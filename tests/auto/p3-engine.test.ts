// Phase 3: parallel step groups in the WorkflowEngine — who starts together, what {{prev}} the next step gets, review
// loops in and into groups, a failing member, Stop mid-group, currentStepIds, waiting_approval, handoffs, run.json.
import { afterAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkflowRun } from '../../shared/protocol.ts';
import { VERDICT_FOOTER } from '../../server/agents/templates.ts';
import { approve, cleanup, makeP3World, revise, sleep, step } from './p3-world';

afterAll(cleanup);

const runsOf = (w: ReturnType<typeof makeP3World>, id: string) => w.sent.filter((m) => m.t === 'run' && m.run.id === id).map((m) => (m as { run: WorkflowRun }).run);

describe('group membership and order', () => {
  test('a → (b + c) → d: b and c start together on their own people, d only after both, with both replies', async () => {
    const w = makeP3World();
    w.behave.set('b', () => 'hold');
    w.behave.set('c', () => 'hold');
    const run = await w.start([step('a'), step('b'), step('c', { parallel: true }), step('d')]);
    expect(run.team!.map((m) => `${m.id}${m.parallel ? '+' : ''}`)).toEqual(['x-a', 'x-b', 'x-c+', 'x-d']);
    await w.until(() => w.promptsOf('b').length && w.promptsOf('c').length, 3000, 'b and c prompted');
    // both are working at once, d hasn't started
    const live = w.engine.get(run.id)!;
    expect(live.steps.filter((s) => s.status === 'running').map((s) => s.stepId)).toEqual(['x-b', 'x-c']);
    expect(live.currentStepIds).toEqual(['x-b', 'x-c']);
    expect(live.currentStepId).toBe('x-b');
    expect(w.promptsOf('d')).toHaveLength(0);
    const [rb, rc] = live.steps.filter((s) => s.stepId !== 'x-a');
    expect(rb!.startedAt).toBe(rc!.startedAt);
    expect(rb!.agentId).not.toBe(rc!.agentId);
    // same {{prev}} for both: what came before the group
    for (const p of [w.promptsOf('b')[0]!, w.promptsOf('c')[0]!]) {
      expect(p.text).toContain('From A:\na done');
    }
    // the parallel note names the others
    expect(w.promptsOf('b')[0]!.text).toContain('Others work at the same time as you: C. Only change the files of your own part.');
    expect(w.promptsOf('c')[0]!.text).toContain('Others work at the same time as you: B. Only change the files of your own part.');
    expect(w.promptsOf('a')[0]!.text).not.toContain('Others work at the same time');
    // c finishes first: b is the only one working; d still waits
    await sleep(20);
    w.promptsOf('c')[0]!.answer('C found gamma');
    await w.until(() => w.engine.get(run.id)!.currentStepIds?.length === 1, 2000, 'c done');
    expect(w.engine.get(run.id)!.currentStepId).toBe('x-b');
    expect(w.engine.get(run.id)!.steps.find((s) => s.stepId === 'x-c')!.status).toBe('done');
    await sleep(50);
    expect(w.promptsOf('d')).toHaveLength(0);
    w.promptsOf('b')[0]!.answer('B found beta');
    const end = await w.end(run.id);
    expect(end.status).toBe('completed');
    // d: every member's reply under its name, in order; prevName joined with " + "
    const d = w.promptsOf('d')[0]!.text;
    expect(d).toContain('From B + C:\n## B\nB found beta\n\n## C\nC found gamma');
    expect(d).not.toContain('Others work at the same time');
    // overlapping times
    const s = end.steps;
    const b = s.find((x) => x.stepId === 'x-b')!;
    const c = s.find((x) => x.stepId === 'x-c')!;
    const dd = s.find((x) => x.stepId === 'x-d')!;
    expect([b.startedAt! < c.endedAt!, c.startedAt! < b.endedAt!, c.endedAt! < b.endedAt!]).toEqual([true, true, true]);
    expect(dd.startedAt!).toBeGreaterThanOrEqual(Math.max(b.endedAt!, c.endedAt!));
    expect(end.currentStepIds).toEqual([]);
    expect(end.currentStepId).toBeNull();
    w.dispose();
  });

  test('handoffs: a hands to b and c; b and c each hand to d', async () => {
    const w = makeP3World();
    const run = await w.start([step('a'), step('b'), step('c', { parallel: true }), step('d')]);
    await w.end(run.id);
    const hand = w.sent.filter((m) => m.t === 'handoff').map((m) => {
      const h = m as { fromAgentId: string; toAgentId: string };
      return `${h.fromAgentId.split(':').at(-1)}→${h.toAgentId.split(':').at(-1)}`;
    });
    expect(hand).toEqual(['x-a→x-b', 'x-a→x-c', 'x-b→x-d', 'x-c→x-d']);
    w.dispose();
  });

  test('a group at the start and three members; outputs saved per member', async () => {
    const w = makeP3World();
    const run = await w.start([step('a'), step('b', { parallel: true }), step('c', { parallel: true }), step('d')]);
    const end = await w.end(run.id);
    expect(end.status).toBe('completed');
    const first = end.steps.slice(0, 3);
    expect(new Set(first.map((s) => s.startedAt)).size).toBe(1);
    expect(w.promptsOf('a')[0]!.text).toContain('From The user:\n(You are first — there is no previous step.)');
    expect(w.promptsOf('a')[0]!.text).toContain('Others work at the same time as you: B, C.');
    expect(w.promptsOf('d')[0]!.text).toContain('From A + B + C:\n## A\na done\n\n## B\nb done\n\n## C\nc done');
    const dir = join(w.projectPath, '.rlt/runs', run.id);
    expect(readFileSync(join(dir, '01-a.md'), 'utf8')).toContain('a done');
    expect(readFileSync(join(dir, '03-c.md'), 'utf8')).toContain('c done');
    expect(readFileSync(join(dir, '04-d.md'), 'utf8')).toContain('d done');
    w.dispose();
  });
});

describe('reviews in and into groups', () => {
  test('revise if any member says revise; the loop target is a member of a group → the whole group runs again', async () => {
    const w = makeP3World();
    // group 1: w1 + w2; group 2: r1 + r2 (r2 loops back to w2, inside group 1)
    w.behave.set('r2', (_t, n) => (n === 1 ? revise('w2 must cite sources') : approve()));
    const run = await w.start([
      step('w1'),
      step('w2', { parallel: true }),
      step('r1', { kind: 'review', loopBackTo: 'w1', instruction: `Check {{prev}}{{feedback}}\n${VERDICT_FOOTER}` }),
      step('r2', { kind: 'review', loopBackTo: 'w2', parallel: true }),
    ]);
    const end = await w.end(run.id);
    expect(end.status).toBe('completed');
    expect(end.loop).toBe(1);
    // both members of group 1 ran twice, the reviews twice
    expect(['w1', 'w2', 'r1', 'r2'].map((s) => w.promptsOf(s).length)).toEqual([2, 2, 2, 2]);
    expect(end.steps.map((s) => `${s.stepId}:${s.verdict ?? s.status}`)).toEqual([
      'x-w1:done', 'x-w2:done', 'x-r1:approve', 'x-r2:revise', 'x-w1:done', 'x-w2:done', 'x-r1:approve', 'x-r2:approve',
    ]);
    // the second round of group 1 gets the revising review's notes, from the reviewer
    for (const s of ['w1', 'w2']) {
      const p = w.promptsOf(s)[1]!.text;
      expect(p).toContain('R2 asked for changes — address every point:\nw2 must cite sources');
      expect(p).toContain('From R2:\nNot yet.');
    }
    // the parallel note sits before the verdict format of a review
    const r1 = w.promptsOf('r1')[0]!.text;
    expect(r1.indexOf('Others work at the same time as you: R2.')).toBeLessThan(r1.indexOf('End your reply with exactly one block'));
    w.dispose();
  });

  test('the loop target is the loopBackTo of the first revising review; notes of every revising review are passed on', async () => {
    const w = makeP3World();
    w.behave.set('r1', (_t, n) => (n === 1 ? revise('plan is thin') : approve()));
    w.behave.set('r2', (_t, n) => (n === 1 ? revise('build is broken') : approve()));
    const run = await w.start([
      step('plan'),
      step('build'),
      step('r1', { kind: 'review', loopBackTo: 'plan' }),
      step('r2', { kind: 'review', loopBackTo: 'build', parallel: true }),
    ]);
    const end = await w.end(run.id);
    expect(end.status).toBe('completed');
    expect(end.loop).toBe(1);
    expect(w.promptsOf('plan')).toHaveLength(2); // r1 (the first revising one) decides: back to plan
    const again = w.promptsOf('plan')[1]!.text;
    expect(again).toContain('R1 + R2 asked for changes — address every point:\n## R1\nplan is thin\n\n## R2\nbuild is broken');
    w.dispose();
  });

  test('a revising review without loopBackTo does not loop; maxLoops still bounds the rounds', async () => {
    const w = makeP3World();
    w.behave.set('r1', () => revise('never happy'));
    const run = await w.start([step('a'), step('b', { parallel: true }), step('r1', { kind: 'review', loopBackTo: 'a', maxLoops: 1 }), step('r2', { kind: 'review', parallel: true })]);
    const end = await w.end(run.id);
    expect(end.status).toBe('completed');
    expect(end.loop).toBe(1);
    expect(w.promptsOf('a')).toHaveLength(2);
    expect(w.promptsOf('b')).toHaveLength(2);
    w.dispose();
  });
});

describe('a member fails, or the run is stopped mid-group', () => {
  test('one member fails → the run fails, the others are stopped, the next step never starts', async () => {
    const w = makeP3World();
    w.behave.set('b', () => 'hold'); // b keeps working until stopped
    w.behave.set('c', async () => {
      await sleep(30);
      return { status: 'error', text: '', error: 'rate limited' };
    });
    const run = await w.start([step('a'), step('b'), step('c', { parallel: true }), step('d')]);
    const end = await w.end(run.id);
    expect(end.status).toBe('failed');
    await w.until(() => w.aborts.some((x) => x.agentId === w.agentOf('b')), 2000, 'b stopped');
    expect(w.aborts.map((x) => x.agentId)).toEqual([w.agentOf('b')]); // c (failed) isn't stopped again
    await w.until(() => w.promptsOf('b')[0]!.outcome, 2000, 'b answered');
    await sleep(30);
    const r = w.engine.get(run.id)!;
    expect(r.steps.find((s) => s.stepId === 'x-c')).toMatchObject({ status: 'failed', output: 'rate limited' });
    expect(r.steps.find((s) => s.stepId === 'x-b')).toMatchObject({ status: 'failed', output: 'partial work' });
    expect(r.steps.find((s) => s.stepId === 'x-b')!.endedAt).toBeGreaterThan(0);
    expect(w.promptsOf('d')).toHaveLength(0);
    expect(r.currentStepIds).toEqual([]);
    w.dispose();
  });

  test('Stop mid-group (engine.abort): every member is stopped, runAt finds the run from any member, run.json keeps their last words', async () => {
    const w = makeP3World();
    w.behave.set('b', () => 'hold');
    w.behave.set('c', () => 'hold');
    const run = await w.start([step('a'), step('b'), step('c', { parallel: true }), step('d')]);
    await w.until(() => w.promptsOf('b').length && w.promptsOf('c').length, 3000, 'group started');
    expect(w.engine.runAt(w.agentOf('c'))?.id).toBe(run.id);
    expect(w.engine.runAt(w.agentOf('b'))?.id).toBe(run.id);
    expect(w.engine.runAt(w.agentOf('d'))).toBeUndefined(); // not working yet
    expect(w.engine.isBusyInRun(w.agentOf('c'))).toBe(true);
    await w.engine.abort(run.id);
    expect(new Set(w.aborts.map((x) => x.agentId))).toEqual(new Set([w.agentOf('b'), w.agentOf('c')]));
    const end = await w.end(run.id);
    expect(end.status).toBe('aborted');
    await w.until(() => w.promptsOf('b')[0]!.outcome && w.promptsOf('c')[0]!.outcome, 2000, 'both answered');
    expect(w.engine.runAt(w.agentOf('c'))).toBeUndefined();
    // the end snapshot waits for both, then run.json is written again with what they said
    await w.until(() => {
      try {
        const saved = JSON.parse(readFileSync(join(w.projectPath, '.rlt/runs', run.id, 'run.json'), 'utf8')) as WorkflowRun;
        return saved.steps.filter((s) => s.output === 'partial work').length === 2 ? saved : null;
      } catch {
        return null;
      }
    }, 3000, 'run.json rewritten');
    expect(w.promptsOf('d')).toHaveLength(0);
    w.dispose();
  });
});

describe('status while a group works', () => {
  test('waiting_approval while any member waits for the user', async () => {
    const w = makeP3World();
    w.behave.set('b', () => 'hold');
    w.behave.set('c', () => 'hold');
    const run = await w.start([step('a'), step('b'), step('c', { parallel: true })]);
    await w.until(() => w.promptsOf('b').length && w.promptsOf('c').length, 3000, 'group started');
    w.pending.set(w.agentOf('c'), 1);
    w.engine.onApprovalChange(w.agentOf('c'));
    expect(w.engine.get(run.id)!.status).toBe('waiting_approval');
    w.pending.set(w.agentOf('b'), 1);
    w.engine.onApprovalChange(w.agentOf('b'));
    w.pending.set(w.agentOf('c'), 0);
    w.engine.onApprovalChange(w.agentOf('c'));
    expect(w.engine.get(run.id)!.status).toBe('waiting_approval'); // b still waits
    w.pending.set(w.agentOf('b'), 0);
    w.engine.onApprovalChange(w.agentOf('b'));
    expect(w.engine.get(run.id)!.status).toBe('running');
    // an agent outside the working group changes nothing
    w.pending.set(w.agentOf('a'), 1);
    w.engine.onApprovalChange(w.agentOf('a'));
    expect(w.engine.get(run.id)!.status).toBe('running');
    w.promptsOf('b')[0]!.answer('ok');
    w.promptsOf('c')[0]!.answer('ok');
    expect((await w.end(run.id)).status).toBe('completed');
    w.dispose();
  });

  test('currentStepIds over the run (as clients see it)', async () => {
    const w = makeP3World();
    const run = await w.start([step('a'), step('b'), step('c', { parallel: true }), step('d')]);
    await w.end(run.id);
    const seen = runsOf(w, run.id).map((r) => (r.currentStepIds ?? []).join('+'));
    const distinct = seen.filter((x, i) => x !== seen[i - 1]);
    expect(distinct).toContain('x-b+x-c');
    expect(distinct.at(-1)).toBe('');
    expect(distinct.indexOf('x-a')).toBeLessThan(distinct.indexOf('x-b+x-c'));
    expect(distinct.indexOf('x-b+x-c')).toBeLessThan(distinct.lastIndexOf('x-d'));
    w.dispose();
  });

  test('a run without parallel steps behaves as before (one at a time, no notes)', async () => {
    const w = makeP3World();
    w.behave.set('r', (_t, n) => (n === 1 ? revise('again') : approve()));
    const run = await w.start([step('a'), step('b'), step('r', { kind: 'review', loopBackTo: 'b' })]);
    const end = await w.end(run.id);
    expect(end.steps.map((s) => s.stepId)).toEqual(['x-a', 'x-b', 'x-r', 'x-b', 'x-r']);
    expect(w.asked.some((a) => a.text.includes('Others work at the same time'))).toBe(false);
    expect(w.promptsOf('b')[1]!.text).toContain('From R:\nNot yet.');
    expect(w.promptsOf('b')[1]!.text).toContain('R asked for changes — address every point:\nagain');
    for (let i = 1; i < end.steps.length; i++) expect(end.steps[i]!.startedAt!).toBeGreaterThanOrEqual(end.steps[i - 1]!.endedAt!);
    w.dispose();
  });
});
