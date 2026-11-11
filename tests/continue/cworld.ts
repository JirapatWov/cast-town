import { tmpdir } from 'node:os';
// Continue-a-run world: a real WorkflowEngine (real city/job/workflow stores in temp dirs) whose people are
// controllable fakes (like auto/server-tests/p3-world.ts), plus a git fake that records checkpoints / undoRun, fake
// models, the people ensureRole moved in (in order), and a second engine on the same folders (loadHistory after a
// "restart").
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentRuntime, PromptOutcome } from '../../server/agents/agent-runtime.ts';
import { AgentStore } from '../../server/agents/agent-store.ts';
import { WorkflowEngine, type EngineDeps } from '../../server/agents/workflow-engine.ts';
import { WorkflowStore } from '../../server/agents/workflow-store.ts';
import { createCityStore } from '../../server/city-store.ts';
import { agentIdFor } from '../../server/data-layout.ts';
import { createJobStore } from '../../server/job-store.ts';
import { LOTS } from '../../shared/city-layout.ts';
import type { Project, ServerMsg, Workflow, WorkflowRun, WorkflowStep } from '../../shared/protocol.ts';
import { giveExamples } from '../legacy-examples.ts';

export const OPUS = 'anthropic/claude-opus-5-5';
export const GPT = 'openai/gpt-6.1-sol';
export const DEEPSEEK = 'deepseek/deepseek-v4-pro';
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const roots: string[] = [];
export function cleanup() {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
}

export interface Asked {
  agentId: string;
  step: string; // written step id (no x-)
  text: string;
  runId?: string;
  at: number;
  outcome?: PromptOutcome;
  answer(o: PromptOutcome | string): void;
}

export type Behaviour = (text: string, n: number) => PromptOutcome | string | 'hold' | Promise<PromptOutcome | string | 'hold'>;

export const approve = (notes = '') => `Checked.\n\`\`\`json\n${JSON.stringify({ verdict: 'approve', notes })}\n\`\`\``;
export const revise = (notes: string) => `Not yet.\n\`\`\`json\n${JSON.stringify({ verdict: 'revise', notes })}\n\`\`\``;

export function step(id: string, over: Partial<WorkflowStep> = {}): WorkflowStep {
  return { id, name: id.toUpperCase(), model: OPUS, kind: 'work', persona: `You are ${id}.`, instruction: `Task: {{task}}\nFrom {{prevName}}:\n{{prev}}{{feedback}}\nDir {{runDir}}`, ...over } as WorkflowStep;
}

export interface CWorldOpts {
  git?: boolean; // checkpoint returns a ref (default true)
  available?: string[]; // connected models (default none: the scripted test model stands in)
  workflowId?: string | null; // the house's team
}

export function makeCWorld(opts: CWorldOpts = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cast-test-tmp-'));
  roots.push(root);
  const dataDir = join(root, 'data');
  const projectPath = join(root, 'ws', 'proj');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(projectPath, { recursive: true });
  const sent: ServerMsg[] = [];
  const hub = { broadcast: (m: ServerMsg) => void sent.push(m), clients: () => [] as never[] };
  const city = createCityStore(dataDir, join(root, 'ws'));
  const project = city.addProject({ name: 'proj', path: projectPath, lotId: LOTS[0]!.id, style: 'house', isGit: false, workflowId: opts.workflowId ?? null, approvalMode: 'write' });
  const jobs = createJobStore(dataDir, city);
  jobs.list(project.id);
  const workflows = new WorkflowStore(dataDir);
  giveExamples(workflows, project.id); // a new house has none: these tests were written for the old example teams
  const store = new AgentStore(hub as never);
  const asked: Asked[] = [];
  const ensured: string[] = [];
  const checkpoints: string[] = [];
  const undoRuns: { from: string; to: string }[] = [];
  const behave = new Map<string, Behaviour>();
  const runtimes = new Map<string, AgentRuntime>();
  const open = new Map<string, Asked>();
  const finished: WorkflowRun[] = [];
  const toasts: string[] = [];
  /** Notes steered into a step's turn (WorkflowEngine.editRun → steerStep), and which were taken back. */
  const steered: { agentId: string; step: string; text: string; shown: string; key: string }[] = [];
  const withdrawn: string[] = [];
  const left: WorkflowRun[] = [];
  const available = opts.available ?? [];
  const models = {
    anyAvailable: () => available.length > 0,
    demoActive: () => available.length === 0, // as ModelRegistry with { scripted: true }
    isAvailable: (s: string) => available.includes(s),
    models: () => [OPUS, GPT, DEEPSEEK].map((id) => ({ id, label: id.split('/')[1]!, vendor: 'other' as const, available: available.includes(id) })),
    label: (s: string) => `L(${s})`,
  };
  const git = {
    checkpoint: async (_p: Project, runId: string) => {
      checkpoints.push(runId);
      return opts.git === false ? null : `refs/rlt/checkpoints/${runId}`;
    },
    undoRun: async (_p: Project, from: string, to: string) => {
      undoRuns.push({ from, to });
      return { restored: ['a.txt'], kept: [] };
    },
  };

  function ensureRole(p: Project, job: { id: string }, s: WorkflowStep): AgentRuntime {
    const agentId = agentIdFor(p.id, job.id, s.id);
    ensured.push(agentId);
    store.upsert({ id: agentId, projectId: p.id, jobId: job.id, kind: 'role', name: s.name, roleId: s.id, model: s.model, modelLabel: s.model, vendor: 'other', demo: true, status: 'idle', activity: 'idle', appearance: { seed: 1, gender: 'f' } });
    let rt = runtimes.get(agentId);
    if (!rt) {
      const written = s.id.replace(/^x-/, '');
      let n = 0;
      rt = {
        agentId,
        get busy() {
          return open.has(agentId);
        },
        retired: false,
        get info() {
          return store.get(agentId);
        },
        newThread: async () => ({}),
        showHandoff() {},
        abort: async () => {
          await sleep(5);
          open.get(agentId)?.answer({ status: 'aborted', text: 'partial work', error: 'stopped' });
        },
        // a note reaches them only mid-turn (asked, not answered yet)
        canSteerStep: () => open.has(agentId),
        steerStep(text: string, shown: string) {
          if (!open.has(agentId)) return null;
          const key = `k${steered.length + 1}`;
          steered.push({ agentId, step: written, text, shown, key });
          return key;
        },
        withdrawSteer: async (key: string) => {
          withdrawn.push(key);
          return false;
        },
        ask: (text: string) =>
          new Promise<PromptOutcome>((resolve) => {
            const runId = engine.runAt(agentId)?.id; // the run whose group this person works in now
            const a: Asked = {
              agentId,
              step: written,
              text,
              runId,
              at: Date.now(),
              answer(o) {
                if (a.outcome) return;
                a.outcome = typeof o === 'string' ? { status: 'completed', text: o } : o;
                open.delete(agentId);
                resolve(a.outcome);
              },
            };
            asked.push(a);
            open.set(agentId, a);
            const b = behave.get(written) ?? ((_t: string) => (s.kind === 'review' ? approve() : `${written} done`));
            void Promise.resolve(b(text, ++n)).then(async (o) => {
              if (o === 'hold') return;
              await sleep(5);
              a.answer(o);
            });
          }),
      } as unknown as AgentRuntime;
      runtimes.set(agentId, rt);
    }
    return rt;
  }

  const deps: EngineDeps = {
    hub: hub as never,
    city,
    jobs,
    git: git as never,
    store,
    approvals: { pendingFor: () => [] } as never,
    subagents: { costFor: () => 0, activeFor: () => 0 } as never,
    gitRefresh: { refreshNow: async () => {} } as never,
    workflows,
    models,
    ensureRole: ensureRole as never,
    onFinish: (run) => void finished.push(structuredClone(run)),
    onPeopleLeave: (run) => void left.push(structuredClone(run)),
    toast: (_l, t) => void toasts.push(t),
  };
  let engine = new WorkflowEngine(deps);

  const w = {
    root,
    dataDir,
    get engine() {
      return engine;
    },
    store,
    city,
    jobs,
    workflows,
    sent,
    projectId: project.id,
    projectPath,
    asked,
    ensured,
    checkpoints,
    undoRuns,
    behave,
    finished,
    toasts,
    steered,
    withdrawn,
    left,
    available,
    /** A one-off team (temporary people). */
    start(steps: WorkflowStep[], task = 'Do the thing', name = 'P3 team'): Promise<WorkflowRun> {
      const wf = { id: 'p3', name, description: '', icon: '🧪', steps } as Workflow;
      return engine.start(project.id, 'main', wf, task, { startedBy: 'user', adhoc: true });
    },
    /** A saved workflow by id (the job's own team when it is the job's workflow). */
    startSaved(id: string, task = 'Do the thing'): Promise<WorkflowRun> {
      return engine.start(project.id, 'main', id, task, { startedBy: 'user' });
    },
    async until<T>(f: () => T, ms = 5000, what = 'condition'): Promise<NonNullable<T>> {
      const s = Date.now();
      while (Date.now() - s < ms) {
        const v = f();
        if (v) return v as NonNullable<T>;
        await sleep(3);
      }
      throw new Error(`timeout: ${what}`);
    },
    end(runId: string, ms = 5000): Promise<WorkflowRun> {
      return w.until(() => {
        const r = engine.get(runId);
        return r && r.status !== 'running' && r.status !== 'waiting_approval' ? r : null;
      }, ms, 'run end');
    },
    /** Wait for the end snapshot / undo.json of a run (written after the end). */
    async settled(runId: string) {
      await w.end(runId);
      await w.until(() => checkpoints.includes(`${runId}-end`) || opts.git === false, 3000, 'end snapshot');
      await sleep(20);
    },
    runDir: (runId: string) => join(projectPath, '.rlt/runs', runId),
    tempAgent: (s: string) => agentIdFor(project.id, 'main', `x-${s}`),
    agent: (s: string) => agentIdFor(project.id, 'main', s),
    promptsOf: (s: string, runId?: string) => asked.filter((a) => a.step === s && (!runId || a.runId === runId)),
    /** A new engine on the same folders (the server restarted): history comes back from run.json. */
    restart() {
      engine.dispose();
      engine = new WorkflowEngine(deps);
      engine.loadHistory(city.project(project.id)!);
      return engine;
    },
    dispose() {
      engine.dispose();
      store.dispose();
    },
  };
  return w;
}

export type CWorld = ReturnType<typeof makeCWorld>;
