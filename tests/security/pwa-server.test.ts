// CAST as an installed app, against a real server process (dev stub agents) and a small fixture web/dist:
//  • The install files (sw.js, manifest, icons) answer an unpaired stranger — and nothing else of web/dist does.
//  • /sw.js: JavaScript, no-cache, nosniff, never Service-Worker-Allowed; POST → 405.
//  • CAST_SERVICE_WORKER=off: /sw.js is the self-removing worker and /api/session says pwa.sw false.
//  • The private page has the pairing form, and the form pairs (303 + cookie).
//  • push.json is 0600 and never in the log.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Subprocess } from 'bun';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PUBLIC_PWA_PATHS } from '../../server/pwa';
import { launchImagePaths } from '../../shared/launch-images';

const REPO = resolve(import.meta.dir, '../..');
const root = mkdtempSync(join(tmpdir(), 'cast-pwa-'));
const dist = join(root, 'dist');

function freePort(): number {
  const s = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
  const p = s.port!;
  s.stop(true);
  return p;
}

interface Srv {
  proc: Subprocess<'ignore', 'pipe', 'pipe'>;
  base: string;
  dataDir: string;
  output: string;
  cookie: string;
}

async function start(name: string, env: Record<string, string> = {}): Promise<Srv> {
  const dataDir = join(root, name, 'data');
  const workspace = join(root, name, 'ws');
  mkdirSync(workspace, { recursive: true });
  const port = freePort();
  const proc = Bun.spawn([process.execPath, join(REPO, 'server', 'index.ts')], {
    cwd: REPO,
    env: {
      HOME: join(root, name), USER: 'alice', PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8',
      CAST_PORT: String(port), CAST_HOST: '127.0.0.1', CAST_STUB_AGENTS: '1', CAST_DATA_DIR: dataDir, CAST_WORKSPACE: workspace,
      CAST_FS_ROOTS: workspace, CAST_WEB_DIST: dist, CAST_ALLOWED_USERS: '', CAST_CITY_NAME: name,
      GIT_AUTHOR_NAME: 'cast-test', GIT_AUTHOR_EMAIL: 'test@localhost', GIT_COMMITTER_NAME: 'cast-test', GIT_COMMITTER_EMAIL: 'test@localhost',
      ...env,
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const s: Srv = { proc, base: `http://127.0.0.1:${port}`, dataDir, output: '', cookie: '' };
  const drain = async (st: ReadableStream<Uint8Array>) => {
    const dec = new TextDecoder();
    for await (const chunk of st) s.output += dec.decode(chunk);
  };
  void drain(proc.stdout);
  void drain(proc.stderr);
  const end = Date.now() + 60_000;
  while (!(s.output.includes('Workspace') && existsSync(join(dataDir, 'listen.json')))) {
    if (Date.now() > end) throw new Error(`server ${name} did not start\n${s.output.replace(/token=\S+/g, 'token=…').slice(-1500)}`);
    await Bun.sleep(100);
  }
  const token = readFileSync(join(dataDir, 'token'), 'utf8').trim();
  const res = await fetch(`${s.base}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, device: 'pwa test' }) });
  s.cookie = ((await res.json()) as { cookie: string }).cookie;
  return s;
}

let on: Srv;
let off: Srv;

beforeAll(async () => {
  mkdirSync(join(dist, 'assets'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>CAST</title><p>the app');
  writeFileSync(join(dist, 'sw.js'), "self.addEventListener('fetch',()=>{});/*cast-sw build-x*/");
  writeFileSync(join(dist, 'manifest.webmanifest'), JSON.stringify({ name: 'CAST', start_url: '/' }));
  for (const f of ['apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'favicon-32.png']) writeFileSync(join(dist, f), 'PNG');
  mkdirSync(join(dist, 'splash'), { recursive: true });
  for (const p of launchImagePaths()) writeFileSync(join(dist, p), 'PNG'); // the iOS launch images
  writeFileSync(join(dist, 'splash', 'other.png'), 'PNG'); // not one of them: stays behind sign-in
  writeFileSync(join(dist, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(join(dist, 'assets', 'index-AbCdEf12.js'), 'console.log(1)');
  [on, off] = await Promise.all([start('on'), start('off', { CAST_SERVICE_WORKER: 'off' })]);
}, 90_000);

afterAll(async () => {
  for (const s of [on, off]) s?.proc.kill('SIGTERM');
  await Promise.race([Promise.all([on?.proc.exited, off?.proc.exited]), Bun.sleep(5000)]);
  rmSync(root, { recursive: true, force: true });
});

describe('public install files', () => {
  test('an unpaired GET / HEAD of each answers 200; the app and its code still answer 403', async () => {
    for (const p of PUBLIC_PWA_PATHS) {
      for (const method of ['GET', 'HEAD']) {
        const res = await fetch(`${on.base}${p}`, { method });
        expect(`${method} ${p} ${res.status}`).toBe(`${method} ${p} 200`);
      }
    }
    for (const p of ['/', '/index.html', '/assets/index-AbCdEf12.js', '/api/session', '/sw.js.map', '/manifest.webmanifest/x', '/splash/other.png']) {
      const res = await fetch(`${on.base}${p}`, { headers: { accept: 'text/html' } });
      expect(`${p} ${res.status}`).toBe(`${p} 403`);
    }
  });

  test('/sw.js: JavaScript, no-cache, nosniff, never Service-Worker-Allowed; POST → 405', async () => {
    const res = await fetch(`${on.base}/sw.js`);
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('service-worker-allowed')).toBeNull();
    expect(await res.text()).toContain('cast-sw build-x');
    expect((await fetch(`${on.base}/sw.js`, { method: 'POST' })).status).toBe(405);
    // a stray ?token= neither pairs nor counts as a wrong try there
    const q = await fetch(`${on.base}/manifest.webmanifest?token=nope`, { redirect: 'manual' });
    expect(q.status).toBe(200);
    expect(q.headers.getSetCookie()).toEqual([]);
  });

  test('/api/session says the worker and push are on', async () => {
    const s = (await (await fetch(`${on.base}/api/session`, { headers: { cookie: on.cookie } })).json()) as { pwa: unknown };
    expect(s.pwa).toEqual({ sw: true, push: true });
  });
});

describe('CAST_SERVICE_WORKER=off', () => {
  test('/sw.js is a worker that empties CAST’s caches and unregisters itself (200, never a reload)', async () => {
    const res = await fetch(`${off.base}/sw.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    const js = await res.text();
    expect(js).toContain('unregister');
    expect(js).toContain('caches.delete');
    expect(js).not.toContain('navigate');
    expect(js).not.toContain('reload');
  });

  test('/api/session says pwa.sw false', async () => {
    const s = (await (await fetch(`${off.base}/api/session`, { headers: { cookie: off.cookie } })).json()) as { pwa: { sw: boolean } };
    expect(s.pwa.sw).toBe(false);
  });
});

describe('the private page and its form', () => {
  test('an unpaired page load shows the form; it pairs with a one-time code and lands where it was going', async () => {
    const page = await fetch(`${on.base}/#/house/x`, { headers: { accept: 'text/html' } });
    expect(page.status).toBe(403);
    const html = await page.text();
    expect(html).toContain('action="/api/pair"');
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'self'");
    const link = (await (await fetch(`${on.base}/api/devices/pair-link`, { method: 'POST', headers: { cookie: on.cookie, origin: on.base } })).json()) as { short: string };
    const res = await fetch(`${on.base}/api/pair`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: on.base, accept: 'text/html' },
      body: new URLSearchParams({ token: link.short.toLowerCase(), next: '/?x=1', app: '1' }).toString(),
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/?x=1');
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith('rlt_session='))!.split(';')[0]!;
    expect((await fetch(`${on.base}/`, { headers: { cookie } })).status).toBe(200);
    const devices = (await (await fetch(`${on.base}/api/devices`, { headers: { cookie } })).json()) as { devices: { name: string }[] };
    expect(devices.devices.some((d) => d.name.endsWith('(Home Screen app)'))).toBe(true);
  });
});

describe('push.json', () => {
  test('0600, and neither the key nor any endpoint in the log', () => {
    const file = join(on.dataDir, 'push.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const { vapid } = JSON.parse(readFileSync(file, 'utf8')) as { vapid: { privateKey: string } };
    expect(on.output).not.toContain(vapid.privateKey);
  });
});
