// omp-check.ts: CAST_ env settings, the agent timeouts, and telling a missing agent from a slow or broken one (#6).
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_CHECK_TIMEOUT_S, DEFAULT_START_TIMEOUT_S, envSetting, ompTimeouts, probeOmpVersion, runOmp } from '../../server/agents/omp-check.ts';
import { cleanupTmp, fakeOmp, tmp } from './fake-omp';

afterAll(cleanupTmp);

describe('settings', () => {
  test('CAST_ wins over RLT_, blanks count as unset', () => {
    expect(envSetting({ CAST_KEY_CHECK: '0', RLT_KEY_CHECK: '1' }, 'KEY_CHECK')).toBe('0');
    expect(envSetting({ RLT_KEY_CHECK: '1' }, 'KEY_CHECK')).toBe('1');
    expect(envSetting({ CAST_KEY_CHECK: '  ', RLT_KEY_CHECK: '1' }, 'KEY_CHECK')).toBe('1');
    expect(envSetting({}, 'KEY_CHECK')).toBeUndefined();
  });

  test('timeouts: seconds from the env, defaults for nonsense', () => {
    expect(ompTimeouts({})).toEqual({ checkMs: DEFAULT_CHECK_TIMEOUT_S * 1000, startMs: DEFAULT_START_TIMEOUT_S * 1000 });
    expect(ompTimeouts({ CAST_AGENT_TIMEOUT: '120', CAST_AGENT_START_TIMEOUT: '90' })).toEqual({ checkMs: 120_000, startMs: 90_000 });
    expect(ompTimeouts({ CAST_AGENT_TIMEOUT: 'abc', CAST_AGENT_START_TIMEOUT: '1' })).toEqual({ checkMs: DEFAULT_CHECK_TIMEOUT_S * 1000, startMs: DEFAULT_START_TIMEOUT_S * 1000 });
  });
});

describe('runOmp / probeOmpVersion', () => {
  const dir = tmp();
  const env = { HOME: dir, PATH: process.env.PATH };

  test('nothing at the path → missing (not a timeout, not "failed")', async () => {
    const r = await runOmp('/nonexistent/omp', ['--version'], env, 5000);
    expect(r.kind).toBe('missing');
    expect(r.kind !== 'ok' && r.error).toContain("wasn't found at /nonexistent/omp");
  });

  test('the cast-agent launcher of an agent that was never built → missing, like nothing at all', async () => {
    const bin = join(dir, 'unbuilt-agent', 'bin', 'cast-agent');
    mkdirSync(join(dir, 'unbuilt-agent', 'bin'), { recursive: true });
    copyFileSync(join(import.meta.dir, '..', '..', 'agent', 'bin', 'cast-agent'), bin);
    chmodSync(bin, 0o755);
    const r = await probeOmpVersion(bin, env, 5000);
    expect(r.kind).toBe('missing');
    expect(r.kind !== 'ok' && r.error).toContain(`isn't built at ${bin}`);
  });

  test('a slow omp → timeout, said in plain words (not "exited 137")', async () => {
    const { bin } = fakeOmp(dir, 'slow', { versionDelay: 5 });
    const t0 = Date.now();
    const r = await probeOmpVersion(bin, env, 300);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(r.kind).toBe('timeout');
    expect(r.kind !== 'ok' && r.error).toMatch(/didn't answer within 0 s|didn't answer within/);
    expect(r.kind !== 'ok' && r.error).not.toContain('137');
  });

  test('an error exit → failed, with the end of what it printed', async () => {
    const { bin } = fakeOmp(dir, 'broken', { modelsExit: 2 });
    const r = await runOmp(bin, ['models', '--json'], env, 5000);
    expect(r.kind).toBe('failed');
    expect(r.kind !== 'ok' && r.error).toContain('exited with code 2');
    expect(r.kind !== 'ok' && r.error).toContain('boom: no config');
  });

  test('a healthy omp → its version', async () => {
    const { bin } = fakeOmp(dir, 'ok', { version: '18.13.2-cast.1' });
    expect(await probeOmpVersion(bin, env, 5000)).toEqual({ kind: 'ok', version: '18.13.2-cast.1' });
  });
});
