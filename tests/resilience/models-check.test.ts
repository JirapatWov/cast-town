// ModelRegistry's check states (#6), the saved model list (#6/#68: a restart on a slow machine goes by it) and not
// starting omp for nothing (#69: one check at a time, Refresh reuses a recent one while the sign-ins are unchanged).
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { credentialFingerprint, ModelRegistry } from '../../server/agents/models.ts';
import { cleanupTmp, fakeOmp, tmp } from './fake-omp';

afterAll(cleanupTmp);

const OPUS = { provider: 'anthropic', id: 'claude-opus-5-5' };

function world() {
  const dir = tmp();
  const agentDir = join(dir, 'agent');
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, 'agent.db'), 'x');
  return { dir, agentDir, cacheFile: join(dir, 'data', 'models-cache.json'), env: { HOME: dir, PATH: process.env.PATH } };
}

describe('states', () => {
  test('never asked → idle; a first check that fails with nothing saved → failed: nothing connected', async () => {
    const w = world();
    const { bin } = fakeOmp(w.dir, 'broken', { modelsExit: 1 });
    const m = new ModelRegistry(bin, w.env, { cacheFile: w.cacheFile, agentDir: w.agentDir });
    expect(m.state).toBe('idle');
    const run = m.detect();
    expect(m.state).toBe('checking');
    await run;
    expect(m.state).toBe('failed');
    expect(m.failure).toBe('failed');
    expect(m.detectError).toContain('exited with code 1');
    // an old rule counted a failed check as "something is connected"; nothing is (the app says why nobody can work)
    expect(m.anyAvailable()).toBe(false);
    expect(m.resolve('anthropic/claude-opus-5-5')).toEqual({ demo: true, selector: 'rlt-demo/claude-opus-5-5' }); // unchanged
    expect(m.demoActive()).toBe(false); // but nobody runs on the scripted model: it is the tests' opt-in only
  });

  test('demoActive: only with the scripted option (CAST_MOCK_LLM) and only while nothing is connected', async () => {
    const w = world();
    const none = fakeOmp(w.dir, 'none', { models: [] });
    const prod = new ModelRegistry(none.bin, w.env);
    const scripted = new ModelRegistry(none.bin, w.env, { scripted: true });
    expect(prod.demoActive()).toBe(false);
    expect(scripted.demoActive()).toBe(true); // never checked: nothing connected
    await Promise.all([prod.detect(), scripted.detect()]);
    expect(prod.state).toBe('ok');
    expect(prod.anyAvailable()).toBe(false);
    expect(prod.demoActive()).toBe(false);
    expect(scripted.demoActive()).toBe(true);
    const w2 = world();
    const one = fakeOmp(w2.dir, 'one', { models: [OPUS] });
    const signedIn = new ModelRegistry(one.bin, w2.env, { scripted: true });
    await signedIn.detect();
    expect(signedIn.anyAvailable()).toBe(true);
    expect(signedIn.demoActive()).toBe(false); // something is connected: no stand-in next to real models
  });

  test('a missing omp is a failure of its own kind', async () => {
    const w = world();
    const m = new ModelRegistry('/nonexistent/omp', w.env);
    await m.detect();
    expect(m.state).toBe('failed');
    expect(m.failure).toBe('missing');
  });

  test('a good check → ok and saved; the next run goes by the saved list (stale) until its own check', async () => {
    const w = world();
    const { bin } = fakeOmp(w.dir, 'good', { models: [OPUS] });
    const a = new ModelRegistry(bin, w.env, { cacheFile: w.cacheFile, agentDir: w.agentDir });
    await a.detect();
    expect(a.state).toBe('ok');
    expect(existsSync(w.cacheFile)).toBe(true);
    expect(JSON.parse(readFileSync(w.cacheFile, 'utf8')).models.map((x: { id: string }) => x.id)).toEqual(['claude-opus-5-5']);

    // restart: the saved list counts at once — a signed-in user is not locked out while omp is slow
    const b = new ModelRegistry(bin, w.env, { cacheFile: w.cacheFile, agentDir: w.agentDir });
    expect(b.state).toBe('stale');
    expect(b.hasResult).toBe(true);
    expect(b.isAvailable('anthropic/claude-opus-5-5')).toBe(true);
    expect(b.checkedAt).toBeGreaterThan(0);

    // its own check fails (too slow): the saved list stays, the reason is known
    const slow = fakeOmp(w.dir, 'slow', { modelsDelay: 5 });
    const c = new ModelRegistry(slow.bin, w.env, { cacheFile: w.cacheFile, agentDir: w.agentDir, timeoutMs: 300 });
    expect(c.state).toBe('idle'); // another omp binary: the saved list isn't its
    const d = new ModelRegistry(bin, w.env, { cacheFile: w.cacheFile, agentDir: w.agentDir, timeoutMs: 300 });
    (d as unknown as { ompBin: string }).ompBin = slow.bin; // same saved list, but omp is slow now
    await d.detect();
    expect(d.state).toBe('stale');
    expect(d.failure).toBe('timeout');
    expect(d.isAvailable('anthropic/claude-opus-5-5')).toBe(true);
  });

  test('an unreadable saved list is ignored', () => {
    const w = world();
    mkdirSync(join(w.dir, 'data'), { recursive: true });
    writeFileSync(w.cacheFile, '{not json');
    const m = new ModelRegistry('/x/omp', w.env, { cacheFile: w.cacheFile });
    expect(m.state).toBe('idle');
  });
});

describe('not starting omp for nothing (#69)', () => {
  test('two checks at once are one omp run', async () => {
    const w = world();
    const omp = fakeOmp(w.dir, 'counted', { models: [OPUS], modelsDelay: 0.3 });
    const m = new ModelRegistry(omp.bin, w.env);
    await Promise.all([m.detect(), m.detect(), m.detect()]);
    expect(omp.count()).toBe(1);
  });

  test('upToDate: a recent good check with unchanged credential files; a sign-in (agent.db changes) makes it due', async () => {
    const w = world();
    const omp = fakeOmp(w.dir, 'fp', { models: [OPUS] });
    const m = new ModelRegistry(omp.bin, w.env, { agentDir: w.agentDir });
    expect(m.upToDate(60_000)).toBe(false); // nothing checked yet
    await m.detect();
    expect(m.upToDate(60_000)).toBe(true);
    expect(m.upToDate(60_000, Date.now() + 120_000)).toBe(false); // too old
    const before = credentialFingerprint(w.agentDir);
    writeFileSync(join(w.agentDir, 'agent.db'), 'signed in');
    utimesSync(join(w.agentDir, 'agent.db'), new Date(), new Date(Date.now() + 5000));
    expect(credentialFingerprint(w.agentDir)).not.toBe(before);
    expect(m.upToDate(60_000)).toBe(false);
  });

  test('firstResult waits for the very first check only', async () => {
    const w = world();
    const omp = fakeOmp(w.dir, 'first', { models: [OPUS], modelsDelay: 0.3 });
    const m = new ModelRegistry(omp.bin, w.env);
    await m.firstResult(); // nothing runs: at once
    void m.detect();
    const t0 = Date.now();
    await m.firstResult();
    expect(Date.now() - t0).toBeGreaterThan(150);
    expect(m.isAvailable('anthropic/claude-opus-5-5')).toBe(true);
    void m.detect(); // a Refresh: there is a result, nobody waits
    const t1 = Date.now();
    await m.firstResult();
    expect(Date.now() - t1).toBeLessThan(100);
  });
});
