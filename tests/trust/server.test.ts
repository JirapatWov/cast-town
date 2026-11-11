// End to end against a real server process (dev stub agents): a first start as a normal user with nothing configured
// (per-user folders, no token in the output, an empty town: no houses, folders or jobs), pairing over HTTP, revoking a device closing its live WebSocket, the
// terminal switch, a browser paired before device sessions being upgraded, and a second server on the same data folder.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { Subprocess } from 'bun';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dir, '../..');
const root = mkdtempSync(join(tmpdir(), 'cast-e2e-'));
const home = join(root, 'home');
mkdirSync(home, { recursive: true });
let proc: Subprocess<'ignore', 'pipe', 'pipe'>;
let base = '';
let output = '';
const dataDir = join(home, '.local', 'share', 'cast');

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
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}\n${output.slice(-2000)}`);
    await Bun.sleep(100);
  }
}

beforeAll(async () => {
  const port = freePort();
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn([process.execPath, join(REPO, 'server', 'index.ts')], {
    cwd: REPO,
    // A clean user environment: no RLT_*/CAST_* paths but the data folder, a home of its own, the terminal switched off
    // by env. The data folder is the per-user default, given explicitly: without it a checkout that already holds a
    // town (the old <repo>/data) would serve that one — and its server's AI agents would be taken for a crash's
    // leftovers and killed. Where the default comes from is config.test.ts's job.
    env: { HOME: home, USER: 'alice', PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8', CAST_PORT: String(port), CAST_STUB_AGENTS: '1', CAST_WEB_DIST: join(root, 'no-dist'), CAST_TERMINAL: '0', CAST_DATA_DIR: dataDir },
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
  await until(() => output.includes('Workspace') && existsSync(join(dataDir, 'listen.json')), 60_000, 'server start');
}, 90_000);

afterAll(async () => {
  proc?.kill('SIGTERM');
  await Promise.race([proc?.exited, Bun.sleep(5000)]);
  rmSync(root, { recursive: true, force: true });
});

const token = () => readFileSync(join(dataDir, 'token'), 'utf8').trim();

test('first start with nothing configured: per-user folders, token never printed', () => {
  expect(existsSync(join(dataDir, 'token'))).toBe(true);
  expect(existsSync(join(home, 'CAST'))).toBe(true); // workspace made on demand
  expect(output).not.toContain(token());
  expect(output).toContain(join(dataDir, 'token'));
  expect(output).toContain('bun run pair');
  expect(output).toContain('pairing required');
  expect(output).toContain('Terminal  off');
  expect(output).not.toContain(['', 'root', 'terminal'].join('/')); // a development checkout's path (spelled apart: the repo holds no such path)
});

test('first start: an empty town — no houses, no project folders, no jobs, nothing seeded', () => {
  expect(readdirSync(join(home, 'CAST'))).toEqual([]);
  expect(output).not.toMatch(/\bseed(ed)?\b/i);
  const cityFile = join(dataDir, 'city.json');
  if (existsSync(cityFile)) expect((JSON.parse(readFileSync(cityFile, 'utf8')) as { projects: unknown[] }).projects).toEqual([]);
  const jobsFile = join(dataDir, 'jobs.json');
  if (existsSync(jobsFile)) expect((JSON.parse(readFileSync(jobsFile, 'utf8')) as { jobs?: unknown[] }).jobs ?? []).toEqual([]);
});

test('no cookie: the 403 page tells where the token is', async () => {
  const res = await fetch(`${base}/`, { headers: { accept: 'text/html' } });
  expect(res.status).toBe(403);
  const html = await res.text();
  expect(html).toContain('~/.local/share/cast/token');
  expect(html).not.toContain(token());
});

test('POST /api/pair → session; revoking the device closes its WebSocket with 4401', async () => {
  const res = await fetch(`${base}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: token(), device: 'e2e script' }) });
  expect(res.status).toBe(200);
  const { cookie, deviceId } = (await res.json()) as { cookie: string; deviceId: string };

  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`, { headers: { cookie } } as unknown as string[]);
  const first = new Promise<string>((r) => (ws.onmessage = (ev) => r(String(ev.data))));
  const closed = new Promise<{ code: number; reason: string }>((r) => (ws.onclose = (ev) => r({ code: ev.code, reason: ev.reason })));
  expect(JSON.parse(await first).t).toBe('hello');

  const session = (await (await fetch(`${base}/api/session`, { headers: { cookie } })).json()) as { deviceId: string; terminal: { enabled: boolean; user: string } };
  expect(session.deviceId).toBe(deviceId);
  expect(session.terminal.enabled).toBe(false);

  const del = await fetch(`${base}/api/devices/${deviceId}`, { method: 'DELETE', headers: { cookie } });
  expect(del.status).toBe(200);
  const c = await Promise.race([closed, Bun.sleep(3000).then(() => ({ code: -1, reason: 'timeout' }))]);
  expect(c.code).toBe(4401);
  expect((await fetch(`${base}/api/session`, { headers: { cookie } })).status).toBe(403);
});

test('terminal off: /term is refused even when signed in', async () => {
  const res = await fetch(`${base}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: token() }) });
  const { cookie } = (await res.json()) as { cookie: string };
  const term = await fetch(`${base}/term?target=town`, { headers: { cookie } });
  expect(term.status).toBe(403);
  expect(await term.text()).toContain('turned off');
});

test('a browser paired before device sessions (rlt_token cookie) is upgraded on its next page load', async () => {
  const res = await fetch(`${base}/`, { headers: { accept: 'text/html', cookie: `rlt_token=${token()}` }, redirect: 'manual' });
  expect(res.status).toBe(200);
  const cookies = res.headers.getSetCookie();
  expect(cookies.some((c) => c.startsWith('rlt_session=') && !c.startsWith('rlt_session=;'))).toBe(true);
  expect(cookies.some((c) => c.startsWith('rlt_token=;') && c.includes('Max-Age=0'))).toBe(true);
});

test('the pairing link → 302 with a session cookie and the clean URL', async () => {
  const res = await fetch(`${base}/?token=${token()}`, { headers: { accept: 'text/html' }, redirect: 'manual' });
  expect(res.status).toBe(302);
  expect(res.headers.get('location')).toBe('/');
  expect(res.headers.getSetCookie().join('\n')).not.toContain(token());
});

// A second server on the same data folder (`bun run start` twice, a test started from a checkout that holds the live
// town) took the first one's AI agents for a crash's leftovers and killed them all, then wrote over its listen.json.
test('a second server on the same data folder refuses to start and leaves the first one alone', async () => {
  const before = readFileSync(join(dataDir, 'listen.json'), 'utf8');
  const second = Bun.spawn([process.execPath, join(REPO, 'server', 'index.ts')], {
    cwd: REPO,
    env: { HOME: home, USER: 'alice', PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8', CAST_PORT: String(freePort()), CAST_STUB_AGENTS: '1', CAST_WEB_DIST: join(root, 'no-dist'), CAST_TERMINAL: '0', CAST_DATA_DIR: dataDir },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  // a real process: the race ends when it exits; the timer only keeps a hung (would-be serving) copy from outliving us
  const code = await Promise.race([second.exited, Bun.sleep(20_000).then(() => 'still running' as const)]);
  if (code === 'still running') second.kill('SIGKILL');
  expect(code).toBe(1);
  const said = (await new Response(second.stderr).text()) + (await new Response(second.stdout).text());
  expect(said).toContain(`another CAST server (pid ${proc.pid}`);
  expect(said).toContain('CAST_DATA_DIR');
  expect(readFileSync(join(dataDir, 'listen.json'), 'utf8')).toBe(before);
  expect((await fetch(`${base}/api/health`)).ok).toBe(true);
}, 30_000);
