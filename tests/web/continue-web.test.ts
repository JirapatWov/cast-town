// Web pure helpers for continuing a run (continue_run / team_continue): web/src/ui/runs.ts (continuableSteps,
// continuedBy, reachedThrough, stepChips.reused) and web/src/ui/plans.ts (stepNote with kept targets, teamLine of
// kept people, planFromName, planSummary, planOutcome for a continuation card). Run: bun test <this file>
import { describe, expect, test } from 'bun:test';
import type { ModelInfo, RunTeamMember, TeamPlan, WorkflowRun, WorkflowRunStep } from '../../shared/protocol';
import { planFromName, planOutcome, planSummary, stepNote, teamLine } from '../../web/src/ui/plans';
import { continuableSteps, continuedBy, reachedThrough, stepChips } from '../../web/src/ui/runs';
import { emptyState } from '../../web/src/net/reducer';

const OPUS = 'anthropic/claude-opus-5-5';
const SOL = 'openai/gpt-6.1-sol';
const models: ModelInfo[] = [
  { id: OPUS, label: 'Claude Opus 5.5', vendor: 'anthropic', available: true },
  { id: SOL, label: 'GPT-6.1 Sol', vendor: 'openai', available: true },
];

const T = (id: string, over: Partial<RunTeamMember> = {}): RunTeamMember => ({ id, agentId: `p:${id}`, name: id.toUpperCase(), model: OPUS, kind: 'work', ...over });
const A = (stepId: string, status: WorkflowRunStep['status'], over: Partial<WorkflowRunStep> = {}): WorkflowRunStep => ({ stepId, status, agentId: `p:${stepId}`, startedAt: 10, endedAt: 20, ...over });

function run(over: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'run-a', workflowId: 'wf', workflowName: 'Team', projectId: 'p', jobId: 'main', task: 't', status: 'completed',
    currentStepId: null, loop: 0, steps: [], startedAt: 1, endedAt: 100, costUsd: 0, ...over,
  };
}

const chain = [T('a'), T('b'), T('c', { kind: 'review', loopBackTo: 'a', maxLoops: 2 })];
const par = [T('a'), T('b'), T('c', { parallel: true }), T('d')];
const keys = (m: Map<string, string>) => Object.fromEntries(m);

describe('continuableSteps', () => {
  test('completed: every step, each to itself', () => {
    const r = run({ team: chain, steps: [A('a', 'done'), A('b', 'done'), A('c', 'done', { verdict: 'approve' })] });
    expect(keys(continuableSteps(r, chain))).toEqual({ a: 'a', b: 'b', c: 'c' });
  });

  test('a review loop: the latest attempt of each step counts', () => {
    const steps = [A('a', 'done'), A('b', 'done'), A('c', 'done', { verdict: 'revise' }), A('a', 'done'), A('b', 'done'), A('c', 'done', { verdict: 'approve' })];
    expect(keys(continuableSteps(run({ steps }), chain))).toEqual({ a: 'a', b: 'b', c: 'c' });
    // the work came back to a and a failed the second time: only from a
    const failedAgain = [A('a', 'done'), A('b', 'done'), A('c', 'done', { verdict: 'revise' }), A('a', 'failed')];
    expect(keys(continuableSteps(run({ status: 'failed', steps: failedAgain }), chain))).toEqual({ a: 'a' });
  });

  test('failed mid-run: up to and including the failed step, not after', () => {
    const r = run({ status: 'failed', steps: [A('a', 'done'), A('b', 'failed')] });
    expect(keys(continuableSteps(r, chain))).toEqual({ a: 'a', b: 'b' });
  });

  test('stopped between groups: the first group that did not run is the last one offered', () => {
    const r = run({ status: 'aborted', steps: [A('a', 'done')] });
    expect(keys(continuableSteps(r, chain))).toEqual({ a: 'a', b: 'b' });
    expect(keys(continuableSteps(run({ status: 'aborted', steps: [] }), chain))).toEqual({ a: 'a' });
  });

  test('parallel group: every member maps to the group start; a half-failed group stops the walk after it', () => {
    const done = run({ steps: [A('a', 'done'), A('b', 'done'), A('c', 'done'), A('d', 'done')] });
    expect(keys(continuableSteps(done, par))).toEqual({ a: 'a', b: 'b', c: 'b', d: 'd' });
    const half = run({ status: 'failed', steps: [A('a', 'done'), A('b', 'done'), A('c', 'failed')] });
    expect(keys(continuableSteps(half, par))).toEqual({ a: 'a', b: 'b', c: 'b' });
  });

  test('reverted: only the first group', () => {
    const r = run({ revertedAt: 200, steps: [A('a', 'done'), A('b', 'done'), A('c', 'done')] });
    expect(keys(continuableSteps(r, chain))).toEqual({ a: 'a' });
    const rp = run({ revertedAt: 200, steps: [A('a', 'done'), A('b', 'done'), A('c', 'done'), A('d', 'done')] });
    expect(keys(continuableSteps(rp, [T('a'), T('x', { parallel: true }), T('d')]))).toEqual({ a: 'a', x: 'a' });
  });

  test('active: nothing', () => {
    expect(continuableSteps(run({ status: 'running', steps: [A('a', 'done')] }), chain).size).toBe(0);
    expect(continuableSteps(run({ status: 'waiting_approval', steps: [A('a', 'done')] }), chain).size).toBe(0);
  });

  test('a continuation that ended: its kept (reused) rows count as done', () => {
    const r = run({ id: 'run-b', continues: { runId: 'run-a', stepId: 'c' }, steps: [A('a', 'done', { reused: { runId: 'run-a', index: 0 } }), A('b', 'done', { reused: { runId: 'run-a', index: 1 } }), A('c', 'done')] });
    expect(keys(continuableSteps(r, chain))).toEqual({ a: 'a', b: 'b', c: 'c' });
  });
});

describe('reachedThrough', () => {
  test('furthest person of the current pass, to the end of the group', () => {
    expect(reachedThrough(run({ steps: [] }), chain)).toBe(-1);
    expect(reachedThrough(run({ steps: [A('a', 'done'), A('b', 'failed')] }), chain)).toBe(1);
    // a loop back to a starts a new pass
    expect(reachedThrough(run({ steps: [A('a', 'done'), A('b', 'done'), A('c', 'done'), A('a', 'running')] }), chain)).toBe(0);
    // b of the group b + c reached: the group counts as reached
    expect(reachedThrough(run({ steps: [A('a', 'done'), A('b', 'running')] }), par)).toBe(2);
  });
});

describe('continuedBy', () => {
  test('later runs that continue this one, newest first', () => {
    const s = emptyState();
    const a = run({ id: 'run-a' });
    s.runs = {
      'run-a': a,
      'run-b': run({ id: 'run-b', startedAt: 200, continues: { runId: 'run-a', stepId: 'c' } }),
      'run-c': run({ id: 'run-c', startedAt: 300, continues: { runId: 'run-a', stepId: 'b' } }),
      'run-d': run({ id: 'run-d', startedAt: 400, continues: { runId: 'run-b', stepId: 'c' } }),
      'run-e': run({ id: 'run-e', startedAt: 500 }),
    };
    expect(continuedBy(s, a).map((r) => r.id)).toEqual(['run-c', 'run-b']);
    expect(continuedBy(s, { id: 'run-e' })).toEqual([]);
  });
});

describe('stepChips', () => {
  test('reused is set only for a kept latest attempt', () => {
    const s = { ...emptyState(), models };
    const r = run({ team: chain, continues: { runId: 'run-a', stepId: 'c' }, steps: [A('a', 'done', { reused: { runId: 'run-a', index: 0 } }), A('b', 'done', { reused: { runId: 'run-a', index: 1 } }), A('c', 'running')], status: 'running' });
    const chips = stepChips(s, r);
    expect(chips.map((c) => c.reused ?? false)).toEqual([true, true, false]);
    expect('reused' in chips[2]).toBe(false); // plain chips keep their old shape
  });
});

describe('plans: continuation card', () => {
  function plan(over: Partial<TeamPlan> = {}): TeamPlan {
    return {
      id: 'p1', agentId: 'p:main:assistant', projectId: 'p', jobId: 'main', title: 'Decode → Implement → Review', task: 't',
      steps: [{ id: 'reviewer', name: 'Reviewer', duty: 'Checks', model: SOL, kind: 'review', loopBackTo: 'implementer', maxLoops: 2 }],
      continues: { runId: 'run-a', fromStepId: 'reviewer', kept: [{ id: 'decoder', name: 'Decoder' }, { id: 'implementer', name: 'Implementer' }], note: 'Look closer' },
      status: 'pending', ts: 1, ...over,
    };
  }

  test('stepNote resolves a loop target among the kept people', () => {
    const p = plan();
    expect(stepNote(p.steps[0], p.steps, p.continues!.kept)).toBe('checks · sends back to Implementer (kept) up to 2×');
    // without kept (old callers): just "checks"
    expect(stepNote(p.steps[0], p.steps)).toBe('checks');
    // a target on the card itself wins, without "(kept)"
    const steps = [{ id: 'implementer', name: 'Implementer', kind: 'work' as const }, { id: 'reviewer', name: 'Reviewer', kind: 'review' as const, loopBackTo: 'implementer', maxLoops: 3 }];
    expect(stepNote(steps[1], steps, p.continues!.kept)).toBe('checks · sends back to Implementer up to 3×');
    // unknown target: "checks"
    expect(stepNote({ ...p.steps[0], loopBackTo: 'ghost' }, p.steps, p.continues!.kept)).toBe('checks');
  });

  test('teamLine takes the kept people (no parallel info: one after another)', () => {
    expect(teamLine(plan().continues!.kept)).toBe('Decoder → Implementer');
    expect(teamLine([])).toBe('');
  });

  test('planFromName / planSummary', () => {
    expect(planFromName(plan())).toBe('Reviewer');
    expect(planFromName(plan({ continues: undefined }))).toBe('');
    // fromStepId not on the card (should not happen): the first step
    expect(planFromName(plan({ continues: { runId: 'r', fromStepId: 'x', kept: [] } }))).toBe('Reviewer');
    expect(planSummary(plan())).toBe('Continue “Decode → Implement → Review” from Reviewer — Reviewer. Run it or change the models.');
    // a plain plan reads as before
    expect(planSummary(plan({ continues: undefined }))).toBe('“Decode → Implement → Review” — Reviewer. Run it or change the models.');
  });

  test('planOutcome for a continuation card', () => {
    expect(planOutcome(plan(), undefined, models)).toBe('Waiting for you');
    expect(planOutcome(plan({ status: 'cancelled' }), undefined, models)).toBe('Cancelled');
    const approved = plan({ status: 'approved', runId: 'run-b', changed: { reviewer: OPUS } });
    expect(planOutcome(approved, undefined, models)).toBe('Started — you changed Reviewer to Claude Opus 5.5');
    const b = run({ id: 'run-b', status: 'running', continues: { runId: 'run-a', stepId: 'reviewer' } });
    expect(planOutcome(approved, b, models)).toBe('Running — you changed Reviewer to Claude Opus 5.5');
    expect(planOutcome(plan({ status: 'approved', runId: 'run-b' }), { ...b, status: 'completed' }, models)).toBe('Completed');
  });
});
