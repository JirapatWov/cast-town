// #25: a person's omp start — the wait goes on while omp reports startup progress (a slow machine is not a hung omp),
// a silent hang times out at the base limit, and the chat gets a plain sentence with omp's output behind Details.
import { afterAll, describe, expect, test } from 'bun:test';
import { OmpProcess, OmpStartTimeout } from '../../server/agents/omp-process.ts';
import { describeStartFailure } from '../../server/agents/start-failure.ts';
import { AGENT_BUILD_COMMAND } from '../../shared/omp-version.ts';
import { cleanupTmp, fakeOmp, tmp } from './fake-omp';

afterAll(cleanupTmp);

const env = { PATH: process.env.PATH, HOME: '/tmp' };
// omp's own watchdog line, with its chalk colours
const progress = (s: number) => `printf '\\033[33mStill starting after ${s}s\\033[39m\\033[2m — phase: extensions > load\\033[22m\\n  logs: /x/omp.log · re-run with PI_DEBUG_STARTUP=1\\n' >&2`;

describe('OmpProcess ready wait', () => {
  test('omp that keeps reporting progress gets more time than the base limit', async () => {
    const dir = tmp();
    const { bin } = fakeOmp(dir, 'slowboot', {
      rpc: `for i in 1 2 3 4 5 6; do ${progress(10)}; sleep 0.1; done; echo '{"type":"ready"}'; sleep 5`,
    });
    const p = new OmpProcess({ bin, cwd: dir, args: [], env, readyTimeoutMs: 250, maxReadyMs: 3000 });
    const seen: number[] = [];
    p.onStartProgress = (s) => seen.push(s);
    await p.start(); // ready after ~0.6 s although the base limit is 0.25 s
    expect(seen.length).toBeGreaterThan(2);
    expect(seen[0]).toBe(10);
    p.kill();
  });

  test('a silent omp times out at the base limit (progressed: false)', async () => {
    const dir = tmp();
    const { bin } = fakeOmp(dir, 'hung', { rpc: 'sleep 5' });
    const p = new OmpProcess({ bin, cwd: dir, args: [], env, readyTimeoutMs: 300, maxReadyMs: 3000 });
    const t0 = Date.now();
    const err = await p.start().then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(OmpStartTimeout);
    expect((err as OmpStartTimeout).progressed).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  test('progress forever still ends at the cap', async () => {
    const dir = tmp();
    const { bin } = fakeOmp(dir, 'forever', { rpc: `while true; do ${progress(20)}; sleep 0.1; done` });
    const p = new OmpProcess({ bin, cwd: dir, args: [], env, readyTimeoutMs: 200, maxReadyMs: 700 });
    const t0 = Date.now();
    const err = await p.start().then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(OmpStartTimeout);
    expect((err as OmpStartTimeout).progressed).toBe(true);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(650);
    expect(Date.now() - t0).toBeLessThan(2500);
    expect((err as OmpStartTimeout).stderr).toContain('Still starting');
  });
});

describe('describeStartFailure', () => {
  const ctx = { name: 'Assistant', modelLabel: 'Claude Opus 5.5', ompBin: '/opt/omp', startTimeoutS: 45 };

  test('timeout: a plain sentence; omp’s output and the setting behind Details', () => {
    const f = describeStartFailure(new OmpStartTimeout(47, true, 'Still starting after 21s — phase: x\n  logs: /root/.omp/logs/a.log'), ctx);
    expect(f.kind).toBe('timeout');
    expect(f.summary).toBe('Assistant took too long to start (over 47 s). The computer may be busy — try again.');
    expect(f.summary).not.toContain('stderr');
    expect(f.summary).not.toContain('/root/.omp');
    expect(f.details).toContain('CAST_AGENT_START_TIMEOUT');
    expect(f.details).toContain('/root/.omp/logs/a.log');
  });

  test('missing agent: says where it looked and how to build it', () => {
    const f = describeStartFailure(new Error("Could not start the agent (/opt/omp): ENOENT: no such file or directory, posix_spawn '/opt/omp'"), ctx);
    expect(f.kind).toBe('missing');
    expect(f.summary).toContain("wasn't found at /opt/omp");
    expect(f.details).toContain(AGENT_BUILD_COMMAND);
  });

  test('no credentials, a crash at boot, a model swap, anything else', () => {
    expect(describeStartFailure(new Error('The agent exited (code 1). stderr: No API key found for anthropic'), ctx).kind).toBe('credentials');
    const crash = describeStartFailure(new Error('The agent exited (code null, SIGSEGV). stderr: boom'), ctx);
    expect(crash.kind).toBe('exited');
    expect(crash.summary).toBe("Assistant couldn't start: the agent was stopped (SIGSEGV) while starting.");
    expect(describeStartFailure(new Error('The agent resolved x/y instead of the requested a/b; refusing to run on a different model'), ctx).kind).toBe('model');
    const other = describeStartFailure(new Error('weird'), ctx);
    expect(other.summary).toBe("Assistant couldn't start.");
    expect(other.details).toBe('weird');
  });
});
