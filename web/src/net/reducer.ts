// Pure-ish state transitions: apply one ServerMsg to the client mirror (mutates in place so the
// Store can hand subscribers a stable object reference).
import type { Job, ServerMsg, TeamPlan, TranscriptItem } from '../../../shared/protocol';
import type { ClientState } from '../core/types';

/** Activity lines the client keeps (the server sends at most as many). */
const ACTIVITY_KEPT = 150;

export function emptyState(): ClientState {
  return {
    connected: false,
    hello: null,
    city: { lots: [], projects: [] },
    agents: {},
    transcripts: {},
    workflows: [],
    runs: {},
    approvals: {},
    plans: {},
    models: [],
    providers: [],
    git: {},
    jobs: {},
    threads: {},
    view: 'city',
    currentProjectId: null,
    currentJobId: null,
  };
}

/** Rooms read bottom-up, left to right: 1A, 2A, 2B, … (the order the contract promises). */
export function byRoom(a: Job, b: Job): number {
  return a.room.floor - b.room.floor || a.room.slot - b.room.slot || a.createdAt - b.createdAt;
}

/** state.git key: the house folder (projectId), or a job's own copy of the files ("projectId:jobId", Job.worktree). */
export function gitKey(projectId: string, jobId?: string | null): string {
  return jobId ? `${projectId}:${jobId}` : projectId;
}

function groupJobs(list: Job[]): Record<string, Job[]> {
  const out: Record<string, Job[]> = {};
  for (const j of list) (out[j.projectId] ??= []).push(j);
  for (const k of Object.keys(out)) out[k].sort(byRoom);
  return out;
}

function byId<T extends { id: string }>(list: T[]): Record<string, T> {
  const out: Record<string, T> = {};
  for (const item of list) out[item.id] = item;
  return out;
}

/** Keep the pending-plan index in step with one plan's latest state (answered plans leave it). */
export function notePlan(s: ClientState, plan: TeamPlan | undefined): void {
  if (!plan?.id) return;
  if (plan.status === 'pending') s.plans[plan.id] = plan;
  else delete s.plans[plan.id];
}

/** Insert or replace by id. Searches from the end because streaming updates hit the newest items. */
export function upsertItem(list: TranscriptItem[], item: TranscriptItem): void {
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].id === item.id) {
      list[i] = item;
      return;
    }
  }
  list.push(item);
}

/** The workflows from a snapshot or a {t:'workflows'}: each house's own and the library (`workflows` is empty; a
 *  slightly older server sent its built-ins there). An older server still sends only `workflows` (every workflow, which
 *  every house saw): no house lists and no library then. */
function setWorkflows(s: ClientState, msg: Pick<Extract<ServerMsg, { t: 'workflows' }>, 'workflows' | 'houseWorkflows' | 'library'>): void {
  s.workflows = msg.workflows;
  s.houseWorkflows = msg.houseWorkflows;
  s.library = msg.library;
}

export function applyServerMsg(s: ClientState, msg: ServerMsg): void {
  switch (msg.t) {
    case 'hello':
      s.hello = msg;
      break;
    case 'snapshot': {
      s.city = msg.city;
      s.agents = byId(msg.agents);
      setWorkflows(s, msg);
      s.runs = byId(msg.runs);
      s.approvals = byId(msg.approvals);
      // Servers from before plan cards send no `plans`.
      s.plans = byId((msg.plans ?? []).filter((p) => p?.status === 'pending'));
      s.models = msg.models;
      s.providers = msg.providers;
      s.jobs = groupJobs(msg.jobs ?? []);
      // Servers from before the spend ledger / activity log send neither: the UI falls back to its own.
      s.spend = msg.spend;
      s.activity = msg.activity ? [...msg.activity] : undefined;
      for (const id of Object.keys(s.threads)) if (!s.agents[id]) delete s.threads[id];
      // Transcripts of agents that disappeared are dropped; the rest are re-requested by the store.
      for (const id of Object.keys(s.transcripts)) if (!s.agents[id]) delete s.transcripts[id];
      break;
    }
    case 'city':
      s.city = msg.city;
      for (const [key, g] of Object.entries(s.git)) if (!msg.city.projects.some((p) => p.id === g.projectId)) delete s.git[key];
      for (const id of Object.keys(s.jobs)) if (!msg.city.projects.some((p) => p.id === id)) delete s.jobs[id];
      break;
    case 'jobs':
      s.jobs[msg.projectId] = [...msg.jobs].sort(byRoom);
      // a deleted job's copy is gone
      for (const [key, g] of Object.entries(s.git)) if (g.projectId === msg.projectId && g.jobId && !msg.jobs.some((j) => j.id === g.jobId && j.worktree)) delete s.git[key];
      break;
    case 'threads':
      s.threads[msg.agentId] = [...msg.threads].sort((a, b) => b.updatedAt - a.updatedAt);
      break;
    case 'agent':
      s.agents[msg.agent.id] = msg.agent;
      break;
    case 'agent_removed':
      delete s.agents[msg.agentId];
      delete s.transcripts[msg.agentId];
      delete s.threads[msg.agentId];
      for (const p of Object.values(s.plans)) if (p.agentId === msg.agentId) delete s.plans[p.id]; // nobody left to run it
      break;
    case 'transcript_reset':
      s.transcripts[msg.agentId] = [...msg.items];
      // a plan answered while this chat wasn't loaded: its stored card says so
      for (const item of msg.items) if (item.kind === 'plan' && item.plan?.status !== 'pending') notePlan(s, item.plan);
      break;
    case 'transcript_upsert':
      // Only into a loaded chat: creating a partial list here would make the chat look loaded, so opening it would
      // never fetch the history. The full transcript, when asked for, already has this item.
      if (s.transcripts[msg.agentId]) upsertItem(s.transcripts[msg.agentId]!, msg.item);
      if (msg.item.kind === 'plan') notePlan(s, msg.item.plan);
      break;
    case 'plan':
      notePlan(s, msg.plan);
      break;
    case 'approval':
      s.approvals[msg.approval.id] = msg.approval;
      break;
    case 'approval_resolved':
      delete s.approvals[msg.id];
      break;
    case 'run':
      s.runs[msg.run.id] = msg.run;
      break;
    case 'workflows':
      setWorkflows(s, msg);
      break;
    case 'git':
      s.git[gitKey(msg.summary.projectId, msg.summary.jobId)] = msg.summary;
      break;
    case 'models':
      s.models = msg.models;
      s.providers = msg.providers;
      // hello is only sent on connect; keep its scripted-model flag (demoMode, CAST_MOCK_LLM only) in step after a
      // sign-in or Refresh: the server's own flag when it sends one, else the one hello had. No guessing.
      if (s.hello) {
        s.hello = { ...s.hello, ...(typeof msg.demoMode === 'boolean' ? { demoMode: msg.demoMode } : {}) };
        // what omp and the account check are up to (installed now, the check done or failed, …)
        if (msg.agents) s.hello.agents = msg.agents;
        if (msg.ompVersion !== undefined) s.hello.ompVersion = msg.ompVersion;
      }
      break;
    case 'spend':
      s.spend = msg.spend;
      break;
    case 'toast':
      // a house event (it has an activity id): the Inbox's "Recent" keeps it, like every other device does
      if (msg.id && s.activity && !s.activity.some((e) => e.id === msg.id)) {
        s.activity.unshift({ id: msg.id, ts: msg.ts ?? Date.now(), level: msg.level, text: msg.text, ...(msg.projectId ? { projectId: msg.projectId } : {}), ...(msg.agentId ? { agentId: msg.agentId } : {}) });
        if (s.activity.length > ACTIVITY_KEPT) s.activity.length = ACTIVITY_KEPT;
      }
      break;
    // handoff / fs_list / ack / error carry no persistent state.
    default:
      break;
  }
}
