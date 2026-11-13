// The Mac menu-bar app's two routes (server/app-routes.ts, contract shared/app-status.ts): GET /api/status is built from
// memory only and has the contract's shape; POST /api/login-link mints a one-time link that works once, expires after
// 10 minutes, points at this server's loopback address and lands only on a path of this server (no open redirect).
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_ATTENTION, type AppStatus } from '../../shared/app-status';
import type { AgentInfo, ApprovalRequest, ProviderStatus, TeamPlan, WorkflowRun } from '../../shared/protocol';
import { appOmpState, buildStatus, createAppRoutes, houseNext, loginLinkUrl, loopbackBase, ompTooOld, safeNext, type StatusInput } from '../../server/app-routes';
import { createAuth, MENU_BAR_DEVICE_NAME, pairKind } from '../../server/auth';
import type { AgentSnapshot } from '../../server/contracts';
import { PAIR_CODE_TTL_MS } from '../../server/devices';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'cast-mac-routes-'));
  roots.push(d);
  return d;
}

function agent(o: Partial<AgentInfo> & Pick<AgentInfo, 'id' | 'projectId'>): AgentInfo {
  return {
    jobId: 'main', kind: 'resident', name: 'Assistant', roleId: 'assistant', model: 'anthropic/claude-opus-5-5', modelLabel: 'Claude Opus 5.5', vendor: 'anthropic',
    demo: false, status: 'idle', activity: 'idle', appearance: { seed: 1, gender: 'f' }, ...o,
  } as AgentInfo;
}
function approval(o: Partial<ApprovalRequest> & Pick<ApprovalRequest, 'id' | 'agentId' | 'projectId' | 'ts'>): ApprovalRequest {
  return { tool: 'bash', title: 'Allow tool: bash', options: ['Approve', 'Deny'], ...o };
}
function plan(o: Partial<TeamPlan> & Pick<TeamPlan, 'id' | 'agentId' | 'projectId' | 'ts'>): TeamPlan {
  return { jobId: 'main', title: 'Code review team', task: 't', steps: [], status: 'pending', ...o };
}
const run = (id: string, status: WorkflowRun['status']) => ({ id, status }) as WorkflowRun;
const provider = (vendor: string, connected: boolean) => ({ vendor, label: vendor, connected, how: '' }) as ProviderStatus;

function input(snapshot: Partial<StatusInput['snapshot']> = {}, over: Partial<StatusInput> = {}): StatusInput {
  return {
    version: '0.1.0', cityName: 'Studio', url: 'http://127.0.0.1:4860/', uptimeSec: 12,
    snapshot: { agents: [], approvals: [], plans: [], runs: [], providers: [], models: [], ...snapshot },
    projects: [{ id: 'todo', name: 'Todo API' }, { id: 'novel', name: 'Moonlight' }],
    health: { omp: 'ok', ompPath: 'omp', models: 'ok', checking: false },
    ompVersion: '18.13.2', demo: false, errorSince: new Map(), now: 1_000_000, ...over,
  };
}

describe('GET /api/status: the contract', () => {
  test('an idle town: every field of the contract, nothing else needed', () => {
    const s = buildStatus(input({ agents: [agent({ id: 'a1', projectId: 'todo' })] }));
    expect(s).toEqual({
      app: 'cast', version: '0.1.0', cityName: 'Studio', url: 'http://127.0.0.1:4860/', uptimeSec: 12,
      agents: { total: 1, working: 0, needsYou: 0 }, approvalsWaiting: 0, runsActive: 0, houses: 2,
      omp: { state: 'ok', version: '18.13.2' }, models: { connected: 0, state: 'ok', demo: false }, attention: [],
    } satisfies AppStatus);
  });

  test('models.demo stays in the contract (older Mac apps read it): true only with the scripted test model', () => {
    expect(buildStatus(input()).models).toEqual({ connected: 0, state: 'ok', demo: false }); // nothing connected: not "demo"
    expect(buildStatus(input({}, { demo: true })).models).toEqual({ connected: 0, state: 'ok', demo: true }); // CAST_MOCK_LLM
  });

  test('models.state: the account check, so the app says "none connected" only once a check worked', () => {
    const health = (models: 'checking' | 'ok' | 'stale' | 'failed') => ({ omp: 'ok' as const, ompPath: 'omp', models, checking: models === 'checking' });
    for (const m of ['checking', 'ok', 'stale', 'failed'] as const) expect(buildStatus(input({}, { health: health(m) })).models.state).toBe(m);
    expect(buildStatus(input({}, { health: undefined })).models.state).toBe('ok'); // no checks (the dev stub)
  });

  test('models.connected counts accounts as the page does: a custom provider\'s available models count too', () => {
    const model = (vendor: string, available: boolean) => ({ id: `${vendor}/m`, vendor, available }) as unknown as AgentSnapshot['models'][number];
    expect(buildStatus(input({ models: [model('local', false)] })).models.connected).toBe(0); // none: the menu says so
    expect(buildStatus(input({ models: [model('local', true), model('ollama', true)] })).models.connected).toBe(2);
    expect(buildStatus(input({ providers: [provider('anthropic', true)], models: [model('local', true)] })).models.connected).toBe(1);
  });

  test('working, waiting people, approvals, questions, plans, runs and connected providers are counted', () => {
    const agents = [
      agent({ id: 'a1', projectId: 'todo', status: 'busy' }),
      agent({ id: 'a2', projectId: 'todo', status: 'starting', name: 'Decoder', jobId: 'side' }),
      agent({ id: 'a3', projectId: 'novel', status: 'idle', name: 'Writer' }),
      agent({ id: 'a4', projectId: 'novel', status: 'offline', name: 'Lead' }),
    ];
    const s = buildStatus(input({
      agents,
      approvals: [
        approval({ id: 'r1', agentId: 'a1', projectId: 'todo', ts: 100 }),
        approval({ id: 'r2', agentId: 'a1', projectId: 'todo', ts: 300, tool: 'edit', title: 'Allow tool: edit' }),
        approval({ id: 'q1', agentId: 'a2', projectId: 'todo', ts: 200, tool: 'ask', title: 'Which database should I use?' }),
      ],
      plans: [plan({ id: 'p1', agentId: 'a4', projectId: 'novel', ts: 250 }), plan({ id: 'p2', agentId: 'a4', projectId: 'novel', ts: 50, status: 'approved' })],
      runs: [run('w1', 'running'), run('w2', 'waiting_approval'), run('w3', 'completed'), run('w4', 'failed')],
      providers: [provider('anthropic', true), provider('openai', true), provider('google', false)],
    }));
    expect(s.agents).toEqual({ total: 4, working: 2, needsYou: 3 }); // a1 (twice), a2, a4
    expect(s.approvalsWaiting).toBe(4); // three cards + one pending plan (the approved one is not waiting)
    expect(s.runsActive).toBe(2);
    expect(s.models).toEqual({ connected: 2, state: 'ok', demo: false });
    // newest first; questions told apart from approvals; plans count as approvals
    expect(s.attention.map((a) => [a.kind, a.person, a.house, a.title, a.since])).toEqual([
      ['approval', 'Assistant', 'Todo API', 'Allow tool: edit', 300],
      ['approval', 'Lead', 'Moonlight', 'Plan: Code review team', 250],
      ['question', 'Decoder', 'Todo API', 'Which database should I use?', 200],
      ['approval', 'Assistant', 'Todo API', 'Allow tool: bash', 100],
    ]);
    // the extras: stable ids and a path that opens CAST at the house (the person's job when it isn't Main)
    const q = s.attention.find((a) => a.kind === 'question')!;
    expect(q).toMatchObject({ id: 'approval:q1', houseId: 'todo', personId: 'a2', next: '/#/house/todo/side' });
    expect(safeNext(q.next)).toBe(q.next);
  });

  test('a person in error is an attention item whose "since" stays put between polls and clears when fixed', () => {
    const errorSince = new Map<string, number>();
    const broken = [agent({ id: 'a1', projectId: 'todo', status: 'error', detail: 'omp exited:\n  no credentials' })];
    const first = buildStatus(input({ agents: broken }, { errorSince, now: 5000 }));
    expect(first.attention).toEqual([
      { kind: 'error', house: 'Todo API', person: 'Assistant', title: 'omp exited: no credentials', since: 5000, id: 'error:a1', houseId: 'todo', personId: 'a1', next: '/#/house/todo' },
    ]);
    expect(buildStatus(input({ agents: broken }, { errorSince, now: 9000 })).attention[0]!.since).toBe(5000);
    expect(buildStatus(input({ agents: [agent({ id: 'a1', projectId: 'todo' })] }, { errorSince, now: 9500 })).attention).toEqual([]);
    expect(errorSince.size).toBe(0);
  });

  test('at most 10 attention items, newest first; long titles cut to one line', () => {
    const approvals = Array.from({ length: 14 }, (_, i) => approval({ id: `r${i}`, agentId: 'gone', projectId: 'deleted', ts: i, title: `Allow tool: bash ${'x'.repeat(300)}` }));
    const s = buildStatus(input({ approvals }));
    expect(s.attention.length).toBe(MAX_ATTENTION);
    expect(s.attention[0]!.since).toBe(13);
    expect(s.attention[0]!.person).toBe('Someone'); // the person left: still listed
    expect(s.attention[0]!.house).toBe('a house');
    expect(s.attention[0]!.title.length).toBeLessThanOrEqual(140);
    expect(s.approvalsWaiting).toBe(14);
  });

  test('omp state: checking, missing, error, too old, fine; no health (dev stub) counts as fine', () => {
    const h = (omp: 'checking' | 'ok' | 'missing' | 'failed') => ({ omp, ompPath: 'omp', models: 'ok' as const, checking: false });
    expect(appOmpState(h('checking'), null)).toBe('checking');
    expect(appOmpState(h('missing'), null)).toBe('missing');
    expect(appOmpState(h('failed'), '18.13.2')).toBe('error');
    expect(appOmpState(h('ok'), '18.13.2')).toBe('ok');
    expect(appOmpState(h('ok'), 'omp/18.13.2-cast.1')).toBe('ok');
    expect(appOmpState(h('ok'), '18.12.9')).toBe('too-old');
    expect(appOmpState(h('ok'), '19.0.0')).toBe('ok'); // newer: untested, not too old
    expect(appOmpState(undefined, null)).toBe('ok');
    expect(ompTooOld('17.99.99', '18.0.0')).toBe(true);
    expect(ompTooOld('garbage', '18.0.0')).toBe(false);
    const s = buildStatus(input({}, { health: h('missing'), ompVersion: null }));
    expect(s.omp).toEqual({ state: 'missing' }); // no version field without a version
  });
});

describe('POST /api/login-link: where the link may land', () => {
  test('same-origin paths are kept (query and fragment too), nothing → "/"', () => {
    expect(safeNext(undefined)).toBe('/');
    expect(safeNext('')).toBe('/');
    expect(safeNext('/')).toBe('/');
    expect(safeNext('/?settings=pair')).toBe('/?settings=pair');
    expect(safeNext('/#/house/todo-api')).toBe('/#/house/todo-api');
    expect(safeNext('/city/laptop/?2d')).toBe('/city/laptop/?2d=');
    expect(safeNext('/?settings=pair&token=stolen')).toBe('/?settings=pair'); // the link brings its own
    expect(safeNext('/a/../b')).toBe('/b');
  });

  test('anything that could leave this server is refused', () => {
    for (const bad of [
      'https://evil.example.com/', 'http://127.0.0.1:4860/', '//evil.example.com', '///evil.example.com', '/\\evil.example.com',
      '\\\\evil.example.com', '/..//evil.example.com', '/.//evil.example.com', 'javascript:alert(1)', 'evil.example.com', '?settings=pair',
      ' /', '/\tfoo', '/\nfoo', '/foo bar', 'x'.repeat(10), `/${'a'.repeat(3000)}`, 42, {}, ['/'], true,
    ]) {
      expect([bad, safeNext(bad)]).toEqual([bad, null]);
    }
  });

  test('the link always has the server\'s origin; only path, query and fragment come from next', () => {
    expect(loginLinkUrl('http://127.0.0.1:4860', '/?settings=pair', 'CODE')).toBe('http://127.0.0.1:4860/?settings=pair&token=CODE');
    expect(loginLinkUrl('http://127.0.0.1:4860', '/#/house/x', 'CODE')).toBe('http://127.0.0.1:4860/?token=CODE#/house/x');
    expect(new URL(loginLinkUrl('http://127.0.0.1:4860', '/%2F%2Fevil.example.com', 'C')).host).toBe('127.0.0.1:4860');
  });

  test('loopback address of the bound host', () => {
    expect(loopbackBase('127.0.0.1', 4860)).toBe('http://127.0.0.1:4860');
    expect(loopbackBase('0.0.0.0', 4861)).toBe('http://127.0.0.1:4861');
    expect(loopbackBase('::', 4862)).toBe('http://127.0.0.1:4862');
    expect(loopbackBase('', 4863)).toBe('http://127.0.0.1:4863');
    expect(loopbackBase('::1', 4864)).toBe('http://[::1]:4864');
    expect(loopbackBase('127.0.0.2', 4865)).toBe('http://127.0.0.2:4865');
    expect(houseNext('a b')).toBe('/#/house/a%20b');
  });
});

describe('the routes, with the real pairing codes', () => {
  function world() {
    let t = 1_700_000_000_000;
    const now = () => t;
    const auth = createAuth({ dataDir: tmp(), allowedUsers: [], allowedOrigins: [], now });
    const snapshot: AgentSnapshot = { agents: [agent({ id: 'a1', projectId: 'todo', status: 'busy' })], workflows: [], houseWorkflows: {}, library: [], runs: [], approvals: [], models: [], providers: [], plans: [] };
    let snapshots = 0;
    const routes = createAppRoutes({
      version: '0.1.0', cityName: 'Studio', host: '127.0.0.1', port: () => 4860, allowedOrigins: [], startedAt: t - 61_000,
      agents: { snapshot: () => (snapshots++, snapshot), ompVersion: () => '18.13.2', demoMode: () => false },
      city: { get: () => ({ projects: [{ id: 'todo', name: 'Todo API' } as never] }) },
      devices: auth.devices, now,
    });
    const call = (path: string, init?: RequestInit) => {
      const req = new Request(`http://127.0.0.1:4860${path}`, init);
      return routes(req, new URL(req.url));
    };
    const link = async (body: unknown, headers: Record<string, string> = {}) =>
      call('/api/login-link', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
    /** What a browser opening `url` gets from the auth check: a redirect (signed in), or a deny. */
    const open = (url: string, cookie?: string) => auth.check(new Request(url, { headers: { accept: 'text/html', ...(cookie ? { cookie } : {}) } }), new URL(url), { peer: '127.0.0.1' });
    return { auth, call, link, open, advance: (ms: number) => (t += ms), snapshots: () => snapshots };
  }

  test('status: GET only, JSON, no-store, cheap (one snapshot per call)', async () => {
    const w = world();
    const res = (await w.call('/api/status'))!;
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const s = (await res.json()) as AppStatus;
    expect(s).toMatchObject({ app: 'cast', uptimeSec: 61, houses: 1, agents: { total: 1, working: 1, needsYou: 0 }, url: 'http://127.0.0.1:4860/' });
    expect(w.snapshots()).toBe(1);
    expect((await w.call('/api/status', { method: 'POST' }))!.status).toBe(405);
    expect(w.call('/api/other')).toBeNull();
  });

  test('a login link signs a browser in once, lands on next, and is dead afterwards', async () => {
    const w = world();
    const res = (await w.link({ next: '/?settings=pair' }))!;
    expect(res.status).toBe(200);
    const { url, expiresAt } = (await res.json()) as { url: string; expiresAt: number };
    const u = new URL(url);
    expect(u.origin).toBe('http://127.0.0.1:4860');
    expect(u.searchParams.get('settings')).toBe('pair');
    expect(u.searchParams.get('token')!.length).toBeGreaterThanOrEqual(24); // 18 random bytes, base64url
    expect(u.searchParams.get('token')).not.toBe(w.auth.token); // never the pairing token itself
    expect(expiresAt).toBe(1_700_000_000_000 + PAIR_CODE_TTL_MS);

    const first = w.open(url);
    expect(first.kind).toBe('redirect');
    if (first.kind !== 'redirect') return;
    expect(first.location).toBe('/?settings=pair');
    expect(first.setCookie.some((c) => c.startsWith('rlt_session=') && !c.startsWith('rlt_session=;'))).toBe(true);
    expect(w.open(url)).toEqual({ kind: 'deny', reason: 'bad-token' }); // single use
  });

  test('a link expires after 10 minutes; no next lands on "/"; a body is optional', async () => {
    const w = world();
    const { url } = (await (await w.link(''))!.json()) as { url: string };
    expect(new URL(url).pathname).toBe('/');
    w.advance(PAIR_CODE_TTL_MS + 1000);
    expect(w.open(url)).toEqual({ kind: 'deny', reason: 'bad-token' });
    const fresh = (await (await w.link({}))!.json()) as { url: string };
    w.advance(PAIR_CODE_TTL_MS - 1000);
    expect(w.open(fresh.url).kind).toBe('redirect');
  });

  test('a browser already signed in keeps its session (no second device)', async () => {
    const w = world();
    const { secret } = w.auth.devices.create({ name: 'Safari on macOS' });
    const before = w.auth.devices.list().length;
    const { url } = (await (await w.link({ next: '/' }))!.json()) as { url: string };
    const d = w.open(url, `rlt_session=${secret}`);
    expect(d.kind === 'redirect' && d.setCookie[0]!.startsWith(`rlt_session=${secret};`)).toBe(true);
    expect(w.auth.devices.list().length).toBe(before);
  });

  test('refused: an open redirect, a cross-site page, a wrong method, bad JSON, a huge body', async () => {
    const w = world();
    for (const next of ['https://evil.example.com/', '//evil.example.com', '/..//evil.example.com']) {
      const res = (await w.link({ next }))!;
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain('path on this server');
    }
    expect((await w.link({ next: '/' }, { origin: 'http://evil.example.com' }))!.status).toBe(403);
    expect((await w.link({ next: '/' }, { origin: 'http://127.0.0.1:4860', host: '127.0.0.1:4860' }))!.status).toBe(200); // CAST's own page
    expect((await w.call('/api/login-link'))!.status).toBe(405);
    expect((await w.link('{not json'))!.status).toBe(400);
    expect((await w.link({ next: '/', pad: 'x'.repeat(5000) }))!.status).toBe(413);
  });
});

describe('pairing as the menu-bar app', () => {
  test('the contract\'s device name (or kind: "app") makes a kind "app" device; other names stay browsers', async () => {
    expect(pairKind({ device: MENU_BAR_DEVICE_NAME })).toBe('app');
    expect(pairKind({ device: 'my laptop', kind: 'app' })).toBe('app');
    expect(pairKind({ device: 'CAST menu bar' })).toBeUndefined();
    expect(pairKind({ kind: 'browser' })).toBeUndefined();

    const dataDir = tmp();
    const auth = createAuth({ dataDir, allowedUsers: [], allowedOrigins: [] });
    const pair = (body: unknown) => auth.pair(new Request('http://127.0.0.1:4860/api/pair', { method: 'POST', body: JSON.stringify(body) }), '127.0.0.1');
    const res = await pair({ token: auth.token, device: MENU_BAR_DEVICE_NAME });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deviceId: string; kind?: string; cookie: string };
    expect(body.kind).toBe('app');
    await pair({ token: auth.token, device: 'e2e script' });
    const list = auth.devices.list();
    expect(list.find((d) => d.id === body.deviceId)).toMatchObject({ name: MENU_BAR_DEVICE_NAME, kind: 'app' });
    expect(list.find((d) => d.name === 'e2e script')!.kind).toBeUndefined();
    // it survives a restart (devices.json keeps the kind)
    auth.devices.flush();
    const again = createAuth({ dataDir, allowedUsers: [], allowedOrigins: [] });
    expect(again.devices.get(body.deviceId)!.kind).toBe('app');
  });
});
