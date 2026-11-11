// REGRESSION (was a repro of a bug that is fixed now): Stop (abort_run / Stop on a person / a failing parallel sibling)
// while a person's omp is still booting. AgentRuntime.abort() counts the Stop (#stops) even without a live process, and
// #send checks that count once omp is up: the step's prompt is never sent to a run that is already stopped or failed.
// Temporary x- people boot at every run's first step (they are new each run), so this is the window right after the
// user presses Run on a plan card.
import { afterAll, expect, test } from 'bun:test';
import { cleanup, makeSys, sleep } from './sys-world';
afterAll(cleanup);

test('Run on the card, then Stop while the first person’s omp boots: the step is never sent', async () => {
  const w = makeSys();
  await w.handle({ t: 'prompt', agentId: w.lead, text: 'fix the failing tests and get them reviewed' });
  const lp = await w.until(() => w.procs.get(w.lead), 2000, 'lead proc');
  lp.hostCall('team_start', { task: 'Fix the failing tests', why: 'build then check' });
  const plan = await w.until(() => w.sys.snapshot().plans[0], 2000, 'card');
  // omp of the first temporary person takes a while to start (2–6 s in the srvint/p3int logs)
  let boot!: () => void;
  const first = w.agentOf('x-decoder');
  w.bootGate.set(first, new Promise<void>((r) => (boot = r)));
  w.member = () => 'hold'; // the step is long work
  const ack = (await w.handle({ t: 'answer_plan', planId: plan.id, run: true, models: { reviewer: 'google/gemini-4-argon' } })) as any;
  expect(ack.ok).toBe(true);
  const runId: string = ack.data.plan.runId;
  await w.until(() => w.sys.pool.isStarting(first), 2000, 'x-decoder booting');

  // the user changes their mind and presses Stop on the run
  await w.handle({ t: 'abort_run', runId });
  expect(w.sys.engine.get(runId)!.status).toBe('aborted');

  boot(); // omp of x-decoder is ready now
  await sleep(100);
  // nobody works on the stopped run
  expect(w.history.filter((p) => p.agentId === first).flatMap((p) => p.prompts)).toEqual([]);
  expect(w.sys.store.get(first)?.status).not.toBe('busy');
  await w.dispose();
});

test("the job's own team (standing people): Stop on the person during the boot — the step is never sent", async () => {
  const w = makeSys();
  await w.handle({ t: 'prompt', agentId: w.lead, text: 'fix the failing tests and get them reviewed' });
  const lp = await w.until(() => w.procs.get(w.lead), 2000, 'lead proc');
  lp.hostCall('team_start', { task: 'Fix the failing tests' });
  const plan = await w.until(() => w.sys.snapshot().plans[0], 2000, 'card');
  let boot!: () => void;
  const first = w.agentOf('decoder');
  w.bootGate.set(first, new Promise<void>((r) => (boot = r)));
  const ack = (await w.handle({ t: 'answer_plan', planId: plan.id, run: true })) as any;
  const runId: string = ack.data.plan.runId;
  await w.until(() => w.sys.pool.isStarting(first), 2000, 'decoder booting');
  await w.handle({ t: 'abort', agentId: first }); // Stop on the person in their chat
  expect(w.sys.engine.get(runId)!.status).toBe('aborted');
  boot();
  await sleep(150);
  expect(w.history.filter((p) => p.agentId === first).flatMap((p) => p.prompts)).toEqual([]);
  await w.dispose();
});

test('a parallel member that fails fast stops a sibling still booting: the sibling never gets the step', async () => {
  const w = makeSys({ workflowId: null });
  await w.handle({ t: 'prompt', agentId: w.lead, text: 'write both parts' });
  const lp = await w.until(() => w.procs.get(w.lead), 2000, 'lead proc');
  // work style auto → no card
  (w.sys as any).o.deps.jobs.update(w.projectId, 'main', { workStyle: 'auto' });
  let boot!: () => void;
  const b = w.agentOf('x-part-b');
  w.bootGate.set(b, new Promise<void>((r) => (boot = r)));
  w.member = (p, id) => {
    if (p.spec.roleId === 'x-part-a') setTimeout(() => p.finish(id, 'error'), 5); // e.g. the provider refuses
    return 'hold';
  };
  lp.hostCall('team_start', {
    task: 'Write two parts',
    steps: [
      { name: 'Part A', model: 'anthropic/claude-opus-5-5', persona: 'You write part A.' },
      { name: 'Part B', model: 'openai/gpt-6.1-sol', persona: 'You write part B.', parallel: true },
    ],
  });
  const run = await w.until(() => w.sys.engine.runs()[0], 2000, 'run');
  await w.until(() => w.sys.engine.get(run.id)!.status === 'failed', 3000, 'run failed');
  boot();
  await sleep(150);
  expect(w.history.filter((p) => p.agentId === b).flatMap((p) => p.prompts)).toEqual([]);
  await w.dispose();
});
