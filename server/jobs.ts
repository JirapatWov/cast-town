// JobService: the core's job and floor operations behind create_job / update_job / delete_job / add_floor /
// remove_floor, plus a job's own copy of the files (get_git with jobId, bring_job_changes). The JobStore enforces the
// room/name rules; this layer checks workflows and models, keeps the 'main' job and project.workflowId in step (older
// clients still set the house team through set_project), makes and removes jobs' copies (git.ts), and tells the
// agent system so people are added, re-briefed or sent home.
import { MAX_FLOORS, roomCode } from '../shared/house-plan';
import { workflowOf } from '../shared/house-workflows';
import type { BringPlan, DiscardResult, GitSummary, Job, JobKind, LeftoverBranch, Project, RoomRef, ThinkingLevel, UndoneChanges, WorkStyle } from '../shared/protocol';
import type { CoreCityStore } from './city-store';
import type { AgentSnapshot, AgentSystem, Hub, JobPatch, NewJob } from './contracts';
import { MAIN_JOB_ID } from './data-layout';
import type { CoreGitService } from './git';
import type { CoreJobStore } from './job-store';
import { errorMessage, log, UserError } from './util';
import { moveRunsHome, worktreeRootFor } from './worktrees';

export interface JobService {
  create(input: {
    projectId: string; name: string; kind: JobKind; room: RoomRef; leadModel?: string; leadThinking?: ThinkingLevel; workflowId?: string | null; brief?: string; workStyle?: WorkStyle;
    worktree?: boolean; advisorModel?: string;
  }): Promise<Job>;
  update(projectId: string, jobId: string, patch: JobPatch): Promise<Job>;
  remove(projectId: string, jobId: string): Promise<void>;
  addFloor(projectId: string): Promise<Project>;
  removeFloor(projectId: string): Promise<Project>;
  /** get_git: the house folder, or (jobId of a job with its own copy) what that copy changed since its base. */
  gitSummary(projectId: string, jobId?: string): Promise<GitSummary>;
  /** bring_job_changes: merge a copy's changes into the house (preview: only the plan), or undo the last bring. */
  bring(projectId: string, jobId: string, opts: { preview?: boolean; undo?: boolean }): Promise<{ plan: BringPlan } | { files: string[]; kept: string[] }>;
  /** list_leftovers: branches deleted jobs left in the house's repository (finding #75). */
  leftovers(projectId: string): Promise<LeftoverBranch[]>;
  /** leftover_branch: bring one into the house (preview: only the plan), undo its last bring, or delete it. */
  leftover(projectId: string, branch: string, action: 'bring' | 'undo' | 'delete', opts?: { preview?: boolean }): Promise<{ plan: BringPlan; files?: string[] } | { files: string[]; kept: string[] } | { deleted: true }>;
  /** discard_changes: Changes → Undo changes / Undo all in the house folder (preview: only say what). */
  discard(projectId: string, paths: string[], opts?: { preview?: boolean }): Promise<DiscardResult>;
  /** list_undone: what Undo changes kept for the house folder, newest first. */
  undone(projectId: string): Promise<UndoneChanges[]>;
  /** bring_back_undone: put back what an Undo changes kept (preview: only say what). */
  bringBack(projectId: string, id: string, opts?: { preview?: boolean }): Promise<{ plan: BringPlan }>;
}

export interface JobServiceDeps {
  city: CoreCityStore;
  jobs: CoreJobStore;
  agents: AgentSystem;
  git: CoreGitService;
  dataDir: string;
  /** Sends everyone the house's and the copy's git state after a bring (without it, clients ask with get_git). */
  hub?: Hub;
}

/** Why this house can't take that workflow as a team (a job's or the house's), or null: it must be one of the house's
 *  own. Another house's workflow, or one in the library, is not — it is imported into the house first. */
export function teamProblem(snapshot: AgentSnapshot, projectId: string, workflowId: string): string | null {
  if (workflowOf(snapshot, projectId, workflowId)) return null;
  const inLibrary = snapshot.library?.find((e) => e.workflow.id === workflowId);
  if (inLibrary) return `“${inLibrary.workflow.name}” is in the library, not in this house — import it into this house first`;
  return `Unknown team (workflow) ${workflowId} — this house has no workflow with that id`;
}

export function createJobService({ city, jobs, agents, git, dataDir, hub }: JobServiceDeps): JobService {
  /** One job/floor operation per house at a time: a delete checks "not the last job", then waits seconds for its
   *  people to stop — a second delete must see the result of the first before it moves anyone out. */
  const queues = new Map<string, Promise<unknown>>();
  function serial<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const prev = queues.get(projectId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    queues.set(projectId, next);
    void next.finally(() => {
      if (queues.get(projectId) === next) queues.delete(projectId);
    }).catch(() => {});
    return next;
  }

  async function notify(what: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      log('agents', `${what} failed: ${errorMessage(err)}`);
    }
  }

  function requireProject(id: string): Project {
    const p = city.project(id);
    if (!p) throw new UserError('That house no longer exists');
    return p;
  }

  /** Models that aren't connected can't lead a job while another model is connected. */
  function requireUsableModel(model: string | undefined): void {
    const why = model?.trim() ? agents.unusableModel?.(model.trim()) : null;
    if (why) throw new UserError(why);
  }

  /** A job's team is a workflow of its own house (one from the library is imported first). */
  function requireWorkflow(projectId: string, workflowId: string | null | undefined): void {
    if (!workflowId) return;
    const why = teamProblem(agents.snapshot(), projectId, workflowId);
    if (why) throw new UserError(why);
  }

  function requireJob(projectId: string, jobId: string): Job {
    const job = jobs.get(projectId, jobId);
    if (!job) throw new UserError('That job no longer exists');
    return job;
  }

  /** A bring writes the house's files: nobody may work in the job (if any) or in the house folder meanwhile. */
  function requireQuiet(project: Project, job?: Job): void {
    const list = jobs.list(project.id);
    const inHouse = new Set(list.filter((j) => !j.worktree).map((j) => j.id));
    const watched = (jobId: string) => jobId === job?.id || inHouse.has(jobId);
    const nameOf = (jobId: string) => list.find((j) => j.id === jobId)?.name ?? jobId;
    const snap = agents.snapshot();
    const run = snap.runs.find((r) => r.projectId === project.id && watched(r.jobId) && (r.status === 'running' || r.status === 'waiting_approval'));
    if (run) throw new UserError(`A team is working in “${nameOf(run.jobId)}” — wait until it’s done, or stop it first.`);
    const busy = snap.agents.find((a) => a.projectId === project.id && watched(a.jobId) && a.status === 'busy');
    if (busy) throw new UserError(`${busy.name} of “${nameOf(busy.jobId)}” is still working — wait until they’re done, or stop them first.`);
  }

  /** After a bring or its undo both folders changed: everyone gets the new state of each (a leftover: the house). */
  function announceGit(project: Project, job?: Job): void {
    if (!hub) return;
    for (const which of job ? [undefined, job] : [undefined]) {
      git.summary(project, which).then(
        (summary) => hub.broadcast({ t: 'git', summary }),
        (err) => log('git', `summary failed for ${project.id}: ${errorMessage(err)}`),
      );
    }
  }

  /** A room on the next floor up (one that isn't built yet) builds that floor as part of the job's create or move —
   *  so the New job dialog can offer "2A on a new Floor 2" without building anything before Create — and takes it
   *  down again when the job could not be made after all (unless another job moved in meanwhile). */
  async function withRoomBuilt<T>(project: Project, room: RoomRef | undefined, fn: () => Promise<T>): Promise<T> {
    if (!room || room.floor !== project.floors || project.floors >= MAX_FLOORS) return fn();
    city.updateProject(project.id, { floors: project.floors + 1 });
    log('city', `${project.id}: built floor ${project.floors + 1} for a job`);
    try {
      return await fn();
    } catch (err) {
      const now = city.project(project.id);
      if (now && now.floors === project.floors + 1 && !jobs.list(project.id).some((j) => j.room.floor === project.floors)) {
        city.updateProject(project.id, { floors: project.floors });
        log('city', `${project.id}: took floor ${project.floors + 1} down again (${errorMessage(err)})`);
      }
      throw err;
    }
  }

  async function createIn(project: Project, input: Parameters<JobService['create']>[0]): Promise<Job> {
    requireWorkflow(project.id, input.workflowId);
    requireUsableModel(input.leadModel);
    requireUsableModel(input.advisorModel);
    const fields: NewJob = {
      name: input.name,
      kind: input.kind,
      room: input.room,
      leadModel: input.leadModel?.trim() || undefined,
      leadThinking: input.leadThinking,
      brief: input.brief,
      workflowId: input.workflowId ?? null,
      workStyle: input.workStyle,
      advisorModel: input.advisorModel?.trim() || undefined,
    };
    let job: Job;
    if (input.worktree) {
      // The copy comes first, so the job's people never start in the house folder: it needs the job's id.
      const id = jobs.nextId(project.id, fields);
      const worktree = await git.createJobCopy(project, id, worktreeRootFor(dataDir, project.id, id));
      try {
        job = jobs.create(project.id, { ...fields, id, worktree });
      } catch (err) {
        await git.removeJobCopy(project, fields.name, worktree, { discard: true }).catch((e) => log('jobs', `could not drop the unused copy ${worktree.root}: ${errorMessage(e)}`));
        throw err;
      }
    } else {
      job = jobs.create(project.id, fields);
    }
    await notify('onJobsChanged', () => agents.onJobsChanged(input.projectId));
    return job;
  }

  async function updateIn(projectId: string, jobId: string, patch: JobPatch): Promise<Job> {
    requireProject(projectId);
    if (patch.workflowId !== undefined) requireWorkflow(projectId, patch.workflowId);
    const before = jobs.get(projectId, jobId);
    // Only a new lead model is checked: renaming a job whose lead lost its sign-in must still work.
    if (patch.leadModel !== undefined && patch.leadModel.trim() !== before?.leadModel) requireUsableModel(patch.leadModel);
    if (patch.advisorModel && patch.advisorModel.trim() !== before?.advisorModel) requireUsableModel(patch.advisorModel);
    // The copy and its bring state are the server's own (JobStorePatch): never from a client's patch.
    const { worktree: _server, ...clientPatch } = patch as JobPatch & { worktree?: unknown };
    const job = jobs.update(projectId, jobId, clientPatch);
    // The house's team is the Main job's: a team change (no team too) is written there whenever the two differ — also
    // when the job had no team of its own and the house still had one, else that workflow stays the job's team.
    if (job.id === MAIN_JOB_ID && patch.workflowId !== undefined && requireProject(projectId).workflowId !== job.workflowId) {
      city.updateProject(projectId, { workflowId: job.workflowId });
    }
    await notify('onJobsChanged', () => agents.onJobsChanged(projectId));
    return job;
  }

  const service: Omit<JobService, 'gitSummary' | 'bring' | 'leftovers' | 'leftover' | 'discard' | 'undone' | 'bringBack'> = {
    async create(input) {
      const project = requireProject(input.projectId);
      return withRoomBuilt(project, input.room, () => createIn(project, input));
    },

    async update(projectId, jobId, patch) {
      const project = requireProject(projectId);
      return withRoomBuilt(project, patch.room, () => updateIn(projectId, jobId, patch));
    },

    async remove(projectId, jobId) {
      const project = requireProject(projectId);
      const list = jobs.list(projectId);
      const job = list.find((j) => j.id === jobId);
      if (!job) throw new UserError('That job no longer exists');
      if (list.length <= 1) throw new UserError('A house needs at least one job — this is the last one');
      await agents.onJobRemoved(projectId, jobId); // stop its runs and people before the job disappears
      if (job.worktree) {
        // Its work is committed to its branch, which stays; the folder goes. A copy that can't be committed stays too.
        const runs = moveRunsHome(project, job.worktree);
        try {
          const branch = await git.removeJobCopy(project, job.name, job.worktree, {
            // Files no commit keeps (an .env, a nested repository) were moved aside, not deleted: say where.
            onKept: (dir, files) => hub?.broadcast({ t: 'toast', level: 'info', projectId, text: `“${job.name}” had files that aren’t on its branch (${files.slice(0, 3).join(', ')}${files.length > 3 ? ', …' : ''}) — they’re kept in ${dir}` }),
          });
          log('jobs', `${projectId}/${jobId}: copy removed${branch ? `, its work is on branch ${branch} (Changes lists it)` : ''}${runs ? `, ${runs} run(s) kept in the house` : ''}`);
        } catch (err) {
          log('jobs', `${projectId}/${jobId}: could not remove its copy (${errorMessage(err)}) — it stays at ${job.worktree.root}`);
        }
      }
      jobs.remove(projectId, jobId);
      await notify('onJobsChanged', () => agents.onJobsChanged(projectId)); // the others' briefs list the jobs of the house
    },

    async addFloor(projectId) {
      const p = requireProject(projectId);
      if (p.floors >= MAX_FLOORS) throw new UserError(`${p.name} already has ${MAX_FLOORS} floors — that's as tall as a house gets`);
      const project = city.updateProject(projectId, { floors: p.floors + 1 });
      log('city', `${projectId}: built floor ${project.floors}`);
      return project;
    },

    async removeFloor(projectId) {
      const p = requireProject(projectId);
      if (p.floors <= 1) throw new UserError("The ground floor can't be removed");
      const top = p.floors - 1;
      const onTop = jobs.list(projectId).filter((j) => j.room.floor === top);
      if (onTop.length) {
        const names = onTop.map((j) => `“${j.name}” (${roomCode(j.room.floor, j.room.slot)})`).join(', ');
        throw new UserError(`Floor ${p.floors} still has ${onTop.length === 1 ? 'a job' : 'jobs'}: ${names}. Move or delete ${onTop.length === 1 ? 'it' : 'them'} first`);
      }
      const project = city.updateProject(projectId, { floors: top });
      log('city', `${projectId}: removed floor ${top + 1}`);
      return project;
    },
  };

  /** Reads and git work only — no queue: it never changes the job list. */
  async function gitSummary(projectId: string, jobId?: string): Promise<GitSummary> {
    const project = city.project(projectId);
    if (!project) throw new UserError('That project no longer exists');
    return git.summary(project, jobId ? jobs.get(projectId, jobId) : undefined);
  }

  async function bring(projectId: string, jobId: string, opts: { preview?: boolean; undo?: boolean }) {
    const project = requireProject(projectId);
    const job = requireJob(projectId, jobId);
    const wt = job.worktree;
    if (!wt) throw new UserError(`“${job.name}” works in the house folder — there is nothing to bring in.`);
    if (!opts.preview) requireQuiet(project, job);
    if (opts.undo) {
      const r = await git.undoBring(project, wt, !!opts.preview);
      if (opts.preview) return r;
      jobs.update(projectId, jobId, { worktree: { ...wt, lastBring: undefined } });
      announceGit(project, job);
      return r;
    }
    const r = await git.bringJobChanges(project, jobId, wt, !!opts.preview);
    if (!opts.preview) {
      if (r.lastBring) jobs.update(projectId, jobId, { worktree: { ...wt, lastBring: r.lastBring } });
      announceGit(project, job);
    }
    return { plan: r.plan };
  }

  async function leftover(projectId: string, branch: string, action: 'bring' | 'undo' | 'delete', opts: { preview?: boolean } = {}) {
    const project = requireProject(projectId);
    if (action === 'delete') {
      await git.deleteLeftover(project, branch);
      return { deleted: true as const };
    }
    if (!opts.preview) requireQuiet(project);
    if (action === 'undo') {
      const r = await git.undoLeftoverBring(project, branch, !!opts.preview);
      if (!opts.preview) announceGit(project);
      return r;
    }
    const r = await git.bringLeftover(project, branch, !!opts.preview);
    if (opts.preview) return { plan: r.plan };
    announceGit(project);
    return r;
  }

  /** Undo changes and Bring back write the house folder's files: the same rule as a bring (requireQuiet). */
  async function discard(projectId: string, paths: string[], opts: { preview?: boolean } = {}) {
    const project = requireProject(projectId);
    if (!opts.preview) requireQuiet(project);
    const r = await git.discardChanges(project, paths, !!opts.preview);
    if (!opts.preview && r.files.length) announceGit(project);
    return r;
  }

  async function bringBack(projectId: string, id: string, opts: { preview?: boolean } = {}) {
    const project = requireProject(projectId);
    if (!opts.preview) requireQuiet(project);
    const r = await git.bringBackUndone(project, id, !!opts.preview);
    if (!opts.preview) announceGit(project);
    return r;
  }

  return {
    gitSummary,
    discard: (projectId, paths, opts) => serial(projectId, () => discard(projectId, paths, opts)),
    undone: async (projectId) => git.listUndone(requireProject(projectId)),
    bringBack: (projectId, id, opts) => serial(projectId, () => bringBack(projectId, id, opts)),
    bring: (projectId, jobId, opts) => serial(projectId, () => bring(projectId, jobId, opts)),
    leftovers: async (projectId) => git.listLeftovers(requireProject(projectId)),
    leftover: (projectId, branch, action, opts) => serial(projectId, () => leftover(projectId, branch, action, opts)),
    create: (input) => serial(input.projectId, () => service.create(input)),
    update: (projectId, jobId, patch) => serial(projectId, () => service.update(projectId, jobId, patch)),
    remove: (projectId, jobId) => serial(projectId, () => service.remove(projectId, jobId)),
    addFloor: (projectId) => serial(projectId, () => service.addFloor(projectId)),
    removeFloor: (projectId) => serial(projectId, () => service.removeFloor(projectId)),
  };
}
