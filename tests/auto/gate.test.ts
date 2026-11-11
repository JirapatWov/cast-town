// The plan card: when it shows (only the first team after a user message, never in 'auto', never for Workflow-tab
// runs), what Run / Cancel / a new message / Stop do, and the model choices it leaves on the job.
import { afterAll, describe, expect, test } from 'bun:test';
import type { TeamPlan } from '../../shared/protocol.ts';
import { MAX_MODEL_PREFS } from '../../server/agents/plan-gate.ts';
import { cleanup, DEEPSEEK, GEMINI, GPT, makeWorld, OPUS, runEnd, SONNET, type World } from './world';

afterAll(cleanup);

const planItem = (w: World, id: string) => w.store.transcript(w.lead).find((i) => i.kind === 'plan' && i.id === id) as { plan: TeamPlan } | undefined;
const broadcasts = (w: World, id: string) => w.hub.sent.filter((m) => m.t === 'plan' && m.plan.id === id).map((m) => (m as { plan: TeamPlan }).plan.status);
const runIdOf = (text: string) => text.match(/run (run-[\w]+)/)?.[1] ?? '';

describe('when a card shows', () => {
  test('no user message yet → no card; a user message → card; approve clears it; the next team of the same message starts at once', async () => {
    const w = makeWorld();
    expect(w.gate.due(w.lead, w.projectId, 'main')).toBe(false);
    const r0 = await w.call('team_start', { task: 'before any message', workflow_id: 'novel' });
    expect(r0.text).toMatch(/^Started/);
    expect(w.gate.pending()).toHaveLength(0);
    await runEnd(w, runIdOf(r0.text));

    w.gate.userMessage(w.lead);
    expect(w.gate.due(w.lead, w.projectId, 'main')).toBe(true);
    const p = w.call('team_start', { task: 'Fix the failing tests', why: 'build then check' });
    const plan = await w.until(() => w.gate.pending()[0]);
    // the card: in the lead's chat, broadcast, the lead shows waiting
    expect(plan).toMatchObject({ agentId: w.lead, projectId: w.projectId, jobId: 'main', title: 'Decode → Implement → Review', workflowId: 'decode-implement-review', why: 'build then check', task: 'Fix the failing tests', status: 'pending' });
    expect(plan.steps.map((s) => `${s.id}:${s.kind}:${s.model}`)).toEqual([`decoder:work:${OPUS}`, `implementer:work:${DEEPSEEK}`, `reviewer:review:${GPT}`]);
    expect(plan.steps[2]).toMatchObject({ loopBackTo: 'implementer' });
    expect(plan.steps.every((s) => s.duty.length > 0 && s.duty.length <= 120)).toBe(true);
    expect(planItem(w, plan.id)!.plan.status).toBe('pending');
    expect(broadcasts(w, plan.id)).toEqual(['pending']);
    expect(w.waiting.get(w.lead)).toBe('Waiting for you: plan for “Decode → Implement → Review”');
    expect(w.engine.runs().filter((r) => r.status === 'running')).toHaveLength(0); // nothing starts before Run

    const answered = await w.gate.answer(plan.id, true);
    expect(answered.status).toBe('approved');
    const r1 = await p;
    expect(r1.text).toMatch(/^Started “Decode → Implement → Review”/);
    expect(r1.text).toMatch(/The user approved the plan\. Keep their model choices/);
    expect(answered.runId).toBe(runIdOf(r1.text));
    expect(planItem(w, plan.id)!.plan.status).toBe('approved');
    expect(broadcasts(w, plan.id)).toEqual(['pending', 'approved']);
    expect(w.waiting.get(w.lead)).toBeNull();
    expect(w.gate.due(w.lead, w.projectId, 'main')).toBe(false);
    await runEnd(w, answered.runId!);

    // same message, another team: no card
    const r2 = await w.call('team_start', { task: 'more', workflow_id: 'novel' });
    expect(r2.text).toMatch(/^Started “Idea → Write → Edit”/);
    expect(w.gate.pending()).toHaveLength(0);
    await runEnd(w, runIdOf(r2.text));
    // a new message: a card again
    w.gate.userMessage(w.lead);
    const p3 = w.call('team_start', { task: 'again' });
    const plan3 = await w.until(() => w.gate.pending()[0]);
    await w.gate.answer(plan3.id, true);
    await runEnd(w, runIdOf((await p3).text));
    w.dispose();
  });

  test("work style 'auto': never a card; 'solo' and 'ask': a card", async () => {
    const w = makeWorld();
    w.jobs.update(w.projectId, 'main', { workStyle: 'auto' });
    w.gate.userMessage(w.lead);
    expect(w.gate.due(w.lead, w.projectId, 'main')).toBe(false);
    const r = await w.call('team_start', { task: 'x' });
    expect(r.text).toMatch(/^Started/);
    expect(r.text).not.toMatch(/approved the plan/);
    await runEnd(w, runIdOf(r.text));
    // a team started without a card is the message's first team too (fix-server: due-survives-cardless-start):
    // switching to 'solo'/'ask' mid-message shows no card for its later teams; the next user message does
    w.jobs.update(w.projectId, 'main', { workStyle: 'solo' });
    expect(w.gate.due(w.lead, w.projectId, 'main')).toBe(false);
    w.gate.userMessage(w.lead);
    expect(w.gate.due(w.lead, w.projectId, 'main')).toBe(true);
    w.dispose();
  });

  test('Workflow-tab runs (engine.start by the user) never show a card nor clear "due"', async () => {
    const w = makeWorld();
    w.gate.userMessage(w.lead);
    const run = await w.engine.start(w.projectId, 'main', 'novel', 'from the tab', { startedBy: 'user' });
    expect(run.startedBy).toBe('user');
    expect(w.gate.pending()).toHaveLength(0);
    expect(w.gate.due(w.lead, w.projectId, 'main')).toBe(true);
    expect(w.gate.runsThisAsk(w.lead)).toBe(0); // not the lead's run
    await runEnd(w, run.id);
    w.dispose();
  });

  test('a plan of a one-off team: no workflowId, its own name, x- free step ids, loops and parallel shown', async () => {
    const w = makeWorld();
    w.gate.userMessage(w.lead);
    const p = w.call('team_start', {
      task: 'Write the docs',
      name: 'Docs pair',
      steps: [
        { name: 'Writer A', model: OPUS, persona: 'You write the API docs.' },
        { name: 'Writer B', model: SONNET, persona: 'You write the guide.', parallel: true },
        { name: 'Editor', model: GPT, persona: 'You edit.', kind: 'review', loopBackTo: 'Writer A', maxLoops: 2 },
      ],
    });
    const plan = await w.until(() => w.gate.pending()[0]);
    expect(plan.title).toBe('Docs pair');
    expect(plan.workflowId).toBeUndefined();
    expect(plan.steps.map((s) => s.id)).toEqual(['writer-a', 'writer-b', 'editor']);
    expect(plan.steps[1]!.parallel).toBe(true);
    expect(plan.steps[2]).toMatchObject({ loopBackTo: 'writer-a', maxLoops: 2, duty: 'You edit.' });
    await w.gate.answer(plan.id, false);
    expect((await p).text).toMatch(/^The user cancelled this plan/);
    w.dispose();
  });
});

describe('answers', () => {
  test('Run with a changed model: the run uses it (temporary people), the result names it, modelPrefs recorded', async () => {
    const w = makeWorld();
    w.gate.userMessage(w.lead);
    const p = w.call('team_start', { task: 'Fix it' });
    const plan = await w.until(() => w.gate.pending()[0]);
    // unchanged entries are dropped; a changed one counts
    const answered = await w.gate.answer(plan.id, true, { reviewer: GEMINI, decoder: OPUS });
    expect(answered.changed).toEqual({ reviewer: GEMINI });
    const r = await p;
    expect(r.text).toMatch(/approved the plan and changed: Reviewer → google\/gemini-4-argon\. Keep their model choices/);
    const run = w.engine.get(answered.runId!)!;
    expect(run.team!.map((m) => `${m.id}/${m.model}`)).toEqual([`x-decoder/${OPUS}`, `x-implementer/${DEEPSEEK}`, `x-reviewer/${GEMINI}`]);
    expect(w.workflows.get(w.projectId, 'decode-implement-review')!.steps[2]!.model).toBe(GPT); // the workflow stays
    expect(w.jobs.get(w.projectId, 'main')!.workflowId).toBe('decode-implement-review');
    const prefs = w.jobs.get(w.projectId, 'main')!.modelPrefs!;
    expect(prefs).toHaveLength(1);
    expect(prefs[0]).toMatchObject({ stepName: 'Reviewer', duty: plan.steps[2]!.duty, model: GEMINI });
    // the lead sees them in workflow_list
    await runEnd(w, run.id);
    const list = await w.call('workflow_list', {});
    expect(list.text).toContain(`The user's model choices (follow them for these duties): Reviewer (${plan.steps[2]!.duty}) → ${GEMINI}`);
    w.dispose();
  });

  test('modelPrefs: newest first, one per person+duty, at most 12', async () => {
    const w = makeWorld();
    const round = async (models: Record<string, string>, steps?: unknown[]) => {
      w.gate.userMessage(w.lead);
      const p = w.call('team_start', steps ? { task: 't', steps } : { task: 't', models: {} });
      const plan = await w.until(() => w.gate.pending()[0]);
      const a = await w.gate.answer(plan.id, true, models);
      await p;
      await runEnd(w, a.runId!);
    };
    await round({ reviewer: GEMINI });
    await round({ reviewer: SONNET });
    let prefs = w.jobs.get(w.projectId, 'main')!.modelPrefs!;
    expect(prefs.map((p) => `${p.stepName}:${p.model}`)).toEqual([`Reviewer:${SONNET}`]);
    // 13 distinct people → 12 kept, the newest first
    const steps = Array.from({ length: 12 }, (_, i) => ({ name: `P${i}`, model: OPUS, persona: `You do part ${i}.` }));
    const models = Object.fromEntries(steps.map((_, i) => [`p${i}`, SONNET]));
    await round(models, steps);
    prefs = w.jobs.get(w.projectId, 'main')!.modelPrefs!;
    expect(prefs).toHaveLength(MAX_MODEL_PREFS);
    expect(prefs.some((p) => p.stepName === 'Reviewer')).toBe(false);
    // stored and reloaded clean (a fresh JobStore reads jobs.json)
    const { createJobStore } = await import('../../server/job-store.ts');
    const again = createJobStore(`${w.root}/data`, w.city).get(w.projectId, 'main')!;
    expect(again.modelPrefs).toHaveLength(MAX_MODEL_PREFS);
    w.dispose();
  }, 20_000);

  test('Cancel: nothing starts, "due" stays (the next team shows a card again), no prefs', async () => {
    const w = makeWorld();
    w.gate.userMessage(w.lead);
    const p = w.call('team_start', { task: 'x' });
    const plan = await w.until(() => w.gate.pending()[0]);
    const answered = await w.gate.answer(plan.id, false, { reviewer: GEMINI });
    expect(answered.status).toBe('cancelled');
    const r = await p;
    expect(r.isError).toBeFalsy();
    expect(r.text).toBe("The user cancelled this plan — don't start it. Ask what they want, or do it another way if they said so.");
    expect(w.engine.runs()).toHaveLength(0);
    expect(w.gate.due(w.lead, w.projectId, 'main')).toBe(true);
    expect(w.gate.runsThisAsk(w.lead)).toBe(0);
    expect(w.jobs.get(w.projectId, 'main')!.modelPrefs ?? []).toHaveLength(0);
    expect(planItem(w, plan.id)!.plan.status).toBe('cancelled');
    expect(w.waiting.get(w.lead)).toBeNull();
    // answering again
    await expect(w.gate.answer(plan.id, true)).rejects.toThrow('That plan was already answered.');
    // the lead tries again → a card again
    const p2 = w.call('team_start', { task: 'x' });
    const plan2 = await w.until(() => w.gate.pending()[0]);
    expect(plan2.id).not.toBe(plan.id);
    await w.gate.answer(plan2.id, false);
    await p2;
    w.dispose();
  });

  test('a new message, Stop (host_tool_cancel), or the lead going away withdraw the card', async () => {
    const w = makeWorld();
    const ask = async () => {
      const p = w.call('team_start', { task: 'x' }, {});
      const plan = await w.until(() => w.gate.pending()[0]);
      return { p, plan };
    };
    w.gate.userMessage(w.lead);
    let { p, plan } = await ask();
    w.gate.userMessage(w.lead);
    expect((await p).text).toMatch(/^The user wrote a new message instead of answering the plan/);
    expect(planItem(w, plan.id)!.plan.status).toBe('cancelled');

    // Stop: only the matching tool call
    const c = { tool: 'team_start', args: { task: 'y' }, agentId: w.lead, projectId: w.projectId, jobId: 'main', callId: 'call-42' };
    const { runLeadTool } = await import('../../server/agents/lead-tools.ts');
    const p2 = runLeadTool(c, w.deps());
    plan = await w.until(() => w.gate.pending()[0]);
    w.gate.cancelCall(w.lead, 'call-other');
    expect(w.gate.pending()).toHaveLength(1);
    w.gate.cancelCall(w.lead, 'call-42');
    expect((await p2).text).toMatch(/^The user pressed Stop before answering the plan/);

    ({ p, plan } = await ask());
    w.gate.cancelFor(w.lead, 'stopped');
    expect((await p).text).toMatch(/^The user pressed Stop/);

    ({ p, plan } = await ask());
    w.gate.forget(w.lead);
    expect((await p).text).toMatch(/^The plan was withdrawn before the user answered it/);
    expect(w.gate.due(w.lead, w.projectId, 'main')).toBe(false); // forgotten

    w.gate.userMessage(w.lead);
    ({ p, plan } = await ask());
    w.gate.cancelAll();
    expect((await p).text).toMatch(/^The plan was withdrawn/);
    expect(w.engine.runs()).toHaveLength(0);
    w.dispose();
  });

  test('bad answers keep the card: unknown person, bad id, unconnected model, the start failing', async () => {
    const w = makeWorld({ available: [OPUS, DEEPSEEK, GPT] });
    w.gate.userMessage(w.lead);
    const p = w.call('team_start', { task: 'x' });
    const plan = await w.until(() => w.gate.pending()[0]);
    await expect(w.gate.answer(plan.id, true, { nobody: OPUS })).rejects.toThrow('This plan has no person “nobody”.');
    await expect(w.gate.answer(plan.id, true, { reviewer: 'gpt' })).rejects.toThrow('Pick a model for Reviewer.');
    await expect(w.gate.answer(plan.id, true, { reviewer: GEMINI })).rejects.toThrow(`L(${GEMINI}) isn't connected — sign in under Models & providers, or pick another model for Reviewer.`);
    expect(w.gate.pending()).toHaveLength(1);
    // the start fails (another run took the job meanwhile): the error goes back, the card stays
    const other = await w.engine.start(w.projectId, 'main', 'novel', 'tab', { startedBy: 'user' }).catch(() => null);
    expect(other).toBeNull(); // novel's models aren't all connected here
    w.models.available.push(GEMINI);
    const tab = await w.engine.start(w.projectId, 'main', 'novel', 'tab', { startedBy: 'user' });
    await expect(w.gate.answer(plan.id, true)).rejects.toThrow(/already running|is running/);
    expect(w.gate.pending()[0]!.status).toBe('pending');
    await runEnd(w, tab.id);
    const ok = await w.gate.answer(plan.id, true);
    expect(ok.status).toBe('approved');
    expect((await p).text).toMatch(/^Started/);
    await runEnd(w, ok.runId!);
    w.dispose();
  });

  test('nothing connected (demo): any model may be picked on the card', async () => {
    const w = makeWorld({ available: [] });
    w.gate.userMessage(w.lead);
    const p = w.call('team_start', { task: 'x' });
    const plan = await w.until(() => w.gate.pending()[0]);
    const a = await w.gate.answer(plan.id, true, { decoder: GEMINI });
    expect(a.changed).toEqual({ decoder: GEMINI });
    await p;
    await runEnd(w, a.runId!);
    w.dispose();
  });
});
