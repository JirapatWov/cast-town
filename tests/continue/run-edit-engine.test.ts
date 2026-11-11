// R1–R10: changing a going run in the WorkflowEngine (planOf / editRun) — it keeps going: the steps that haven't
// started take the new plan, the people who finished keep their results and the person working now is never asked
// again; the change is kept with the run (run.team, team.json, run.json) and survives a restart; review loops use the
// changed steps; parallel groups; notes; the saved workflow is never touched.
import { afterAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EngineError, type RunEditInput } from '../../server/agents/workflow-engine.ts';
import { VERDICT_FOOTER } from '../../server/agents/templates.ts';
import type { WorkflowRun, WorkflowStep } from '../../shared/protocol.ts';
import { approve, cleanup, GPT, makeCWorld, OPUS, revise, step, type CWorld } from './cworld';

afterAll(cleanup);

const abc = () => [step('a'), step('b'), step('c')];
const user = { startedBy: 'user' as const };
const edit = (steps: WorkflowStep[], over: Partial<RunEditInput> = {}): RunEditInput => ({ by: 'user', steps, changes: ['test'], ...over });

/** The job's own team "tw" = steps, started as the job's team (standing people). */
async function ownRun(w: CWorld, steps: WorkflowStep[] = abc()): Promise<WorkflowRun> {
  w.workflows.save(w.projectId, { id: 'tw', name: 'TW', description: '', icon: '🧪', steps });
  w.jobs.update(w.projectId, 'main', { workflowId: 'tw' });
  return w.startSaved('tw');
}

/** Hold this step's first prompt open until release() is called. */
function hold(w: CWorld, id: string, answer = `${id} done`) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  w.behave.set(id, async (_t, n) => {
    if (n === 1) await gate;
    return answer;
  });
  return () => release();
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

describe('R1 change a step that has not started while the one before works', () => {
  test("a→b→c, b working: c's new instruction is used; a and b asked once; run.team, team.json, run.edits; the saved workflow unchanged", async () => {
    const w = makeCWorld();
    const release = hold(w, 'b');
    const run = await ownRun(w);
    const savedBefore = JSON.stringify(w.workflows.get(w.projectId, 'tw'));
    expect(savedBefore).toContain('"id":"tw"'); // the house's own workflow (not undefined === undefined)
    await w.until(() => w.promptsOf('b').length === 1, 3000, 'b asked');
    const view = w.engine.planOf(run.id);
    expect(view).toMatchObject({ runId: run.id, rev: 0, own: true, done: 1, frozen: 2, states: { a: 'done', b: 'working', c: 'next' } });
    expect(view.steps.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    const next = structuredClone(view.steps);
    next[2]!.instruction = 'NEW C: {{prev}}';
    const res = w.engine.editRun(run.id, edit(next, { changes: ['C: instruction'] }));
    expect(res.run.status).toBe('running');
    expect(res.run.team!.map((m) => [m.id, m.edited ?? false])).toEqual([['a', false], ['b', false], ['c', true]]);
    expect(res.run.planRev).toBe(1);
    expect(res.run.edits).toEqual([{ at: expect.any(Number), by: 'user', changes: ['C: instruction'] }]);
    const team = JSON.parse(readFileSync(join(w.runDir(run.id), 'team.json'), 'utf8')) as WorkflowStep[];
    expect(team[2]!.instruction).toBe('NEW C: {{prev}}');
    const saved = JSON.parse(readFileSync(join(w.runDir(run.id), 'run.json'), 'utf8')) as WorkflowRun;
    expect(saved.edits).toHaveLength(1);
    expect(w.ensured.at(-1)).toBe(w.agent('c')); // c takes the new version now
    release();
    const end = await w.end(run.id);
    expect(end.status).toBe('completed');
    expect(w.promptsOf('a').length).toBe(1);
    expect(w.promptsOf('b').length).toBe(1); // never restarted
    expect(w.promptsOf('c').map((a) => a.text)).toEqual(['NEW C: b done']);
    expect(JSON.stringify(w.workflows.get(w.projectId, 'tw'))).toBe(savedBefore); // saved definition untouched
    expect(end.steps.map((s) => `${s.stepId}:${s.status}`)).toEqual(['a:done', 'b:done', 'c:done']);
    w.dispose();
  });
});

describe('R2 add and remove', () => {
  test('add d after b and e at the end: prompts go a, b, d, c, e; d moves in at once', async () => {
    const w = makeCWorld();
    const release = hold(w, 'b');
    const run = await ownRun(w);
    await w.until(() => w.promptsOf('b').length === 1, 3000, 'b asked');
    const v = w.engine.planOf(run.id);
    const next = [v.steps[0]!, v.steps[1]!, step('d'), v.steps[2]!, step('e')];
    const before = w.ensured.length;
    w.engine.editRun(run.id, edit(next));
    expect(w.ensured.slice(before)).toEqual([w.agent('d'), w.agent('e')]);
    release();
    await w.end(run.id);
    expect(w.asked.map((a) => a.step)).toEqual(['a', 'b', 'd', 'c', 'e']);
    expect(w.promptsOf('c')[0]!.text).toContain('From D:\nd done');
    w.dispose();
  });

  test("a temporary team: the added person has an x- id and leaves with the run; a removed one who never worked leaves now", async () => {
    const w = makeCWorld();
    const release = hold(w, 'b');
    const run = await w.start(abc());
    await w.until(() => w.promptsOf('b').length === 1, 3000, 'b asked');
    const v = w.engine.planOf(run.id);
    expect(v.own).toBe(false);
    expect(v.steps.map((s) => s.id)).toEqual(['a', 'b', 'c']); // as written
    const r = w.engine.editRun(run.id, edit([v.steps[0]!, v.steps[1]!, step('d')]));
    expect(r.run.team!.map((m) => m.id)).toEqual(['x-a', 'x-b', 'x-d']);
    expect(w.left).toHaveLength(1); // c (never worked) goes home now
    release();
    const end = await w.end(run.id);
    expect(end.steps.map((s) => s.stepId)).toEqual(['x-a', 'x-b', 'x-d']);
    await w.settled(run.id);
    await w.until(() => w.left.length === 2, 9000, 'people leave');
    w.dispose();
  }, 15_000);
});

describe('R3 refusals', () => {
  test('an ended run; a frozen step; joining the group working now; more than 12; a model not connected — the plan unchanged after each', async () => {
    const w = makeCWorld({ available: [OPUS] });
    const release = hold(w, 'b');
    const run = await ownRun(w);
    await w.until(() => w.promptsOf('b').length === 1, 3000, 'b asked');
    const v = w.engine.planOf(run.id);
    const same = () => expect(w.engine.planOf(run.id).steps).toEqual(v.steps);
    const changedA = structuredClone(v.steps);
    changedA[0]!.persona = 'other';
    refuses(() => w.engine.editRun(run.id, edit(changedA)), /^“A” already finished in this run — it keeps its result\.$/);
    same();
    const changedB = structuredClone(v.steps);
    changedB[1]!.model = GPT;
    refuses(() => w.engine.editRun(run.id, edit(changedB)), /^“B” started meanwhile — it works with the version it had; send them a note instead\.$/);
    same();
    refuses(() => w.engine.editRun(run.id, edit([v.steps[0]!, v.steps[1]!, { ...v.steps[2]!, parallel: true }])), /can't join the group working now \(B\)/);
    same();
    refuses(() => w.engine.editRun(run.id, edit([...v.steps, ...Array.from({ length: 10 }, (_, k) => step(`p${k}`))])), /at most 12 steps/);
    same();
    refuses(() => w.engine.editRun(run.id, edit([v.steps[0]!, v.steps[1]!, { ...v.steps[2]!, model: GPT }])), /^Not connected: C uses L\(openai\/gpt-6\.1-sol\)/);
    same();
    refuses(() => w.engine.editRun(run.id, edit([v.steps[0]!, v.steps[1]!, { ...v.steps[2]!, id: 'x-c' }])), /can't have the step id/);
    // dryRun: only checks
    const ok = [v.steps[0]!, v.steps[1]!, { ...v.steps[2]!, persona: 'dry' }];
    w.engine.editRun(run.id, edit(ok), { dryRun: true });
    same();
    expect(w.engine.get(run.id)!.planRev).toBeUndefined();
    release();
    await w.end(run.id);
    refuses(() => w.engine.editRun(run.id, edit(ok)), /That run has ended/);
    refuses(() => w.engine.planOf(run.id), /That run has ended/);
    refuses(() => w.engine.planOf('run-nope'), /No run “run-nope”/);
    w.dispose();
  });
});

describe('R4 a step that starts meanwhile', () => {
  test('an edit to c is accepted while b works; once c works a second edit to it is refused, the step after it still changes', async () => {
    const w = makeCWorld();
    const rb = hold(w, 'b');
    const rc = hold(w, 'c');
    const run = await ownRun(w, [step('a'), step('b'), step('c'), step('d')]);
    await w.until(() => w.promptsOf('b').length === 1, 3000, 'b asked');
    const v1 = w.engine.planOf(run.id);
    const n1 = structuredClone(v1.steps);
    n1[2]!.persona = 'c v2';
    w.engine.editRun(run.id, edit(n1));
    rb();
    await w.until(() => w.promptsOf('c').length === 1, 3000, 'c asked');
    const n2 = structuredClone(n1);
    n2[2]!.persona = 'c v3';
    refuses(() => w.engine.editRun(run.id, edit(n2)), /“C” started meanwhile/);
    const n3 = structuredClone(n1);
    n3[3]!.instruction = 'D NEW {{prev}}';
    w.engine.editRun(run.id, edit(n3));
    rc();
    await w.end(run.id);
    expect(w.promptsOf('d')[0]!.text).toBe('D NEW c done');
    w.dispose();
  });
});

describe('R5 review loops use the changed steps', () => {
  test('a→b→c→r (back to c): c changed while b works; r says revise; c runs twice, both times changed', async () => {
    const w = makeCWorld();
    const rb = hold(w, 'b');
    w.behave.set('r', (_t, n) => (n === 1 ? revise('more') : approve()));
    const run = await ownRun(w, [step('a'), step('b'), step('c'), step('r', { kind: 'review', loopBackTo: 'c', maxLoops: 2, instruction: `R {{prev}}\n${VERDICT_FOOTER}` })]);
    await w.until(() => w.promptsOf('b').length === 1, 3000, 'b asked');
    const n = structuredClone(w.engine.planOf(run.id).steps);
    n[2]!.instruction = 'C2 {{prev}}{{feedback}}';
    w.engine.editRun(run.id, edit(n));
    rb();
    const end = await w.end(run.id);
    expect(end.status).toBe('completed');
    const cs = w.promptsOf('c').map((a) => a.text);
    expect(cs).toHaveLength(2);
    expect(cs[0]).toBe('C2 b done');
    expect(cs[1]).toStartWith('C2 Not yet.');
    expect(cs[1]).toContain('asked for changes — address every point:\nmore');
    w.dispose();
  });

  test('r loops back to a: in round 2, while a works, b (with an earlier attempt) can change and its new version is used', async () => {
    const w = makeCWorld();
    let releaseA2!: () => void;
    const a2 = new Promise<void>((r) => (releaseA2 = r));
    w.behave.set('a', async (_t, n) => {
      if (n === 2) await a2;
      return 'a done';
    });
    w.behave.set('r', (_t, n) => (n === 1 ? revise('again') : approve()));
    const run = await ownRun(w, [step('a'), step('b'), step('r', { kind: 'review', loopBackTo: 'a', instruction: `R\n${VERDICT_FOOTER}` })]);
    await w.until(() => w.promptsOf('a').length === 2, 3000, 'a asked again');
    const v = w.engine.planOf(run.id);
    expect(v.states).toEqual({ a: 'working', b: 'next', r: 'next' });
    const n = structuredClone(v.steps);
    n[1]!.instruction = 'B ROUND 2 {{prev}}';
    w.engine.editRun(run.id, edit(n));
    releaseA2();
    await w.end(run.id);
    const bs = w.promptsOf('b').map((a) => a.text);
    expect(bs).toHaveLength(2);
    expect(bs[0]).toStartWith('Task: Do the thing\nFrom A');
    expect(bs[1]).toBe('B ROUND 2 a done');
    w.dispose();
  });
});

describe('R6 parallel groups', () => {
  test('a → [b1 + b2] → c, b1 done and b2 working: b1 refused, a note to b2 steers, c changes, adding after b1 lands after b2', async () => {
    const w = makeCWorld();
    const rb2 = hold(w, 'b2');
    const run = await ownRun(w, [step('a'), step('b1'), step('b2', { parallel: true }), step('c')]);
    await w.until(() => w.promptsOf('b1')[0]?.outcome && w.promptsOf('b2').length === 1, 3000, 'b1 done, b2 working');
    const v = w.engine.planOf(run.id);
    expect(v.states).toEqual({ a: 'done', b1: 'finished', b2: 'working', c: 'next' });
    const nb1 = structuredClone(v.steps);
    nb1[1]!.persona = 'x';
    refuses(() => w.engine.editRun(run.id, edit(nb1)), /“B1” started meanwhile/);
    refuses(() => w.engine.editRun(run.id, edit(v.steps, { notes: [{ stepId: 'b1', text: 'hi' }] })), /“B1” already finished their step/);
    const r = w.engine.editRun(run.id, edit([...v.steps.slice(0, 3), step('d'), { ...v.steps[3]!, persona: 'c2' }], { notes: [{ stepId: 'b2', text: 'Mind the tests' }] }));
    expect(r.delivered).toEqual([{ stepId: 'b2', name: 'B2', how: 'steered' }]);
    expect(w.steered).toEqual([
      {
        agentId: w.agent('b2'),
        step: 'b2',
        text: "Note from the user for your current step:\nMind the tests\n\nKeep going with your step — your final reply is still your step's report.",
        shown: 'Note for this step: Mind the tests',
        key: 'k1',
      },
    ]);
    rb2();
    await w.end(run.id);
    expect(w.asked.map((a) => a.step)).toEqual(['a', 'b1', 'b2', 'd', 'c']);
    expect(w.withdrawn).toEqual(['k1']); // asked back at b2's end (the fake had already read it)
    w.dispose();
  });
});

describe('R7 notes for a step that is about to start', () => {
  // (before the group is asked: the run is still taking its checkpoint, or waits for someone busy)
  test("planOf says 'starting' before the group is asked; a note then goes with the prompt", async () => {
    const w = makeCWorld();
    w.workflows.save(w.projectId, { id: 'tw', name: 'TW', description: '', icon: '🧪', steps: [step('r', { kind: 'review', instruction: `Review\n\n${VERDICT_FOOTER}` })] });
    w.jobs.update(w.projectId, 'main', { workflowId: 'tw' });
    // the checkpoint is awaited before the first group is asked: edit right after start
    const run = await w.startSaved('tw');
    const v = w.engine.planOf(run.id);
    expect(v.states).toEqual({ r: 'starting' });
    const r = w.engine.editRun(run.id, edit(v.steps, { notes: [{ stepId: 'r', text: 'Check the dates' }] }));
    expect(r.delivered).toEqual([{ stepId: 'r', name: 'R', how: 'prompt' }]);
    await w.end(run.id);
    expect(w.promptsOf('r')[0]!.text).toBe(`Review\n\nNote from the user for this step:\nCheck the dates\n\n${VERDICT_FOOTER}`);
    w.dispose();
  });
});

describe('R8 restart', () => {
  test('edit, restart: the run is interrupted, teamOf is the changed plan; continuing from b runs the changed c, temporary people, with a note', async () => {
    const w = makeCWorld();
    hold(w, 'b'); // never released: the server "stops" mid-run
    const run = await ownRun(w);
    await w.until(() => w.promptsOf('b').length === 1, 3000, 'b asked');
    const n = structuredClone(w.engine.planOf(run.id).steps);
    n[2]!.instruction = 'C AFTER RESTART {{prev}}';
    w.engine.editRun(run.id, edit(n));
    const e2 = w.restart();
    const back = e2.get(run.id)!;
    expect(back.status).toBe('aborted');
    expect(back.interrupted).toBe(true);
    expect(back.team!.map((m) => [m.id, m.edited ?? false])).toEqual([['a', false], ['b', false], ['c', true]]);
    expect(back.edits).toHaveLength(1);
    expect(e2.teamOf(run.id)![2]!.instruction).toBe('C AFTER RESTART {{prev}}');
    w.behave.set('b', () => 'b again');
    const plan = e2.planContinue(run.id, 'b');
    expect(plan.own).toBe(false);
    expect(plan.notes.join('\n')).toContain("This run's team was changed while it ran, so temporary people do this run, with the team as it ran.");
    const r2 = await e2.continueFrom(run.id, 'b', user);
    await w.end(r2.id);
    expect(w.promptsOf('c').at(-1)!.text).toBe('C AFTER RESTART b again');
    w.dispose();
  });
});

describe('R9 continuing with another team', () => {
  test("continueFrom(run, 'b', { team }) keeps a and uses the changes; a team whose kept steps differ is refused", async () => {
    const w = makeCWorld();
    const run = await w.start(abc());
    await w.end(run.id);
    await w.settled(run.id);
    const team = abc();
    team[1]!.instruction = 'B CHANGED {{prev}}';
    team.push(step('d'));
    const before = w.asked.length;
    const r2 = await w.engine.continueFrom(run.id, 'b', { ...user, team });
    const end = await w.end(r2.id);
    expect(w.asked.slice(before).map((a) => a.step)).toEqual(['b', 'c', 'd']);
    expect(w.asked[before]!.text).toStartWith('B CHANGED a done');
    expect(end.steps[0]!.reused).toBeTruthy();
    const bad = abc();
    bad[0]!.persona = 'changed a';
    refuses(() => w.engine.planContinue(run.id, 'b', { team: bad }), /The steps before “B” must stay as they ran/);
    refuses(() => w.engine.planContinue(run.id, 'b', { team: [step('a'), { ...step('b'), id: 'x-b' }] }), /plain step ids/);
    w.dispose();
  });

  test('live: a going run can be planned (its finished steps are kept), not continued', async () => {
    const w = makeCWorld();
    const rb = hold(w, 'b');
    const run = await w.start(abc());
    await w.until(() => w.promptsOf('b').length === 1, 3000, 'b asked');
    refuses(() => w.engine.planContinue(run.id, 'b'), /is still running/);
    const plan = w.engine.planContinue(run.id, 'b', { live: true });
    expect(plan.kept.map((k) => k.step.id)).toEqual(['a']);
    rb();
    await w.end(run.id);
    w.dispose();
  });
});

describe('R10 the saved workflow is never the run\'s array', () => {
  test('after an own-team run with edits (and of the house’s copy of an old example team), the stored workflows are byte-identical', async () => {
    const w = makeCWorld();
    const rb = hold(w, 'b');
    const run = await ownRun(w);
    const before = JSON.stringify(w.workflows.get(w.projectId, 'tw'));
    expect(before).toContain('"id":"tw"');
    const file = readFileSync(w.workflows.file, 'utf8');
    await w.until(() => w.promptsOf('b').length === 1, 3000, 'b asked');
    const v = w.engine.planOf(run.id);
    w.engine.editRun(run.id, edit([v.steps[0]!, v.steps[1]!, { ...v.steps[2]!, persona: 'mutated?' }, step('d')]));
    rb();
    await w.end(run.id);
    expect(JSON.stringify(w.workflows.get(w.projectId, 'tw'))).toBe(before);
    expect(readFileSync(w.workflows.file, 'utf8')).toBe(file);
    // the house's copy of the old novel team as the job's team (stored in workflows.json like any of its workflows)
    const novel = JSON.stringify(w.workflows.get(w.projectId, 'novel'));
    expect(novel).toContain('"id":"novel"');
    expect(novel).not.toContain('"builtin"');
    const file2 = readFileSync(w.workflows.file, 'utf8');
    expect(file2).toContain('"id": "novel"');
    w.jobs.update(w.projectId, 'main', { workflowId: 'novel' });
    const rw = hold(w, 'writer');
    const r2 = await w.startSaved('novel');
    await w.until(() => w.promptsOf('writer').length === 1, 3000, 'writer asked');
    const v2 = w.engine.planOf(r2.id);
    w.engine.editRun(r2.id, edit([v2.steps[0]!, v2.steps[1]!, { ...v2.steps[2]!, instruction: `Polish.\n${VERDICT_FOOTER}` }]));
    rw();
    await w.end(r2.id);
    expect(JSON.stringify(w.workflows.get(w.projectId, 'novel'))).toBe(novel);
    expect(readFileSync(w.workflows.file, 'utf8')).toBe(file2);
    w.dispose();
  });
});

describe('R11 a continuation changed while it runs', () => {
  test("its start step is found by id: a loop back to a kept step, a step between removed — the note still reaches it", async () => {
    const w = makeCWorld();
    const team = [step('a'), step('b'), step('c'), step('r', { kind: 'review', loopBackTo: 'a', instruction: `R {{prev}}\n${VERDICT_FOOTER}` })];
    const first = await w.start(team);
    await w.end(first.id);
    await w.settled(first.id);
    let releaseA!: () => void;
    const gate = new Promise<void>((r) => (releaseA = r));
    w.behave.set('a', async () => {
      await gate;
      return 'a again';
    });
    w.behave.set('r', (_t, n) => (n === 2 ? revise('from the top') : approve()));
    const before = w.asked.length;
    const run = await w.engine.continueFrom(first.id, 'c', { ...user, note: 'THE NOTE' });
    // before anything is asked the start group is frozen (it is starting)
    expect(w.engine.planOf(run.id).states).toEqual({ a: 'done', b: 'done', c: 'starting', r: 'next' });
    await w.until(() => w.asked.slice(before).some((a) => a.step === 'a'), 3000, 'back to a');
    const v = w.engine.planOf(run.id);
    expect(v.states).toEqual({ a: 'working', b: 'next', c: 'next', r: 'next' });
    w.engine.editRun(run.id, edit([v.steps[0]!, v.steps[2]!, v.steps[3]!]));
    releaseA();
    await w.end(run.id);
    const fresh = w.asked.slice(before);
    expect(fresh.map((a) => a.step)).toEqual(['c', 'r', 'a', 'c', 'r']);
    const cs = fresh.filter((a) => a.step === 'c').map((a) => a.text);
    expect(cs[0]).toContain('THE NOTE');
    expect(cs[1]).toContain('THE NOTE'); // every time the work comes back to it
    expect(fresh.filter((a) => a.step === 'r').some((a) => a.text.includes('THE NOTE'))).toBe(false);
    w.dispose();
  });
});
