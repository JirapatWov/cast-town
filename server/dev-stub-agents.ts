// Development stand-in for server/agents (enable with RLT_STUB_AGENTS=1). It implements AgentSystem with plain
// in-memory state so the core and the web UI can be exercised without omp: every job's people appear (lead +
// team), prompts get a canned reply (a "team"/"helpers" prompt also sends two helpers in for a few seconds), each
// person has chat threads with some fake history, and workflow runs play out with fake step outputs. Each house
// gets its own copies of two stub workflows when the stub first sees it, so the Workflow tab has something in it.
// Jobs and floors themselves are real: the core's JobStore/JobService handle them (persisted in jobs.json).
import type {
  AccountOrder, Activity, AgentInfo, ChatThread, Job, JobKind, LibraryWorkflow, ModelInfo, ModelOwner, OmpEnvView, Project, ProviderStatus,
  ThinkingLevel, TranscriptItem, Vendor, Workflow, WorkflowRun,
} from '../shared/protocol';
import type { AgentSnapshot, AgentSystem, AgentSystemDeps, ClientConn } from './contracts';
import { agentIdFor, MAIN_JOB_ID } from './data-layout';
import { UPLOAD_ID } from './uploads';
import { searchItems, snippetAt } from './agents/thread-search';

const MODELS: ModelInfo[] = [
  { id: 'anthropic/claude-opus-5-5', label: 'Claude Opus 5.5', vendor: 'anthropic', available: false },
  { id: 'anthropic/claude-sonnet-5-5', label: 'Claude Sonnet 5.5', vendor: 'anthropic', available: false },
  { id: 'openai/gpt-6.1-sol', label: 'GPT-6.1 Sol', vendor: 'openai', available: false },
  { id: 'openai/gpt-6.1-terra', label: 'GPT-6.1 Terra', vendor: 'openai', available: false },
  { id: 'deepseek/deepseek-v4-pro', label: 'DeepSeek V4 Pro', vendor: 'deepseek', available: false },
  { id: 'deepseek/deepseek-flash', label: 'DeepSeek Flash', vendor: 'deepseek', available: false },
  { id: 'google/gemini-4-argon', label: 'Gemini 4 Argon', vendor: 'google', available: false },
];

const PROVIDERS: ProviderStatus[] = [
  { vendor: 'anthropic', label: 'Anthropic', connected: false, how: 'export ANTHROPIC_API_KEY=… or `cast-agent login anthropic`' },
  { vendor: 'openai', label: 'OpenAI', connected: false, how: 'export OPENAI_API_KEY=… or `cast-agent login openai-codex`' },
  { vendor: 'deepseek', label: 'DeepSeek', connected: false, how: 'export DEEPSEEK_API_KEY=…' },
  { vendor: 'google', label: 'Google', connected: false, how: 'export GEMINI_API_KEY=…' },
];

const step = (id: string, name: string, model: string, kind: 'work' | 'review' = 'work', loopBackTo?: string) => ({
  id, name, model, kind, loopBackTo, persona: `You are the ${name}.`, instruction: '{{task}}\n\n{{prev}}',
});

/** What each house starts with here (copies: changing one changes only that house's). */
const STUB_WORKFLOWS: Workflow[] = [
  {
    id: 'decode-implement-review', name: 'Decode → Implement → Review', icon: '🧩',
    description: 'Opus analyses, DeepSeek builds, GPT reviews (loops back on "revise").',
    steps: [
      step('decoder', 'Decoder', 'anthropic/claude-opus-5-5'),
      step('implementer', 'Implementer', 'deepseek/deepseek-v4-pro'),
      step('reviewer', 'Reviewer', 'openai/gpt-6.1-sol', 'review', 'implementer'),
    ],
  },
  {
    id: 'novel', name: 'Idea → Write → Edit', icon: '📖',
    description: 'Gemini pitches ideas, Opus writes the chapter, GPT edits it.',
    steps: [
      step('idea-maker', 'Idea-maker', 'google/gemini-4-argon'),
      step('writer', 'Writer', 'anthropic/claude-opus-5-5'),
      step('editor', 'Editor', 'openai/gpt-6.1-sol', 'review', 'writer'),
    ],
  },
];

const LEAD_NAMES: Record<JobKind, string> = { general: 'Assistant', code: 'Developer', write: 'Writer', research: 'Researcher' };
const DEFAULT_LEAD = 'anthropic/claude-opus-5-5';
const STEP_MS = 3500;

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function vendorOf(model: string): Vendor {
  const v = model.split('/')[0] as Vendor;
  return ['anthropic', 'openai', 'deepseek', 'google', 'openrouter'].includes(v) ? v : 'other';
}

interface StubThread {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  items: TranscriptItem[];
}

let seq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}${(++seq).toString(36)}`;

/** A couple of older chats so the thread menu has something to show. */
function fakeHistory(agentId: string, a: Pick<AgentInfo, 'name' | 'kind'>, project: Project, job: Job): StubThread[] {
  const now = Date.now();
  const hour = 3_600_000;
  const chat = (title: string, ago: number, turns: [string, string][]): StubThread => {
    const id = uid('t');
    const items: TranscriptItem[] = [];
    let ts = now - ago;
    for (const [q, r] of turns) {
      items.push({ kind: 'user', id: uid(`${agentId}:u`), text: q, ts });
      ts += 40_000;
      items.push({ kind: 'tool', id: uid(`${agentId}:tool`), tool: 'read', title: 'read README.md', status: 'done', result: `# ${project.name}\n…`, ts });
      items.push({ kind: 'assistant', id: uid(`${agentId}:a`), text: r, ts: ts + 5000 });
      ts += 120_000;
    }
    return { id, title: title.slice(0, 60), createdAt: now - ago, updatedAt: ts, items };
  };
  if (a.kind === 'role') {
    return [chat(`Run · ${job.name}`, 26 * hour, [[`Task: tidy up ${project.name}`, `*(stub)* ${a.name} finished the step and handed it on.`]])];
  }
  const thai = /novel/.test(project.id) || /[฀-๿]/.test(job.name);
  return [
    chat(thai ? 'สรุปเรื่องย่อให้หน่อย' : `What does ${project.name} do?`, 50 * hour, [
      [thai ? 'สรุปเรื่องย่อให้หน่อย' : `What does ${project.name} do?`, thai ? '*(stub)* เรื่องย่อ: ร้านน้ำชาเล็ก ๆ ที่เปิดเฉพาะคืนพระจันทร์เต็มดวง…' : `*(stub)* It's a small project — see \`README.md\`.`],
      ['Thanks! Anything missing?', '*(stub)* A couple of TODOs in the README are still open.'],
    ]),
    chat(`Plan for “${job.name}”`, 5 * hour, [[`Make a plan for ${job.name}`, '*(stub)* 1. Read the code · 2. Make the change · 3. Test it.']]),
  ];
}

export async function createAgentSystem(deps: AgentSystemDeps): Promise<AgentSystem> {
  const { hub, city, jobs } = deps;
  jobs.setDefaultLeadModel(() => ({ model: DEFAULT_LEAD, connected: true }));
  const agents = new Map<string, AgentInfo>();
  const threads = new Map<string, { list: StubThread[]; current: string }>();
  const runs = new Map<string, WorkflowRun>();
  // Workflows as the real server keeps them: each house's own, and the shared library a house promotes into and
  // imports from (copies both ways).
  const houseOwn = new Map<string, Workflow[]>();
  const library: LibraryWorkflow[] = [];
  const own = (projectId: string) => houseOwn.get(projectId) ?? [];
  const workflowOf = (projectId: string, id: string | null | undefined) => (id ? own(projectId).find((w) => w.id === id) : undefined);
  const workflowLists = () => ({
    workflows: [] as Workflow[], // every workflow belongs to a house
    houseWorkflows: Object.fromEntries([...houseOwn].filter(([, l]) => l.length)),
    library,
  });
  const keepInHouse = (projectId: string, w: Workflow) => {
    const list = own(projectId);
    const i = list.findIndex((x) => x.id === w.id);
    houseOwn.set(projectId, i < 0 ? [...list, w] : list.map((x, j) => (j === i ? w : x)));
  };
  /** A house the stub hasn't seen since it started gets its own copies of the stub workflows. */
  const firstSight = (projectId: string) => {
    if (!houseOwn.has(projectId)) houseOwn.set(projectId, structuredClone(STUB_WORKFLOWS));
  };
  for (const p of city.get().projects) firstSight(p.id);
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let helperSeq = 0;

  const later = (ms: number, fn: () => void) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
  };

  function person(
    project: Project, job: Job, roleId: string, name: string, model: string, kind: AgentInfo['kind'], thinking: ThinkingLevel | undefined,
    modelBy: ModelOwner,
  ): AgentInfo {
    const id = agentIdFor(project.id, job.id, roleId);
    const h = hash(id);
    return {
      id, projectId: project.id, jobId: job.id, kind, name, roleId, model,
      modelLabel: MODELS.find((m) => m.id === model)?.label ?? model,
      vendor: vendorOf(model), demo: false, status: 'offline', activity: 'idle',
      appearance: { seed: h, gender: h % 2 ? 'f' : 'm' }, thinking, modelBy,
    };
  }

  function residents(project: Project): AgentInfo[] {
    const list: AgentInfo[] = [];
    for (const job of jobs.list(project.id)) {
      list.push(person(project, job, 'assistant', LEAD_NAMES[job.kind], job.leadModel, 'resident', job.leadThinking, 'job'));
      const wf = workflowOf(project.id, job.workflowId);
      for (const s of wf?.steps ?? []) list.push(person(project, job, s.id, s.name, s.model, 'role', s.thinking, 'team'));
    }
    return list;
  }

  function threadsOf(a: AgentInfo): { list: StubThread[]; current: string } {
    let t = threads.get(a.id);
    if (!t) {
      const project = city.project(a.projectId);
      const job = jobs.get(a.projectId, a.jobId);
      const list = project && job ? fakeHistory(a.id, a, project, job) : [];
      const current = list.at(-1)?.id ?? uid('t');
      if (!list.length) list.push({ id: current, title: 'New chat', createdAt: Date.now(), updatedAt: Date.now(), items: [] });
      t = { list, current };
      threads.set(a.id, t);
    }
    return t;
  }

  const currentThread = (agentId: string): StubThread | undefined => {
    const t = threads.get(agentId);
    return t?.list.find((x) => x.id === t.current);
  };

  function chatThreads(agentId: string): ChatThread[] {
    const t = threads.get(agentId);
    if (!t) return [];
    return t.list
      .filter((x) => x.items.length > 0 || x.id === t.current)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((x) => ({
        id: x.id, agentId, title: x.title, createdAt: x.createdAt, updatedAt: x.updatedAt, current: x.id === t.current,
        messages: x.items.filter((i) => i.kind === 'user' || i.kind === 'assistant').length,
      }));
  }

  function upsert(a: AgentInfo): void {
    agents.set(a.id, a);
    hub.broadcast({ t: 'agent', agent: a });
  }

  function patch(id: string, p: Partial<AgentInfo>): void {
    const a = agents.get(id);
    if (a) upsert({ ...a, ...p });
  }

  function remove(id: string): void {
    if (!agents.delete(id)) return;
    hub.broadcast({ t: 'agent_removed', agentId: id });
  }

  function syncResidents(project: Project, broadcast = true): void {
    const want = residents(project);
    const keep = new Set(want.map((a) => a.id));
    for (const a of [...agents.values()]) if (a.projectId === project.id && a.kind !== 'subagent' && !keep.has(a.id)) remove(a.id);
    for (const a of want) {
      const prev = agents.get(a.id);
      const next: AgentInfo = { ...a, status: prev?.status ?? a.status, activity: prev?.activity ?? a.activity, detail: prev?.detail, threadId: threadsOf(a).current };
      if (broadcast) upsert(next);
      else agents.set(next.id, next);
    }
  }

  for (const p of city.get().projects) syncResidents(p, false);

  function pushItem(agentId: string, item: TranscriptItem): void {
    const a = agents.get(agentId);
    if (!a) return; // moved out (job deleted) while a canned reply was still scheduled
    const t = a && a.kind !== 'subagent' ? currentThread(agentId) : undefined;
    if (t) {
      const i = t.items.findIndex((x) => x.id === item.id);
      if (i >= 0) t.items[i] = item;
      else t.items.push(item);
      t.updatedAt = Date.now();
      const firstUser = t.items.find((x) => x.kind === 'user');
      if (t.title === 'New chat' && firstUser && firstUser.kind === 'user') t.title = firstUser.text.replace(/\s+/g, ' ').slice(0, 60);
      hub.broadcast({ t: 'threads', agentId, threads: chatThreads(agentId) });
    } else {
      const list = (helperItems.get(agentId) ?? []).filter((x) => x.id !== item.id);
      list.push(item);
      helperItems.set(agentId, list);
    }
    hub.broadcast({ t: 'transcript_upsert', agentId, item });
  }
  const helperItems = new Map<string, TranscriptItem[]>();

  function act(id: string, activity: Activity, detail?: string, status: AgentInfo['status'] = 'busy'): void {
    patch(id, { activity, detail, status });
  }

  function sendHelpers(parent: AgentInfo): void {
    for (const [i, chore] of (['chore', 'reading'] as Activity[]).entries()) {
      const id = `${parent.projectId}:sub:${++helperSeq}`;
      const h = hash(id);
      upsert({
        id, projectId: parent.projectId, jobId: parent.jobId, kind: 'subagent', name: i ? 'Explore helper' : 'Task helper', roleId: 'task',
        model: parent.model, modelLabel: parent.modelLabel, vendor: parent.vendor, demo: false, parentId: parent.id, modelBy: 'helper',
        status: 'busy', activity: chore, detail: `Sent by ${parent.name}`, appearance: { seed: h, gender: h % 2 ? 'f' : 'm' },
      });
      later(7000 + i * 1500, () => act(id, 'done', 'Finished — heading out', 'idle'));
      later(13_000 + i * 1500, () => {
        remove(id);
        helperItems.delete(id);
      });
    }
  }

  async function prompt(agentId: string, text: string, conn: ClientConn, imageIds: string[] = []): Promise<void> {
    const agent = agents.get(agentId);
    if (!agent) {
      conn.send({ t: 'toast', level: 'error', text: 'That person is not home' });
      return;
    }
    const n = Date.now();
    // the stub never reads the pictures, but the chat shows them like the real system does
    const images = imageIds.flatMap((id) => {
      const ext = UPLOAD_ID.exec(id)?.[1];
      return ext ? [{ id, mimeType: ext === 'jpg' ? 'image/jpeg' : `image/${ext}` }] : [];
    });
    pushItem(agentId, { kind: 'user', id: uid(`${agentId}:u`), text, ts: n, ...(images.length ? { images } : {}) });
    act(agentId, 'listening', 'Listening…');
    const team = /\b(team|helpers?|parallel)\b/i.test(text) && agent.kind !== 'subagent';
    later(1200, () => act(agentId, team ? 'delegating' : 'thinking', team ? 'Sending two helpers' : 'Thinking…'));
    if (team) later(1600, () => sendHelpers(agent));
    later(2000, () => act(agentId, 'reading', 'Reading README.md'));
    later(3400, () => {
      const job = jobs.get(agent.projectId, agent.jobId);
      pushItem(agentId, {
        kind: 'assistant', id: uid(`${agentId}:a`), ts: Date.now(),
        text: `*(stub agents)* ${agent.name} of **${job?.name ?? agent.jobId}** heard: “${text.slice(0, 200)}”. The real agent system is disabled because the server runs with \`RLT_STUB_AGENTS=1\`.`,
      });
      act(agentId, 'done', 'Done', 'idle');
      later(3000, () => act(agentId, 'idle', undefined, 'idle'));
    });
  }

  function threadAgent(agentId: string): AgentInfo {
    const a = agents.get(agentId);
    if (!a) throw new Error('That person is not home any more.');
    if (a.kind === 'subagent') throw new Error('Helpers have a single chat — talk to the person who sent them instead.');
    if (a.status === 'busy') throw new Error(`${a.name} is still working. Wait until they're done (or press Stop).`);
    return a;
  }

  function showThread(a: AgentInfo, t: { current: string }): void {
    patch(a.id, { threadId: t.current });
    hub.broadcast({ t: 'transcript_reset', agentId: a.id, items: currentThread(a.id)?.items ?? [] });
    hub.broadcast({ t: 'threads', agentId: a.id, threads: chatThreads(a.id) });
  }

  // ── fake workflow runs (per job), so the corkboard and the Workflow tab can be tested ──
  function emitRun(run: WorkflowRun): void {
    hub.broadcast({ t: 'run', run: structuredClone(run) });
  }

  function startRun(projectId: string, jobId: string | undefined, workflowId: string, task: string): WorkflowRun {
    const project = city.project(projectId);
    if (!project) throw new Error('That house no longer exists.');
    const job = jobId ? jobs.get(projectId, jobId) : (jobs.get(projectId, MAIN_JOB_ID) ?? jobs.list(projectId)[0]);
    if (!job) throw new Error('That job no longer exists.');
    const wf = workflowOf(projectId, workflowId);
    if (!wf) throw new Error('Unknown workflow.');
    if ([...runs.values()].some((r) => r.projectId === projectId && r.jobId === job.id && (r.status === 'running' || r.status === 'waiting_approval'))) {
      throw new Error(`A workflow is already running in “${job.name}”.`);
    }
    const run: WorkflowRun = {
      id: uid('run'), workflowId: wf.id, workflowName: wf.name, projectId, jobId: job.id, task, status: 'running',
      currentStepId: null, loop: 0, steps: [], startedAt: Date.now(), costUsd: 0, startedBy: 'user',
      team: wf.steps.map((s) => ({ id: s.id, agentId: agentIdFor(projectId, job.id, s.id), name: s.name, model: s.model, kind: s.kind, ...(s.loopBackTo ? { loopBackTo: s.loopBackTo } : {}) })),
    };
    runs.set(run.id, run);
    emitRun(run);
    let prev: AgentInfo | undefined;
    wf.steps.forEach((s, i) => {
      later(400 + i * STEP_MS, () => {
        if (run.status !== 'running') return;
        let a = agents.get(agentIdFor(projectId, job.id, s.id));
        if (!a) {
          a = { ...person(project, job, s.id, s.name, s.model, 'role', s.thinking, 'run'), threadId: uid('t') };
          threads.set(a.id, { list: [{ id: a.threadId!, title: 'New chat', createdAt: Date.now(), updatedAt: Date.now(), items: [] }], current: a.threadId! });
          upsert(a);
        }
        if (prev) hub.broadcast({ t: 'handoff', projectId, fromAgentId: prev.id, toAgentId: a.id, label: `${prev.name}'s notes` });
        run.currentStepId = s.id;
        run.steps.push({ stepId: s.id, status: 'running', agentId: a.id, startedAt: Date.now() });
        emitRun(run);
        act(a.id, s.kind === 'review' ? 'reading' : 'writing', `${s.name} at work`);
        const me = a;
        later(STEP_MS - 400, () => {
          const rs = run.steps.at(-1)!;
          if (run.status !== 'running') return;
          rs.status = 'done';
          rs.endedAt = Date.now();
          rs.output = `*(stub)* ${s.name} did their part of: ${task.slice(0, 120)}`;
          if (s.kind === 'review') rs.verdict = 'approve';
          run.costUsd += 0.012;
          act(me.id, 'done', 'Done', 'idle');
          later(2500, () => act(me.id, 'idle', undefined, 'idle'));
          if (i === wf.steps.length - 1) {
            run.status = 'completed';
            run.currentStepId = null;
            run.endedAt = Date.now();
            hub.broadcast({ t: 'toast', level: 'success', text: `${wf.icon} ${wf.name} finished (stub)`, projectId });
          }
          emitRun(run);
        });
        prev = a;
      });
    });
    return run;
  }

  function abortRun(run: WorkflowRun): void {
    if (run.status !== 'running' && run.status !== 'waiting_approval') return;
    run.status = 'aborted';
    run.currentStepId = null;
    run.endedAt = Date.now();
    for (const s of run.steps) if (s.status === 'running') s.status = 'failed';
    emitRun(run);
  }

  return {
    snapshot(): AgentSnapshot {
      return { agents: [...agents.values()], ...workflowLists(), runs: [...runs.values()], approvals: [], models: MODELS, providers: PROVIDERS, plans: [] };
    },

    async handle(msg, conn) {
      const ack = (reqId: string, data?: unknown) => conn.send({ t: 'ack', reqId, ok: true, data });
      const nack = (reqId: string, err: unknown) => conn.send({ t: 'ack', reqId, ok: false, error: err instanceof Error ? err.message : String(err) });
      switch (msg.t) {
        case 'enter_project': {
          const p = city.project(msg.projectId);
          if (p) syncResidents(p);
          return;
        }
        case 'prompt':
          if (!msg.text.trim() && !msg.images?.length) {
            if (msg.reqId) nack(msg.reqId, 'Type a message first.');
            return;
          }
          await prompt(msg.agentId, msg.text, conn, msg.images);
          if (msg.reqId) ack(msg.reqId);
          return;
        case 'abort': {
          const a = agents.get(msg.agentId);
          if (a) upsert({ ...a, status: 'idle', activity: 'idle', detail: undefined });
          if (msg.reqId) ack(msg.reqId, { restored: [] }); // the stub never queues messages
          return;
        }
        case 'queue_action':
          nack(msg.reqId, 'That message was already read.');
          return;
        case 'compact':
          ack(msg.reqId, { nothing: true });
          return;
        case 'goal':
          nack(msg.reqId, 'Goals need the real agent system (server runs with RLT_STUB_AGENTS=1).');
          return;
        case 'get_helper_transcript':
          ack(msg.reqId, { items: [], running: false }); // the stub's helpers leave no chat behind
          return;
        case 'get_transcript': {
          const a = agents.get(msg.agentId);
          const items = a && a.kind !== 'subagent' ? (currentThread(msg.agentId)?.items ?? []) : (helperItems.get(msg.agentId) ?? []);
          conn.send({ t: 'transcript_reset', agentId: msg.agentId, items });
          return;
        }
        case 'list_threads':
          conn.send({ t: 'threads', agentId: msg.agentId, threads: chatThreads(msg.agentId) });
          return;
        case 'search_threads': {
          const t = threads.get(msg.agentId);
          const q = msg.query.trim().toLowerCase();
          const results = chatThreads(msg.agentId).flatMap((c) => {
            const m = searchItems(t?.list.find((x) => x.id === c.id)?.items ?? [], q);
            const ti = c.title.toLowerCase().indexOf(q);
            if (!m.hits && ti < 0) return [];
            const shown = m.hits ? { snippet: m.snippet, at: m.at, itemId: m.itemId } : snippetAt(c.title, ti, q.length);
            return [{ threadId: c.id, title: c.title, updatedAt: c.updatedAt, messages: c.messages, current: c.current, hits: m.hits, ...shown }];
          });
          ack(msg.reqId, { results });
          return;
        }
        case 'new_thread': {
          try {
            const a = threadAgent(msg.agentId);
            const t = threadsOf(a);
            const cur = currentThread(a.id);
            if (!cur || cur.items.length) {
              const fresh: StubThread = { id: uid('t'), title: 'New chat', createdAt: Date.now(), updatedAt: Date.now(), items: [] };
              t.list.push(fresh);
              t.current = fresh.id;
            }
            showThread(a, t);
            ack(msg.reqId, { thread: chatThreads(a.id).find((x) => x.current) });
          } catch (err) {
            nack(msg.reqId, err);
          }
          return;
        }
        case 'delete_thread': {
          try {
            const a = threadAgent(msg.agentId);
            const t = threadsOf(a);
            if (!t.list.some((x) => x.id === msg.threadId)) throw new Error('That chat no longer exists.');
            if (t.current === msg.threadId) {
              const fresh: StubThread = { id: uid('t'), title: 'New chat', createdAt: Date.now(), updatedAt: Date.now(), items: [] };
              t.list.push(fresh);
              t.current = fresh.id;
            }
            t.list = t.list.filter((x) => x.id !== msg.threadId);
            showThread(a, t);
            ack(msg.reqId, { thread: chatThreads(a.id).find((x) => x.current) });
          } catch (err) {
            nack(msg.reqId, err);
          }
          return;
        }
        case 'switch_thread': {
          try {
            const a = threadAgent(msg.agentId);
            const t = threadsOf(a);
            if (!t.list.some((x) => x.id === msg.threadId)) throw new Error('That chat no longer exists.');
            const cur = currentThread(a.id);
            if (cur && !cur.items.length && cur.id !== msg.threadId) t.list = t.list.filter((x) => x !== cur);
            t.current = msg.threadId;
            showThread(a, t);
            ack(msg.reqId, { thread: chatThreads(a.id).find((x) => x.current) });
          } catch (err) {
            nack(msg.reqId, err);
          }
          return;
        }
        case 'approve':
          hub.broadcast({ t: 'approval_resolved', id: msg.approvalId });
          if (msg.reqId) ack(msg.reqId);
          return;
        case 'save_workflow': {
          if (!msg.projectId) return nack(msg.reqId, 'This page is out of date — reload it to save workflows.');
          const p = city.project(msg.projectId);
          if (!p) return nack(msg.reqId, 'That house no longer exists.');
          keepInHouse(p.id, msg.workflow);
          hub.broadcast({ t: 'workflows', ...workflowLists() });
          syncResidents(p);
          ack(msg.reqId, { workflow: workflowOf(p.id, msg.workflow.id) });
          return;
        }
        case 'delete_workflow': {
          if (!msg.projectId) return nack(msg.reqId, 'This page is out of date — reload it to delete workflows.');
          const p = city.project(msg.projectId);
          if (!p) return nack(msg.reqId, 'That house no longer exists.');
          const w = workflowOf(p.id, msg.workflowId);
          if (!w) return nack(msg.reqId, 'No such workflow.');
          const used = jobs.list(p.id).filter((j) => j.workflowId === w.id);
          if (used.length && !msg.clearTeams) return nack(msg.reqId, `“${w.name}” is the team of ${used.map((j) => j.name).join(', ')} — pick another team there first.`);
          for (const j of used) jobs.update(p.id, j.id, { workflowId: null }); // the user said: no team there
          if (p.workflowId === w.id) city.updateProject(p.id, { workflowId: jobs.get(p.id, MAIN_JOB_ID)?.workflowId ?? null });
          houseOwn.set(p.id, own(p.id).filter((x) => x.id !== w.id));
          hub.broadcast({ t: 'workflows', ...workflowLists() });
          syncResidents(p);
          ack(msg.reqId, { workflow: w, cleared: used.map((j) => j.name) });
          return;
        }
        case 'promote_workflow': {
          const p = city.project(msg.projectId);
          const w = own(msg.projectId).find((x) => x.id === msg.workflowId);
          if (!p || !w) return nack(msg.reqId, `This house has no workflow with id “${msg.workflowId}”.`);
          const i = library.findIndex((e) => e.workflow.id === w.id);
          if (i >= 0 && !msg.replace) return nack(msg.reqId, `The library already has a workflow with id “${w.id}” (“${library[i]!.workflow.name}”) — replace it, or save this one as a copy first.`);
          const entry: LibraryWorkflow = { workflow: structuredClone(w), from: { projectId: p.id, house: p.name }, at: Date.now() };
          if (i >= 0) library[i] = entry;
          else library.push(entry);
          hub.broadcast({ t: 'workflows', ...workflowLists() });
          ack(msg.reqId, { entry });
          return;
        }
        case 'import_workflow': {
          const p = city.project(msg.projectId);
          if (!p) return nack(msg.reqId, 'That house no longer exists.');
          const e = library.find((x) => x.workflow.id === msg.workflowId);
          if (!e) return nack(msg.reqId, `The library has no workflow with id “${msg.workflowId}”.`);
          const mine = own(p.id).find((x) => x.id === msg.workflowId);
          if (mine && !msg.replace) return nack(msg.reqId, `This house already has a workflow with id “${mine.id}” (“${mine.name}”) — replace it with the library's, or keep it.`);
          keepInHouse(p.id, structuredClone(e.workflow));
          hub.broadcast({ t: 'workflows', ...workflowLists() });
          syncResidents(p);
          ack(msg.reqId, { workflow: workflowOf(p.id, msg.workflowId) });
          return;
        }
        case 'delete_library_workflow': {
          const i = library.findIndex((e) => e.workflow.id === msg.workflowId);
          if (i < 0) return nack(msg.reqId, `The library has no workflow with id “${msg.workflowId}”.`);
          library.splice(i, 1);
          hub.broadcast({ t: 'workflows', ...workflowLists() });
          ack(msg.reqId, { workflowId: msg.workflowId });
          return;
        }
        case 'save_run_team': {
          // The stub's runs only use saved workflows: keep a copy of the run's workflow under the new name, in its house.
          const run = runs.get(msg.runId);
          const wf = run && workflowOf(run.projectId, run.workflowId);
          if (!run || !wf) return nack(msg.reqId, 'No such run.');
          const base = msg.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'team';
          let id = base;
          for (let n = 2; workflowOf(run.projectId, id); n++) id = `${base}-${n}`;
          const copy: Workflow = { ...structuredClone(wf), id, name: msg.name };
          keepInHouse(run.projectId, copy);
          hub.broadcast({ t: 'workflows', ...workflowLists() });
          ack(msg.reqId, { workflow: copy });
          return;
        }
        case 'answer_plan':
          // The stub's leads never start teams, so no plan card ever waits.
          nack(msg.reqId, 'That plan was already answered.');
          return;
        case 'run_workflow':
          try {
            const run = startRun(msg.projectId, msg.jobId, msg.workflowId, msg.task);
            ack(msg.reqId, { runId: run.id });
          } catch (err) {
            nack(msg.reqId, err);
          }
          return;
        case 'abort_run': {
          const run = runs.get(msg.runId);
          if (run) abortRun(run);
          return;
        }
        case 'revert_run':
          nack(msg.reqId, 'Reverting needs the real agent system (server runs with RLT_STUB_AGENTS=1)');
          return;
        case 'continue_run':
          nack(msg.reqId, 'Continuing a run needs the real agent system (server runs with RLT_STUB_AGENTS=1)');
          return;
        case 'get_run_plan':
        case 'edit_run':
          nack(msg.reqId, 'Changing a running team needs the real agent system (server runs with RLT_STUB_AGENTS=1)');
          return;
        case 'refresh_models':
          conn.send({ t: 'models', models: MODELS, providers: PROVIDERS });
          return;
        case 'login_start':
          conn.send({
            t: 'login',
            login: { loginId: 'stub', provider: msg.provider, phase: 'failed', message: 'Sign-in needs the real agent system (server runs with RLT_STUB_AGENTS=1).' },
          });
          return;
        case 'login_input':
        case 'login_cancel':
          return;
        case 'get_omp_env':
          ack(msg.reqId, { ompEnv: { GOOGLE_CLOUD_PROJECT: { source: null }, GEMINI_API_KEY: { source: null }, ANTHROPIC_API_KEY: { source: null }, OPENAI_API_KEY: { source: null } } satisfies OmpEnvView });
          return;
        case 'set_omp_env':
          nack(msg.reqId, 'Saving agent settings needs the real agent system (server runs with RLT_STUB_AGENTS=1).');
          return;
        case 'list_local_servers':
          ack(msg.reqId, { servers: [], file: 'models.yml' });
          return;
        case 'test_local_server':
        case 'save_local_server':
        case 'remove_local_server':
          nack(msg.reqId, 'Model servers need the real agent system (server runs with RLT_STUB_AGENTS=1).');
          return;
        case 'list_accounts':
          ack(msg.reqId, { accounts: [] });
          return;
        case 'logout_account':
          nack(msg.reqId, 'Signing out needs the real agent system (server runs with RLT_STUB_AGENTS=1).');
          return;
        case 'get_usage':
          ack(msg.reqId, { usage: { fetchedAt: Date.now(), accounts: [] } });
          return;
        case 'get_account_order': // no signed-in accounts here (like list_accounts): nothing to order, no account chip
          ack(msg.reqId, { order: { providers: [] } satisfies AccountOrder });
          return;
        case 'set_account_order':
        case 'set_chat_account':
          nack(msg.reqId, 'Choosing accounts needs the real agent system (server runs with RLT_STUB_AGENTS=1).');
          return;
        default:
          throw new Error(`Stub agent system cannot handle ${msg.t}`);
      }
    },

    async onProjectAdded(project) {
      firstSight(project.id);
      hub.broadcast({ t: 'workflows', ...workflowLists() });
      syncResidents(project);
    },
    async onProjectRemoved(projectId) {
      if (houseOwn.delete(projectId)) hub.broadcast({ t: 'workflows', ...workflowLists() }); // the library keeps its copies
      for (const run of runs.values()) if (run.projectId === projectId) abortRun(run);
      for (const a of [...agents.values()]) {
        if (a.projectId !== projectId) continue;
        threads.delete(a.id);
        remove(a.id);
      }
    },
    async onProjectUpdated(project) {
      syncResidents(project);
    },
    async onJobsChanged(projectId) {
      const p = city.project(projectId);
      if (p) syncResidents(p);
    },
    async onJobRemoved(projectId, jobId) {
      for (const run of runs.values()) if (run.projectId === projectId && run.jobId === jobId) abortRun(run);
      for (const a of [...agents.values()]) if (a.projectId === projectId && a.jobId === jobId) remove(a.id); // threads stay (like files on disk)
    },
    defaultLead: () => ({ model: DEFAULT_LEAD, connected: true }),
    ompVersion: () => null,
    demoMode: () => false,
    async shutdown() {
      for (const t of timers) clearTimeout(t);
      timers.clear();
    },
  };
}
