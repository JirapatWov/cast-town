// The Hermes bridge against a real CAST server process (dev stub agents), the way Hermes uses it: `cast-hermes pair`
// once (the token read from CAST's data folder), then the MCP server over stdio — status lists the house, tell gives
// the job's lead a message and returns its reply, read shows the chat. A session revoked in Settings → Devices stays
// revoked: the bridge says so instead of pairing again on its own.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { Subprocess } from 'bun';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CastLink } from '../../hermes/client';

const REPO = resolve(import.meta.dir, '../..');
const CLI = join(REPO, 'hermes', 'cast-hermes.ts');
const root = mkdtempSync(join(tmpdir(), 'cast-hermes-e2e-'));
const home = join(root, 'home');
const dataDir = join(root, 'data');
const bridgeDir = join(root, 'bridge');
let server: Subprocess<'ignore', 'pipe', 'pipe'>;
let output = '';
const env = () => ({ HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin', CAST_HERMES_HOME: bridgeDir });

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

async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn([process.execPath, CLI, ...args], { env: env(), stdout: 'pipe', stderr: 'pipe' });
  const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code, out, err };
}

beforeAll(async () => {
  mkdirSync(join(root, 'ws'), { recursive: true });
  mkdirSync(home, { recursive: true });
  const port = freePort();
  server = Bun.spawn([process.execPath, join(REPO, 'server', 'index.ts')], {
    cwd: root,
    env: { HOME: home, USER: 'alice', PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8', CAST_PORT: String(port), CAST_STUB_AGENTS: '1', CAST_WEB_DIST: join(root, 'no-dist'), CAST_TERMINAL: '0', CAST_PUSH: 'off', CAST_DATA_DIR: dataDir, CAST_WORKSPACE: join(root, 'ws') },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const drain = async (s: ReadableStream<Uint8Array>) => {
    const dec = new TextDecoder();
    for await (const chunk of s) output += dec.decode(chunk);
  };
  void drain(server.stdout);
  void drain(server.stderr);
  await until(() => existsSync(join(dataDir, 'listen.json')), 60_000, 'server start');
}, 90_000);

afterAll(async () => {
  server?.kill('SIGTERM');
  await Promise.race([server?.exited, Bun.sleep(10_000)]);
  rmSync(root, { recursive: true, force: true });
});

test('pairing: a wrong token is refused; the data folder’s token pairs as “Hermes Agent”', async () => {
  const wrong = await run(['pair', '--data-dir', dataDir, '--token', 'not-the-token']);
  expect(wrong.code).toBe(1);
  expect(wrong.err).toContain('CAST refused to pair');
  expect(existsSync(join(bridgeDir, 'session.json'))).toBe(false);

  const ok = await run(['pair', '--data-dir', dataDir]);
  expect(ok.code).toBe(0);
  expect(ok.out).toContain('as “Hermes Agent”');
  const devices = readFileSync(join(dataDir, 'devices.json'), 'utf8');
  expect(devices).toContain('Hermes Agent');
}, 30_000);

test('MCP: status, tell (with the reply) and read, over stdio', async () => {
  // a house to talk to, made through the same kind of link the bridge uses
  const link = new CastLink(bridgeDir, () => {});
  link.start();
  await link.ready(15_000);
  const lot = link.city.lots.find((l) => !link.city.projects.some((p) => p.lotId === l.id))!;
  await link.request({ t: 'create_project', name: 'Bakery', lotId: lot.id, style: 'house', template: 'empty' });
  link.stop();

  const mcp = Bun.spawn([process.execPath, CLI, 'mcp'], { env: env(), stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  const replies = new Map<number, { result?: { content: { text: string }[]; isError?: boolean } }>();
  void (async () => {
    let buf = '';
    const dec = new TextDecoder();
    for await (const chunk of mcp.stdout) {
      buf += dec.decode(chunk);
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const m = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        replies.set(m.id, m);
      }
    }
  })();
  let id = 0;
  const rpc = async (method: string, params: unknown) => {
    const n = ++id;
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`);
    mcp.stdin.flush();
    return until(() => replies.get(n), 60_000, `reply to ${method}`);
  };
  const tool = async (name: string, args: unknown) => {
    const r = await rpc('tools/call', { name, arguments: args });
    expect(r.result?.isError).toBeFalsy();
    return r.result!.content[0]!.text;
  };
  try {
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    expect(await tool('status', {})).toContain('House “Bakery”');
    const told = await tool('tell', { house: 'bak', text: 'what is in this folder?', wait_seconds: 30 });
    expect(told).toContain('Sent to');
    expect(told).toMatch(/\n\S[^\n]*: \S/); // the lead's reply, after the message
    const chat = await tool('read', { house: 'Bakery' });
    expect(chat).toContain('User: what is in this folder?');
    const unknown = await rpc('tools/call', { name: 'tell', arguments: { house: 'Library', text: 'hi' } });
    expect(unknown.result?.isError).toBe(true);
    expect(unknown.result?.content[0]?.text).toContain('Houses: “Bakery”');
  } finally {
    mcp.kill();
  }
}, 90_000);

test('a session revoked in Settings → Devices stays revoked, and the bridge says so', async () => {
  const session = JSON.parse(readFileSync(join(bridgeDir, 'session.json'), 'utf8')) as { url: string; cookie: string; deviceId: string };
  const res = await fetch(`${session.url}/api/devices/${session.deviceId}`, { method: 'DELETE', headers: { cookie: session.cookie } });
  expect(res.ok).toBe(true);
  const status = await run(['status']);
  expect(status.code).toBe(1);
  expect(status.err).toContain('signed this bridge out');
}, 60_000);
