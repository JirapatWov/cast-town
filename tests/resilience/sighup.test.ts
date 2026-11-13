// FINDING: "if CAST is stopped with kill, its agents keep running". SIGTERM and SIGINT already shut down properly
// (tests/mac/sigterm.test.ts), but SIGHUP — what the server gets when the terminal it was started in closes — was not
// handled, so it killed the server on the spot, and a busy agent whose CAST was gone finished its turn on its own. Now
// SIGHUP takes the same shutdown: agents and shells stopped, then exit 0.
import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dir, '../..');
const root = mkdtempSync(join(tmpdir(), 'cast-sighup-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function freePort(): number {
  const s = Bun.serve({ port: 0, fetch: () => new Response('') });
  const p = s.port!;
  s.stop(true);
  return p;
}

test('SIGHUP (the terminal closed) shuts the server down like SIGTERM', async () => {
  const home = join(root, 'home');
  const dataDir = join(root, 'data');
  mkdirSync(home, { recursive: true });
  const proc = Bun.spawn([process.execPath, join(REPO, 'server', 'index.ts')], {
    cwd: root,
    env: { HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8', CAST_PORT: String(freePort()), CAST_STUB_AGENTS: '1', CAST_WEB_DIST: join(root, 'no-dist'), CAST_TERMINAL: '0', CAST_PUSH: 'off', CAST_DATA_DIR: dataDir },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let output = '';
  for (const s of [proc.stdout, proc.stderr]) void (async () => { for await (const c of s) output += new TextDecoder().decode(c); })();
  try {
    const end = Date.now() + 60_000;
    while (!existsSync(join(dataDir, 'listen.json'))) {
      if (Date.now() > end) throw new Error(`the server did not start\n${output.slice(-1500)}`);
      await Bun.sleep(100);
    }
    proc.kill('SIGHUP');
    const code = await Promise.race([proc.exited, Bun.sleep(10_000).then(() => 'still running')]);
    expect(code).toBe(0); // a clean shutdown, not killed by the signal
    expect(output).toContain('SIGHUP: shutting down');
    expect(output).toMatch(/bye \(/);
  } finally {
    proc.kill('SIGKILL');
  }
}, 90_000);
