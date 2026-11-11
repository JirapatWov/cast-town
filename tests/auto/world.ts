import { tmpdir } from 'node:os';
// A small RLT world for server unit tests: real city/job/workflow stores and a real WorkflowEngine + PlanGate in
// temp dirs, with fake people (runtimes answer at once), fake git and fake models. Each house starts with the two old
// example teams (tests/legacy-examples.ts); with no model available the fake models act as the scripted test model.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentRuntime } from '../../server/agents/agent-runtime.ts';
import { AgentStore } from '../../server/agents/agent-store.ts';
import { runLeadTool, type LeadToolCall, type LeadToolDeps } from '../../server/agents/lead-tools.ts';
import { PlanGate } from '../../server/agents/plan-gate.ts';
import { agentIdFor } from '../../server/data-layout.ts';
import { WorkflowEngine } from '../../server/agents/workflow-engine.ts';
import { WorkflowStore } from '../../server/agents/workflow-store.ts';
import { createCityStore } from '../../server/city-store.ts';
import { createJobStore } from '../../server/job-store.ts';
import { LOTS } from '../../shared/city-layout.ts';
import type { ServerMsg, WorkflowRun, WorkflowStep } from '../../shared/protocol.ts';
import { giveExamples } from '../legacy-examples.ts';

export const OPUS = 'anthropic/claude-opus-5-5';
export const SONNET = 'anthropic/claude-sonnet-5-5';
export const GPT = 'openai/gpt-6.1-sol';
export const DEEPSEEK = 'deepseek/deepseek-v4-pro';
export const GEMINI = 'google/gemini-4-argon';
const CATALOG = [OPUS, SONNET, GPT, DEEPSEEK, GEMINI];

export function fakeModels(available: string[]) {
  return {
    available,
    models: () => CATALOG.map((id) => ({ id, label: id.split('/')[1]!, vendor: 'other' as const, available: available.includes(id) })),
    isAvailable: (s: string) => available.includes(s),
    anyAvailable: () => available.length > 0,
    // the scripted test model stands in while nothing is connected (as ModelRegistry with { scripted: true })
    demoActive: () => available.length === 0,
    state: 'ok' as const,
    label: (s: string) => `L(${s})`,
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const roots: string[] = [];
export function cleanup() {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
}

export interface World {
  root: string;
  hub: { broadcast(m: ServerMsg): void; clients(): never[]; sent: ServerMsg[] };
  city: ReturnType<typeof createCityStore>;
  jobs: ReturnType<typeof createJobStore>;
  workflows: WorkflowStore;
  store: AgentStore;
  engine: WorkflowEngine;
  gate: PlanGate;
  models: ReturnType<typeof fakeModels>;
  projectId: string;
  lead: string;
  waiting: Map<string, string | null>;
  ensured: string[]; // agentIds ensureRole was asked for
  ensuredSteps: WorkflowStep[]; // the steps ensureRole was asked for (as given)
  prompts: { agentId: string; text: string }[];
  finished: WorkflowRun[];
  left: WorkflowRun[];
  /** What the fake people answer (default: "done", reviews approve); a promise holds the step until it settles. */
  answer: (step: WorkflowStep, text: string) => string | Promise<string>;
  /** Notes steered into a working step (team_edit's note). */
  steered: { agentId: string; text: string; shown: string }[];
  /** The lead tools' deps, bound to a house (default: this world's “todo”) as agent-system binds them. */
  deps(over?: Partial<LeadToolDeps>, projectId?: string): LeadToolDeps;
  /** A lead tool call by the Main job's lead of “todo”. */
  call(tool: string, args: Record<string, unknown>, over?: Partial<LeadToolDeps>): Promise<{ text: string; isError?: boolean }>;
  /** The same by the lead of another house's job (a house added with addHouse). */
  callIn(where: { projectId: string; jobId?: string }, tool: string, args: Record<string, unknown>, over?: Partial<LeadToolDeps>): Promise<{ text: string; isError?: boolean }>;
  /** Another house in the same town (its Main job made), sharing the workflow store and the library. examples: false
   *  = it starts with no workflows (as a new house does), not with the two old example teams. */
  addHouse(name: string, opts?: { workflowId?: string | null; examples?: boolean }): string;
  until<T>(f: () => T, ms?: number): Promise<NonNullable<T>>;
  dispose(): void;
}

export function makeWorld(opts: { available?: string[]; workflowId?: string | null } = {}): World {
  const root = mkdtempSync(join(tmpdir(), 'cast-test-tmp-'));
  roots.push(root);
  const dataDir = join(root, 'data');
  const projectDir = join(root, 'ws', 'todo');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  const sent: ServerMsg[] = [];
  const hub = { broadcast: (m: ServerMsg) => void sent.push(m), clients: () => [] as never[], sent };
  const city = createCityStore(dataDir, join(root, 'ws'));
  const project = city.addProject({ name: 'todo', path: projectDir, lotId: LOTS[0]!.id, style: 'house', isGit: false, workflowId: opts.workflowId === undefined ? 'decode-implement-review' : opts.workflowId, approvalMode: 'write' });
  const jobs = createJobStore(dataDir, city);
  jobs.list(project.id); // the Main job
  const workflows = new WorkflowStore(dataDir);
  giveExamples(workflows, project.id); // a new house has none: these tests were written for the old example teams
  const store = new AgentStore(hub as never);
  const models = fakeModels(opts.available ?? []);
  const waiting = new Map<string, string | null>();
  const ensured: string[] = [];
  const ensuredSteps: WorkflowStep[] = [];
  const prompts: { agentId: string; text: string }[] = [];
  const finished: WorkflowRun[] = [];
  const left: WorkflowRun[] = [];
  const runtimes = new Map<string, AgentRuntime>();
  const working = new Set<string>();
  const steered: { agentId: string; text: string; shown: string }[] = [];
  const w = { steered, answer: (step: WorkflowStep, _text: string) => (step.kind === 'review' ? 'Fine.\n```json\n{"verdict":"approve","notes":""}\n```' : `${step.name} done`) } as World;

  const engine = new WorkflowEngine({
    hub: hub as never,
    city,
    jobs,
    git: { checkpoint: async () => null } as never,
    store,
    approvals: { pendingFor: () => [] } as never,
    subagents: { costFor: () => 0, activeFor: () => 0 } as never,
    gitRefresh: { refreshNow: async () => {} } as never,
    workflows,
    models,
    ensureRole(p, job, step) {
      const agentId = agentIdFor(p.id, job.id, step.id);
      ensured.push(agentId);
      ensuredSteps.push(structuredClone(step));
      store.upsert({ id: agentId, projectId: p.id, jobId: job.id, kind: 'role', name: step.name, roleId: step.id, model: step.model, modelLabel: step.model, vendor: 'other', demo: true, status: 'idle', activity: 'idle', appearance: { seed: 1, gender: 'f' } });
      let rt = runtimes.get(agentId);
      if (!rt) {
        rt = {
          agentId,
          busy: false,
          retired: false,
          get info() {
            return store.get(agentId);
          },
          newThread: async () => ({}),
          showHandoff() {},
          abort: async () => {},
          // workflow steps use ask() (the whole answer); prompt() is the chat's send
          ask: async (text: string) => {
            prompts.push({ agentId, text });
            working.add(agentId);
            await sleep(5);
            try {
              return { status: 'completed', text: await w.answer(step, text) };
            } finally {
              working.delete(agentId);
            }
          },
          canSteerStep: () => working.has(agentId),
          steerStep: (text: string, shown: string) => {
            steered.push({ agentId, text, shown });
            return `k${steered.length}`;
          },
          withdrawSteer: async () => false,
        } as unknown as AgentRuntime;
        runtimes.set(agentId, rt);
      }
      return rt;
    },
    onFinish: (run) => void finished.push(structuredClone(run)),
    onPeopleLeave: (run) => void left.push(structuredClone(run)),
    toast: () => {},
  });
  const gate = new PlanGate({ hub, store, jobs, city, models, waiting: (id, d) => void waiting.set(id, d) });
  const lead = agentIdFor(project.id, 'main', 'assistant');
  Object.assign(w, {
    root, hub, city, jobs, workflows, store, engine, gate, models, projectId: project.id, lead, waiting, ensured, ensuredSteps, prompts, finished, left,
    deps(over: Partial<LeadToolDeps> = {}, projectId = project.id): LeadToolDeps {
      return {
        engine,
        jobs,
        workflows,
        store,
        models,
        gate,
        houseWorkflowId: (pid: string) => city.project(pid)?.workflowId ?? null,
        started: (_runId: string, agentId: string) => gate.noteRun(agentId),
        stopped: () => {},
        // bound to the lead's house, as agent-system binds them
        saveWorkflow: (raw: unknown) => workflows.save(projectId, raw),
        deleteWorkflow: () => {
          throw new Error('not in this test');
        },
        assignTeam: async (pid: string, jid: string, wid: string | null) => jobs.update(pid, jid, { workflowId: wid }),
        usedBy: () => [],
        promoteWorkflow: (id: string, o: { replace?: boolean }) => workflows.promote(projectId, id, { house: city.project(projectId)?.name ?? projectId, replace: o.replace }),
        importWorkflow: (id: string, o: { replace?: boolean }) => workflows.importFromLibrary(projectId, id, o),
        ...over,
      };
    },
    call(tool: string, args: Record<string, unknown>, over: Partial<LeadToolDeps> = {}) {
      const c: LeadToolCall = { tool, args, agentId: lead, projectId: project.id, jobId: 'main', callId: `call-${Math.random()}` };
      return runLeadTool(c, w.deps(over));
    },
    callIn(where: { projectId: string; jobId?: string }, tool: string, args: Record<string, unknown>, over: Partial<LeadToolDeps> = {}) {
      const jobId = where.jobId ?? 'main';
      const c: LeadToolCall = { tool, args, agentId: agentIdFor(where.projectId, jobId, 'assistant'), projectId: where.projectId, jobId, callId: `call-${Math.random()}` };
      return runLeadTool(c, w.deps(over, where.projectId));
    },
    addHouse(name: string, o: { workflowId?: string | null; examples?: boolean } = {}): string {
      const dir = join(root, 'ws', name);
      mkdirSync(dir, { recursive: true });
      const p = city.addProject({ name, path: dir, lotId: city.freeLots()[0]!, style: 'house', isGit: false, workflowId: o.workflowId === undefined ? 'decode-implement-review' : o.workflowId, approvalMode: 'write' });
      jobs.list(p.id); // its Main job
      if (o.examples !== false) giveExamples(workflows, p.id);
      return p.id;
    },
    async until<T>(f: () => T, ms = 5000): Promise<NonNullable<T>> {
      const s = Date.now();
      while (Date.now() - s < ms) {
        const v = f();
        if (v) return v as NonNullable<T>;
        await sleep(10);
      }
      throw new Error('timeout');
    },
    dispose() {
      engine.dispose();
      store.dispose();
    },
  });
  return w;
}

/** Wait until a run is no longer going. */
export async function runEnd(w: World, runId: string, ms = 5000): Promise<WorkflowRun> {
  return w.until(() => {
    const r = w.engine.get(runId);
    return r && r.status !== 'running' && r.status !== 'waiting_approval' ? r : null;
  }, ms);
}
