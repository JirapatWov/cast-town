// REGRESSION (was a repro of a bug that is fixed now): the lead's omp dies while its plan card waits (its team_start
// host tool call is gone with it). The pool's onExit withdraws the card (PlanGate.cancelFor 'gone') and drops the dead
// turn's host tool queue (HostToolQueue.drop), so:
//  - the card leaves snapshot.plans and can't be run any more (Run would start a team the lead never hears about);
//  - the lead's next turn (e.g. a Workflow-tab run's update) gets its tool calls answered — nothing waits behind the
//    dead call's card.
import { afterAll, expect, test } from 'bun:test';
import { cleanup, makeSys, sleep } from './sys-world';
afterAll(cleanup);

test('lead omp crashes while the card waits: the card is withdrawn and Run no longer starts a team', async () => {
  const w = makeSys();
  await w.handle({ t: 'prompt', agentId: w.lead, text: 'fix the failing tests and get them reviewed' });
  const lp = await w.until(() => w.procs.get(w.lead), 2000, 'lead proc');
  lp.hostCall('team_start', { task: 'Fix the failing tests' });
  const plan = await w.until(() => w.sys.snapshot().plans[0], 2000, 'card');

  // omp of the lead dies (crash / OOM / killed) — its turn and the host tool call are gone
  w.exit(w.lead, { code: 1, signal: null, stderr: 'segfault', expected: false });
  await sleep(50);
  expect(w.sys.store.get(w.lead)?.activity).toBe('error'); // "Crashed — send a message to restart"

  // the card is gone for every client …
  expect(w.sys.snapshot().plans).toEqual([]);
  // … and answering it is refused: no team starts behind the lead's back
  const ack = (await w.handle({ t: 'answer_plan', planId: plan.id, run: true })) as { ok: boolean; error?: string };
  expect(ack.ok).toBe(false);
  expect(w.sys.engine.runs()).toEqual([]);
  await w.dispose();
});

test("after the crash, the lead's next turn (a Workflow-tab run's update) is answered: nothing queues behind the dead call", async () => {
  const w = makeSys();
  await w.handle({ t: 'prompt', agentId: w.lead, text: 'fix the failing tests and get them reviewed' });
  const lp = await w.until(() => w.procs.get(w.lead), 2000, 'lead proc');
  lp.hostCall('team_start', { task: 'Fix the failing tests' });
  await w.until(() => w.sys.snapshot().plans[0], 2000, 'card');
  w.exit(w.lead, { code: 1, signal: null, stderr: 'segfault', expected: false });

  // the user runs a team from the Workflow tab meanwhile; when it ends RLT prompts the lead (a new omp)
  const tab = (await w.handle({ t: 'run_workflow', projectId: w.projectId, jobId: 'main', workflowId: 'decode-implement-review', task: 'tidy up' })) as { ok: boolean };
  expect(tab.ok).toBe(true);
  const np = await w.until(() => { const p = w.procs.get(w.lead); return p && p !== lp && p.prompts.find((x) => x.message.startsWith('[RLT team update]')) ? p : null; }, 4000, 'new lead turn');
  const call = np.hostCall('team_status', {});
  const result = await w.until(() => np.hostResults.find((r) => r.id === call.id), 2000, 'team_status answered');
  expect(result.isError).toBe(false);
  expect(w.sys.snapshot().plans).toEqual([]);
  await w.dispose();
});
