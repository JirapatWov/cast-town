// The server as one compiled file (`bun run build:server`, the Mac app's Resources/cast-server): no repository around
// it, so everything it used to read from the checkout must come from elsewhere (server/runtime.ts) — its version is
// embedded, web/dist and the agent (cast-agent) are found next to the binary, the old in-repo data folder is never
// used, a .env in the folder it starts from is not loaded, and a cast-agent launcher is never told to run on
// cast-server. The last test compiles the real server and runs it from an unrelated folder, the way the Mac app does:
// a first start with no AI account is an empty town with no scripted model (no port, no omp-demo-agent folder, not
// "demo").
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Subprocess } from 'bun';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pkg from '../../package.json';
import { ompEnv, resolveOmpBin } from '../../server/agents/index';
import { loadConfig } from '../../server/config';
import { forbiddenPage } from '../../server/pages';
import { isCompiledDir, launchedBy, selfCommand } from '../../server/runtime';
import { pairingHint, respawn, RESTART_EXIT_CODE } from '../../server/startup';

const REPO = resolve(import.meta.dir, '../..');
const roots: string[] = [];
function tmp(prefix = 'cast-compiled-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  roots.push(d);
  return d;
}
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

describe('where a compiled server finds things', () => {
  test('a compiled binary is recognised by its virtual folder', () => {
    expect(isCompiledDir('/$bunfs/root')).toBe(true);
    expect(isCompiledDir('B:\\~BUN\\root')).toBe(true);
    expect(isCompiledDir(join(REPO, 'server'))).toBe(false);
    expect(isCompiledDir('/home/me/$bunfs-notes')).toBe(false);
  });

  test('restarting itself: the binary gets its own arguments, not the virtual entry path', () => {
    expect(selfCommand(true, '/Applications/CAST.app/Contents/Resources/cast-server', ['bun', '/$bunfs/root/cast-server', '--x'])).toEqual(['/Applications/CAST.app/Contents/Resources/cast-server', '--x']);
    expect(selfCommand(false, '/usr/bin/bun', ['/usr/bin/bun', 'server/index.ts'])).toEqual(['/usr/bin/bun', 'server/index.ts']);
  });

  test('config: no legacy <repo>/data, web/dist next to the binary, the embedded version; CAST_WEB_DIST still wins', () => {
    const root = tmp();
    const home = join(root, 'home');
    const bin = join(root, 'CAST.app', 'Contents', 'Resources');
    mkdirSync(join(bin, 'data'), { recursive: true });
    mkdirSync(home);
    writeFileSync(join(bin, 'data', 'city.json'), '{"version":1,"projects":[]}'); // would be "legacy" for a checkout
    const sys = { home, platform: 'darwin' as const, hostname: 'studio.local', repoRoot: bin, compiled: true, binDir: bin };
    const cfg = loadConfig({}, sys);
    expect(cfg.compiled).toBe(true);
    expect(cfg.dataDir).toBe(join(home, 'Library', 'Application Support', 'CAST'));
    expect(cfg.dataDirSource).toBe('default');
    expect(cfg.webDist).toBe(join(bin, 'web', 'dist'));
    expect(cfg.pocRoot).toBe(bin);
    expect(cfg.serverVersion).toBe(pkg.version);
    expect(cfg.launchedBy).toBeNull();
    expect(loadConfig({ CAST_WEB_DIST: '~/web' }, sys).webDist).toBe(join(home, 'web'));
    expect(loadConfig({ CAST_LAUNCHED_BY: 'mac-app' }, sys).launchedBy).toBe('mac-app');
    // the same folders from a checkout: the legacy folder is honoured there
    expect(loadConfig({}, { ...sys, compiled: false }).dataDirSource).toBe('legacy');
    expect(launchedBy({ CAST_LAUNCHED_BY: ' Mac-App ' })).toBe('mac-app');
    expect(launchedBy({ CAST_LAUNCHED_BY: 'systemd' })).toBeNull();
  });

  test('cast-agent: CAST_AGENT_BIN, else the one next to a compiled binary, else <repo>/agent/bin/cast-agent', () => {
    const dir = tmp();
    const bundled = join(dir, 'cast-agent');
    writeFileSync(bundled, '#!/bin/sh\n');
    expect(resolveOmpBin({ PATH: '/usr/bin' }, bundled, '/repo')).toBe(bundled);
    expect(resolveOmpBin({ PATH: '/usr/bin', CAST_AGENT_BIN: ' /opt/cast-agent ' }, bundled, '/repo')).toBe('/opt/cast-agent');
    // the bundled path even when it is missing (the start-up check reports it), never a search of PATH
    expect(resolveOmpBin({ PATH: '/usr/bin' }, join(dir, 'missing'), '/repo')).toBe(join(dir, 'missing'));
    expect(resolveOmpBin({ PATH: '/usr/bin', CAST_AGENT_BIN: '  ' }, null, '/repo')).toBe(join('/repo', 'agent', 'bin', 'cast-agent'));
    expect(resolveOmpBin({ PATH: '/usr/local/bin:/usr/bin', HOME: '/home/me' }, null, '/repo')).not.toContain('.bun');
  });

  test('agent children: a compiled server never offers itself as the bun a cast-agent launcher runs on', () => {
    const env = { HOME: '/home/me', PATH: '/usr/bin' };
    expect(ompEnv(env, true, '/x/cast-server').CAST_AGENT_BUN).toBeUndefined();
    expect(ompEnv({ ...env, CAST_AGENT_BUN: '/opt/bun' }, true, '/x/cast-server').CAST_AGENT_BUN).toBe('/opt/bun');
    expect(ompEnv(env, false, '/usr/bin/bun').CAST_AGENT_BUN).toBe('/usr/bin/bun');
    expect(ompEnv(env, true, '/x/cast-server').PATH).toBe('/home/me/.bun/bin:/usr/bin');
  });

  test('pairing help points at the menu-bar app, not at a checkout command', () => {
    const base = { dataDir: '/home/me/Library/Application Support/CAST', dataDirSource: 'default' as const };
    expect(pairingHint({ ...base, compiled: false, launchedBy: null }).menuBar).toBeUndefined();
    const hint = pairingHint({ ...base, compiled: true, launchedBy: 'mac-app' });
    expect(hint.menuBar).toBe(true);
    const page = forbiddenPage('no-token', { pairing: hint });
    expect(page).toContain('menu bar');
    expect(page).toContain('Pair a phone');
    expect(page).not.toContain('bun run pair');
  });

  test('a compiled server the Mac app did not start (the Linux tarball) prints the link with echo, no Bun needed', () => {
    const hint = pairingHint({ dataDir: "/srv/it's CAST", dataDirSource: 'env', compiled: true, launchedBy: null, port: 4930 });
    expect(hint.menuBar).toBeUndefined();
    expect(hint.command).toBe(`echo "http://127.0.0.1:4930/?token=$(cat '/srv/it'\\''s CAST/token')"`);
    const home = pairingHint({ dataDir: join(homedir(), 'my data'), dataDirSource: 'default', compiled: true, launchedBy: null, port: 4860 });
    expect(home.command).toBe(`echo "http://127.0.0.1:4860/?token=$(cat ~/'my data/token')"`);
    const page = forbiddenPage('no-token', { pairing: hint });
    expect(page).not.toContain('menu bar');
    expect(page).not.toContain('bun run pair');
    expect(page).toContain('echo &quot;http://127.0.0.1:4930/?token=');
  });

  test('"Delete all CAST data" under the menu-bar app: no copy is spawned, the app restarts the server', () => {
    expect(respawn({ dataDir: tmp(), launchedBy: 'mac-app' })).toBe(RESTART_EXIT_CODE);
  });
});

// ───────────────────────── the real binary ─────────────────────────

const root = tmp('cast-compiled-run-');
const binDir = join(root, 'Resources');
const home = join(root, 'home');
const cwd = join(root, 'somewhere-else');
const dataDir = join(home, '.local', 'share', 'cast');
let proc: Subprocess<'ignore', 'pipe', 'pipe'> | null = null;
let output = '';
let base = '';
let mockPort = 0;

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
  for (const d of [binDir, home, cwd, join(binDir, 'web', 'dist'), join(binDir, 'data')]) mkdirSync(d, { recursive: true });
  // `bun run build:server`, with the output put here
  const script = (pkg.scripts as Record<string, string>)['build:server']!;
  expect(script).toContain('--compile');
  const argv = script.replace('dist/cast-server', join(binDir, 'cast-server')).split(/\s+/);
  expect(argv[0]).toBe('bun');
  const build = Bun.spawnSync([process.execPath, ...argv.slice(1)], { cwd: REPO, stdout: 'pipe', stderr: 'pipe' });
  if (build.exitCode !== 0) throw new Error(`build:server failed: ${build.stderr.toString()}`);
  // what the kit puts next to it: the web app and cast-agent (a fake with a version of its own: proof it was the one used)
  writeFileSync(join(binDir, 'web', 'dist', 'index.html'), '<!doctype html><title>CAST</title><p>web app next to the binary</p>');
  writeFileSync(join(binDir, 'cast-agent'), '#!/bin/bash\nif [ "$1" = "--version" ]; then echo "cast-agent/18.13.7"; exit 0; fi\nif [ "$1" = "models" ]; then echo \'{"models":[]}\'; exit 0; fi\nexit 3\n');
  chmodSync(join(binDir, 'cast-agent'), 0o755);
  // traps: an old in-repo town next to the binary, and a .env where it is started
  writeFileSync(join(binDir, 'data', 'city.json'), '{"version":1,"projects":[]}');
  writeFileSync(join(cwd, '.env'), 'CAST_CITY_NAME=from-dotenv\n');

  const port = freePort();
  base = `http://127.0.0.1:${port}`;
  mockPort = freePort();
  proc = Bun.spawn([join(binDir, 'cast-server')], {
    cwd,
    // what the Mac app sets (no CAST_DATA_DIR, no CAST_WEB_DIST, no CAST_AGENT_BIN: found next to the binary)
    env: { HOME: home, USER: 'alice', SHELL: '/bin/sh', LANG: 'en_US.UTF-8', PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', CAST_PORT: String(port), CAST_MOCK_PORT: String(mockPort), CAST_LAUNCHED_BY: 'mac-app', CAST_TERMINAL: '0', PI_CODING_AGENT_DIR: join(root, 'agent') },
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
  await until(() => existsSync(join(dataDir, 'listen.json')), 60_000, 'the compiled server');
}, 120_000);

afterAll(async () => {
  if (proc && proc.exitCode === null) {
    proc.kill('SIGKILL');
    await proc.exited;
  }
});

describe('the compiled server, started from an unrelated folder', () => {
  let cookie = '';

  test('starts with its embedded version and the per-user data folder (not the old town next to it)', async () => {
    const v = (await (await fetch(`${base}/api/version`)).json()) as { app: string; version: string; features: string[] };
    expect(v.app).toBe('cast');
    expect(v.version).toBe(pkg.version);
    expect(v.features).toContain('mac-app-v1');
    expect(existsSync(join(dataDir, 'token'))).toBe(true);
    expect(existsSync(join(binDir, 'data', 'token'))).toBe(false);
    expect(output).not.toContain('legacy');
    expect(output).toContain('menu-bar app'); // the banner's pairing line
    expect(output).not.toContain('bun run pair');
    expect(output).not.toContain(readFileSync(join(dataDir, 'token'), 'utf8').trim());
  });

  test('pairs as the menu-bar app; serves the web app from next to the binary; finds cast-agent there', async () => {
    const token = readFileSync(join(dataDir, 'token'), 'utf8').trim();
    const res = await fetch(`${base}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, device: 'CAST menu bar (Mac)' }) });
    expect(res.status).toBe(200);
    cookie = ((await res.json()) as { cookie: string }).cookie;
    const page = await fetch(`${base}/`, { headers: { cookie, accept: 'text/html' } });
    expect(await page.text()).toContain('web app next to the binary');
    const status = await until(async () => {
      const s = (await (await fetch(`${base}/api/status`, { headers: { cookie } })).json()) as { omp: { state: string; version?: string }; cityName: string };
      return s.omp.state === 'ok' ? s : null;
    }, 30_000, 'the agent check');
    expect(status.omp.version).toBe('18.13.7');
    expect(status.cityName).not.toBe('from-dotenv'); // the .env in the folder it started from was not loaded
  });

  test('no AI account (the agent lists no models): an empty town, no scripted model — nothing listens on its port', async () => {
    await until(() => output.includes('no AI account connected yet — connect one in Models & providers'), 30_000, 'the start-up summary');
    expect(output).toContain('credentialed models: 0 (nobody can work until an AI account is connected)');
    expect(output).not.toMatch(/demo LLM|scripted model listening/);
    expect(output).not.toMatch(/\bseed(ed)?\b/i);
    expect(existsSync(join(dataDir, 'omp-demo-agent'))).toBe(false);
    const refused = await fetch(`http://127.0.0.1:${mockPort}/v1/models`).then(
      () => false,
      () => true,
    );
    expect(refused).toBe(true);
    const s = (await (await fetch(`${base}/api/status`, { headers: { cookie } })).json()) as { houses: number; models: { connected: number; state?: string; demo: boolean } };
    expect(s.houses).toBe(0);
    expect(s.models).toEqual({ connected: 0, state: 'ok', demo: false }); // the check worked: the Mac menu may say none is connected
  });

  test('SIGTERM: exits cleanly within 10 s', async () => {
    const t0 = Date.now();
    proc!.kill('SIGTERM');
    const code = await Promise.race([proc!.exited, Bun.sleep(10_000).then(() => 'timeout' as const)]);
    expect(code).toBe(0);
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(output).toContain('SIGTERM: shutting down');
    expect(output).toContain('bye');
  }, 15_000);
});
