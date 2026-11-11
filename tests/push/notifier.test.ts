// When CAST tells a device that someone needs the user (server/push/notifier.ts), against a fake hub, fake people and
// a fake clock: debounce, presence holds, coalescing, rate caps, generic payloads, revocation.
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerMsg } from '../../shared/protocol';
import { createNotifier, DEBOUNCE_MS, HOLD_MS, HOURLY_CAP, PRESENCE_TTL_MS, WAITING_GAP_MS, type Clock } from '../../server/push/notifier';
import type { SendOptions, SendTarget } from '../../server/push/send';
import { createPushStore, type PushStore } from '../../server/push/store';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** Timers that run only when the test moves the clock. */
function fakeClock(): Clock & { advance(ms: number): Promise<void> } {
  let t = 1_800_000_000_000;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => t,
    setTimeout(fn, ms) {
      const id = ++seq;
      timers.set(id, { at: t + ms, fn });
      return id;
    },
    clearTimeout(h) {
      timers.delete(h as number);
    },
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]);
        t = next[1].at;
        next[1].fn();
        await Bun.sleep(0);
      }
      t = end;
      await Bun.sleep(0);
    },
  };
}

interface Sent {
  deviceId: string;
  payload: { notification: { title: string; body: string; tag: string; navigate?: string; app_badge?: string; data: { kind: string; next: string; badge?: number } } };
  opts: SendOptions;
}

const ASSISTANT = { id: 'a1', name: 'Assistant', projectId: 'todo', jobId: 'main', status: 'idle', detail: '' };
const REVIEWER = { id: 'a2', name: 'Reviewer', projectId: 'todo', jobId: 'j2', status: 'idle', detail: '' };
const approval = (id: string, agentId = 'a1', tool = 'bash', ts = Date.now()) => ({
  id, agentId, projectId: 'todo', tool, title: 'Run rm -rf /secret/path', detail: 'SECRET-DETAIL cat ~/.ssh/id_rsa', ts,
});

function setup(o: { devices?: string[]; prefs?: Partial<{ waiting: boolean; runs: boolean; errors: boolean }> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cast-notify-'));
  roots.push(dir);
  const clock = fakeClock();
  const store: PushStore = createPushStore(dir);
  const devices = new Set(o.devices ?? ['d-phone']);
  for (const id of devices) {
    store.put({ deviceId: id, endpoint: `https://web.push.apple.com/${id}`, p256dh: 'x', auth: 'y', origin: 'https://box.tail.ts.net:8443', prefs: { waiting: true, runs: true, errors: false, ...o.prefs }, createdAt: 1, failures: 0 });
  }
  const sent: Sent[] = [];
  const sender = {
    async send(t: SendTarget, payload: string, opts: SendOptions) {
      sent.push({ deviceId: t.endpoint.split('/').pop()!, payload: JSON.parse(payload), opts });
      return { ok: true, status: 201 };
    },
  };
  const world = { agents: [ASSISTANT, REVIEWER] as Record<string, unknown>[], approvals: [] as Record<string, unknown>[], plans: [] as Record<string, unknown>[], runs: [] as Record<string, unknown>[] };
  const notifier = createNotifier({ store, sender: sender as never, contact: null, devices: { get: (id) => (devices.has(id) ? { id } : undefined) }, clock });
  const hub = notifier.tap({ broadcast: (_m: ServerMsg) => {} });
  notifier.attach({ snapshot: () => world as never, projects: () => [{ id: 'todo', name: 'todo-api' }] });
  const raise = (a: ReturnType<typeof approval>) => {
    world.approvals.push(a);
    hub.broadcast({ t: 'approval', approval: a } as never);
  };
  const resolve = (id: string) => {
    world.approvals = world.approvals.filter((x) => x.id !== id);
    hub.broadcast({ t: 'approval_resolved', id });
  };
  const run = (id: string, status: string, extra: Record<string, unknown> = {}) => {
    const r = { id, status, workflowName: 'Ship it', projectId: 'todo', jobId: 'j2', task: 'SECRET TASK TEXT', ...extra };
    world.runs = [...world.runs.filter((x) => x.id !== id), r];
    hub.broadcast({ t: 'run', run: r } as never);
  };
  return { clock, store, sent, notifier, hub, world, raise, resolve, run, devices };
}

describe('waiting for you', () => {
  test('a new approval → exactly one push after the debounce: tag = approval id, badge 1, next = the house', async () => {
    const w = setup();
    w.raise(approval('ap1'));
    await w.clock.advance(DEBOUNCE_MS - 100);
    expect(w.sent).toHaveLength(0);
    await w.clock.advance(200);
    expect(w.sent).toHaveLength(1);
    const n = w.sent[0]!.payload.notification;
    expect(n.title).toBe('Assistant needs your OK');
    expect(n.body).toBe('todo-api · tap to answer');
    expect(n.tag).toBe('ap1');
    expect(n.app_badge).toBe('1');
    expect(n.data).toMatchObject({ kind: 'waiting', next: '/#/house/todo', badge: 1 });
    expect(n.navigate).toBe('https://box.tail.ts.net:8443/#/house/todo');
    expect(w.sent[0]!.payload).toMatchObject({ web_push: 8030, mutable: true });
    expect(w.sent[0]!.opts).toMatchObject({ ttl: 43_200, urgency: 'high', topic: 'waiting' });
    await w.clock.advance(60_000);
    expect(w.sent).toHaveLength(1); // never again
  });

  test('a question and a plan get their own titles', async () => {
    const w = setup();
    w.raise(approval('q1', 'a2', 'ask'));
    await w.clock.advance(DEBOUNCE_MS);
    expect(w.sent.at(-1)!.payload.notification.title).toBe('Reviewer has a question');
    expect(w.sent.at(-1)!.payload.notification.data.next).toBe('/#/house/todo/j2');
    await w.clock.advance(WAITING_GAP_MS);
    w.world.plans.push({ id: 'p1', agentId: 'a1', projectId: 'todo', jobId: 'main', title: 'SECRET PLAN', status: 'pending', ts: Date.now() });
    w.hub.broadcast({ t: 'plan', plan: w.world.plans[0] } as never);
    await w.clock.advance(DEBOUNCE_MS);
    const n = w.sent.at(-1)!.payload.notification;
    expect(n.title).toBe('Assistant has a plan for you');
    expect(n.tag).toBe('plan:p1');
    expect(n.app_badge).toBe('2');
  });

  test('two approvals in the same moment → one "2 things need you", tag cast-waiting, opens the Inbox', async () => {
    const w = setup();
    // the same millisecond (a wall-clock ts could differ by one and put the newer first)
    const t = Date.now();
    w.raise(approval('ap1', 'a1', 'bash', t));
    w.raise(approval('ap2', 'a2', 'bash', t));
    await w.clock.advance(DEBOUNCE_MS);
    expect(w.sent).toHaveLength(1);
    const n = w.sent[0]!.payload.notification;
    expect(n.title).toBe('2 things need you');
    expect(n.body).toBe('Assistant and Reviewer · tap to open the Inbox');
    expect(n.tag).toBe('cast-waiting');
    expect(n.data.next).toBe('/?panel=inbox');
  });

  test('answered before the debounce → no push', async () => {
    const w = setup();
    w.raise(approval('ap1'));
    await w.clock.advance(500);
    w.resolve('ap1');
    await w.clock.advance(10_000);
    expect(w.sent).toHaveLength(0);
  });

  test('already waiting when CAST starts → no push', async () => {
    const w = setup();
    w.world.approvals.push(approval('old'));
    w.notifier.attach({ snapshot: () => w.world as never, projects: () => [{ id: 'todo', name: 'todo-api' }] });
    w.hub.broadcast({ t: 'agent', agent: ASSISTANT } as never);
    await w.clock.advance(10_000);
    expect(w.sent).toHaveLength(0);
  });
});

describe('presence', () => {
  test('the device itself is looking at CAST → skipped (and not told later)', async () => {
    const w = setup();
    w.notifier.presence('page1', 'd-phone', true);
    w.raise(approval('ap1'));
    await w.clock.advance(DEBOUNCE_MS);
    expect(w.sent).toHaveLength(0);
    w.notifier.presence('page1', 'd-phone', false);
    await w.clock.advance(120_000);
    w.hub.broadcast({ t: 'agent', agent: ASSISTANT } as never);
    await w.clock.advance(DEBOUNCE_MS);
    expect(w.sent).toHaveLength(0);
  });

  test('another device is looking → wait 60 s, then only what still waits', async () => {
    const w = setup({ devices: ['d-phone', 'd-mac'] });
    w.store.remove(['d-mac']); // the Mac has no subscription, it is only looking
    w.notifier.presence('macpage', 'd-mac', true);
    w.raise(approval('ap1'));
    w.raise(approval('ap2'));
    await w.clock.advance(DEBOUNCE_MS + 30_000);
    expect(w.sent).toHaveLength(0);
    w.resolve('ap2'); // answered on the Mac
    w.notifier.presence('macpage', 'd-mac', true); // still there
    await w.clock.advance(HOLD_MS);
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]!.payload.notification.tag).toBe('ap1');
    expect(w.sent[0]!.payload.notification.app_badge).toBe('1');
  });

  test('all answered while held → nothing', async () => {
    const w = setup();
    w.notifier.presence('macpage', null, true); // a tailnet page: no device, still "someone is looking"
    w.raise(approval('ap1'));
    await w.clock.advance(DEBOUNCE_MS + 10_000);
    w.resolve('ap1');
    await w.clock.advance(HOLD_MS);
    expect(w.sent).toHaveLength(0);
  });

  test(`presence ends after ${PRESENCE_TTL_MS / 1000} s without a heartbeat`, async () => {
    const w = setup();
    w.notifier.presence('page1', 'd-phone', true);
    await w.clock.advance(PRESENCE_TTL_MS + 1);
    w.raise(approval('ap1'));
    await w.clock.advance(DEBOUNCE_MS);
    expect(w.sent).toHaveLength(1);
  });
});

describe('team runs', () => {
  test('running → completed or failed → a push; aborted or interrupted → none', async () => {
    const w = setup();
    w.run('r1', 'running');
    w.run('r1', 'completed');
    await w.clock.advance(DEBOUNCE_MS);
    expect(w.sent).toHaveLength(1);
    const n = w.sent[0]!.payload.notification;
    expect(n.title).toBe('Team run finished');
    expect(n.body).toBe('“Ship it” · todo-api');
    expect(n.data).toMatchObject({ kind: 'run', next: '/#/house/todo/j2' });
    expect(w.sent[0]!.opts).toMatchObject({ ttl: 3600, urgency: 'normal', topic: 'run' });
    w.run('r2', 'waiting_approval');
    w.run('r2', 'failed');
    await w.clock.advance(DEBOUNCE_MS);
    expect(w.sent.at(-1)!.payload.notification.title).toBe('Team run failed');
    const before = w.sent.length;
    w.run('r3', 'running');
    w.run('r3', 'aborted');
    w.run('r4', 'running');
    w.run('r4', 'failed', { interrupted: true });
    w.run('r5', 'completed'); // never seen running here (before a restart): not news
    await w.clock.advance(DEBOUNCE_MS);
    expect(w.sent.length).toBe(before);
  });
});

describe('preferences and caps', () => {
  test('errors are off by default; on when asked', async () => {
    const off = setup();
    off.world.agents = [{ ...ASSISTANT, status: 'error', detail: 'SECRET STACK' }, REVIEWER];
    off.hub.broadcast({ t: 'agent', agent: off.world.agents[0] } as never);
    await off.clock.advance(DEBOUNCE_MS);
    expect(off.sent).toHaveLength(0);
    const on = setup({ prefs: { errors: true } });
    on.world.agents = [{ ...ASSISTANT, status: 'error', detail: 'SECRET STACK' }, REVIEWER];
    on.hub.broadcast({ t: 'agent', agent: on.world.agents[0] } as never);
    await on.clock.advance(DEBOUNCE_MS);
    expect(on.sent).toHaveLength(1);
    expect(on.sent[0]!.payload.notification.title).toBe('Assistant stopped with an error');
    expect(JSON.stringify(on.sent)).not.toContain('SECRET');
  });

  test('waiting off, runs off → nothing of those', async () => {
    const w = setup({ prefs: { waiting: false, runs: false } });
    w.raise(approval('ap1'));
    w.run('r1', 'running');
    w.run('r1', 'completed');
    await w.clock.advance(DEBOUNCE_MS * 3);
    expect(w.sent).toHaveLength(0);
  });

  test(`at most one waiting push per ${WAITING_GAP_MS / 1000} s: the next folds the rest in`, async () => {
    const w = setup();
    w.raise(approval('ap1'));
    await w.clock.advance(DEBOUNCE_MS);
    expect(w.sent).toHaveLength(1);
    w.raise(approval('ap2'));
    await w.clock.advance(DEBOUNCE_MS);
    w.raise(approval('ap3', 'a2'));
    await w.clock.advance(DEBOUNCE_MS);
    expect(w.sent).toHaveLength(1);
    await w.clock.advance(WAITING_GAP_MS);
    expect(w.sent).toHaveLength(2);
    expect(w.sent[1]!.payload.notification.title).toBe('2 things need you');
    expect(w.sent[1]!.payload.notification.app_badge).toBe('3');
  });

  test(`at most ${HOURLY_CAP} per device per hour`, async () => {
    const w = setup();
    for (let i = 0; i < HOURLY_CAP + 5; i++) {
      w.raise(approval(`ap${i}`));
      await w.clock.advance(WAITING_GAP_MS + DEBOUNCE_MS);
    }
    expect(w.sent).toHaveLength(HOURLY_CAP);
  });
});

describe('privacy and devices', () => {
  test('a payload never carries the approval title or detail, the run task or anything secret', async () => {
    const w = setup();
    w.raise(approval('ap1'));
    w.run('r1', 'running');
    w.run('r1', 'completed');
    await w.clock.advance(DEBOUNCE_MS * 2);
    const text = JSON.stringify(w.sent.map((s) => s.payload));
    expect(w.sent.length).toBeGreaterThan(0);
    for (const secret of ['SECRET', 'rm -rf', 'id_rsa', 'bash', 'Run rm']) expect(text).not.toContain(secret);
  });

  test('a signed-out device (forget) loses its subscription; a device missing at send time is dropped', async () => {
    const w = setup({ devices: ['d-phone', 'd-tablet'] });
    w.store.put({ ...w.store.get('d-phone')!, deviceId: 'd-tablet', endpoint: 'https://web.push.apple.com/d-tablet' });
    w.notifier.forget(['d-phone']);
    expect(w.store.get('d-phone')).toBeUndefined();
    w.devices.delete('d-tablet'); // forgotten by the DeviceBook (idle, evicted)
    w.raise(approval('ap1'));
    await w.clock.advance(DEBOUNCE_MS);
    expect(w.sent).toHaveLength(0);
    expect(w.store.list()).toHaveLength(0);
  });

  test('an observer error never breaks the broadcast', () => {
    const w = setup();
    const seen: string[] = [];
    const hub = w.notifier.tap({ broadcast: (m: ServerMsg) => void seen.push(m.t) });
    expect(() => hub.broadcast({ t: 'run', run: null } as never)).not.toThrow();
    expect(seen).toEqual(['run']);
  });

  test('a test notification goes to this device at once', async () => {
    const w = setup();
    const r = await w.notifier.sendTest('d-phone');
    expect(r.ok).toBe(true);
    expect(w.sent[0]!.payload.notification).toMatchObject({ title: 'Test from CAST', tag: 'cast-test' });
    expect(w.sent[0]!.opts).toMatchObject({ ttl: 60, topic: 'test' });
    expect((await w.notifier.sendTest('d-none')).ok).toBe(false);
  });
});

