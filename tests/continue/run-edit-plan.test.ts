// P1–P9: the pure part of changing a running team (server/agents/run-edit.ts) — parsing team_edit's ops and planning
// them on a run's plan: step references, every field, new people's ids and places, the group working now and the
// steps before it never moving or silently changing, loop targets, the 12-step cap.
import { describe, expect, test } from 'bun:test';
import { addParagraph, frozenRefusal, frozenUserText, parseRunEditOps, planRunEdit, type PlannedEdit } from '../../server/agents/run-edit.ts';
import { VERDICT_FOOTER } from '../../server/agents/templates.ts';
import type { RunEditOp, RunPlanView, WorkflowStep } from '../../shared/protocol.ts';

const OPUS = 'anthropic/claude-opus-5-5';
const GPT = 'openai/gpt-6.1-sol';
const step = (id: string, over: Partial<WorkflowStep> = {}): WorkflowStep => ({ id, name: id[0]!.toUpperCase() + id.slice(1), model: OPUS, kind: 'work', persona: `You are ${id}.`, instruction: `Task: {{task}}\n{{prev}}`, ...over });
const models = (available: string[] = []) => ({
  anyAvailable: () => available.length > 0,
  demoActive: () => available.length === 0,
  isAvailable: (m: string) => available.includes(m),
  models: () => [OPUS, GPT].map((id) => ({ id, available: available.includes(id) })),
});
const ctx = (available: string[] = [], taken: string[] = []) => ({ models: models(available), defaultInstruction: (name: string) => `DEFAULT for ${name}{{feedback}}`, taken });

/** idea (done) → writer (working) → editor (review, back to writer) — the novel team mid-run. */
function view(over: Partial<RunPlanView> = {}): RunPlanView {
  const steps = [
    step('idea'),
    step('writer', { instruction: 'Write it.\n{{prev}}{{feedback}}' }),
    step('editor', { kind: 'review', loopBackTo: 'writer', maxLoops: 2, instruction: `Edit it.\n\n${VERDICT_FOOTER}` }),
  ];
  return { runId: 'run-1', rev: 0, workflowId: 'mine', workflowName: 'Novel', own: true, steps, done: 1, frozen: 2, states: { idea: 'done', writer: 'working', editor: 'next' }, taken: ['idea', 'writer', 'editor'], ...over };
}
function plan(ops: RunEditOp[], v = view(), c = ctx()): PlannedEdit {
  const r = planRunEdit(v, ops, c);
  if ('error' in r) throw new Error(r.error);
  return r;
}
function refused(ops: RunEditOp[], v = view(), c = ctx()): string {
  const r = planRunEdit(v, ops, c);
  if (!('error' in r)) throw new Error(`planned: ${JSON.stringify(r.changes)}`);
  return r.error;
}
const ids = (p: PlannedEdit) => p.steps.map((s) => s.id);

describe('P1 parse', () => {
  test('unknown op, missing step, bad thinking, add without a name, shape', () => {
    expect(parseRunEditOps([])).toEqual({ error: expect.stringContaining('Pass ops') });
    expect(parseRunEditOps([{ op: 'zap', step: 'a' }])).toEqual({ error: 'ops[0].op must be one of update, add, remove, move, note.' });
    expect(parseRunEditOps([{ op: 'update', instruction: 'x' }])).toEqual({ error: expect.stringContaining('ops[0]: update needs step') });
    expect(parseRunEditOps([{ op: 'update', step: 'a', thinking: 'huge' }])).toEqual({ error: expect.stringContaining('ops[0].thinking must be one of off,') });
    expect(parseRunEditOps([{ op: 'add', person: { model: OPUS } }])).toEqual({ error: expect.stringContaining('add needs person') });
    expect(parseRunEditOps([{ op: 'update', step: 'a' }])).toEqual({ error: expect.stringContaining('update needs something to change') });
    expect(parseRunEditOps([{ op: 'note', step: 'a' }])).toEqual({ error: expect.stringContaining('note needs text') });
    expect(parseRunEditOps([{ op: 'move', step: 'a' }])).toEqual({ error: expect.stringContaining('move needs after') });
    expect(parseRunEditOps([{ op: 'update', step: 'a', maxLoops: 9 }])).toEqual({ error: 'ops[0].maxLoops must be a whole number 0–5.' });
    expect(parseRunEditOps([{ op: 'update', step: 3, name: 'x' }])).toEqual({ error: 'ops[0].step must be a string.' });
    expect(parseRunEditOps(Array.from({ length: 21 }, () => ({ op: 'remove', step: 'a' })))).toEqual({ error: 'At most 20 changes at once.' });
    expect(parseRunEditOps([{ op: 'update', step: 'editor', thinking: '' }, { op: 'note', step: 'writer', text: 'hi' }])).toEqual([{ op: 'update', step: 'editor', thinking: '' }, { op: 'note', step: 'writer', text: 'hi' }]);
  });
});

describe('P2 references and updates', () => {
  test('a step by id, x- id or name (any case); unknown names the steps and their states', () => {
    for (const ref of ['editor', 'x-editor', 'EDITOR', ' Editor ']) expect(plan([{ op: 'update', step: ref, persona: 'Sharp.' }]).steps[2]!.persona).toBe('Sharp.');
    expect(refused([{ op: 'update', step: 'zz', persona: 'x' }])).toBe('No step “zz” in this run — its steps: idea (done), writer (working), editor (not started).');
  });

  test('every field of a step that has not started; the short and long words', () => {
    const p = plan([{ op: 'update', step: 'editor', name: 'Polisher', model: GPT, thinking: 'high', persona: 'P', instruction: 'Polish it.', maxLoops: 3 }]);
    const e = p.steps[2]!;
    expect(e).toMatchObject({ id: 'editor', name: 'Polisher', model: GPT, thinking: 'high', persona: 'P', maxLoops: 3, loopBackTo: 'writer' });
    expect(e.instruction).toBe(`Polish it.\n\n${VERDICT_FOOTER}`); // a review keeps its verdict format
    expect(p.changes).toEqual(['Polisher: name, model, effort, persona, instruction, rounds']);
    expect(p.lines[0]).toBe(`- Polisher: renamed from Editor, model → ${GPT}, effort → high, persona changed, instruction changed, up to 3 rounds.`);
    expect(p.frozen).toBeUndefined();
    // '' = default effort
    const d = plan([{ op: 'update', step: 'editor', thinking: '' }], view({ steps: view().steps.map((s) => (s.id === 'editor' ? { ...s, thinking: 'max' } : s)) }));
    expect(d.steps[2]!.thinking).toBeUndefined();
    // no change at all
    expect(plan([{ op: 'update', step: 'editor', persona: 'You are editor.' }]).lines).toEqual(['- Editor: already like that (no change).']);
  });

  test('add_to_instruction lands before a review\'s verdict format, at the end of a work step', () => {
    const p = plan([{ op: 'update', step: 'editor', add_to_instruction: 'Use short sentences.' }]);
    expect(p.steps[2]!.instruction).toBe(`Edit it.\n\nUse short sentences.\n\n${VERDICT_FOOTER}`);
    expect(p.steps[2]!.instruction.endsWith(VERDICT_FOOTER)).toBe(true);
    expect(addParagraph('Do it.\n', 'More.')).toBe('Do it.\n\nMore.');
  });

  test('kind work → review adds the verdict format; review → work removes it and the loop', () => {
    const r = plan([{ op: 'update', step: 'editor', kind: 'work' }]).steps[2]!;
    expect(r).toMatchObject({ kind: 'work', instruction: 'Edit it.' });
    expect(r.loopBackTo).toBeUndefined();
    const v = view({ steps: [...view().steps, step('proof')], states: { ...view().states, proof: 'next' } });
    const w = plan([{ op: 'update', step: 'proof', kind: 'review', loopBackTo: 'editor' }], v).steps[3]!;
    expect(w.instruction.endsWith(VERDICT_FOOTER)).toBe(true);
    expect(w).toMatchObject({ kind: 'review', loopBackTo: 'editor', maxLoops: 2 });
  });

  test('a model that is not connected (while others are) is refused; any model when nothing is', () => {
    expect(refused([{ op: 'update', step: 'editor', model: GPT }], view(), ctx([OPUS]))).toBe(`“Editor” can't use ${GPT} — it isn't connected. Connected models: ${OPUS}.`);
    expect(refused([{ op: 'update', step: 'editor', model: 'gpt' }])).toContain('needs a model id like');
    expect(plan([{ op: 'update', step: 'editor', model: GPT }]).steps[2]!.model).toBe(GPT);
  });

  test('too long is refused, never cut (a review would lose its verdict format)', () => {
    expect(refused([{ op: 'update', step: 'editor', add_to_instruction: 'x'.repeat(8000) }])).toContain('would be too long (at most 8000 characters)');
    expect(refused([{ op: 'update', step: 'editor', persona: 'x'.repeat(4001) }])).toContain('persona is too long');
  });
});

describe('P3 add', () => {
  test('after a member of the working group = next, after the whole group; no after = the end', () => {
    const v = view({
      steps: [step('idea'), step('w1'), step('w2', { parallel: true }), step('editor')],
      done: 1,
      frozen: 3,
      states: { idea: 'done', w1: 'finished', w2: 'working', editor: 'next' },
      taken: ['idea', 'w1', 'w2', 'editor'],
    });
    const p = plan([{ op: 'add', after: 'w1', person: { name: 'Checker', model: OPUS, persona: 'c' } }, { op: 'add', person: { name: 'Proofreader', model: OPUS } }], v);
    expect(ids(p)).toEqual(['idea', 'w1', 'w2', 'checker', 'editor', 'proofreader']);
    expect(p.steps[3]!.instruction).toBe('DEFAULT for Checker{{feedback}}');
    expect(p.changes).toEqual(['added Checker', 'added Proofreader']);
    expect(p.lines[1]).toBe(`- Added Proofreader [proofreader] after Editor (${OPUS}).`);
    expect(p.added).toEqual(['checker', 'proofreader']);
  });

  test("unique ids against the plan, this run's attempts and the job: never assistant", () => {
    const p = plan(
      [
        { op: 'add', person: { name: 'Writer', model: OPUS } },
        { op: 'add', person: { name: 'Assistant', model: OPUS } },
        { op: 'add', person: { name: 'นักตรวจ', model: OPUS } },
        { op: 'add', person: { id: 'jobs', name: 'Jobs', model: OPUS } },
        { op: 'add', person: { name: 'Old', model: OPUS } },
      ],
      view({ taken: ['idea', 'writer', 'editor', 'old'] }),
      ctx([], ['assistant-role']),
    );
    expect(ids(p).slice(3)).toEqual(['writer-2', 'assistant-role-2', 'step-6', 'jobs-role', 'old-2']);
  });

  test('not before the working group; not joining it; at most 12', () => {
    expect(refused([{ op: 'add', after: 'idea', person: { name: 'X', model: OPUS } }])).toBe('“Idea” already finished — a new person can only come after the group working now (Writer): add them with after: "writer" or a later step.');
    expect(refused([{ op: 'add', after: 'writer', person: { name: 'X', model: OPUS, parallel: true } }])).toContain("can't join the group working now (Writer)");
    expect(refused([{ op: 'add', person: { name: 'X' } }])).toContain('needs a model');
    const many = Array.from({ length: 9 }, (_, k) => ({ op: 'add' as const, person: { name: `P${k}`, model: OPUS } }));
    expect(plan(many).steps).toHaveLength(12);
    expect(refused([...many, { op: 'add', person: { name: 'P13', model: OPUS } }])).toBe('A team can have at most 12 steps.');
  });

  test('a review added that loops back: a pending target gets {{feedback}}, a frozen one never changes (a warning)', () => {
    const p = plan([
      { op: 'add', person: { name: 'Proof', model: OPUS, kind: 'review', loopBackTo: 'editor' } },
      { op: 'update', step: 'editor', kind: 'work' },
    ]);
    expect(p.steps[2]!.instruction).toBe('Edit it.{{feedback}}');
    const q = plan([{ op: 'add', person: { name: 'Proof', model: OPUS, kind: 'review', loopBackTo: 'idea', instruction: 'Check.' } }]);
    expect(q.steps[0]).toEqual(view().steps[0]!);
    expect(q.frozen).toBeUndefined();
    expect(q.warnings).toEqual(["Idea's instruction has no {{feedback}}, so Proof's notes reach them only in {{prev}}."]);
    expect(q.steps[3]!.instruction).toBe(`Check.\n\n${VERDICT_FOOTER}`);
  });
});

describe('P4 remove and move', () => {
  test('only steps that have not started; a review left pointing at a removed step is refused', () => {
    expect(refused([{ op: 'remove', step: 'writer' }])).toBe('“Writer” works now — only steps that haven\'t started can be removed.');
    expect(refused([{ op: 'remove', step: 'idea' }])).toBe('“Idea” already finished — only steps that haven\'t started can be removed.');
    const v = view({ steps: [...view().steps, step('proof', { kind: 'review', loopBackTo: 'editor', instruction: `P\n${VERDICT_FOOTER}` })], states: { ...view().states, proof: 'next' } });
    expect(refused([{ op: 'remove', step: 'editor' }], v)).toBe('“Proof” sends the work back to “Editor”, which is no longer in the team — change that first ({"op":"update","step":"proof","loopBackTo":"…"}; "" = none) or remove “Proof” too.');
    expect(ids(plan([{ op: 'remove', step: 'proof' }, { op: 'remove', step: 'editor' }], v))).toEqual(['idea', 'writer']);
  });

  test('move: after the working group or later; a review moved before its target is refused', () => {
    const v = view({ steps: [...view().steps, step('proof')], states: { ...view().states, proof: 'next' } });
    expect(ids(plan([{ op: 'move', step: 'proof', after: 'writer' }], v))).toEqual(['idea', 'writer', 'proof', 'editor']);
    expect(refused([{ op: 'move', step: 'proof', after: 'idea' }], v)).toContain('can only move after the group working now (Writer)');
    const w = view({ steps: [...view().steps, step('proof', { kind: 'review', loopBackTo: 'editor', instruction: `P ${VERDICT_FOOTER}` })], states: { ...view().states, proof: 'next' } });
    expect(refused([{ op: 'move', step: 'proof', after: 'writer' }], w)).toBe('“Proof” can only loop back to an earlier step, and “Editor” comes later.');
  });

  test("removing a group's first person: the next one leads it (never joining the group working now)", () => {
    const v = view({ steps: [...view().steps, step('p1'), step('p2', { parallel: true })], states: { ...view().states, p1: 'next', p2: 'next' } });
    const v2 = { ...v, steps: [v.steps[0]!, v.steps[1]!, v.steps[3]!, v.steps[4]!, v.steps[2]!] };
    expect(plan([{ op: 'remove', step: 'p1' }], v2).steps[2]).toMatchObject({ id: 'p2' });
    expect(plan([{ op: 'remove', step: 'p1' }], v2).steps[2]!.parallel).toBeUndefined();
  });

  test('parallel: true on the first step that has not started is refused', () => {
    expect(refused([{ op: 'update', step: 'editor', parallel: true }])).toBe("“Editor” can't join the group working now (Writer) — it starts after them.");
  });
});

describe('P5 the steps that finished or work now', () => {
  test('a change to their definition is reported (frozen, with where a redo starts); the plan never moves them', () => {
    const done = plan([{ op: 'update', step: 'idea', instruction: 'Other ideas' }]);
    expect(done.frozen).toMatchObject({ index: 0, id: 'idea', name: 'Idea', state: 'done', from: { index: 0, id: 'idea' } });
    const working = plan([{ op: 'update', step: 'writer', model: GPT }, { op: 'update', step: 'editor', persona: 'x' }]);
    expect(working.frozen).toMatchObject({ id: 'writer', state: 'working', from: { id: 'writer' } });
    // the texts
    expect(frozenRefusal(view(), done.frozen!)).toBe(
      '“Idea” already finished in this run — changing it means redoing it and the steps after it that used its result (Writer is working on it now). Ask the user first. ' +
        'If they want it redone: team_edit again with the same ops and redo: true — the run stops and continues from Idea; nothing before it is lost. Changes to later steps alone never need that.',
    );
    expect(frozenRefusal(view(), working.frozen!)).toBe(
      '“Writer” is working now and team_edit doesn\'t restart them. To tell them something now: {"op":"note","step":"writer","text":"…"} — they read it at their next step. ' +
        'If their work must start over with the change, ask the user first, then team_edit with redo: true (continues from Writer; Idea keeps its result).',
    );
    expect(frozenUserText(view(), working.frozen!, { frozen: 1 })).toBe('“Writer” started meanwhile — it works with the version it had; send them a note instead.');
    expect(frozenUserText(view(), working.frozen!, { frozen: 2 })).toBe('“Writer” is working now — send them a note instead.');
  });

  test('notes: to the person working now; into the prompt of a step not started; refused for one who finished', () => {
    const p = plan([{ op: 'note', step: 'writer', text: 'Keep it short' }, { op: 'note', step: 'editor', text: 'Be gentle' }]);
    expect(p.notes).toEqual([{ stepId: 'writer', text: 'Keep it short' }]);
    expect(p.steps[2]!.instruction).toBe(`Edit it.\n\nNote from the user for this step:\nBe gentle\n\n${VERDICT_FOOTER}`);
    expect(p.lines).toEqual(['- Note sent to Writer (they read it at their next step).', "- Editor hasn't started yet: the note is in their prompt."]);
    expect(p.frozen).toBeUndefined();
    expect(refused([{ op: 'note', step: 'idea', text: 'x' }])).toContain('“Idea” already finished their step in this run');
    const starting = plan([{ op: 'note', step: 'writer', text: 'Hi' }], view({ states: { idea: 'done', writer: 'starting', editor: 'next' } }));
    expect(starting.lines).toEqual(["- Note for Writer: they get it with their step's prompt."]);
  });

  test('every field of a frozen step counts (the compare key)', () => {
    const fields: RunEditOp[] = [
      { op: 'update', step: 'writer', name: 'W2' },
      { op: 'update', step: 'writer', model: GPT },
      { op: 'update', step: 'writer', thinking: 'max' },
      { op: 'update', step: 'writer', persona: 'p2' },
      { op: 'update', step: 'writer', instruction: 'i2' },
      { op: 'update', step: 'writer', kind: 'review' },
    ];
    for (const f of fields) expect(plan([f]).frozen?.id).toBe('writer');
  });
});
