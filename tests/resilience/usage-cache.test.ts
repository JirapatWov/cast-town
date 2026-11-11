// Opening Models & providers used to start `omp usage` (a few hundred MB) again and again: a report was kept for a
// minute and a failure not at all, and a missing omp logged three lines per open. Now a report is reused for minutes,
// a failure for a minute, callers share one run, a page with no OAuth account asks for no limits, and a missing omp
// is one line in the log, then quiet.
import { afterAll, afterEach, describe, expect, spyOn, test } from 'bun:test';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProviderAccounts, USAGE_FAILURE_TTL_MS, USAGE_TTL_MS } from '../../server/agents/provider-accounts.ts';
import { cleanup as cleanupSys, makeSys, sleep } from '../rv-server/sys-world';
import { cleanupTmp, tmp } from './fake-omp';

afterAll(() => {
  cleanupTmp();
  cleanupSys();
});

/** A fake omp whose `usage` runs are counted; `fail` makes `usage --json` exit 1. */
function fakeUsageOmp(o: { fail?: boolean } = {}) {
  const dir = tmp('cast-test-usage-');
  const bin = join(dir, 'omp.sh');
  const count = join(dir, 'usage.count');
  writeFileSync(
    bin,
    `#!/bin/bash
if [ "$1" = "usage" ] && [ "$2" = "--json" ]; then echo run >> ${count}; sleep 0.2; ${o.fail ? 'echo "provider said 500" >&2; exit 1' : `echo '{"reports":[]}'; exit 0`}; fi
if [ "$1" = "usage" ] && [ "$2" = "invalidate" ]; then exit 0; fi
if [ "$1" = "usage" ] && [ "$2" = "accounts" ]; then echo '[]'; exit 0; fi
echo "No models available" >&2; exit 3
`,
  );
  chmodSync(bin, 0o755);
  // anything else is the rpc-ui listing: an omp store with no sign-in at all
  const runs = () => (existsSync(count) ? readFileSync(count, 'utf8').split('\n').filter(Boolean).length : 0);
  return { bin, dir, runs };
}

const logs: string[] = [];
let spy: ReturnType<typeof spyOn> | null = null;
function captureLogs() {
  logs.length = 0;
  spy = spyOn(console, 'log').mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(' ')));
}
afterEach(() => {
  spy?.mockRestore();
  spy = null;
});

describe('omp usage is not started on every open', () => {
  test('a report is reused for minutes, and callers at the same time share one run', async () => {
    expect(USAGE_TTL_MS).toBeGreaterThanOrEqual(5 * 60_000);
    const omp = fakeUsageOmp();
    const accounts = new ProviderAccounts({ ompBin: omp.bin, env: { PATH: process.env.PATH }, cwd: omp.dir });
    const [a, b] = await Promise.all([accounts.usage(), accounts.usage()]);
    expect(a.error).toBeUndefined();
    expect(b).toBe(a);
    expect(omp.runs()).toBe(1);
    await accounts.usage(); // the page opened again
    await accounts.usage();
    expect(omp.runs()).toBe(1);
    await accounts.usage(true); // Check limits: asks omp now
    expect(omp.runs()).toBe(2);
    await accounts.usage(true); // pressed again at once: the fresh report is reused
    expect(omp.runs()).toBe(2);
    accounts.invalidateUsage(); // a sign-in: the next open asks again
    await accounts.usage();
    expect(omp.runs()).toBe(3);
  });

  test('a failure is answered again for a minute (no omp per open); Check limits retries at once; the last good report stays', async () => {
    expect(USAGE_FAILURE_TTL_MS).toBeGreaterThanOrEqual(30_000);
    captureLogs();
    const omp = fakeUsageOmp({ fail: true });
    const accounts = new ProviderAccounts({ ompBin: omp.bin, env: { PATH: process.env.PATH }, cwd: omp.dir });
    const first = await accounts.usage();
    expect(first.error).toContain('provider said 500');
    expect(await accounts.usage()).toBe(first);
    expect(await accounts.usage()).toBe(first);
    expect(omp.runs()).toBe(1);
    await accounts.usage(true);
    expect(omp.runs()).toBe(2);
    expect(accounts.lastUsage()).toBeNull(); // a failure is never taken for a report
    expect(logs.filter((l) => l.includes('usage failed')).length).toBe(1); // the same failure again stays quiet
  });

  test('a missing omp adds nothing to the log here, whatever is asked and how often (the start-up check said it)', async () => {
    captureLogs();
    const dir = tmp('cast-test-usage-');
    const accounts = new ProviderAccounts({ ompBin: join(dir, 'no-omp-here'), env: { PATH: process.env.PATH }, cwd: dir });
    for (let i = 0; i < 3; i++) {
      await accounts.list().catch(() => {});
      await accounts.usage(true);
      await accounts.identities();
    }
    expect(accounts.ompMissing).toBe(true);
    expect(logs.filter((l) => l.includes('accounts'))).toEqual([]);
  });
});

describe('the account order asks for limits only when there is an order', () => {
  test('no OAuth account: get_account_order answers without starting omp usage; get_usage still works and is cached', async () => {
    const omp = fakeUsageOmp();
    const w = makeSys({ extra: () => ({ ompBin: omp.bin, env: { HOME: omp.dir, PATH: process.env.PATH } }) });
    try {
      const ack = (await w.handle({ t: 'get_account_order' })) as { ok: boolean; data: { order: { providers: unknown[] } } };
      expect(ack.ok).toBe(true);
      expect(ack.data.order.providers).toEqual([]);
      await sleep(400); // a background usage run would have started by now
      expect(omp.runs()).toBe(0);
      await w.handle({ t: 'get_usage' });
      await w.handle({ t: 'get_usage' });
      expect(omp.runs()).toBe(1);
    } finally {
      await w.dispose();
    }
  });
});
