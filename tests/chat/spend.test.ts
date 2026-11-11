// "Spend this session" must never go down when a team run ends (finding #23). The top bar used to add up the
// costUsd of the people still in store.state.agents; a run's members and the helpers leave when they are done, so
// their spend vanished with them ($0.25 at the end of a run, $0.07 a few seconds later). Now the server keeps a
// ledger that only grows (shared/spend.ts, kept by AgentStore) and the client falls back to its own for older
// servers (web/src/ui/spend.ts). Run: bun test tests/chat/spend.test.ts
import { describe, expect, test } from 'bun:test';
import type { AgentInfo, ServerMsg } from '../../shared/protocol';
import { createSpendLedger } from '../../shared/spend';
import { AgentStore } from '../../server/agents/agent-store';
import { applyServerMsg, emptyState } from '../../web/src/net/reducer';
import { sessionSpend, spendBarParts, spendRows } from '../../web/src/ui/spend';

function person(id: string, vendor: AgentInfo['vendor'], costUsd: number, over: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id,
    projectId: 'todo-api',
    jobId: 'main',
    kind: 'role',
    name: id,
    roleId: id,
    model: `${vendor}/x`,
    modelLabel: 'X',
    vendor,
    demo: false,
    status: 'idle',
    activity: 'idle',
    costUsd,
    appearance: { seed: 1, gender: 'f' },
    ...over,
  };
}

const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-9);

describe('spend ledger', () => {
  test('counts growth per vendor and keeps it when the person leaves', () => {
    const l = createSpendLedger(() => 5);
    l.observe('lead', 'anthropic', 0.03);
    l.observe('lead', 'anthropic', 0.07);
    l.observe('x-reviewer', 'openai', 0.05);
    l.observe('helper', 'deepseek', 0.06);
    near(l.totals().total, 0.18);
    l.forget('x-reviewer');
    l.forget('helper');
    near(l.totals().total, 0.18);
    expect(l.totals().since).toBe(5);
    near(l.totals().byVendor.openai!, 0.05);
  });

  test('a lower cost (a person set up again under the same id) never takes spend away, and counts from there', () => {
    const l = createSpendLedger();
    l.observe('p', 'anthropic', 0.2);
    expect(l.observe('p', 'anthropic', 0)).toBe(false);
    near(l.totals().total, 0.2);
    l.observe('p', 'anthropic', 0.05);
    near(l.totals().total, 0.25);
  });

  test('the scripted test model\'s simulated cost is kept apart from real spend, and the top bar shows real spend only', () => {
    const l = createSpendLedger();
    l.observe('real', 'anthropic', 0.1);
    l.observe('scripted', 'openai', 0.4, true);
    near(l.totals().total, 0.1);
    expect(l.totals().byVendor.openai).toBeUndefined();
    near(l.totals().simulated!.byVendor.openai!, 0.4);
    expect(spendRows(l.totals()).map((r) => r.vendor)).toEqual(['anthropic']);
    // there is no "simulated" view any more: a second argument changes nothing
    expect((spendRows as (t: unknown, x: boolean) => unknown)(l.totals(), true)).toEqual(spendRows(l.totals()));
    // a server from before the split: everything was in byVendor, and counts as spend
    expect(spendRows({ since: 0, total: 0.3, byVendor: { deepseek: 0.3 } }).map((r) => r.vendor)).toEqual(['deepseek']);
    expect(createSpendLedger().totals().simulated).toBeUndefined();
  });

  test('the page\'s own ledger (a server without one) files a person on the scripted model as simulated, never as money', () => {
    const s = emptyState();
    const ledger = createSpendLedger();
    applyServerMsg(s, { t: 'agent', agent: person('lead', 'anthropic', 0.07) });
    applyServerMsg(s, { t: 'agent', agent: person('scripted', 'openai', 0.5, { demo: true }) });
    const t = sessionSpend(s, ledger);
    near(t.total, 0.07);
    expect(spendRows(t).map((r) => r.vendor)).toEqual(['anthropic']);
  });

  test('garbage costs count as nothing', () => {
    const l = createSpendLedger();
    for (const c of [Number.NaN, -1, undefined, Infinity]) l.observe('p', 'other', c as number);
    expect(l.totals().total).toBe(0);
  });
});

describe('server: AgentStore keeps the session total when a team run ends', () => {
  function world() {
    const sent: ServerMsg[] = [];
    const store = new AgentStore({ broadcast: (m) => void sent.push(m), clients: () => [] });
    return { store, sent };
  }

  test('a run of three people spends $0.18; when they leave the total stays $0.25 with the lead', async () => {
    const { store, sent } = world();
    store.upsert(person('todo-api:assistant', 'anthropic', 0, { kind: 'resident' }));
    store.patch('todo-api:assistant', { costUsd: 0.07 });
    for (const [id, v, c] of [['todo-api:x-decoder', 'anthropic', 0.08], ['todo-api:x-implementer', 'deepseek', 0.05], ['todo-api:x-reviewer', 'openai', 0.05]] as const) {
      store.upsert(person(id, v, 0));
      store.patch(id, { costUsd: c / 2 });
      store.patch(id, { costUsd: c });
    }
    near(store.spend.totals().total, 0.25);
    // the run ends: its people leave the house
    store.remove('todo-api:x-decoder');
    store.remove('todo-api:x-implementer');
    store.remove('todo-api:x-reviewer');
    near(store.spend.totals().total, 0.25);
    near(store.spend.totals().byVendor.anthropic!, 0.15);
    // the clients hear about it (coalesced)
    await new Promise((r) => setTimeout(r, 500));
    const last = sent.filter((m): m is Extract<ServerMsg, { t: 'spend' }> => m.t === 'spend').at(-1);
    expect(last).toBeDefined();
    near(last!.spend.total, 0.25);
  });

  test('a helper’s spend stays after it is removed; a re-sync of a resident with the same cost adds nothing', () => {
    const { store } = world();
    store.upsert(person('p:sub:1', 'deepseek', 0, { kind: 'subagent' }));
    store.patch('p:sub:1', { costUsd: 0.04 });
    store.remove('p:sub:1');
    store.upsert(person('p:assistant', 'anthropic', 0.1));
    store.upsert(person('p:assistant', 'anthropic', 0.1)); // residents are upserted again on enter_project
    near(store.spend.totals().total, 0.14);
  });
});

describe('client: the top bar total', () => {
  test('from the server ledger when it sends one', () => {
    const s = emptyState();
    applyServerMsg(s, { t: 'spend', spend: { since: 1, total: 0.25, byVendor: { anthropic: 0.15, openai: 0.05, deepseek: 0.05 } } });
    const t = sessionSpend(s, createSpendLedger());
    near(t.total, 0.25);
    expect(spendRows(t).map((r) => r.vendor)).toEqual(['anthropic', 'openai', 'deepseek']);
  });

  test('an older server (no ledger): the page’s own total still never drops when the run’s people leave', () => {
    const s = emptyState();
    const ledger = createSpendLedger();
    applyServerMsg(s, { t: 'agent', agent: person('lead', 'anthropic', 0.07) });
    applyServerMsg(s, { t: 'agent', agent: person('x-reviewer', 'openai', 0.18) });
    near(sessionSpend(s, ledger).total, 0.25);
    applyServerMsg(s, { t: 'agent_removed', agentId: 'x-reviewer' });
    near(sessionSpend(s, ledger).total, 0.25); // was $0.07 before the fix
  });
});

// The bar beside the top bar's total once showed spend in colour while the number said $0.00.
describe('client: the spend bar', () => {
  test('is empty beside $0.00, whatever rows it is given', () => {
    const rows = [{ vendor: 'anthropic' as const, usd: 0.12 }, { vendor: 'openai' as const, usd: 0.03 }];
    expect(spendBarParts(rows, 0)).toEqual([]);
    expect(spendBarParts([], 0)).toEqual([]);
  });
  test('with real spend: one part per vendor, sized by share, a tiny share still visible', () => {
    const parts = spendBarParts([{ vendor: 'anthropic', usd: 1 }, { vendor: 'google', usd: 0.001 }], 1.001);
    expect(parts.map((p) => p.vendor)).toEqual(['anthropic', 'google']);
    near(parts[0]!.flex, 1);
    near(parts[1]!.flex, 1.001 * 0.04);
  });
});
