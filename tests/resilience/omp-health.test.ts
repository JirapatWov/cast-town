// OmpHealth (#6, #68, #69): background checks with honest states, retries after a failure, Refresh that reuses a
// recent result instead of starting another few-hundred-MB omp.
import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ModelRegistry } from '../../server/agents/models.ts';
import { OmpHealth } from '../../server/agents/omp-health.ts';
import { cleanupTmp, fakeOmp, tmp } from './fake-omp';

afterAll(cleanupTmp);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const OPUS = { provider: 'anthropic', id: 'claude-opus-5-5' };

function make(bin: string, o: { checkMs?: number; retry?: number[]; missingRetryMs?: number; withAgentDir?: boolean } = {}) {
  const dir = tmp();
  const agentDir = join(dir, 'agent');
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, 'agent.db'), 'x');
  const env = { HOME: dir, PATH: process.env.PATH };
  const models = new ModelRegistry(bin, env, { agentDir: o.withAgentDir === false ? undefined : agentDir, timeoutMs: o.checkMs ?? 5000 });
  const changes: boolean[] = [];
  const health = new OmpHealth({
    bin,
    env,
    models,
    timeouts: { checkMs: o.checkMs ?? 5000, startMs: 45_000 },
    onChange: (w) => changes.push(w.modelsChecked),
    retryDelaysMs: o.retry ?? [60_000],
    missingRetryMs: o.missingRetryMs ?? 60_000,
  });
  return { health, models, changes, dir };
}

describe('the first look', () => {
  test('healthy omp, nobody signed in → omp ok, models ok, nothing connected (the banner says to connect one)', async () => {
    const omp = fakeOmp(tmp(), 'empty', {});
    const { health, models, changes } = make(omp.bin);
    expect(health.health().omp).toBe('checking');
    expect(health.health().models).toBe('checking');
    await health.start();
    const h = health.health();
    expect(h.omp).toBe('ok');
    expect(h.models).toBe('ok');
    expect(h.checking).toBe(false);
    expect(h.retryAt).toBeUndefined();
    expect(models.anyAvailable()).toBe(false);
    expect(health.summary()).toBe('cast-agent 18.13.2 · no AI account connected yet — connect one in Models & providers');
    expect(health.version).toBe('18.13.2');
    expect(changes.at(-1)).toBe(true); // the app heard the result
    health.dispose();
  });

  test('omp missing → its own state (not "not signed in"), looked for again on a timer', async () => {
    const { health } = make('/nonexistent/omp', { missingRetryMs: 50 });
    await health.start();
    const h = health.health();
    expect(h.omp).toBe('missing');
    expect(h.ompPath).toBe('/nonexistent/omp');
    expect(h.retryAt).toBeGreaterThan(Date.now() - 10);
    expect(health.summary()).toContain("wasn't found at /nonexistent/omp — nobody can work");
    health.dispose();
  });

  test('omp missing → one clear line (the start-up result, from summary()), then quiet retries', async () => {
    const lines: string[] = [];
    const spy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')));
    let summary = '';
    try {
      const { health, models } = make('/nonexistent/omp', { missingRetryMs: 30 });
      await health.start();
      summary = health.summary(); // what agents/index.ts logs once the first look is done
      await sleep(200); // several retries
      await health.recheckMissing();
      await models.detect();
      health.dispose();
    } finally {
      spy.mockRestore();
    }
    expect(summary).toContain("wasn't found at /nonexistent/omp");
    expect(lines).toEqual([]); // the retries and the model checks add nothing
  });

  test('omp installed while CAST runs → noticed by the next look', async () => {
    const dir = tmp();
    const later = join(dir, 'omp.sh');
    const { health } = make(later, { missingRetryMs: 50 });
    await health.start();
    expect(health.health().omp).toBe('missing');
    const real = fakeOmp(dir, 'real', { models: [OPUS] });
    writeFileSync(later, `#!/bin/bash\nexec ${real.bin} "$@"\n`, { mode: 0o755 });
    for (let i = 0; i < 60 && health.health().models !== 'ok'; i++) await sleep(25);
    expect(health.health().omp).toBe('ok');
    expect(health.health().models).toBe('ok');
    health.dispose();
  });

  test('slow omp → "failed" with the reason, a retry planned; nothing counts as connected (nobody works until a check works)', async () => {
    const omp = fakeOmp(tmp(), 'slow', { versionDelay: 3, modelsDelay: 3 });
    const { health, models } = make(omp.bin, { checkMs: 300 });
    await health.start();
    const h = health.health();
    expect(h.omp).toBe('failed');
    expect(h.ompError).toContain("didn't answer");
    expect(h.models).toBe('failed');
    expect(h.modelsError).toContain("didn't answer");
    expect(h.retryAt).toBeGreaterThan(Date.now());
    expect(models.anyAvailable()).toBe(false);
    expect(health.summary()).toContain('nobody can work until a check works; retrying');
    expect(health.summary()).not.toMatch(/\bdemo\b/);
    health.dispose();
  });

  test('a failed check is retried by itself and recovers', async () => {
    const dir = tmp();
    const flag = join(dir, 'fixed');
    const omp = fakeOmp(dir, 'flaky', { models: [OPUS], rpc: '' });
    // models fails until the flag file exists
    const wrapper = join(dir, 'wrap.sh');
    writeFileSync(wrapper, `#!/bin/bash\nif [ "$1" = models ] && [ ! -f ${flag} ]; then echo nope >&2; exit 1; fi\nexec ${omp.bin} "$@"\n`, { mode: 0o755 });
    const { health } = make(wrapper, { retry: [50] });
    await health.start();
    expect(health.health().models).toBe('failed');
    writeFileSync(flag, '');
    for (let i = 0; i < 80 && health.health().models !== 'ok'; i++) await sleep(25);
    expect(health.health().models).toBe('ok');
    expect(health.health().retryAt).toBeUndefined();
    health.dispose();
  });
});

describe('Refresh (#69)', () => {
  test('reuses a recent good result while the sign-ins are unchanged — no new omp', async () => {
    const omp = fakeOmp(tmp(), 'counted', { models: [OPUS] });
    const { health, dir } = make(omp.bin);
    await health.start();
    expect(omp.count()).toBe(1);
    expect(await health.refresh()).toBe('reused');
    expect(await health.refresh()).toBe('reused');
    expect(omp.count()).toBe(1);
    // a sign-in changes omp's credential store → checked again
    writeFileSync(join(dir, 'agent', 'agent.db'), 'new login');
    const later = new Date(Date.now() + 5000);
    (await import('node:fs')).utimesSync(join(dir, 'agent', 'agent.db'), later, later);
    expect(await health.refresh()).toBe('checked');
    expect(omp.count()).toBe(2);
    health.dispose();
  });

  test('after a failure, Refresh checks again (and looks at omp itself again)', async () => {
    const omp = fakeOmp(tmp(), 'bad', { modelsExit: 1 });
    const { health } = make(omp.bin);
    await health.start();
    expect(health.health().models).toBe('failed');
    expect(await health.refresh()).toBe('checked');
    expect(omp.count()).toBe(2);
    health.dispose();
  });
});
