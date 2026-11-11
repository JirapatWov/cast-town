// House + people dev harness: a fake project with 4 residents + 2 helpers, a fake diff on the TV and a
// pipeline on the corkboard. Buttons / keys cycle activities, trigger handoffs and speech bubbles.
// URL params: ?az=28&el=47&dist=19.5&tx=0&tz=0 (camera), ?scene=lineup (character lineup), ?noao,
// ?engine=real (the app's engine instead of the stub), ?sim=6 (fast-forward the simulation before showing)
// window.__house: setActivity(role, act), sim(seconds, hz?), probe() (what each person does), showFloor(n), only([names])
import type { Activity, AgentInfo, ApprovalRequest, GitSummary, Job, JobKind, Project, Workflow, WorkflowRun } from '../../shared/protocol';
import type { AppContext, Bus, BusEvents, Engine, Store } from '../src/core/types';
import { createEngine } from '../src/engine';
import { createHouseView } from '../src/house';
import { createStubEngine } from './house-engine-stub';
import { FAKE_DIFF } from './house-fake-diff';

const params = new URLSearchParams(location.search);
const app = document.getElementById('app')!;
const logEl = document.getElementById('log')!;
const log = (s: string) => { logEl.textContent = `${s}\n${logEl.textContent}`.slice(0, 900); };

// ── fakes ──────────────────────────────────────────────────────────────────────────────────────
function createFakeBus(): Bus {
  const subs = new Map<string, Set<(p: unknown) => void>>();
  return {
    on(k, fn) {
      if (!subs.has(k)) subs.set(k, new Set());
      subs.get(k)!.add(fn as (p: unknown) => void);
      return () => subs.get(k)!.delete(fn as (p: unknown) => void);
    },
    emit<K extends keyof BusEvents>(k: K, p: BusEvents[K]) {
      log(`bus ${k} ${JSON.stringify(p)}`);
      subs.get(k)?.forEach((fn) => fn(p));
    },
  };
}

const project: Project = {
  id: 'p-todo', name: 'todo-api', path: '/home/you/CAST/todo-api', lotId: 'A-N3', style: 'house',
  isGit: true, workflowId: 'decode-implement-review', approvalMode: 'write', createdAt: Date.now(),
  floors: Number(params.get('floors') ?? 1),
};

// ?floors=3 builds upper floors; ?rooms=2A:code,2B:write,2C:research,2D:general,3A:empty… assigns job rooms
const job = (id: string, name: string, kind: JobKind, floor: number, slot: number, leadModel: string): Job =>
  ({ id, projectId: project.id, name, kind, room: { floor, slot }, leadModel, brief: '', workflowId: null, createdAt: 0 });
const jobs: Job[] = [job('main', 'Todo API', 'general', 0, 0, 'anthropic/claude-opus-5-5')];
const NAMES: Record<JobKind, string> = { code: 'Reader website', write: 'Write the novel', research: 'Market research', general: 'Planning' };
const MODELS = ['deepseek/deepseek-chat', 'anthropic/claude-opus-5-5', 'google/gemini-2.5-pro', 'openai/gpt-5'];
for (const [i, spec] of (params.get('rooms') ?? (project.floors > 1 ? '2A:code,2B:write,2C:research,2D:general' : '')).split(',').filter(Boolean).entries()) {
  const [code, kind] = spec.split(':');
  if (kind === 'empty') continue;
  jobs.push(job(`j${i}`, NAMES[kind as JobKind] ?? kind, kind as JobKind, Number(code[0]) - 1, 'ABCD'.indexOf(code[1]), MODELS[i % MODELS.length]));
}

function agent(role: string, name: string, model: string, modelLabel: string, vendor: AgentInfo['vendor'], gender: 'm' | 'f', seed: number,
  activity: Activity, extra: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id: `${project.id}:${role}`, projectId: project.id, kind: 'role', name, roleId: role, model, modelLabel, vendor,
    demo: false, status: activity === 'idle' ? 'idle' : 'busy', activity, appearance: { seed, gender }, ...extra,
  };
}

const agents: Record<string, AgentInfo> = {};
function put(a: AgentInfo) { agents[a.id] = a; }
put(agent('decoder', 'Decoder', 'anthropic/claude-opus-5-5', 'Claude Opus 5.5', 'anthropic', 'f', 11, 'writing', { detail: 'Writing analysis.md', tool: 'write' }));
put(agent('implementer', 'Implementer', 'deepseek/deepseek-v4-pro', 'DeepSeek V4 Pro', 'deepseek', 'm', 22, 'reading', { detail: 'Reading src/todos.ts', tool: 'read' }));
put(agent('reviewer', 'Reviewer', 'openai/gpt-6.1-sol', 'GPT-6.1 Sol', 'openai', 'm', 33, 'waiting_approval', { detail: 'bash: git diff --stat', tool: 'bash' }));
put({ ...agent('assistant', 'Assistant', 'google/gemini-4-argon', 'Gemini 4 Argon', 'google', 'f', 44, 'idle'), kind: 'resident' });
put({ ...agent('sub:1', 'Explore helper', 'deepseek/deepseek-flash', 'DeepSeek Flash', 'deepseek', 'm', 55, 'chore'), kind: 'subagent', parentId: `${project.id}:decoder` });
put({ ...agent('sub:2', 'Test helper', 'anthropic/claude-sonnet-5-5', 'Claude Sonnet 5.5', 'anthropic', 'f', 66, 'chore'), kind: 'subagent', parentId: `${project.id}:decoder` });

const approvals: Record<string, ApprovalRequest> = {
  ap1: { id: 'ap1', agentId: `${project.id}:reviewer`, projectId: project.id, tool: 'bash', title: 'Allow tool: bash', detail: 'git diff --stat', options: ['Approve', 'Deny'], ts: Date.now() },
};

const workflow: Workflow = {
  id: 'decode-implement-review', name: 'Decode → Implement → Review', description: 'Analyze, build, review', icon: '🧩',
  steps: [
    { id: 'decoder', name: 'Decoder', model: 'anthropic/claude-opus-5-5', persona: '', instruction: '', kind: 'work' },
    { id: 'implementer', name: 'Implementer', model: 'deepseek/deepseek-v4-pro', persona: '', instruction: '', kind: 'work' },
    { id: 'reviewer', name: 'Reviewer', model: 'openai/gpt-6.1-sol', persona: '', instruction: '', kind: 'review', loopBackTo: 'implementer', maxLoops: 2 },
  ],
};
const run: WorkflowRun = {
  id: 'run-1', workflowId: workflow.id, workflowName: workflow.name, projectId: project.id,
  task: 'Add "mark as done" endpoint with input validation', status: 'waiting_approval', currentStepId: 'reviewer', loop: 1,
  steps: [
    { stepId: 'decoder', status: 'done', agentId: `${project.id}:decoder`, startedAt: Date.now() - 300000, endedAt: Date.now() - 240000 },
    { stepId: 'implementer', status: 'done', agentId: `${project.id}:implementer`, startedAt: Date.now() - 240000, endedAt: Date.now() - 180000 },
    { stepId: 'reviewer', status: 'done', agentId: `${project.id}:reviewer`, verdict: 'revise', startedAt: Date.now() - 180000, endedAt: Date.now() - 150000 },
    { stepId: 'implementer', status: 'done', agentId: `${project.id}:implementer`, startedAt: Date.now() - 150000, endedAt: Date.now() - 60000 },
    { stepId: 'reviewer', status: 'running', agentId: `${project.id}:reviewer`, startedAt: Date.now() - 60000 },
  ],
  startedAt: Date.now() - 300000, costUsd: 0.42, checkpoint: 'refs/rlt/checkpoints/run-1',
};
const git: GitSummary = {
  projectId: project.id, isGit: true, branch: 'main', ts: Date.now(), diff: FAKE_DIFF,
  files: [
    { path: 'src/todos.ts', status: 'M', additions: 24, deletions: 3 },
    { path: 'src/server.ts', status: 'M', additions: 11, deletions: 2 },
    { path: 'test/todos.test.ts', status: '??', additions: 38, deletions: 0 },
  ],
};

// ── boot ───────────────────────────────────────────────────────────────────────────────────────
const engine = withSimulate(params.get('engine') === 'real' ? await createEngine(app) : createStubEngine(app, { ao: !params.has('noao') }));
const bus = createFakeBus();
const store = { state: { agents, approvals }, subscribe: () => () => {}, send: () => {}, activeJob: () => jobs[0], jobsOf: () => jobs } as unknown as Store;
const ctx: AppContext = { engine, store, bus };
const house = createHouseView(ctx);
(window as unknown as { __house: unknown }).__house = {
  house, agents, approvals, sync, setActivity, sim: (s: number, hz?: number) => engine.simulate(s, hz), probe,
  showFloor: (n: number) => house.showFloor(n),
  /** Hide everyone but `names` (screenshots of one person). */
  only: (names: string[]) => { for (const p of peopleOf()) p.group.visible = names.includes(p.agent.name); },
};

// dev probe: what each person is doing (private Person fields read on purpose)
interface ProbePerson {
  id: string; agent: AgentInfo; desired: Activity; current: Activity | null; seated: boolean; group: { visible: boolean; position: { x: number; z: number } };
  step?: { name: string } | null; seat?: { sitting: boolean } | null;
  slot?: { id: string; kind: string; owner?: string | null; room?: number } | null;
  anim: { current: string | null };
  arms: { typing: { target: number }; mouse: { target: number }; raise: { target: number; weight: number } };
  laptop?: { visible: boolean } | null;
}
function peopleOf(): ProbePerson[] {
  const pm = house.dev.people() as { people: Map<string, ProbePerson> } | undefined;
  return pm ? [...pm.people.values()] : [];
}
function probe() {
  return peopleOf().map((p) => ({
    name: p.agent.name, desired: p.desired, current: p.current, step: p.step?.name ?? null, seated: p.seated, sitting: !!p.seat?.sitting,
    slot: p.slot ? `${p.slot.kind}:${p.slot.id}${p.slot.room === undefined ? '' : `@${p.slot.room}`}` : null, owner: p.slot?.owner ?? null, mine: p.slot?.owner === p.id,
    x: +p.group.position.x.toFixed(3), z: +p.group.position.z.toFixed(3), clip: p.anim.current,
    typing: p.arms.typing.target, mouse: p.arms.mouse.target, raise: p.arms.raise.target, laptop: !!p.laptop?.visible,
  }));
}

function sync() { house.syncAgents(Object.values(agents), Object.values(approvals)); }
function setActivity(role: string, activity: Activity, detail?: string) {
  const id = `${project.id}:${role}`;
  const a = agents[id];
  if (!a) return;
  agents[id] = { ...a, activity, detail, status: activity === 'idle' ? 'idle' : activity === 'error' ? 'error' : 'busy' };
  // approvals drive waiting_approval in the house: keep them in sync with the button pressed
  for (const ap of Object.values(approvals)) if (ap.agentId === id && activity !== 'waiting_approval') delete approvals[ap.id];
  if (activity === 'waiting_approval') {
    approvals[`ap-${role}`] = { id: `ap-${role}`, agentId: id, projectId: project.id, tool: 'bash', title: 'Allow tool: bash', detail: 'npm test', options: ['Approve', 'Deny'], ts: Date.now() };
  }
  sync();
  log(`${a.name} → ${activity}`);
}

const ACTIVITIES: Activity[] = ['idle', 'listening', 'thinking', 'reading', 'writing', 'running', 'searching', 'delegating', 'waiting_approval', 'error', 'done'];

function devPanel() {
  const dev = document.getElementById('dev')!;
  for (const a of Object.values(agents).filter((x) => x.kind !== 'subagent')) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<span class="lbl">${a.name}</span>`;
    for (const act of ACTIVITIES) {
      const b = document.createElement('button');
      b.textContent = act.replace('waiting_approval', 'approval');
      b.onclick = () => setActivity(a.roleId, act, `${act} (dev)`);
      row.appendChild(b);
    }
    dev.appendChild(row);
  }
  const row = document.createElement('div');
  row.className = 'row';
  const btn = (label: string, fn: () => void) => { const b = document.createElement('button'); b.textContent = label; b.onclick = fn; row.appendChild(b); };
  btn('handoff D→I (h)', () => house.handoff(`${project.id}:decoder`, `${project.id}:implementer`, 'analysis.md'));
  btn('handoff I→R', () => house.handoff(`${project.id}:implementer`, `${project.id}:reviewer`, 'patch'));
  btn('say (s)', () => house.say(`${project.id}:decoder`, 'I found the missing "mark done" route — drafting the plan now.', 4000));
  btn('add helper', () => {
    const n = Object.keys(agents).length + 1;
    put({ ...agent(`sub:${n}`, `Helper ${n}`, 'deepseek/deepseek-flash', 'DeepSeek Flash', 'deepseek', n % 2 ? 'm' : 'f', n * 7, 'chore'), kind: 'subagent' });
    sync();
  });
  btn('remove helpers', () => { for (const id of Object.keys(agents)) if (agents[id].kind === 'subagent') delete agents[id]; sync(); });
  btn('clear TV', () => house.setTV(null));
  btn('TV diff', () => house.setTV(git));
  dev.appendChild(row);
  addEventListener('keydown', (e) => {
    if (e.key === 'h') house.handoff(`${project.id}:decoder`, `${project.id}:implementer`, 'analysis.md');
    if (e.key === 's') house.say(`${project.id}:decoder`, 'On it — reading the routes first.', 3500);
  });
}

/** Dev: fast-forward every frame callback without rendering (headless WebGL renders are slow). */
function withSimulate(e: Engine): Engine & { simulate(seconds: number, hz?: number): void } {
  const fns = new Set<(dt: number, elapsed: number) => void>();
  const onFrame = e.onFrame.bind(e);
  let elapsed = 0;
  e.onFrame = (fn) => {
    fns.add(fn);
    const off = onFrame(fn);
    return () => { fns.delete(fn); off(); };
  };
  return Object.assign(e, {
    /** `hz`: simulated frame rate (default 30; e.g. 120 checks frame-rate independence). */
    simulate(seconds: number, hz = 30) {
      for (let t = 0, step = 1 / hz; t < seconds - 1e-9; t += step) { elapsed += step; for (const fn of fns) fn(step, elapsed); }
    },
  });
}

async function main() {
  const t0 = performance.now();
  await house.init();
  await house.enter(project);
  house.setTV(git);
  house.syncPlan(project, jobs);
  for (const j of jobs) house.setRunBoard(j.id, run, workflow);
  if (params.get('floor')) await house.showFloor(Number(params.get('floor')));
  if (params.get('scene') === 'lineup') {
    const { showLineup } = await import('./house-lineup');
    (window as unknown as { __lineup: unknown }).__lineup = await showLineup(engine, house.scene, params);
  } else {
    sync();
  }
  if (params.has('sim')) engine.simulate(+(params.get('sim') ?? 5));
  const dev = (house as unknown as { dev?: { orbit(a: number, e: number, d: number, t?: { x: number; y: number; z: number }): void } }).dev;
  if (params.has('az') && dev) {
    dev.orbit(+(params.get('az') ?? 28), +(params.get('el') ?? 47), +(params.get('dist') ?? 19.5),
      { x: +(params.get('tx') ?? 0.2), y: +(params.get('ty') ?? 0.6), z: +(params.get('tz') ?? -0.6) });
  }
  if (!params.has('nopanel')) devPanel();
  else document.getElementById('dev')!.remove();
  log(`ready in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  let frames = 0;
  engine.onFrame(() => { if (++frames === 4) (window as unknown as { __ready: boolean }).__ready = true; });
}
main().catch((e) => { console.error(e); log(String(e)); });
