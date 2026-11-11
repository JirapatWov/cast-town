// ProjectService: the core's project operations behind place/create/move/remove/set_project.
// Owns the rules (folder confinement, one project per lot, one building per folder) and keeps the agent system informed.
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { clipName, MAX_PROJECT_NAME } from '../shared/limits';
import type { BuildingStyle, Project } from '../shared/protocol';
import type { CoreCityStore } from './city-store';
import type { AgentSystem } from './contracts';
import { MAIN_JOB_ID } from './data-layout';
import type { FsBrowser } from './fs-browse';
import type { CoreGitService } from './git';
import type { CoreJobStore } from './job-store';
import { teamProblem } from './jobs';
import { pruneUploads, removeHouseArtifacts, removeHouseHistory } from './data-wipe';
import { templateFiles, writeFiles, type TemplateId } from './project-templates';
import { errorMessage, log, slugify, uniqueName, UserError } from './util';

/** maxRunsPerAsk: null takes the house back to the default limit. */
export type ProjectPatch = Partial<Pick<Project, 'name' | 'style' | 'approvalMode' | 'workflowId' | 'path'>> & { maxRunsPerAsk?: number | null };

export interface ProjectService {
  /** initGit: set up git in a folder that has none first. A failure there doesn't stop the placing: the house is then
   *  placed without git and `gitError` says why. */
  place(input: { path: string; name: string; lotId: string; style: BuildingStyle; initGit?: boolean }): Promise<Project & { gitError?: string }>;
  /** Changes → Set up git: make a house that is not a git repo one. */
  initGit(projectId: string): Promise<Project>;
  create(input: { name: string; lotId: string; style: BuildingStyle; template: TemplateId }): Promise<Project>;
  move(projectId: string, lotId: string): Promise<Project>;
  /** deleteHistory: also delete its chats, omp sessions and CAST's run notes (data-wipe.ts); the folder stays. */
  remove(projectId: string, opts?: { deleteHistory?: boolean }): Promise<void>;
  update(projectId: string, patch: ProjectPatch): Promise<Project>;
}

export interface ProjectDeps {
  city: CoreCityStore;
  jobs: CoreJobStore;
  git: CoreGitService;
  fs: FsBrowser;
  agents: AgentSystem;
  workspaceRoot: string;
  /** Needed for remove(…, { deleteHistory }). */
  dataDir?: string;
}

const CODE_MARKERS = ['package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'requirements.txt', 'pom.xml', 'build.gradle', 'Gemfile', 'composer.json', 'src', 'Makefile'];
const PROSE_EXT = new Set(['.md', '.txt', '.docx', '.fountain']);

/** How much people may do without asking in a new house. With git every change can be seen and undone, so they may
 *  edit freely; without it an edit can't be taken back, so they ask first until the user decides otherwise. */
export function defaultApprovalMode(isGit: boolean): Project['approvalMode'] {
  return isGit ? 'write' : 'always-ask';
}

/** What a folder looks like: code, prose (a book, notes) or neither. It picks the Main job's kind, so the lead is a
 *  Developer or a Writer from the start. No team comes with it: a new house has no workflows, and its lead builds a
 *  team per task from the models that are connected (and keeps one with workflow_save). */
export function guessFolderKind(dir: string): 'code' | 'write' | 'general' {
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return 'general';
  }
  if (names.some((n) => CODE_MARKERS.includes(n))) return 'code';
  const prose = names.filter((n) => PROSE_EXT.has(extname(n).toLowerCase())).length;
  if (names.includes('chapters') || names.includes('manuscript') || prose >= 3) return 'write';
  return 'general';
}

export function createProjectService(d: ProjectDeps): ProjectService {
  const { city, jobs, git, fs, agents } = d;

  /** Agent-system hooks are best-effort: a failure there must not undo a successful city change. */
  async function notify(what: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      log('agents', `${what} failed: ${errorMessage(err)}`);
    }
  }

  function requireFreeLot(lotId: string): void {
    if (!city.get().lots.some((l) => l.id === lotId)) throw new UserError(`Unknown lot ${lotId}`);
    const holder = city.projectOnLot(lotId);
    if (holder) throw new UserError(`Lot ${lotId} is already home to ${holder.name}`);
  }

  function requireProject(id: string): Project {
    const p = city.project(id);
    if (!p) throw new UserError('That project no longer exists');
    return p;
  }

  /** Point a house at another folder (the user moved or renamed it on disk, or placed the wrong one). Its people,
   *  chats, jobs and runs stay; their omp processes stop and start again in the new folder with their next message.
   *  Refused while anyone works there, and for houses with jobs that work in their own copy (those copies are git
   *  worktrees of the old folder's repository). The old folder is not touched. */
  async function relocate(p: Project, path: string): Promise<Project> {
    const dir = fs.resolveDir(path);
    if (dir === p.path) return p;
    if (dir === '/') throw new UserError('Pick a project folder, not the whole disk');
    const other = city.projectByPath(dir);
    if (other && other.id !== p.id) throw new UserError(`That folder is already ${other.name} on lot ${other.lotId}`);
    const copies = jobs.list(p.id).filter((j) => j.worktree);
    if (copies.length) {
      const names = copies.map((j) => `“${j.name}”`).join(', ');
      throw new UserError(`${names} ${copies.length === 1 ? 'works' : 'work'} in ${copies.length === 1 ? 'its own copy' : 'their own copies'} of the old folder — delete ${copies.length === 1 ? 'that job' : 'those jobs'} first (their work stays on their branches).`);
    }
    const snap = agents.snapshot();
    const run = snap.runs.find((r) => r.projectId === p.id && (r.status === 'running' || r.status === 'waiting_approval'));
    if (run) throw new UserError(`A team is working in ${p.name} (“${run.workflowName}”) — wait until it’s done, or stop it first.`);
    const busy = snap.agents.find((a) => a.projectId === p.id && (a.status === 'busy' || a.status === 'starting'));
    if (busy) throw new UserError(`${busy.name} is still working in ${p.name} — wait until they’re done, or stop them first.`);
    const isGit = await git.isGit(dir);
    if (isGit) await git.ensureRltExcluded(dir).catch((err) => log('git', `exclude .rlt failed: ${errorMessage(err)}`));
    const project = city.updateProject(p.id, { path: dir, isGit });
    log('city', `${p.id}: now in ${dir} (was ${p.path})`);
    await notify('onProjectMoved', async () => {
      if (agents.onProjectMoved) await agents.onProjectMoved(project);
      else await agents.onProjectUpdated(project);
    });
    return project;
  }

  return {
    async place({ path, name, lotId, style, initGit }) {
      const dir = fs.resolveDir(path);
      if (dir === '/') throw new UserError('Pick a project folder, not the whole disk');
      const existing = city.projectByPath(dir);
      if (existing) throw new UserError(`That folder is already ${existing.name} on lot ${existing.lotId}`);
      requireFreeLot(lotId);
      let isGit = await git.isGit(dir);
      let gitError: string | undefined;
      if (!isGit && initGit) {
        try {
          await git.setUpGit(dir);
          isGit = true;
          log('git', `set up git in ${dir}`);
        } catch (err) {
          gitError = errorMessage(err);
          log('git', `could not set up git in ${dir}: ${gitError}`);
        }
      }
      if (isGit) await git.ensureRltExcluded(dir).catch((err) => log('git', `exclude .rlt failed: ${errorMessage(err)}`));
      const project = city.addProject({
        name: clipName(name, MAX_PROJECT_NAME) || clipName(basename(dir), MAX_PROJECT_NAME),
        path: dir,
        lotId,
        style,
        isGit,
        workflowId: null, // see guessFolderKind: the lead builds teams from the connected models
        approvalMode: defaultApprovalMode(isGit),
        floors: 1,
      });
      jobs.list(project.id); // every house starts with its Main job
      const kind = guessFolderKind(dir);
      if (kind !== 'general') jobs.update(project.id, MAIN_JOB_ID, { kind });
      log('city', `placed ${project.id} (${dir}) on ${lotId}`);
      await notify('onProjectAdded', () => agents.onProjectAdded(project));
      return gitError ? { ...project, gitError } : project;
    },

    async initGit(projectId) {
      const p = requireProject(projectId);
      if (await git.isGit(p.path)) {
        // already one (set up outside CAST meanwhile): just bring the house's flag up to date
        if (p.isGit) return p;
      } else {
        await git.setUpGit(p.path);
        log('git', `set up git in ${p.path} (${projectId})`);
      }
      await git.ensureRltExcluded(p.path).catch((err) => log('git', `exclude .rlt failed: ${errorMessage(err)}`));
      const project = city.updateProject(projectId, { isGit: true });
      await notify('onProjectUpdated', () => agents.onProjectUpdated(project));
      return project;
    },

    async create({ name, lotId, style, template }) {
      const display = clipName(name, MAX_PROJECT_NAME);
      if (!display) throw new UserError('Give the project a name');
      requireFreeLot(lotId);
      mkdirSync(d.workspaceRoot, { recursive: true });
      const base = slugify(display) || 'project';
      const folder = uniqueName(base, (c) => existsSync(join(d.workspaceRoot, c)));
      const dir = join(d.workspaceRoot, folder);
      mkdirSync(dir);
      try {
        writeFiles(dir, templateFiles(template, display, folder));
        await git.initRepo(dir, 'Initial commit (created with CAST)');
      } catch (err) {
        rmSync(dir, { recursive: true, force: true }); // we just made it; leave no half-built folder behind
        throw new UserError(`Could not create the project: ${errorMessage(err)}`);
      }
      const project = city.addProject({
        name: display,
        path: dir,
        lotId,
        style,
        isGit: true,
        workflowId: null,
        approvalMode: 'write',
        floors: 1,
      });
      jobs.list(project.id);
      if (template !== 'empty') jobs.update(project.id, MAIN_JOB_ID, { kind: template === 'novel' ? 'write' : 'code' });
      log('city', `created ${project.id} (${template}) at ${dir} on ${lotId}`);
      await notify('onProjectAdded', () => agents.onProjectAdded(project));
      return project;
    },

    async move(projectId, lotId) {
      const p = requireProject(projectId);
      if (p.lotId === lotId) return p;
      requireFreeLot(lotId);
      return city.updateProject(projectId, { lotId });
    },

    async remove(projectId, opts = {}) {
      const project = requireProject(projectId);
      city.removeProject(projectId); // the folder on disk is never touched
      await notify('onProjectRemoved', () => agents.onProjectRemoved(projectId));
      jobs.removeProject(projectId);
      // Only now: its people have saved their last words and their omp processes are gone, so nothing writes again.
      if (opts.deleteHistory && d.dataDir) {
        const gone = removeHouseHistory(d.dataDir, projectId);
        await removeHouseArtifacts(project, 'runs');
        const pictures = pruneUploads(d.dataDir);
        log('city', `deleted the history of ${projectId} (${gone.length} folder${gone.length === 1 ? '' : 's'}, ${pictures} picture${pictures === 1 ? '' : 's'})`);
      }
    },

    async update(projectId, patch) {
      requireProject(projectId);
      if (patch.path !== undefined) await relocate(requireProject(projectId), patch.path);
      if (patch.workflowId) {
        // one of the house's own workflows (another house's, or one in the library, is imported first)
        const why = teamProblem(agents.snapshot(), projectId, patch.workflowId);
        if (why) throw new UserError(why);
      }
      const clean: Partial<Omit<Project, 'id'>> = {};
      if (patch.name !== undefined) clean.name = clipName(patch.name, MAX_PROJECT_NAME) || requireProject(projectId).name;
      if (patch.style !== undefined) clean.style = patch.style;
      if (patch.approvalMode !== undefined) clean.approvalMode = patch.approvalMode;
      if (patch.workflowId !== undefined) clean.workflowId = patch.workflowId;
      // (undefined, not null: city.json leaves the key out and the house follows the default again)
      if (patch.maxRunsPerAsk !== undefined) clean.maxRunsPerAsk = patch.maxRunsPerAsk ?? undefined;
      if (!Object.keys(clean).length) return requireProject(projectId); // only the folder changed (relocate did it)
      const project = city.updateProject(projectId, clean);
      // The house team is the Main job's team: keep both in step for clients that still set it here.
      if (clean.workflowId !== undefined && jobs.get(projectId, MAIN_JOB_ID)) {
        jobs.update(projectId, MAIN_JOB_ID, { workflowId: clean.workflowId });
      }
      await notify('onProjectUpdated', () => agents.onProjectUpdated(project));
      return project;
    },
  };
}
