// S1–S3: changing a running team through the real AgentSystemImpl (the run card's Edit / Add a person / Send a note →
// get_run_plan / edit_run), with fake omp processes: the run keeps going, a note is steered into the working person's
// turn, a standing person keeps the run's version of their step while it runs (#syncProject), a person added for this
// run only leaves after it, and refusals come back as a failed ack.
import { afterAll, expect, test } from 'bun:test';
import type { FakeProc, SysWorld } from './sys-world';
import { cleanup, makeSys } from './sys-world';
afterAll(cleanup);

/** The job's own team (Decode → Implement → Review, standing people) started from the lead; the roles in `hold` keep
 *  their prompts open (the test finishes them). */
async function midRun(w: SysWorld, hold: string[] = ['implementer']): Promise<{ runId: string; held: Map<string, { p: FakeProc; ids: string[] }> }> {
  const answer = w.member;
  const held = new Map<string, { p: FakeProc; ids: string[] }>();
  w.member = (p, id, message) => {
    const role = p.spec.roleId ?? '';
    if (!hold.includes(role)) return answer(p, id, message);
    const h = held.get(role) ?? { p, ids: [] };
    h.ids.push(id);
    held.set(role, h);
    return 'hold';
  };
  await w.handle({ t: 'prompt', agentId: w.lead, text: 'add the done endpoint and get it reviewed' });
  const lp = await w.until(() => w.procs.get(w.lead), 2000, 'lead proc');
  lp.hostCall('team_start', { task: 'Add PATCH /todos/:id/done' });
  const plan = await w.until(() => w.sys.snapshot().plans[0], 2000, 'card');
  const ack = (await w.handle({ t: 'answer_plan', planId: plan.id, run: true })) as any;
  expect(ack.ok).toBe(true);
  const runId: string = ack.data.plan.runId;
  await w.until(() => held.get(hold[0]!), 3000, `${hold[0]} working`);
  return { runId, held };
}

test('S1 get_run_plan, then edit_run: the run keeps going; the note is steered; a standing person keeps the run\'s version until it ends', async () => {
  const w = makeSys();
  const { runId, held } = await midRun(w, ['implementer', 'reviewer']);
  const view = (await w.handle({ t: 'get_run_plan', runId })) as any;
  expect(view.ok).toBe(true);
  expect(view.data).toMatchObject({ runId, workflowId: 'decode-implement-review', own: true, done: 1, frozen: 2, states: { decoder: 'done', implementer: 'working', reviewer: 'next' } });
  const savedModel = w.sys.store.get(w.agentOf('reviewer'))!.model;
  expect(savedModel).not.toBe('google/gemini-4-argon');
  // the implementer's omp: what the note is sent with
  const ip = held.get('implementer')!.p;
  const extras: Record<string, unknown>[] = [];
  const prompt = ip.prompt.bind(ip);
  ip.prompt = (message: string, extra: Record<string, unknown> = {}) => {
    extras.push(extra);
    return prompt(message, extra);
  };
  const ack = (await w.handle({
    t: 'edit_run',
    runId,
    ops: [
      { op: 'update', step: 'reviewer', model: 'google/gemini-4-argon', persona: 'You check the 404 path first.' },
      { op: 'add', person: { name: 'Proofreader', model: 'anthropic/claude-sonnet-5-5', persona: 'You read the docs.' } },
      { op: 'note', step: 'implementer', text: 'Use the existing router.' },
    ],
    seen: { rev: view.data.rev, frozen: view.data.frozen },
  })) as any;
  expect(ack.ok).toBe(true);
  expect(ack.data.changes).toEqual(['Reviewer: model, persona', 'added Proofreader', 'note to Implementer']);
  expect(ack.data.delivered).toEqual([{ stepId: 'implementer', name: 'Implementer', how: 'steered' }]);
  expect(ack.data.saved).toBeUndefined();
  await w.until(() => extras.length, 2000, 'note sent');
  expect(extras[0]!.streamingBehavior).toBe('steer');
  expect(ip.prompts.at(-1)!.message).toContain('Use the existing router.');
  expect(w.sys.engine.get(runId)!.status).toBe('running');
  expect(w.sys.engine.get(runId)!.edits).toHaveLength(1);
  // omp ends the turn: one prompt_result per accepted prompt (the note's, then the step's)
  const [stepPrompt, notePrompt] = held.get('implementer')!.ids;
  ip.finish(notePrompt!, 'completed', '');
  ip.finish(stepPrompt!, 'completed', 'implementer done');
  const rp = await w.until(() => held.get('reviewer')?.p, 3000, 'reviewer working');
  expect(rp.spec.systemPrompt).toContain('You check the 404 path first.');
  // a sync while the reviewer works (a job changed, a workflow saved …): they keep the run's version of their step
  await w.sys.onJobsChanged(w.projectId);
  expect(w.sys.store.get(w.agentOf('reviewer'))!.model).toBe('google/gemini-4-argon');
  rp.finish(held.get('reviewer')!.ids[0]!, 'completed', 'ok\n```json\n{"verdict":"approve","notes":""}\n```');
  const proof = await w.until(() => w.procs.get(w.agentOf('proofreader')), 3000, 'proofreader proc');
  expect(proof.spec.systemPrompt).toContain('You read the docs.');
  const end = await w.until(() => (w.sys.engine.get(runId)!.status === 'completed' ? w.sys.engine.get(runId) : null), 3000, 'run done');
  expect(end.steps.map((s) => s.stepId)).toEqual(['decoder', 'implementer', 'reviewer', 'proofreader']);
  // after the run: the person added for it leaves; the reviewer is their saved self again
  await w.until(() => !w.sys.store.get(w.agentOf('proofreader')), 9000, 'proofreader left');
  expect(w.sys.store.get(w.agentOf('reviewer'))!.model).toBe(savedModel);
  await w.dispose();
}, 20_000);

test('S2 refusals come back as a failed ack, and nothing changes', async () => {
  const w = makeSys();
  const { runId } = await midRun(w);
  const done = (await w.handle({ t: 'edit_run', runId, ops: [{ op: 'update', step: 'decoder', persona: 'x' }], seen: { rev: 0, frozen: 2 } })) as any;
  expect(done.ok).toBe(false);
  expect(done.error).toBe('“Decoder” already finished — its result stays. To redo it, stop the run and use Run again from here.');
  const working = (await w.handle({ t: 'edit_run', runId, ops: [{ op: 'update', step: 'implementer', persona: 'x' }] })) as any;
  expect(working.ok).toBe(false);
  expect(working.error).toBe('“Implementer” is working now — send them a note instead.');
  const bad = (await w.handle({ t: 'edit_run', runId, ops: [] })) as any;
  expect(bad.ok).toBe(false);
  // a step taken out meanwhile (another window, or the lead): plain words, not the lead's list of step ids
  const stale = (await w.handle({ t: 'edit_run', runId, ops: [{ op: 'update', step: 'fact-checker', persona: 'x' }] })) as any;
  expect(stale).toMatchObject({ ok: false, error: 'That step is no longer in this run — the run was changed meanwhile (in another window, or by the lead). Close this and look again.' });
  // a note to someone who finished meanwhile: no "ask the user first" (that hint is the lead's)
  const late = (await w.handle({ t: 'edit_run', runId, ops: [{ op: 'note', step: 'decoder', text: 'hi' }] })) as any;
  expect(late).toMatchObject({ ok: false, error: '“Decoder” already finished their step — a note can\'t reach them now.' });
  const gone = (await w.handle({ t: 'get_run_plan', runId: 'run-nope' })) as any;
  expect(gone).toMatchObject({ ok: false, error: 'No run “run-nope”.' });
  expect(w.sys.engine.get(runId)!.planRev).toBeUndefined();
  await w.dispose();
});

test('S3 save: true on an own workflow changes it for next time too', async () => {
  const w = makeSys({ workflowId: null });
  const sys = w.sys as any;
  const code = sys.o.workflows.get(w.projectId, 'decode-implement-review'); // the house's copy of the old code team
  const saved = (await w.handle({ t: 'save_workflow', projectId: w.projectId, workflow: { id: 'mine', name: 'Mine', description: '', icon: '🧪', steps: code.steps } })) as any;
  expect(saved.ok).toBe(true);
  sys.o.deps.jobs.update(w.projectId, 'main', { workflowId: 'mine' });
  await w.sys.onJobsChanged(w.projectId);
  const { runId } = await midRun(w);
  const ack = (await w.handle({ t: 'edit_run', runId, ops: [{ op: 'update', step: 'reviewer', instruction: 'Review {{previous}} strictly.' }], save: true })) as any;
  expect(ack.ok).toBe(true);
  expect(ack.data.saved).toBe('Mine');
  expect(sys.o.workflows.get(w.projectId, 'mine').steps[2].instruction).toStartWith('Review {{previous}} strictly.');
  expect(w.sys.engine.get(runId)!.edits![0]!.saved).toBe('Mine');
  await w.dispose();
});
