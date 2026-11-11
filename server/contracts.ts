// Real Life Terminal — server-internal contracts between the core (index/hub/city/jobs/git/fs/auth, owned by server-core)
// and the agent system (omp processes, workflow engine, the scripted test model; owned by server-agents).
import type {
  AgentInfo, LibraryWorkflow, AgentsHealth, ApprovalRequest, CityState, ClientMsg, GitSummary, Job, JobKind, JobPatch, JobWorktree, ModelInfo, ModelPref,
  Project, ProviderStatus, RoomRef, ServerMsg, SpendTotals, TeamPlan, ThinkingLevel, UndoneChanges, Workflow, WorkflowRun, WorkStyle,
} from '../shared/protocol';

export interface ClientConn {
  id: string;
  user: string | null; // Tailscale-User-Login or 'token' / 'local'
  send(msg: ServerMsg): void;
}

export interface Hub {
  broadcast(msg: ServerMsg): void;
  clients(): ClientConn[];
}

export interface CityStore {
  readonly workspaceRoot: string; // absolute, e.g. /home/you/CAST
  get(): CityState;
  project(id: string): Project | undefined;
  /** `floors` defaults to 1. */
  addProject(p: Omit<Project, 'id' | 'createdAt' | 'floors'> & { floors?: number }): Project;
  updateProject(id: string, patch: Partial<Omit<Project, 'id'>>): Project;
  removeProject(id: string): void; // never touches the folder on disk
  onChange(fn: (city: CityState) => void): () => void;
}

/** The lead model a job gets when none is chosen. connected: at least one AI account is connected, so `model` is one
 *  the person can work on; false: it is only a stand-in (Job.leadModelDefault). */
export interface DefaultLead {
  model: string;
  connected: boolean;
}

export interface NewJob {
  name: string;
  kind: JobKind;
  room: RoomRef;
  /** Absent → the store gives the job the default lead (and marks it a stand-in while nothing is connected). */
  leadModel?: string;
  leadThinking?: ThinkingLevel;
  brief?: string;
  workflowId?: string | null;
  workStyle?: WorkStyle;
  advisorModel?: string;
  /** Server-made: the job's own copy of the files, made before the job (it needs the id: see CoreJobStore.nextId). */
  worktree?: JobWorktree;
  /** Server-chosen id (CoreJobStore.nextId) for a job whose copy was made first; absent → from the name. */
  id?: string;
}

export type { JobPatch };

/** What the server itself may change on a job besides a client's JobPatch: the model choices from plan cards, and a
 *  job copy's bring state (Job.worktree.lastBring; the copy itself never changes). */
export type JobStorePatch = JobPatch & { modelPrefs?: ModelPref[]; worktree?: JobWorktree };

/** Jobs of every project, persisted to <dataDir>/jobs.json. Every existing project has ≥ 1 job ('main' first). */
export interface JobStore {
  /** Every job of every project (each project's list ordered by room). */
  all(): Job[];
  /** The project's jobs ordered by room; creates the 'main' job first when the project has none. */
  list(projectId: string): Job[];
  get(projectId: string, jobId: string): Job | undefined;
  create(projectId: string, input: NewJob): Job;
  update(projectId: string, jobId: string, patch: JobStorePatch): Job;
  remove(projectId: string, jobId: string): void;
  /** Drop every job of a removed project. */
  removeProject(projectId: string): void;
  /** Who picks the lead model of a job made without one (and of the lazily created 'main' job): the agent system knows
   *  which models have credentials. Agent systems set this before they first read jobs. */
  setDefaultLeadModel(fn: () => DefaultLead): void;
  /** Jobs whose lead model is a stand-in (Job.leadModelDefault) take the default lead once an account is connected —
   *  except those `busy` says are working. Never touches a model somebody chose. */
  followDefaultLead(busy: (projectId: string, jobId: string) => boolean): void;
  /** Fires with the project's new job list after every change (incl. a lazily created 'main'). */
  onChange(fn: (projectId: string, jobs: Job[]) => void): () => void;
}

export interface GitService {
  isGit(path: string): Promise<boolean>;
  /** The house folder vs HEAD; with a job that has its own copy (Job.worktree): that copy vs its base (jobId set). */
  summary(project: Project, job?: Job): Promise<GitSummary>;
  /** Snapshot the whole working tree (tracked + untracked, honoring .gitignore) into refs/rlt/checkpoints/<runId>
   *  WITHOUT touching the user's index, HEAD or branches. Returns the ref, or null for non-git folders. */
  checkpoint(project: Project, runId: string): Promise<string | null>;
  /** Restore the working tree to a checkpoint ref: rewrite changed/deleted files, remove files created after it
   *  (only files that are not ignored). Does not move HEAD. */
  revert(project: Project, ref: string): Promise<void>;
  /** Undo one run only: files that changed between `from` (its checkpoint) and `to` (its end snapshot) go back to
   *  `from`, except files changed again after `to` and files in `keep` (other people's work). dryRun: report only. */
  undoRun(project: Project, from: string, to: string, opts?: { keep?: string[]; dryRun?: boolean }): Promise<{ restored: string[]; kept: string[] }>;
  // Per-turn undo of chat turns (agents/turn-changes.ts); optional: without them no turn is tracked.
  /** Snapshot a folder into `ref` (refs/rlt/turns/…) without touching HEAD, index or branches; null: not git. */
  snapshotFolder?(path: string, ref: string, message: string): Promise<string | null>;
  /** Files of the folder that differ between two snapshots. */
  changedBetween?(path: string, from: string, to: string): Promise<string[]>;
  /** Drop these turn refs, and all but the newest turns. */
  dropTurns?(path: string, refs?: string[]): Promise<void>;
  /** Undo one turn (project.path = the folder) unless a file changed again since (`kept`); keeps what it replaces
   *  as an Undo changes entry (`saved`, Bring back). preview: only say what. */
  undoTurn?(project: Project, from: string, to: string, preview?: boolean): Promise<{ files: string[]; kept: string[]; saved?: UndoneChanges }>;
}

export interface AgentSnapshot {
  agents: AgentInfo[];
  /** Always [] (older servers: the built-ins); houseWorkflows: each house's own; library: the shared library. */
  workflows: Workflow[];
  houseWorkflows: Record<string, Workflow[]>;
  library: LibraryWorkflow[];
  runs: WorkflowRun[];
  approvals: ApprovalRequest[];
  models: ModelInfo[];
  providers: ProviderStatus[];
  plans: TeamPlan[]; // plan cards waiting for the user
  /** The session's spend ledger (never lowered when people leave). */
  spend?: SpendTotals;
}

export interface AgentSystem {
  snapshot(): AgentSnapshot;
  /** Handles: enter_project, prompt, abort, get_transcript, approve, run_workflow, abort_run, revert_run, continue_run,
   *  get_run_plan, edit_run,
   *  save_workflow, delete_workflow, save_run_team, answer_plan, refresh_models, list_threads, new_thread,
   *  switch_thread, delete_thread, login_start, login_input, login_cancel, list_accounts, logout_account, get_usage,
   *  get_account_order, set_account_order, set_chat_account.
   *  (The core handles place/create/move/remove/set_project, get_git, fs_list, the job/floor messages and the file
   *  viewer's files_key, list_files and find_files.)
   *  Account order: the agent system owns it (<dataDir>/account-order.json, the omp overlay every real-model omp
   *  gets) and keeps AgentInfo.account of every person's current chat; set_account_order drops EVERY chat's own pick
   *  of that provider and broadcasts 'account_order' plus the changed people. Model/effort: AgentInfo.thinking and
   *  .modelBy are set for everyone; a lead's model/effort still changes through update_job → onJobsChanged. */
  handle(msg: ClientMsg, conn: ClientConn): Promise<void>;
  /** Called by the core after a project is added (to upsert its residents) or removed (to stop its processes). */
  onProjectAdded(project: Project): Promise<void>;
  onProjectRemoved(projectId: string): Promise<void>;
  onProjectUpdated(project: Project): Promise<void>; // e.g. workflowId/approvalMode changed
  /** The house now points at another folder (set_project path; nobody was working): stop its omp processes so they
   *  start again there with their next message (chats resume), and re-sync its people. Optional: without it the core
   *  calls onProjectUpdated. */
  onProjectMoved?(project: Project): Promise<void>;
  /** A project's jobs were created/changed (name, kind, brief, lead model, team, room): re-sync its people. */
  onJobsChanged(projectId: string): Promise<void>;
  /** Called BEFORE a job is deleted: stop its runs and processes and remove its people (files/history stay on disk). */
  onJobRemoved(projectId: string, jobId: string): Promise<void>;
  /** The core hands over its job update (JobService.update, the path update_job takes) once it exists, so a lead
   *  can change its job's team from chat (team_assign). Optional: without it, teams change only from the UI. */
  attachJobService?(update: (projectId: string, jobId: string, patch: JobPatch) => Promise<Job>): void;
  /** The lead model a new job (and the migrated 'main' job) gets when none is chosen. */
  defaultLead(): DefaultLead;
  /** Why this model can't be picked now (it isn't connected while another one is; with nothing connected any model
   *  may be picked — nobody works until one is), or null. Optional: without it every model may be picked. */
  unusableModel?(selector: string): string | null;
  ompVersion(): string | null;
  demoMode(): boolean; // true only with CAST_MOCK_LLM while nothing is connected (people run on the scripted model)
  /** omp and AI-account checks (hello.agents). Optional: without it the app assumes everything is fine. */
  health?(): AgentsHealth | undefined;
  /** One line about omp and the AI accounts for the start banner. */
  statusLine?(): string;
  shutdown(): Promise<void>; // stop all omp process groups + the scripted model when on
}

export interface AgentSystemDeps {
  hub: Hub;
  city: CityStore;
  jobs: JobStore;
  git: GitService;
  dataDir: string; // absolute, e.g. ~/.local/share/cast (server/config.ts)
}

// Implemented in server/agents/index.ts:
//   export async function createAgentSystem(deps: AgentSystemDeps, o: { mockLlm?: boolean } = {}): Promise<AgentSystem>
