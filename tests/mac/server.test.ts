// The Mac app's calls against a real server process (dev stub agents), in the order the app makes them: GET /api/version
// (the feature flag), POST /api/pair as "CAST menu bar (Mac)", GET /api/status (signed in only, cheap), POST
// /api/login-link → a browser opens the link once and lands on Settings → Pair a phone with a session of its own.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { Subprocess } from 'bun';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AppStatus, LoginLink } from '../../shared/app-status';

const REPO = resolve(import.meta.dir, '../..');
const root = mkdtempSync(join(tmpdir(), 'cast-mac-e2e-'));
const home = join(root, 'home');
const dataDir = join(home, '.local', 'share', 'cast');
let proc: Subprocess<'ignore', 'pipe', 'pipe'>;
let base = '';
let output = '';
let appCookie = '';

function freePort(): number {
  const s = Bun.serve({ port: 0, fetch: () => new Response('') });
  const p = s.port!;
  s.stop(true);
  return p;
}

async function until<T>(fn: () => T | Promise<T>, ms: number, what: string): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}\n${output.slice(-1500)}`);
    await Bun.sleep(100);
  }
}

beforeAll(async () => {
  mkdirSync(home, { recursive: true });
  const port = freePort();
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn([process.execPath, join(REPO, 'server', 'index.ts')], {
    cwd: root,
    // (the data folder explicitly: a checkout holding a town in <repo>/data would otherwise serve that one, trust/server.test.ts)
    env: { HOME: home, USER: 'alice', PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8', CAST_PORT: String(port), CAST_STUB_AGENTS: '1', CAST_WEB_DIST: join(root, 'no-dist'), CAST_TERMINAL: '0', CAST_LAUNCHED_BY: 'mac-app', CAST_CITY_NAME: 'Studio', CAST_DATA_DIR: dataDir },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const drain = async (s: ReadableStream<Uint8Array>) => {
    const dec = new TextDecoder();
    for await (const chunk of s) output += dec.decode(chunk);
  };
  void drain(proc.stdout);
  void drain(proc.stderr);
  await until(() => existsSync(join(dataDir, 'listen.json')), 60_000, 'server start');
}, 90_000);

afterAll(async () => {
  proc?.kill('SIGTERM');
  await Promise.race([proc?.exited, Bun.sleep(10_000)]);
  rmSync(root, { recursive: true, force: true });
});

const token = () => readFileSync(join(dataDir, 'token'), 'utf8').trim();
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), redirect: 'manual' });

test('version says mac-app-v1; the start banner and the 403 page point at the menu bar', async () => {
  const v = (await (await fetch(`${base}/api/version`)).json()) as { app: string; features: string[] };
  expect(v.app).toBe('cast');
  expect(v.features).toEqual(expect.arrayContaining(['city-proxy-v1', 'mac-app-v1']));
  expect(output).toContain('the CAST menu-bar app: Open CAST');
  const page = await (await fetch(`${base}/`, { headers: { accept: 'text/html' } })).text();
  expect(page).toContain('menu bar');
  expect(page).not.toContain(token());
});

test('status and login links need a sign-in', async () => {
  expect((await fetch(`${base}/api/status`)).status).toBe(403);
  expect((await post('/api/login-link', {})).status).toBe(403);
  expect((await fetch(`${base}/api/status`, { headers: { cookie: 'rlt_session=made-up' } })).status).toBe(403);
});

test('the app pairs once; Settings → Devices lists it as kind "app"', async () => {
  const res = await post('/api/pair', { token: token(), device: 'CAST menu bar (Mac)' });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { cookie: string; deviceId: string; kind: string };
  expect(body.kind).toBe('app');
  expect(body.cookie).toMatch(/^rlt_session=[\w-]{20,}$/);
  appCookie = body.cookie;
  const devices = (await (await fetch(`${base}/api/devices`, { headers: { cookie: appCookie } })).json()) as { devices: { id: string; kind?: string; current: boolean }[] };
  expect(devices.devices.find((d) => d.id === body.deviceId)).toMatchObject({ kind: 'app', current: true });
});

test('GET /api/status: the contract, quickly', async () => {
  const res = await fetch(`${base}/api/status`, { headers: { cookie: appCookie } });
  expect(res.status).toBe(200);
  expect(res.headers.get('cache-control')).toBe('no-store');
  const s = (await res.json()) as AppStatus;
  expect(Object.keys(s).sort()).toEqual(['agents', 'app', 'approvalsWaiting', 'attention', 'cityName', 'houses', 'models', 'omp', 'runsActive', 'uptimeSec', 'url', 'version'].sort());
  expect(s).toMatchObject({ app: 'cast', cityName: 'Studio', url: `${base}/`, approvalsWaiting: 0, runsActive: 0, attention: [] });
  expect(Object.keys(s.agents).sort()).toEqual(['needsYou', 'total', 'working']);
  expect(typeof s.models.connected).toBe('number');
  expect(typeof s.models.demo).toBe('boolean'); // older Mac apps read it
  expect(s.models.demo).toBe(false); // only the tests' scripted model (CAST_MOCK_LLM) sets it
  expect(['ok', 'checking', 'missing', 'too-old', 'error']).toContain(s.omp.state);
  expect(s.houses).toBe(0); // a first start makes no houses: the town is empty
  // cheap: the app asks every few seconds (the server side is memory only; this is the whole round trip)
  const times: number[] = [];
  for (let i = 0; i < 30; i++) {
    const t0 = performance.now();
    await (await fetch(`${base}/api/status`, { headers: { cookie: appCookie } })).arrayBuffer();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  expect(times[15]!).toBeLessThan(25);
  // the server's own time to build it (Server-Timing): the contract's < 5 ms
  const timing = (await fetch(`${base}/api/status`, { headers: { cookie: appCookie } })).headers.get('server-timing') ?? '';
  expect(Number(/status;dur=([\d.]+)/.exec(timing)?.[1] ?? NaN)).toBeLessThan(5);
});

test('POST /api/login-link → the browser signs in once, on its own session, landing on Settings → Pair a phone', async () => {
  const res = await post('/api/login-link', { next: '/?settings=pair' }, { cookie: appCookie });
  expect(res.status).toBe(200);
  const { url } = (await res.json()) as LoginLink;
  expect(url.startsWith(`${base}/?settings=pair&token=`)).toBe(true);

  const open = await fetch(url, { headers: { accept: 'text/html', 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15' }, redirect: 'manual' });
  expect(open.status).toBe(302);
  expect(open.headers.get('location')).toBe('/?settings=pair');
  const browser = open.headers.getSetCookie().find((c) => c.startsWith('rlt_session=') && !c.startsWith('rlt_session=;'))!.split(';')[0]!;
  expect(browser).not.toBe(appCookie);
  const session = (await (await fetch(`${base}/api/session`, { headers: { cookie: browser } })).json()) as { deviceName: string };
  expect(session.deviceName).toBe('Safari on macOS');

  const again = await fetch(url, { headers: { accept: 'text/html' }, redirect: 'manual' });
  expect(again.status).toBe(403); // used up
});

test('login-link refuses other hosts and cross-site callers', async () => {
  for (const next of ['https://evil.example.com/', '//evil.example.com/x', '/..//evil.example.com', '/\\evil.example.com']) {
    expect((await post('/api/login-link', { next }, { cookie: appCookie })).status).toBe(400);
  }
  expect((await post('/api/login-link', { next: '/' }, { cookie: appCookie, origin: 'http://evil.example.com' })).status).toBe(403);
  // the token-in-the-path trick never yields a redirect off this server either
  const { url } = (await (await post('/api/login-link', {}, { cookie: appCookie })).json()) as LoginLink;
  const code = new URL(url).searchParams.get('token')!;
  const tricky = await fetch(`${base}//evil.example.com/?token=${code}`, { headers: { accept: 'text/html' }, redirect: 'manual' });
  expect(tricky.status).toBe(302);
  expect(tricky.headers.get('location')).toBe('/evil.example.com/');
});
