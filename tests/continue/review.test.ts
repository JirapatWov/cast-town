// Adversarial review of continuing a run (WorkflowEngine planContinue / continueFrom): each test is a bug found by
// trying to break it. R1 kept results whose files were reverted through a chain of continuations; R2 Stop then "Run
// again from here" at once — the stopped run's end snapshot landed in the continuation's work; R3 a revert that
// restored nothing still blocked continuing; R4 a team.json that doesn't match the run's team (ids used as paths).
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EngineError } from '../../server/agents/workflow-engine.ts';
import type { WorkflowRun } from '../../shared/protocol.ts';
import { cleanup, makeCWorld, sleep, step, type CWorld } from './cworld';

afterAll(cleanup);

const abc = () => [step('a'), step('b'), step('c')];
const user = { startedBy: 'user' as const };

async function ended(w: CWorld, steps = abc()): Promise<WorkflowRun> {
  const run = await w.start(steps);
  const end = await w.end(run.id);
  await w.settled(run.id);
  return end;
}

function refuses(f: () => unknown, re: RegExp) {
  let err: unknown;
  try {
    f();
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(EngineError);
  expect((err as Error).message).toMatch(re);
}

describe('R1 a kept result whose run was reverted later', () => {
  test('A → B (continues A from c); reverting A undoes a and b: B can no longer keep them', async () => {
    const w = makeCWorld();
    const a = await ended(w);
    const b = await w.engine.continueFrom(a.id, 'c', user);
    await w.end(b.id);
    await w.settled(b.id);
    expect(w.engine.planContinue(b.id, 'c').kept.map((k) => k.step.id)).toEqual(['a', 'b']);
    await w.engine.revert(a.id); // a's and b's file changes go back
    refuses(() => w.engine.planContinue(b.id, 'c'), /reverted/);
    refuses(() => w.engine.planContinue(b.id, 'b'), /reverted/);
    // from the first step nothing is kept: fine
    expect(w.engine.planContinue(b.id, 'a').startIndex).toBe(0);
    w.dispose();
  });

  test('through two continuations (C keeps a from B, which kept it from A)', async () => {
    const w = makeCWorld();
    const a = await ended(w);
    const b = await w.engine.continueFrom(a.id, 'c', user);
    await w.end(b.id);
    await w.settled(b.id);
    const c = await w.engine.continueFrom(b.id, 'b', user); // keeps a (from A, via B); b and c ran in C
    await w.end(c.id);
    await w.settled(c.id);
    await w.engine.revert(a.id);
    refuses(() => w.engine.planContinue(c.id, 'c'), /reverted/);
    w.dispose();
  });

  test("reverting the continuation itself leaves the earlier run's kept results alone", async () => {
    const w = makeCWorld();
    const a = await ended(w);
    const b = await w.engine.continueFrom(a.id, 'c', user);
    await w.end(b.id);
    await w.settled(b.id);
    await w.engine.revert(b.id); // only c's changes go back: the files are as A left them
    expect(w.engine.planContinue(a.id, 'c').kept.map((k) => k.step.id)).toEqual(['a', 'b']);
    w.dispose();
  });
});

describe('R2 Stop, then "Run again from here" right away', () => {
  test("the stopped run's end snapshot is taken before the continuation's checkpoint, not in the middle of its work", async () => {
    const w = makeCWorld();
    w.behave.set('c', () => 'hold');
    const a = await w.start(abc());
    await w.until(() => w.promptsOf('c', a.id).length, 3000, 'c works in A');
    await w.engine.abort(a.id); // c (temporary x-c) is stopped; A records its end once c is quiet
    const b = await w.engine.continueFrom(a.id, 'c', user); // the same person works on c again at once
    await w.until(() => w.promptsOf('c', b.id).length, 15000, 'c works in B');
    await w.until(() => w.checkpoints.includes(`${a.id}-end`), 15000, "A's end snapshot");
    const at = (ref: string) => w.checkpoints.indexOf(ref);
    expect(at(`${a.id}-end`)).toBeGreaterThanOrEqual(0);
    expect(at(`${a.id}-end`)).toBeLessThan(at(b.id)); // A's revert must not include B's work, nor B's A's
    w.promptsOf('c', b.id).at(-1)!.answer('c done');
    await w.end(b.id);
    w.dispose();
  }, 30000);

  test('a run started in the same folder while nothing is ending does not wait', async () => {
    const w = makeCWorld();
    const a = await ended(w);
    const t = Date.now();
    const b = await w.engine.continueFrom(a.id, 'c', user);
    await w.until(() => w.checkpoints.includes(b.id), 3000, "B's checkpoint");
    expect(Date.now() - t).toBeLessThan(200);
    await w.end(b.id);
    w.dispose();
  });
});

describe('R3 a revert that restored nothing', () => {
  test('does not mark the run reverted (its files are as it left them)', async () => {
    const w = makeCWorld();
    const a = await ended(w);
    // every file it changed was changed again since: nothing restored
    (w.engine as unknown as { d: { git: { undoRun: unknown } } }).d.git.undoRun = async () => ({ restored: [], kept: ['a.txt'] });
    await w.engine.revert(a.id);
    expect(w.engine.get(a.id)!.revertedAt).toBeUndefined();
    expect(w.engine.planContinue(a.id, 'c').startIndex).toBe(2);
    w.dispose();
  });
});

describe("R4 team.json that isn't the run's team", () => {
  test('ids that are not step ids (paths) are refused, not used for files or people', async () => {
    const w = makeCWorld();
    const a = await ended(w);
    const file = join(w.runDir(a.id), 'team.json');
    const team = JSON.parse(readFileSync(file, 'utf8'));
    team[0].id = '../../../../escape';
    writeFileSync(file, JSON.stringify(team));
    refuses(() => w.engine.planContinue(a.id, 'a'), /team/);
    try {
      const r = await w.engine.continueFrom(a.id, 'a', user);
      await w.end(r.id);
    } catch {
      /* refused */
    }
    expect(existsSync(join(w.projectPath, 'escape.md'))).toBe(false); // .rlt/runs/<id>/01-../../../../escape.md
    w.dispose();
  });

  test("a team.json whose steps differ from the run's team is refused", async () => {
    const w = makeCWorld();
    const a = await ended(w);
    const file = join(w.runDir(a.id), 'team.json');
    writeFileSync(file, JSON.stringify([step('a'), step('c'), step('b')]));
    refuses(() => w.engine.planContinue(a.id, 'c'), /team/);
    w.dispose();
  });

  test('the normal case still works (ids as written, x- people)', async () => {
    const w = makeCWorld();
    const a = await ended(w);
    await sleep(5);
    expect(w.engine.planContinue(a.id, 'x-c').fromStepId).toBe('c');
    w.dispose();
  });
});

describe('R7 models for steps that are kept', () => {
  test("a model for a kept step no review can send work back to is refused (it would also swap the job's people for temporary ones)", async () => {
    const w = makeCWorld();
    w.workflows.save(w.projectId, { id: 'tw', name: 'TW', description: '', icon: '🧪', steps: abc() });
    w.jobs.update(w.projectId, 'main', { workflowId: 'tw' });
    const run = await w.startSaved('tw');
    await w.end(run.id);
    await w.settled(run.id);
    refuses(() => w.engine.planContinue(run.id, 'c', { models: { a: 'openai/gpt-6.1-sol' } }), /doesn't run again/);
    expect(w.engine.planContinue(run.id, 'c').own).toBe(true);
    w.dispose();
  });

  test('a kept step a review can send the work back to may get another model', async () => {
    const w = makeCWorld();
    const a = await ended(w, [step('a'), step('b'), step('r', { kind: 'review', loopBackTo: 'a', maxLoops: 1 })]);
    const plan = w.engine.planContinue(a.id, 'r', { models: { a: 'openai/gpt-6.1-sol' } });
    expect(plan.team[0]!.model).toBe('openai/gpt-6.1-sol');
    w.dispose();
  });
});
