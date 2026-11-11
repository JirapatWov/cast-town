// E1–E11: continuing an ended run from a step in the WorkflowEngine (planContinue / continueFrom) — what runs, what
// is kept and handed on, the notes, review loops into kept steps, parallel groups, refusals, models, people, the
// run dir, persistence across a restart. (E12, normal runs unchanged, is golden.test.ts.)
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EngineError } from '../../server/agents/workflow-engine.ts';
import { VERDICT_FOOTER } from '../../server/agents/templates.ts';
import type { WorkflowRun } from '../../shared/protocol.ts';
import { approve, cleanup, GPT, makeCWorld, OPUS, revise, sleep, step, type CWorld } from './cworld';

afterAll(cleanup);

const abc = () => [step('a'), step('b'), step('c')];
const ids = (r: WorkflowRun) => r.steps.map((s) => `${s.stepId}${s.reused ? `<${s.reused.index}` : ''}:${s.verdict ?? s.status}`);
const user = { startedBy: 'user' as const };

async function ended(w: CWorld, steps = abc(), task = 'Do the thing'): Promise<WorkflowRun> {
  const run = await w.start(steps, task);
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

async function refusesAsync(p: Promise<unknown>, re: RegExp) {
  let err: unknown;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(EngineError);
  expect((err as Error).message).toMatch(re);
}

describe('E1 continue a→b→c from c', () => {
  test('only c works; it gets b\'s full reply from 02-b.md; kept rows, cost, continues, run dir; the old run stays', async () => {
    const w = makeCWorld();
    const big = `B report start\n${'x'.repeat(20 * 1024)}\nB report end`;
    w.behave.set('b', () => big);
    const cost = (s: string) => () => {
      const id = w.tempAgent(s);
      w.store.patch(id, { costUsd: (w.store.get(id)?.costUsd ?? 0) + 0.25 });
      return `${s} done`;
    };
    w.behave.set('a', cost('a'));
    w.behave.set('c', cost('c'));
    const old = await ended(w);
    expect(old.status).toBe('completed');
    expect(old.costUsd).toBeCloseTo(0.5);
    const oldJson = readFileSync(join(w.runDir(old.id), 'run.json'), 'utf8');
    const oldFiles = readdirSync(w.runDir(old.id)).sort();
    expect(old.steps[1]!.output!.length).toBeLessThan(9000); // run.json keeps only 8 KB of it

    const before = w.asked.length;
    const run = await w.engine.continueFrom(old.id, 'c', user);
    expect(run.continues).toEqual({ runId: old.id, stepId: 'x-c' });
    const end = await w.end(run.id);
    await w.settled(run.id);
    expect(end.status).toBe('completed');
    const fresh = w.asked.slice(before);
    expect(fresh.map((a) => a.step)).toEqual(['c']);
    expect(fresh[0]!.text).toContain(`From B:\n${big}\n\nThis step runs again`); // the whole 20 KB, not 8 KB
    expect(ids(end)).toEqual(['x-a<0:done', 'x-b<1:done', 'x-c:done']);
    expect(end.steps[0]!.reused).toEqual({ runId: old.id, index: 0 });
    expect(end.steps[1]!.output).toBe(old.steps[1]!.output);
    expect(end.steps[1]!.startedAt).toBe(old.steps[1]!.startedAt);
    expect(end.costUsd).toBeCloseTo(0.25); // c only
    expect(end.workflowName).toBe(old.workflowName);
    expect(end.adhoc).toBe(true);
    expect(end.task).toBe(old.task);
    // the new run dir: kept replies, c's own, the continuation in task.md
    const dir = w.runDir(run.id);
    expect(readFileSync(join(dir, '01-a.md'), 'utf8')).toBe('# A\n\na done\n');
    expect(readFileSync(join(dir, '02-b.md'), 'utf8')).toBe(`# B\n\n${big}\n`);
    expect(readFileSync(join(dir, '03-c.md'), 'utf8')).toBe('# C\n\nc done\n');
    expect(readFileSync(join(dir, 'task.md'), 'utf8')).toBe(`# P3 team\n\nDo the thing\n\nContinues run ${old.id} from C; kept: A → B.\n`);
    // the old run is as it was
    expect(readFileSync(join(w.runDir(old.id), 'run.json'), 'utf8')).toBe(oldJson);
    expect(readdirSync(w.runDir(old.id)).sort()).toEqual(oldFiles);
    expect(w.engine.get(old.id)).toEqual(JSON.parse(oldJson));
    // the toast says it continued
    expect(w.toasts.some((t) => /P3 team finished in \d+s \(continued from C\)$/.test(t))).toBe(true);
    w.dispose();
  });
});

describe('E2 the note and the "runs again" paragraph', () => {
  test('lands where {{feedback}} does; appended without it; before a review\'s verdict format', async () => {
    const w = makeCWorld();
    const old = await ended(w, [
      step('a'),
      step('b', { instruction: 'Just {{task}} after {{prevName}}' }), // no {{feedback}}
      step('r', { kind: 'review', instruction: `Check {{prev}}\n${VERDICT_FOOTER}` }),
    ]);
    // from b: no {{feedback}} → at the end
    const r1 = await w.engine.continueFrom(old.id, 'b', { ...user, note: 'Use tabs.' });
    await w.end(r1.id);
    const b = w.promptsOf('b', r1.id)[0]!.text;
    expect(b).toBe(
      `Just Do the thing after A\n\nThis step runs again: the steps before it are kept from an earlier run (${old.id}), and the files are as that run left them — they may already contain the earlier attempt at this step and the steps after it; build on them, don't apply changes twice. Your earlier reply: \`.rlt/runs/${old.id}/02-b.md\`.\n\nThe user asked for this part to be done again — take this into account:\nUse tabs.`,
    );
    // r (after b) gets no note
    expect(w.promptsOf('r', r1.id)[0]!.text).not.toContain('runs again');
    expect(w.promptsOf('r', r1.id)[0]!.text).not.toContain('Use tabs');
    // from r: a review — before the verdict format, which stays last
    const r2 = await w.engine.continueFrom(old.id, 'r', { ...user, note: 'Be strict.' });
    await w.end(r2.id);
    const r = w.promptsOf('r', r2.id)[0]!.text;
    expect(r.endsWith(VERDICT_FOOTER)).toBe(true);
    expect(r).toContain(`Check b done\n\nThis step runs again: the steps before it are kept from an earlier run (${old.id})`);
    expect(r).toContain(`Your earlier reply: \`.rlt/runs/${old.id}/03-r.md\`.\n\nThe user asked for this part to be done again — take this into account:\nBe strict.\n\n${VERDICT_FOOTER}`);
    w.dispose();
  });

  test('with {{feedback}}: in the instruction where it lands; sticky on a loop, "runs again" only the first time', async () => {
    const w = makeCWorld();
    const old = await ended(w, [step('a'), step('b'), step('r', { kind: 'review', loopBackTo: 'b', maxLoops: 2, instruction: `Check {{prev}}\n${VERDICT_FOOTER}` })]);
    let round = 0;
    w.behave.set('r', () => (++round === 1 ? revise('Fix the edge case.') : approve()));
    const run = await w.engine.continueFrom(old.id, 'b', { ...user, note: 'Keep the API stable.' });
    const end = await w.end(run.id);
    expect(end.loop).toBe(1);
    expect(ids(end)).toEqual(['x-a<0:done', 'x-b:done', 'x-r:revise', 'x-b:done', 'x-r:approve']);
    const [first, second] = w.promptsOf('b', run.id).map((a) => a.text);
    expect(first).toBe(
      `Task: Do the thing\nFrom A:\na done\n\nThis step runs again: the steps before it are kept from an earlier run (${old.id}), and the files are as that run left them — they may already contain the earlier attempt at this step and the steps after it; build on them, don't apply changes twice. Your earlier reply: \`.rlt/runs/${old.id}/02-b.md\`.\n\nThe user asked for this part to be done again — take this into account:\nKeep the API stable.\nDir .rlt/runs/${run.id}`,
    );
    expect(second).toContain('R asked for changes — address every point:\nFix the edge case.\n\nThe user asked for this part to be done again — take this into account:\nKeep the API stable.\nDir ');
    expect(second).not.toContain('This step runs again');
    // the earlier reply files of this run are numbered after the kept ones
    expect(existsSync(join(w.runDir(run.id), '04-b.md'))).toBe(true);
    // no note: the second time says nothing extra
    const w2 = makeCWorld();
    const o2 = await ended(w2, [step('a'), step('b'), step('r', { kind: 'review', loopBackTo: 'b', maxLoops: 2 })]);
    let n2 = 0;
    w2.behave.set('r', () => (++n2 === 1 ? revise('again') : approve()));
    const c2 = await w2.engine.continueFrom(o2.id, 'b', user);
    await w2.end(c2.id);
    const again = w2.promptsOf('b', c2.id)[1]!.text;
    expect(again).toBe(`Task: Do the thing\nFrom R:\nNot yet.\n\`\`\`json\n{"verdict":"revise","notes":"again"}\n\`\`\`\n\nR asked for changes — address every point:\nagain\nDir .rlt/runs/${c2.id}`);
    w.dispose();
    w2.dispose();
  });

  test('from the first step: nothing kept, the whole team again on the files as they are', async () => {
    const w = makeCWorld();
    const old = await ended(w);
    const run = await w.engine.continueFrom(old.id, 'a', user);
    const end = await w.end(run.id);
    expect(ids(end)).toEqual(['x-a:done', 'x-b:done', 'x-c:done']);
    const a = w.promptsOf('a', run.id)[0]!.text;
    expect(a).toContain(`From The user:\n(You are first — there is no previous step.)\n\nThis team runs again after an earlier run (${old.id}), and the files are as that run left them`);
    expect(readFileSync(join(w.runDir(run.id), 'task.md'), 'utf8')).toContain(`Continues run ${old.id} from A; nothing kept.`);
    w.dispose();
  });
});

describe('E3 a review sends the work back into kept steps', () => {
  test('a→b→r(loopBackTo a, maxLoops 1) from r: r revises → a then b run with R\'s notes; people move in when needed', async () => {
    const w = makeCWorld();
    const team = [step('a'), step('b'), step('r', { kind: 'review', loopBackTo: 'a', maxLoops: 1, instruction: `Check {{prev}}\n${VERDICT_FOOTER}` })];
    const old = await ended(w, team);
    w.ensured.length = 0;
    let n = 0;
    w.behave.set('r', () => (++n === 1 ? revise('A missed the config.') : approve()));
    w.behave.set('a', () => 'hold');
    const run = await w.engine.continueFrom(old.id, 'r', user);
    expect([...new Set(w.ensured)]).toEqual([w.tempAgent('r')]); // only r moves in at the start (and for its group)
    await w.until(() => w.promptsOf('a', run.id).length, 3000, 'a prompted');
    expect(w.ensured.filter((x) => x === w.tempAgent('a'))).toHaveLength(1); // a when the loop reached them
    expect(w.ensured).not.toContain(w.tempAgent('b'));
    const a = w.promptsOf('a', run.id)[0]!;
    expect(a.text).toContain('From R:\nNot yet.');
    expect(a.text).toContain('R asked for changes — address every point:\nA missed the config.');
    expect(a.text).not.toContain('runs again'); // the note is the start group's
    a.answer('a fixed');
    const end = await w.end(run.id);
    expect(end.loop).toBe(1);
    expect(ids(end)).toEqual(['x-a<0:done', 'x-b<1:done', 'x-r:revise', 'x-a:done', 'x-b:done', 'x-r:approve']);
    expect(w.ensured).toContain(w.tempAgent('b'));
    expect(w.promptsOf('b', run.id)[0]!.text).toContain('From A:\na fixed');
    // the second review gets no "runs again" sentence (seen) and no note (none given)
    expect(w.promptsOf('r', run.id)[1]!.text).not.toContain('runs again');
    w.dispose();
  });
});

describe('E4 parallel groups', () => {
  test('a→(b+c)→d: from c runs b and c again (noted); from d hands both replies on', async () => {
    const w = makeCWorld();
    w.behave.set('b', () => 'B found beta');
    w.behave.set('c', () => 'C found gamma');
    const old = await ended(w, [step('a'), step('b'), step('c', { parallel: true }), step('d')]);
    const plan = w.engine.planContinue(old.id, 'c');
    expect(plan.startIndex).toBe(1);
    expect(plan.fromStepId).toBe('b');
    expect(plan.notes.join('\n')).toContain('“C” works at the same time as “B”, so the whole group runs again: B + C.');
    const r1 = await w.engine.continueFrom(old.id, 'c', user);
    const e1 = await w.end(r1.id);
    expect(r1.continues!.stepId).toBe('x-b');
    expect(['a', 'b', 'c', 'd'].map((s) => w.promptsOf(s, r1.id).length)).toEqual([0, 1, 1, 1]);
    expect(w.promptsOf('b', r1.id)[0]!.text).toContain('From A:\na done\n\nThis step runs again');
    expect(w.promptsOf('b', r1.id)[0]!.text).toContain(`Your earlier reply: \`.rlt/runs/${old.id}/02-b.md\``);
    expect(w.promptsOf('c', r1.id)[0]!.text).toContain(`Your earlier reply: \`.rlt/runs/${old.id}/03-c.md\``);
    expect(w.promptsOf('c', r1.id)[0]!.text).toContain('Others work at the same time as you: B.');
    expect(ids(e1)).toEqual(['x-a<0:done', 'x-b:done', 'x-c:done', 'x-d:done']);

    const r2 = await w.engine.continueFrom(old.id, 'd', user);
    await w.end(r2.id);
    expect(w.promptsOf('d', r2.id)[0]!.text).toContain('From B + C:\n## B\nB found beta\n\n## C\nC found gamma\n\nThis step runs again');
    w.dispose();
  });
});

describe('E5 a failed run', () => {
  test('a done, b failed: from c names B; from b works; from a keeps nothing', async () => {
    const w = makeCWorld();
    w.behave.set('b', () => ({ status: 'error', text: '', error: 'boom' }));
    const old = await ended(w);
    expect(old.status).toBe('failed');
    refuses(() => w.engine.planContinue(old.id, 'c'), /“B”'s last attempt in that run didn't finish .* continue from B \(b\) or earlier/);
    await refusesAsync(w.engine.continueFrom(old.id, 'c', user), /“B”/);
    w.behave.delete('b');
    const fromB = await w.engine.continueFrom(old.id, 'b', user);
    const e = await w.end(fromB.id);
    expect(ids(e)).toEqual(['x-a<0:done', 'x-b:done', 'x-c:done']);
    const fromA = await w.engine.continueFrom(old.id, 'a', user);
    const ea = await w.end(fromA.id);
    expect(ea.steps.some((s) => s.reused)).toBe(false);
    expect(ids(ea)).toEqual(['x-a:done', 'x-b:done', 'x-c:done']);
    w.dispose();
  });

  test('a step that never ran (stopped before it) refuses to be kept', async () => {
    const w = makeCWorld();
    w.behave.set('b', () => 'hold');
    const run = await w.start(abc());
    await w.until(() => w.promptsOf('b').length, 3000, 'b');
    await w.engine.abort(run.id);
    await w.settled(run.id);
    refuses(() => w.engine.planContinue(run.id, 'c'), /“B”'s last attempt in that run didn't finish/);
    w.behave.delete('b');
    const w2 = makeCWorld();
    // stopped between groups: c never ran
    w2.behave.set('c', () => 'hold');
    const r2 = await w2.start([step('a'), step('b'), step('c'), step('d')]);
    await w2.until(() => w2.promptsOf('c').length, 3000, 'c');
    await w2.engine.abort(r2.id);
    await w2.settled(r2.id);
    refuses(() => w2.engine.planContinue(r2.id, 'd'), /“C”'s last attempt/);
    w2.behave.delete('c');
    const ok = await w2.engine.continueFrom(r2.id, 'c', user);
    expect(ids(await w2.end(ok.id))).toEqual(['x-a<0:done', 'x-b<1:done', 'x-c:done', 'x-d:done']);
    // a step with no attempt at all
    const w3 = makeCWorld();
    w3.behave.set('a', () => 'hold');
    const r3 = await w3.start(abc());
    await w3.until(() => w3.promptsOf('a').length, 3000, 'a');
    await w3.engine.abort(r3.id);
    await w3.settled(r3.id);
    refuses(() => w3.engine.planContinue(r3.id, 'c'), /“A”'s last attempt/);
    refuses(() => w3.engine.planContinue(r3.id, 'b'), /“A”'s last attempt/);
    // remove a's row: b never ran at all
    const r3b = w3.engine.get(r3.id)!;
    r3b.steps = [{ ...r3b.steps[0]!, status: 'done' }];
    refuses(() => w3.engine.planContinue(r3.id, 'c'), /“B” never ran in that run — continue from B \(b\) or earlier/);
    w.dispose();
    w2.dispose();
    w3.dispose();
  });
});

describe('E6 continuing a continuation', () => {
  test('the kept texts come from the continuation\'s copied files; reused points at it', async () => {
    const w = makeCWorld();
    const old = await ended(w);
    const run2 = await w.engine.continueFrom(old.id, 'c', user);
    await w.end(run2.id);
    await w.settled(run2.id);
    writeFileSync(join(w.runDir(run2.id), '02-b.md'), '# B\n\nB as copied into run 2\n');
    const run3 = await w.engine.continueFrom(run2.id, 'c', user);
    const e3 = await w.end(run3.id);
    expect(w.promptsOf('c', run3.id)[0]!.text).toContain('From B:\nB as copied into run 2\n\nThis step runs again');
    expect(w.promptsOf('c', run3.id)[0]!.text).toContain(`kept from an earlier run (${run2.id})`);
    expect(e3.steps.slice(0, 2).map((s) => s.reused)).toEqual([{ runId: run2.id, index: 0 }, { runId: run2.id, index: 1 }]);
    expect(e3.continues!.runId).toBe(run2.id);
    expect(readFileSync(join(w.runDir(run3.id), '02-b.md'), 'utf8')).toBe('# B\n\nB as copied into run 2\n');
    w.dispose();
  });
});

describe('E7 refusals', () => {
  test('a run going in the job; the source still going; an unknown step; reverted files; no team kept', async () => {
    const w = makeCWorld();
    const old = await ended(w);
    // a run going in the job
    w.behave.set('a', () => 'hold');
    const other = await w.start(abc());
    await w.until(() => w.promptsOf('a').length, 3000, 'a');
    await refusesAsync(w.engine.continueFrom(old.id, 'c', user), /already running in “Main”/);
    // the source is still going
    refuses(() => w.engine.planContinue(other.id, 'a'), /still running/);
    w.promptsOf('a').at(-1)!.answer('a done');
    w.behave.delete('a');
    await w.end(other.id);
    await w.settled(other.id);
    // two at once (a double click): the second is refused
    const first = w.engine.continueFrom(old.id, 'c', user);
    const second = w.engine.continueFrom(old.id, 'c', user);
    await refusesAsync(second, /already running/);
    await w.end((await first).id);
    // unknown step: the run's step ids
    refuses(() => w.engine.planContinue(old.id, 'zz'), /^No step “zz” — this run's steps: a, b, c\.$/);
    refuses(() => w.engine.planContinue('run-nope', 'a'), /no longer in history/);
    // reverted: only from the first step
    await w.engine.revert(old.id);
    expect(w.engine.get(old.id)!.revertedAt).toBeNumber();
    expect(JSON.parse(readFileSync(join(w.runDir(old.id), 'run.json'), 'utf8')).revertedAt).toBe(w.engine.get(old.id)!.revertedAt);
    refuses(() => w.engine.planContinue(old.id, 'b'), /reverted/);
    expect(w.engine.planContinue(old.id, 'a').startIndex).toBe(0);
    // a preview doesn't count
    const old2 = await ended(w);
    await w.engine.revert(old2.id, true);
    expect(w.engine.get(old2.id)!.revertedAt).toBeUndefined();
    // no team.json and no workflow
    rmSync(join(w.runDir(old2.id), 'team.json'));
    refuses(() => w.engine.planContinue(old2.id, 'c'), /didn't keep the team of run/);
    w.dispose();
  });

  test('no team.json: the saved workflow when it has the same steps; refused when it changed', async () => {
    const w = makeCWorld();
    w.workflows.save(w.projectId, { id: 'tw', name: 'TW', description: '', icon: '🧪', steps: abc() });
    const run = await w.startSaved('tw');
    await w.end(run.id);
    await w.settled(run.id);
    rmSync(join(w.runDir(run.id), 'team.json'));
    const plan = w.engine.planContinue(run.id, 'c');
    expect(plan.team.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(plan.notes.join('\n')).toContain("CAST didn't keep that run's team");
    w.workflows.save(w.projectId, { id: 'tw', name: 'TW', description: '', icon: '🧪', steps: [step('a'), step('c')] });
    refuses(() => w.engine.planContinue(run.id, 'c'), /didn't keep the team of run .*, and its workflow has other steps now/);
    w.dispose();
  });

  test('a run of a job copy that went away (copyOf) and a missing run folder are refused', async () => {
    const w = makeCWorld();
    const old = await ended(w);
    const undo = join(w.runDir(old.id), 'undo.json');
    writeFileSync(undo, JSON.stringify({ ...JSON.parse(readFileSync(undo, 'utf8')), copyOf: 'rlt/job-x' }));
    refuses(() => w.engine.planContinue(old.id, 'c'), /kept on branch rlt\/job-x/);
    const old2 = await ended(w);
    rmSync(w.runDir(old2.id), { recursive: true });
    refuses(() => w.engine.planContinue(old2.id, 'c'), /can't find the folder of that run/);
    w.dispose();
  });
});

describe('E8 models', () => {
  test('{c: GPT} runs c on GPT; team.json and run.team say so', async () => {
    const w = makeCWorld();
    const old = await ended(w);
    const run = await w.engine.continueFrom(old.id, 'c', { ...user, models: { 'x-c': GPT } });
    await w.end(run.id);
    expect(run.team!.find((m) => m.id === 'x-c')!.model).toBe(GPT);
    const team = JSON.parse(readFileSync(join(w.runDir(run.id), 'team.json'), 'utf8'));
    expect(team.map((s: { id: string; model: string }) => `${s.id}:${s.model}`)).toEqual([`a:${OPUS}`, `b:${OPUS}`, `c:${GPT}`]);
    refuses(() => w.engine.planContinue(old.id, 'c', { models: { zz: GPT } }), /has no step “zz” — its step ids: a, b, c/);
    refuses(() => w.engine.planContinue(old.id, 'c', { models: { c: 'gpt' } }), /models\.c must be a model id/);
    w.dispose();
  });

  test('a kept step on a model signed out of: fine unless a review loop can reach it', async () => {
    const w = makeCWorld({ available: [OPUS, GPT] });
    const old = await ended(w, [step('a'), step('b', { model: GPT }), step('c', { model: GPT })]);
    const looping = await ended(w, [step('a'), step('b', { model: GPT }), step('r', { model: GPT, kind: 'review', loopBackTo: 'a', maxLoops: 1 })]);
    w.available.splice(w.available.indexOf(OPUS), 1); // Opus is signed out of
    const run = await w.engine.continueFrom(old.id, 'c', user);
    expect((await w.end(run.id)).status).toBe('completed');
    refuses(() => w.engine.planContinue(looping.id, 'r'), /^Not connected: A uses L\(anthropic\/claude-opus-5-5\)/);
    expect(w.engine.planContinue(looping.id, 'r', { models: { a: GPT } }).startIndex).toBe(2);
    refuses(() => w.engine.planContinue(old.id, 'a'), /Not connected: A uses/);
    w.dispose();
  });
});

describe('E9 people', () => {
  test("the job's own team, unchanged → its standing people; other models → temporary people", async () => {
    const w = makeCWorld();
    w.workflows.save(w.projectId, { id: 'tw', name: 'TW', description: '', icon: '🧪', steps: abc() });
    w.jobs.update(w.projectId, 'main', { workflowId: 'tw' });
    const run = await w.startSaved('tw');
    const old = await w.end(run.id);
    await w.settled(run.id);
    expect(old.team!.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    const plan = w.engine.planContinue(old.id, 'c');
    expect(plan.own).toBe(true);
    const r2 = await w.engine.continueFrom(old.id, 'c', user);
    const e2 = await w.end(r2.id);
    expect(e2.team!.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    expect(ids(e2)).toEqual(['a<0:done', 'b<1:done', 'c:done']);
    expect(e2.steps[0]!.agentId).toBe(w.agent('a'));
    expect(e2.adhoc).toBeUndefined();
    expect(e2.workflowId).toBe('tw');
    const r3 = await w.engine.continueFrom(old.id, 'c', { ...user, models: { c: GPT } });
    const e3 = await w.end(r3.id);
    expect(e3.team!.map((m) => m.id)).toEqual(['x-a', 'x-b', 'x-c']);
    expect(w.engine.planContinue(old.id, 'c', { models: { c: GPT } }).notes.join('\n')).toContain('Temporary people do this run');
    w.dispose();
  });

  test('the workflow edited since → temporary people with the team as it ran, and a note', async () => {
    const w = makeCWorld();
    w.workflows.save(w.projectId, { id: 'tw', name: 'TW', description: '', icon: '🧪', steps: abc() });
    w.jobs.update(w.projectId, 'main', { workflowId: 'tw' });
    const run = await w.startSaved('tw');
    await w.end(run.id);
    await w.settled(run.id);
    w.workflows.save(w.projectId, { id: 'tw', name: 'TW', description: '', icon: '🧪', steps: [step('a'), step('b', { persona: 'You are a new b.' }), step('c')] });
    const plan = w.engine.planContinue(run.id, 'c');
    expect(plan.own).toBe(false);
    expect(plan.team[1]!.persona).toBe('You are b.'); // as it ran
    expect(plan.notes.join('\n')).toContain("The job's team changed since that run, so temporary people do this run");
    const r2 = await w.engine.continueFrom(run.id, 'c', user);
    const e2 = await w.end(r2.id);
    expect(e2.team!.map((m) => m.id)).toEqual(['x-a', 'x-b', 'x-c']);
    // another team for the job since: also temporary
    w.workflows.save(w.projectId, { id: 'tw', name: 'TW', description: '', icon: '🧪', steps: abc() });
    expect(w.engine.planContinue(run.id, 'c').own).toBe(true);
    w.jobs.update(w.projectId, 'main', { workflowId: null });
    expect(w.engine.planContinue(run.id, 'c').own).toBe(false);
    // other runs of the job since are noted
    expect(plan.notes.join('\n')).not.toContain('ran in this job');
    expect(w.engine.planContinue(run.id, 'c').notes.join('\n')).toContain('Since that run, “TW” ran in this job — the files include its changes.');
    w.dispose();
  });
});

describe('E10 persistence', () => {
  test('run.json while running; after a crash it loads as stopped at its last step and continues', async () => {
    const w = makeCWorld();
    w.behave.set('b', () => 'hold');
    const run = await w.start(abc());
    await w.until(() => w.promptsOf('b').length, 3000, 'b prompted');
    await sleep(20);
    const file = join(w.runDir(run.id), 'run.json');
    const saved = JSON.parse(readFileSync(file, 'utf8')) as WorkflowRun;
    expect(saved.status).toBe('running');
    expect(saved.steps.map((s) => `${s.stepId}:${s.status}`)).toEqual(['x-a:done']);
    // "crash": the server is gone with run.json as it was mid-run (no end, no undo.json)
    const snapshot = readFileSync(file, 'utf8');
    await w.engine.abort(run.id);
    await w.settled(run.id);
    writeFileSync(file, snapshot);
    rmSync(join(w.runDir(run.id), 'undo.json'), { force: true });
    w.behave.delete('b');
    const e2 = w.restart();
    const loaded = e2.get(run.id)!;
    expect(loaded.status).toBe('aborted');
    expect(loaded.endedAt).toBe(saved.steps[0]!.endedAt!);
    expect(loaded.currentStepIds).toEqual([]);
    const cont = await e2.continueFrom(run.id, 'b', user);
    const end = await w.end(cont.id);
    expect(ids(end)).toEqual(['x-a<0:done', 'x-b:done', 'x-c:done']);
    w.dispose();
  });

  test('a continuation that dies before any step of its own ended: ended when it started, not when its kept steps did', async () => {
    const w = makeCWorld();
    const old = await ended(w);
    w.behave.set('c', () => 'hold');
    const run = await w.engine.continueFrom(old.id, 'c', user);
    await w.until(() => w.promptsOf('c', run.id).length, 3000, 'c');
    await sleep(20);
    const file = join(w.runDir(run.id), 'run.json');
    const snapshot = readFileSync(file, 'utf8');
    expect((JSON.parse(snapshot) as WorkflowRun).steps.map((s) => `${s.stepId}${s.reused ? '*' : ''}`)).toEqual(['x-a*', 'x-b*']);
    await w.engine.abort(run.id);
    await w.settled(run.id);
    writeFileSync(file, snapshot);
    w.behave.delete('c');
    const loaded = w.restart().get(run.id)!;
    expect(loaded.status).toBe('aborted');
    expect(loaded.endedAt).toBe(loaded.startedAt);
    expect(loaded.continues).toEqual({ runId: old.id, stepId: 'x-c' });
    const again = await w.engine.continueFrom(run.id, 'c', user);
    const end = await w.end(again.id);
    expect(ids(end)).toEqual(['x-a<0:done', 'x-b<1:done', 'x-c:done']);
    expect(end.steps[0]!.reused!.runId).toBe(run.id);
    w.dispose();
  });

  test('a run.json saved while a step was running loads that step as failed (continue from it)', async () => {
    const w = makeCWorld();
    w.behave.set('c', () => 'hold');
    const run = await w.start([step('a'), step('b'), step('c', { parallel: true }), step('d')]);
    await w.until(() => w.promptsOf('c').length && w.engine.get(run.id)!.steps.find((s) => s.stepId === 'x-b')?.status === 'done', 3000, 'b done');
    await sleep(20);
    const file = join(w.runDir(run.id), 'run.json');
    // only whole groups are saved: b is done but its group isn't — the file still has a only
    expect((JSON.parse(readFileSync(file, 'utf8')) as WorkflowRun).steps.map((s) => s.stepId)).toEqual(['x-a']);
    w.dispose();
  });
});

describe('E11 the run dir', () => {
  test('hand-off files copied, own records and step replies not, kept replies renumbered, a checkpoint, no revert', async () => {
    const w = makeCWorld();
    w.behave.set('a', (t) => {
      const dir = join(w.projectPath, t.match(/Dir (\.rlt\/runs\/run-\w+)/)![1]!);
      writeFileSync(join(dir, 'analysis.md'), 'the plan');
      mkdirSync(join(dir, 'sub'), { recursive: true });
      writeFileSync(join(dir, 'sub', 'x.md'), 'nested');
      symlinkSync('/etc/hostname', join(dir, 'link.md'));
      return 'a done';
    });
    let n = 0;
    w.behave.set('r', () => (++n === 1 ? revise('again') : approve()));
    w.behave.set('b', (_t, k) => `b round ${k}`);
    const old = await ended(w, [step('a'), step('b'), step('r', { kind: 'review', loopBackTo: 'b', maxLoops: 2 }), step('d')]);
    expect(readdirSync(w.runDir(old.id)).sort()).toEqual(['01-a.md', '02-b.md', '03-r.md', '04-b.md', '05-r.md', '06-d.md', 'analysis.md', 'link.md', 'run.json', 'sub', 'task.md', 'team.json', 'undo.json']);
    const plan = w.engine.planContinue(old.id, 'd');
    expect(plan.kept.map((k) => `${k.step.id}@${k.index}:${k.file}`)).toEqual([`a@0:.rlt/runs/${old.id}/01-a.md`, `b@3:.rlt/runs/${old.id}/04-b.md`, `r@4:.rlt/runs/${old.id}/05-r.md`]);
    expect(plan.handoff).toEqual(['analysis.md', 'sub/x.md']);
    expect(plan.notes.join('\n')).toContain('1 hand-off file of that run was not copied');
    w.checkpoints.length = 0;
    const run = await w.engine.continueFrom(old.id, 'd', user);
    const end = await w.end(run.id);
    await w.settled(run.id);
    const dir = w.runDir(run.id);
    expect(readdirSync(dir).sort()).toEqual(['01-a.md', '02-b.md', '03-r.md', '04-d.md', 'analysis.md', 'run.json', 'sub', 'task.md', 'team.json', 'undo.json']);
    expect(readFileSync(join(dir, '02-b.md'), 'utf8')).toBe('# B\n\nb round 2\n');
    expect(readFileSync(join(dir, '03-r.md'), 'utf8')).toContain('"verdict":"approve"');
    expect(readFileSync(join(dir, 'analysis.md'), 'utf8')).toBe('the plan');
    expect(readFileSync(join(dir, 'sub', 'x.md'), 'utf8')).toBe('nested');
    expect(JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')).id).toBe(run.id);
    expect(JSON.parse(readFileSync(join(dir, 'undo.json'), 'utf8')).end).toBe(`refs/rlt/checkpoints/${run.id}-end`);
    expect(w.promptsOf('d', run.id)[0]!.text).toContain('From R:\nChecked.');
    expect(ids(end)).toEqual(['x-a<0:done', 'x-b<3:done', 'x-r<4:approve', 'x-d:done']);
    expect(w.checkpoints).toEqual([run.id, `${run.id}-end`]);
    expect(w.undoRuns).toEqual([]);
    expect(end.checkpoint).toBe(`refs/rlt/checkpoints/${run.id}`);
    // the shortened copy when a kept reply file is gone
    rmSync(join(w.runDir(old.id), '01-a.md'));
    const p2 = w.engine.planContinue(old.id, 'd');
    expect(p2.kept[0]!.full).toBe(false);
    expect(p2.kept[0]!.text).toBe('a done');
    expect(p2.notes.join('\n')).toContain("A's full reply is gone");
    const r2 = await w.engine.continueFrom(old.id, 'd', user);
    await w.end(r2.id);
    expect(readFileSync(join(w.runDir(r2.id), '01-a.md'), 'utf8')).toBe('# A\n\na done\n');
    w.dispose();
  });
});
