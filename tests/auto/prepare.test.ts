// prepareSteps (shared by workflow_save and one-off team_start) and normalizeWorkflow: ids, reserved ids, loopBackTo,
// parallel rules, the 12-step limit, default instructions, connected models.
import { describe, expect, test } from 'bun:test';
import { prepareSteps, prepareWorkflowSave } from '../../server/agents/lead-tools.ts';
import { groupStarts, normalizeWorkflow } from '../../server/agents/workflow-store.ts';
import { DEEPSEEK, fakeModels, GPT, OPUS } from './world';

const st = (name: string, extra: Record<string, unknown> = {}) => ({ name, model: OPUS, persona: `You are ${name}.`, ...extra });
const d = (available: string[] = []) => ({ models: fakeModels(available) });
function ok(r: ReturnType<typeof prepareSteps>) {
  if ('error' in r) throw new Error(r.error);
  return r;
}
function err(r: ReturnType<typeof prepareSteps>) {
  if (!('error' in r)) throw new Error(`expected an error, got ${r.steps.map((s) => s.id).join(',')}`);
  return r.error;
}

describe('prepareSteps', () => {
  test('ids: slugified, unique, Thai names get step-N', () => {
    const r = ok(prepareSteps([st('Code Reviewer'), st('Code Reviewer'), st('นักเขียน')], d()));
    expect(r.steps.map((s) => s.id)).toEqual(['code-reviewer', 'code-reviewer-2', 'step-3']);
  });

  test('reserved ids: assistant, jobs, sub and x-… never become role ids', () => {
    const r = ok(prepareSteps([st('Assistant'), st('Jobs'), st('Sub'), st('X-ray'), st('Other', { id: 'x-other' })], d()));
    expect(r.steps.map((s) => s.id)).toEqual(['assistant-role', 'jobs-role', 'sub-role', 'ray', 'other']);
    expect(r.steps.every((s) => !s.id.startsWith('x-'))).toBe(true);
  });

  test('loopBackTo by given id, final id or name; later step refused; non-review ignored with a note', () => {
    const r = ok(prepareSteps([st('Builder', { id: 'b' }), st('Checker', { kind: 'review', loopBackTo: 'builder' }), st('Final', { kind: 'review', loopBackTo: 'b', maxLoops: 3 })], d()));
    expect(r.steps[1]!.loopBackTo).toBe('b');
    expect(r.steps[2]!.loopBackTo).toBe('b');
    expect(r.steps[2]!.maxLoops).toBe(3);
    expect(r.steps[0]!.instruction).toContain('{{feedback}}');
    expect(err(prepareSteps([st('A', { kind: 'review', loopBackTo: 'B' }), st('B')], d()))).toMatch(/earlier step/);
    expect(err(prepareSteps([st('A'), st('B', { kind: 'review', loopBackTo: 'Nobody' })], d()))).toMatch(/no step of this workflow/);
    const n = ok(prepareSteps([st('A'), st('B', { loopBackTo: 'A' })], d()));
    expect(n.steps[1]!.loopBackTo).toBeUndefined();
    expect(n.notes.join(' ')).toMatch(/only works on review steps/);
  });

  test('parallel: kept after the first step, refused on the first, review cannot loop into its own group', () => {
    const r = ok(prepareSteps([st('Plan'), st('Front'), st('Back', { parallel: true }), st('Check', { kind: 'review', loopBackTo: 'Front' })], d()));
    expect(r.steps.map((s) => !!s.parallel)).toEqual([false, false, true, false]);
    expect(err(prepareSteps([st('A', { parallel: true }), st('B')], d()))).toMatch(/first step/);
    expect(err(prepareSteps([st('A'), st('B'), st('C', { kind: 'review', parallel: true, loopBackTo: 'B' })], d()))).toMatch(/same time/);
    // a review in a group may send the work to a step before the group
    ok(prepareSteps([st('A'), st('B'), st('C', { kind: 'review', parallel: true, loopBackTo: 'A' })], d()));
    expect(groupStarts([{}, {}, { parallel: true }, { parallel: true }, {}, { parallel: true }])).toEqual([0, 1, 1, 1, 4, 4]);
  });

  test('12 steps at most', () => {
    ok(prepareSteps(Array.from({ length: 12 }, (_, i) => st(`P${i}`)), d()));
    expect(err(prepareSteps(Array.from({ length: 13 }, (_, i) => st(`P${i}`)), d()))).toMatch(/at most 12/);
    expect(err(prepareSteps([], d(), 'team'))).toMatch(/at least one person/);
  });

  test('default instructions, verdict footer, placeholder warnings', () => {
    const r = ok(prepareSteps([st('Writer'), st('Editor', { kind: 'review' }), st('Polisher', { instruction: 'Do {{taks}}' })], d()));
    expect(r.steps[0]!.instruction).toMatch(/^Task: \{\{task\}\}/);
    expect(r.steps[1]!.instruction).toMatch(/verdict/);
    expect(r.notes.join('\n')).toMatch(/\{\{taks\}\}/);
  });

  test('models: connected only when something is connected; anything when nothing is (only the scripted test model runs then)', () => {
    expect(err(prepareSteps([st('A', { model: GPT })], d([OPUS])))).toMatch(/Not connected: “A” \[a\] uses openai\/gpt-6.1-sol\. Pick from the connected models: anthropic\/claude-opus-5-5/);
    ok(prepareSteps([st('A', { model: GPT })], d([GPT, OPUS])));
    const none = ok(prepareSteps([st('A', { model: DEEPSEEK })], d()));
    expect(none.notes).toContain('No AI account is connected (CAST_MOCK_LLM test mode: steps run on the scripted model).');
    expect(none.notes.join(' ')).not.toMatch(/\bdemo\b/);
    expect(err(prepareSteps([st('A', { model: 'gpt' })], d()))).toMatch(/model id like/);
  });

  test('nothing connected without the scripted model (production: a lead outlived the last sign-out): no test-mode text', () => {
    const prod = { models: { ...fakeModels([]), demoActive: () => false } };
    const none = ok(prepareSteps([st('A', { model: DEEPSEEK })], prod));
    expect(none.notes.join(' ')).toContain('No AI account is connected now — nobody can work until the user connects one under Models & providers.');
    expect(none.notes.join(' ')).toContain('team_start is refused until then');
    expect(none.notes.join(' ')).not.toMatch(/CAST_MOCK_LLM|scripted/);
  });

  test('workflow_save uses it too (12 steps, x- reserved, parallel kept through normalize)', () => {
    const ctx = { projectId: 'todo', models: fakeModels([]), usedBy: () => [], workflows: { get: () => undefined }, engine: { runs: () => [], get: () => undefined, teamOf: () => null } };
    const r = prepareWorkflowSave({ name: 'Wide', steps: [st('Lead'), st('X-A'), st('B', { parallel: true })] }, ctx as never);
    if ('error' in r) throw new Error(r.error);
    const saved = normalizeWorkflow(r.workflow);
    expect(saved.steps.map((s) => s.id)).toEqual(['lead', 'a', 'b']);
    expect(saved.steps[2]!.parallel).toBe(true);
  });
});

describe('normalizeWorkflow (the Workflow tab and workflows.json)', () => {
  const wf = (steps: unknown[]) => ({ id: 'w', name: 'W', steps });
  const s = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id.toUpperCase(), model: OPUS, persona: '', instruction: '{{task}}', ...extra });
  test('x- ids are renamed (loopBackTo follows), jobs/sub get -role, assistant refused', () => {
    const w = normalizeWorkflow(wf([s('x-ray'), s('sub'), s('check', { kind: 'review', loopBackTo: 'x-ray' })]));
    expect(w.steps.map((x) => x.id)).toEqual(['ray', 'sub-role', 'check']);
    expect(w.steps[2]!.loopBackTo).toBe('ray');
    expect(() => normalizeWorkflow(wf([s('assistant')]))).toThrow(/reserved/);
  });
  test('12 steps max; parallel kept; first parallel and loop into own group refused', () => {
    expect(normalizeWorkflow(wf(Array.from({ length: 12 }, (_, i) => s(`s${i}`)))).steps).toHaveLength(12);
    expect(() => normalizeWorkflow(wf(Array.from({ length: 13 }, (_, i) => s(`s${i}`))))).toThrow(/at most 12/);
    expect(normalizeWorkflow(wf([s('a'), s('b', { parallel: true })])).steps[1]!.parallel).toBe(true);
    expect(() => normalizeWorkflow(wf([s('a', { parallel: true })]))).toThrow(/first step/);
    expect(() => normalizeWorkflow(wf([s('a'), s('b'), s('c', { kind: 'review', parallel: true, loopBackTo: 'b' })]))).toThrow(/same time/);
  });
});

describe('dutyOf (the plan card line)', () => {
  test("skips the “You are the X …” introduction of the old example teams' personas", async () => {
    const { dutyOf } = await import('../../server/agents/lead-tools.ts');
    const { LEGACY_EXAMPLES } = await import('../../server/agents/legacy-examples.ts');
    const duties = LEGACY_EXAMPLES.flatMap((w) => w.steps.map((s) => dutyOf(s)));
    expect(duties.some((d) => /^you are\b/i.test(d))).toBe(false);
    expect(duties.every((d) => d.length > 10 && d.length <= 120)).toBe(true);
    const reviewer = LEGACY_EXAMPLES.find((w) => w.id === 'decode-implement-review')!.steps[2]!;
    expect(dutyOf(reviewer)).toBe('Judge the uncommitted changes against the task and the plan.');
    expect(dutyOf({ persona: 'You are a careful reviewer.', instruction: '', kind: 'review' })).toBe('You are a careful reviewer.');
    expect(dutyOf({ persona: '', instruction: 'Task: {{task}}\nWrite the plan.', kind: 'work' })).toBe('Write the plan.');
    expect(dutyOf({ persona: '', instruction: '', kind: 'review' })).toBe('Checks the work.');
  });
});
