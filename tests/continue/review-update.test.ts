// Adversarial review R5: the lead's "[RLT team update]" for a run the user STOPPED must not tell the lead to carry
// on by itself — after the first team of a message no plan card is due, so a team_continue would start at once and
// undo the user's Stop. A failed run may still be carried on (the finished steps keep their results).
import { afterAll, expect, test } from 'bun:test';
import { cleanup, makeSys, sleep, type SysWorld } from '../rv-server/sys-world';

afterAll(cleanup);

async function leadRun(w: SysWorld, hold: string) {
  w.member = (p, id) => {
    if (p.spec.roleId === hold) return 'hold';
    const review = p.spec.systemPrompt.includes('[rlt-step-kind:review]');
    setTimeout(() => p.alive && p.open.has(id) && p.finish(id, 'completed', review ? 'ok\n```json\n{"verdict":"approve","notes":""}\n```' : `${p.spec.roleId} done`), 10);
  };
  await w.handle({ t: 'prompt', agentId: w.lead, text: 'fix the failing tests and get them reviewed' });
  const lp = await w.until(() => w.procs.get(w.lead), 2000, 'lead proc');
  lp.hostCall('team_start', { task: 'Fix the failing tests' });
  const plan = await w.until(() => w.sys.snapshot().plans[0], 2000, 'card');
  await w.handle({ t: 'answer_plan', planId: plan.id, run: true });
  const run = await w.until(() => w.sys.engine.runs()[0], 2000, 'run');
  await w.until(() => w.procs.get(w.agentOf(hold))?.open.size, 3000, `${hold} works`);
  return run;
}

/** Every text the lead was sent (prompts and follow-ups), from every omp it had. */
const leadTexts = (w: SysWorld) =>
  w.history.filter((p) => p.agentId === w.lead).flatMap((p) => [...p.prompts.map((x) => x.message), ...((p as unknown as { followUps?: string[] }).followUps ?? [])]);

test('stopped by the user: tell what happened, continue only when the user asks', async () => {
  const w = makeSys();
  const run = await leadRun(w, 'implementer');
  await w.handle({ t: 'abort_run', runId: run.id });
  const update = await w.until(() => leadTexts(w).find((t) => t.startsWith('[RLT team update]')), 4000, 'update');
  expect(update).toContain('was stopped');
  expect(update).toMatch(/unless the user asks/);
  expect(update).not.toMatch(/to go on, continue/);
  expect(update).toContain('team_continue'); // how, once they ask
  await w.dispose();
});

test('failed: the lead may carry on from the step that failed', async () => {
  const w = makeSys();
  const run = await leadRun(w, 'implementer');
  const p = w.procs.get(w.agentOf('implementer'))!;
  for (const id of [...p.open.keys()]) p.finish(id, 'error', '');
  const update = await w.until(() => leadTexts(w).find((t) => t.startsWith('[RLT team update]')), 4000, 'update');
  expect(update).toContain('failed');
  expect(update).toContain('team_continue');
  await sleep(10);
  await w.dispose();
  void run;
});
