// Two real CAST servers (stub agents, separate data folders, free ports) and a fake upstream that records what it
// receives. A is the hub: B is added through POST /api/cities, then reached through A at /city/beta/ over HTTP and
// WebSocket. The fake city proves what the proxy forwards and drops (credentials, identity headers, Set-Cookie…).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server, ServerWebSocket, Subprocess } from 'bun';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CITY_PROXY_FEATURE } from '../../shared/cities';
import { pairWithServer } from '../../server/cities';

const ROOT = resolve(import.meta.dir, '../..');
const T = 90_000;
const root = mkdtempSync(join(tmpdir(), 'cast-cities-int-'));

interface Cast {
  name: string;
  port: number;
  url: string;
  dataDir: string;
  workspace: string;
  token: string;
  proc: Subprocess;
  logFile: string;
}

/** A bundle big enough for the server to gzip it. */
const bigJs = (name: string) => `// ${name}\n` + Array.from({ length: 3000 }, (_, i) => `export const v${i} = ${i} * 2; // ${name}`).join('\n');

async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
  const port = s.port!;
  s.stop(true);
  return port;
}

async function startCast(name: string, cityName: string, allowedUsers = 'nobody@invalid'): Promise<Cast> {
  const dir = join(root, name);
  const dataDir = join(dir, 'data');
  const workspace = join(dir, 'ws');
  const dist = join(dir, 'dist');
  for (const d of [dataDir, workspace, dist]) mkdirSync(d, { recursive: true });
  writeFileSync(join(dist, 'index.html'), `<!doctype html><title>CAST</title><p>CITY ${name.toUpperCase()}</p>`);
  mkdirSync(join(dist, 'assets'), { recursive: true });
  writeFileSync(join(dist, 'assets', 'big-a1b2c3d4e5.js'), bigJs(name));
  const port = await freePort();
  const logFile = join(dir, 'server.log');
  const proc = Bun.spawn(['bun', 'run', 'server/index.ts'], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: process.env.HOME ?? '/root',
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      RLT_PORT: String(port),
      RLT_HOST: '127.0.0.1',
      RLT_DATA_DIR: dataDir,
      RLT_WORKSPACE: workspace,
      RLT_FS_ROOTS: workspace,
      RLT_WEB_DIST: dist,
      RLT_STUB_AGENTS: '1',
      RLT_ALLOWED_USERS: allowedUsers,
      CAST_CITY_NAME: cityName,
      GIT_AUTHOR_NAME: 'cast-test', GIT_AUTHOR_EMAIL: 'test@localhost', GIT_COMMITTER_NAME: 'cast-test', GIT_COMMITTER_EMAIL: 'test@localhost',
    },
    stdout: Bun.file(logFile),
    stderr: Bun.file(logFile),
  });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const r = await fetch(`${url}/api/health`);
      if (r.ok && existsSync(join(dataDir, 'token'))) break;
    } catch {
      /* not yet */
    }
    if (Date.now() > deadline || proc.exitCode !== null) throw new Error(`${name} did not start: ${readFileSync(logFile, 'utf8').replace(/token=\S+/g, 'token=…').slice(-1500)}`);
    await Bun.sleep(200);
  }
  return { name, port, url, dataDir, workspace, token: readFileSync(join(dataDir, 'token'), 'utf8').trim(), proc, logFile };
}

// ── the fake city: answers like a CAST server and records every request it gets ──
interface Seen {
  method: string;
  path: string;
  headers: Record<string, string>;
}
const seen: Seen[] = [];
const wsSeen: Record<string, string>[] = [];
let fake: Server<undefined>;
const FAKE_COOKIE = 'rlt_session=FAKE1';
const FAKE_UPGRADED = 'rlt_session=FAKE2';

function startFake(port = 0): Server<undefined> {
  return Bun.serve<undefined>({
    hostname: '127.0.0.1',
    port,
    fetch(req, srv) {
      const u = new URL(req.url);
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => (headers[k] = v));
      seen.push({ method: req.method, path: u.pathname + u.search, headers });
      const cookie = req.headers.get('cookie');
      const ok = cookie === FAKE_COOKIE || cookie === FAKE_UPGRADED;
      const json = (d: unknown, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json', ...extra } });
      if (u.pathname === '/api/version') return json({ app: 'cast', version: '0.0.9', protocol: 1, features: [CITY_PROXY_FEATURE], instanceId: 'fake-instance', paired: ok, ...(ok ? { name: 'Fake' } : {}) });
      if (u.pathname === '/api/pair' && req.method === 'POST') return json({ cookie: FAKE_COOKIE, deviceId: 'd' });
      if (u.pathname.startsWith('/api/files/KEY/')) return new Response('<!doctype html><p>agent page', { headers: { 'content-type': 'text/html' } });
      if (!ok) return new Response('Forbidden: no-token\n', { status: 403 });
      if (u.pathname === '/ws') {
        wsSeen.push(headers);
        if (srv.upgrade(req)) return undefined;
        return new Response('no upgrade', { status: 426 });
      }
      if (u.pathname === '/redirect') {
        const h = new Headers({ location: '/landing?x=1' });
        h.append('set-cookie', 'evil=1; Path=/');
        h.append('set-cookie', 'rlt_token=EVIL; Path=/');
        h.set('strict-transport-security', 'max-age=31536000');
        return new Response(null, { status: 302, headers: h });
      }
      if (u.pathname === '/upgrade') return new Response('ok', { headers: { 'set-cookie': `${FAKE_UPGRADED}; Path=/; HttpOnly` } });
      if (u.pathname === '/echo-body') return req.arrayBuffer().then((b) => json({ bytes: b.byteLength, type: req.headers.get('content-type') }));
      return json({ path: u.pathname + u.search, headers });
    },
    websocket: {
      open(ws: ServerWebSocket<undefined>) {
        ws.send('hello from fake');
      },
      message(ws, msg) {
        if (msg === 'close-4001') return ws.close(4001, 'bye from fake');
        ws.send(typeof msg === 'string' ? `echo:${msg}` : msg);
      },
    },
  });
}

let A: Cast;
let B: Cast;
let cookieA = '';
const TAILNET_LOGIN = 'owner@example.com';
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));

const get = (path: string, init: RequestInit = {}, who = () => A) =>
  fetch(`${who().url}${path}`, { redirect: 'manual', ...init, headers: { cookie: cookieA, ...(init.headers as Record<string, string>) } });
const post = (path: string, body: unknown, extra: Record<string, string> = {}) =>
  get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...extra } });

/** Open a WebSocket with headers (Bun extension) and collect its first `n` text messages. */
function wsCollect(url: string, headers: Record<string, string>, n: number, send: (string | Uint8Array)[] = [], ms = 20_000): Promise<{ msgs: (string | Uint8Array)[]; opened: boolean; close?: { code: number; reason: string } }> {
  return new Promise((resolveP, reject) => {
    const ws = new WebSocket(url, { headers } as unknown as string[]);
    ws.binaryType = 'arraybuffer';
    const msgs: (string | Uint8Array)[] = [];
    let opened = false;
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`ws timeout after ${msgs.length} messages`));
    }, ms);
    ws.onopen = () => {
      opened = true;
      send.forEach((m) => ws.send(m));
    };
    ws.onmessage = (ev) => {
      msgs.push(typeof ev.data === 'string' ? ev.data : new Uint8Array(ev.data as ArrayBuffer));
      if (msgs.length >= n) {
        clearTimeout(timer);
        ws.close(1000);
        resolveP({ msgs, opened });
      }
    };
    ws.onclose = (ev) => {
      clearTimeout(timer);
      resolveP({ msgs, opened, close: { code: ev.code, reason: ev.reason } });
    };
    ws.onerror = () => {};
  });
}

beforeAll(async () => {
  [A, B] = await Promise.all([startCast('a', 'Alpha', TAILNET_LOGIN), startCast('b', 'Beta')]);
  fake = startFake();
  // sign in to A the way a hub does (POST /api/pair: a device session)
  cookieA = (await pairWithServer((u, i) => fetch(u, i), A.url, A.token, 'integration test')).cookie;
}, T);

afterAll(async () => {
  for (const c of [A, B]) {
    if (!c) continue;
    c.proc.kill('SIGTERM');
    await Promise.race([c.proc.exited, Bun.sleep(10_000)]);
    if (c.proc.exitCode === null) c.proc.kill('SIGKILL');
  }
  fake?.stop(true);
  rmSync(root, { recursive: true, force: true });
}, T);

describe('hub with two real CAST servers', () => {
  test('/api/version: no sign-in needed, says who it is, names itself only to a signed-in client', async () => {
    const anon = await (await fetch(`${A.url}/api/version`)).json();
    expect(anon).toMatchObject({ app: 'cast', protocol: 1, paired: false });
    expect(anon.features).toContain(CITY_PROXY_FEATURE);
    expect(anon.instanceId).toBe(readFileSync(join(A.dataDir, 'instance-id'), 'utf8').trim());
    expect(anon.name).toBeUndefined();
    const signed = await (await get('/api/version')).json();
    expect(signed).toMatchObject({ paired: true, name: 'Alpha' });
  }, T);

  test('/api/version uses the request\'s one auth decision: a legacy cookie is upgraded on that answer, ?token= is ignored', async () => {
    const legacy = await fetch(`${A.url}/api/version`, { headers: { cookie: `rlt_token=${A.token}` } });
    expect(await legacy.json()).toMatchObject({ paired: true });
    expect(legacy.headers.get('set-cookie') ?? '').toContain('rlt_session=');
    // the query is not a pairing attempt here: no redirect, no session, not paired
    const query = await fetch(`${A.url}/api/version?token=${A.token}`, { redirect: 'manual' });
    expect(query.status).toBe(200);
    expect(await query.json()).toMatchObject({ paired: false });
    expect(query.headers.get('set-cookie')).toBeNull();
  }, T);

  test('the cities API and the proxy are closed to requests the hub has not signed in', async () => {
    expect((await fetch(`${A.url}/api/cities`)).status).toBe(403);
    expect((await fetch(`${A.url}/city/beta/api/version`)).status).toBe(403);
    expect((await fetch(`${A.url}/api/cities`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).status).toBe(403);
  }, T);

  test('adding B: checks, pairs, stores only a cookie (0600)', async () => {
    // cross-site and non-JSON writes are refused before anything happens
    expect((await post('/api/cities', { url: B.url, pairing: B.token }, { origin: 'http://evil.example' })).status).toBe(403);
    expect((await get('/api/cities', { method: 'POST', body: 'url=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status).toBe(415);
    // a wrong token
    const bad = await post('/api/cities', { url: B.url, pairing: 'x'.repeat(32) });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: 'bad-token' });
    // A itself
    const self = await post('/api/cities', { url: A.url, pairing: A.token });
    expect(await self.json()).toMatchObject({ code: 'self' });

    const res = await post('/api/cities', { url: B.url, pairing: `http://127.0.0.1:${B.port}/?token=${B.token}` });
    expect(res.status).toBe(201);
    const { city } = await res.json();
    expect(city).toMatchObject({ id: 'beta', name: 'Beta', url: B.url, status: 'online' });

    const file = join(A.dataDir, 'cities.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const raw = readFileSync(file, 'utf8');
    // (booleans, so a failure never prints a token)
    expect(raw.includes(A.token)).toBe(false);
    const stored = JSON.parse(raw)[0].cookie as string;
    expect(raw.includes(B.token)).toBe(false); // only the session B gave the hub, never its pairing token
    expect(stored.startsWith('rlt_session=')).toBe(true);

    const list = await (await get('/api/cities')).json();
    expect(list.home).toMatchObject({ id: 'home', name: 'Alpha' });
    expect(list.cities).toEqual([expect.objectContaining({ id: 'beta', name: 'Beta', status: 'online' })]);
    expect(JSON.stringify(list)).not.toMatch(/rlt_session|rlt_token/);
  }, T);

  test('GET A/city/beta/api/version is B answering', async () => {
    const v = await (await get('/city/beta/api/version')).json();
    expect(v.instanceId).toBe(readFileSync(join(B.dataDir, 'instance-id'), 'utf8').trim());
    expect(v).toMatchObject({ paired: true, name: 'Beta' }); // B sees the hub's own cookie for B, not A's
  }, T);

  test('the city page is B’s own web app; /city/beta redirects to /city/beta/', async () => {
    const page = await get('/city/beta/', { headers: { accept: 'text/html' } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('CITY B');
    // None of B's cookies pass; the hub may renew its own session on a page load (auth.ts), and only that one.
    const setCookie = page.headers.get('set-cookie');
    expect(setCookie === null || setCookie.startsWith(`${cookieA};`)).toBe(true);
    const home = await get('/', { headers: { accept: 'text/html' } });
    expect(await home.text()).toContain('CITY A');
    // B's gzip passes through untouched (the hub neither unpacks nor double-packs it)
    const js = await get('/city/beta/assets/big-a1b2c3d4e5.js', { headers: { 'accept-encoding': 'gzip' } });
    expect(js.status).toBe(200);
    expect(js.headers.get('content-encoding')).toBe('gzip');
    expect(await js.text()).toBe(bigJs('b'));
    const bare = await get('/city/beta');
    expect(bare.status).toBe(308);
    expect(bare.headers.get('location')).toBe('/city/beta/');
  }, T);

  test('a WebSocket to A/city/beta/ws gets B’s hello and snapshot, A’s own /ws gets A’s', async () => {
    // a first start makes no houses: B gets one through the hub, as a page there would make it
    const make = JSON.stringify({ t: 'create_project', reqId: 'mk1', name: 'Beta house', lotId: 'A-N1', style: 'house', template: 'empty' });
    await wsCollect(`ws://127.0.0.1:${A.port}/city/beta/ws`, { cookie: cookieA }, 2, [make]);
    const cityFile = join(B.dataDir, 'city.json');
    const made = Date.now() + 20_000;
    while (!(existsSync(cityFile) && (JSON.parse(readFileSync(cityFile, 'utf8')) as { projects: unknown[] }).projects.length)) {
      if (Date.now() > made) throw new Error('B made no house');
      await Bun.sleep(100);
    }
    const viaHub = await wsCollect(`ws://127.0.0.1:${A.port}/city/beta/ws`, { cookie: cookieA }, 2);
    const [hello, snap] = viaHub.msgs.map((m) => JSON.parse(String(m)));
    expect(hello.t).toBe('hello');
    expect(hello.workspaceRoot).toBe(B.workspace);
    expect(snap.t).toBe('snapshot');
    expect(snap.city.projects.map((p: { name: string }) => p.name)).toEqual(['Beta house']);
    expect(snap.city.projects.every((p: { path: string }) => p.path.startsWith(B.workspace))).toBe(true);
    const direct = await wsCollect(`ws://127.0.0.1:${A.port}/ws`, { cookie: cookieA }, 1);
    expect(JSON.parse(String(direct.msgs[0])).workspaceRoot).toBe(A.workspace);
    // a browser-like handshake from another site is refused by the hub (the city can't check Origin itself)
    const evil = await wsCollect(`ws://127.0.0.1:${A.port}/city/beta/ws`, { cookie: cookieA, origin: 'http://evil.example' }, 1, [], 5000).catch((e) => ({ msgs: [], opened: false, close: { code: -1, reason: String(e) } }));
    expect(evil.opened).toBe(false);
    expect(evil.msgs.length).toBe(0);
  }, T);

  test('revoking a device at the hub closes its sockets to B too (and B is not asked to keep them)', async () => {
    const other = (await pairWithServer((u, i) => fetch(u, i), A.url, A.token, 'revoke test')).cookie;
    const devices = (await (await get('/api/devices', { headers: { cookie: other } })).json()) as { devices: { id: string; current: boolean }[] };
    const mine = devices.devices.find((d) => d.current)!;
    const ws = new WebSocket(`ws://127.0.0.1:${A.port}/city/beta/ws`, { headers: { cookie: other } } as unknown as string[]);
    const got: string[] = [];
    const closed = new Promise<{ code: number }>((res) => (ws.onclose = (ev) => res({ code: ev.code })));
    await new Promise<void>((res, rej) => {
      ws.onmessage = (ev) => {
        got.push(String(ev.data));
        if (got.length >= 2) res();
      };
      setTimeout(() => rej(new Error('no snapshot from B through the hub')), 20_000);
    });
    expect(JSON.parse(got[0]!).workspaceRoot).toBe(B.workspace);
    const r = await get(`/api/devices/${mine.id}`, { method: 'DELETE', headers: { origin: A.url } });
    expect(r.status).toBe(200);
    const c = await Promise.race([closed, Bun.sleep(10_000).then(() => ({ code: -1 }))]);
    expect(c.code).not.toBe(-1);
    // and that device can't open a new one
    const again = await wsCollect(`ws://127.0.0.1:${A.port}/city/beta/ws`, { cookie: other }, 1, [], 5000).catch(() => ({ msgs: [], opened: false }));
    expect(again.opened).toBe(false);
  }, T);

  test('uploads stream through to B and come back sandboxed', async () => {
    const up = await get('/city/beta/api/uploads', { method: 'POST', body: PNG, headers: { 'content-type': 'image/png', origin: A.url } });
    expect(up.status).toBe(200);
    const ref = await up.json();
    expect(ref.mimeType).toBe('image/png');
    const back = await get(`/city/beta/api/uploads/${ref.id}`);
    expect(back.status).toBe(200);
    expect(new Uint8Array(await back.arrayBuffer())).toEqual(PNG);
    expect(back.headers.get('content-security-policy')).toContain('sandbox');
    // it lives on B, not on A
    const inB = existsSync(join(B.dataDir, 'uploads')) ? readdirSync(join(B.dataDir, 'uploads')) : [];
    const inA = existsSync(join(A.dataDir, 'uploads')) ? readdirSync(join(A.dataDir, 'uploads')) : [];
    expect(inB).toContain(ref.id);
    expect(inA).not.toContain(ref.id);
  }, T);
});

describe('what the proxy forwards and drops (fake city)', () => {
  const fakeUrl = () => `http://127.0.0.1:${fake.port}`;

  test('add the fake city', async () => {
    const res = await post('/api/cities', { url: fakeUrl(), pairing: 'p'.repeat(32), name: 'Fake' });
    expect(res.status).toBe(201);
    expect((await res.json()).city).toMatchObject({ id: 'fake', status: 'online' });
  }, T);

  test('the browser’s credentials, identity and forwarding headers never reach the city', async () => {
    seen.length = 0;
    const res = await get('/city/fake/echo?x=1', {
      headers: {
        authorization: 'Bearer browser',
        'tailscale-user-login': TAILNET_LOGIN, // signs the request in at the hub (A allows this login) …
        'tailscale-user-name': 'Owner',
        'x-forwarded-for': '6.6.6.6',
        'x-forwarded-host': 'evil.example',
        referer: `${A.url}/city/fake/`,
        'user-agent': 'IntegrationTest/1',
      },
    });
    expect(res.status).toBe(200);
    const r = seen.find((s) => s.path.startsWith('/echo'))!; // … and must not travel on
    expect(r.headers.cookie).toBe(FAKE_COOKIE);
    expect(JSON.stringify(r.headers).includes(cookieA.split('=')[1]!)).toBe(false);
    for (const k of Object.keys(r.headers)) expect(k).not.toMatch(/^(authorization|tailscale-|x-forwarded-|forwarded|origin|referer)/);
    expect(r.headers.host).toBe(`127.0.0.1:${fake.port}`);
    expect(r.headers['user-agent']).toBe('IntegrationTest/1');
    expect(r.headers['x-cast-hops']).toBe('1');
  }, T);

  test('the hub’s own pairing token never travels on to the city', async () => {
    seen.length = 0;
    const res = await fetch(`${A.url}/city/fake/echo-body?keep=1&token=${A.token}`, { method: 'POST', body: 'abc', headers: { 'content-type': 'text/plain' } });
    expect(res.status).toBe(200);
    const r = seen.find((s) => s.path.startsWith('/echo-body'))!;
    expect(r.path === '/echo-body?keep=1').toBe(true);
    expect(await res.json()).toEqual({ bytes: 3, type: 'text/plain' });
  }, T);

  test('Set-Cookie and origin-wide policy are dropped; redirects stay under /city/fake/', async () => {
    const res = await get('/city/fake/redirect');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/city/fake/landing?x=1');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('strict-transport-security')).toBeNull();
  }, T);

  test('a session the city upgrades the hub to is kept by the hub, not sent to the browser', async () => {
    const res = await get('/city/fake/upgrade');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(readFileSync(join(A.dataDir, 'cities.json'), 'utf8')).toContain(FAKE_UPGRADED);
  }, T);

  test('agent pages: keyed files load without the hub’s cookie, are sandboxed, carry no city cookie', async () => {
    seen.length = 0;
    const res = await fetch(`${A.url}/city/fake/api/files/KEY/page.html`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    const r = seen.find((s) => s.path.startsWith('/api/files/'))!;
    expect(r.headers.cookie).toBeUndefined();
    // anything else of the city still needs the hub's sign-in
    expect((await fetch(`${A.url}/city/fake/api/version`)).status).toBe(403);
    expect((await fetch(`${A.url}/city/fake/api/files/KEY/page.html`, { method: 'POST' })).status).toBe(403);
  }, T);

  test('WebSocket bridge: city cookie only, no Origin; text, binary and close codes both ways', async () => {
    wsSeen.length = 0;
    const bin = Uint8Array.from([0, 1, 2, 250, 251]);
    const res = await wsCollect(`ws://127.0.0.1:${A.port}/city/fake/ws`, { cookie: cookieA, origin: A.url }, 3, ['ping', bin]);
    expect(res.msgs[0]).toBe('hello from fake');
    expect(res.msgs[1]).toBe('echo:ping');
    expect(res.msgs[2]).toEqual(bin);
    const h = wsSeen[0]!;
    expect(h.cookie).toBe(FAKE_UPGRADED);
    expect(h.origin).toBeUndefined();
    expect(Object.keys(h).some((k) => k.startsWith('tailscale-') || k.startsWith('x-forwarded-'))).toBe(false);
    const closed = await wsCollect(`ws://127.0.0.1:${A.port}/city/fake/ws`, { cookie: cookieA }, 99, ['close-4001'], 10_000);
    expect(closed.close).toEqual({ code: 4001, reason: 'bye from fake' });
  }, T);

  test('offline city: a CAST page for page loads, 502 JSON for the API, offline in the list', async () => {
    const port = fake.port!;
    fake.stop(true);
    const page = await get('/city/fake/', { headers: { accept: 'text/html' } });
    expect(page.status).toBe(502);
    const html = await page.text();
    expect(html).toContain('Fake is offline');
    expect(html).toContain('Back to Home');
    expect(html).toContain(`127.0.0.1:${port}`);
    // the browser's socket is never accepted while the city can't be reached (so it never looks connected)
    const ws = await wsCollect(`ws://127.0.0.1:${A.port}/city/fake/ws`, { cookie: cookieA }, 1, [], 15_000);
    expect(ws.opened).toBe(false);
    const api = await get('/city/fake/api/anything');
    expect(api.status).toBe(502);
    expect(await api.json()).toMatchObject({ offline: true, city: 'fake' });
    const list = await (await get('/api/cities')).json();
    expect(list.cities.find((c: { id: string }) => c.id === 'fake')).toMatchObject({ status: 'offline' });
    // and back
    fake = startFake(port);
    const again = await get('/city/fake/echo');
    expect(again.status).toBe(200);
  }, T);

  test('unknown cities are 404; removing a city closes its door', async () => {
    expect((await get('/city/nope/', { headers: { accept: 'text/html' } })).status).toBe(404);
    expect((await get('/api/cities/fake', { method: 'DELETE' })).status).toBe(200);
    expect((await get('/city/fake/echo')).status).toBe(404);
    expect((await get('/api/cities/fake', { method: 'DELETE' })).status).toBe(404);
  }, T);

  test('rename keeps the URL', async () => {
    const res = await get('/api/cities/beta', { method: 'PATCH', body: JSON.stringify({ name: 'Beta lab' }), headers: { 'content-type': 'application/json' } });
    expect((await res.json()).city).toMatchObject({ id: 'beta', name: 'Beta lab' });
    expect((await get('/city/beta/api/version')).status).toBe(200);
  }, T);
});
