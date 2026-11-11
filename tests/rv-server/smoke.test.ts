import { afterAll, expect, test } from 'bun:test';
import { cleanup, makeSys } from './sys-world';
afterAll(cleanup);

test('harness: prompt → team_start → card → Run → run ends → lead hears', async () => {
  const w = makeSys();
  await w.handle({ t: 'prompt', agentId: w.lead, text: 'fix it and get it reviewed' });
  const lp = await w.until(() => w.procs.get(w.lead), 2000, 'lead proc');
  await w.until(() => lp.prompts.length === 1, 2000, 'lead prompt');
  const call = lp.hostCall('team_start', { task: 'Fix the bug', why: 'staged' });
  const plan = await w.until(() => w.sys.snapshot().plans[0], 2000, 'card');
  expect(plan.status).toBe('pending');
  expect(w.sys.store.get(w.lead)?.activity).toBe('waiting_approval');
  const ack = (await w.handle({ t: 'answer_plan', planId: plan.id, run: true })) as any;
  expect(ack.ok).toBe(true);
  await w.until(() => lp.hostResults.find((r) => r.id === call.id), 2000, 'tool result');
  expect(lp.hostResults[0]!.text).toMatch(/^Started/);
  const runId = ack.data.plan.runId;
  await w.until(() => { const r = w.sys.engine.get(runId); return r && r.status === 'completed'; }, 4000, 'run end');
  await w.until(() => lp.prompts.some((p) => p.message.startsWith('[RLT team update]')), 2000, 'update');
  await w.dispose();
});
