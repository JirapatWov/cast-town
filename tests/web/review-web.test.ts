// Adversarial review (web side of R1): "Run again from here" mirrors the server — a continuation's kept result whose
// earlier run was reverted since can't be kept, so the walk stops at that step (it can run again from there).
import { expect, test } from 'bun:test';
import type { RunTeamMember, WorkflowRun, WorkflowRunStep } from '../../shared/protocol';
import { continuableSteps, keptFromReverted } from '../../web/src/ui/runs';

const OPUS = 'anthropic/claude-opus-5-5';
const T = (id: string): RunTeamMember => ({ id, agentId: `p:${id}`, name: id.toUpperCase(), model: OPUS, kind: 'work' });
const A = (stepId: string, status: WorkflowRunStep['status'], over: Partial<WorkflowRunStep> = {}): WorkflowRunStep => ({ stepId, status, agentId: `p:${stepId}`, startedAt: 10, endedAt: 20, ...over });
const run = (id: string, over: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id, workflowId: 'wf', workflowName: 'Team', projectId: 'p', jobId: 'main', task: 't', status: 'completed', currentStepId: null, loop: 0, steps: [], startedAt: 1, endedAt: 100, costUsd: 0, ...over,
});
const team = [T('a'), T('b'), T('c')];
const keys = (m: Map<string, string>) => Object.fromEntries(m);

const a = run('run-a', { steps: [A('a', 'done'), A('b', 'done'), A('c', 'done')] });
const b = run('run-b', {
  continues: { runId: 'run-a', stepId: 'c' },
  steps: [A('a', 'done', { reused: { runId: 'run-a', index: 0 } }), A('b', 'done', { reused: { runId: 'run-a', index: 1 } }), A('c', 'done')],
});
const c = run('run-c', {
  continues: { runId: 'run-b', stepId: 'b' },
  steps: [A('a', 'done', { reused: { runId: 'run-b', index: 0 } }), A('b', 'done'), A('c', 'done')],
});

test('kept rows from a run reverted since stop the walk there; without that run known, the server decides', () => {
  const reverted = { ...a, revertedAt: 500 };
  expect(keys(continuableSteps(b, team, { [a.id]: a, [b.id]: b }))).toEqual({ a: 'a', b: 'b', c: 'c' });
  expect(keys(continuableSteps(b, team, { [a.id]: reverted, [b.id]: b }))).toEqual({ a: 'a' });
  expect(keys(continuableSteps(b, team))).toEqual({ a: 'a', b: 'b', c: 'c' }); // runs unknown: as before
});

test('followed through a continuation of a continuation; the continuation reverted itself is the old rule', () => {
  const runs = { [a.id]: { ...a, revertedAt: 500 }, [b.id]: b, [c.id]: c };
  expect(keptFromReverted(c.steps[0]!, runs)).toBe(true);
  expect(keptFromReverted(c.steps[1]!, runs)).toBe(false); // ran in C itself
  expect(keys(continuableSteps(c, team, runs))).toEqual({ a: 'a' });
  // B reverted: its own c went back, a and b (from A) are as A left them
  const bRev = { [a.id]: a, [b.id]: { ...b, revertedAt: 600 }, [c.id]: c };
  expect(keptFromReverted(c.steps[0]!, bRev)).toBe(false);
  expect(keys(continuableSteps(a, team, bRev))).toEqual({ a: 'a', b: 'b', c: 'c' });
});
