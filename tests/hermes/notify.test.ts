// The Hermes notifier: when a card starts waiting for the user, Hermes gets one signed webhook — not one per CAST
// message, not again after a restart, not for a card answered within the debounce, and again (under a new request id,
// since Hermes drops a repeated one) when Hermes could not deliver it. The signature must be the one Hermes' webhook
// route checks for the "generic" scheme, or every notification is refused with 401.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentInfo, ApprovalRequest, ServerMsg } from '../../shared/protocol';
import { DEBOUNCE_MS, Notifier, postWebhook, RETRY_MS, signatureHeaders, ToldStore, type Clock, type Watched } from '../../hermes/notify';
import type { Pending } from '../../hermes/view';

test('signature: hex HMAC-SHA256 of "<unix seconds>.<body>" under the route secret (Hermes generic V2)', () => {
  // known answer, computed with Python's hmac the way Hermes' webhook adapter checks it
  const body = '{"event_type":"cast.approval","text":"hi"}';
  expect(signatureHeaders('route-secret', body, 1_794_500_000_999)).toEqual({
    'X-Webhook-Timestamp': '1794500000',
    'X-Webhook-Signature-V2': '7da2d800de573957018a894827fc316fe06cf45cc6cee3d3ec00e9493c97111c',
  });
});

test('a refused POST says why, with a hint for the usual setup mistakes', async () => {
  const fake = (status: number) => (async () => new Response('nope', { status })) as unknown as typeof fetch;
  const payload = { event_type: 'cast.test', id: 'x', code: '', house: '', job: '', person: '', title: '', text: 'hi' } as const;
  await expect(postWebhook({ url: 'http://h/webhooks/cast', secret: 's' }, payload, 'r', fake(401))).rejects.toThrow(/HTTP 401 \(the signature/);
  await expect(postWebhook({ url: 'http://h/webhooks/cast', secret: 's' }, payload, 'r', fake(404))).rejects.toThrow(/no such route/);
  await expect(postWebhook({ url: 'http://h/webhooks/cast', secret: 's' }, payload, 'r', fake(200))).resolves.toBeUndefined();
});

// ───────────────────────── the watcher ─────────────────────────

class FakeClock implements Clock {
  t = 1_000_000;
  #timers: { at: number; fn: () => void }[] = [];
  now = () => this.t;
  setTimeout = (fn: () => void, ms: number) => {
    const h = { at: this.t + ms, fn };
    this.#timers.push(h);
    return h;
  };
  clearTimeout = (h: unknown) => {
    this.#timers = this.#timers.filter((x) => x !== h);
  };
  async advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      const next = this.#timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.#timers = this.#timers.filter((x) => x !== next);
      this.t = next.at;
      next.fn();
      for (let i = 0; i < 5; i++) await Promise.resolve();
    }
    this.t = end;
  }
}

function town(): Watched & { emit(m: ServerMsg): void; ask(id: string): void; answer(id: string): void } {
  const listeners = new Set<(m: ServerMsg) => void>();
  const agent = { id: 'ag', projectId: 'p', jobId: 'main', kind: 'resident', name: 'Developer' } as AgentInfo;
  const t = {
    url: 'http://127.0.0.1:4860',
    city: { lots: [], projects: [{ id: 'p', name: 'Shop' }] } as unknown as Watched['city'],
    jobs: [{ id: 'main', projectId: 'p', name: 'Main' }] as unknown as Watched['jobs'],
    agents: new Map([[agent.id, agent]]),
    approvals: new Map<string, ApprovalRequest>(),
    plans: new Map(),
    runs: new Map(),
    on: (fn: (m: ServerMsg) => void) => (listeners.add(fn), () => listeners.delete(fn)),
    emit: (m: ServerMsg) => listeners.forEach((fn) => fn(m)),
    ask(id: string) {
      const approval: ApprovalRequest = { id, agentId: 'ag', projectId: 'p', tool: 'bash', title: 'Allow tool: bash', options: ['Approve', 'Deny'], ts: 1 };
      t.approvals.set(id, approval);
      t.emit({ t: 'approval', approval });
    },
    answer(id: string) {
      t.approvals.delete(id);
      t.emit({ t: 'approval_resolved', id });
    },
  };
  return t;
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function toldFile(): string {
  const d = mkdtempSync(join(tmpdir(), 'cast-hermes-told-'));
  dirs.push(d);
  return join(d, 'notified.json');
}

function setup(file = toldFile(), fails = 0) {
  const clock = new FakeClock();
  const t = town();
  const sent: { id: string; attempt: number }[] = [];
  let failing = fails;
  const n = new Notifier({
    town: t,
    told: new ToldStore(file),
    clock,
    log: () => {},
    deliver: async (p: Pending, attempt: number) => {
      if (failing > 0) {
        failing--;
        throw new Error('Hermes answered HTTP 502');
      }
      sent.push({ id: p.id, attempt });
    },
  });
  n.start();
  return { clock, t, sent, n };
}

describe('Notifier', () => {
  test('a waiting card is told once, after the debounce', async () => {
    const { clock, t, sent } = setup();
    t.ask('r1');
    await clock.advance(DEBOUNCE_MS - 1);
    expect(sent).toEqual([]);
    await clock.advance(1);
    expect(sent).toEqual([{ id: 'r1', attempt: 0 }]);
    t.emit({ t: 'approval', approval: t.approvals.get('r1')! }); // CAST sends the card again (another client joined…)
    await clock.advance(DEBOUNCE_MS * 3);
    expect(sent).toHaveLength(1);
  });

  test('a card answered within the debounce is never told', async () => {
    const { clock, t, sent } = setup();
    t.ask('r1');
    await clock.advance(500);
    t.answer('r1');
    await clock.advance(DEBOUNCE_MS * 3);
    expect(sent).toEqual([]);
  });

  test('a failed delivery is tried again later under the next attempt number; an answered one is dropped', async () => {
    const { clock, t, sent } = setup(toldFile(), 1);
    t.ask('r1');
    await clock.advance(DEBOUNCE_MS);
    expect(sent).toEqual([]);
    await clock.advance(RETRY_MS[0]!);
    expect(sent).toEqual([{ id: 'r1', attempt: 1 }]);

    const second = setup(toldFile(), 1);
    second.t.ask('r2');
    await second.clock.advance(DEBOUNCE_MS);
    second.t.answer('r2');
    await second.clock.advance(RETRY_MS[0]! * 2);
    expect(second.sent).toEqual([]);
  });

  test('after a restart, what was told stays told and what waits untold is told', async () => {
    const file = toldFile();
    const first = setup(file);
    first.t.ask('r1');
    await first.clock.advance(DEBOUNCE_MS);
    first.n.stop();

    const again = setup(file);
    again.t.approvals.set('r1', first.t.approvals.get('r1')!);
    again.t.approvals.set('r2', { ...first.t.approvals.get('r1')!, id: 'r2' });
    again.t.emit({ t: 'snapshot' } as ServerMsg);
    await again.clock.advance(DEBOUNCE_MS);
    expect(again.sent).toEqual([{ id: 'r2', attempt: 0 }]);
  });
});
