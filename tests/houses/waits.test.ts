// Waiting for the user is not working time: the engine's wait clocks (trackWaits / closeWait) and the client's
// worked/waited arithmetic (runs.ts).
import { describe, expect, test } from 'bun:test';
import type { WorkflowRun, WorkflowRunStep } from '../../shared/protocol';
import { closeWait, trackWaits } from '../../server/agents/workflow-engine';
import { runWorked, waitedFor, workedFor } from '../../web/src/ui/runs';

const step = (over: Partial<WorkflowRunStep> = {}): WorkflowRunStep => ({ stepId: 'reviewer', status: 'running', agentId: 'p:reviewer', startedAt: 1_000, ...over });
const run = (steps: WorkflowRunStep[], over: Partial<WorkflowRun> = {}): WorkflowRun =>
  ({ id: 'r', workflowId: 'w', workflowName: 'W', projectId: 'p', jobId: 'main', task: 't', status: 'running', currentStepId: null, loop: 0, steps, startedAt: 0, costUsd: 0, ...over }) as WorkflowRun;

describe('trackWaits', () => {
  test('a step and the run start waiting when an approval is pending, and stop when it is answered', () => {
    const st = step();
    const r = run([st], { status: 'waiting_approval' });
    expect(trackWaits(r, () => true, 5_000)).toBe(true);
    expect(st.waitingSince).toBe(5_000);
    expect(r.waitingSince).toBe(5_000);
    expect(trackWaits(r, () => true, 6_000)).toBe(false); // already waiting
    r.status = 'running';
    expect(trackWaits(r, () => false, 65_000)).toBe(true);
    expect(st.waitingSince).toBeUndefined();
    expect(st.waitedMs).toBe(60_000);
    expect(r.waitedMs).toBe(60_000);
  });

  test('in a parallel group only the one who asks waits', () => {
    const a = step({ stepId: 'a', agentId: 'p:a' });
    const b = step({ stepId: 'b', agentId: 'p:b' });
    const r = run([a, b], { status: 'waiting_approval' });
    trackWaits(r, (id) => id === 'p:b', 2_000);
    expect(a.waitingSince).toBeUndefined();
    expect(b.waitingSince).toBe(2_000);
  });

  test('closeWait adds an open wait up to the end and is a no-op otherwise', () => {
    const st = step({ waitingSince: 10_000, waitedMs: 500 });
    expect(closeWait(st, 12_000)).toBe(true);
    expect(st.waitedMs).toBe(2_500);
    expect(closeWait(st, 13_000)).toBe(false);
    expect(st.waitedMs).toBe(2_500);
  });
});

describe('worked vs waited (client)', () => {
  test('a finished step: elapsed minus waits', () => {
    const st = step({ status: 'done', startedAt: 0, endedAt: 649_000, waitedMs: 629_000 });
    expect(workedFor(st)).toBe(20_000);
    expect(waitedFor(st)).toBe(629_000);
  });
  test('a step waiting now: the worked clock stops at the start of the wait', () => {
    const st = step({ startedAt: 0, waitingSince: 20_000 });
    expect(workedFor(st, 500_000)).toBe(20_000);
    expect(waitedFor(st, 500_000)).toBe(480_000);
  });
  test('kept steps and steps not started have no time', () => {
    expect(workedFor(step({ startedAt: undefined }))).toBeNull();
    expect(workedFor(step({ reused: { runId: 'x', index: 0 } }))).toBeNull();
  });
  test('a run', () => {
    const r = run([], { startedAt: 0, endedAt: 759_000, waitedMs: 570_000, status: 'completed' });
    expect(runWorked(r)).toBe(189_000);
  });
  test('older runs without wait fields count everything as work', () => {
    const r = run([], { startedAt: 0, endedAt: 10_000, status: 'completed' });
    expect(runWorked(r)).toBe(10_000);
    expect(workedFor(step({ status: 'done', startedAt: 0, endedAt: 4_000 }))).toBe(4_000);
  });
});
