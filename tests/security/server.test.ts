// A real server process (dev stub agents), attacked from outside: what an unpaired stranger who can reach the port
// can and cannot do, and the promises that need the whole server wired together.
//  • The data folder: one left open by an older CAST (0755, umask 022) is closed to other accounts; files are 0600.
//  • A pairing token change ends the viewer's file keys too (index.ts hands files.ts the live token).
//  • POST /api/pair answers anyone: it must not read a huge chunked body into memory.
//  • With no allowedUsers, the Tailscale identity header means nothing.
//  • Keyed city file requests (no sign-in needed) never name a city or its address.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server, Subprocess } from 'bun';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CITY_PROXY_FEATURE } from '../../shared/cities';
import { LOTS } from '../../shared/city-layout';

const REPO = resolve(import.meta.dir, '../..');
const root = mkdtempSync(join(tmpdir(), 'cast-sec-'));
const dataDir = join(root, 'data');
const workspace = join(root, 'ws');
let proc: Subprocess<'ignore', 'pipe', 'pipe'>;
let base = '';
let output = '';
let cookie = '';
let projectId = '';

function freePort(): number {
  const s = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
  const p = s.port!;
  s.stop(true);
  return p;
}

async function until<T>(fn: () => T | Promise<T>, ms: number, what: string): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}\n${output.replace(/token=\S+/g, 'token=…').slice(-2000)}`);
    await Bun.sleep(100);
  }
}

const mode = (p: string) => statSync(p).mode & 0o777;
const token = () => readFileSync(join(dataDir, 'token'), 'utf8').trim();

beforeAll(async () => {
  // A data folder an older CAST made with a plain mkdir: open to every account on the machine.
  mkdirSync(dataDir, { recursive: true });
  chmodSync(dataDir, 0o755);
  mkdirSync(workspace, { recursive: true });
  const port = freePort();
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(['/bin/sh', '-c', `umask 022; exec "${process.execPath}" "${join(REPO, 'server', 'index.ts')}"`], {
    cwd: REPO,
    env: {
      HOME: root, USER: 'alice', PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8',
      CAST_PORT: String(port), CAST_HOST: '127.0.0.1', CAST_STUB_AGENTS: '1', CAST_DATA_DIR: dataDir, CAST_WORKSPACE: workspace,
      CAST_FS_ROOTS: workspace, CAST_WEB_DIST: join(root, 'no-dist'), CAST_ALLOWED_USERS: '', CAST_CITY_NAME: 'Hub',
    },
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
  const res = await fetch(`${base}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: token(), device: 'security test' }) });
  cookie = ((await res.json()) as { cookie: string }).cookie;
  // a first start makes no houses: make one as the user would (the city file and the file keys below need one)
  const made = await wsRequest({ t: 'create_project', name: 'notes', lotId: LOTS[0]!.id, style: 'house', template: 'empty' });
  if (!made.ok) throw new Error(`create_project failed: ${made.error}`);
  projectId = (made.data as { project: { id: string } }).project.id;
}, 90_000);

afterAll(async () => {
  proc?.kill('SIGTERM');
  await Promise.race([proc?.exited, Bun.sleep(5000)]);
  rmSync(root, { recursive: true, force: true });
});

/** One request over /ws: the ack's data. */
async function wsRequest(msg: Record<string, unknown>): Promise<{ ok: boolean; data?: Record<string, unknown>; error?: string }> {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`, { headers: { cookie } } as unknown as string[]);
  try {
    return await new Promise((resolveP, reject) => {
      const timer = setTimeout(() => reject(new Error('no ack')), 15_000);
      ws.onmessage = (ev) => {
        const m = JSON.parse(String(ev.data)) as { t: string; reqId?: string };
        if (m.t === 'snapshot') ws.send(JSON.stringify({ ...msg, reqId: 'sec1' }));
        if (m.t === 'ack' && m.reqId === 'sec1') {
          clearTimeout(timer);
          resolveP(m as never);
        }
      };
      ws.onerror = () => reject(new Error('ws refused'));
    });
  } finally {
    ws.close();
  }
}

describe('data folder', () => {
  test('a data folder open to other accounts is closed at start; what CAST writes there is 0600', () => {
    expect(mode(dataDir)).toBe(0o700);
    expect(output).toContain('Closed the data folder');
    expect(mode(join(dataDir, 'token'))).toBe(0o600);
    expect(mode(join(dataDir, 'city.json'))).toBe(0o600); // written with writeFileAtomic's default
    expect(output).not.toContain(token());
  });
});

describe('pairing and identity', () => {
  test('the Tailscale login header means nothing when no logins are allowed', async () => {
    for (const host of [undefined, 'localhost', 'machine.tailnet.ts.net', 'evil.example']) {
      const res = await fetch(`${base}/api/session`, { headers: { 'tailscale-user-login': 'owner@example.com', ...(host ? { host } : {}) } });
      expect(res.status).toBe(403);
    }
  });

  test('POST /api/pair stops reading a huge body without Content-Length after a few KB', async () => {
    const chunk = new Uint8Array(256 * 1024).fill(0x61);
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (pulled >= 256) return c.close(); // 64 MB if read to the end
        pulled++;
        c.enqueue(chunk);
      },
    });
    const res = await fetch(`${base}/api/pair`, { method: 'POST', body, headers: { 'content-type': 'application/json' }, duplex: 'half' } as RequestInit);
    expect(res.status).toBe(413);
    expect(pulled).toBeLessThan(64); // the server answered long before the end (it used to buffer all of it)
    // and it still pairs normally afterwards
    const ok = await fetch(`${base}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: token() }) });
    expect(ok.status).toBe(200);
  });
});

describe('cross-site requests', () => {
  // Every HTTP route that changes something, as a signed-in browser would send it from another site, a sandboxed
  // (opaque-origin) page, or another port of the same machine (same-site, so a SameSite=Lax cookie rides along).
  const routes: [string, string, string, string][] = [
    ['POST', '/api/devices/pair-link', '', 'text/plain'],
    ['POST', '/api/devices/rotate-token', '{"revokeAll":true}', 'text/plain'],
    ['POST', '/api/devices/revoke-others', '', 'application/x-www-form-urlencoded'],
    ['DELETE', '/api/devices/d-000000000000', '', 'text/plain'],
    ['POST', '/api/data/wipe', '{"confirm":"delete everything"}', 'text/plain'],
    ['POST', '/api/cities', '{"url":"http://127.0.0.1:9","pairing":"aaaaaaaaaaaaaaaaaaaa"}', 'application/json'],
    ['PATCH', '/api/cities/some-city', '{"name":"x"}', 'application/json'],
    ['DELETE', '/api/cities/some-city', '', 'text/plain'],
    ['POST', '/api/uploads', 'GIF89a', 'image/gif'],
    ['POST', '/city/some-city/api/devices/rotate-token', '{}', 'text/plain'],
  ];
  const origins = ['https://evil.example', 'null', 'http://localhost:1'];
  test('every state-changing route refuses a foreign, opaque or other-port Origin, even signed in', async () => {
    const before = token();
    for (const [method, path, body, type] of routes) {
      for (const origin of origins) {
        const res = await fetch(`${base}${path}`, { method, headers: { cookie, origin, 'content-type': type, 'sec-fetch-site': 'cross-site' }, body: body || undefined, redirect: 'manual' });
        if (res.status !== 403) throw new Error(`${method} ${path} from ${origin} → ${res.status}`);
      }
    }
    expect(token()).toBe(before); // nothing rotated, nothing wiped
    expect(existsSync(join(dataDir, 'token'))).toBe(true);
    expect(existsSync(join(dataDir, 'city.json'))).toBe(true);
  });

  test('a WebSocket with a foreign Origin is refused; without one it needs a valid session', async () => {
    const open = (path: string, headers: Record<string, string>) =>
      new Promise<boolean>((r) => {
        const ws = new WebSocket(`${base.replace('http', 'ws')}${path}`, { headers } as unknown as string[]);
        const t = setTimeout(() => r(false), 5000);
        ws.onopen = () => (clearTimeout(t), ws.close(), r(true));
        ws.onerror = () => (clearTimeout(t), r(false));
      });
    expect(await open('/ws', { cookie, origin: 'https://evil.example' })).toBe(false);
    expect(await open('/ws', { cookie, origin: 'null' })).toBe(false);
    expect(await open('/term?target=town', { cookie, origin: 'https://evil.example' })).toBe(false);
    expect(await open('/city/some-city/ws', { cookie, origin: 'https://evil.example' })).toBe(false);
    expect(await open('/ws', {})).toBe(false);
    expect(await open('/ws', { cookie: 'rlt_session=forged' })).toBe(false);
    expect(await open('/ws', { cookie })).toBe(true);
    expect(await open('/ws', { cookie, origin: base })).toBe(true);
  });
});

describe('viewer file keys', () => {
  test('a new pairing token ends every file key, without a restart', async () => {
    const city = JSON.parse(readFileSync(join(dataDir, 'city.json'), 'utf8')) as { projects: { id: string }[] };
    expect(city.projects.map((p) => p.id)).toEqual([projectId]); // only the house made above
    const ack = await wsRequest({ t: 'files_key', projectId });
    expect(ack.ok).toBe(true);
    const fileBase = (ack.data as { base: string }).base;
    const readme = `${base}${fileBase}README.md`;
    expect((await fetch(readme)).status).toBe(200);

    const rot = await fetch(`${base}/api/devices/rotate-token`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' });
    expect(rot.status).toBe(200);
    expect((await fetch(readme)).status).toBe(404);
  }, 30_000);
});

describe('keyed city files (answered before sign-in)', () => {
  let fake: Server<undefined>;
  let cityId = '';
  const SECRET_NAME = 'Basement-Box';

  beforeAll(async () => {
    fake = Bun.serve<undefined>({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req) {
        const u = new URL(req.url);
        const json = (d: unknown) => new Response(JSON.stringify(d), { headers: { 'content-type': 'application/json' } });
        if (u.pathname === '/api/version') return json({ app: 'cast', version: '0.0.9', protocol: 1, features: [CITY_PROXY_FEATURE], instanceId: 'fake-sec', paired: req.headers.get('cookie') === 'rlt_session=SEC1' });
        if (u.pathname === '/api/pair') return json({ cookie: 'rlt_session=SEC1', deviceId: 'd' });
        return new Response('Not found\n', { status: 404 });
      },
    });
    const res = await fetch(`${base}/api/cities`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ name: SECRET_NAME, url: `http://127.0.0.1:${fake.port}`, pairing: 'a'.repeat(32) }) });
    expect(res.status).toBe(201);
    cityId = ((await res.json()) as { city: { id: string } }).city.id;
  });

  afterAll(() => fake?.stop(true));

  test('an unknown city and an unreachable one get the very same answer: no name, no address, no hint which ids exist', async () => {
    const port = String(fake.port);
    const answer = async (res: Response) => {
      const h = Object.fromEntries([...res.headers].filter(([k]) => k !== 'date' && k !== 'content-length'));
      return { status: res.status, headers: h, text: await res.text() };
    };
    // online, with a key that city doesn't know: its own 404 is replaced by the same plain one
    const unknownNow = await answer(await fetch(`${base}/city/no-such-city/api/files/KEY/page.html`));
    expect(await answer(await fetch(`${base}/city/${cityId}/api/files/KEY/page.html`))).toEqual(unknownNow);
    fake.stop(true);
    for (const accept of ['text/html', 'application/json']) {
      const unknown = await answer(await fetch(`${base}/city/no-such-city/api/files/KEY/page.html`, { headers: { accept } }));
      const known = await answer(await fetch(`${base}/city/${cityId}/api/files/KEY/page.html`, { headers: { accept } }));
      expect(unknown.status).toBe(404);
      expect(unknown.text).toBe('Not found\n');
      expect(known).toEqual(unknown);
      expect(known.text).not.toContain(SECRET_NAME);
      expect(known.text).not.toContain(port);
      // a forged hop count must not tell them apart either (an unknown id is refused before hops are counted)
      const loop = await answer(await fetch(`${base}/city/${cityId}/api/files/KEY/page.html`, { headers: { accept, 'x-cast-hops': '9' } }));
      expect(loop).toEqual(unknown);
    }
    // a signed-in page load still gets the friendly offline page
    const page = await fetch(`${base}/city/${cityId}/`, { headers: { cookie, accept: 'text/html' } });
    expect(page.status).toBe(502);
    expect(await page.text()).toContain(SECRET_NAME);
  }, 30_000);
});
