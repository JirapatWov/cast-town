// What the CAST menu-bar app for the Mac asks this server (contract: shared/app-status.ts). Both routes are signed in
// (the app pairs with POST /api/pair, device kind 'app'):
//   GET  /api/status      the menu's status line, badge and attention list. Built from what is in memory only — no
//                         omp, no disk — because the app asks every few seconds.
//   POST /api/login-link  a one-time sign-in link for a browser on this machine ("Open CAST", "Pair a phone…", an
//                         attention item). It reuses the one-time pairing codes of Settings → Pair a phone (single use,
//                         10 minutes, 144 bits), points at this server's own loopback address and lands on `next`, a
//                         same-origin path: anything that could leave this server (another host, `//host`, `\`, a
//                         scheme) is refused, so the link can never redirect elsewhere. The browser gets its own device
//                         session; one already signed in keeps its session (auth.ts).
import { approvalLine, isQuestion } from '../shared/ask';
import { MAX_ATTENTION, type AppOmpState, type AppStatus, type AttentionItem, type LoginLink } from '../shared/app-status';
import { ompCoreVersion, OMP_TESTED_VERSION } from '../shared/omp-version';
import { liveProviders } from '../shared/live-providers';
import type { AgentsHealth, CityState } from '../shared/protocol';
import { originAllowed } from './auth';
import type { AgentSnapshot, AgentSystem } from './contracts';
import type { DeviceBook } from './devices';
import { PROBE_ORIGIN, readTextCapped, safeNext } from './util';

export { safeNext };

const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const json = (data: unknown, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...extra } });

const BODY_MAX = 4096;
const TITLE_MAX = 140;

// ───────────────────────── one-time sign-in links ─────────────────────────

/** Where a browser on this machine reaches this server: the bound address, with the "every interface" binds and an
 *  empty host turned into 127.0.0.1 (IPv6 in brackets). */
export function loopbackBase(host: string, port: number): string {
  const h = host.trim().replace(/^\[|\]$/g, '');
  if (!h || h === '0.0.0.0' || h === '::' || h === '::0') return `http://127.0.0.1:${port}`;
  return h.includes(':') ? `http://[${h}]:${port}` : `http://${h}:${port}`;
}

/** `base` + `next` (a safeNext path) with the one-time code as `?token=` (before the fragment, which the browser keeps
 *  through the sign-in redirect). The origin is always base's: only the path, query and fragment come from `next`. */
export function loginLinkUrl(base: string, next: string, code: string): string {
  const u = new URL(base);
  const n = new URL(next, PROBE_ORIGIN);
  u.pathname = n.pathname;
  u.search = n.search;
  u.searchParams.set('token', code);
  u.hash = n.hash;
  return u.href;
}

// ───────────────────────── status ─────────────────────────

/** True when omp `version` is older than the tested release (x.y.z compared as numbers). */
export function ompTooOld(version: string | null | undefined, tested: string = OMP_TESTED_VERSION): boolean {
  const a = version ? ompCoreVersion(version) : null;
  const b = ompCoreVersion(tested);
  if (!a || !b) return false;
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! < y[i]!;
  return false;
}

export function appOmpState(health: AgentsHealth | undefined, version: string | null): AppOmpState {
  if (!health) return 'ok'; // no checks (the dev stub): everything counts as fine, like the app does
  if (health.omp === 'checking') return 'checking';
  if (health.omp === 'missing') return 'missing';
  if (health.omp === 'failed') return 'error';
  return ompTooOld(version) ? 'too-old' : 'ok';
}

const oneLine = (s: string, max = TITLE_MAX) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** Opens CAST at that house (the web app's `#/house/<id>[/<job>]` route). */
export function houseNext(projectId: string, jobId?: string): string {
  const base = `/#/house/${encodeURIComponent(projectId)}`;
  return jobId && jobId !== 'main' ? `${base}/${encodeURIComponent(jobId)}` : base;
}

export interface StatusInput {
  version: string;
  cityName: string;
  url: string;
  uptimeSec: number;
  snapshot: Pick<AgentSnapshot, 'agents' | 'approvals' | 'plans' | 'runs' | 'providers' | 'models'>;
  projects: { id: string; name: string }[];
  health?: AgentsHealth;
  ompVersion: string | null;
  demo: boolean;
  /** agent id → when it was first seen in 'error' (kept by the caller between polls; updated here). */
  errorSince: Map<string, number>;
  now: number;
}

export interface AttentionInput {
  snapshot: Pick<AgentSnapshot, 'agents' | 'approvals' | 'plans'>;
  projects: { id: string; name: string }[];
  /** agent id → when it was first seen in 'error' (kept by the caller between calls; updated here). */
  errorSince: Map<string, number>;
  now: number;
}

/** Who needs the user, newest first (approval and question cards, pending plans, people stopped with an error), how
 *  many people wait, and how many answers the user owes. Shared by GET /api/status (the Mac menu bar) and Web Push
 *  (server/push/notifier.ts), so both count the same things. */
export function attentionOf(i: AttentionInput): { attention: AttentionItem[]; needsYou: number; approvalsWaiting: number } {
  const { agents, approvals, plans } = i.snapshot;
  const byId = new Map(agents.map((a) => [a.id, a]));
  const houseName = new Map(i.projects.map((p) => [p.id, p.name]));
  const house = (id: string) => houseName.get(id) ?? 'a house';
  const attention: AttentionItem[] = [];
  const waiting = new Set<string>();

  for (const a of approvals) {
    waiting.add(a.agentId);
    const person = byId.get(a.agentId);
    attention.push({
      kind: isQuestion(a) ? 'question' : 'approval',
      house: house(a.projectId),
      person: person?.name ?? 'Someone',
      title: oneLine(approvalLine(a) || 'Needs your OK'),
      since: a.ts,
      id: `approval:${a.id}`,
      houseId: a.projectId,
      personId: a.agentId,
      next: houseNext(a.projectId, person?.jobId),
    });
  }
  for (const p of plans) {
    if (p.status !== 'pending') continue;
    waiting.add(p.agentId);
    attention.push({
      kind: 'approval',
      house: house(p.projectId),
      person: byId.get(p.agentId)?.name ?? 'The lead',
      title: oneLine(`Plan: ${p.title}`),
      since: p.ts,
      id: `plan:${p.id}`,
      houseId: p.projectId,
      personId: p.agentId,
      next: houseNext(p.projectId, p.jobId),
    });
  }
  const failed = new Set<string>();
  for (const a of agents) {
    if (a.status !== 'error') continue;
    failed.add(a.id);
    if (!i.errorSince.has(a.id)) i.errorSince.set(a.id, i.now);
    attention.push({
      kind: 'error',
      house: house(a.projectId),
      person: a.name,
      title: oneLine(a.detail || 'Stopped with an error'),
      since: i.errorSince.get(a.id)!,
      id: `error:${a.id}`,
      houseId: a.projectId,
      personId: a.id,
      next: houseNext(a.projectId, a.jobId),
    });
  }
  for (const id of [...i.errorSince.keys()]) if (!failed.has(id)) i.errorSince.delete(id);
  attention.sort((x, y) => y.since - x.since || x.id.localeCompare(y.id));
  return { attention, needsYou: waiting.size, approvalsWaiting: approvals.length + plans.filter((p) => p.status === 'pending').length };
}

export function buildStatus(i: StatusInput): AppStatus {
  const { agents, runs, providers, models } = i.snapshot;
  const { attention, needsYou, approvalsWaiting } = attentionOf(i);
  const version = i.ompVersion ?? undefined;
  return {
    app: 'cast',
    version: i.version,
    cityName: i.cityName,
    url: i.url,
    uptimeSec: i.uptimeSec,
    agents: {
      total: agents.length,
      working: agents.filter((a) => a.status === 'busy' || a.status === 'starting').length,
      needsYou,
    },
    approvalsWaiting,
    runsActive: runs.filter((r) => r.status === 'running' || r.status === 'waiting_approval').length,
    houses: i.projects.length,
    omp: { state: appOmpState(i.health, i.ompVersion), ...(version ? { version } : {}) },
    // counted as the page counts them (a custom provider's models count too), so the menu bar and the page's
    // "Connect AI" never disagree on whether anybody can work
    models: { connected: liveProviders({ providers, models }), state: i.health?.models ?? 'ok', demo: i.demo },
    attention: attention.slice(0, MAX_ATTENTION),
  };
}

// ───────────────────────── routes ─────────────────────────

export interface AppRouteDeps {
  version: string;
  cityName: string;
  host: string;
  /** The port the server listens on (known once it does). */
  port: () => number;
  allowedOrigins: string[];
  startedAt: number;
  agents: Pick<AgentSystem, 'snapshot' | 'ompVersion' | 'demoMode'> & Partial<Pick<AgentSystem, 'health'>>;
  city: { get(): Pick<CityState, 'projects'> };
  devices: Pick<DeviceBook, 'newPairCode'>;
  now?: () => number;
}

export function createAppRoutes(d: AppRouteDeps): (req: Request, url: URL) => Promise<Response> | null {
  const now = d.now ?? Date.now;
  const errorSince = new Map<string, number>();

  function status(): AppStatus {
    const t = now();
    return buildStatus({
      version: d.version,
      cityName: d.cityName,
      url: `${loopbackBase(d.host, d.port())}/`,
      uptimeSec: Math.max(0, Math.round((t - d.startedAt) / 1000)),
      snapshot: d.agents.snapshot(),
      projects: d.city.get().projects,
      health: d.agents.health?.(),
      ompVersion: d.agents.ompVersion(),
      demo: d.agents.demoMode(),
      errorSince,
      now: t,
    });
  }

  async function loginLink(req: Request): Promise<Response> {
    if (!originAllowed(req, d.allowedOrigins)) return json({ error: 'Forbidden: cross-origin request' }, 403);
    const text = await readTextCapped(req, BODY_MAX).catch(() => '');
    if (text === null) return json({ error: 'Request too large' }, 413);
    let body: unknown = {};
    if (text.trim()) {
      try {
        body = JSON.parse(text);
      } catch {
        return json({ error: 'Send JSON like {"next": "/?settings=pair"}' }, 400);
      }
    }
    const raw = body && typeof body === 'object' && !Array.isArray(body) ? (body as { next?: unknown }).next : undefined;
    const next = safeNext(raw);
    if (next === null) return json({ error: '“next” must be a path on this server, like /?settings=pair' }, 400);
    const { code, expiresAt } = d.devices.newPairCode();
    const out: LoginLink = { url: loginLinkUrl(loopbackBase(d.host, d.port()), next, code), expiresAt };
    return json(out);
  }

  return (req, url) => {
    if (url.pathname === '/api/status') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return Promise.resolve(json({ error: 'Method not allowed' }, 405, { allow: 'GET' }));
      const t0 = performance.now();
      const body = status();
      // how long building it took (the contract wants it cheap): visible to the app and to tests
      const res = json(body, 200, { 'server-timing': `status;dur=${(performance.now() - t0).toFixed(2)}` });
      return Promise.resolve(req.method === 'HEAD' ? new Response(null, { headers: res.headers }) : res);
    }
    if (url.pathname === '/api/login-link') {
      if (req.method !== 'POST') return Promise.resolve(json({ error: 'Use POST with {"next": "/…"}' }, 405, { allow: 'POST' }));
      return loginLink(req);
    }
    return null;
  };
}
