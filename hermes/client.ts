// The CAST side of the Hermes Agent bridge: a paired device session (POST /api/pair, kept in the bridge's own folder)
// and one live /ws connection that mirrors what the web app sees — houses, jobs, people, approval and question cards,
// plan cards and team runs. The MCP server (mcp.ts) and the notifier (notify.ts) each run on one.
//
// The bridge is a script client of CAST: it sends no Origin header (auth.ts originAllowed) and signs in with the
// `rlt_session` cookie it got when it paired. A session CAST revoked (Settings → Devices) stays revoked: the bridge
// never pairs again on its own; `cast-hermes pair` does, and a running bridge picks up the new session file on its
// next reconnect.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentInfo, ApprovalRequest, ClientMsg, CityState, Job, ServerMsg, TeamPlan, TranscriptItem, WorkflowRun } from '../shared/protocol';
import { WS_PATH } from '../shared/protocol';
import { errorMessage, writeFileAtomic } from '../server/util';

/** How the bridge shows up in Settings → Devices. */
export const DEVICE_NAME = 'Hermes Agent';

export interface Session {
  url: string; // CAST's address, e.g. http://127.0.0.1:4860 (no trailing slash)
  cookie: string; // "rlt_session=…"
  deviceId?: string;
  pairedAt: number;
}

/** Where the bridge keeps its session and notifier state: $CAST_HERMES_HOME, else ~/.config/cast-hermes. */
export function stateDir(env: Record<string, string | undefined> = process.env): string {
  const own = env.CAST_HERMES_HOME?.trim();
  if (own) return own;
  return join(env.XDG_CONFIG_HOME?.trim() || join(env.HOME || homedir(), '.config'), 'cast-hermes');
}

export function ensureStateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

const sessionFile = (dir: string) => join(dir, 'session.json');

export function loadSession(dir: string): Session | null {
  const file = sessionFile(dir);
  if (!existsSync(file)) return null;
  try {
    const s = JSON.parse(readFileSync(file, 'utf8')) as Partial<Session>;
    if (typeof s.url !== 'string' || typeof s.cookie !== 'string' || !/^rlt_session=[\w-]+$/.test(s.cookie)) return null;
    return { url: s.url, cookie: s.cookie, deviceId: typeof s.deviceId === 'string' ? s.deviceId : undefined, pairedAt: Number(s.pairedAt) || 0 };
  } catch {
    return null;
  }
}

export function baseUrl(url: string): string {
  const u = new URL(url.trim());
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`Not a CAST address: ${url}`);
  return u.origin;
}

/** Trade a pairing token, a pairing link or a one-time code (Settings → Pair a phone) for a session and save it. */
export async function pair(dir: string, url: string, input: string, fetchFn: typeof fetch = fetch): Promise<Session> {
  const base = baseUrl(url);
  let res: Response;
  try {
    res = await fetchFn(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ token: input.trim(), device: DEVICE_NAME }),
      redirect: 'manual',
    });
  } catch (err) {
    throw new Error(`CAST did not answer at ${base}: ${errorMessage(err)}`);
  }
  const body = (await res.json().catch(() => null)) as { cookie?: unknown; deviceId?: unknown; error?: unknown } | null;
  if (res.status === 429) throw new Error('Too many wrong tries from this address: wait a minute, then try again.');
  if (!res.ok || typeof body?.cookie !== 'string') {
    const why = typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`;
    throw new Error(`CAST refused to pair (${why}). Use the pairing token, a pairing link, or a fresh code from Settings → Pair a phone.`);
  }
  const session: Session = { url: base, cookie: body.cookie, deviceId: typeof body.deviceId === 'string' ? body.deviceId : undefined, pairedAt: Date.now() };
  ensureStateDir(dir);
  writeFileAtomic(sessionFile(dir), `${JSON.stringify(session, null, 2)}\n`, 0o600);
  return session;
}

export type Logger = (...args: unknown[]) => void;

/** stdout belongs to the MCP protocol: the bridge logs to stderr only. */
export const stderrLog: Logger = (...args) => {
  const ts = new Date().toISOString().slice(11, 19);
  console.error(`[${ts}] cast-hermes`, ...args);
};

interface Waiter<T> {
  resolve: (v: T) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type Ack = Extract<ServerMsg, { t: 'ack' }>;
type DropReqId<M> = M extends unknown ? ('reqId' extends keyof M ? Omit<M, 'reqId'> : never) : never;
/** A client message that takes a reqId (required or optional), without it: CastLink.request adds one. */
export type Requestable = DropReqId<ClientMsg>;

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const REQUEST_TIMEOUT_MS = 30_000;

/** One live connection to CAST, reconnecting with backoff, and the town as CAST last described it. */
export class CastLink {
  city: CityState = { lots: [], projects: [] };
  jobs: Job[] = [];
  readonly agents = new Map<string, AgentInfo>();
  readonly approvals = new Map<string, ApprovalRequest>();
  readonly plans = new Map<string, TeamPlan>();
  readonly runs = new Map<string, WorkflowRun>();
  /** CAST's address of the session in use ('' before the first one is read). */
  url = '';

  #ws: WebSocket | null = null;
  #synced = false; // a snapshot arrived on the current connection
  #stopped = false;
  #retryMs = RECONNECT_MIN_MS;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #problem = 'Connecting to CAST…';
  #seq = 0;
  #acks = new Map<string, Waiter<Ack>>();
  #transcripts = new Map<string, Waiter<TranscriptItem[]>[]>();
  #ready: { resolve: () => void; reject: (e: Error) => void }[] = [];
  /** Not paired, or signed out: waiting won't help until someone pairs the bridge again. */
  #stuck = false;
  #listeners = new Set<(msg: ServerMsg) => void>();

  constructor(
    private readonly dir: string,
    private readonly log: Logger = stderrLog,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  start(): void {
    this.#stopped = false;
    this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    clearTimeout(this.#retryTimer ?? undefined);
    this.#ws?.close();
    this.#ws = null;
    this.#failAll(new Error('The bridge is shutting down.'));
  }

  get connected(): boolean {
    return this.#synced;
  }

  /** Why the bridge isn't connected (for tool answers). */
  get problem(): string {
    return this.#problem;
  }

  /** Every message CAST sends, after the mirror took it in. */
  on(fn: (msg: ServerMsg) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  /** Resolves once the mirror holds CAST's snapshot; rejects with the reason after `ms`, or at once when the bridge
   *  isn't paired or was signed out. */
  ready(ms = 10_000): Promise<void> {
    if (this.#synced) return Promise.resolve();
    if (this.#stuck) return Promise.reject(new Error(this.#problem));
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const entry = { resolve: () => (clearTimeout(timer), resolve()), reject: (e: Error) => (clearTimeout(timer), reject(e)) };
    const timer = setTimeout(() => {
      this.#ready = this.#ready.filter((r) => r !== entry);
      reject(new Error(this.#problem));
    }, ms);
    this.#ready.push(entry);
    return promise;
  }

  #giveUp(problem: string): void {
    this.#problem = problem;
    this.#stuck = true;
    for (const r of this.#ready.splice(0)) r.reject(new Error(problem));
  }

  send(msg: ClientMsg): void {
    if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN || !this.#synced) throw new Error(this.#problem);
    this.#ws.send(JSON.stringify(msg));
  }

  /** Send a message with a reqId and wait for CAST's ack (rejects with CAST's own words when it says no). */
  async request(msg: Requestable, ms = REQUEST_TIMEOUT_MS): Promise<Ack> {
    const reqId = `h${++this.#seq}-${Date.now().toString(36)}`;
    const { promise, resolve, reject } = Promise.withResolvers<Ack>();
    const timer = setTimeout(() => {
      this.#acks.delete(reqId);
      reject(new Error('CAST did not answer in time.'));
    }, ms);
    this.#acks.set(reqId, { resolve, reject, timer });
    try {
      this.send({ ...msg, reqId } as ClientMsg);
    } catch (err) {
      clearTimeout(timer);
      this.#acks.delete(reqId);
      throw err;
    }
    const ack = await promise;
    if (!ack.ok) throw new Error(ack.error || 'CAST refused that.');
    return ack;
  }

  /** A person's current chat as CAST keeps it. */
  transcript(agentId: string, ms = 15_000): Promise<TranscriptItem[]> {
    const { promise, resolve, reject } = Promise.withResolvers<TranscriptItem[]>();
    const drop = (w: Waiter<TranscriptItem[]>) => {
      const rest = (this.#transcripts.get(agentId) ?? []).filter((x) => x !== w);
      if (rest.length) this.#transcripts.set(agentId, rest);
      else this.#transcripts.delete(agentId);
    };
    const w: Waiter<TranscriptItem[]> = {
      resolve,
      reject,
      timer: setTimeout(() => {
        drop(w);
        reject(new Error('CAST did not send the chat in time.'));
      }, ms),
    };
    this.#transcripts.set(agentId, [...(this.#transcripts.get(agentId) ?? []), w]);
    try {
      this.send({ t: 'get_transcript', agentId });
    } catch (err) {
      clearTimeout(w.timer);
      drop(w);
      reject(err);
    }
    return promise;
  }

  // ───────────────────────── connection ─────────────────────────

  #connect(): void {
    if (this.#stopped) return;
    const session = loadSession(this.dir);
    if (!session) {
      this.#giveUp(`The bridge isn't paired with CAST yet. Run: bun run hermes pair (state folder: ${this.dir})`);
      this.#later();
      return;
    }
    this.#stuck = false;
    this.url = session.url;
    const wsUrl = `${session.url.replace(/^http/, 'ws')}${WS_PATH}`;
    let opened = false;
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl, { headers: { cookie: session.cookie } } as unknown as string[]);
    } catch (err) {
      this.#problem = `Could not open a connection to CAST at ${session.url}: ${errorMessage(err)}`;
      this.#later();
      return;
    }
    this.#ws = ws;
    ws.onopen = () => {
      opened = true;
    };
    ws.onmessage = (ev) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMsg;
      } catch {
        return;
      }
      this.#apply(msg);
    };
    ws.onclose = () => {
      if (this.#ws !== ws) return;
      this.#ws = null;
      const wasSynced = this.#synced;
      this.#synced = false;
      this.#failAll(new Error('The connection to CAST dropped; try again in a moment.'));
      if (this.#stopped) return;
      if (wasSynced) {
        this.#problem = `Reconnecting to CAST at ${session.url}…`;
        this.log('connection to CAST closed; reconnecting');
        this.#retryMs = RECONNECT_MIN_MS;
        this.#later();
        return;
      }
      void this.#diagnose(session, opened).then(() => this.#later());
    };
  }

  /** The socket closed before CAST sent the town: tell "not running" from "signed out". */
  async #diagnose(session: Session, opened: boolean): Promise<void> {
    try {
      const res = await this.fetchFn(`${session.url}/api/session`, { headers: { cookie: session.cookie, accept: 'application/json' } });
      if (res.status === 401 || res.status === 403) {
        this.#giveUp(`CAST at ${session.url} signed this bridge out (Settings → Devices). Pair it again: bun run hermes pair`);
      } else {
        this.#problem = `CAST at ${session.url} answered but closed the live connection${opened ? '' : ' before it opened'} (HTTP ${res.status} on /api/session).`;
      }
    } catch (err) {
      this.#problem = `CAST is not reachable at ${session.url} (${errorMessage(err)}). Is it running?`;
    }
    this.log(this.#problem);
  }

  #later(): void {
    if (this.#stopped || this.#retryTimer) return;
    const ms = this.#retryMs;
    this.#retryMs = Math.min(this.#retryMs * 2, RECONNECT_MAX_MS);
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      this.#connect();
    }, ms);
    (this.#retryTimer as { unref?: () => void }).unref?.();
  }

  #failAll(err: Error): void {
    for (const w of this.#acks.values()) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    this.#acks.clear();
    for (const list of this.#transcripts.values()) {
      for (const w of list) {
        clearTimeout(w.timer);
        w.reject(err);
      }
    }
    this.#transcripts.clear();
  }

  // ───────────────────────── the mirror ─────────────────────────

  #apply(msg: ServerMsg): void {
    switch (msg.t) {
      case 'snapshot': {
        this.city = msg.city;
        this.jobs = msg.jobs;
        this.agents.clear();
        for (const a of msg.agents) this.agents.set(a.id, a);
        this.approvals.clear();
        for (const a of msg.approvals) this.approvals.set(a.id, a);
        this.plans.clear();
        for (const p of msg.plans) if (p.status === 'pending') this.plans.set(p.id, p);
        this.runs.clear();
        for (const r of msg.runs) this.runs.set(r.id, r);
        this.#synced = true;
        this.#retryMs = RECONNECT_MIN_MS;
        this.#problem = '';
        this.#stuck = false;
        for (const r of this.#ready.splice(0)) r.resolve();
        break;
      }
      case 'city':
        this.city = msg.city;
        break;
      case 'jobs':
        this.jobs = [...this.jobs.filter((j) => j.projectId !== msg.projectId), ...msg.jobs];
        break;
      case 'agent':
        this.agents.set(msg.agent.id, msg.agent);
        break;
      case 'agent_removed':
        this.agents.delete(msg.agentId);
        break;
      case 'approval':
        this.approvals.set(msg.approval.id, msg.approval);
        break;
      case 'approval_resolved':
        this.approvals.delete(msg.id);
        break;
      case 'plan':
        if (msg.plan.status === 'pending') this.plans.set(msg.plan.id, msg.plan);
        else this.plans.delete(msg.plan.id);
        break;
      case 'run':
        this.runs.set(msg.run.id, msg.run);
        break;
      case 'transcript_reset': {
        const list = this.#transcripts.get(msg.agentId);
        if (list) {
          this.#transcripts.delete(msg.agentId);
          for (const w of list) {
            clearTimeout(w.timer);
            w.resolve(msg.items);
          }
        }
        break;
      }
      case 'ack': {
        const w = this.#acks.get(msg.reqId);
        if (w) {
          this.#acks.delete(msg.reqId);
          clearTimeout(w.timer);
          w.resolve(msg);
        }
        break;
      }
      case 'error':
        this.log('CAST:', msg.message);
        break;
    }
    for (const fn of this.#listeners) {
      try {
        fn(msg);
      } catch (err) {
        this.log('listener failed:', errorMessage(err));
      }
    }
  }
}
