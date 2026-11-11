// The plan card's effort: what the card shows, what Run with other efforts starts, what the lead hears, what the job
// keeps for later teams, and the checks — for team_start and team_continue.
import { afterAll, describe, expect, test } from 'bun:test';
import { parseClientMsg } from '../../server/validate.ts';
import { cleanup, GEMINI, makeWorld, OPUS, runEnd, type World } from './world';

afterAll(cleanup);

const runIdOf = (text: string) => text.match(/run (run-[\w]+)/)?.[1] ?? '';

describe('plan card effort (team_start)', () => {
  test('the card carries each step’s effort; Run with other efforts starts them; the lead hears it; the job keeps it', async () => {
    const w = makeWorld();
    w.gate.userMessage(w.lead);
    const p = w.call('team_start', { task: 'Fix it' });
    const plan = await w.until(() => w.gate.pending()[0]);
    expect(plan.steps.map((s) => `${s.id}:${s.thinking ?? '-'}`)).toEqual(['decoder:high', 'implementer:medium', 'reviewer:high']);
    // unchanged entries drop out: decoder high = planned
    const answered = await w.gate.answer(plan.id, true, {}, { reviewer: 'max', decoder: 'high', implementer: '' });
    expect(answered.changed).toEqual({});
    expect(answered.changedThinking).toEqual({ reviewer: 'max', implementer: '' });
    const r = await p;
    expect(r.text).toContain('approved the plan and changed: ');
    expect(r.text).toContain('Reviewer → effort max');
    expect(r.text).toContain('Implementer → effort default');
    const run = w.engine.get(answered.runId!)!;
    expect(run.team!.map((m) => m.id)).toEqual(['x-decoder', 'x-implementer', 'x-reviewer']); // temporary people: other efforts
    const started = (id: string) => w.ensuredSteps.findLast((s) => s.id === id)!;
    expect(started('x-reviewer').thinking).toBe('max');
    expect(started('x-implementer').thinking).toBeUndefined(); // default: no --thinking
    expect(started('x-decoder').thinking).toBe('high');
    expect(w.workflows.get(w.projectId, 'decode-implement-review')!.steps[2]!.thinking).toBe('high'); // the workflow stays
    // the job keeps the effort (no model: the user only changed the effort); the default isn't a pick
    const prefs = w.jobs.get(w.projectId, 'main')!.modelPrefs!;
    expect(prefs).toHaveLength(1);
    expect(prefs[0]).toMatchObject({ stepName: 'Reviewer', thinking: 'max' });
    expect(prefs[0]!.model).toBeUndefined();
    await runEnd(w, run.id);
    // workflow_list shows it to the lead
    expect((await w.call('workflow_list', {})).text).toContain('Reviewer (');
    expect((await w.call('workflow_list', {})).text).toMatch(/Reviewer \([^)]*\) → effort max/);

    // the next card: the saved team's Reviewer is planned at max (the job's pick), with a note
    w.gate.userMessage(w.lead);
    const p2 = w.call('team_start', { task: 'Again' });
    const plan2 = await w.until(() => w.gate.pending()[0]);
    expect(plan2.steps.find((s) => s.id === 'reviewer')!.thinking).toBe('max');
    // a model change for the same duty keeps the effort pick
    const a2 = await w.gate.answer(plan2.id, true, { reviewer: GEMINI });
    const r2 = await p2;
    expect(r2.text).toContain('thinks at max, the effort the user picked for this duty');
    expect(w.jobs.get(w.projectId, 'main')!.modelPrefs![0]).toMatchObject({ stepName: 'Reviewer', model: GEMINI, thinking: 'max' });
    expect(started('x-reviewer').thinking).toBe('max');
    await runEnd(w, a2.runId!);

    // effort back to the default drops the effort pick but keeps the model
    w.gate.userMessage(w.lead);
    const p3 = w.call('team_start', { task: 'Third' });
    const plan3 = await w.until(() => w.gate.pending()[0]);
    const a3 = await w.gate.answer(plan3.id, true, {}, { reviewer: '' });
    expect(a3.changedThinking).toEqual({ reviewer: '' });
    await p3;
    expect(started('x-reviewer').thinking).toBeUndefined();
    const kept = w.jobs.get(w.projectId, 'main')!.modelPrefs![0]!;
    expect(kept).toMatchObject({ stepName: 'Reviewer', model: GEMINI });
    expect(kept.thinking).toBeUndefined();
    await runEnd(w, a3.runId!);
    w.dispose();
  });

  test('a pick that is only “default” and nothing else leaves no pref; no change → the standing team runs', async () => {
    const w = makeWorld();
    w.gate.userMessage(w.lead);
    const p = w.call('team_start', { task: 'x' });
    const plan = await w.until(() => w.gate.pending()[0]);
    const a = await w.gate.answer(plan.id, true, {}, { decoder: 'high' }); // = planned
    expect(a.changedThinking).toBeUndefined();
    const r = await p;
    expect(r.text).toMatch(/approved the plan\. Keep/);
    expect(w.engine.get(a.runId!)!.team!.map((m) => m.id)).toEqual(['decoder', 'implementer', 'reviewer']); // own people
    expect(w.jobs.get(w.projectId, 'main')!.modelPrefs).toBeUndefined();
    await runEnd(w, a.runId!);
    // one-off team: a step with an effort set back to default → no pref is made, run without thinking
    w.gate.userMessage(w.lead);
    const p2 = w.call('team_start', { task: 'y', steps: [{ name: 'Fixer', model: OPUS, persona: 'You fix.', thinking: 'low' }] });
    const plan2 = await w.until(() => w.gate.pending()[0]);
    expect(plan2.steps[0]!.thinking).toBe('low');
    const a2 = await w.gate.answer(plan2.id, true, {}, { fixer: '' });
    await p2;
    expect(w.ensuredSteps.findLast((s) => s.id === 'x-fixer')!.thinking).toBeUndefined();
    expect(w.jobs.get(w.projectId, 'main')!.modelPrefs).toBeUndefined();
    await runEnd(w, a2.runId!);
    w.dispose();
  });

  test('checks: unknown person, unknown level — the card stays', async () => {
    const w = makeWorld();
    w.gate.userMessage(w.lead);
    const p = w.call('team_start', { task: 'x' });
    const plan = await w.until(() => w.gate.pending()[0]);
    await expect(w.gate.answer(plan.id, true, {}, { qa: 'high' })).rejects.toThrow('This plan has no person “qa”.');
    await expect(w.gate.answer(plan.id, true, {}, { reviewer: 'ultra' })).rejects.toThrow('Pick an effort for Reviewer.');
    expect(w.gate.pending()).toHaveLength(1);
    const a = await w.gate.answer(plan.id, true, {}, { reviewer: 'low' });
    await p;
    await runEnd(w, a.runId!);
    w.dispose();
  });
});

describe('plan card effort (team_continue)', () => {
  test('Run with another effort for a step that works again; a kept step can’t change', async () => {
    const w = makeWorld();
    const first = await w.call('team_start', { task: 'Add PATCH' }); // no message yet → no card
    const a = runIdOf(first.text);
    await runEnd(w, a);
    w.gate.userMessage(w.lead);
    const p = w.call('team_continue', { from_step: 'reviewer', run_id: a });
    const plan = await w.until(() => w.gate.pending()[0]);
    expect(plan.steps.map((s) => `${s.id}:${s.thinking}`)).toEqual(['reviewer:high']);
    const ans = await w.gate.answer(plan.id, true, {}, { reviewer: 'minimal' });
    expect(ans.changedThinking).toEqual({ reviewer: 'minimal' });
    const r = await p;
    expect(r.text).toContain('Reviewer → effort minimal');
    expect(w.ensuredSteps.findLast((s) => s.id === 'x-reviewer')!.thinking).toBe('minimal');
    await runEnd(w, ans.runId!);
    // the engine refuses an effort for a kept step, and a bad level
    expect(() => w.engine.planContinue(a, 'reviewer', { thinking: { decoder: 'low' } })).toThrow(/doesn't run again in this continuation/);
    expect(() => w.engine.planContinue(a, 'reviewer', { thinking: { reviewer: 'ultra' as never } })).toThrow(/thinking\.reviewer must be one of/);
    // same as it ran → no change (the standing people do it)
    const same = w.engine.planContinue(a, 'reviewer', { thinking: { reviewer: 'high' } });
    expect(same.own).toBe(true);
    w.dispose();
  });
});

describe('answer_plan wire shape', () => {
  test('thinking map: levels and "" pass; anything else is refused', () => {
    const ok = parseClientMsg(JSON.stringify({ t: 'answer_plan', reqId: 'r', planId: 'plan-1', run: true, thinking: { reviewer: 'max', decoder: '' } }));
    expect(ok.ok).toBe(true);
    if (ok.ok && ok.msg.t === 'answer_plan') expect(ok.msg.thinking).toEqual({ reviewer: 'max', decoder: '' });
    expect(parseClientMsg(JSON.stringify({ t: 'answer_plan', reqId: 'r', planId: 'plan-1', run: true, thinking: { reviewer: 'ultra' } })).ok).toBe(false);
    expect(parseClientMsg(JSON.stringify({ t: 'answer_plan', reqId: 'r', planId: 'plan-1', run: true, thinking: ['max'] })).ok).toBe(false);
    expect(parseClientMsg(JSON.stringify({ t: 'answer_plan', reqId: 'r', planId: 'plan-1', run: true })).ok).toBe(true);
  });
});
