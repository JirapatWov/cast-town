import { tmpdir } from 'node:os';
// Phase 3 world: a real WorkflowEngine (real city/job/workflow stores in temp dirs) whose people are controllable fakes —
// each prompt can be held open, answered, failed, or stopped (abort), and every prompt/abort is recorded with times.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentRuntime, PromptOutcome } from '../../server/agents/agent-runtime.ts';
import { AgentStore } from '../../server/agents/agent-store.ts';
import { WorkflowEngine } from '../../server/agents/workflow-engine.ts';
import { WorkflowStore } from '../../server/agents/workflow-store.ts';
import { createCityStore } from '../../server/city-store.ts';
import { agentIdFor } from '../../server/data-layout.ts';
import { createJobStore } from '../../server/job-store.ts';
import { LOTS } from '../../shared/city-layout.ts';
import type { ServerMsg, Workflow, WorkflowRun, WorkflowStep } from '../../shared/protocol.ts';

export const OPUS = 'anthropic/claude-opus-5-5';
export const GPT = 'openai/gpt-6.1-sol';
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const roots: string[] = [];
export function cleanup() {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
}

/** One prompt a fake person got. */
export interface Asked {
  agentId: string;
  step: string; // written step id (no x-)
  text: string;
  at: number;
  endedAt?: number;
  outcome?: PromptOutcome;
  /** Answer it now (when the step's behaviour holds it open). */
  answer(o: PromptOutcome | string): void;
}

/** What a person does with a prompt: return an outcome (after an optional delay), or 'hold' to answer by hand. */
export type Behaviour = (text: string, n: number) => PromptOutcome | string | 'hold' | Promise<PromptOutcome | string | 'hold'>;

export interface P3World {
  engine: WorkflowEngine;
  store: AgentStore;
  sent: ServerMsg[];
  projectId: string;
  projectPath: string;
  asked: Asked[];
  aborts: { agentId: string; at: number }[];
  pending: Map<string, number>; // agentId → pending approvals (onApprovalChange reads it)
  behave: Map<string, Behaviour>; // written step id → behaviour (default: "<id> done", reviews approve)
  start(steps: Partial<WorkflowStep>[], task?: string): Promise<WorkflowRun>;
  until<T>(f: () => T, ms?: number, what?: string): Promise<NonNullable<T>>;
  end(runId: string, ms?: number): Promise<WorkflowRun>;
  agentOf(step: string): string;
  promptsOf(step: string): Asked[];
  dispose(): void;
}

export const approve = (notes = '') => `Checked.\n\`\`\`json\n${JSON.stringify({ verdict: 'approve', notes })}\n\`\`\``;
export const revise = (notes: string) => `Not yet.\n\`\`\`json\n${JSON.stringify({ verdict: 'revise', notes })}\n\`\`\``;

export function step(id: string, over: Partial<WorkflowStep> = {}): Partial<WorkflowStep> {
  return { id, name: id.toUpperCase(), model: OPUS, kind: 'work', persona: `You are ${id}.`, instruction: `Task: {{task}}\nFrom {{prevName}}:\n{{prev}}{{feedback}}\nDir {{runDir}}`, ...over };
}

export function makeP3World(): P3World {
  const root = mkdtempSync(join(tmpdir(), 'cast-test-tmp-p3-'));
  roots.push(root);
  const dataDir = join(root, 'data');
  const projectPath = join(root, 'ws', 'proj');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(projectPath, { recursive: true });
  const sent: ServerMsg[] = [];
  const hub = { broadcast: (m: ServerMsg) => void sent.push(m), clients: () => [] as never[] };
  const city = createCityStore(dataDir, join(root, 'ws'));
  const project = city.addProject({ name: 'proj', path: projectPath, lotId: LOTS[0]!.id, style: 'house', isGit: false, workflowId: null, approvalMode: 'write' });
  const jobs = createJobStore(dataDir, city);
  jobs.list(project.id);
  const workflows = new WorkflowStore(dataDir);
  const store = new AgentStore(hub as never);
  const asked: Asked[] = [];
  const aborts: { agentId: string; at: number }[] = [];
  const pending = new Map<string, number>();
  const behave = new Map<string, Behaviour>();
  const runtimes = new Map<string, AgentRuntime>();
  const open = new Map<string, Asked>(); // agentId → the prompt still going

  const engine = new WorkflowEngine({
    hub: hub as never,
    city,
    jobs,
    git: { checkpoint: async () => null } as never,
    store,
    approvals: { pendingFor: (id: string) => Array(pending.get(id) ?? 0).fill({}) } as never,
    subagents: { costFor: () => 0, activeFor: () => 0 } as never,
    gitRefresh: { refreshNow: async () => {} } as never,
    workflows,
    // nothing connected: everyone is on the scripted test model (as ModelRegistry with { scripted: true })
    models: { anyAvailable: () => false, demoActive: () => true, isAvailable: () => false, models: () => [], label: (s: string) => s },
    ensureRole(p, job, s) {
      const agentId = agentIdFor(p.id, job.id, s.id);
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
            aborts.push({ agentId, at: Date.now() });
            await sleep(5);
            open.get(agentId)?.answer({ status: 'aborted', text: 'partial work', error: 'stopped' });
          },
          ask: (text: string) => // workflow steps use ask() (the whole answer)
            new Promise<PromptOutcome>((resolve) => {
              const a: Asked = {
                agentId,
                step: written,
                text,
                at: Date.now(),
                answer(o) {
                  if (a.outcome) return;
                  a.outcome = typeof o === 'string' ? { status: 'completed', text: o } : o;
                  a.endedAt = Date.now();
                  open.delete(agentId);
                  resolve(a.outcome);
                },
              };
              asked.push(a);
              open.set(agentId, a);
              const b = behave.get(written) ?? ((_t: string) => (s.kind === 'review' ? approve() : `${written} done`));
              void Promise.resolve(b(text, ++n)).then(async (o) => {
                if (o === 'hold') return;
                await sleep(10);
                a.answer(o);
              });
            }),
        } as unknown as AgentRuntime;
        runtimes.set(agentId, rt);
      }
      return rt;
    },
    toast: () => {},
  });

  const w: P3World = {
    engine,
    store,
    sent,
    projectId: project.id,
    projectPath,
    asked,
    aborts,
    pending,
    behave,
    async start(steps, task = 'Do the thing') {
      const wf = { id: 'p3', name: 'P3 team', description: '', icon: '🧪', steps: steps as WorkflowStep[] } as Workflow;
      return engine.start(project.id, 'main', wf, task, { startedBy: 'user', adhoc: true });
    },
    async until<T>(f: () => T, ms = 5000, what = 'condition'): Promise<NonNullable<T>> {
      const s = Date.now();
      while (Date.now() - s < ms) {
        const v = f();
        if (v) return v as NonNullable<T>;
        await sleep(5);
      }
      throw new Error(`timeout: ${what}`);
    },
    end(runId, ms = 5000) {
      return w.until(() => {
        const r = engine.get(runId);
        return r && r.status !== 'running' && r.status !== 'waiting_approval' ? r : null;
      }, ms, 'run end');
    },
    agentOf: (s) => agentIdFor(project.id, 'main', `x-${s}`),
    promptsOf: (s) => asked.filter((a) => a.step === s),
    dispose() {
      engine.dispose();
      store.dispose();
    },
  };
  return w;
}
