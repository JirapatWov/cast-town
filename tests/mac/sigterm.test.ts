// SIGTERM (the Mac app's Quit and Restart, systemd's stop): the server exits within 10 s and leaves nothing it started
// behind — not the shells of the browser terminal (nor what runs in them), not an agent (cast-agent) that hangs. The
// case here is the worst one at start-up: the agent's account check (`cast-agent models`) never answers and has started
// a child of its own, and a terminal runs a long command in the foreground and another in the background. Linux only
// (it reads /proc).
import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { Subprocess } from 'bun';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dir, '../..');
const linux = process.platform === 'linux' && existsSync('/proc/self/stat');
const MARK = `cast-sigterm-${process.pid}-${Date.now().toString(36)}`;
const root = mkdtempSync(join(tmpdir(), 'cast-sigterm-'));
const home = join(root, 'home');
const dataDir = join(home, '.local', 'share', 'cast');
let proc: Subprocess<'ignore', 'pipe', 'pipe'> | null = null;
let output = '';
let base = '';

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

/** pid → { ppid, cmdline } of every process (a snapshot of /proc). */
function processes(): Map<number, { ppid: number; cmd: string }> {
  const out = new Map<number, { ppid: number; cmd: string }>();
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      const cmd = readFileSync(`/proc/${name}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
      out.set(Number(name), { ppid, cmd });
    } catch {
      /* gone meanwhile */
    }
  }
  return out;
}

/** Every process below `pid`. */
function descendants(pid: number): number[] {
  const all = processes();
  const found: number[] = [];
  const walk = (p: number) => {
    for (const [child, info] of all) {
      if (info.ppid === p && !found.includes(child)) {
        found.push(child);
        walk(child);
      }
    }
  };
  walk(pid);
  return found;
}

const alive = (pid: number) => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return !/\) Z /.test(stat); // a zombie has exited already
  } catch {
    return false;
  }
};
const marked = () => [...processes()].filter(([, p]) => p.cmd.includes(MARK)).map(([pid]) => pid);

beforeAll(async () => {
  if (!linux) return;
  mkdirSync(home, { recursive: true });
  // a stand-in for cast-agent (the real one can't be made to hang): --version answers; `models` starts a child of its
  // own and never answers
  const agent = join(root, 'cast-agent');
  writeFileSync(agent, `#!/bin/bash
if [ "$1" = "--version" ]; then echo "cast-agent/18.13.2"; exit 0; fi
if [ "$1" = "models" ]; then bash -c 'while :; do sleep 1; done' ${MARK}-agent-child & wait; fi
exit 3
`);
  chmodSync(agent, 0o755);
  const port = freePort();
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn([process.execPath, join(REPO, 'server', 'index.ts')], {
    cwd: root,
    env: {
      HOME: home, USER: 'alice', SHELL: '/bin/bash', LANG: 'C.UTF-8', PATH: process.env.PATH ?? '/usr/bin:/bin',
      CAST_PORT: String(port), CAST_MOCK_PORT: String(freePort()), CAST_AGENT_BIN: agent, CAST_WEB_DIST: join(root, 'no-dist'),
      CAST_AGENT_TIMEOUT: '120', PI_CODING_AGENT_DIR: join(root, 'agent'),
      // the data folder explicitly: a checkout holding a town in <repo>/data would otherwise serve that one, and this
      // server (real agents) would kill that town's running AI agents as a crash's leftovers (trust/server.test.ts)
      CAST_DATA_DIR: dataDir,
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
  await until(() => existsSync(join(dataDir, 'listen.json')), 60_000, 'server start');
}, 90_000);

afterAll(async () => {
  if (proc && proc.exitCode === null) proc.kill('SIGKILL');
  if (linux) for (const pid of marked()) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  rmSync(root, { recursive: true, force: true });
});

test.skipIf(!linux)('SIGTERM with a hung agent check and busy terminals: exits within 10 s, no child left', async () => {
  const token = readFileSync(join(dataDir, 'token'), 'utf8').trim();
  const res = await fetch(`${base}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, device: 'CAST menu bar (Mac)' }) });
  const { cookie } = (await res.json()) as { cookie: string };

  // the account check hangs, with its own child
  await until(() => marked().length > 0, 20_000, 'the hung agent check');

  // a terminal: one command in the background, one in the foreground
  const ws = new WebSocket(`${base.replace('http', 'ws')}/term?target=town&cols=80&rows=24`, { headers: { cookie } } as unknown as string[]);
  let screen = '';
  ws.binaryType = 'arraybuffer';
  ws.onmessage = (ev) => (screen += typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer));
  await new Promise<void>((ok, fail) => {
    ws.onopen = () => ok();
    ws.onerror = () => fail(new Error('terminal did not open'));
  });
  const type = (d: string) => ws.send(JSON.stringify({ t: 'in', d }));
  type(`bash -c 'sleep 600; true' ${MARK}-term-bg &\r`);
  type(`echo ready-${MARK.length}\r`);
  await until(() => screen.includes(`ready-${MARK.length}`), 10_000, 'the shell');
  type(`bash -c 'sleep 600; true' ${MARK}-term-fg\r`);
  await until(() => marked().length >= 3, 10_000, 'the terminal commands');

  const before = descendants(proc!.pid);
  expect(before.length).toBeGreaterThanOrEqual(5); // shell, its two commands (and their sleeps), the agent and its child

  const t0 = Date.now();
  proc!.kill('SIGTERM');
  const code = await Promise.race([proc!.exited, Bun.sleep(10_000).then(() => 'timeout' as const)]);
  const took = Date.now() - t0;
  expect(code).toBe(0);
  expect(took).toBeLessThan(10_000);
  expect(output).toContain('SIGTERM: shutting down');

  await Bun.sleep(300); // let the kernel reap
  const left = before.filter(alive).map((pid) => `${pid}: ${processes().get(pid)?.cmd ?? '?'}`);
  expect(left).toEqual([]);
  expect(marked()).toEqual([]);
}, 60_000);
