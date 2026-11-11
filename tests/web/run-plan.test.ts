// Web pure helpers for changing a going run from its card (web/src/ui/run-plan.ts): which steps can still change,
// who a note reaches, the edit op for a changed step, a person to add, where they can go, the "Changed" line.
// Run: bun test <this file>
import { describe, expect, test } from 'bun:test';
import type { RunPlanView, WorkflowRun, WorkflowStep } from '../../shared/protocol';
import { addOp, addPlaces, blankStep, editableFrom, editedLine, stepOps, workingNow } from '../../web/src/ui/run-plan';
import { timeOfDay } from '../../web/src/ui/format';

const OPUS = 'anthropic/claude-opus-5-5';
const SOL = 'openai/gpt-6.1-sol';
const S = (id: string, over: Partial<WorkflowStep> = {}): WorkflowStep => ({ id, name: id.toUpperCase(), model: OPUS, persona: `p ${id}`, instruction: `do ${id}`, kind: 'work', ...over });
const team = [S('idea'), S('writer'), S('editor', { kind: 'review', loopBackTo: 'writer', maxLoops: 2, model: SOL })];

describe('editableFrom / workingNow', () => {
  test('from the end of the group working now; nothing when it ended or without planAt', () => {
    expect(editableFrom({ status: 'running', planAt: { start: 1, end: 2 } })).toBe(2);
    expect(editableFrom({ status: 'waiting_approval', planAt: { start: 0, end: 1 } })).toBe(1);
    expect(editableFrom({ status: 'completed', planAt: { start: 1, end: 2 } })).toBe(Infinity);
    expect(editableFrom({ status: 'running' })).toBe(Infinity);
    expect(workingNow({ status: 'running', planAt: { start: 1, end: 2 } }, team)).toEqual(['writer']);
    expect(workingNow({ status: 'aborted', planAt: { start: 1, end: 2 } }, team)).toEqual([]);
  });
});

describe('stepOps', () => {
  test('only what changed; cleared effort / sending back / parallel', () => {
    const before = team[2]!;
    expect(stepOps(before, { ...before })).toBeNull();
    expect(stepOps(before, { ...before, instruction: 'polish lightly' })).toEqual({ op: 'update', step: 'editor', instruction: 'polish lightly' });
    expect(stepOps(before, { ...before, model: OPUS, thinking: 'max', persona: 'Kind.' })).toEqual({ op: 'update', step: 'editor', model: OPUS, thinking: 'max', persona: 'Kind.' });
    expect(stepOps({ ...before, thinking: 'high' }, { ...before, thinking: undefined })).toEqual({ op: 'update', step: 'editor', thinking: '' });
    expect(stepOps(before, { ...before, kind: 'work', loopBackTo: undefined })).toEqual({ op: 'update', step: 'editor', kind: 'work' });
    expect(stepOps(before, { ...before, loopBackTo: undefined })).toEqual({ op: 'update', step: 'editor', loopBackTo: '' });
    expect(stepOps(before, { ...before, maxLoops: 4 })).toEqual({ op: 'update', step: 'editor', maxLoops: 4 });
    expect(stepOps({ ...before, parallel: true }, { ...before, parallel: undefined })).toEqual({ op: 'update', step: 'editor', parallel: false });
    expect(stepOps(before, { ...before, parallel: undefined })).toBeNull(); // undefined vs absent
    expect(stepOps(before, { ...before, name: 'Polisher' })).toEqual({ op: 'update', step: 'editor', name: 'Polisher' });
  });
});

describe('addOp / addPlaces / blankStep', () => {
  const view: Pick<RunPlanView, 'steps' | 'frozen'> = { steps: team, frozen: 2 };
  test('a person after a step (or at the end), its review loop; the places after the group working now', () => {
    expect(addPlaces(view)).toEqual([
      { after: 'writer', label: 'After WRITER (next)' },
      { after: 'editor', label: 'After EDITOR' },
    ]);
    expect(addPlaces({ steps: team, frozen: 3 })).toEqual([{ after: 'editor', label: 'After EDITOR (next)' }]);
    const blank = blankStep(view, 'editor');
    expect(blank).toMatchObject({ name: '', model: SOL, kind: 'work', persona: '', instruction: '' });
    expect(addOp({ ...blank, name: ' Proofreader ', persona: 'Reads.' }, 'editor')).toEqual({ op: 'add', after: 'editor', person: { name: 'Proofreader', model: SOL, kind: 'work', persona: 'Reads.' } });
    expect(addOp({ ...blank, name: 'Checker', kind: 'review', loopBackTo: 'writer', thinking: 'low', instruction: 'Check {{prev}}' }, '')).toEqual({
      op: 'add',
      person: { name: 'Checker', model: SOL, kind: 'review', persona: '', instruction: 'Check {{prev}}', thinking: 'low', loopBackTo: 'writer', maxLoops: 2 },
    });
  });
});

describe('editedLine', () => {
  test('when, what, who, saved', () => {
    const at = Date.UTC(2026, 10, 3, 9, 5);
    expect(editedLine({ at, by: 'user', changes: ['Editor: instruction', 'added Proofreader'] })).toBe(`${timeOfDay(at)} · Editor: instruction; added Proofreader — by you`);
    expect(editedLine({ at, by: 'lead', changes: ['note to Writer'], saved: 'Mine' })).toBe(`${timeOfDay(at)} · note to Writer — by the lead (also saved to “Mine”)`);
  });
});

// the run card's types stay in step with the server's (compile-time)
const _run: Pick<WorkflowRun, 'edits' | 'planAt' | 'planRev'> = { edits: [{ at: 1, by: 'user', changes: [] }], planAt: { start: 0, end: 1 }, planRev: 1 };
void _run;
