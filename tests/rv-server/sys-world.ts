import { tmpdir } from 'node:os';
// A real AgentSystemImpl (real stores, PlanGate, WorkflowEngine, AgentRuntimes, HostToolQueue) whose omp processes are
// fakes: the pool's acquire/get/isStarting/stop are replaced, frames are injected through the pool's onFrame/onExit
// callbacks exactly like a live omp would deliver them. Boots can be held open to model omp's 2–6 s start.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AgentSystemImpl, type AgentSystemOptions } from '../../server/agents/agent-system.ts';
import { workflowUsers } from '../../server/agents/index.ts';
import { ModelRegistry } from '../../server/agents/models.ts';
import type { OmpHealth } from '../../server/agents/omp-health.ts';
import { StartCancelled, type ProcessSpec } from '../../server/agents/process-pool.ts';
import { WorkflowStore } from '../../server/agents/workflow-store.ts';
import { createCityStore, type CoreCityStore } from '../../server/city-store.ts';
import type { ClientConn, GitService } from '../../server/contracts.ts';
import { agentIdFor } from '../../server/data-layout.ts';
import { createJobStore, type CoreJobStore } from '../../server/job-store.ts';
import { LOTS } from '../../shared/city-layout.ts';
import type { ClientMsg, ServerMsg } from '../../shared/protocol.ts';
import { giveExamples } from '../legacy-examples.ts';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const roots: string[] = [];
export function cleanup() {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
}

export interface HostCall {
  id: string;
  tool: string;
  args: Record<string, unknown>;
}

export class FakeProc {
  alive = true;
  prompts: { id: string; message: string; at: number }[] = [];
  calls: { type: string; at: number }[] = [];
  hostResults: { id: string; text: string; isError?: boolean; at: number }[] = [];
  open = new Map<string, (f: unknown) => void>(); // prompt id → its prompt_result waiter
  openHost = new Set<string>(); // host tool calls omp is waiting on
  lastText = '';
  constructor(readonly agentId: string, readonly spec: ProcessSpec, private readonly w: SysWorld) {}
  async prompt(message: string, extra: Record<string, unknown> = {}) {
    const id = String(extra.id);
    this.prompts.push({ id, message, at: Date.now() });
    const result = new Promise((r) => this.open.set(id, r));
    this.w.onPrompt(this, id, message);
    return { result };
  }
  async call<T>(cmd: { type: string }): Promise<T> {
    this.calls.push({ type: cmd.type, at: Date.now() });
    if (cmd.type === 'get_subagents') return { subagents: [] } as T;
    if (cmd.type === 'get_last_assistant_text') return { text: this.lastText } as T;
    if (cmd.type === 'abort_and_restore_queue') {
      // like omp: an aborted host tool call is called off (host_tool_cancel), the turn ends aborted
      for (const h of [...this.openHost]) {
        this.openHost.delete(h);
        this.emit({ type: 'host_tool_cancel', id: `c-${h}`, targetId: h });
      }
      for (const id of [...this.open.keys()]) this.finish(id, 'aborted');
    }
    return {} as T;
  }
  respondHostTool(id: string, text: string, isError = false) {
    if (!this.alive) return;
    this.hostResults.push({ id, text, isError, at: Date.now() });
    this.openHost.delete(id);
  }
  respondUi() {}
  emit(f: Record<string, unknown>) {
    this.w.frame(this.agentId, f);
  }
  /** omp asks RLT to run a host tool (the lead's team tools). */
  hostCall(tool: string, args: Record<string, unknown>): HostCall {
    const id = `h${Math.random().toString(36).slice(2, 8)}`;
    this.openHost.add(id);
    this.emit({ type: 'host_tool_call', id, toolCallId: `tc-${id}`, toolName: tool, arguments: args });
    return { id, tool, args };
  }
  finish(id: string, status: 'completed' | 'aborted' | 'error' = 'completed', text = '') {
    this.lastText = text;
    this.open.delete(id);
    this.emit({ type: 'prompt_result', id, status, sessionSettled: true });
  }
}

export interface SysWorld {
  root: string;
  sys: AgentSystemImpl;
  city: CoreCityStore;
  jobs: CoreJobStore;
  sent: ServerMsg[];
  acks: Map<string, ServerMsg>;
  projectId: string;
  projectPath: string;
  lead: string;
  procs: Map<string, FakeProc>;
  /** Every proc ever started, in order (a restarted person gets a new one). */
  history: FakeProc[];
  /** agentId → a promise the boot waits for (omp starting). */
  bootGate: Map<string, Promise<void>>;
  /** agentId → the error its next boot fails with (omp didn't start). */
  bootFail: Map<string, Error>;
  /** Every spec acquire() was called with, in order. */
  specs: ProcessSpec[];
  /** What team members do with a prompt (default: answer "done" / approve after 10 ms). Return 'hold' to keep it open. */
  member: (p: FakeProc, id: string, message: string) => 'hold' | void;
  onPrompt(p: FakeProc, id: string, message: string): void;
  frame(agentId: string, f: Record<string, unknown>): void;
  exit(agentId: string, info: { code: number | null; signal: string | null; stderr: string; expected: boolean }): void;
  handle(msg: Record<string, unknown>): Promise<ServerMsg | undefined>;
  until<T>(f: () => T, ms?: number, what?: string): Promise<NonNullable<T>>;
  agentOf(roleId: string): string;
  dispose(): Promise<void>;
}

/** root: reuse that world's folders (a restart: same data dir, same house). models / health: instead of a registry that
 *  never checks anything. scripted (default true): that registry runs people on the scripted test model while nothing
 *  is connected (CAST_MOCK_LLM); false = the production default, nobody works without an AI account. extra: more
 *  AgentSystemImpl options (env, ompEnv, checkKey, localServers, …). git: a real GitService instead of the no-git stub.
 *  examples (default true): every house there is gets the two old example teams (tests/legacy-examples.ts); the
 *  house's team is the code one. false: only what workflows.json and the one-time move give (a new house has none). */
export function makeSys(opts: { workflowId?: string | null; root?: string; models?: ModelRegistry; scripted?: boolean; examples?: boolean; health?: OmpHealth; extra?: (dataDir: string) => Partial<AgentSystemOptions>; git?: GitService } = {}): SysWorld {
  const root = opts.root ?? mkdtempSync(join(tmpdir(), 'cast-test-tmp-'));
  if (!opts.root) roots.push(root);
  const dataDir = join(root, 'data');
  const projectPath = join(root, 'ws', 'proj');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(projectPath, { recursive: true });
  const sent: ServerMsg[] = [];
  const hub = { broadcast: (m: ServerMsg) => void sent.push(m), clients: () => [] as ClientConn[] };
  const city = createCityStore(dataDir, join(root, 'ws'));
  const project = city.get().projects[0] ?? city.addProject({ name: 'proj', path: projectPath, lotId: LOTS[0]!.id, style: 'house', isGit: false, workflowId: opts.workflowId === undefined ? 'decode-implement-review' : opts.workflowId, approvalMode: 'bypass' });
  const jobs = createJobStore(dataDir, city);
  jobs.list(project.id);
  // as the server builds it (an old workflows.json moves to the houses that use it: house-workflows.test.ts; the
  // one-time move gives a house using an old example team its own copy: legacy-examples-move.test.ts)
  const workflows = new WorkflowStore(dataDir, { migrate: workflowUsers({ city, jobs, dataDir }) });
  if (opts.examples !== false) for (const p of city.get().projects) giveExamples(workflows, p.id);
  // never detect(): nothing connected → every model runs on the scripted test model (the isolated-test setup), unless
  // scripted: false (the production default: nobody can work)
  const scripted = opts.scripted !== false;
  const models = opts.models ?? new ModelRegistry('/nonexistent/omp', { HOME: root }, { scripted });
  const git = opts.git ?? {
    isGit: async () => false,
    summary: async () => ({ projectId: project.id, isGit: false, branch: null, ahead: 0, behind: 0, dirty: 0, files: [] }),
    checkpoint: async () => null,
    revert: async () => {},
    undoRun: async () => ({ restored: [], kept: [] }),
  };
  const sys = new AgentSystemImpl({
    deps: { hub, city, jobs, git, dataDir } as never,
    models,
    workflows,
    ompBin: '/nonexistent/omp',
    ompVersion: 'test',
    health: opts.health,
    env: { HOME: root },
    ...(scripted ? { demoAgentDir: join(dataDir, 'omp-demo-agent'), mock: null, mockError: null, mockPort: 1 } : {}),
    ...opts.extra?.(dataDir),
  });
  const procs = new Map<string, FakeProc>();
  const history: FakeProc[] = [];
  const starting = new Set<string>();
  const bootGate = new Map<string, Promise<void>>();
  const bootFail = new Map<string, Error>();
  const cancels = new Map<string, (err: Error) => void>();
  const specs: ProcessSpec[] = [];
  const acks = new Map<string, ServerMsg>();
  const poolOpts = (sys.pool as unknown as { o: { onFrame(id: string, f: unknown): void; onExit(id: string, i: unknown): void } }).o;
  const pool = sys.pool as unknown as Record<string, unknown>;
  pool.acquire = async (spec: ProcessSpec) => {
    specs.push(spec);
    const cur = procs.get(spec.agentId);
    if (cur?.alive) return cur;
    starting.add(spec.agentId);
    try {
      // like the real pool: stop() during the boot calls it off (StartCancelled)
      const cancelled = new Promise<never>((_, reject) => cancels.set(spec.agentId, reject));
      const gate = bootGate.get(spec.agentId);
      await Promise.race([gate ?? sleep(1), cancelled]);
      const fail = bootFail.get(spec.agentId);
      if (fail) {
        bootFail.delete(spec.agentId);
        throw fail;
      }
    } finally {
      starting.delete(spec.agentId);
      cancels.delete(spec.agentId);
    }
    const p = new FakeProc(spec.agentId, spec, w);
    procs.set(spec.agentId, p);
    history.push(p);
    return p;
  };
  pool.get = (id: string) => {
    const p = procs.get(id);
    return p?.alive ? p : undefined;
  };
  pool.isStarting = (id: string) => starting.has(id);
  pool.stop = async (id: string) => {
    cancels.get(id)?.(new StartCancelled(id));
    const p = procs.get(id);
    if (!p) return;
    procs.delete(id);
    p.alive = false;
    poolOpts.onExit(id, { code: 0, signal: null, stderr: '', expected: true });
  };
  pool.stopWhere = async () => {};
  pool.shutdown = async () => {};
  pool.touch = () => {};

  const conn: ClientConn = { id: 'c1', user: 'local', send: (m) => { sent.push(m); if (m.t === 'ack') acks.set(m.reqId, m); } };
  let reqs = 0;
  const lead = agentIdFor(project.id, 'main', 'assistant');
  const w: SysWorld = {
    root,
    sys,
    city,
    jobs,
    sent,
    acks,
    projectId: project.id,
    projectPath,
    lead,
    procs,
    history,
    bootGate,
    bootFail,
    specs,
    member: (p, id) => {
      const review = p.spec.systemPrompt.includes('[rlt-step-kind:review]');
      setTimeout(() => p.alive && p.open.has(id) && p.finish(id, 'completed', review ? 'ok\n```json\n{"verdict":"approve","notes":""}\n```' : `${p.spec.roleId} done`), 10);
    },
    onPrompt(p, id, message) {
      if (p.agentId === lead) return; // the lead's turn stays open; tests drive its host tool calls
      w.member(p, id, message);
    },
    frame: (agentId, f) => poolOpts.onFrame(agentId, f),
    exit(agentId, info) {
      const p = procs.get(agentId);
      if (p) p.alive = false;
      procs.delete(agentId);
      poolOpts.onExit(agentId, info);
    },
    async handle(msg) {
      const reqId = `r${++reqs}`;
      await sys.handle({ ...msg, reqId } as unknown as ClientMsg, conn);
      return acks.get(reqId) ?? sent.filter((m) => m.t === 'toast').at(-1);
    },
    async until<T>(f: () => T, ms = 3000, what = 'condition'): Promise<NonNullable<T>> {
      const s = Date.now();
      while (Date.now() - s < ms) {
        const v = f();
        if (v) return v as NonNullable<T>;
        await sleep(5);
      }
      throw new Error(`timeout: ${what}`);
    },
    agentOf: (roleId) => agentIdFor(project.id, 'main', roleId),
    async dispose() {
      await sys.shutdown().catch(() => {});
    },
  };
  return w;
}
