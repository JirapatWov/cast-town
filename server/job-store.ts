// JobStore: the jobs (one job = one room = its own people and chats) of every project, persisted to
// <dataDir>/jobs.json with atomic writes. Migration: a project without jobs gets the 'main' job (room 1A, the
// project's old workflowId, a general "Assistant" lead) the first time anyone asks for its jobs.
// Rules enforced here: names 1–60 chars and unique per house, rooms must exist (shared/house-plan.ts, below the
// project's floor count) and be free, a house keeps at least one job, ids are path-safe and never reused.
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { MAX_FLOORS, roomCode, roomSlot, roomsOf, sameRoom } from '../shared/house-plan';
import {
  THINKING_LEVELS, type Job, type JobKind, type JobWorktree, type ModelPref, type Project, type RoomRef, type ThinkingLevel, type WorkStyle,
} from '../shared/protocol';
import type { CoreCityStore } from './city-store';
import type { DefaultLead, JobStore, JobStorePatch, NewJob } from './contracts';
import { jobLeftData, MAIN_JOB_ID } from './data-layout';
import { log, slugify, uniqueName, UserError, writeFileAtomic } from './util';

const FILE_VERSION = 1;
export const JOB_KINDS: JobKind[] = ['general', 'code', 'write', 'research'];
export const WORK_STYLES: WorkStyle[] = ['ask', 'auto', 'solo'];
const MAX_MODEL_PREFS = 12;
export const MAX_JOB_NAME = 60;
export const MAX_BRIEF = 4000;
/** What a job gets before an agent system says which models are connected (never a stand-in: nothing knows better). */
const FALLBACK_LEAD: DefaultLead = { model: 'anthropic/claude-opus-5-5', connected: true };
const MODEL_SELECTOR = /^[\w.-]+\/[\w./:@-]+$/;
const JOB_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
/** 'sub' would collide with helper ids (`<project>:sub:<n>`), 'jobs' with the main job's session layout. */
const RESERVED_IDS = new Set([MAIN_JOB_ID, 'sub', 'jobs']);

interface JobsFile {
  version: number;
  jobs: Job[];
}

export interface CoreJobStore extends JobStore {
  readonly file: string;
  /** First free room of the project, bottom floor first (null when every existing room is taken). */
  freeRoom(projectId: string): RoomRef | null;
  /** Check a new job as create() would and return the id it will get — for work that needs the id before the job
   *  exists (its own copy of the files); pass it back as NewJob.id. */
  nextId(projectId: string, input: NewJob): string;
}

const byRoom = (a: Job, b: Job) => a.room.floor - b.room.floor || a.room.slot - b.room.slot || a.createdAt - b.createdAt;
const cloneWorktree = (w: JobWorktree): JobWorktree => ({ ...w, ...(w.lastBring ? { lastBring: { ...w.lastBring, files: [...w.lastBring.files] } } : {}) });
const clone = (j: Job): Job => ({
  ...j,
  room: { ...j.room },
  ...(j.modelPrefs ? { modelPrefs: j.modelPrefs.map((p) => ({ ...p })) } : {}),
  ...(j.worktree ? { worktree: cloneWorktree(j.worktree) } : {}),
});

/** A job's copy as jobs.json has it: null when it is malformed (the job must not quietly move into the house folder). */
function parseWorktree(w: unknown): JobWorktree | null {
  const x = w as Partial<JobWorktree> | null;
  if (!x || typeof x !== 'object') return null;
  const { path, root, branch, baseRef } = x;
  if (typeof path !== 'string' || typeof root !== 'string' || !isAbsolute(path) || !isAbsolute(root)) return null;
  if (typeof branch !== 'string' || !branch || typeof baseRef !== 'string' || !baseRef.startsWith('refs/rlt/jobs/')) return null;
  const l = x.lastBring;
  const lastBring = l && typeof l.ref === 'string' && l.ref.startsWith('refs/rlt/jobs/') && Array.isArray(l.files) && typeof l.at === 'number'
    ? { ref: l.ref, files: l.files.filter((f): f is string => typeof f === 'string'), at: l.at }
    : undefined;
  return { path, root, branch, baseRef, createdAt: typeof x.createdAt === 'number' ? x.createdAt : Date.now(), ...(lastBring ? { lastBring } : {}) };
}

export function createJobStore(dataDir: string, city: CoreCityStore): CoreJobStore {
  const file = join(dataDir, 'jobs.json');
  const listeners = new Set<(projectId: string, jobs: Job[]) => void>();
  let defaultLead: () => DefaultLead = () => FALLBACK_LEAD;
  /** projectId → jobs (unsorted; sorted on read). */
  const byProject = new Map<string, Job[]>();

  function load(): void {
    if (!existsSync(file)) return;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      const backup = `${file}.corrupt-${Date.now()}`;
      renameSync(file, backup);
      log('jobs', `jobs.json was unreadable (${String(err)}); moved it to ${backup} — every house starts again with its Main job`);
      return;
    }
    const list = (raw as Partial<JobsFile> | null)?.jobs;
    if (!Array.isArray(list)) return;
    for (const j of list as Partial<Job>[]) {
      const job = sanitize(j);
      if (!job) continue;
      const jobs = byProject.get(job.projectId) ?? [];
      if (jobs.some((x) => x.id === job.id)) continue;
      jobs.push(job);
      byProject.set(job.projectId, jobs);
    }
    let fixed = false;
    for (const [projectId, jobs] of byProject) if (repairRooms(projectId, jobs)) fixed = true;
    if (fixed) persist();
  }

  function sanitize(j: Partial<Job> | null | undefined): Job | null {
    if (!j || typeof j.projectId !== 'string' || typeof j.id !== 'string' || !JOB_ID.test(j.id)) return null;
    const project = city.project(j.projectId);
    if (!project) return null; // the building is gone
    const worktree = j.worktree === undefined || j.id === MAIN_JOB_ID ? undefined : parseWorktree(j.worktree);
    if (worktree === null) {
      log('jobs', `job ${j.projectId}/${j.id} has an unreadable own-copy record; leaving it out (its copy stays on disk)`);
      return null;
    }
    const name = typeof j.name === 'string' && j.name.trim() ? j.name.trim().slice(0, MAX_JOB_NAME) : j.id === MAIN_JOB_ID ? 'Main' : j.id;
    const room = j.room && Number.isInteger(j.room.floor) && Number.isInteger(j.room.slot) ? { floor: j.room.floor, slot: j.room.slot } : { floor: -1, slot: -1 };
    return {
      id: j.id,
      projectId: j.projectId,
      name,
      kind: JOB_KINDS.includes(j.kind as JobKind) ? (j.kind as JobKind) : 'general',
      room,
      ...(typeof j.leadModel === 'string' && MODEL_SELECTOR.test(j.leadModel)
        ? { leadModel: j.leadModel, ...(j.leadModelDefault === true ? { leadModelDefault: true as const } : {}) }
        : defaultLeadFields()),
      ...(THINKING_LEVELS.includes(j.leadThinking as ThinkingLevel) ? { leadThinking: j.leadThinking as ThinkingLevel } : {}),
      brief: typeof j.brief === 'string' ? j.brief.slice(0, MAX_BRIEF) : '',
      workflowId: typeof j.workflowId === 'string' && j.workflowId ? j.workflowId : null,
      ...(WORK_STYLES.includes(j.workStyle as WorkStyle) ? { workStyle: j.workStyle } : {}),
      ...(Array.isArray(j.modelPrefs) && cleanPrefs(j.modelPrefs).length ? { modelPrefs: cleanPrefs(j.modelPrefs) } : {}),
      ...(worktree ? { worktree } : {}),
      ...(typeof j.advisorModel === 'string' && MODEL_SELECTOR.test(j.advisorModel) ? { advisorModel: j.advisorModel } : {}),
      createdAt: typeof j.createdAt === 'number' ? j.createdAt : Date.now(),
    };
  }

  /** The model and effort choices of plan cards (server-written): well-formed entries only (a model, an effort or
   *  both), newest first, at most 12. */
  function cleanPrefs(list: unknown[]): ModelPref[] {
    const okModel = (m: unknown): m is string => typeof m === 'string' && MODEL_SELECTOR.test(m);
    const okThinking = (t: unknown): t is ThinkingLevel => THINKING_LEVELS.includes(t as ThinkingLevel);
    return list
      .filter((p): p is ModelPref => {
        const x = p as Partial<ModelPref> | null;
        return !!x && typeof x.stepName === 'string' && typeof x.duty === 'string' && (okModel(x.model) || okThinking(x.thinking)) && typeof x.at === 'number';
      })
      .map((p) => ({
        stepName: p.stepName.slice(0, 40),
        duty: p.duty.slice(0, 200),
        ...(okModel(p.model) ? { model: p.model } : {}),
        ...(okThinking(p.thinking) ? { thinking: p.thinking } : {}),
        at: p.at,
        ...(okModel(p.model) && typeof p.modelAt === 'number' ? { modelAt: p.modelAt } : {}),
        ...(okThinking(p.thinking) && typeof p.thinkingAt === 'number' ? { thinkingAt: p.thinkingAt } : {}),
      }))
      .sort((a, b) => b.at - a.at)
      .slice(0, MAX_MODEL_PREFS);
  }

  /** The lead of a job made without a model. While no account is connected it is only a stand-in
   *  (Job.leadModelDefault): followDefaultLead replaces it once there is one. */
  function defaultLeadFields(): Pick<Job, 'leadModel' | 'leadModelDefault'> {
    const d = defaultLead();
    return { leadModel: d.model, ...(d.connected ? {} : { leadModelDefault: true as const }) };
  }

  function cleanStyle(style: WorkStyle): WorkStyle {
    if (!WORK_STYLES.includes(style)) throw new UserError('Pick how the Assistant works: ask, auto or solo');
    return style;
  }

  /** Jobs whose room is missing, doubled up or above the top floor move to the first free room (adding floors if needed). */
  function repairRooms(projectId: string, jobs: Job[]): boolean {
    const project = city.project(projectId);
    if (!project) return false;
    let floors = project.floors;
    const valid = (r: RoomRef) => r.floor < floors && roomSlot(r.floor, r.slot) !== null;
    const placed: Job[] = [];
    const homeless: Job[] = [];
    for (const job of [...jobs].sort((a, b) => a.createdAt - b.createdAt)) {
      if (valid(job.room) && !placed.some((p) => sameRoom(p.room, job.room))) placed.push(job);
      else homeless.push(job);
    }
    if (!homeless.length) return false;
    for (const job of homeless) {
      let free = roomsOf(floors).find((r) => !placed.some((p) => sameRoom(p.room, r)));
      while (!free && floors < MAX_FLOORS) {
        floors++;
        free = roomsOf(floors).find((r) => !placed.some((p) => sameRoom(p.room, r)));
      }
      if (!free) {
        log('jobs', `no room left for job ${projectId}/${job.id}; dropping it`);
        jobs.splice(jobs.indexOf(job), 1);
        continue;
      }
      log('jobs', `job ${projectId}/${job.id} moved to room ${free.code}`);
      job.room = { floor: free.floor, slot: free.slot };
      placed.push(job);
    }
    if (floors !== project.floors) city.updateProject(projectId, { floors });
    return true;
  }

  function persist(): void {
    const all: Job[] = [];
    for (const jobs of byProject.values()) all.push(...[...jobs].sort(byRoom));
    const data: JobsFile = { version: FILE_VERSION, jobs: all };
    writeFileAtomic(file, `${JSON.stringify(data, null, 2)}\n`);
  }

  function emit(projectId: string): void {
    const jobs = sorted(projectId);
    for (const fn of listeners) {
      try {
        fn(projectId, jobs);
      } catch (err) {
        log('jobs', 'listener failed', err);
      }
    }
  }

  function changed(projectId: string): void {
    persist();
    emit(projectId);
  }

  function sorted(projectId: string): Job[] {
    return [...(byProject.get(projectId) ?? [])].sort(byRoom).map(clone);
  }

  function requireProject(projectId: string): Project {
    const p = city.project(projectId);
    if (!p) throw new UserError('That house no longer exists');
    return p;
  }

  /** The project's live job array, creating 'main' when the project has none yet (migration / new project). */
  function jobsOf(projectId: string): Job[] {
    let jobs = byProject.get(projectId);
    if (jobs?.length) return jobs;
    const project = city.project(projectId);
    if (!project) return [];
    jobs = [
      {
        id: MAIN_JOB_ID,
        projectId,
        name: 'Main',
        kind: 'general',
        room: { floor: 0, slot: 0 },
        ...defaultLeadFields(),
        brief: '',
        workflowId: project.workflowId,
        createdAt: project.createdAt,
      },
    ];
    byProject.set(projectId, jobs);
    log('jobs', `${projectId}: created the Main job (room 1A)`);
    changed(projectId);
    return jobs;
  }

  function find(projectId: string, jobId: string): Job {
    const job = jobsOf(projectId).find((j) => j.id === jobId);
    if (!job) throw new UserError('That job no longer exists');
    return job;
  }

  function cleanName(raw: string, projectId: string, exceptId?: string): string {
    const name = raw.replace(/\s+/g, ' ').trim();
    if (!name) throw new UserError('Give the job a name');
    if (name.length > MAX_JOB_NAME) throw new UserError(`Keep the job name to ${MAX_JOB_NAME} characters or fewer`);
    const clash = jobsOf(projectId).find((j) => j.id !== exceptId && j.name.toLocaleLowerCase() === name.toLocaleLowerCase());
    if (clash) throw new UserError(`This house already has a job called “${clash.name}”`);
    return name;
  }

  function cleanRoom(room: RoomRef, project: Project, exceptId?: string): RoomRef {
    const slot = roomSlot(room.floor, room.slot);
    if (!slot) throw new UserError('That room does not exist');
    if (room.floor >= project.floors) {
      throw new UserError(`Floor ${room.floor + 1} hasn't been built yet — add a floor first`);
    }
    const holder = jobsOf(project.id).find((j) => j.id !== exceptId && sameRoom(j.room, room));
    if (holder) throw new UserError(`Room ${slot.code} is taken by “${holder.name}”`);
    return { floor: room.floor, slot: room.slot };
  }

  function cleanModel(model: string, what = 'a lead model'): string {
    const m = model.trim();
    if (!MODEL_SELECTOR.test(m)) throw new UserError(`Pick ${what} like provider/model-id`);
    return m;
  }

  function cleanBrief(brief: string): string {
    const b = brief.trim();
    if (b.length > MAX_BRIEF) throw new UserError(`Keep the brief to ${MAX_BRIEF} characters or fewer`);
    return b;
  }

  function newId(projectId: string, name: string): string {
    const jobs = jobsOf(projectId);
    const taken = (c: string) => RESERVED_IDS.has(c) || jobs.some((j) => j.id === c) || jobLeftData(dataDir, projectId, c);
    const base = slugify(name, 40);
    if (base) return uniqueName(base, taken);
    for (let n = 2; ; n++) if (!taken(`job-${n}`)) return `job-${n}`; // names without ASCII letters, e.g. Thai
  }

  /** A new job, checked (name, kind, room, models, brief, style) but not added yet. */
  function build(projectId: string, input: NewJob): Job {
    const project = requireProject(projectId);
    const name = cleanName(input.name, projectId);
    if (!JOB_KINDS.includes(input.kind)) throw new UserError('Pick what kind of job this is');
    let id = input.id;
    if (id !== undefined) {
      // chosen by nextId (its copy, made first, now holds the id in worktrees/ — that is what jobLeftData sees)
      if (!JOB_ID.test(id) || RESERVED_IDS.has(id) || jobsOf(projectId).some((j) => j.id === id)) throw new UserError('That job id is taken');
    } else id = newId(projectId, name);
    return {
      id,
      projectId,
      name,
      kind: input.kind,
      room: cleanRoom(input.room, project),
      ...(input.leadModel?.trim() ? { leadModel: cleanModel(input.leadModel) } : defaultLeadFields()),
      ...(input.leadThinking && THINKING_LEVELS.includes(input.leadThinking) ? { leadThinking: input.leadThinking } : {}),
      brief: cleanBrief(input.brief ?? ''),
      workflowId: input.workflowId ?? null,
      ...(input.workStyle !== undefined ? { workStyle: cleanStyle(input.workStyle) } : {}),
      ...(input.worktree ? { worktree: cloneWorktree(input.worktree) } : {}),
      ...(input.advisorModel?.trim() ? { advisorModel: cleanModel(input.advisorModel, 'an advisor model') } : {}),
      createdAt: Date.now(),
    };
  }

  load();

  return {
    file,
    setDefaultLeadModel(fn) {
      defaultLead = fn;
    },

    followDefaultLead(busy) {
      const d = defaultLead();
      if (!d.connected) return;
      for (const [projectId, jobs] of byProject) {
        const followers = jobs.filter((j) => j.leadModelDefault && !busy(projectId, j.id));
        if (!followers.length) continue;
        for (const job of followers) {
          log('jobs', `${projectId}/${job.id}: lead model ${job.leadModel} was a stand-in; now ${d.model}`);
          job.leadModel = d.model;
          delete job.leadModelDefault;
        }
        changed(projectId);
      }
    },

    all() {
      const out: Job[] = [];
      for (const p of city.get().projects) {
        jobsOf(p.id);
        out.push(...sorted(p.id));
      }
      return out;
    },

    list(projectId) {
      jobsOf(projectId);
      return sorted(projectId);
    },

    get(projectId, jobId) {
      const job = jobsOf(projectId).find((j) => j.id === jobId);
      return job ? clone(job) : undefined;
    },

    freeRoom(projectId) {
      const project = city.project(projectId);
      if (!project) return null;
      const jobs = jobsOf(projectId);
      const free = roomsOf(project.floors).find((r) => !jobs.some((j) => sameRoom(j.room, r)));
      return free ? { floor: free.floor, slot: free.slot } : null;
    },

    nextId(projectId, input) {
      return build(projectId, input).id;
    },

    create(projectId, input) {
      const job = build(projectId, input);
      jobsOf(projectId).push(job);
      log('jobs', `${projectId}: new job ${job.id} “${job.name}” (${job.kind}) in ${roomCode(job.room.floor, job.room.slot)}${job.worktree ? ` with its own copy (${job.worktree.branch})` : ''}`);
      changed(projectId);
      return clone(job);
    },

    update(projectId, jobId, patch: JobStorePatch) {
      const project = requireProject(projectId);
      const job = find(projectId, jobId);
      const next: Job = clone(job);
      if (patch.name !== undefined) next.name = cleanName(patch.name, projectId, jobId);
      if (patch.kind !== undefined) {
        if (!JOB_KINDS.includes(patch.kind)) throw new UserError('Pick what kind of job this is');
        next.kind = patch.kind;
      }
      if (patch.room !== undefined && !sameRoom(patch.room, job.room)) next.room = cleanRoom(patch.room, project, jobId);
      if (patch.leadModel !== undefined) {
        next.leadModel = cleanModel(patch.leadModel);
        delete next.leadModelDefault; // chosen now
      }
      if (patch.leadThinking === null) delete next.leadThinking;
      else if (patch.leadThinking !== undefined && THINKING_LEVELS.includes(patch.leadThinking)) next.leadThinking = patch.leadThinking;
      if (patch.brief !== undefined) next.brief = cleanBrief(patch.brief);
      if (patch.workflowId !== undefined) next.workflowId = patch.workflowId || null;
      if (patch.workStyle !== undefined) next.workStyle = cleanStyle(patch.workStyle);
      if (patch.advisorModel === null || patch.advisorModel?.trim() === '') delete next.advisorModel;
      else if (patch.advisorModel !== undefined) next.advisorModel = cleanModel(patch.advisorModel, 'an advisor model');
      if (patch.worktree !== undefined) {
        // Chosen when the job is made: only the bring state (lastBring) changes afterwards.
        if (!job.worktree) throw new UserError('This job works in the house folder — it has no copy of its own');
        const { lastBring } = patch.worktree;
        next.worktree = { ...cloneWorktree(job.worktree), lastBring: lastBring && { ...lastBring, files: [...lastBring.files] } };
        if (!lastBring) delete next.worktree.lastBring;
      }
      if (patch.modelPrefs !== undefined) {
        const prefs = cleanPrefs(patch.modelPrefs);
        if (prefs.length) next.modelPrefs = prefs;
        else delete next.modelPrefs;
      }
      if (JSON.stringify(next) === JSON.stringify(job)) return clone(job);
      // Optional fields the patch removed (leadThinking / advisorModel → default, modelPrefs emptied) must go from the job too
      for (const k of Object.keys(job) as (keyof Job)[]) if (!(k in next)) delete job[k];
      Object.assign(job, next);
      changed(projectId);
      return clone(job);
    },

    remove(projectId, jobId) {
      const jobs = jobsOf(projectId);
      const i = jobs.findIndex((j) => j.id === jobId);
      if (i < 0) throw new UserError('That job no longer exists');
      if (jobs.length <= 1) throw new UserError('A house needs at least one job — this is the last one');
      const [gone] = jobs.splice(i, 1);
      log('jobs', `${projectId}: removed job ${gone.id} “${gone.name}” (its files and chats stay on disk)`);
      changed(projectId);
    },

    removeProject(projectId) {
      if (!byProject.delete(projectId)) return;
      persist();
      for (const fn of listeners) {
        try {
          fn(projectId, []);
        } catch (err) {
          log('jobs', 'listener failed', err);
        }
      }
    },

    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
