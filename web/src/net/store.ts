// Client store: mirrors server state over the /ws WebSocket and notifies subscribers.
import { WS_PATH, type AgentInfo, type ClientMsg, type Job, type ServerMsg } from '../../../shared/protocol';
import { workflowOf, workflowsOf } from '../../../shared/house-workflows';
import type { ClientState, RequestOptions, Store } from '../core/types';
import { apiUrl, wsUrl } from './base';
import { applyServerMsg, emptyState } from './reducer';
import { createRequestTracker, newReqId, OFFLINE_TEXT, RequestError } from './requests';
import { connectSocket } from './socket';

const REQUEST_TIMEOUT_MS = 20_000;
const FS_LIST_TIMEOUT_MS = 10_000;
// Answered by a short-lived omp on the server, one at a time; `omp usage` alone may take up to 45 s.
const OMP_REQUESTS = new Set<ClientMsg['t']>(['list_accounts', 'logout_account', 'get_usage', 'get_account_order', 'set_account_order', 'set_chat_account']);
const OMP_TIMEOUT_MS = 90_000;
// Answered once the person's omp has it: a prompt may wait for its process to start and for omp to re-encode its
// images (~15 s for big ones); Stop waits for the turn to end; a compact runs for minutes.
const SLOW_TIMEOUT_MS: Partial<Record<ClientMsg['t'], number>> = { prompt: 150_000, abort: 60_000, queue_action: 30_000, goal: 60_000, compact: 600_000 };
// Git work over a whole repo for a job with its own copy (Job.worktree): making the copy, bringing its changes in
// (preview / apply / undo, file by file) and deleting it (its work is committed first). Minutes on a big repo — the
// server finishes regardless, so the page waits long and says it is still working meanwhile (RequestOptions.onSlow).
const COPY_TIMEOUT_MS = 180_000;
const STILL_WORKING_MS = 8_000;
const COPY_TIMEOUT_TEXT = 'Still not done after 3 minutes. CAST keeps working on it — check again in a moment.';
const OUTBOX_LIMIT = 100;
// Without a connection for this long (the "Reconnecting…" banner shows then, ui/index.ts) a request fails at once
// instead of waiting out its timeout; a blip shorter than this still queues it.
const OFFLINE_FAIL_MS = 1500;
// The browser said the network is gone: how long the quick "is the server still there?" request may take.
const REACHABLE_MS = 4000;

/** One cheap request to this city's server (GET /api/version needs no sign-in): can it still be reached? */
export async function serverReachable(timeoutMs = REACHABLE_MS): Promise<boolean> {
  try {
    const res = await fetch(apiUrl('/api/version'), { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

/** This city's /ws: on the hub's own origin, under /city/<id>/ for a city opened through a hub (net/base.ts). */
export function defaultWsUrl(): string {
  return wsUrl(WS_PATH);
}

export const MAIN_JOB = 'main';

/** Sort people the way they are expected: the job's lead, team members in step order, helpers. */
function agentOrder(a: AgentInfo, b: AgentInfo, stepOrder: string[]): number {
  const rank = (x: AgentInfo) => {
    if (x.kind === 'subagent') return 1000;
    if (x.kind === 'resident' || x.roleId === 'assistant') return -1;
    const i = stepOrder.indexOf(x.roleId);
    return i < 0 ? 500 : i;
  };
  return rank(a) - rank(b) || a.name.localeCompare(b.name);
}

export function createStore(url: string = defaultWsUrl()): Store {
  const state = emptyState();
  const listeners = new Set<(s: ClientState, msg?: ServerMsg) => void>();
  const outbox: { data: string; reqId?: string }[] = [];
  // A request that timed out while the socket was down must not go out later, once the caller said it failed
  // (a chat message the user then sends again would arrive twice).
  const requests = createRequestTracker({
    onUnsent(reqId) {
      const i = outbox.findIndex((o) => o.reqId === reqId);
      if (i >= 0) outbox.splice(i, 1);
    },
  });
  let snapshots = 0;
  let offlineSince = Date.now(); // not connected since (0 while connected); the first connect counts from page load
  let offlineTimer: ReturnType<typeof setTimeout> | undefined;
  const offlineLong = () => !state.connected && offlineSince > 0 && Date.now() - offlineSince >= OFFLINE_FAIL_MS;
  const armOffline = () => {
    clearTimeout(offlineTimer);
    offlineTimer = setTimeout(() => {
      if (offlineLong()) requests.failUnsent(OFFLINE_TEXT);
    }, OFFLINE_FAIL_MS - (Date.now() - offlineSince));
  };
  // The job last picked in each house, so walking out and back in (or switching houses) keeps the choice.
  const jobMemory = new Map<string, string>();
  let jobOwner: string | null = null; // project the current currentJobId belongs to

  const notify = (msg?: ServerMsg) => {
    for (const fn of [...listeners]) {
      try {
        fn(state, msg);
      } catch (err) {
        console.error('[store] subscriber threw', err);
      }
    }
  };

  const flush = () => {
    while (outbox.length && socket.open) {
      const next = outbox.shift()!;
      socket.send(next.data);
      if (next.reqId) requests.markSent(next.reqId);
    }
  };

  const enqueue = (data: string, reqId?: string): boolean => {
    if (socket.open && outbox.length === 0) return socket.send(data);
    if (outbox.length >= OUTBOX_LIMIT) outbox.shift();
    outbox.push({ data, reqId });
    return false;
  };

  /** After a reconnect the server sends a fresh snapshot; re-fetch what the snapshot does not carry. */
  const resync = () => {
    for (const agentId of Object.keys(state.transcripts)) send({ t: 'get_transcript', agentId });
    for (const agentId of Object.keys(state.threads)) if (state.agents[agentId]) send({ t: 'list_threads', agentId });
    const pid = state.currentProjectId;
    if (pid && state.city.projects.some((p) => p.id === pid)) {
      send({ t: 'enter_project', projectId: pid });
      send({ t: 'get_git', projectId: pid });
      // job copies (Job.worktree) shown since: their own summaries
      for (const g of Object.values(state.git)) if (g.projectId === pid && g.jobId && store.job(pid, g.jobId)?.worktree) send({ t: 'get_git', projectId: pid, jobId: g.jobId });
    }
  };

  const onMessage = (raw: string) => {
    let msg: ServerMsg;
    try {
      msg = JSON.parse(raw) as ServerMsg;
    } catch {
      console.warn('[store] dropped non-JSON frame');
      return;
    }
    if (!msg || typeof msg !== 'object' || typeof (msg as { t?: unknown }).t !== 'string') return;
    requests.handle(msg);
    applyServerMsg(state, msg);
    if (msg.t === 'snapshot') {
      snapshots++;
      if (snapshots > 1) resync();
    }
    notify(msg);
  };

  const socket = connectSocket(url, {
    onOpen() {
      state.connected = true;
      offlineSince = 0;
      clearTimeout(offlineTimer);
      flush();
      notify();
    },
    onClose() {
      const was = state.connected;
      state.connected = false;
      requests.failSent('Lost connection to the CAST server. Try again in a moment.');
      if (was) {
        offlineSince = Date.now();
        armOffline();
        notify();
      }
    },
    onMessage,
    reachable: () => serverReachable(),
  });

  armOffline(); // the first connect: requests made meanwhile fail once the banner would show, not at their timeout

  function send(msg: ClientMsg) {
    enqueue(JSON.stringify(msg));
  }

  /** Whether the request works on a job's own copy of the files (see COPY_TIMEOUT_MS). */
  function touchesCopy(msg: ClientMsg): boolean {
    if (msg.t === 'create_job') return msg.worktree === true;
    if (msg.t === 'bring_job_changes' || msg.t === 'discard_changes' || msg.t === 'bring_back_undone') return true; // the house's files: the same git work
    if (msg.t === 'delete_job') return !!store.job(msg.projectId, msg.jobId)?.worktree;
    return false;
  }

  const store: Store = {
    state,
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    send,
    request<T = unknown>(msg: ClientMsg & { reqId: string }, opts?: RequestOptions): Promise<T> {
      const reqId = msg.reqId || newReqId();
      const out = { ...msg, reqId };
      const copyWork = touchesCopy(out);
      const timeout = copyWork
        ? COPY_TIMEOUT_MS
        : out.t === 'fs_list' ? FS_LIST_TIMEOUT_MS : OMP_REQUESTS.has(out.t) ? OMP_TIMEOUT_MS : (SLOW_TIMEOUT_MS[out.t] ?? REQUEST_TIMEOUT_MS);
      // offline for a while: say so now, not after the timeout (nothing went out, so it can simply be tried again)
      if (offlineLong()) return Promise.reject(new RequestError(OFFLINE_TEXT, reqId));
      const promise = requests.track<T>(reqId, timeout, false, copyWork ? COPY_TIMEOUT_TEXT : undefined);
      if (enqueue(JSON.stringify(out), reqId)) requests.markSent(reqId);
      if (opts?.onSlow) {
        const onSlow = opts.onSlow;
        const timer = setTimeout(() => onSlow(), STILL_WORKING_MS);
        const done = () => clearTimeout(timer);
        promise.then(done, done);
      }
      return promise;
    },
    setLocal(patch) {
      const next = { ...patch };
      if ('currentProjectId' in next && next.currentProjectId !== state.currentProjectId && next.currentProjectId) {
        // Changing house: restore the job picked there last time (or fall back to its 'main' job).
        if (jobOwner && state.currentJobId) jobMemory.set(jobOwner, state.currentJobId);
        if (!('currentJobId' in next)) next.currentJobId = jobMemory.get(next.currentProjectId) ?? null;
        jobOwner = next.currentProjectId;
      } else if ('currentProjectId' in next && next.currentProjectId) {
        jobOwner = next.currentProjectId;
      }
      if ('currentJobId' in next) {
        const owner = next.currentProjectId ?? state.currentProjectId ?? jobOwner;
        if (owner && next.currentJobId) jobMemory.set(owner, next.currentJobId);
        jobOwner = owner;
      }
      Object.assign(state, next);
      notify();
    },
    project(id) {
      if (!id) return undefined;
      return state.city.projects.find((p) => p.id === id);
    },
    workflowsOf(projectId) {
      return workflowsOf(state, projectId);
    },
    workflowOf(projectId, id) {
      return workflowOf(state, projectId, id);
    },
    agentsOf(projectId) {
      const project = store.project(projectId);
      const wf = workflowOf(state, projectId, project?.workflowId);
      const order = wf?.steps.map((s) => s.id) ?? [];
      return Object.values(state.agents)
        .filter((a) => a.projectId === projectId)
        .sort((a, b) => agentOrder(a, b, order));
    },
    jobsOf(projectId) {
      return state.jobs[projectId] ?? [];
    },
    job(projectId, jobId) {
      if (!jobId) return undefined;
      return state.jobs[projectId]?.find((j) => j.id === jobId);
    },
    agentsOfJob(projectId, jobId) {
      const job = store.job(projectId, jobId);
      const project = store.project(projectId);
      const wfId = job ? job.workflowId : project?.workflowId;
      const wf = workflowOf(state, projectId, wfId);
      const order = wf?.steps.map((s) => s.id) ?? [];
      // A run's temporary people (another workflow, a one-off team: roleId "x-…") line up in the run's order.
      for (const r of Object.values(state.runs)) {
        if (r.projectId !== projectId || (r.jobId ?? MAIN_JOB) !== jobId || (r.status !== 'running' && r.status !== 'waiting_approval')) continue;
        for (const m of r.team ?? []) if (!order.includes(m.id)) order.push(m.id);
      }
      const all = Object.values(state.agents).filter((a) => a.projectId === projectId);
      const inJob = (a: AgentInfo): boolean => (a.jobId ?? MAIN_JOB) === jobId;
      // Helpers inherit their parent's job; older servers may not stamp jobId on them.
      return all
        .filter((a) => inJob(a) || (a.kind === 'subagent' && !a.jobId && !!a.parentId && !!state.agents[a.parentId] && inJob(state.agents[a.parentId])))
        .sort((a, b) => agentOrder(a, b, order));
    },
    activeJob(projectId) {
      const jobs = state.jobs[projectId] ?? [];
      if (!jobs.length) return undefined;
      const wanted = projectId === (state.currentProjectId ?? jobOwner) ? state.currentJobId : jobMemory.get(projectId);
      const pick = (id: string | null | undefined): Job | undefined => (id ? jobs.find((j) => j.id === id) : undefined);
      return pick(wanted) ?? pick(jobMemory.get(projectId)) ?? pick(MAIN_JOB) ?? jobs[0];
    },
  };
  return store;
}
