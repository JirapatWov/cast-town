// mac/cast-install-update.sh: Check for Updates' last step, which replaces CAST.app once the app has quit. Run for
// real against throwaway apps, with `open` (and, to make a step fail, `mv`) stubbed on PATH.
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const helper = join(import.meta.dir, '..', '..', 'mac', 'cast-install-update.sh');
const tmp = mkdtempSync(join(tmpdir(), 'cast-test-update-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Applications/CAST.app (old) with the new app staged next to it, a logs folder, and stubs for open and mv. */
interface UpdateCase {
  root: string;
  apps: string;
  current: string;
  staged: string;
  bin: string;
  opened: string;
  result: string;
}

let count = 0;
function setup(): UpdateCase {
  const root = join(tmp, `case${count++}`);
  const apps = join(root, 'Applications');
  const current = join(apps, 'CAST.app');
  const staged = join(apps, '.CAST-0.2.0-update.app');
  for (const [app, which] of [[current, 'old'], [staged, 'new']]) {
    mkdirSync(join(app, 'Contents'), { recursive: true });
    writeFileSync(join(app, 'Contents', 'which'), which);
  }
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const opened = join(root, 'opened');
  const result = join(root, 'logs', 'update-result');
  // open records what it opened and what the result file said at that moment (the app reads it when it starts);
  // FAIL_OPEN_ONCE: the first open fails, as for an app macOS refuses to start
  writeFileSync(join(bin, 'open'), [
    '#!/bin/bash',
    `if [ -n "\${FAIL_OPEN_ONCE:-}" ] && [ ! -f "${root}/open-failed" ]; then : >"${root}/open-failed"; exit 1; fi`,
    `printf '%s\\n' "$*" >>"${opened}"`,
    `cat "${result}" >>"${root}/seen" 2>/dev/null || echo none >>"${root}/seen"`,
    '',
  ].join('\n'));
  // FAIL_MV_FROM, FAIL_MV_FROM2: a mv whose source contains this fails, as it would without permission
  writeFileSync(join(bin, 'mv'), [
    '#!/bin/bash',
    'case "$1" in *"${FAIL_MV_FROM:-//none}"* | *"${FAIL_MV_FROM2:-//none}"*) echo "mv: denied" >&2; exit 1 ;; esac',
    'exec /bin/mv "$@"',
    '',
  ].join('\n'));
  chmodSync(join(bin, 'open'), 0o755);
  chmodSync(join(bin, 'mv'), 0o755);
  return { root, apps, current, staged, bin, opened, result };
}

function run(s: UpdateCase, pid: number, env: Record<string, string> = {}, staged = s.staged) {
  const r = Bun.spawnSync(['bash', helper, String(pid), s.current, staged, '0.2.0', s.result], {
    env: { ...process.env, PATH: `${s.bin}:${process.env.PATH}`, CAST_UPDATE_WAIT_SECONDS: '5', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    code: r.exitCode,
    result: existsSync(s.result) ? readFileSync(s.result, 'utf8').trim() : '',
    which: existsSync(join(s.current, 'Contents', 'which')) ? readFileSync(join(s.current, 'Contents', 'which'), 'utf8') : '',
    opened: existsSync(s.opened) ? readFileSync(s.opened, 'utf8').trim() : '',
    seen: existsSync(join(s.root, 'seen')) ? readFileSync(join(s.root, 'seen'), 'utf8').trim() : '',
    apps: readdirSync(s.apps).sort(),
  };
}

/** The app: a process that exits after `seconds`. Not a child of this test (its children stay zombies while
 *  spawnSync blocks, and look alive), as the quitting CAST.app is not the helper's to reap either. */
function app(seconds: number): number {
  const r = Bun.spawnSync(['bash', '-c', `sleep ${seconds} >/dev/null 2>&1 </dev/null & echo $!`], { stdout: 'pipe' });
  return Number(r.stdout.toString().trim());
}

describe('mac/cast-install-update.sh', () => {
  test('waits for the app to quit, puts the new app in its place, opens it and reports', () => {
    const s = setup();
    const started = Date.now();
    const r = run(s, app(0.6));
    expect(Date.now() - started).toBeGreaterThanOrEqual(500); // not before the app is gone
    expect(r.code).toBe(0);
    expect(r.which).toBe('new');
    expect(r.apps).toEqual(['CAST.app']); // neither the staged copy nor the old app is left behind
    expect(r.result).toBe('installed 0.2.0');
    expect(r.opened).toBe(s.current);
    expect(r.seen).toBe('installed 0.2.0'); // written before the new app starts and looks for it
    expect(readFileSync(join(s.root, 'logs', 'update.log'), 'utf8')).toContain('installed 0.2.0');
  });

  test('an app that does not quit in time keeps running as it is', () => {
    const s = setup();
    const stuck = app(30);
    try {
      const r = run(s, stuck, { CAST_UPDATE_WAIT_SECONDS: '1' });
      expect(r.code).not.toBe(0);
      expect(r.which).toBe('old');
      expect(r.apps).toEqual(['CAST.app']);
      expect(r.result).toBe('failed CAST did not quit within 1 seconds');
      expect(r.opened).toBe(''); // it is still open
    } finally {
      process.kill(stuck);
    }
  });

  test('when the old app can not be moved aside (no permission), it stays and is opened again', () => {
    const s = setup();
    const r = run(s, 999999, { FAIL_MV_FROM: '/CAST.app' });
    expect(r.code).not.toBe(0);
    expect(r.which).toBe('old');
    expect(r.apps).toEqual(['CAST.app']);
    expect(r.result).toMatch(/^failed the old CAST\.app could not be moved aside/);
    expect(r.opened).toBe(s.current);
  });

  test('when the new app can not be put in place, the old one goes back and is opened again', () => {
    const s = setup();
    const r = run(s, 999999, { FAIL_MV_FROM: '-update.app' });
    expect(r.code).not.toBe(0);
    expect(r.which).toBe('old');
    expect(r.apps).toEqual(['CAST.app']);
    expect(r.result).toBe('failed the new CAST.app could not be put in place');
    expect(r.opened).toBe(s.current);
  });

  test('when the old app can not be put back either, the result says where it is', () => {
    const s = setup();
    const r = run(s, 999999, { FAIL_MV_FROM: '-update.app', FAIL_MV_FROM2: '.previous-' });
    expect(r.code).not.toBe(0);
    expect(r.result).toMatch(/^failed the new CAST\.app could not be put in place, and the previous one is at \S*\/CAST\.previous-\d+\.app/);
    expect(r.apps).toEqual([expect.stringMatching(/^CAST\.previous-\d+\.app$/)]); // kept, never deleted
    expect(r.opened).toBe('');
  });

  test('a new app that does not open is swapped back for the previous one', () => {
    const s = setup();
    const r = run(s, 999999, { FAIL_OPEN_ONCE: '1' });
    expect(r.code).not.toBe(0);
    expect(r.which).toBe('old');
    expect(r.apps).toEqual(['CAST.app']);
    expect(r.result).toBe('failed the new CAST did not open, so the previous one is back');
    expect(r.opened).toBe(s.current);
    expect(r.seen).toBe('failed the new CAST did not open, so the previous one is back');
  });

  test('moves nothing that is not an app next to the one in use', () => {
    const s = setup();
    const elsewhere = join(s.root, 'Elsewhere.app');
    mkdirSync(join(elsewhere, 'Contents'), { recursive: true });
    const r = run(s, 999999, {}, elsewhere);
    expect(r.code).not.toBe(0);
    expect(r.result).toBe('failed the new app is not next to the one in use');
    expect(r.which).toBe('old');
    expect(existsSync(elsewhere)).toBe(true);
    expect(r.apps).toEqual(['.CAST-0.2.0-update.app', 'CAST.app']);
    expect(r.opened).toBe(s.current); // the app that quit for the update opens again
  });
});
