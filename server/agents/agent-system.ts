// AgentSystemImpl: the server-side "town hall" for people. Owns residents (per job: a lead + the job's team, plus
// the temporary people of runs that aren't the job's own team), their runtimes and processes, chat threads,
// approvals, plan cards, helpers, the workflow engine and model state; dispatches client messages.
import { appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AccountOrder, AgentInfo, AgentsHealth, ApiKeyName, ChatAccount, ChatThread, ClientMsg, ImageRef, Job, LibraryWorkflow, LocalServer, OmpEnvKey, Project, ProviderAccount, TranscriptItem, UsageSnapshot, Vendor, Workflow, WorkflowRun, WorkflowStep } from '../../shared/protocol';
import type { AgentSnapshot, AgentSystem, AgentSystemDeps, ClientConn, DefaultLead, JobPatch } from '../contracts';
import { agentIdFor, MAIN_JOB_ID } from '../data-layout';
import { pruneUploads } from '../data-wipe';
import { readUpload } from '../uploads';
import { UserError } from '../util';
import { jobDir } from '../worktrees';
import { AccountOrderBook, accountPlan, chatAccountOf, type AccountPlan } from './account-order';
import { AgentRuntime, GOAL_BLOCKS } from './agent-runtime';
import { AgentStore } from './agent-store';
import { ApprovalBook } from './approvals';
import { writeDemoAgentDir } from './demo-agent-dir';
import { GitRefresher } from './git-refresh';
import { checkApiKey } from './api-key-check';
import type { KeyCheck } from './google-auth';
import { helperAgents, writeHelperAgents, type HelperAgent } from './helper-agents';
import { defaultInstruction, describeRun, duration, LEAD_TOOLS, prepareWorkflowSave, runLeadTool, takenIds, workflowDeleteProblem, type WorkflowSaveContext } from './lead-tools';
import { applyRunEdit, parseRunEditOps } from './run-edit';
import type { MockLlm } from './mock-llm';
import type { LocalServers } from './local-models';
import { splitSelector, type ModelRegistry } from './models';
import { AGENT_BUILD_HINT, DEFAULT_START_TIMEOUT_S, type OmpTimeouts } from './omp-check';
import { cleanOmpEnvValue, type OmpEnv } from './omp-env';
import type { OmpHealth } from './omp-health';
import type { OmpFrame } from './omp-process';
import { PlanGate } from './plan-gate';
import { ProcessPool, type ProcessSpec } from './process-pool';
import { CredentialWatch } from './credential-watch';
import { AccountError, OAUTH_PROVIDERS, ProviderAccounts, USAGE_TTL_MS } from './provider-accounts';
import { ProviderLogin } from './provider-login';
import { ASSISTANT_ROLE, modelOff, modelOwner, residentInfo, residentsFor, sessionDirOf, stepSpec, systemPromptFor, transcriptDirOf, type ResidentSpec } from './residents';
import { importOmpSession } from './session-import';
import { SubagentTracker } from './subagents';
import { ThreadBook, type ThreadRecord } from './thread-store';
import { TurnChanges } from './turn-changes';
import { WorkJournal, type JournalEntry } from './work-journal';
import { errorText, log, truncate } from './util';
import { EngineError, WorkflowEngine } from './workflow-engine';
import { normalizeWorkflow, WorkflowValidationError, type WorkflowStore } from './workflow-store';

export interface AgentSystemOptions {
  deps: AgentSystemDeps;
  models: ModelRegistry;
  workflows: WorkflowStore;
  ompBin: string;
  /** omp's version when known up front (tests); the live server reads it from `health`. */
  ompVersion: string | null;
  /** omp and AI-account checks running in the background (omp-health.ts); absent in tests (nothing is checked). */
  health?: OmpHealth;
  /** CAST_AGENT_TIMEOUT / CAST_AGENT_START_TIMEOUT (omp-check.ts); absent → the defaults. */
  timeouts?: OmpTimeouts;
  env: Record<string, string | undefined>;
  /** config.json's extra omp environment, kept in `env` (omp-env.ts); absent in tests → get/set_omp_env refused. */
  ompEnv?: OmpEnv;
  /** How a pasted API key is checked before it is saved (default: ask its vendor; CAST_KEY_CHECK=0 skips). */
  checkKey?: (name: ApiKeyName, key: string) => Promise<KeyCheck>;
  /** Model servers on other machines in omp's models.yml (local-models.ts); absent in tests → their messages refused. */
  localServers?: LocalServers;
  /** The scripted model (CAST_MOCK_LLM, tests/dev only): its omp agent dir, the server and why it couldn't start.
   *  All absent without the flag: nobody works on a model that isn't connected. */
  demoAgentDir?: string;
  mock?: MockLlm | null;
  mockError?: string | null;
  mockPort?: number;
  /** Debugging: append every omp frame as JSONL here (RLT_OMP_FRAME_LOG). */
  frameLog?: string;
  /** Notice sign-ins made outside CAST (`omp login` in a terminal): omp's agent dir, looked at every few seconds
   *  (credential-watch.ts). Absent (tests): nothing is watched. */
  credentialWatch?: { agentDir: string; intervalMs?: number };
}

const MAX_PROMPT = 20_000;
/** Who a pasted API key is for: the models it unlocks, and how the toasts name it. */
const API_KEYS: Record<ApiKeyName, { vendor: Vendor; label: string; maker: string; chats: string }> = {
  GEMINI_API_KEY: { vendor: 'google', label: 'Gemini API key', maker: 'Google', chats: 'Gemini' },
  ANTHROPIC_API_KEY: { vendor: 'anthropic', label: 'Anthropic API key', maker: 'Anthropic', chats: 'Claude' },
  OPENAI_API_KEY: { vendor: 'openai', label: 'OpenAI API key', maker: 'OpenAI', chats: 'OpenAI' },
};
/** get_account_order reads the limits again (in the background) when the last usage report is older than this (the
 *  accounts module would answer from its cache before that anyway). */
const USAGE_FRESH_MS = USAGE_TTL_MS;
/** The signed-in accounts are listed this long after startup (people's account chips, the saved order checked). */
const ACCOUNTS_AT_START_MS = 2500;
/** A helper's whole chat (get_helper_transcript): its last items, like a person's own transcript. */
const MAX_HELPER_ITEMS = 600;

function logFrame(file: string, agentId: string, frame: unknown): void {
  try {
    appendFileSync(file, `${JSON.stringify({ t: Date.now(), agentId, frame })}\n`);
  } catch {
    /* debugging aid only */
  }
}

/** Host tool calls of each agent, run one after another. omp sends host_tool_cancel when the user presses Stop:
 *  a cancelled call still waiting in line is skipped without a reply (omp has already given up on it); one that
 *  is running finishes and omp ignores its late reply. */
export class HostToolQueue {
  #tails = new Map<string, Promise<void>>();
  /** Per agent: call ids omp cancelled while its line was busy — forgotten when skipped or when the line empties. */
  #cancelled = new Map<string, Set<string>>();
  /** Per agent: bumped when its omp exits — calls that process left in line are skipped. */
  #gens = new Map<string, number>();

  constructor(private readonly run: (agentId: string, f: OmpFrame) => Promise<void>) {}

  push(agentId: string, f: OmpFrame): Promise<void> {
    const id = String(f.id ?? '');
    const tool = String(f.toolName ?? '');
    const gen = this.#gens.get(agentId) ?? 0;
    const prev = this.#tails.get(agentId) ?? Promise.resolve();
    const next = prev
      .then(() => {
        if ((this.#gens.get(agentId) ?? 0) !== gen) return log('agents', `${agentId}: ${tool} skipped — its agent is gone`);
        if (!this.#cancelled.get(agentId)?.delete(id)) return this.run(agentId, f);
        log('agents', `${agentId}: ${tool} skipped — cancelled while it waited`);
      })
      .catch((err) => log('agents', `${agentId}: ${tool} failed: ${errorText(err)}`));
    this.#tails.set(agentId, next);
    void next.finally(() => {
      if (this.#tails.get(agentId) !== next) return;
      this.#tails.delete(agentId);
      this.#cancelled.delete(agentId);
    });
    return next;
  }

  cancel(agentId: string, targetId: string): void {
    if (!targetId || !this.#tails.has(agentId)) return; // nothing waits: that call already finished
    let ids = this.#cancelled.get(agentId);
    if (!ids) this.#cancelled.set(agentId, (ids = new Set()));
    ids.add(targetId);
  }

  /** The agent's omp exited: nobody waits for the answers to its calls any more. Calls still in line are skipped,
   *  and the next process starts a line of its own instead of waiting behind one that is still running. */
  drop(agentId: string): void {
    if (!this.#tails.has(agentId)) return;
    this.#gens.set(agentId, (this.#gens.get(agentId) ?? 0) + 1);
    this.#tails.delete(agentId);
    this.#cancelled.delete(agentId);
  }
}

export class AgentSystemImpl implements AgentSystem {
  readonly store: AgentStore;
  readonly approvals: ApprovalBook;
  readonly subagents: SubagentTracker;
  readonly git: GitRefresher;
  readonly pool: ProcessPool;
  readonly engine: WorkflowEngine;
  readonly threads: ThreadBook;
  readonly login: ProviderLogin;
  readonly accounts: ProviderAccounts;
  /** Which signed-in account omp prefers per provider, and the overlay that tells every omp (account-order.ts). */
  readonly accountOrder: AccountOrderBook;
  #listAccounts?: ReturnType<typeof setTimeout>;
  /** Sign-ins made outside CAST (credential-watch.ts); #storeOps: CAST's own sign-outs running now. */
  #credWatch: CredentialWatch | null = null;
  #storeOps = 0;
  /** Plan cards and the per-message loop guard of every lead. */
  readonly plans: PlanGate;
  /** Per-turn undo of chat turns in house folders (turn-changes.ts). */
  readonly turns: TurnChanges;
  #specs = new Map<string, ResidentSpec>();
  #runtimes = new Map<string, AgentRuntime>();
  /** Team runs whose end the job's lead hears about (runId → the lead and the chat it was in then): the ones it
   *  started with team_start and the ones the user started from the Workflow tab. */
  #leadRuns = new Map<string, { agentId: string; threadId?: string }>();
  /** Per lead: sending its waiting team updates (one after another), and a retry while it compacts. */
  #flushes = new Map<string, Promise<void>>();
  #flushRetry = new Map<string, ReturnType<typeof setTimeout>>();
  #startFlush?: ReturnType<typeof setTimeout>;
  /** Each lead's team tool calls, one after another (team_assign then team_start in one message must run in order). */
  #leadCalls = new HostToolQueue((agentId, f) => this.#runHostTool(agentId, f));
  /** The core's job update (JobService.update), handed over once the core has it: team_assign goes through it. */
  #updateJob: ((projectId: string, jobId: string, patch: JobPatch) => Promise<Job>) | null = null;
  /** Task-tool helpers on other models (one per connected model) and the omp extension root they live in. */
  #helpers: HelperAgent[] = [];
  #helperRoot: string | undefined;
  #closed = false;
  /** What people were doing for the user, on disk for the next start (work-journal.ts). */
  readonly journal: WorkJournal;

  constructor(private readonly o: AgentSystemOptions) {
    const { hub, city, jobs, git, dataDir } = o.deps;
    this.journal = new WorkJournal(join(dataDir, 'in-flight.json'));
    jobs.setDefaultLeadModel(() => this.defaultLead());
    this.#helperRoot = this.#writeHelpers();
    this.store = new AgentStore(hub);
    this.threads = new ThreadBook((agentId, threads) => hub.broadcast({ t: 'threads', agentId, threads }));
    this.store.onTranscript((agentId, items) => this.threads.observe(agentId, items));
    this.approvals = new ApprovalBook(
      hub,
      {
        added: (req) => this.#approvalChanged(req.agentId),
        resolved: (req) => this.#approvalChanged(req.agentId),
      },
      (projectId, agentId) => {
        const p = this.o.deps.city.project(projectId);
        const a = this.store.get(agentId); // helpers carry their parent's job
        return p && { mode: p.approvalMode, dir: jobDir(p, a && jobs.get(projectId, a.jobId)) };
      },
    );
    this.subagents = new SubagentTracker({
      store: this.store,
      models: o.models,
      toast: (l, t, p, a) => this.toast(l, t, p, a),
      sessionOf: (agentId) => {
        const spec = this.#specs.get(agentId);
        return spec && { dir: sessionDirOf(dataDir, spec), file: this.threads.current(agentId)?.sessionFile };
      },
    });
    this.plans = new PlanGate({
      hub,
      store: this.store,
      jobs,
      city,
      models: o.models,
      waiting: (agentId, detail) => this.#runtimes.get(agentId)?.setWaiting(detail),
      goalActive: (agentId) => this.#runtimes.get(agentId)?.goalActive() ?? false,
    });
    this.git = new GitRefresher(hub, city, git, jobs);
    this.turns = new TurnChanges({
      git,
      folderOf: (agentId) => {
        const spec = this.#specs.get(agentId);
        const project = spec && city.project(spec.projectId);
        // a job's own copy has Bring into house / Undo last bring instead
        if (!spec || !project || jobs.get(project.id, spec.jobId)?.worktree) return null;
        return { project, name: this.store.get(agentId)?.name ?? agentId };
      },
      othersWorking: (agentId, projectId) => this.#workingInHouse(projectId, agentId),
      anyoneWorking: (projectId) => this.#workingInHouse(projectId),
      transcript: (agentId) => this.store.transcript(agentId),
      upsertItem: (agentId, item) => this.store.upsertItem(agentId, item),
      changed: (projectId) => this.git.poke(projectId),
    });
    this.accounts = new ProviderAccounts({ ompBin: o.ompBin, env: o.env, cwd: o.env.HOME ?? '/', credentialsKey: () => o.models.credentialsKey() });
    // Before the pool: its overlay must exist before any omp starts.
    this.accountOrder = new AccountOrderBook({
      dataDir,
      accounts: this.accounts,
      agentDir: o.env.PI_CODING_AGENT_DIR || join(o.env.HOME || homedir(), '.omp', 'agent'),
      onChange: () => this.#accountsChanged(),
    });
    this.pool = new ProcessPool({
      ompBin: o.ompBin,
      baseEnv: o.env,
      demoAgentDir: o.demoAgentDir,
      dataDir,
      startTimeoutMs: o.timeouts?.startMs,
      onFrame: (id, f) => {
        if (o.frameLog) logFrame(o.frameLog, id, f);
        if (f.type === 'host_tool_call') void this.#leadCalls.push(id, f);
        else if (f.type === 'host_tool_cancel') {
          this.#leadCalls.cancel(id, String(f.targetId ?? ''));
          this.plans.cancelCall(id, String(f.targetId ?? '')); // a team_start waiting for its plan card
        } else this.#runtimes.get(id)?.onFrame(f);
      },
      onExit: (id, info) => {
        // Its turn is over (a crash or a stop): a team_start waiting on a plan card can't get its answer any more.
        this.plans.cancelFor(id, 'gone');
        this.#leadCalls.drop(id);
        this.#runtimes.get(id)?.onExit(info);
      },
      isBusy: (id) => this.#runtimes.get(id)?.busy ?? false,
      inFlight: (id) => this.#runtimes.get(id)?.inFlight ?? false,
      onSession: (id, file, spec) => this.threads.noteSession(id, file, spec.threadId),
      onStartProgress: (id, seconds) => this.#runtimes.get(id)?.startProgress(seconds),
      accountsOverlay: () => this.accountOrder.ensureOverlay(),
      envGeneration: () => o.ompEnv?.generation ?? 0,
    });
    this.pool.reapOrphans();
    this.login = new ProviderLogin({
      ompBin: o.ompBin,
      env: o.env,
      emit: (login) => hub.broadcast({ t: 'login', login }),
      onConnected: async () => {
        const n = await this.#credentialsChanged();
        hub.broadcast({ t: 'toast', level: 'success', text: `Signed in — ${n} ${n === 1 ? 'model is' : 'models are'} ready.` });
      },
    });
    if (o.credentialWatch) {
      this.#credWatch = new CredentialWatch({
        agentDir: o.credentialWatch.agentDir,
        intervalMs: o.credentialWatch.intervalMs,
        known: () => o.models.checkedCredentialsKey,
        busy: () => this.login.active || this.#storeOps > 0 || o.models.checking,
        onChange: () => this.#signInsChangedOutside(),
      }).start();
    }
    this.engine = new WorkflowEngine({
      hub,
      city,
      jobs,
      git,
      store: this.store,
      approvals: this.approvals,
      subagents: this.subagents,
      gitRefresh: this.git,
      workflows: o.workflows,
      models: o.models,
      ensureRole: (project, job, step) => this.#ensureRole(project, job, step),
      onFinish: (run) => this.#teamFinished(run),
      onPeopleLeave: (run) => {
        const project = this.#closed ? undefined : this.o.deps.city.project(run.projectId);
        if (project) this.#syncProject(project, true);
      },
      toast: (l, t, p, a) => this.toast(l, t, p, a),
    });
    this.#followDefaultLead(); // a saved model list may already show an account
    for (const p of city.get().projects) {
      this.#syncProject(p, false);
      this.engine.loadHistory(p);
    }
    // Work the last stop interrupted (a chat turn, messages not read yet): said in the chats, never dropped silently.
    this.#restoreInterrupted(this.journal.take());
    // Team updates that waited in an open chat when RLT stopped (or couldn't be sent then) go out now.
    this.#startFlush = setTimeout(() => this.#flushWaiting(), 1500);
    // (not without omp: there is nobody to ask, and the log would only repeat that)
    this.#listAccounts = setTimeout(() => {
      if (this.o.health?.omp !== 'missing') void this.accountOrder.refresh();
    }, ACCOUNTS_AT_START_MS);
  }

  // ───────────────────────── AgentSystem contract ─────────────────────────

  snapshot(): AgentSnapshot {
    return {
      agents: this.store.list(),
      ...this.#workflowLists(),
      runs: this.engine.runs(),
      approvals: this.approvals.list(),
      models: this.o.models.models(),
      providers: this.o.models.providers(),
      plans: this.plans.pending(),
      spend: this.store.spend.totals(),
    };
  }

  async handle(msg: ClientMsg, conn: ClientConn): Promise<void> {
    try {
      await this.#dispatch(msg, conn);
    } catch (err) {
      const friendly = err instanceof EngineError || err instanceof WorkflowValidationError || err instanceof AccountError || err instanceof UserError;
      const message = friendly ? err.message : `Something went wrong: ${errorText(err)}`;
      if (!friendly) log('agents', `${msg.t} failed:`, err);
      if ('reqId' in msg && typeof msg.reqId === 'string') conn.send({ t: 'ack', reqId: msg.reqId, ok: false, error: message });
      else conn.send({ t: 'toast', level: 'error', text: message });
    }
  }

  async onProjectAdded(project: Project): Promise<void> {
    this.#syncProject(project, true);
  }

  async onProjectUpdated(project: Project): Promise<void> {
    this.#syncProject(project, true);
    this.approvals.reconsider(project.id);
  }

  async onProjectMoved(project: Project): Promise<void> {
    await this.pool.stopWhere((s) => s.projectId === project.id);
    this.#syncProject(project, true);
    this.approvals.reconsider(project.id);
  }

  async onJobsChanged(projectId: string): Promise<void> {
    const project = this.o.deps.city.project(projectId);
    if (project) this.#syncProject(project, true);
  }

  attachJobService(update: (projectId: string, jobId: string, patch: JobPatch) => Promise<Job>): void {
    this.#updateJob = update;
  }

  async onJobRemoved(projectId: string, jobId: string): Promise<void> {
    await this.engine.abortJob(projectId, jobId);
    const ids = this.store.list().filter((a) => a.projectId === projectId && a.jobId === jobId && a.kind !== 'subagent').map((a) => a.id);
    // Move everyone out first (no new prompt can reach them), then wait until their omp — booting ones included — is gone.
    for (const id of ids) this.#retire(id);
    await this.pool.stopWhere((s) => ids.includes(s.agentId));
  }

  async onProjectRemoved(projectId: string): Promise<void> {
    await this.engine.abortProject(projectId);
    for (const a of this.store.list()) if (a.projectId === projectId && a.kind !== 'subagent') this.#retire(a.id);
    await this.pool.stopWhere((s) => s.projectId === projectId);
    // its workflows go with it (the library keeps what it promoted)
    if (this.o.workflows.removeHouse(projectId)) this.#broadcastWorkflows();
  }

  defaultLead(): DefaultLead {
    const { models } = this.o;
    return { model: models.preferredAssistantModel(), connected: models.anyAvailable() };
  }

  /** Jobs that got a stand-in lead model before any account was connected move to the preferred connected model —
   *  unless somebody there is working. */
  #followDefaultLead() {
    const { jobs } = this.o.deps;
    jobs.followDefaultLead((projectId, jobId) =>
      !!this.engine.activeRunOf(projectId, jobId) || this.store.list().some((a) => a.projectId === projectId && a.jobId === jobId && (a.status === 'busy' || a.status === 'starting')));
  }

  /** A job's model must be connected — unless nothing is yet: choosing isn't working, and the first job may well be
   *  made before any sign-in (nobody works until one is: #notConnected). */
  unusableModel(selector: string): string | null {
    const { models } = this.o;
    if (!models.anyAvailable() || models.isAvailable(selector)) return null;
    return `${models.label(selector)} isn't connected — sign in under Models & providers, or pick a connected model.`;
  }

  ompVersion(): string | null {
    return this.o.health ? this.o.health.version : this.o.ompVersion;
  }

  /** What the app shows about omp and the AI accounts (undefined: nothing is checked, e.g. in tests). */
  health(): AgentsHealth | undefined {
    return this.o.health?.health();
  }

  /** One line for the start banner. */
  statusLine(): string {
    return this.o.health?.summary() ?? `cast-agent ${this.ompVersion() ?? '—'}`;
  }

  /** A background check started or ended (omp-health.ts): the app hears it; after a model check, people follow the
   *  models it found (who can work, who isn't connected). */
  healthChanged(modelsChecked: boolean): void {
    if (this.#closed) return;
    if (modelsChecked) this.#modelsChecked();
    else this.#broadcastModels();
  }

  #broadcastModels() {
    const { models } = this.o;
    this.o.deps.hub.broadcast({ t: 'models', models: models.models(), providers: models.providers(), demoMode: this.demoMode(), agents: this.health(), ompVersion: this.ompVersion() });
  }

  /** People run on the scripted model (CAST_MOCK_LLM, nothing connected). Always false in production. */
  demoMode(): boolean {
    return this.o.models.demoActive();
  }

  async shutdown(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    // From here on, people stop because CAST does: keep what they were doing for the next start.
    this.journal.freeze();
    this.o.health?.dispose();
    clearTimeout(this.#startFlush);
    clearTimeout(this.#listAccounts);
    this.#credWatch?.stop();
    for (const t of this.#flushRetry.values()) clearTimeout(t);
    this.login.shutdown();
    this.accounts.shutdown();
    this.plans.cancelAll();
    for (const r of this.engine.runs()) if (r.status === 'running' || r.status === 'waiting_approval') await this.engine.abort(r.id, { interrupted: true });
    await this.pool.shutdown();
    this.o.mock?.stop();
    this.engine.dispose();
    this.approvals.dispose();
    this.subagents.dispose();
    this.git.dispose();
    for (const r of this.#runtimes.values()) r.dispose();
    for (const a of this.store.list()) this.store.transcript(a.id); // flush throttled stream items into the threads
    this.threads.flushAll();
    this.store.dispose();
  }

  toast(level: 'info' | 'success' | 'warn' | 'error', text: string, projectId?: string, agentId?: string): void {
    this.o.deps.hub.broadcast({ t: 'toast', level, text, projectId, agentId });
  }

  // ───────────────────────── message handling ─────────────────────────

  async #dispatch(msg: ClientMsg, conn: ClientConn): Promise<void> {
    const { city } = this.o.deps;
    switch (msg.t) {
      case 'enter_project': {
        const project = city.project(String(msg.projectId));
        if (!project) throw new EngineError('That house no longer exists.');
        this.#syncProject(project, true);
        this.git.poke(project.id);
        return;
      }
      case 'prompt': {
        const text = typeof msg.text === 'string' ? msg.text.trim() : '';
        const images = msg.images ?? [];
        if (!text && !images.length) throw new EngineError('Type a message first.');
        const sent = this.#prompt(String(msg.agentId), truncate(text, MAX_PROMPT), images, msg.mode === 'steer' ? 'steer' : 'queue');
        // With a reqId the ack waits until omp has the message (the composer keeps the text on an error, and when a
        // Stop called the start off: calledOff).
        if (msg.reqId) {
          const r = await sent;
          if (r?.calledOff) conn.send({ t: 'ack', reqId: msg.reqId, ok: true, data: { calledOff: true } });
        } else void sent.catch((err: unknown) => this.#report(conn, err, `prompt to ${msg.agentId}`));
        return;
      }
      case 'abort': {
        const id = String(msg.agentId);
        // Stop on anyone of the group working now (or who worked last) stops the whole run.
        const run = this.engine.runAt(id);
        let restored: { text: string; images: ImageRef[] }[] = [];
        if (run) await this.engine.abort(run.id);
        else {
          this.plans.cancelFor(id, 'stopped'); // Stop while a plan card waits: the card goes too
          restored = (await this.#runtimes.get(id)?.abort()) ?? [];
        }
        // the user's messages it hadn't read yet go back to the composer
        if (msg.reqId) conn.send({ t: 'ack', reqId: msg.reqId, ok: true, data: { restored } });
        return;
      }
      case 'queue_action': {
        const rt = this.#chatRuntime(String(msg.agentId));
        const draft = await rt.queueAction(String(msg.key), msg.action);
        conn.send({ t: 'ack', reqId: msg.reqId, ok: true, data: msg.action === 'remove' ? (draft ?? { text: '', images: [] }) : undefined });
        return;
      }
      case 'compact': {
        const rt = this.#threadRuntime(String(msg.agentId), 'compact the chat');
        await this.o.models.firstResult(); // no beforeStart wait on this path: the refusal must see the first check
        const agent = this.store.get(rt.agentId)!;
        const off = this.#notConnected(agent);
        if (off) throw new EngineError(off);
        if (agent.demo && this.o.mockError) throw new EngineError(`The scripted model (CAST_MOCK_LLM) is unavailable: ${this.o.mockError}`);
        const run = agent.kind === 'resident' ? this.engine.activeRunOf(agent.projectId, agent.jobId) : undefined;
        if (run) throw new EngineError(`${agent.name}’s team is running “${run.workflowName}” — compact the chat after it finishes.`);
        // A chat omp never wrote has nothing to shrink: no need to start omp to hear that.
        if (!this.pool.get(rt.agentId) && !this.threads.resumeFile(rt.agentId)) {
          conn.send({ t: 'ack', reqId: msg.reqId, ok: true, data: { nothing: true } });
          return;
        }
        const data = await rt.compact();
        conn.send({ t: 'ack', reqId: msg.reqId, ok: true, data });
        return;
      }
      case 'goal': {
        await this.#goal(String(msg.agentId), msg.op, typeof msg.objective === 'string' ? msg.objective.trim() : '', msg.tokenBudget);
        conn.send({ t: 'ack', reqId: msg.reqId, ok: true });
        return;
      }
      case 'undo_turn': {
        const data = await this.turns.undo(String(msg.agentId), String(msg.itemId), msg.preview === true);
        conn.send({ t: 'ack', reqId: msg.reqId, ok: true, data });
        return;
      }
      case 'get_helper_transcript': {
        const id = String(msg.agentId);
        const item = this.store.findItem(id, String(msg.itemId));
        if (!item || item.kind !== 'helper') throw new EngineError('That helper isn’t in this chat any more.');
        const ompId = item.id.slice('helper:'.length);
        // Read from the helper's omp session file: works after it left, after its parent's omp stopped, after a restart.
        const file = this.subagents.sessionFile(id, ompId, item.sessionFile);
        const session = file ? importOmpSession(file, item.id) : null;
        const items = session ? session.items.slice(-MAX_HELPER_ITEMS) : [];
        conn.send({ t: 'ack', reqId: msg.reqId, ok: true, data: { items, running: this.subagents.running(id, ompId) } });
        return;
      }
      case 'get_transcript': {
        const id = String(msg.agentId);
        conn.send({ t: 'transcript_reset', agentId: id, items: this.store.transcript(id) });
        return;
      }
      case 'list_threads': {
        const id = String(msg.agentId);
        conn.send({ t: 'threads', agentId: id, threads: this.threads.list(id) });
        return;
      }
      case 'search_threads': {
        const id = String(msg.agentId);
        conn.send({ t: 'ack', reqId: msg.reqId, ok: true, data: { results: this.threads.search(id, String(msg.query)) } });
        return;
      }
      case 'new_thread': {
        const rt = this.#threadRuntime(String(msg.agentId), 'start a new chat');
        const thread = await rt.newThread();
        conn.send({ t: 'ack', reqId: msg.reqId, ok: true, data: { thread: this.#chatThread(rt.agentId, thread) } });
        return;
      }
      case 'switch_thread': {
        const rt = this.#threadRuntime(String(msg.agentId), 'switch chats');
        if (!this.threads.get(rt.agentId, String(msg.threadId))) throw new EngineError('That chat no longer exists.');
        const thread = await rt.switchThread(String(msg.threadId));
        conn.send({ t: 'ack', reqId: msg.reqId, ok: true, data: { thread: this.#chatThread(rt.agentId, thread) } });
        void this.#flushPending(rt.agentId); // team updates that waited for this chat
        return;
      }
      case 'delete_thread': {
        const rt = this.#threadRuntime(String(msg.agentId), 'delete a chat');
        const threadId = String(msg.threadId);
        if (!this.threads.get(rt.agentId, threadId)) throw new EngineError('That chat no longer exists.');
        // The current chat: move to a fresh one first, so omp leaves the session that is about to go. An empty current
        // chat is simply reused by newThread (nothing to delete then).
        if (this.threads.isCurrent(rt.agentId, threadId)) await rt.newThread();
        if (!this.threads.isCurrent(rt.agentId, threadId)) {
          this.threads.remove(rt.agentId, threadId);
          pruneUploads(this.o.deps.dataDir);
          log('agents', `${rt.agentId}: deleted chat ${threadId}`);
        }
        conn.send({ t: 'ack', reqId: msg.reqId, ok: true, data: { thread: this.#chatThread(rt.agentId, this.threads.current(rt.agentId)!) } });
        return;
      }
      case 'approve': {
        // answers that don't fit an ask's questions throw (UserError): the user is told, the card stays
        if (!this.approvals.answer(String(msg.approvalId), String(msg.value), msg.answers)) {
          conn.send({ t: 'approval_resolved', id: String(msg.approvalId) });
          throw new EngineError('That request is no longer waiting for you.');
        }
        if (msg.reqId) conn.send({ t: 'ack', reqId: msg.reqId, ok: true });
        return;
      }
      case 'run_workflow': {
        await this.#requireOmp(); // as a message to a person: say omp is missing rather than that a check failed
        const run = await this.engine.start(String(msg.projectId), msg.jobId, String(msg.workflowId), typeof msg.task === 'string' ? msg.task : '', { startedBy: 'user' });
        // The job's lead hears about runs from the Workflow tab too, so the chat knows what the team did.
        this.#noteLeadRun(run.id, agentIdFor(run.projectId, run.jobId, ASSISTANT_ROLE));
        conn.send({ t: 'ack', reqId: msg.reqId, ok: true, data: { runId: run.id } });
        return;
      }
      case 'get_run_plan': {
        conn.send({ t: 'ack', reqId: msg.reqId, ok: true, data: this.engine.planOf(String(msg.runId)) });
        return;
      }
      case 'edit_run': {
        // The run card's Edit / Add a person / Send a note: the run keeps going (run-edit.ts, like the lead's team_edit).
        const ops = parseRunEditOps(msg.ops);
        if ('error' in ops) throw new EngineError(ops.error);
        await this.#requireOmp();
        const house = this.engine.get(String(msg.runId))?.projectId ?? ''; // "for next time": the run's house's workflow
        const r = applyRunEdit(String(msg.runId), ops, { by: 'user', save: msg.save === true, ...(msg.seen ? { seen: msg.seen } : {}) }, {
          engine: this.engine,
          workflows: this.o.workflows,
          models: this.o.models,
          defaultInstruction,
          saveWorkflow: (raw) => this.#saveWorkflow(house, raw, { byHand: true }),
          usedBy: (id) => this.#usedBy(house, id),
          taken: (run) => takenIds({ store: this.store, workflows: this.o.workflows }, run),
        });
        if (!r.ok) throw new EngineError(r.error);
        conn.send({
          t: 'ack',
          reqId: msg.reqId,
          ok: true,
          data: { run: r.run, changes: r.plan.changes, warnings: r.plan.warnings, delivered: r.delivered, ...(r.saved ? { saved: r.saved.workflow.name } : {}), ...(r.notSaved ? { notSaved: r.notSaved } : {}) },
        });
        return;
      }
      case 'continue_run': {
        // The Workflow tab's "Run again from here": no plan card (the user chose it); the lead hears about it.
        await this.#requireOmp();
        const run = await this.engine.continueFrom(String(msg.runId), String(msg.fromStepId), {
          ...(typeof msg.note === 'string' && msg.note.trim() ? { note: msg.note } : {}),
          ...(msg.models ? { models: msg.models } : {}),
          startedBy: 'user',
        });
        this.#noteLeadRun(run.id, agentIdFor(run.projectId, run.jobId, ASSISTANT_ROLE));
        conn.send({ t: 'ack', reqId: msg.reqId, ok: true, data: { runId: run.id } });
        return;
      }
      case 'abort_run':
        await this.engine.abort(String(msg.runId));
        return;
      case 'revert_run': {
        const plan = await this.engine.revert(String(msg.runId), msg.preview === true);
        conn.send({ t: 'ack', reqId: msg.reqId, ok: true, data: { plan } });
        return;
      }
      case 'save_workflow': {
        const house = this.#workflowHouse(msg.projectId, 'save');
        const saved = this.#saveWorkflow(house.id, msg.workflow, { byHand: true });
        conn.send({ t: 'ack', reqId: msg.reqId, ok: true, data: { workflow: saved } });
        return;
      }
      case 'delete_workflow': {
        const house = this.#workflowHouse(msg.projectId, 'delete');
        const { workflow, cleared } = this.#deleteWorkflow(house.id, String(msg.workflowId), { clearTeams: msg.clearTeams === true });
        conn.send({ t: 'ack', reqId: msg.reqId, ok: true, data: { workflow, cleared } });
        return;
      }
      case 'promote_workflow': {
        const house = this.#workflowHouse(msg.projectId, 'promote');
        const entry = this.#promoteWorkflow(house.id, String(msg.workflowId), { replace: msg.replace === true });
        conn.send({ t: 'ack', reqId: msg.reqId, ok: true, data: { entry } });
        return;
      }
      case 'import_workflow': {
        const house = this.#workflowHouse(msg.projectId, 'import');
        const workflow = this.#importWorkflow(house.id, String(msg.workflowId), { replace: msg.replace === true });
        conn.send({ t: 'ack', reqId: msg.reqId, ok: true, data: { workflow } });
        return;
      }
      case 'delete_library_workflow': {
        const workflowId = String(msg.workflowId);
        if (!this.o.workflows.removeFromLibrary(workflowId)) throw new UserError(`The library has no workflow with id “${workflowId}”.`);
        this.#broadcastWorkflows(); // the houses' copies stay theirs
        conn.send({ t: 'ack', reqId: msg.reqId, ok: true, data: { workflowId } });
        return;
      }
      case 'save_run_team': {
        // kept in the run's house
        const house = this.engine.get(String(msg.runId))?.projectId ?? '';
        const prep = prepareWorkflowSave({ name: msg.name, from_run: String(msg.runId) }, this.#saveContext(house));
        if ('error' in prep) throw new EngineError(prep.error);
        const saved = this.#saveWorkflow(house, prep.workflow);
        conn.send({ t: 'ack', reqId: msg.reqId, ok: true, data: { workflow: saved } });
        return;
      }
      case 'answer_plan': {
        const plan = await this.plans.answer(String(msg.planId), msg.run === true, msg.models ?? {}, msg.thinking ?? {});
        conn.send({ t: 'ack', reqId: msg.reqId, ok: true, data: { plan } });
        return;
      }
      case 'refresh_models': {
        // Joins a running check, and reuses a recent good one while omp's sign-ins are unchanged (#69: every check is
        // an omp process of a few hundred MB). The outcome goes to the asking client; everyone gets the 'models' push.
        // config.json is read again first: an ompEnv edited by hand changes the fingerprint, so the models are checked.
        this.#reloadOmpEnv();
        const health = this.o.health;
        const outcome = health ? await health.refresh() : (await this.#reloadModels(), 'checked');
        conn.send({ t: 'toast', ...this.#refreshToast(outcome) });
        return;
      }
      case 'login_start':
        this.login.start(msg.provider);
        return;
      case 'login_input':
        if (!this.login.input(msg.loginId, msg.value)) throw new EngineError('That sign-in is no longer waiting — start it again.');
        return;
      case 'login_cancel':
        this.login.cancel(msg.loginId);
        return;
      case 'get_omp_env':
        conn.send({ t: 'ack', reqId: msg.reqId, ok: true, data: { ompEnv: this.#ompEnv().view() } });
        return;
      case 'set_omp_env':
        await this.#setOmpEnv(msg.patch, msg.reqId, conn);
        return;
      case 'list_local_servers': {
        const servers = this.#localServers();
        conn.send({ t: 'ack', reqId: msg.reqId, ok: true, data: { servers: servers.list(), file: servers.file } });
        return;
      }
      case 'test_local_server': {
        const models = await this.#localServers().test({ kind: msg.kind, baseUrl: msg.baseUrl, apiKey: msg.apiKey, name: msg.name });
        conn.send({ t: 'ack', reqId: msg.reqId, ok: true, data: { models } });
        return;
      }
      case 'save_local_server':
        await this.#changeLocalServers(msg.reqId, conn, msg.name, true, (s) => s.save({ name: msg.name, kind: msg.kind, baseUrl: msg.baseUrl, apiKey: msg.apiKey }));
        return;
      case 'remove_local_server':
        await this.#changeLocalServers(msg.reqId, conn, msg.name, false, (s) => s.remove(msg.name));
        return;
      case 'list_accounts': {
        const accounts = await this.accounts.list();
        void this.accountOrder.note(accounts);
        conn.send({ t: 'ack', reqId: msg.reqId, ok: true, data: { accounts } });
        return;
      }
      case 'logout_account': {
        this.#storeOps++; // the credential watch leaves this change to us
        try {
          const { removed, accounts } = await this.accounts.logout(msg.provider, msg.credentialId).catch(async (err: unknown) => {
            // The sign-out reached omp before it failed: models are re-detected all the same, then the error is shown.
            if (err instanceof AccountError && err.mayHaveChanged) await this.#credentialsChanged().catch((e) => log('agents', 'model reload after a failed sign-out failed:', e));
            throw err;
          });
          await this.#credentialsChanged(accounts); // like after a sign-in: people whose last account is gone can't work
          this.toast('success', `Signed out of ${removed.label}.`);
          conn.send({ t: 'ack', reqId: msg.reqId, ok: true, data: { accounts } });
        } finally {
          this.#storeOps--;
        }
        return;
      }
      case 'get_usage':
        conn.send({ t: 'ack', reqId: msg.reqId, ok: true, data: { usage: await this.accounts.usage(msg.force === true) } });
        return;
      case 'get_account_order': {
        await this.accountOrder.ensureListed();
        const last = this.accounts.lastUsage();
        const order = this.#accountOrderView(last?.snapshot);
        conn.send({ t: 'ack', reqId: msg.reqId, ok: true, data: { order } });
        // Limits can take omp up to 45 s: they follow as a push. No OAuth account to put in order: no limits to show,
        // so no `omp usage` (a few hundred MB) either.
        if (order.providers.length && (msg.force === true || !last || Date.now() - last.at > USAGE_FRESH_MS)) {
          void this.accounts.usage(msg.force === true).then((usage) => {
            if (!this.#closed) this.o.deps.hub.broadcast({ t: 'account_order', order: this.#accountOrderView(usage) });
          });
        }
        return;
      }
      case 'set_account_order': {
        // Saved → omp's overlay rewritten, every chat's own pick of the provider dropped (#accountsChanged moves the
        // live idle ones now; the rest before their next message or when their turn ends).
        await this.accountOrder.setOrder(msg.provider, msg.credentialIds);
        conn.send({ t: 'ack', reqId: msg.reqId, ok: true, data: { order: this.#accountOrderView(this.accounts.lastUsage()?.snapshot) } });
        return;
      }
      case 'set_chat_account': {
        const pending = await this.#setChatAccount(String(msg.agentId), msg.threadId, msg.provider, msg.credentialId);
        conn.send({ t: 'ack', reqId: msg.reqId, ok: true, data: { pending } });
        return;
      }
      default:
        throw new EngineError(`Unsupported message: ${(msg as { t?: string }).t}`);
    }
  }

  /** A message of the user to a person. The checks throw right away (EngineError); the promise settles once omp
   *  has the message — queued or steered while the person is busy (mode), read at once when idle. */
  async #prompt(agentId: string, text: string, imageIds: string[], mode: 'queue' | 'steer'): Promise<{ calledOff?: boolean } | void> {
    const agent = this.store.get(agentId);
    if (!agent) throw new EngineError('Unknown person.');
    if (agent.kind === 'subagent') {
      if (imageIds.length) throw new EngineError(`Helpers can’t see images — send them to ${this.store.get(agent.parentId ?? '')?.name ?? 'the person who sent them'} instead.`);
      return this.#steerHelper(agent, text);
    }
    await this.#requireOmp();
    // Nobody works on a model that isn't connected (while the first check runs, the runtime waits for it).
    const off = this.#notConnected(agent);
    if (off) throw new EngineError(off);
    if (agent.demo && this.o.mockError) throw new EngineError(`The scripted model (CAST_MOCK_LLM) is unavailable: ${this.o.mockError}`);
    // A chat message would land in the run's turn: the step would hand the reply on as its output (a review
    // without a verdict even counts as approve), and a person whose step is still to come would hold the run up.
    // Only the run's own people are locked (runs from before teams were kept: every team member of the job).
    const lead = () => this.store.list().find((a) => a.projectId === agent.projectId && a.jobId === agent.jobId && a.roleId === ASSISTANT_ROLE && a.kind === 'resident');
    const run = agent.kind === 'role' ? this.engine.activeRunOf(agent.projectId, agent.jobId) : undefined;
    if (run && (!run.team || run.team.some((m) => m.agentId === agentId))) {
      const l = lead();
      throw new EngineError(
        `${agent.name} is on the team's “${run.workflowName}” run — chat with them after it finishes. Ask ${l ? `the ${l.name}` : 'the lead'} how the team is doing — to tell them something now, use Send a note on their step in the Workflow tab, or ask the lead.`,
      );
    }
    if (agent.kind === 'role' && agent.roleId.startsWith('x-')) {
      const l = lead();
      throw new EngineError(`${agent.name} was only on that run's team and is leaving — ask ${l ? `the ${l.name}` : 'the lead'} instead.`);
    }
    const rt = this.#runtime(agentId);
    if (!rt) throw new EngineError('Unknown person.');
    const images = imageIds.length ? this.#images(agent, imageIds) : [];
    // A message of the user to a lead (queued or steered too): its next team shows a plan card, and a card still
    // waiting goes away — now, not when omp reads it (a waiting card holds the lead's turn, so it would never be read).
    if (agent.kind === 'resident' && agent.roleId === ASSISTANT_ROLE) this.plans.userMessage(agentId);
    return rt
      .prompt(text, {
        mode,
        by: 'user',
        chat: true,
        ...(images.length ? { images: images.map((i) => ({ mimeType: i.ref.mimeType, data: i.data })), imageRefs: images.map((i) => i.ref) } : {}),
      })
      .then((r) => {
        if (!r.calledOff) this.#flushWaiting(agentId); // omp works for them again: a team update that couldn't go goes now
        return r;
      });
  }

  /** The uploaded images of a message, read for omp (base64) — refused when the person's model can't see images. */
  #images(agent: AgentInfo, ids: string[]): { ref: ImageRef; data: string }[] {
    if (!this.o.models.takesImages(agent.model)) throw new EngineError(`${agent.modelLabel} can’t see images — send the message without them, or pick a model that can.`);
    return ids.map((id) => {
      const img = readUpload(this.o.deps.dataDir, id);
      if (!img) throw new EngineError('An attached image is no longer on the server — attach it again.');
      return img;
    });
  }

  /** Goal mode of a lead's chat (omp goal): create counts as a new message of the user for the plan card, and the
   *  goal's loop guard starts over on create and resume. */
  async #goal(agentId: string, op: 'create' | 'pause' | 'resume' | 'drop', objective: string, tokenBudget?: number) {
    const agent = this.store.get(agentId);
    if (!agent) throw new EngineError('That person is not home any more.');
    if (agent.kind !== 'resident' || agent.roleId !== ASSISTANT_ROLE) throw new EngineError('Only a job’s lead can work toward a goal.');
    const rt = this.#runtime(agentId);
    if (!rt) throw new EngineError('That person is not home any more.');
    await this.o.models.firstResult(); // no beforeStart wait on this path: never start omp before the first check ends
    // pause and drop go to a running omp whatever is connected (agent-runtime); without one they would start omp
    if (op === 'create' || op === 'resume' || !this.pool.get(agentId)) {
      const off = this.#notConnected(agent);
      if (off) throw new EngineError(off);
      if (agent.demo && this.o.mockError) throw new EngineError(`The scripted model (CAST_MOCK_LLM) is unavailable: ${this.o.mockError}`);
    }
    if (op === 'create') {
      if (!objective) throw new EngineError('Say what the goal is first.');
      if (agent.goal) throw new EngineError('This chat already has a goal — drop it first.');
      this.plans.userMessage(agentId);
    }
    if (op === 'create' || op === 'resume') this.plans.goalStarted(agentId);
    await rt.goal(op, op === 'create' ? objective : undefined, op === 'create' ? tokenBudget : undefined);
    if (op === 'create' || op === 'resume') this.#flushWaiting(agentId);
  }

  /** A failed message without a reqId (no ack to carry the error): friendly errors become a toast, the rest a log. */
  #report(conn: ClientConn, err: unknown, what: string) {
    if (err instanceof EngineError || err instanceof UserError) conn.send({ t: 'toast', level: 'error', text: err.message });
    else log('agents', `${what} failed: ${errorText(err)}`);
  }

  /** CAST stopped while people worked for the user (in-flight.json): each chat says so — the turn that was cut off
   *  gets "Run again", messages they never read are marked "Not sent" with Retry — and the person shows it until
   *  their next message. Nothing is re-run on its own (it could do the work twice). */
  #restoreInterrupted(entries: Record<string, JournalEntry>) {
    const at = Date.now();
    let people = 0;
    for (const [agentId, e] of Object.entries(entries)) {
      const agent = this.store.get(agentId);
      if (!agent || agent.kind === 'subagent') continue;
      // The chat it was in must still be the current one (its transcript is what the user sees).
      if (e.threadId && this.threads.current(agentId)?.id !== e.threadId) continue;
      const items = this.store.transcript(agentId);
      const sys = (text: string, extra: Partial<Extract<TranscriptItem, { kind: 'system' }>> = {}) =>
        this.store.upsertItem(agentId, { kind: 'system', id: `${agentId}:s:r${at.toString(36)}${Math.random().toString(36).slice(2, 6)}`, level: 'warn', text, ts: Date.now(), ...extra });
      if (e.turn) sys(`Interrupted: CAST restarted before ${agent.name} finished this.`, { resend: { text: e.turn.text, ...(e.turn.images.length ? { images: e.turn.images } : {}) } });
      for (const m of e.waiting) {
        const bubble = m.itemId ? items.find((i) => i.id === m.itemId) : undefined;
        if (bubble?.kind === 'user') this.store.upsertItem(agentId, { ...bubble, notSent: true });
        else this.store.upsertItem(agentId, { kind: 'user', id: `${agentId}:u:r${at.toString(36)}${Math.random().toString(36).slice(2, 6)}`, text: m.text, ts: Date.now(), ...(m.images.length ? { images: m.images } : {}), notSent: true });
      }
      if (e.waiting.length) sys(`CAST restarted before ${agent.name} read ${e.waiting.length === 1 ? 'your message, so it wasn’t sent' : `${e.waiting.length} of your messages, so they weren’t sent`} — Retry when you’re ready.`);
      this.store.patch(agentId, { interrupted: at, status: 'offline', activity: 'error', detail: 'Interrupted by a restart', tool: undefined }, true);
      people++;
    }
    if (people) log('agents', `restart: work of ${people} ${people === 1 ? 'person was' : 'people were'} interrupted — marked in their chats`);
  }

  /** omp isn't installed: nobody can work — say how to fix it rather than failing at the spawn. It is looked for
   *  again first (cheap), so installing it while CAST runs works at once. */
  async #requireOmp(): Promise<void> {
    const health = this.o.health;
    if (!health || health.omp !== 'missing') return;
    await health.recheckMissing();
    if (health.omp === 'missing') throw new EngineError(`The agent (cast-agent) wasn't found at ${this.o.ompBin}, so nobody can work yet. ${AGENT_BUILD_HINT}`);
  }

  /** What a Refresh found, in words (the asking client's toast). */
  #refreshToast(outcome: 'checked' | 'reused'): { level: 'info' | 'warn' | 'error'; text: string } {
    const { models } = this.o;
    const health = this.health();
    if (health?.omp === 'missing') return { level: 'error', text: `The agent (cast-agent) wasn't found at ${health.ompPath}. ${AGENT_BUILD_HINT}` };
    const n = models.models().filter((m) => m.available).length;
    const found = n ? `${n} model${n === 1 ? '' : 's'} connected` : 'nobody is signed in yet — connect an AI account under Models & providers';
    if (models.detectError) {
      const kept = models.hasResult ? `kept the last result (${found})` : 'nothing counts as connected until a check works';
      return { level: 'warn', text: `Couldn't check your AI accounts: ${models.detectError} — ${kept}. CAST tries again by itself.` };
    }
    if (outcome === 'reused') return { level: 'info', text: `Up to date: ${found} (no sign-in changed since the last check).` };
    return { level: 'info', text: `${found[0]!.toUpperCase()}${found.slice(1)}.` };
  }

  /** Why this person can't work now: their model isn't connected (null: they can). While the very first check still
   *  runs it is too early to say: the runtime's beforeStart waits for it, then asks again (blocked). Only the scripted
   *  test model (CAST_MOCK_LLM, nothing connected) stands in for models that aren't connected. */
  #notConnected(agent: Pick<AgentInfo, 'name' | 'model' | 'kind'>): string | null {
    const { models } = this.o;
    if (!modelOff(models, agent.model)) return null; // AgentInfo.notConnected says the same to the page
    if (models.state === 'failed') return `CAST couldn't check your AI accounts (${models.detectError}) — it tries again by itself; press Refresh under Models & providers. ${agent.name} can work once a check works.`;
    if (!models.anyAvailable()) return `${agent.name} can't work yet: no AI account is connected. Connect one under Models & providers.`;
    const how = agent.kind === 'resident' ? 'pick another model (job menu → Edit job…)' : 'pick another model: change the team in the Workflow tab or ask the Assistant';
    return `${agent.name} uses ${models.label(agent.model)}, which isn't connected — sign in under Models & providers, or ${how}.`;
  }

  /** Talk to a helper mid-task (omp steer_subagent: text only). Rejects with an EngineError when it can't take it. */
  async #steerHelper(helper: AgentInfo, text: string): Promise<void> {
    const parent = helper.parentId ? this.#runtimes.get(helper.parentId) : undefined;
    const ompId = this.subagents.ompIdOf(helper.id);
    this.store.upsertItem(helper.id, { kind: 'user', id: `${helper.id}:u:${Date.now()}`, text, ts: Date.now() });
    const ok = parent && ompId ? await parent.steerHelper(ompId, text) : false;
    if (!ok) throw new EngineError(`${helper.name} couldn't take the message (they may be finishing up).`);
  }

  // ───────────────────────── the lead's team ─────────────────────────

  /** omp asks RLT to run one of the lead's team tools (lead-tools.ts) — after the lead's earlier calls finished. */
  async #runHostTool(agentId: string, f: OmpFrame) {
    const id = String(f.id ?? '');
    const spec = this.#specs.get(agentId);
    const tool = String(f.toolName ?? '');
    let res: { text: string; isError?: boolean };
    if (!spec || spec.roleId !== ASSISTANT_ROLE) {
      res = { text: `${tool} is only for the job's lead.`, isError: true };
    } else {
      const house = spec.projectId; // the lead's workflow deps work in its own house
      res = await runLeadTool(
        { tool, args: (f.arguments ?? {}) as Record<string, unknown>, agentId, projectId: spec.projectId, jobId: spec.jobId, callId: id },
        {
          engine: this.engine,
          jobs: this.o.deps.jobs,
          workflows: this.o.workflows,
          store: this.store,
          models: this.o.models,
          gate: this.plans,
          houseWorkflowId: (pid) => this.o.deps.city.project(pid)?.workflowId ?? null,
          started: (runId, lead) => {
            this.#noteLeadRun(runId, lead);
            this.plans.noteRun(lead);
          },
          stopped: (runId) => this.#leadRuns.delete(runId),
          saveWorkflow: (raw) => this.#saveWorkflow(house, raw),
          deleteWorkflow: (wid, opts) => this.#deleteWorkflow(house, wid, opts).workflow,
          promoteWorkflow: (wid, o) => this.#promoteWorkflow(house, wid, o),
          importWorkflow: (wid, o) => this.#importWorkflow(house, wid, o),
          assignTeam: (pid, jid, workflowId) => {
            if (!this.#updateJob) throw new EngineError("Teams can't be changed from chat here.");
            return this.#updateJob(pid, jid, { workflowId });
          },
          usedBy: (workflowId, except) => this.#usedBy(house, workflowId, except),
          helpers: () => this.#helpers.map((h) => ({ name: h.name, label: h.label })),
        },
      ).catch((err: unknown) => ({
        text: err instanceof EngineError || err instanceof WorkflowValidationError || err instanceof UserError ? err.message : `Failed: ${errorText(err)}`,
        isError: true,
      }));
    }
    log('agents', `${agentId}: ${tool}${res.isError ? ` failed — ${truncate(res.text, 120)}` : ''}`);
    this.pool.get(agentId)?.respondHostTool(id, res.text, res.isError);
  }

  /** The lists of workflows the page has (snapshot, 'workflows'): each house's own and the shared library.
   *  `workflows` (the old built-ins) is always empty; it stays for pages from before. */
  #workflowLists(): { workflows: Workflow[]; houseWorkflows: Record<string, Workflow[]>; library: LibraryWorkflow[] } {
    return { workflows: [], houseWorkflows: this.o.workflows.byHouse(), library: this.o.workflows.library() };
  }

  /** Every client hears the workflows after any change (a house's, the library's). */
  #broadcastWorkflows() {
    this.o.deps.hub.broadcast({ t: 'workflows', ...this.#workflowLists() });
  }

  /** The house a workflow message from the page names. A page from before workflows belonged to houses names none:
   *  it is told to reload (it would save into no house). Throws UserError. */
  #workflowHouse(projectId: string | undefined, what: string): Project {
    if (typeof projectId !== 'string' || !projectId) throw new UserError(`This page is out of date — reload it to ${what} workflows.`);
    const p = this.o.deps.city.project(projectId);
    if (!p) throw new UserError('That house no longer exists.');
    return p;
  }

  /** Save a workflow in this house (the Workflow tab, the lead's workflow_save, a run card's "for next time", "Keep
   *  this team"): only this house has it. Store it, tell every client, and re-sync the people of this house's jobs
   *  whose team it is. byHand: the user changed it (the Workflow tab, a run card's "for next time") — the store notes
   *  when they set a person's model or effort, which then wins over an older plan-card choice (pickTeam), and leaves
   *  the workflow's base alone (a lead's later save keeps the hand edit: workflow-merge.ts). Throws
   *  WorkflowValidationError. */
  #saveWorkflow(projectId: string, raw: unknown, o: { byHand?: boolean } = {}): Workflow {
    const { city } = this.o.deps;
    const project = city.project(projectId);
    if (!project) throw new UserError('That house no longer exists.');
    const workflow = normalizeWorkflow(raw);
    const before = o.byHand ? this.o.workflows.get(projectId, workflow.id) : undefined;
    // Models that aren't connected can't be used — unless nothing is yet: designing a team isn't working (nobody
    // works until an account is connected: #notConnected, the engine's own check).
    const { models } = this.o;
    const off = models.anyAvailable() ? workflow.steps.filter((s) => !models.isAvailable(s.model)) : [];
    if (off.length) {
      const ok = models.models().filter((m) => m.available).map((m) => m.label);
      throw new EngineError(
        `Not connected: ${off.map((s) => `${s.name} uses ${models.label(s.model)}`).join(', ')}. Pick connected models${ok.length ? ` (${ok.join(', ')})` : ''}, or sign in under Models & providers first.`,
      );
    }
    const saved = this.o.workflows.save(projectId, workflow);
    if (before) {
      for (const s of saved.steps) {
        const b = before.steps.find((x) => x.id === s.id);
        if (b && b.model !== s.model) this.o.workflows.noteHandSet(projectId, saved.id, s.id, 'model');
        if (b && (b.thinking ?? '') !== (s.thinking ?? '')) this.o.workflows.noteHandSet(projectId, saved.id, s.id, 'thinking');
      }
    }
    this.#workflowChanged(project, saved);
    return saved;
  }

  /** A house's workflow is new or changed (saved, imported): the models it names are known, every client hears it, and
   *  the house's jobs whose team it is get its people. */
  #workflowChanged(project: Project, w: Workflow) {
    const modelsChanged = this.o.models.noteSelectors(w.steps.map((s) => s.model));
    if (modelsChanged) this.#refreshModelFiles();
    this.#broadcastWorkflows();
    if (modelsChanged) this.o.deps.hub.broadcast({ t: 'models', models: this.o.models.models(), providers: this.o.models.providers(), demoMode: this.demoMode() });
    if (this.#teamsOf(project.id, w.id).length) this.#syncProject(project, true);
  }

  /** Delete this house's saved workflow (the Workflow tab or the lead's workflow_delete): never while it runs. A job's
   *  team only with clearTeams (the user said so): those jobs get no fixed team. No job of the house, nor the house,
   *  keeps pointing at it. Other houses' workflows with the same id are theirs, untouched. `cleared`: the jobs it was
   *  the team of, by name. Throws EngineError. */
  #deleteWorkflow(projectId: string, id: string, opts: { clearTeams?: boolean } = {}): { workflow: Workflow; cleared: string[] } {
    const { city, jobs } = this.o.deps;
    const project = city.project(projectId);
    if (!project) throw new UserError('That house no longer exists.');
    const ctx = this.#saveContext(projectId);
    const problem = workflowDeleteProblem(id, opts.clearTeams ? { ...ctx, usedBy: () => [] } : ctx);
    if (problem) throw new EngineError(problem);
    const users = this.#teamsOf(projectId, id); // only with clearTeams: else refused above
    const gone = this.o.workflows.get(projectId, id)!;
    this.engine.keepTeamsOf(projectId, gone); // its older runs found their people through it
    this.o.workflows.remove(projectId, id);
    // The jobs it was the team of get none; a house that still names it follows its Main job (none now, or that job's
    // own team) — all in this one step, so nothing can start in between.
    for (const { job } of users) if (job.workflowId === id) jobs.update(projectId, job.id, { workflowId: null });
    if (project.workflowId === id) city.updateProject(projectId, { workflowId: jobs.get(projectId, MAIN_JOB_ID)?.workflowId ?? null });
    this.#broadcastWorkflows();
    const now = city.project(projectId);
    if (now) this.#syncProject(now, true); // its people leave the rooms of the jobs that had it
    return { workflow: gone, cleared: users.map(({ job }) => job.name) };
  }

  /** Put a copy of this house's workflow in the shared library (the house keeps its own). Throws
   *  WorkflowValidationError (WorkflowExistsError: the library has that id — replace). */
  #promoteWorkflow(projectId: string, id: string, o: { replace?: boolean } = {}): LibraryWorkflow {
    const project = this.o.deps.city.project(projectId);
    if (!project) throw new UserError('That house no longer exists.');
    const entry = this.o.workflows.promote(projectId, id, { house: project.name, ...(o.replace ? { replace: true } : {}) });
    this.#broadcastWorkflows();
    return entry;
  }

  /** Copy a library workflow into this house: the house's own from now on. With replace over the house's workflow of
   *  that id — the jobs whose team it is get the library's people. Throws WorkflowValidationError (WorkflowExistsError:
   *  the house has that id — replace). */
  #importWorkflow(projectId: string, id: string, o: { replace?: boolean } = {}): Workflow {
    const project = this.o.deps.city.project(projectId);
    if (!project) throw new UserError('That house no longer exists.');
    const w = this.o.workflows.importFromLibrary(projectId, id, o.replace ? { replace: true } : {});
    this.#workflowChanged(project, w);
    return w;
  }

  /** The lookups workflow_save / workflow_delete do, in this house. */
  #saveContext(projectId: string): WorkflowSaveContext {
    return { projectId, models: this.o.models, usedBy: (w, except) => this.#usedBy(projectId, w, except), workflows: this.o.workflows, engine: this.engine };
  }

  /** Every job of this house whose team the workflow is (the Main job falls back to the house's team). */
  #teamsOf(projectId: string, workflowId: string, except?: { jobId: string }): { project: Project; job: Job }[] {
    const p = this.o.deps.city.project(projectId);
    if (!p) return [];
    const out: { project: Project; job: Job }[] = [];
    for (const j of this.o.deps.jobs.list(p.id)) {
      if (except && j.id === except.jobId) continue;
      if ((j.workflowId ?? (j.id === MAIN_JOB_ID ? p.workflowId : null)) === workflowId) out.push({ project: p, job: j });
    }
    return out;
  }

  /** The names of this house's jobs whose team the workflow is (the house is implied). */
  #usedBy(projectId: string, workflowId: string, except?: { jobId: string }): string[] {
    return this.#teamsOf(projectId, workflowId, except).map(({ job }) => job.name);
  }

  /** A team run the lead hears about when it ends, and the chat the lead is in now (its omp session knows why). */
  #noteLeadRun(runId: string, lead: string) {
    this.#leadRuns.set(runId, { agentId: lead, threadId: this.threads.current(lead)?.id });
  }

  /** A run ended: the job's lead hears about it (a follow-up if they're mid-turn) and tells the user — runs it
   *  started itself, and runs the user started from the Workflow tab. In the chat the run was started from: when
   *  the user is in another chat now, the update waits with that chat (sent once it is open again) and the open
   *  chat gets a line that leads there. */
  #teamFinished(run: WorkflowRun) {
    const at = this.#leadRuns.get(run.id);
    if (!at) return;
    this.#leadRuns.delete(run.id);
    const { agentId } = at;
    // Not while the server, the job or the house goes away (their runs are stopped first).
    if (this.#closed || !this.o.deps.city.project(run.projectId) || !this.o.deps.jobs.get(run.projectId, run.jobId)) return;
    const rt = this.#runtime(agentId);
    if (!rt || rt.retired) return;
    const lead = this.store.get(agentId);
    if (lead && this.#notConnected(lead)) {
      log('agents', `${agentId}: no team update — the lead's model isn't connected`);
      return;
    }
    const tab = run.startedBy === 'user';
    const how = run.status === 'completed' ? 'finished' : run.status === 'aborted' ? 'was stopped' : 'failed';
    const text = [
      `[RLT team update]${tab ? ' (the user started this run from the Workflow tab)' : ''} “${run.workflowName}” ${how} after ${duration((run.endedAt ?? Date.now()) - run.startedAt)}.`,
      describeRun(run, { workflows: this.o.workflows, store: this.store }),
      tab
        ? "Sum it up for the user; don't start another team for it unless they ask (to redo only part of it: team_continue)."
        : run.status === 'completed'
          ? 'Tell the user briefly what the team did and what they should check. If they want only part of it redone later, use team_continue from that step.'
          : run.status === 'aborted'
            ? // stopped on purpose (Stop, team_stop): no card is due now, so a team_continue would undo that Stop at once
              "Tell the user briefly what happened. It was stopped on purpose: don't continue it unless the user asks — then continue from the step that was stopped (team_continue): the finished steps keep their results; don't start the whole team again."
            : "Tell the user briefly what happened. The finished steps keep their results: to go on, continue from the step that failed (team_continue) — don't start the whole team again.",
    ].join('\n\n');
    const shown = `Team update: “${run.workflowName}”${tab ? ' (from the Workflow tab)' : ''} ${how} — ${rt.info?.name ?? 'the lead'} will sum it up.`;
    const update = { text, shown, at: Date.now() };
    // A chat that was still empty then (or is gone) has no context to lose: the open chat gets it.
    const from = at.threadId ? this.threads.get(agentId, at.threadId) : undefined;
    if (from && from.messages > 0 && !this.threads.isCurrent(agentId, from.id)) {
      this.threads.addPending(agentId, from.id, [update]);
      this.store.upsertItem(agentId, {
        kind: 'system',
        id: `${agentId}:s:team-${run.id}`,
        level: 'info',
        text: `“${run.workflowName}” ${how} — its update is in the chat “${from.title}”.`,
        ts: Date.now(),
        link: { threadId: from.id, label: 'Open that chat' },
      });
      return;
    }
    const cur = this.threads.current(agentId);
    if (cur) this.threads.addPending(agentId, cur.id, [update]);
    void this.#flushPending(agentId);
  }

  /** Send the team updates waiting for the lead's open chat (as RLT's own messages: queued while the lead works),
   *  one after another. While it compacts they wait a little longer; ones that can't be sent stay with the chat. */
  #flushPending(agentId: string): Promise<void> {
    const prev = this.#flushes.get(agentId) ?? Promise.resolve();
    const next = prev.then(() => this.#sendPending(agentId));
    this.#flushes.set(agentId, next);
    void next.finally(() => {
      if (this.#flushes.get(agentId) === next) this.#flushes.delete(agentId);
    });
    return next;
  }

  async #sendPending(agentId: string): Promise<void> {
    const thread = this.threads.current(agentId);
    const rt = this.#runtimes.get(agentId);
    if (this.#closed || !thread?.pending?.length || !rt || rt.retired) return;
    const lead = this.store.get(agentId);
    if (lead && this.#notConnected(lead)) return; // kept until the lead can work again
    if (rt.compacting) return this.#retryPending(agentId);
    const updates = this.threads.takePending(agentId, thread.id);
    for (const [i, u] of updates.entries()) {
      try {
        await rt.prompt(u.text, { shown: u.shown, by: 'rlt' });
      } catch (err) {
        this.threads.addPending(agentId, thread.id, updates.slice(i), true);
        log('agents', `team update to ${agentId} failed: ${errorText(err)}`);
        if (rt.compacting) this.#retryPending(agentId);
        return;
      }
    }
  }

  /** Team updates still waiting in a person's open chat — one that couldn't be sent (omp failed to start, the model
   *  wasn't connected), or from before RLT restarted — go out once they can work: at startup, when sign-ins change,
   *  after they took a message of the user or a goal. Nothing waits for a chat switch any more. */
  #flushWaiting(agentId?: string): void {
    if (this.#closed) return;
    const ids = agentId ? [agentId] : this.store.list().filter((a) => a.kind !== 'subagent').map((a) => a.id);
    for (const id of ids) {
      if (!this.threads.current(id)?.pending?.length || !this.#runtime(id)) continue;
      void this.#flushPending(id);
    }
  }

  #retryPending(agentId: string) {
    if (this.#flushRetry.has(agentId)) return;
    this.#flushRetry.set(agentId, setTimeout(() => {
      this.#flushRetry.delete(agentId);
      void this.#flushPending(agentId);
    }, 2000));
  }

  // ───────────────────────── threads ─────────────────────────

  /** The runtime of a person whose chats can change now (exists, not a helper, not busy). */
  #threadRuntime(agentId: string, what: string): AgentRuntime {
    const agent = this.store.get(agentId);
    if (!agent) throw new EngineError('That person is not home any more.');
    if (agent.kind === 'subagent') throw new EngineError('Helpers have a single chat — talk to the person who sent them instead.');
    const rt = this.#runtime(agentId);
    if (!rt) throw new EngineError('That person is not home any more.');
    // An active goal keeps them busy between turns too (omp goes on with it): waiting wouldn't help.
    if (rt.goalActive()) throw new EngineError(GOAL_BLOCKS(agent.name, what));
    if (rt.busy || this.engine.isBusyInRun(agentId)) {
      throw new EngineError(`${agent.name} is still working. Wait until they're done (or press Stop) to ${what}.`);
    }
    // Between steps too: a review loop comes back to the same chat, so it must still be the run's chat then.
    const run = this.engine.activeRunWith(agentId);
    if (run) throw new EngineError(`${agent.name} is part of “${run.workflowName}”, which is still running. Wait until it finishes (or stop it) to ${what}.`);
    return rt;
  }

  /** The runtime of a person you can chat with (not a helper). */
  #chatRuntime(agentId: string): AgentRuntime {
    const agent = this.store.get(agentId);
    const rt = agent && agent.kind !== 'subagent' ? this.#runtime(agentId) : undefined;
    if (!rt) throw new EngineError(agent ? 'Helpers have no message queue — talk to the person who sent them.' : 'That person is not home any more.');
    return rt;
  }

  /** Who works in the house folder (people of jobs without their own copy, their helpers, teams running there) right
   *  now, as words — or null. `except`: that person and their helpers don't count. */
  #workingInHouse(projectId: string, except?: string): string | null {
    const jobs = this.o.deps.jobs.list(projectId);
    const inHouse = new Set(jobs.filter((j) => !j.worktree).map((j) => j.id));
    const nameOf = (jobId: string) => jobs.find((j) => j.id === jobId)?.name ?? jobId;
    const run = this.engine.runs().find((r) => r.projectId === projectId && inHouse.has(r.jobId ?? MAIN_JOB_ID) && (r.status === 'running' || r.status === 'waiting_approval'));
    if (run) return `A team is working in “${nameOf(run.jobId ?? MAIN_JOB_ID)}”`;
    const busy = this.store.list().find((a) => a.projectId === projectId && inHouse.has(a.jobId) && a.status === 'busy' && a.id !== except && (!except || a.parentId !== except));
    return busy ? `${busy.name} of “${nameOf(busy.jobId)}” is still working` : null;
  }

  #chatThread(agentId: string, t: ThreadRecord): ChatThread {
    return this.threads.list(agentId).find((x) => x.id === t.id) ?? {
      id: t.id, agentId, title: t.title, createdAt: t.createdAt, updatedAt: t.updatedAt, messages: t.messages, current: true,
    };
  }

  // ───────────────────────── residents ─────────────────────────

  #runtime(agentId: string): AgentRuntime | undefined {
    let rt = this.#runtimes.get(agentId);
    if (rt) return rt;
    const spec = this.#specs.get(agentId);
    if (!spec) return undefined;
    rt = new AgentRuntime(agentId, spec.projectId, {
      store: this.store,
      pool: this.pool,
      approvals: this.approvals,
      subagents: this.subagents,
      git: this.git,
      threads: this.threads,
      specFor: (id) => this.#processSpec(id),
      onFileTool: (id, tool, args) => {
        this.engine.noteFileTool(id, tool, args);
        this.turns.noteFileTool(id, spec.projectId);
      },
      toast: (l, t, p, a) => this.toast(l, t, p, a),
      accountPlan: (id) => this.#accountPlan(id),
      accountChanged: (id) => this.#refreshChatAccounts([id]),
      accountsSettled: (id) => (this.#accountProvider(id) ? this.accountOrder.overlaySettled() : Promise.resolve()),
      // The very first AI-account check still runs (nothing to go by yet): wait for it rather than refusing a
      // signed-in user's chat (blocked() then says why when nobody can work).
      beforeStart: () => (this.o.models.state === 'checking' ? { detail: 'Checking AI accounts…', promise: this.o.models.firstResult() } : null),
      blocked: (id) => {
        const a = this.store.get(id);
        return a ? this.#notConnected(a) : null;
      },
      startTimeoutS: Math.round((this.o.timeouts?.startMs ?? DEFAULT_START_TIMEOUT_S * 1000) / 1000),
      ompBin: this.o.ompBin,
      journal: (id, entry) => this.journal.set(id, entry),
      turns: this.turns,
    });
    this.#runtimes.set(agentId, rt);
    return rt;
  }

  #processSpec(agentId: string): ProcessSpec | null {
    const spec = this.#specs.get(agentId);
    const project = spec ? this.o.deps.city.project(spec.projectId) : undefined;
    if (!spec || !project) return null;
    const resolved = this.o.models.resolve(spec.model);
    // Nobody works on a model that isn't connected (#notConnected says why); only the scripted test model
    // (CAST_MOCK_LLM, nothing connected) stands in. While the very first check runs the spec is still given: the
    // runtime waits for that check (beforeStart) and asks again before it starts anything.
    if (resolved.demo && !this.o.models.demoActive() && this.o.models.state !== 'checking') return null;
    return {
      agentId,
      projectId: project.id,
      roleId: spec.roleId,
      cwd: jobDir(project, this.o.deps.jobs.get(project.id, spec.jobId)), // a job with its own copy of the files works there
      model: resolved.selector,
      demo: resolved.demo,
      // Auto: omp asks about every edit and command, and RLT's auto review answers the safe ones
      approvalMode: project.approvalMode === 'auto' ? 'always-ask' : project.approvalMode,
      systemPrompt: systemPromptFor(spec),
      // Always said: omp would otherwise take a resumed chat's saved effort, not the default (high).
      thinking: spec.thinking ?? 'high',
      sessionDir: sessionDirOf(this.o.deps.dataDir, spec),
      resumeFile: this.threads.resumeFile(agentId),
      threadId: this.threads.current(agentId)?.id,
      hostTools: spec.roleId === ASSISTANT_ROLE ? LEAD_TOOLS : undefined,
      // helpers on other models (people on the scripted model run on its own agent dir, without helpers by model)
      extensionDir: resolved.demo ? undefined : this.#helperRoot,
      settingsOverlay: this.#settingsOverlay(spec, resolved.demo),
    };
  }

  /** omp settings of a lead (a --config overlay): goal turns go on by themselves over RPC too, and the job's advisor —
   *  always said explicitly, so a global omp config can't switch it on. Leads on the scripted model go without one
   *  (it doesn't speak the advisor protocol), and so does an advisor model that isn't connected. Others: no overlay. */
  #settingsOverlay(spec: ResidentSpec, demo: boolean): string | undefined {
    if (spec.kind !== 'resident' || spec.roleId !== ASSISTANT_ROLE) return undefined;
    const advisor = !demo && spec.advisorModel ? this.o.models.resolve(spec.advisorModel) : undefined;
    const on = !!advisor && !advisor.demo;
    const lines = ['goal:', '  continuationModes: [interactive, rpc]', 'advisor:', `  enabled: ${on}`];
    if (on) lines.push('modelRoles:', `  advisor: ${JSON.stringify(advisor.selector)}`);
    return `${lines.join('\n')}\n`;
  }

  /** Upsert every job's people; send home those whose job or team role is gone (unless a running workflow needs them). */
  #syncProject(project: Project, broadcast: boolean) {
    const jobs = this.o.deps.jobs.list(project.id);
    const keep = new Set<string>();
    for (const job of jobs) {
      const workflow = this.o.workflows.get(project.id, job.workflowId);
      for (const spec of residentsFor(project, job, workflow, jobs)) {
        keep.add(spec.agentId);
        // A standing person on a going run of the job's team keeps the run's version of their step (it may have been
        // changed for that run, or the workflow saved since): the engine set it, and it goes back at the run's end.
        const live = this.engine.runStepOf(spec.agentId);
        this.#upsertResident(live ? stepSpec(project, job, live, jobs) : spec, broadcast);
      }
    }
    for (const a of this.store.list()) {
      if (a.projectId !== project.id || a.kind === 'subagent' || keep.has(a.id)) continue;
      if (jobs.some((j) => j.id === a.jobId) && this.engine.inActiveRun(a.id)) continue;
      this.#retire(a.id);
    }
  }

  #upsertResident(spec: ResidentSpec, broadcast: boolean) {
    const before = this.#specs.get(spec.agentId);
    this.#specs.set(spec.agentId, spec);
    const prev = this.store.get(spec.agentId);
    let threadId = prev?.threadId;
    if (!this.threads.has(spec.agentId)) {
      const t = this.threads.attach({
        agentId: spec.agentId,
        transcriptDir: transcriptDirOf(this.o.deps.dataDir, spec),
        sessionDir: sessionDirOf(this.o.deps.dataDir, spec),
      });
      this.store.setTranscript(spec.agentId, t.items, !!prev);
      threadId = t.threadId;
    }
    const next = residentInfo(spec, this.o.models, prev, threadId);
    if (!prev) {
      const context = this.threads.context(spec.agentId); // last seen before omp (or RLT) stopped
      if (context) next.context = context;
      const goal = this.threads.goal(spec.agentId); // paused until omp is on the chat again (Resume)
      if (goal) next.goal = goal;
    }
    const account = this.#chatAccount(spec.agentId);
    if (account) next.account = account;
    else delete next.account;
    if (!prev || broadcast) this.store.upsert(next);
    // A lead's model or effort changed (update_job, the chat's chips): its live omp switches in place.
    if (before && spec.kind === 'resident' && (before.model !== spec.model || before.thinking !== spec.thinking)) void this.#retargetLive(spec.agentId);
  }

  /** Switch a lead's live omp to its job's model and effort now (AgentRuntime.retarget; otherwise at its next start). */
  async #retargetLive(agentId: string): Promise<void> {
    const rt = this.#runtimes.get(agentId);
    const next = this.#processSpec(agentId);
    if (rt && next) await rt.retarget(next).catch((err: unknown) => log('agents', `${agentId}: model switch failed: ${errorText(err)}`));
  }

  // ───────────────────────── accounts ─────────────────────────

  /** The OAuth provider a person's chat runs on, when it has an account to show: a lead or standing team member on a
   *  real model of a provider with signed-in OAuth accounts. */
  #accountProvider(agentId: string): string | undefined {
    const spec = this.#specs.get(agentId);
    if (!spec || modelOwner(spec) === 'run') return undefined;
    const resolved = this.o.models.resolve(spec.model);
    if (resolved.demo) return undefined;
    const provider = splitSelector(resolved.selector).provider;
    return OAUTH_PROVIDERS.includes(provider) && this.accountOrder.oauth(provider).length ? provider : undefined;
  }

  /** What omp should do for the person's current chat (AgentRuntime.syncAccount); null → nothing to manage. */
  #accountPlan(agentId: string): (AccountPlan & { read: boolean }) | null {
    const provider = this.#accountProvider(agentId);
    const st = provider ? this.threads.accountState(agentId) : undefined;
    if (!provider || !st) return null;
    const book = this.accountOrder;
    const plan = accountPlan(provider, st.picks, st.pinned, (p, pick) => book.pickOf(p, pick), (p, id) => book.signedIn(p, id));
    const many = book.oauth(provider).length >= 2;
    return many || plan.drop || plan.credentialId !== null ? { ...plan, read: many } : null;
  }

  /** AgentInfo.account of the person's current chat (undefined: none to show). */
  #chatAccount(agentId: string): ChatAccount | undefined {
    const provider = this.#accountProvider(agentId);
    const st = provider ? this.threads.accountState(agentId) : undefined;
    if (!provider || !st) return undefined;
    const book = this.accountOrder;
    const drop = accountPlan(provider, st.picks, st.pinned, (p, pick) => book.pickOf(p, pick), (p, id) => book.signedIn(p, id)).drop;
    return chatAccountOf(provider, book.oauth(provider), book.pickOf(provider, st.picks?.[provider]), st.pinned, st.seen?.[provider], drop);
  }

  /** Work out AgentInfo.account again (everyone, or `ids`) and tell the clients what changed. */
  #refreshChatAccounts(ids?: string[]): void {
    if (this.#closed) return;
    for (const a of this.store.list()) {
      if (a.kind === 'subagent' || (ids && !ids.includes(a.id))) continue;
      this.store.patch(a.id, { account: this.#chatAccount(a.id) }, true);
    }
  }

  /** The order as the clients show it: every provider's accounts, their limits and how many chats are on each. */
  #accountOrderView(usage: UsageSnapshot | null | undefined): AccountOrder {
    const people = this.store.list();
    return this.accountOrder.view(usage, (provider, id) => people.filter((a) => a.account?.provider === provider && a.account.credentialId === id).length);
  }

  /** The signed-in accounts or the order changed: people's account chips, the clients' order, and live idle chats that
   *  must move (a dropped pick is forked away now; busy or stopped ones before their next message). */
  #accountsChanged(): void {
    if (this.#closed) return;
    this.#refreshChatAccounts();
    this.o.deps.hub.broadcast({ t: 'account_order', order: this.#accountOrderView(this.accounts.lastUsage()?.snapshot) });
    for (const [id, rt] of this.#runtimes) if (!rt.retired && this.#accountPlan(id)) void rt.syncAccount();
  }

  /** set_chat_account: a chat's own account of a provider (null → it follows the order again). Returns whether omp
   *  isn't on it yet (it moves after this turn, before the chat's next message, or once its model is on that provider). */
  async #setChatAccount(agentId: string, threadId: string | undefined, provider: string, credentialId: number | null): Promise<boolean> {
    const agent = this.store.get(agentId);
    if (!agent) throw new EngineError('That person is not home any more.');
    if (agent.kind === 'subagent') throw new EngineError('Helpers use the account of the person who sent them.');
    const spec = this.#specs.get(agentId);
    if (spec && modelOwner(spec) === 'run') throw new EngineError(`${agent.name} is only on this run's team — their account follows the order.`);
    const rt = this.#runtime(agentId);
    const thread = threadId ? this.threads.get(agentId, threadId) : this.threads.current(agentId);
    if (!rt || !thread) throw new EngineError(rt ? 'That chat no longer exists.' : 'That person is not home any more.');
    if (!OAUTH_PROVIDERS.includes(provider)) throw new EngineError('Only Claude, ChatGPT and Google sign-ins can be picked for a chat — an API key is a single account.');
    const book = this.accountOrder;
    if (credentialId !== null && !book.signedIn(provider, credentialId)) await book.refresh();
    if (credentialId !== null && !book.signedIn(provider, credentialId)) throw new EngineError('That account is no longer signed in.');
    this.threads.setPick(agentId, thread.id, provider, credentialId === null ? null : { credentialId, at: Math.max(Date.now(), book.resetAt(provider) + 1) });
    log('agents', `${agentId}: chat ${thread.id} → ${credentialId === null ? 'follows the order' : `account #${credentialId}`} of ${provider}`);
    if (this.threads.isCurrent(agentId, thread.id)) await rt.syncAccount(); // now, when omp runs idle on it
    this.#refreshChatAccounts([agentId]);
    const st = this.threads.accountState(agentId, thread.id);
    const pick = book.pickOf(provider, st?.picks?.[provider]);
    const pin = st?.pinned?.[provider];
    return pick ? pin !== pick.credentialId : pin !== undefined && book.signedIn(provider, pin);
  }

  /** A person moves out: whatever waits on them settles, their omp (also one still booting) is stopped, chats stay
   *  on disk. Callers that must know the process is gone await pool.stop/stopWhere afterwards. */
  #retire(agentId: string) {
    this.plans.forget(agentId);
    clearTimeout(this.#flushRetry.get(agentId));
    this.#flushRetry.delete(agentId);
    this.approvals.dismissForAgent(agentId);
    this.subagents.removeForParent(agentId);
    const rt = this.#runtimes.get(agentId);
    rt?.retire();
    rt?.dispose();
    this.#runtimes.delete(agentId);
    void this.pool.stop(agentId);
    this.#specs.delete(agentId);
    this.store.transcript(agentId); // flush throttled stream items before the last save
    this.threads.detach(agentId);
    this.store.remove(agentId);
  }

  #ensureRole(project: Project, job: Job, step: WorkflowStep): AgentRuntime {
    const jobs = this.o.deps.jobs.list(project.id);
    const current = jobs.find((j) => j.id === job.id) ?? job; // the brief may have changed since the run started
    const spec = stepSpec(project, current, step, jobs);
    if (this.o.models.noteSelectors([step.model])) {
      this.#refreshModelFiles();
      this.#broadcastModels(); // the page lists the model now (its chips and pickers)
    }
    this.#upsertResident(spec, true);
    return this.#runtime(spec.agentId)!;
  }

  #approvalChanged(agentId: string) {
    this.#runtimes.get(agentId)?.render();
    this.engine.onApprovalChange(agentId);
  }

  #ompEnv(): OmpEnv {
    if (!this.o.ompEnv) throw new EngineError('This server can’t change the agent’s environment.');
    return this.o.ompEnv;
  }

  /** set_omp_env: a pasted API key is checked with its vendor first (refused when the vendor refuses it; saved
   *  unchecked, with a warning, when the vendor can't be asked). Saved → every client hears it; omp's environment
   *  changed → models re-detected now, idle omp processes restarted on their next message (ProcessPool.envGeneration). */
  async #setOmpEnv(patch: Partial<Record<OmpEnvKey, string | null>>, reqId: string, conn: ClientConn): Promise<void> {
    const env = this.#ompEnv();
    const warnings: string[] = [];
    const pasted = (Object.keys(API_KEYS) as ApiKeyName[]).filter((name) => typeof patch[name] === 'string');
    for (const name of pasted) {
      const check = await (this.o.checkKey ?? checkApiKey)(name, cleanOmpEnvValue(name, patch[name] ?? ''));
      if (!check.ok && check.rejected) throw new UserError(check.message);
      if (!check.ok) warnings.push(`${check.message} to check the key, so it was saved without a check. If ${API_KEYS[name].chats} chats fail with a key error, paste it again.`);
    }
    const warning = warnings.join(' ');
    const { saved, applied } = env.set(patch);
    const view = env.view();
    conn.send({ t: 'ack', reqId, ok: true, data: { ompEnv: view, ...(warning ? { warning } : {}) } });
    if (saved) this.o.deps.hub.broadcast({ t: 'omp_env', ompEnv: view });
    if (!applied || this.#closed) return;
    try {
      await this.#ompEnvChanged();
    } catch (err) {
      log('agents', `model reload after an agent environment change failed: ${errorText(err)}`);
      return;
    }
    for (const name of pasted) {
      const { vendor, label, maker } = API_KEYS[name];
      const n = this.o.models.models().filter((m) => m.available && m.vendor === vendor).length;
      conn.send({ t: 'toast', level: n ? 'success' : 'warn', text: n ? `${label} saved — ${n} ${maker} ${n === 1 ? 'model is' : 'models are'} ready.` : `${label} saved, but the agent lists no ${maker} models with it. Press Refresh in a moment, or check the key.` });
    }
  }

  #localServers(): LocalServers {
    if (!this.o.localServers) throw new EngineError('This server can’t change the agent’s model servers.');
    return this.o.localServers;
  }

  /** save/remove_local_server: models.yml changed by CAST (the credential watch leaves it to us), every client hears
   *  the new list, then the models are checked again — omp asks the servers for their models while listing them.
   *  `saved`: the server was saved (its models are counted in the toast), not removed. */
  async #changeLocalServers(reqId: string, conn: ClientConn, rawName: string, saved: boolean, change: (s: LocalServers) => LocalServer[]): Promise<void> {
    const store = this.#localServers();
    const name = rawName.trim().toLowerCase();
    this.#storeOps++;
    try {
      const servers = change(store);
      log('agents', `model server ${name} ${saved ? 'saved in' : 'removed from'} ${store.file}`);
      conn.send({ t: 'ack', reqId, ok: true, data: { servers } });
      this.o.deps.hub.broadcast({ t: 'local_servers', servers });
      if (this.#closed) return;
      // a check that started before the change read the old file: let it end, then check again
      if (this.o.models.checking) await this.o.models.detect();
      await this.#credentialsChanged();
    } finally {
      this.#storeOps--;
    }
    if (!saved) return;
    const n = this.o.models.models().filter((m) => m.available && splitSelector(m.id).provider === name).length;
    conn.send({ t: 'toast', level: n ? 'success' : 'warn', text: n ? `${name} saved — ${n} ${n === 1 ? 'model is' : 'models are'} ready.` : `${name} saved, but the agent lists no models from it yet. Check that the server runs, then press Refresh.` });
  }

  /** omp's extra environment changed: what it can reach may have too (a key added or removed). */
  async #ompEnvChanged(): Promise<void> {
    this.accounts.invalidateUsage();
    // A check that started before the change ran with the old environment: let it end, then check again.
    if (this.o.models.checking) await this.o.models.detect();
    await this.#reloadModels();
  }

  /** Refresh: config.json read again (an ompEnv edited by hand). The clients hear a changed view; a changed
   *  environment drops the cached limits, and the model fingerprint (OmpEnv.key) makes the check run again. */
  #reloadOmpEnv(): void {
    const env = this.o.ompEnv;
    if (!env) return;
    const { saved, applied } = env.reload();
    if (saved) this.o.deps.hub.broadcast({ t: 'omp_env', ompEnv: env.view() });
    if (applied) this.accounts.invalidateUsage();
  }

  /** The credential watch saw omp's sign-ins change outside CAST (`omp login …` in a terminal): models, accounts and
   *  limits are read again without a restart, and every client hears it ('models', 'account_order'; an open Models &
   *  providers page re-reads its accounts and limits on the 'models' push). */
  async #signInsChangedOutside(): Promise<void> {
    if (this.#closed) return;
    const real = () => this.o.models.models().filter((m) => m.available).length;
    const before = real();
    log('agents', "the agent's sign-ins changed outside CAST — checking models and accounts again");
    const n = await this.#credentialsChanged();
    if (this.#closed || n === before) return;
    const models = `${n} ${n === 1 ? 'model is' : 'models are'}`;
    if (n > before) this.toast('success', `New sign-in found (made outside CAST) — ${models} ready.`);
    else if (n > 0) this.toast('info', `A sign-in was removed outside CAST — ${n} ${n === 1 ? 'model' : 'models'} left.`);
    else this.toast('warn', 'The last sign-in was removed outside CAST — nobody can work until you connect an AI account again (Models & providers).');
  }

  /** omp's stored credentials changed (a sign-in or sign-out): limits are read again, models re-detected, the account
   *  order follows the accounts (`accounts`: the list as it is now, when known). */
  async #credentialsChanged(accounts?: ProviderAccount[]): Promise<number> {
    this.accounts.invalidateUsage();
    const n = await this.#reloadModels();
    if (accounts) await this.accountOrder.note(accounts);
    else void this.accountOrder.refresh();
    return n;
  }

  /** Re-detect credentialed models; people follow what it found. Returns how many models are connected. */
  async #reloadModels(): Promise<number> {
    await this.o.models.detect();
    this.#modelsChecked();
    return this.o.models.models().filter((m) => m.available).length;
  }

  /** A model check ended: the files omp reads, the app, and everyone's model (connected or not) follow its result. */
  #modelsChecked() {
    this.#followDefaultLead();
    this.#refreshModelFiles();
    this.#broadcastModels();
    for (const p of this.o.deps.city.get().projects) this.#syncProject(p, true);
    this.#flushWaiting(); // a lead whose model is connected now hears about the team runs it missed
  }

  /** The files omp reads about models: the helpers by model, and the scripted model's agent dir (CAST_MOCK_LLM only). */
  #refreshModelFiles() {
    if (this.o.demoAgentDir && this.o.mockPort !== undefined) writeDemoAgentDir(this.o.deps.dataDir, this.o.mockPort, this.o.models.demoCatalog());
    this.#helperRoot = this.#writeHelpers();
  }

  /** (Re)write the helpers by model when the connected models changed. Returns their extension root (undefined when
   *  it could never be written: people then start without helpers by model). */
  #writeHelpers(): string | undefined {
    const next = helperAgents(this.o.models.helperModels());
    if (this.#helperRoot && JSON.stringify(next) === JSON.stringify(this.#helpers)) return this.#helperRoot;
    this.#helpers = next;
    try {
      return writeHelperAgents(this.o.deps.dataDir, next);
    } catch (err) {
      log('agents', `could not write the helpers by model: ${errorText(err)}`);
      return this.#helperRoot;
    }
  }
}
