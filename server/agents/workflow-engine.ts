// Workflow engine: RLT owns the graph (deterministic order, review loops), each step runs on that role's
// own omp process/person. A run: checkpoint → for each group of steps: render the instruction, prompt the role,
// wait for prompt_result + session_settled, keep the final text, parse review verdicts, hand off a
// folder to the next person, loop back on "revise" (bounded by maxLoops) → completed / failed / aborted.
// A group is one step, or a step plus the consecutive steps after it with parallel:true: its people work at the same
// time on the same {{prev}}, the next step gets all their replies, and one failing stops the others and the run.
// A run is the job's own team (its standing people), or any other team — another workflow, other models, a one-off
// team made for the task — whose people are temporary (`x-<step id>`) and leave after the run.
// A run works in its job's folder (jobDir): the house, or the job's own copy of the files — its run dir
// (.rlt/runs/<id>), checkpoints and revert are there.
// A continuation (continueFrom) is a new run that redoes only part of an ended run: the steps before the one it
// starts from keep their results (their final replies feed {{prev}}, their hand-off files are copied into the new
// run dir), and that step and every step after it work again on the files as they are now — nothing is reverted.
import { appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, relative } from 'node:path';
import { THINKING_LEVELS, type AgentInfo, type Job, type Project, type RevertPlan, type RunPlanView, type RunTeamMember, type ThinkingLevel, type Workflow, type WorkflowRun, type WorkflowRunStep, type WorkflowStep } from '../../shared/protocol';
import type { CityStore, GitService, Hub, JobStore } from '../contracts';
import { agentIdFor, MAIN_JOB_ID } from '../data-layout';
import { COPY_RUN_MARK, jobDir } from '../worktrees';
import type { AgentRuntime, PromptOutcome } from './agent-runtime';
import type { AgentStore } from './agent-store';
import type { ApprovalBook } from './approvals';
import type { GitRefresher } from './git-refresh';
import type { ModelRegistry } from './models';
import type { SubagentTracker } from './subagents';
import { continueNote, parallelNote, renderInstruction, VERDICT_FOOTER } from './templates';
import { changedPaths } from './tool-display';
import { errorText, log, newId, truncate } from './util';
import { parseVerdict } from './verdict';
import { groupStarts, normalizeWorkflow, type WorkflowStore } from './workflow-store';

const MAX_OUTPUT = 8 * 1024;
const MAX_RUNS_KEPT = 60;
const HANDOFF_SHOW_MS = 3500;
/** Temporary people leave this long after the run's end snapshot (like helpers, subagents.ts). */
const LEAVE_AFTER_MS = 6000;
/** A continuation copies at most this much of the earlier run's hand-off files into its own run dir. */
const MAX_SEED_BYTES = 50 * 1024 * 1024;
const MODEL_ID = /^[\w.-]+\/[\w./:@-]+$/;
/** Files of a run dir that belong to that run only (a continuation writes its own): the step replies `NN-<id>.md`. */
const OWN_RUN_FILES = new Set(['run.json', 'undo.json', 'team.json', 'task.md']);
const STEP_REPLY = /^\d{2,}-[\w.-]+\.md$/;
/** A step id as RLT writes it (workflow-store / prepareSteps: a slug, never `x-`): safe in file names and agent ids. */
const STEP_ID = /^(?!x-)[a-z0-9][a-z0-9-]{0,63}$/;
/** A run keeps its latest plan changes (run.edits); planRev counts them all. */
const MAX_EDITS_KEPT = 30;

/** Who started a run, and whether its team is a one-off one. */
export interface StartOptions {
  startedBy: 'lead' | 'user'; // the job's lead (team_start) or the user (the Workflow tab)
  adhoc?: boolean; // a one-off team made for this task: in no workflow (run.workflowId '')
}

/** What a continuation may change (team_continue / continue_run). */
export interface ContinueOptions {
  note?: string; // what must be different this time (the people of the first step that runs again get it)
  task?: string; // a new brief (default: the earlier run's task)
  models?: Record<string, string>; // step id (written or `x-`) → model, this run only
  thinking?: Record<string, ThinkingLevel | ''>; // step id (written or `x-`) → effort ('' = omp's default), this run only
  /** Another team than the run's team.json (step ids as written): the steps before the one it starts from must be as
   *  they ran — a running team changed in a way that redoes work (team_edit redo). */
  team?: WorkflowStep[];
  /** Check a run that still goes (team_edit redo plans the continuation before it stops the run): only its finished
   *  steps before the start count as kept. */
  live?: boolean;
}

/** A change to a going run's plan (editRun): the whole plan after it, step ids as written. */
export interface RunEditInput {
  by: 'lead' | 'user';
  steps: WorkflowStep[];
  changes: string[]; // for run.edits
  /** Notes for people of the group working or starting now (written step ids). */
  notes?: { stepId: string; text: string }[];
  saved?: string; // also saved to this workflow (its name)
}

/** How each note of an edit reaches its person: steered into their turn now, or with their step's prompt. */
export interface RunEditResult {
  run: WorkflowRun;
  delivered: { stepId: string; name: string; how: 'steered' | 'prompt' }[];
}

/** A continuation, checked and worked out (planContinue): what runs again, what is kept, on which team. */
export interface ContinuePlan {
  from: WorkflowRun;
  project: Project;
  job: Job;
  dir: string; // the job's folder (the earlier run's)
  team: WorkflowStep[]; // the earlier run's team as it ran, step ids as written, `models` applied → the new team.json
  startIndex: number; // the first step that runs again (the first step of its parallel group)
  fromStepId: string; // its id as written
  own: boolean; // the job's standing people do it (else temporary `x-` people)
  task: string;
  note?: string;
  /** team[0..startIndex-1]: each step's last attempt in the earlier run (`index` in its steps[]) and its full reply. */
  kept: { step: WorkflowStep; rs: WorkflowRunStep; index: number; text: string; file: string; full: boolean }[];
  /** The start group's earlier replies (written step id → project-relative file), when they exist. */
  earlier: Record<string, string>;
  /** Hand-off files of the earlier run dir to copy (relative to it), within MAX_SEED_BYTES. */
  handoff: string[];
  /** For the lead and the plan card: the start moved to its group, shortened replies, other runs since, people. */
  notes: string[];
}

/** A continuation while it runs. */
interface Continuing {
  fromRunId: string;
  startIndex: number;
  startId: string; // this run's id of the step it starts from (the plan can change while it runs: ids, not indexes)
  prev: { name: string; text: string }; // the kept group just before startIndex: the first group's {{prev}}
  note?: string;
  earlier: Map<string, string>; // this run's step id → that person's earlier reply (project-relative)
  fromName: string;
  keptChain: string; // "A → B + C"
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** The index in run.steps of a step's last attempt (by its id as written), or -1. */
function lastAttempt(run: WorkflowRun, id: string): number {
  for (let k = run.steps.length - 1; k >= 0; k--) if (writtenStepId(run.steps[k]!.stepId) === id) return k;
  return -1;
}

/** "A → B + C → D": people in order, those who work at the same time joined with " + ". */
function chain(steps: Pick<WorkflowStep, 'name' | 'parallel'>[]): string {
  return steps.map((s, i) => `${i === 0 ? '' : s.parallel ? ' + ' : ' → '}${s.name}`).join('');
}

/** The fields that make a step the same person doing the same work. */
export const stepKey = (s: WorkflowStep) =>
  JSON.stringify([s.id, s.name, s.model, s.kind, s.thinking ?? null, s.persona, s.instruction, s.loopBackTo ?? null, s.loopBackTo ? (s.maxLoops ?? 2) : null, s.parallel === true]);

/** The fields that make two teams the same people doing the same work. */
function sameTeam(a: WorkflowStep[], b: WorkflowStep[]): boolean {
  return a.length === b.length && a.every((s, i) => stepKey(s) === stepKey(b[i]!));
}

/** The end of the group that starts at `start` (the first index after it). */
function groupEnd(steps: WorkflowStep[], start: number): number {
  const starts = groupStarts(steps);
  let end = start + 1;
  while (end < steps.length && starts[end] === start) end++;
  return end;
}

/** The lowest step a review loop can send the work back to, from `start` on (a loop target inside a group runs the
 *  whole group): what a continuation from `start` may still run. */
export function reachFrom(steps: WorkflowStep[], start: number): number {
  const starts = groupStarts(steps);
  let lo = start;
  for (let changed = true; changed; ) {
    changed = false;
    for (const [j, s] of steps.entries()) {
      if (j < lo || s.kind !== 'review' || !s.loopBackTo || (s.maxLoops ?? 2) <= 0) continue;
      const t = steps.findIndex((x) => x.id === s.loopBackTo);
      if (t >= 0 && starts[t]! < lo) [lo, changed] = [starts[t]!, true];
    }
  }
  return lo;
}

/** The people of a run that isn't the job's own team: `x-<step id>` (loop targets too), so they are never one of
 *  the job's standing team — whose ids can't start with `x-` (workflow-store safeStepId). */
export function temporaryTeam(steps: WorkflowStep[]): WorkflowStep[] {
  return steps.map((s) => ({ ...s, id: `x-${s.id}`, ...(s.loopBackTo ? { loopBackTo: `x-${s.loopBackTo}` } : {}) }));
}

/** run.team: who works on each step of the run (`edited`: written step ids added or changed while it ran). */
function teamMembers(projectId: string, jobId: string, steps: WorkflowStep[], edited?: ReadonlySet<string>): RunTeamMember[] {
  return steps.map((s) => ({
    id: s.id,
    agentId: agentIdFor(projectId, jobId, s.id),
    name: s.name,
    model: s.model,
    kind: s.kind,
    ...(s.loopBackTo ? { loopBackTo: s.loopBackTo } : {}),
    ...(s.parallel ? { parallel: true } : {}),
    ...(edited?.has(writtenStepId(s.id)) ? { edited: true as const } : {}),
  }));
}

/** A step id as written in the workflow (a temporary person's `x-` taken off). */
export const writtenStepId = (id: string) => id.replace(/^x-/, '');

export interface EngineDeps {
  hub: Hub;
  city: CityStore;
  jobs: JobStore;
  git: GitService;
  store: AgentStore;
  approvals: ApprovalBook;
  subagents: SubagentTracker;
  gitRefresh: GitRefresher;
  workflows: WorkflowStore;
  /** state and detectError are optional: a test fake without them never counts as 'checking'. */
  models: Pick<ModelRegistry, 'anyAvailable' | 'isAvailable' | 'models' | 'label' | 'demoActive'> & Partial<Pick<ModelRegistry, 'state' | 'detectError'>>;
  /** Upsert the person for this step of the run's team (if needed) and return their runtime. A changed step of a
   *  going run (editRun) is upserted again with its new version. */
  ensureRole(project: Project, job: Job, step: WorkflowStep): AgentRuntime;
  /** A run ended (completed, failed or stopped) — e.g. tell the lead who started it. */
  onFinish?(run: WorkflowRun): void;
  /** The run's temporary people may leave now (its end snapshot is taken), or people taken out of a going run's plan
   *  before they worked: send home whoever no run needs (and put changed standing people back as saved). */
  onPeopleLeave?(run: WorkflowRun): void;
  toast(level: 'info' | 'success' | 'warn' | 'error', text: string, projectId?: string, agentId?: string): void;
}

/** A step attempt or a run that may wait for the user: close an open wait at `at` (it adds to waitedMs). */
export function closeWait(x: { waitedMs?: number; waitingSince?: number }, at: number): boolean {
  if (x.waitingSince === undefined) return false;
  x.waitedMs = (x.waitedMs ?? 0) + Math.max(0, at - x.waitingSince);
  delete x.waitingSince;
  return true;
}

/** Start or stop the wait clocks of a run and of its running attempts (an attempt waits while its person has an
 *  approval pending; the run while its status is waiting_approval), so durations can show working time apart from
 *  the time the team sat waiting for the user. True when anything changed. */
export function trackWaits(run: WorkflowRun, asking: (agentId: string) => boolean, now = Date.now()): boolean {
  let changed = false;
  for (const st of run.steps) {
    const waits = st.status === 'running' && asking(st.agentId);
    if (waits && st.waitingSince === undefined) {
      st.waitingSince = now;
      changed = true;
    } else if (!waits && closeWait(st, now)) changed = true;
  }
  if (run.status === 'waiting_approval' && run.waitingSince === undefined) {
    run.waitingSince = now;
    changed = true;
  } else if (run.status !== 'waiting_approval' && closeWait(run, now)) changed = true;
  return changed;
}

interface Active {
  run: WorkflowRun;
  dir: string; // the folder the run works in (its job's own copy, or the house), fixed when it starts
  workflow: Workflow; // the steps this run works through (temporary people: `x-` ids)
  temp: boolean; // its people are temporary and leave after the run
  /** The people of the group that works now, or worked last (Stop on any of them stops the run). */
  group: AgentRuntime[];
  /** Who is working on a step right now (agentId → their agent+helper cost when their step started). */
  working: Map<string, number>;
  costBase: number; // run cost of the steps that finished
  aborted: boolean;
  /** People of other jobs who changed files in the same folder while this run worked (their work is not the run's).
   *  A job with its own copy shares its folder with nobody. */
  others: Map<string, Outsider>;
  cont?: Continuing; // this run continues an earlier one
  /** The group working or starting now (indexes into workflow.steps): steps from `end` on can still change (editRun). */
  at: { start: number; end: number };
  /** The group's people were asked (before that, a note goes into their prompt; after it, into their turn). */
  asked: boolean;
  /** Notes for people of the group starting now, added to their prompt (run step id → texts). */
  notes: Map<string, string[]>;
  /** Notes steered into a person's turn they may not have read yet (agentId → queue keys): taken back at their step's end. */
  steered: Map<string, string[]>;
  /** Written step ids added or changed while the run went (run.team's `edited`). */
  edited: Set<string>;
}

/** One person's step in the group that works now. */
interface Member {
  step: WorkflowStep;
  runtime: AgentRuntime;
  rs: WorkflowRunStep;
  attempt: number; // NN of the saved output file
  text: string; // their final reply (once done)
  notes: string; // a review's notes (once done)
}

/** What the next group gets: {{prev}} / {{prevName}}, and who hands it over (one folder per person). */
interface Handed {
  name: string;
  text: string;
  from: { runtime: AgentRuntime; label: string }[];
}

interface Outsider {
  label: string; // "Developer (Side)"
  paths: Set<string>; // project-relative files they wrote
  unknown: boolean; // they also ran commands or sent helpers (files unknown)
}

/** <run's folder>/.rlt/runs/<runId>/undo.json: what a revert needs besides the checkpoint. */
interface UndoRecord {
  end?: string; // snapshot ref taken when the run finished
  others: { label: string; paths: string[]; unknown: boolean }[];
  /** The run worked in a job's own copy that was deleted (its runs moved to the house): the branch keeping its work. */
  copyOf?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A tool's path argument → project-relative path (null when it points outside the project). */
function projectRel(root: string, p: string): string | null {
  const rel = isAbsolute(p) ? relative(root, p) : normalize(p);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel.replace(/^\.\//, '');
}

/** GitService works on a project's folder: for a run in a job's own copy, that copy. */
const projectAt = (project: Project, dir: string): Project => (dir === project.path ? project : { ...project, path: dir });

/** "A", "A and B", "A, B and C". */
function andList(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** What a group hands on: one person's reply as it is; several under "## <Name>", names joined with " + ". */
function combined(members: Pick<Member, 'step' | 'text'>[]): { name: string; text: string } {
  if (members.length === 1) return { name: members[0]!.step.name, text: members[0]!.text };
  return { name: members.map((m) => m.step.name).join(' + '), text: members.map((m) => `## ${m.step.name}\n${m.text.trim()}`).join('\n\n') };
}

export class EngineError extends Error {}

export class WorkflowEngine {
  #runs = new Map<string, WorkflowRun>();
  #active = new Map<string, Active>(); // runId → active state
  #undo = new Map<string, Promise<UndoRecord | null>>(); // runId → end snapshot being recorded
  /** runId → the folder of a run whose end snapshot is still being taken (until it is): a run starting there waits. */
  #ending = new Map<string, string>();
  /** runId → temporary people of a finished run who stay until its end snapshot is taken (then 6 s more). */
  #leaving = new Map<string, Set<string>>();
  #costTimer?: ReturnType<typeof setTimeout>;
  #unsub: () => void;
  #disposed = false;

  constructor(private readonly d: EngineDeps) {
    // Live cost while a step works (coalesced to ~1 update/s).
    this.#unsub = d.store.onChange((a) => {
      for (const act of this.#active.values()) {
        if (act.working.has(a.id) || (a.parentId && act.working.has(a.parentId))) this.#scheduleCostEmit();
      }
    });
  }

  runs(): WorkflowRun[] {
    return [...this.#runs.values()];
  }

  /** Bring back finished runs of a project from <folder>/.rlt/runs/<runId>/run.json (survives restarts) — the house
   *  folder and each job's own copy. */
  loadHistory(project: Project): void {
    const loaded: WorkflowRun[] = [];
    const folders = [project.path, ...this.d.jobs.list(project.id).filter((j) => j.worktree).map((j) => jobDir(project, j))];
    for (const folder of folders) this.#loadRuns(project, join(folder, '.rlt/runs'), loaded);
    loaded.sort((a, b) => a.startedAt - b.startedAt);
    for (const run of loaded) this.#runs.set(run.id, run);
    if (loaded.length) {
      // keep #runs in start order so history trimming drops the oldest
      const all = [...this.#runs.values()].sort((a, b) => a.startedAt - b.startedAt);
      this.#runs.clear();
      for (const r of all) this.#runs.set(r.id, r);
      this.#trimHistory();
    }
  }

  #loadRuns(project: Project, dir: string, loaded: WorkflowRun[]): void {
    let ids: string[];
    try {
      ids = readdirSync(dir);
    } catch {
      return; // no runs yet
    }
    for (const id of ids) {
      if (this.#runs.has(id) || loaded.some((r) => r.id === id)) continue;
      let interrupted = false;
      try {
        const run = JSON.parse(readFileSync(join(dir, id, 'run.json'), 'utf8')) as WorkflowRun;
        if (!run || run.id !== id || !Array.isArray(run.steps) || typeof run.startedAt !== 'number') continue;
        if (run.status === 'running' || run.status === 'waiting_approval') {
          // the server stopped mid-run (run.json is saved after every group): show it as stopped rather than forever
          // running, ended when its last step did — it can be continued from the step that didn't finish
          run.status = 'aborted';
          run.currentStepId = null;
          run.currentStepIds = [];
          // (a continuation's kept steps ended before it started)
          const ends = run.steps.filter((s) => !s.reused).map((s) => s.endedAt).filter((t): t is number => typeof t === 'number');
          run.endedAt ??= Math.max(run.startedAt, ...ends);
          for (const st of run.steps) if (st.status === 'running') st.status = 'failed';
          run.interrupted = true; // CAST stopped, not the user
          for (const st of run.steps) closeWait(st, st.endedAt ?? run.endedAt);
          closeWait(run, run.endedAt);
          interrupted = true;
        }
        // Runs saved before jobs existed belong to the house's Main job.
        const final = { ...run, projectId: project.id, jobId: typeof run.jobId === 'string' && run.jobId ? run.jobId : MAIN_JOB_ID };
        loaded.push(final);
        if (interrupted && final.checkpoint) {
          const folder = dirname(dirname(dir)); // dir = <folder>/.rlt/runs
          const undo = this.#readUndo(folder, id);
          if (!undo?.end && !undo?.copyOf) this.#recording(id, folder, this.#endAfterStop(project, folder, final, undo));
        }
      } catch {
        /* run.json missing or unreadable (run still in progress when the server stopped) */
      }
    }
  }

  /** The folder a finished run worked in: its job's (a deleted job's runs are in the house folder). */
  #dirOf(run: WorkflowRun, project: Project): string {
    return this.#active.get(run.id)?.dir ?? jobDir(project, this.d.jobs.get(run.projectId, run.jobId));
  }

  get(runId: string): WorkflowRun | undefined {
    return this.#runs.get(runId);
  }

  /** True when this agent is a person currently working on an active run step. */
  isBusyInRun(agentId: string): boolean {
    for (const a of this.#active.values()) if (a.working.has(agentId)) return true;
    return false;
  }

  /** The going run whose current group (the people working now, or who worked last) has this person — Stop on any
   *  of them stops the whole run. */
  runAt(agentId: string): WorkflowRun | undefined {
    for (const a of this.#active.values()) if (a.group.some((rt) => rt.agentId === agentId)) return a.run;
    return undefined;
  }

  /** True when this agent is on (or took part in) a run that is still going, or on a finished run's temporary team
   *  that hasn't left yet — keep them in the house. */
  inActiveRun(agentId: string): boolean {
    return !!this.activeRunWith(agentId) || [...this.#leaving.values()].some((ids) => ids.has(agentId));
  }

  /** The still-going run this agent is on the team of, works on or took part in. */
  activeRunWith(agentId: string): WorkflowRun | undefined {
    for (const a of this.#active.values()) {
      if (a.working.has(agentId) || a.run.steps.some((s) => s.agentId === agentId) || a.run.team?.some((m) => m.agentId === agentId)) return a.run;
    }
    return undefined;
  }

  /** The team a run worked with, step ids as written (its team.json; null for runs from before teams were kept). */
  teamOf(runId: string): WorkflowStep[] | null {
    const run = this.#runs.get(runId);
    const project = run && this.d.city.project(run.projectId);
    if (!run || !project) return null;
    return this.#readTeam(this.#dirOf(run, project), run.id);
  }

  #readTeam(dir: string, runId: string): WorkflowStep[] | null {
    try {
      const raw = JSON.parse(readFileSync(join(dir, '.rlt/runs', runId, 'team.json'), 'utf8')) as WorkflowStep[];
      if (!Array.isArray(raw) || !raw.length) return null;
      return raw.map((s) => ({ ...s, id: writtenStepId(String(s.id)), ...(s.loopBackTo ? { loopBackTo: writtenStepId(String(s.loopBackTo)) } : {}) }));
    } catch {
      return null;
    }
  }

  /** A house's saved workflow is about to be deleted: that house's runs of it from before teams were kept with the run
   *  (their people were the job's standing team) get that team now — run.team and team.json — so they still show and
   *  name their people. Other houses' runs of a workflow with the same id are another workflow's. */
  keepTeamsOf(projectId: string, workflow: Workflow): void {
    for (const run of this.#runs.values()) {
      if (run.team || run.projectId !== projectId || run.workflowId !== workflow.id) continue;
      run.team = teamMembers(run.projectId, run.jobId, workflow.steps);
      const project = this.d.city.project(run.projectId);
      if (project) {
        const dir = this.#dirOf(run, project);
        this.#saveRun(dir, run);
        this.#writeTeam(dir, run, workflow.steps);
      }
      this.#emit(run);
    }
  }

  /** Someone's file-changing tool finished: if they are not on a run going on in the same folder (another job's
   *  people, or this job's lead and its helpers), remember it, so reverting that run leaves their files alone (and
   *  says who else worked meanwhile). */
  noteFileTool(agentId: string, tool: string, args: unknown): void {
    if (!this.#active.size) return;
    const a = this.d.store.get(agentId);
    if (!a) return;
    const project = this.d.city.project(a.projectId);
    if (!project) return;
    const dir = jobDir(project, this.d.jobs.get(a.projectId, a.jobId));
    for (const act of this.#active.values()) {
      if (act.run.projectId !== a.projectId || act.dir !== dir || this.#onRun(act, a)) continue;
      let o = act.others.get(agentId);
      if (!o) {
        o = { label: this.#label(a), paths: new Set(), unknown: false };
        act.others.set(agentId, o);
      }
      const paths = changedPaths(tool, args);
      if (!paths) o.unknown = true;
      else for (const p of paths) {
        const rel = projectRel(dir, p);
        if (rel) o.paths.add(rel);
      }
    }
  }

  /** The run's own people and their helpers. Runs without a team (none since teams are kept): the whole job. */
  #onRun(act: Active, a: AgentInfo): boolean {
    if (!act.run.team) return act.run.jobId === a.jobId;
    const owner = a.kind === 'subagent' && a.parentId ? a.parentId : a.id;
    return act.run.team.some((m) => m.agentId === owner);
  }

  /** The active run of a job (each job runs at most one workflow at a time; jobs run side by side). */
  activeRunOf(projectId: string, jobId: string): WorkflowRun | undefined {
    for (const a of this.#active.values()) if (a.run.projectId === projectId && a.run.jobId === jobId) return a.run;
    return undefined;
  }

  // ───────────────────────── changing a going run ─────────────────────────

  /** A going run's plan, step ids as written: what is behind, the group working or starting now, what can change.
   *  Throws EngineError when the run isn't going. */
  planOf(runId: string): RunPlanView {
    const act = this.#active.get(runId);
    if (!act || act.aborted) throw new EngineError(this.#runs.has(runId) ? 'That run has ended — nothing of it can change any more.' : `No run “${runId}”.`);
    const { run } = act;
    const steps = this.#plan(act);
    const states: RunPlanView['states'] = {};
    for (const [k, st] of steps.entries()) {
      if (k < act.at.start) states[st.id] = 'done';
      else if (k >= act.at.end) states[st.id] = 'next';
      else if (!act.asked) states[st.id] = 'starting';
      else states[st.id] = act.working.has(agentIdFor(run.projectId, run.jobId, act.workflow.steps[k]!.id)) ? 'working' : 'finished';
    }
    const taken = new Set([...steps.map((x) => x.id), ...run.steps.map((x) => writtenStepId(x.stepId))]);
    return {
      runId,
      rev: run.planRev ?? 0,
      workflowId: run.workflowId,
      workflowName: run.workflowName,
      own: !act.temp,
      steps,
      done: act.at.start,
      frozen: act.at.end,
      states,
      taken: [...taken],
    };
  }

  /** The step of a going run of the job's own team that this standing person works on — the run's version of them
   *  (it may differ from the saved workflow: editRun, or the workflow saved while it runs). */
  runStepOf(agentId: string): WorkflowStep | undefined {
    for (const act of this.#active.values()) {
      if (act.temp) continue;
      const step = act.workflow.steps.find((s) => agentIdFor(act.run.projectId, act.run.jobId, s.id) === agentId);
      if (step) return step;
    }
    return undefined;
  }

  /** Change a going run's plan — it keeps going: the steps that haven't started take the new plan (added, removed,
   *  changed, moved), the group working now and every step before it stay exactly as they are (refused otherwise),
   *  and notes reach the people of the group working now (into their turn) or starting now (into their prompt).
   *  Synchronous, so nothing of the run moves on between the checks and the change. dryRun: only check. Throws
   *  EngineError. */
  editRun(runId: string, e: RunEditInput, opts: { dryRun?: boolean } = {}): RunEditResult {
    const act = this.#active.get(runId);
    if (!act || act.aborted) throw new EngineError(this.#runs.has(runId) ? 'That run has ended — nothing of it can change any more.' : `No run “${runId}”.`);
    const { run } = act;
    const project = this.d.city.project(run.projectId);
    const job = this.d.jobs.get(run.projectId, run.jobId);
    if (!project || !job) throw new EngineError("That run's house or job no longer exists.");
    const old = this.#plan(act);
    const { start, end: frozen } = act.at;
    const next = e.steps;
    // The group working now and everything before it, exactly as they are.
    for (let k = 0; k < frozen; k++) {
      if (next[k] && stepKey(next[k]!) === stepKey(old[k]!)) continue;
      throw new EngineError(
        k < start
          ? `“${old[k]!.name}” already finished in this run — it keeps its result.`
          : `“${old[k]!.name}” started meanwhile — it works with the version it had; send them a note instead.`,
      );
    }
    if (next[frozen]?.parallel) {
      throw new EngineError(`“${next[frozen]!.name}” can't join the group working now (${old.slice(start, frozen).map((x) => x.name).join(' + ')}) — add it after them.`);
    }
    // The rest: a valid team, ids as given (an id normalizeWorkflow would change can't name a file or person).
    let norm: WorkflowStep[];
    try {
      norm = normalizeWorkflow({ id: 'run', name: run.workflowName || 'Run', steps: next }).steps;
    } catch (err) {
      throw new EngineError(errorText(err));
    }
    for (let k = frozen; k < next.length; k++) {
      if (!STEP_ID.test(next[k]!.id) || norm[k]!.id !== next[k]!.id) throw new EngineError(`“${next[k]!.name}” can't have the step id “${next[k]!.id}” — use a plain slug like “proofreader”.`);
    }
    const plan = [...old.slice(0, frozen), ...norm.slice(frozen)];
    // Every step a review loop can still send the work to must be on a connected model.
    this.#checkModels(plan.slice(reachFrom(plan, start)));
    // Notes: only for the group working or starting now.
    const notes: { k: number; text: string; how: 'steered' | 'prompt'; rt?: AgentRuntime }[] = [];
    for (const n of e.notes ?? []) {
      const k = plan.findIndex((x) => x.id === writtenStepId(n.stepId));
      const name = plan[k]?.name ?? n.stepId;
      if (k < 0 || k >= frozen) throw new EngineError(`“${name}” hasn't started yet — change their step instead of sending a note.`);
      if (k < start) throw new EngineError(`“${name}” already finished in this run — a note can't reach them now.`);
      if (!act.asked) {
        notes.push({ k, text: n.text, how: 'prompt' });
        continue;
      }
      const agentId = agentIdFor(run.projectId, run.jobId, act.workflow.steps[k]!.id);
      if (!act.working.has(agentId)) throw new EngineError(`“${name}” already finished their step — a note can't reach them now.`);
      const rt = act.group.find((x) => x.agentId === agentId);
      if (!rt?.canSteerStep?.()) throw new EngineError(`${name} is still getting ready — send the note again in a moment.`);
      notes.push({ k, text: n.text, how: 'steered', rt });
    }
    const delivered = notes.map((n) => ({ stepId: plan[n.k]!.id, name: plan[n.k]!.name, how: n.how }));
    if (opts.dryRun) return { run, delivered };

    // The new plan: from here the run works through it (the next group reads it).
    const byId = new Map(old.map((x) => [x.id, x]));
    const changed = plan.slice(frozen).filter((x) => byId.get(x.id) === undefined || stepKey(byId.get(x.id)!) !== stepKey(x));
    for (const x of changed) act.edited.add(x.id);
    const removed = old.filter((x) => !plan.some((y) => y.id === x.id));
    const planChanged = changed.length > 0 || removed.length > 0 || plan.length !== old.length || plan.some((x, k) => x.id !== old[k]!.id);
    if (planChanged) {
      act.workflow = { ...act.workflow, steps: act.temp ? temporaryTeam(plan) : plan };
      run.team = teamMembers(run.projectId, run.jobId, act.workflow.steps, act.edited);
    }
    run.planRev = (run.planRev ?? 0) + 1;
    run.edits = [...(run.edits ?? []), { at: Date.now(), by: e.by, changes: e.changes, ...(e.saved ? { saved: e.saved } : {}) }].slice(-MAX_EDITS_KEPT);
    if (planChanged) this.#writeTeam(act.dir, run, plan);
    this.#saveRun(act.dir, run);
    // Added and changed people move in (or take their new version) now: their model shows at once.
    for (const x of changed) this.d.ensureRole(project, job, act.workflow.steps[plan.indexOf(x)]!);
    this.#emit(run);
    // Taken out before they worked: they leave now (those who worked stay until the run ends, with its history).
    if (removed.some((x) => !run.steps.some((st) => writtenStepId(st.stepId) === x.id))) this.d.onPeopleLeave?.(run);
    for (const n of notes) {
      const step = act.workflow.steps[n.k]!;
      if (n.how === 'prompt') {
        act.notes.set(step.id, [...(act.notes.get(step.id) ?? []), n.text]);
        continue;
      }
      const review = step.kind === 'review';
      const text =
        `Note from the user for your current step:\n${n.text}\n\n` +
        `Keep going with your step — your final reply is still your step's report${review ? ' and still ends with the verdict format' : ''}.`;
      const key = n.rt!.steerStep(text, `Note for this step: ${truncate(n.text.replace(/\s+/g, ' '), 300)}`);
      if (key) act.steered.set(n.rt!.agentId, [...(act.steered.get(n.rt!.agentId) ?? []), key]);
    }
    return { run, delivered };
  }

  /** The run's plan, step ids as written. */
  #plan(act: Active): WorkflowStep[] {
    const steps = structuredClone(act.workflow.steps);
    return act.temp ? steps.map((x) => ({ ...x, id: writtenStepId(x.id), ...(x.loopBackTo ? { loopBackTo: writtenStepId(x.loopBackTo) } : {}) })) : steps;
  }

  /** Validate and start a run; the run continues in the background. No jobId → 'main' (or the first job).
   *  `workflow`: a saved workflow's id, or a team to run as given (other models for a saved one, or a one-off team).
   *  Only the job's own team (by id) works with the job's standing people; any other gets temporary people. */
  async start(projectId: string, jobId: string | undefined, workflow: string | Workflow, task: string, opts: StartOptions = { startedBy: 'user' }): Promise<WorkflowRun> {
    const project = this.d.city.project(projectId);
    if (!project) throw new EngineError('That house no longer exists.');
    const job = jobId ? this.d.jobs.get(projectId, jobId) : (this.d.jobs.get(projectId, MAIN_JOB_ID) ?? this.d.jobs.list(projectId)[0]);
    if (!job) throw new EngineError('That job no longer exists.');
    const given = typeof workflow === 'string' ? this.d.workflows.get(projectId, workflow) : workflow;
    if (!given?.steps.length) throw new EngineError('Unknown workflow.');
    const text = task.trim();
    if (!text) throw new EngineError('Tell the team what to do first.');
    if (this.activeRunOf(projectId, job.id)) throw new EngineError(`A workflow is already running in “${job.name}”. Stop it first, or start this one in another job.`);
    this.#checkModels(given.steps);

    const own = typeof workflow === 'string' && !opts.adhoc && workflow === this.#teamIdOf(project, job);
    return this.#launch(project, job, given, own, text, opts);
  }

  /** The job's own team (the Main job falls back to the house's). */
  #teamIdOf(project: Project, job: Job): string | null {
    return job.workflowId ?? (job.id === MAIN_JOB_ID ? project.workflowId : null);
  }

  /** Make the run and start it in the background. Synchronous up to #active.set: a second start for the same job
   *  (a double click, two clients) is refused by activeRunOf. `given`: the team with step ids as written. */
  #launch(project: Project, job: Job, given: Workflow, own: boolean, text: string, opts: StartOptions, cont?: ContinuePlan): WorkflowRun {
    if (this.activeRunOf(project.id, job.id)) throw new EngineError(`A workflow is already running in “${job.name}”. Stop it first, or start this one in another job.`);
    // The run's own copy of its plan: it can change while it runs (editRun) — never the WorkflowStore's array.
    const steps = own ? structuredClone(given.steps) : temporaryTeam(given.steps);
    const begin = cont?.startIndex ?? 0;
    const run: WorkflowRun = {
      id: newId('run'),
      workflowId: opts.adhoc ? '' : given.id,
      workflowName: given.name,
      projectId: project.id,
      jobId: job.id,
      task: truncate(text, 4000),
      status: 'running',
      currentStepId: null,
      loop: 0,
      steps: [],
      startedAt: Date.now(),
      costUsd: 0,
      team: teamMembers(project.id, job.id, steps),
      ...(opts.adhoc ? { adhoc: true } : {}),
      startedBy: opts.startedBy,
      planAt: { start: begin, end: groupEnd(steps, begin) },
    };
    if (cont) {
      run.continues = { runId: cont.from.id, stepId: steps[cont.startIndex]!.id, ...(cont.note ? { note: cont.note } : {}) };
      // The kept steps, as they ended in the earlier run (not run again here).
      run.steps = cont.kept.map((k, i) => ({
        stepId: steps[i]!.id,
        status: 'done',
        agentId: agentIdFor(project.id, job.id, steps[i]!.id),
        ...(k.rs.output !== undefined ? { output: k.rs.output } : {}),
        ...(k.rs.verdict ? { verdict: k.rs.verdict } : {}),
        ...(k.rs.startedAt !== undefined ? { startedAt: k.rs.startedAt } : {}),
        ...(k.rs.endedAt !== undefined ? { endedAt: k.rs.endedAt } : {}),
        reused: { runId: cont.from.id, index: k.index },
      }));
    }
    this.#runs.set(run.id, run);
    this.#trimHistory();
    const act: Active = {
      run, dir: jobDir(project, job), workflow: { ...given, steps }, temp: !own, group: [], working: new Map(), costBase: 0, aborted: false, others: new Map(),
      at: { ...run.planAt! }, asked: false, notes: new Map(), steered: new Map(), edited: new Set(),
    };
    if (cont) {
      const starts = groupStarts(given.steps);
      const before = cont.startIndex > 0 ? cont.kept.slice(starts[cont.startIndex - 1]!, cont.startIndex) : [];
      act.cont = {
        fromRunId: cont.from.id,
        startIndex: cont.startIndex,
        startId: steps[cont.startIndex]!.id,
        prev: before.length ? combined(before) : { name: 'The user', text: '' },
        ...(cont.note ? { note: cont.note } : {}),
        earlier: new Map(Object.entries(cont.earlier).map(([id, file]) => [steps[given.steps.findIndex((s) => s.id === id)]!.id, file])),
        fromName: given.steps[cont.startIndex]!.name,
        keptChain: chain(given.steps.slice(0, cont.startIndex)),
      };
    }
    this.#active.set(run.id, act);
    // The team moves in now (a temporary person exists from here until they leave after the run) — in a continuation
    // only those who work again; a kept step's person comes when a review sends the work back to them.
    for (const step of steps.slice(cont?.startIndex ?? 0)) this.d.ensureRole(project, job, step);
    this.#emit(run);
    this.#writeTeam(act.dir, run, given.steps);
    if (cont) this.#seedRunDir(join(cont.dir, '.rlt/runs', cont.from.id), join(act.dir, '.rlt/runs', run.id), cont);
    void this.#execute(act, project, job).catch((err) => {
      log('flows', `run ${run.id} crashed: ${errorText(err)}`);
      this.#finish(act, 'failed', `Workflow failed: ${errorText(err)}`);
    });
    return run;
  }

  // ───────────────────────── continuing a run ─────────────────────────

  /** Check a continuation of an ended run from one of its steps and work out what it would do — no side effects.
   *  `fromStep`: a step id as written, the run's own id of it (`x-…`) or its name. Throws EngineError. */
  planContinue(runId: string, fromStep: string, opts: ContinueOptions = {}): ContinuePlan {
    // 1–3. The run, ended, of a job that still exists.
    const from = this.#runs.get(runId);
    if (!from) throw new EngineError(`No run “${runId}” — it is no longer in history (CAST keeps the last ${MAX_RUNS_KEPT} runs). Start the team again instead.`);
    if (this.#active.has(runId) && !opts.live) throw new EngineError(`“${from.workflowName}” is still running — wait for it to end (or stop it) before continuing it.`);
    const project = this.d.city.project(from.projectId);
    if (!project) throw new EngineError('That house no longer exists.');
    const job = this.d.jobs.get(from.projectId, from.jobId);
    if (!job) throw new EngineError("That run's job no longer exists.");
    // 4. In the job's folder, as the run left it.
    const dir = this.#dirOf(from, project);
    if (dir !== jobDir(project, job)) throw new EngineError("That run worked in another folder than its job's now — start the team again.");
    const copyOf = this.#readUndo(dir, runId)?.copyOf;
    if (copyOf) {
      throw new EngineError(`This run worked in its job's own copy of the files, which went with the job — its work is kept on branch ${copyOf}. Start the team again instead.`);
    }
    const oldDir = join(dir, '.rlt/runs', runId);
    if (!existsSync(oldDir)) throw new EngineError(`CAST can't find the folder of that run (.rlt/runs/${runId}) in this job's files — start the team again.`);

    // 5. Its team as it ran: team.json, else its saved workflow when that still has the same steps.
    const notes: string[] = [];
    let team = this.#readTeam(dir, runId);
    if (!team) {
      const saved = this.d.workflows.get(from.projectId, from.workflowId);
      const ids = from.team?.map((m) => writtenStepId(m.id));
      if (!saved || !ids || saved.steps.map((s) => s.id).join('\n') !== ids.join('\n')) {
        throw new EngineError(`CAST didn't keep the team of run ${runId}${saved ? ', and its workflow has other steps now' : ''} — start the team again with team_start.`);
      }
      team = structuredClone(saved.steps);
      notes.push(`CAST didn't keep that run's team, so “${saved.name}” works as it is saved now.`);
    }
    // team.json is a file in the job's folder: its ids name files and people, and must be the steps the run had
    const ran = from.team?.map((m) => writtenStepId(m.id));
    if (team.some((s) => typeof s.id !== 'string' || !STEP_ID.test(s.id)) || (ran && ran.join('\n') !== team.map((s) => s.id).join('\n'))) {
      throw new EngineError(`CAST's record of that run's team (.rlt/runs/${runId}/team.json) doesn't match the run — start the team again with team_start.`);
    }
    const ranTeam = team;
    // Another team (a running team changed in a way that redoes work): checked once its start is known.
    if (opts.team) {
      if (!opts.team.length || opts.team.some((s) => typeof s.id !== 'string' || !STEP_ID.test(s.id)) || new Set(opts.team.map((s) => s.id)).size !== opts.team.length) {
        throw new EngineError("The changed team's step ids must be plain step ids (as team_status shows them), each once.");
      }
      team = structuredClone(opts.team);
    }
    const asRan = structuredClone(team);

    // 6–7. Where it starts: the first step of the group the asked-for step works in.
    const ask = fromStep.trim();
    let idx = team.findIndex((s) => s.id === ask);
    if (idx < 0) idx = team.findIndex((s) => s.id === writtenStepId(ask));
    if (idx < 0) idx = team.findIndex((s) => s.name.trim().toLowerCase() === ask.toLowerCase());
    if (idx < 0) throw new EngineError(`No step “${truncate(ask, 60)}” — this run's steps: ${team.map((s) => s.id).join(', ')}.`);
    const starts = groupStarts(team);
    const startIndex = starts[idx]!;
    const group = team.filter((_, j) => starts[j] === startIndex);
    if (startIndex !== idx) {
      notes.push(`“${team[idx]!.name}” works at the same time as ${group.filter((s) => s !== team![idx]).map((s) => `“${s.name}”`).join(', ')}, so the whole group runs again: ${chain(group.map((s, j) => ({ ...s, parallel: j > 0 })))}.`);
    }
    // The steps before the start keep their results: they must be the steps that made them.
    if (opts.team && !sameTeam(team.slice(0, startIndex), ranTeam.slice(0, startIndex))) {
      throw new EngineError(`The steps before “${team[startIndex]!.name}” must stay as they ran — only that step and the ones after it can change when the run continues.`);
    }
    // 8. Reverted files no longer hold the kept steps' work.
    if (from.revertedAt && startIndex > 0) {
      throw new EngineError(`The files of that run were reverted, so its results no longer match them — start the team again (or continue from its first step, “${team[0]!.name}”).`);
    }

    // 9. What is kept: each earlier step's last attempt, which must have finished.
    const kept: ContinuePlan['kept'] = [];
    for (const step of team.slice(0, startIndex)) {
      const index = lastAttempt(from, step.id);
      const rs = from.steps[index];
      if (!rs) throw new EngineError(`“${step.name}” never ran in that run — continue from ${step.name} (${step.id}) or earlier.`);
      if (rs.status !== 'done') throw new EngineError(`“${step.name}”'s last attempt in that run didn't finish (it failed or was stopped) — continue from ${step.name} (${step.id}) or earlier.`);
      // kept from a run before it (a continuation of a continuation): that run's files must still hold the work
      const madeIn = this.#madeIn(from, index);
      if (madeIn && madeIn !== from && madeIn.revertedAt) {
        throw new EngineError(`“${step.name}”'s result comes from run ${madeIn.id}, whose files were reverted since — continue from ${step.name} (${step.id}) or earlier.`);
      }
      const file = `.rlt/runs/${runId}/${pad2(index + 1)}-${step.id}.md`;
      const read = this.#readOutput(dir, file);
      if (read === null) notes.push(`${step.name}'s full reply is gone (${file}), so the next step gets its shortened copy.`);
      kept.push({ step, rs, index, text: read ?? rs.output ?? '', file, full: read !== null });
    }
    const earlier: Record<string, string> = {};
    for (const s of group) {
      const index = lastAttempt(from, s.id);
      const file = `.rlt/runs/${runId}/${pad2(index + 1)}-${s.id}.md`;
      if (index >= 0 && existsSync(join(dir, file))) earlier[s.id] = file;
    }

    // 10–11. Other models for this run; every step a review loop can still reach must be on a connected model.
    let modelsChanged = false;
    const reach = reachFrom(team, startIndex);
    for (const [id, value] of Object.entries(opts.models ?? {})) {
      const s = team.find((x) => x.id === writtenStepId(id));
      if (!s) throw new EngineError(`“${from.workflowName}” has no step “${id}” — its step ids: ${team.map((x) => x.id).join(', ')}.`);
      // a kept step that never works again: its model changes nothing but the team's record (and its people)
      if (team.indexOf(s) < reach) {
        throw new EngineError(`“${s.name}” doesn't run again in this continuation (it keeps its result) — models only for: ${team.slice(reach).map((x) => x.id).join(', ')}.`);
      }
      const model = typeof value === 'string' ? value.trim() : '';
      if (!MODEL_ID.test(model)) throw new EngineError(`models.${id} must be a model id like anthropic/claude-opus-5-5.`);
      if (model !== s.model) [s.model, modelsChanged] = [model, true];
    }
    for (const [id, value] of Object.entries(opts.thinking ?? {})) {
      const s = team.find((x) => x.id === writtenStepId(id));
      if (!s) throw new EngineError(`“${from.workflowName}” has no step “${id}” — its step ids: ${team.map((x) => x.id).join(', ')}.`);
      if (team.indexOf(s) < reach) {
        throw new EngineError(`“${s.name}” doesn't run again in this continuation (it keeps its result) — efforts only for: ${team.slice(reach).map((x) => x.id).join(', ')}.`);
      }
      if (value !== '' && !THINKING_LEVELS.includes(value)) throw new EngineError(`thinking.${id} must be one of ${THINKING_LEVELS.join(', ')} (or '' for the default).`);
      if (value === (s.thinking ?? '')) continue;
      if (value) s.thinking = value;
      else delete s.thinking;
      modelsChanged = true;
    }
    this.#checkModels(team.slice(reach));

    // 12. The job's standing people only when it is still the job's team, as it ran, on the same models.
    const standing = from.team ? from.team.every((m) => !m.id.startsWith('x-')) : from.steps.every((s) => !s.stepId.startsWith('x-'));
    const saved = from.workflowId ? this.d.workflows.get(from.projectId, from.workflowId) : undefined;
    const own = standing && !modelsChanged && !!saved && this.#teamIdOf(project, job) === from.workflowId && sameTeam(saved.steps, asRan);
    if (standing && !own) {
      notes.push(
        modelsChanged
          ? 'Temporary people do this run (other models or efforts than the job\'s team), with the team as it ran.'
          : opts.team
            ? "The team changes for this run, so temporary people do it, with the changed team (the job's team stays as saved)."
            : from.edits?.length
              ? "This run's team was changed while it ran, so temporary people do this run, with the team as it ran."
              : "The job's team changed since that run, so temporary people do this run, with the team as it ran.",
      );
    }

    // 13. Other runs of this job since then: the files include their changes.
    const since = this.runs().filter((r) => r.id !== runId && r.projectId === from.projectId && r.jobId === from.jobId && r.startedAt >= (from.endedAt ?? from.startedAt));
    if (since.length) {
      const names = [...new Set(since.map((r) => `“${r.workflowName}”`))];
      notes.push(`Since that run, ${andList(names)} ran in this job — the files include ${since.length === 1 ? 'its' : 'their'} changes.`);
    }

    // The earlier run's hand-off files (not its own records or step replies): copied into the new run dir.
    const handoff: string[] = [];
    const skipped = this.#listHandoff(oldDir, '', handoff, { bytes: 0, skipped: 0 }).skipped;
    if (skipped) notes.push(`${skipped} hand-off file${skipped === 1 ? '' : 's'} of that run ${skipped === 1 ? 'was' : 'were'} not copied (links, or over ${MAX_SEED_BYTES / 1024 / 1024} MB) — they are still in .rlt/runs/${runId}/.`);

    const task = opts.task?.trim() || from.task;
    const note = opts.note?.trim() ? truncate(opts.note.trim(), 8000) : undefined;
    return { from, project, job, dir, team, startIndex, fromStepId: team[startIndex]!.id, own, task, ...(note ? { note } : {}), kept, earlier, handoff, notes };
  }

  /** Continue an ended run from a step (planContinue checks it again — a plan card may answer minutes later): a new
   *  run in the same job that keeps the earlier steps' results and runs the rest. Throws EngineError. */
  async continueFrom(runId: string, fromStep: string, opts: ContinueOptions & StartOptions): Promise<WorkflowRun> {
    const plan = this.planContinue(runId, fromStep, opts);
    const { from } = plan;
    const icon = from.adhoc ? '👥' : (this.d.workflows.get(from.projectId, from.workflowId)?.icon ?? '⚙️');
    const given: Workflow = { id: from.workflowId, name: from.workflowName, description: '', icon, steps: plan.team };
    return this.#launch(plan.project, plan.job, given, plan.own, plan.task, { startedBy: opts.startedBy, ...(from.adhoc ? { adhoc: true } : {}) }, plan);
  }

  /** The run a step attempt's result was made in: a continuation's kept rows point to the run they came from (which
   *  may be a continuation too). Undefined when that run is no longer in history. */
  #madeIn(run: WorkflowRun, index: number): WorkflowRun | undefined {
    let r: WorkflowRun | undefined = run;
    let k = index;
    for (let hops = 0; r && hops <= MAX_RUNS_KEPT; hops++) {
      const reused: WorkflowRunStep['reused'] = r.steps[k]?.reused;
      if (!reused) return r;
      k = reused.index;
      r = this.#runs.get(reused.runId);
    }
    return undefined;
  }

  /** A step's saved reply (`# Name\n\n<text>\n`) without its header, or null when the file is gone. */
  #readOutput(dir: string, file: string): string | null {
    try {
      return readFileSync(join(dir, file), 'utf8').replace(/^# [^\n]*\n\n/, '').replace(/\n$/, '');
    } catch {
      return null;
    }
  }

  /** The files under a run dir a continuation copies (relative paths into `out`): everything but the run's own
   *  records and step replies at the top, no links, at most MAX_SEED_BYTES. */
  #listHandoff(root: string, rel: string, out: string[], acc: { bytes: number; skipped: number }): { bytes: number; skipped: number } {
    let names: string[];
    try {
      names = readdirSync(join(root, rel)).sort();
    } catch {
      return acc;
    }
    for (const name of names) {
      if (!rel && (OWN_RUN_FILES.has(name) || STEP_REPLY.test(name))) continue;
      const r = rel ? `${rel}/${name}` : name;
      let st;
      try {
        st = lstatSync(join(root, r));
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) acc.skipped++;
      else if (st.isDirectory()) this.#listHandoff(root, r, out, acc);
      else if (!st.isFile()) continue;
      else if (acc.bytes + st.size > MAX_SEED_BYTES) acc.skipped++;
      else {
        acc.bytes += st.size;
        out.push(r);
      }
    }
    return acc;
  }

  /** A continuation's run dir before it starts: the kept replies at their new numbers (the `NN` of a run's step
   *  replies follows its steps[]) and the earlier run's hand-off files. */
  #seedRunDir(oldDir: string, newDir: string, plan: ContinuePlan) {
    try {
      mkdirSync(newDir, { recursive: true });
      for (const rel of plan.handoff) {
        const to = join(newDir, rel);
        mkdirSync(dirname(to), { recursive: true });
        copyFileSync(join(oldDir, rel), to);
      }
      for (const [i, k] of plan.kept.entries()) {
        const to = join(newDir, `${pad2(i + 1)}-${k.step.id}.md`);
        if (k.full) copyFileSync(join(plan.dir, k.file), to);
        else writeFileSync(to, `# ${k.step.name}\n\n${k.text}\n`);
      }
    } catch (err) {
      log('flows', `could not seed ${newDir}: ${errorText(err)}`);
    }
  }

  /** Stop a run. `interrupted`: CAST is shutting down, not the user stopping it (the run says so; it can be run again
   *  from the step that didn't finish). */
  async abort(runId: string, opts: { interrupted?: boolean } = {}): Promise<boolean> {
    const act = this.#active.get(runId);
    if (!act) return false;
    act.aborted = true;
    if (opts.interrupted) act.run.interrupted = true;
    this.#finish(act, 'aborted', opts.interrupted ? `${act.run.workflowName} was interrupted: CAST is restarting.` : `${act.run.workflowName} stopped.`);
    await Promise.all(act.group.map((rt) => rt.abort())); // every person of a parallel group
    return true;
  }

  async abortProject(projectId: string): Promise<void> {
    await Promise.all([...this.#active.values()].filter((a) => a.run.projectId === projectId).map((a) => this.abort(a.run.id)));
  }

  async abortJob(projectId: string, jobId: string): Promise<void> {
    await Promise.all([...this.#active.values()].filter((a) => a.run.projectId === projectId && a.run.jobId === jobId).map((a) => this.abort(a.run.id)));
  }

  /** Undo one run's file changes (preview: only say what would happen). Only the files the run changed go back;
   *  files changed again after the run, or also edited by another job's people during it, are kept. */
  async revert(runId: string, preview = false): Promise<RevertPlan> {
    const run = this.#runs.get(runId);
    if (!run) throw new EngineError('Unknown run.');
    if (this.#active.has(runId)) throw new EngineError('Stop the run before reverting it.');
    if (!run.checkpoint) throw new EngineError('This run has no checkpoint to restore (not a git repository?).');
    const project = this.d.city.project(run.projectId);
    if (!project) throw new EngineError('That house no longer exists.');
    const dir = this.#dirOf(run, project);
    const saved = this.#readUndo(dir, runId);
    if (saved?.copyOf) {
      // Its checkpoints are of a copy that is gone: reverting here would put that copy's files into the house.
      throw new EngineError(`This run worked in its job's own copy of the files, which went with the job — its work is kept on branch ${saved.copyOf}. Undo it with git instead.`);
    }
    let rec = await (this.#undo.get(runId) ?? Promise.resolve(saved));
    if (!rec?.end) {
      // Finished before RLT recorded an end snapshot: everything since the checkpoint counts as the run's — only
      // safe while no other job works in this folder.
      const other = this.d.jobs.list(project.id).find((j) => j.id !== run.jobId && jobDir(project, j) === dir);
      if (other) {
        throw new EngineError(`This run finished before CAST kept track of each run's own changes, and “${other.name}” works in the same folder — reverting it could undo that job's work too. Undo it with git instead.`);
      }
      const now = await this.d.git.checkpoint(projectAt(project, dir), `${run.id}-now`).catch(() => null);
      if (!now) throw new EngineError('Could not take a snapshot of the files to compare with.');
      rec = { end: now, others: rec?.others ?? [] };
    }
    const keep = rec.others.flatMap((o) => o.paths);
    const r = await this.d.git.undoRun(projectAt(project, dir), run.checkpoint, rec.end!, { keep, dryRun: preview });
    const plan: RevertPlan = { files: r.restored, kept: r.kept, others: rec.others.map((o) => o.label) };
    // Commands and helpers name no files: what those people changed can't be told apart from the run's changes.
    const unknown = rec.others.filter((o) => o.unknown).map((o) => o.label);
    if (unknown.length) plan.othersUnknown = unknown;
    if (preview) return plan;
    // Its files are back as before it: what it kept can't be built on any more (a continuation starts from the top).
    // Nothing restored (every file changed again since): its files are as it left them, nothing to mark.
    if (plan.files.length) {
      run.revertedAt = Date.now();
      this.#saveRun(dir, run);
      this.#emit(run);
    }
    await this.d.gitRefresh.refreshNow(project.id, run.jobId);
    const n = plan.files.length;
    const kept = plan.kept.length ? ` Kept ${plan.kept.length} file${plan.kept.length === 1 ? '' : 's'} someone else also changed.` : '';
    const check = unknown.length ? ` ${andList(unknown)} also ran commands or sent helpers during the run — check their files.` : '';
    this.d.toast(n ? 'success' : 'info', n ? `Reverted ${n} file${n === 1 ? '' : 's'} of “${run.workflowName}”.${kept}${check}` : `Nothing of “${run.workflowName}” left to revert.${kept}`, project.id);
    return plan;
  }

  /** Approvals changed for this agent → flip the run between running and waiting_approval (waiting while anyone
   *  working on it waits for the user). */
  onApprovalChange(agentId: string): void {
    for (const act of this.#active.values()) {
      if (!act.working.has(agentId) || act.aborted) continue;
      this.#syncStatus(act);
    }
  }

  #statusOf(act: Active): 'running' | 'waiting_approval' {
    return [...act.working.keys()].some((id) => this.d.approvals.pendingFor(id).length) ? 'waiting_approval' : 'running';
  }

  #syncStatus(act: Active): void {
    const next = this.#statusOf(act);
    let changed = false;
    if (act.run.status !== next) {
      act.run.status = next;
      changed = true;
    }
    if (trackWaits(act.run, (agentId) => this.d.approvals.pendingFor(agentId).length > 0)) changed = true;
    if (changed) this.#emit(act.run);
  }

  dispose(): void {
    this.#disposed = true;
    this.#unsub();
    if (this.#costTimer) clearTimeout(this.#costTimer);
  }

  /** Every model of the team must be connected (only the scripted test model, CAST_MOCK_LLM, stands in for all). */
  #checkModels(steps: WorkflowStep[]): void {
    const { models } = this.d;
    if (models.demoActive()) return;
    if (!models.anyAvailable()) {
      if (models.state === 'checking') throw new EngineError('Checking AI accounts — try again in a moment.');
      if (models.state === 'failed') throw new EngineError(`CAST couldn't check your AI accounts${models.detectError ? ` (${models.detectError})` : ''} — it tries again by itself; press Refresh under Models & providers before starting a team.`);
      throw new EngineError('No AI account is connected yet — connect one under Models & providers before starting a team.');
    }
    const off = steps.filter((s) => !models.isAvailable(s.model));
    if (!off.length) return;
    const ok = models.models().filter((m) => m.available).map((m) => m.label);
    throw new EngineError(
      `Not connected: ${off.map((s) => `${s.name} uses ${models.label(s.model)}`).join(', ')}. ` +
        `Pick connected models${ok.length ? ` (${ok.join(', ')})` : ''}, or sign in under Models & providers.`,
    );
  }

  // ───────────────────────── execution ─────────────────────────

  async #execute(act: Active, project: Project, job: Job) {
    const { run, workflow, cont } = act;
    const runDirRel = `.rlt/runs/${run.id}`;
    const runDirAbs = join(act.dir, runDirRel);
    this.#prepareRunDir(act.dir, runDirAbs, run, workflow, cont);

    // A run that ended in this folder a moment ago (stopped — its last person may still be writing) takes its end
    // snapshot once they are quiet: wait for it (at most ~10 s), so that snapshot holds none of this run's work and this
    // checkpoint none of that run's (else reverting either one undoes the other's files). Nobody of this run works yet.
    const ending = [...this.#ending].filter(([id, dir]) => id !== run.id && dir === act.dir).map(([id]) => this.#undo.get(id));
    if (ending.length) await Promise.all(ending);
    if (act.aborted) return;

    try {
      run.checkpoint = (await this.d.git.checkpoint(projectAt(project, act.dir), run.id)) ?? undefined;
    } catch (err) {
      this.d.toast('warn', `No checkpoint for this run (${truncate(errorText(err), 100)}) — revert won't be available.`, project.id);
    }
    if (act.aborted) return;
    this.#emit(run);
    this.#saveRun(act.dir, run); // saved after every group too: a run the server stops midway can be continued

    // The plan (act.workflow.steps) is read again at every group: the steps that haven't started can change while the
    // run goes (editRun). The group working now and every step before it never change, so indexes into them hold.
    const fresh = new Set<string>(); // roles that already got a clean session in this run
    const waited = new Set<string>(); // people we said we wait for
    // A continuation starts at its first step that runs again, handed the kept group's replies (nobody walks a folder
    // over: those people did their part in the earlier run).
    let i = cont?.startIndex ?? 0; // the first step of the group to run
    let prev: Handed = cont && cont.startIndex > 0 ? { ...cont.prev, from: [] } : { name: 'The user', text: '', from: [] };
    let asked: { from: string; text: string } | null = null; // a review's notes when it sent the work back
    let attempt = run.steps.length; // a continuation's kept steps are its first replies
    let seenStart = false; // the continuation's start group ran once

    while (i < act.workflow.steps.length && !act.aborted) {
      const steps = act.workflow.steps;
      const end = groupEnd(steps, i);
      // From here this group can't change any more (only notes reach its people) — before anything is awaited.
      act.at = { start: i, end };
      act.asked = false;
      if (run.planAt?.start !== i || run.planAt.end !== end) {
        run.planAt = { start: i, end };
        this.#emit(run);
      }
      const group = steps.slice(i, end);
      // A model signed out of during the run: nobody works on a model that isn't connected.
      const off = this.d.models.demoActive() ? undefined : group.find((s) => !this.d.models.isAvailable(s.model));
      if (off) {
        const label = this.d.models.label(off.model);
        this.#finish(
          act,
          'failed',
          this.d.models.anyAvailable()
            ? `${off.name} uses ${label}, which isn't connected any more — sign in under Models & providers, or pick another model.`
            : `${off.name} uses ${label}, which isn't connected any more — connect an AI account under Models & providers.`,
        );
        return;
      }
      const runtimes = group.map((step) => this.d.ensureRole(project, job, step));
      // Someone still busy (a chat with the user, or omp still booting for one) must finish first: a new chat now
      // would cut their answer off, and a boot finishing later would tie its session to the run's chat.
      for (const [k, rt] of runtimes.entries()) {
        if (!rt.busy || waited.has(rt.agentId)) continue;
        waited.add(rt.agentId);
        this.d.toast('info', `${rt.info?.name ?? group[k]!.name} is still busy with another chat — “${run.workflowName}” continues when they're done.`, project.id, rt.agentId);
      }
      while (runtimes.some((rt) => rt.busy && !rt.retired) && !act.aborted) await sleep(400);
      if (act.aborted) return;
      act.group = runtimes;
      // Each run is its own chat for each role (the earlier ones stay reopenable in the thread menu).
      await Promise.all(
        group.map((step, k) => {
          if (fresh.has(step.id)) return undefined;
          fresh.add(step.id);
          return runtimes[k]!.newThread({ title: `${workflow.icon} ${truncate(run.task.replace(/\s+/g, ' '), 52)}`, note: `New workflow run: ${truncate(run.task, 140)}` });
        }),
      );
      if (act.aborted) return;
      this.#handoff(project.id, prev.from, runtimes);

      const startedAt = Date.now();
      const members: Member[] = group.map((step, k) => ({
        step,
        runtime: runtimes[k]!,
        rs: { stepId: step.id, status: 'running', agentId: runtimes[k]!.agentId, startedAt },
        attempt: ++attempt,
        text: '',
        notes: '',
      }));
      run.steps.push(...members.map((m) => m.rs));
      act.asked = true;
      run.currentStepId = group[0]!.id;
      run.currentStepIds = group.map((s) => s.id);
      act.working = new Map(members.map((m) => [m.runtime.agentId, this.#costOf(m.runtime.agentId)]));
      run.status = this.#statusOf(act);
      this.#emit(run);

      const vars = {
        task: run.task,
        prev: prev.text.trim() || '(You are first — there is no previous step.)',
        prevName: prev.name,
        runDir: runDirRel,
        feedback: asked ? `\n\n${asked.from} asked for changes — address every point:\n${asked.text}` : '',
      };
      asked = null;
      // A continuation's start group: that it runs again (the first time) and the user's note (every time).
      const again = cont && steps[i]!.id === cont.startId;
      const first = !seenStart;
      if (again) seenStart = true;
      const prompts = members.map((m) => {
        // notes the user sent for this step before it started (editRun)
        const notes = (act.notes.get(m.step.id) ?? []).map((t) => `Note from the user for this step:\n${t}`);
        act.notes.delete(m.step.id);
        const extra = [again ? continueNote(cont.fromRunId, cont.startIndex > 0, first, cont.earlier.get(m.step.id), cont.note) : '', ...notes].filter(Boolean).join('\n\n');
        // where a review's notes land ({{feedback}}), else before a review's verdict format, else at the end
        const inline = !!extra && /\{\{\s*feedback\s*\}\}/.test(m.step.instruction);
        let text = renderInstruction(m.step.instruction, inline ? { ...vars, feedback: `${vars.feedback}\n\n${extra}` } : vars);
        if (extra && !inline) {
          const at = text.indexOf(VERDICT_FOOTER);
          const head = at < 0 ? text : text.slice(0, at);
          const gap = !head || head.endsWith('\n\n') ? '' : head.endsWith('\n') ? '\n' : '\n\n'; // its own paragraph
          text = at < 0 ? `${text}\n\n${extra}` : `${head}${gap}${extra}\n\n${text.slice(at)}`;
        }
        if (members.length === 1) return text;
        const note = parallelNote(members.filter((o) => o !== m).map((o) => o.step.name));
        // a review's verdict format stays the last thing it reads
        return text.includes(VERDICT_FOOTER) ? text.replace(VERDICT_FOOTER, `${note}\n\n${VERDICT_FOOTER}`) : `${text}\n\n${note}`;
      });
      if (!(await this.#runGroup(act, project.id, runDirAbs, members, prompts))) return;
      this.#saveRun(act.dir, run);

      // Reviews: the work goes back when any of them says revise — to the loop target of the first one that has one
      // (a target inside a group runs that whole group again). The plan as it is now: later steps may have changed
      // meanwhile, this group and the steps before it (every loop target) never do.
      const now = act.workflow.steps;
      const revising = members.filter((m) => m.rs.verdict === 'revise');
      const back = revising.find((m) => m.step.loopBackTo && now.some((s) => s.id === m.step.loopBackTo));
      if (back) {
        if (run.loop < (back.step.maxLoops ?? 2)) {
          run.loop++;
          prev = { ...combined(revising), from: revising.map((m) => ({ runtime: m.runtime, label: 'Review notes' })) };
          asked = { from: prev.name, text: combined(revising.map((m) => ({ step: m.step, text: m.notes || 'See the review above.' }))).text };
          this.#emit(run);
          i = groupStarts(now)[now.findIndex((s) => s.id === back.step.loopBackTo)]!;
          continue;
        }
        this.d.toast('warn', `${back.step.name} still wants changes after ${run.loop} round${run.loop === 1 ? '' : 's'} — finishing here.`, project.id, back.runtime.agentId);
      }
      this.#emit(run);
      prev = { ...combined(members), from: members.map((m) => ({ runtime: m.runtime, label: this.#labelFor(m.step, m.text, runDirRel) })) };
      i = end;
    }
    if (!act.aborted) {
      const secs = Math.round((Date.now() - run.startedAt) / 1000);
      const dur = secs >= 90 ? `${Math.round(secs / 60)} min` : `${secs}s`;
      this.#finish(act, 'completed', `${workflow.icon || '✅'} ${run.workflowName} finished in ${dur}${cont ? ` (continued from ${cont.fromName})` : ''}`);
    }
  }

  /** Prompt every member of a group at once. True when all of them finished; false when the run ended meanwhile —
   *  stopped, or one of them failed (then the run fails and the others are stopped). */
  #runGroup(act: Active, projectId: string, runDirAbs: string, members: Member[], prompts: string[]): Promise<boolean> {
    const { run } = act;
    return new Promise<boolean>((resolve) => {
      let left = members.length;
      let over = false;
      const end = (ok: boolean) => {
        if (over) return;
        over = true;
        resolve(ok);
      };
      for (const [k, m] of members.entries()) {
        const asked: Promise<PromptOutcome> = m.runtime.ask(prompts[k]!).catch((err: unknown) => ({ status: 'error', text: '', error: errorText(err) }));
        void asked.then((out) => {
          const atStart = act.working.get(m.runtime.agentId);
          if (atStart !== undefined) act.costBase += Math.max(0, this.#costOf(m.runtime.agentId) - atStart);
          act.working.delete(m.runtime.agentId);
          this.#unreadNotes(act, projectId, m);
          run.costUsd = this.#liveCost(act);
          m.rs.endedAt ??= Date.now();
          closeWait(m.rs, m.rs.endedAt);
          m.rs.output = truncate(out.text, MAX_OUTPUT) || m.rs.output;
          m.text = out.text;
          this.#saveOutput(runDirAbs, m.attempt, m.step, out.text);
          if (act.aborted || !this.#active.has(run.id)) {
            // the run was stopped, or someone else in the group failed: this person was stopped with it
            m.rs.status = out.status === 'completed' && !act.aborted ? 'done' : 'failed';
            if (!m.rs.output) m.rs.output = 'Stopped.';
            this.#emit(run);
            end(false);
            return;
          }
          if (out.status !== 'completed') {
            m.rs.status = 'failed';
            if (!m.rs.output) m.rs.output = out.error ?? 'Failed';
            this.#finish(act, out.status === 'aborted' ? 'aborted' : 'failed', `${m.step.name} ${out.status === 'aborted' ? 'was stopped' : `failed: ${truncate(out.error ?? 'unknown error', 120)}`}`);
            for (const o of members) if (o !== m && o.rs.status !== 'done') void o.runtime.abort(); // the others stop too
            end(false);
            return;
          }
          m.rs.status = 'done';
          if (m.step.kind === 'review') {
            const v = parseVerdict(out.text);
            if (!v) this.d.toast('warn', `Couldn't read ${m.step.name}'s verdict — treating it as approve.`, projectId, m.runtime.agentId);
            m.rs.verdict = v?.verdict ?? 'approve';
            m.notes = v?.notes ?? '';
          }
          // Who still works (the last one to finish stays "current" until the next group starts, as before).
          const still = members.filter((o) => o.rs.status === 'running').map((o) => o.step.id);
          if (still.length) {
            run.currentStepIds = still;
            run.currentStepId = still[0]!;
            this.#syncStatus(act);
          }
          this.#emit(run);
          if (--left === 0) end(true);
        });
      }
    });
  }

  /** A person's step ended: notes steered into their turn that they never read are taken back (they would start a
   *  turn of their own outside the run). */
  #unreadNotes(act: Active, projectId: string, m: Member) {
    const keys = act.steered.get(m.runtime.agentId);
    if (!keys) return;
    act.steered.delete(m.runtime.agentId);
    for (const key of keys) {
      void m.runtime.withdrawSteer?.(key).then((back) => {
        if (back) this.d.toast('info', `${m.step.name} finished before reading your note — it wasn't used.`, projectId, m.runtime.agentId);
      });
    }
  }

  #finish(act: Active, status: WorkflowRun['status'], message: string) {
    const { run } = act;
    if (!this.#active.has(run.id)) return;
    // Temporary people stay until the end snapshot is taken — retiring one ends #recordEnd's wait for an aborted
    // step's last writes — and leave a few seconds later (also people added to the job's own team for this run: then
    // the standing people changed for it go back to their saved selves).
    const people = () => new Set([...(run.team ?? []).map((m) => m.agentId), ...run.steps.filter((s) => !s.reused).map((s) => s.agentId)]);
    const leaving = (act.temp && run.team) || run.edits?.length ? people() : null;
    if (leaving) this.#leaving.set(run.id, leaving);
    this.#active.delete(run.id);
    run.status = status;
    run.endedAt = Date.now();
    run.currentStepId = null;
    run.currentStepIds = [];
    for (const s of run.steps) {
      if (s.status !== 'running') continue;
      s.status = status === 'completed' ? 'done' : 'failed';
      s.endedAt ??= run.endedAt;
    }
    for (const s of run.steps) closeWait(s, s.endedAt ?? run.endedAt);
    closeWait(run, run.endedAt);
    this.#emit(run);
    this.d.toast(status === 'completed' ? 'success' : status === 'aborted' ? 'info' : 'error', message, run.projectId);
    this.d.onFinish?.(run);
    void this.d.gitRefresh.refreshNow(run.projectId, run.jobId);
    const project = this.d.city.project(run.projectId);
    if (project) {
      this.#saveRun(act.dir, run);
      const rec = this.#recordEnd(project, act).catch((err) => {
        log('flows', `run ${run.id}: no end snapshot (${errorText(err)})`);
        return null;
      });
      this.#recording(run.id, act.dir, rec);
      if (leaving) void rec.then(() => sleep(LEAVE_AFTER_MS)).then(() => this.#letGo(run));
    } else if (leaving) {
      this.#letGo(run);
    }
  }

  /** A run's end snapshot is being taken (revert waits for it, and so does a run starting in the same folder). */
  #recording(runId: string, dir: string, rec: Promise<UndoRecord | null>) {
    this.#undo.set(runId, rec);
    this.#ending.set(runId, dir);
    void rec.finally(() => {
      if (this.#undo.get(runId) === rec) this.#ending.delete(runId);
    });
  }

  /** A finished run's temporary people leave (unless another run needs them meanwhile — agent-system checks). */
  #letGo(run: WorkflowRun) {
    this.#leaving.delete(run.id);
    if (!this.#disposed) this.d.onPeopleLeave?.(run);
  }

  /** Snapshot the files as the run left them (once its last person has stopped) + who else worked meanwhile. */
  async #recordEnd(project: Project, act: Active): Promise<UndoRecord> {
    const { run } = act;
    const others = [...act.others.values()].map((o) => ({ label: o.label, paths: [...o.paths].sort(), unknown: o.unknown }));
    // an aborted step may still be writing — every person of the last group
    for (let i = 0; act.group.some((rt) => rt.busy && !rt.retired) && i < 40; i++) await sleep(250);
    this.#saveRun(act.dir, run); // with the stopped people's last words
    const end = run.checkpoint ? ((await this.d.git.checkpoint(projectAt(project, act.dir), `${run.id}-end`)) ?? undefined) : undefined;
    const rec: UndoRecord = { end, others };
    try {
      writeFileSync(join(act.dir, '.rlt/runs', run.id, 'undo.json'), `${JSON.stringify(rec, null, 2)}\n`);
    } catch {
      /* best effort */
    }
    return rec;
  }

  /** A run the server stopped midway (run.json is saved after every group, so it is in history now) has no end
   *  snapshot: take it at load, when the files are as the stop left them. Without it, reverting the run would count
   *  everything since its checkpoint as its own — the later runs' work and the user's edits too. */
  async #endAfterStop(project: Project, folder: string, run: WorkflowRun, undo: UndoRecord | null): Promise<UndoRecord | null> {
    this.#saveRun(folder, run); // stopped from now on (status, endedAt), like any other run that ended
    try {
      const end = (await this.d.git.checkpoint(projectAt(project, folder), `${run.id}-end`)) ?? undefined;
      if (!end) return undo;
      const rec: UndoRecord = { end, others: undo?.others ?? [] };
      writeFileSync(join(folder, '.rlt/runs', run.id, 'undo.json'), `${JSON.stringify(rec, null, 2)}\n`);
      return rec;
    } catch (err) {
      log('flows', `run ${run.id}: no end snapshot after the restart (${errorText(err)})`);
      return undo;
    }
  }

  #readUndo(dir: string, runId: string): UndoRecord | null {
    try {
      const raw = JSON.parse(readFileSync(join(dir, '.rlt/runs', runId, 'undo.json'), 'utf8')) as Partial<UndoRecord>;
      const others = (Array.isArray(raw.others) ? raw.others : [])
        .filter((o) => o && typeof o.label === 'string')
        .map((o) => ({ label: o.label, paths: Array.isArray(o.paths) ? o.paths.filter((p): p is string => typeof p === 'string') : [], unknown: o.unknown === true }));
      const copyOf = (raw as Record<string, unknown>)[COPY_RUN_MARK];
      return {
        end: typeof raw.end === 'string' && raw.end.startsWith('refs/rlt/') ? raw.end : undefined,
        others,
        ...(typeof copyOf === 'string' ? { copyOf } : {}),
      };
    } catch {
      return null;
    }
  }

  #label(a: AgentInfo): string {
    const owner = a.kind === 'subagent' && a.parentId ? (this.d.store.get(a.parentId) ?? a) : a;
    const job = this.d.jobs.get(owner.projectId, owner.jobId);
    return job ? `${owner.name} (${job.name})` : owner.name;
  }

  /** Everyone who finished hands their folder to everyone of the next group (one folder per pair on screen). */
  #handoff(projectId: string, from: Handed['from'], to: AgentRuntime[]) {
    for (const f of from) {
      const targets = to.filter((t) => t !== f.runtime);
      if (!targets.length) continue;
      for (const t of targets) this.d.hub.broadcast({ t: 'handoff', projectId, fromAgentId: f.runtime.agentId, toAgentId: t.agentId, label: f.label });
      const names = andList(targets.map((t) => t.info?.name ?? 'the next person'));
      if (!f.runtime.busy) f.runtime.showHandoff(`Bringing ${f.label} to ${names}`, HANDOFF_SHOW_MS);
    }
  }

  #saveRun(dir: string, run: WorkflowRun) {
    try {
      writeFileSync(join(dir, '.rlt/runs', run.id, 'run.json'), `${JSON.stringify(run, null, 2)}\n`);
    } catch {
      /* best effort */
    }
  }

  /** Folder label for the handoff: a file the step wrote in the run dir, else "<Name>'s notes". */
  #labelFor(step: WorkflowStep, text: string, runDirRel: string): string {
    const m = text.match(new RegExp(`${runDirRel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/([\\w.-]+)`));
    if (m) return m[1];
    const chapter = text.match(/chapters\/[\w.-]+\.md/);
    if (chapter) return basename(chapter[0]);
    return step.kind === 'review' ? 'Sign-off' : `${step.name}'s notes`;
  }

  /** <run dir>/team.json: the team as written (step ids without `x-`, full personas and instructions) — what a
   *  one-off team is kept from (save_run_team, workflow_save from_run). */
  #writeTeam(folder: string, run: WorkflowRun, steps: WorkflowStep[]) {
    try {
      const dir = join(folder, '.rlt/runs', run.id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'team.json'), `${JSON.stringify(steps, null, 2)}\n`);
    } catch (err) {
      log('flows', `could not keep the team of ${run.id}: ${errorText(err)}`);
    }
  }

  #prepareRunDir(folder: string, dir: string, run: WorkflowRun, workflow: Workflow, cont?: Continuing) {
    try {
      mkdirSync(dir, { recursive: true });
      const continues = cont
        ? `\nContinues run ${cont.fromRunId} from ${cont.fromName}; ${cont.keptChain ? `kept: ${cont.keptChain}` : 'nothing kept'}.\n${cont.note ? `\nNote: ${cont.note}\n` : ''}`
        : '';
      writeFileSync(join(dir, 'task.md'), `# ${workflow.name}\n\n${run.task}\n${continues}`);
      // Keep run artifacts out of the user's git status (the GitService also excludes .rlt/, and does it for a job's
      // copy too, whose .git is a file).
      const exclude = join(folder, '.git', 'info', 'exclude');
      if (existsSync(join(folder, '.git')) && statSync(join(folder, '.git')).isDirectory()) {
        const cur = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
        if (!/^\.rlt\/?$/m.test(cur)) {
          mkdirSync(join(folder, '.git', 'info'), { recursive: true });
          appendFileSync(exclude, `${cur && !cur.endsWith('\n') ? '\n' : ''}.rlt/\n`);
        }
      }
    } catch (err) {
      log('flows', `could not prepare ${dir}: ${errorText(err)}`);
    }
  }

  #saveOutput(dir: string, attempt: number, step: WorkflowStep, text: string) {
    try {
      writeFileSync(join(dir, `${String(attempt).padStart(2, '0')}-${writtenStepId(step.id)}.md`), `# ${step.name}\n\n${text}\n`);
    } catch {
      /* best effort */
    }
  }

  /** The finished steps' cost plus what everyone working now has spent so far. */
  #liveCost(act: Active): number {
    let live = act.costBase;
    for (const [id, atStart] of act.working) live += Math.max(0, this.#costOf(id) - atStart);
    return live;
  }

  #costOf(agentId: string): number {
    return (this.d.store.get(agentId)?.costUsd ?? 0) + this.d.subagents.costFor(agentId);
  }

  #scheduleCostEmit() {
    if (this.#costTimer) return;
    this.#costTimer = setTimeout(() => {
      this.#costTimer = undefined;
      for (const act of this.#active.values()) {
        if (!act.working.size) continue;
        const live = this.#liveCost(act);
        if (Math.abs(live - act.run.costUsd) > 1e-7) {
          act.run.costUsd = live;
          this.#emit(act.run);
        }
      }
    }, 1000);
  }

  #trimHistory() {
    if (this.#runs.size <= MAX_RUNS_KEPT) return;
    for (const [id] of this.#runs) {
      if (this.#runs.size <= MAX_RUNS_KEPT) break;
      if (!this.#active.has(id)) this.#runs.delete(id);
    }
  }

  #emit(run: WorkflowRun) {
    this.d.hub.broadcast({ t: 'run', run: structuredClone(run) });
  }
}
