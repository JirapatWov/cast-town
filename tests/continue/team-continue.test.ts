// L1–L5, L8, D1–D2: the lead's team_continue (refusals, defaults, from_step forms, the plan card, the loop guard, the
// result's first line), how it shows in the transcript, and the demo lead picking it and its from_step.
import { afterAll, describe, expect, test } from 'bun:test';
import { LEAD_TOOL_NAMES, LEAD_TOOLS } from '../../server/agents/lead-tools.ts';
import { activityForTool, toolDetail, toolTitle } from '../../server/agents/tool-display.ts';
import { classifyAsk } from '../../server/agents/demo/assistant.ts';
import { parseRunReport, pickFromStep, startedReply, teamIntent } from '../../server/agents/demo/team.ts';
import { cleanup, GPT, makeWorld, OPUS, runEnd, SONNET, type World } from '../auto/world';

afterAll(cleanup);

const STARTED = /^Started “.+” \(.+\), run (run-\w+) — continuing run (run-\w+) from /;
const runOf = (text: string) => text.match(/run (run-\w+)/)![1]!;
const ONE_OFF = [
  { name: 'Fixer', model: OPUS, persona: 'p' },
  { name: 'Checker', model: GPT, persona: 'q', kind: 'review', loopBackTo: 'Fixer' },
];

async function ownRun(w: World, task = 'Add PATCH /todos/:id/done'): Promise<string> {
  const r = await w.call('team_start', { task });
  expect(r.isError).toBeFalsy();
  const id = runOf(r.text);
  await runEnd(w, id);
  return id;
}

describe('L1 refusals', () => {
  test('no runs; another job\'s run; a run going; models shape; the engine\'s own refusals', async () => {
    const w = makeWorld();
    const none = await w.call('team_continue', { from_step: 'reviewer' });
    expect(none).toEqual({ text: 'This job has no team run to continue — start one with team_start.', isError: true });
    // a run of another job
    const other = await w.engine.start(w.projectId, 'main', 'decode-implement-review', 'Docs task', { startedBy: 'user' });
    await runEnd(w, other.id);
    w.engine.get(other.id)!.jobId = 'docs'; // as if another job had run it
    const foreign = await w.call('team_continue', { from_step: 'reviewer', run_id: other.id });
    expect(foreign.isError).toBe(true);
    expect(foreign.text).toContain('belongs to another job');
    expect((await w.call('team_continue', { from_step: 'reviewer', run_id: 'run-nope' })).text).toContain('No run “run-nope”');
    // the latest of THIS job is still none (the other job's run doesn't count)
    expect((await w.call('team_continue', { from_step: 'reviewer' })).text).toContain('no team run to continue');
    const a = await ownRun(w);
    // a run going in this job
    const going = await w.engine.start(w.projectId, 'main', 'decode-implement-review', 'Another', { startedBy: 'user' });
    const busy = await w.call('team_continue', { from_step: 'reviewer', run_id: a });
    expect(busy.isError).toBe(true);
    expect(busy.text).toMatch(/A team is already running “Decode → Implement → Review” in this job/);
    await runEnd(w, going.id);
    // models shape / format
    expect((await w.call('team_continue', { from_step: 'reviewer', run_id: a, models: ['x'] })).text).toBe('models is an object: {"<step id>": "<model id>"}.');
    expect((await w.call('team_continue', { from_step: 'reviewer', run_id: a, models: { reviewer: 'gpt' } })).text).toContain('models.reviewer must be a model id');
    // no from_step
    expect((await w.call('team_continue', { run_id: a })).text).toContain('Pass from_step');
    // planContinue's EngineError
    const unknown = await w.call('team_continue', { from_step: 'zz', run_id: a });
    expect(unknown).toEqual({ text: 'No step “zz” — this run\'s steps: decoder, implementer, reviewer.', isError: true });
    const unknownModel = await w.call('team_continue', { from_step: 'reviewer', run_id: a, models: { qa: GPT } });
    expect(unknownModel.text).toContain('has no step “qa”');
    w.dispose();
  });
});

describe('L2 defaults and from_step forms', () => {
  test('the latest run by default; from_step by id, by name and by a temporary person\'s x- id', async () => {
    const w = makeWorld();
    const a = await ownRun(w);
    const b = await w.call('team_start', { task: 'One-off', steps: ONE_OFF });
    const bId = runOf(b.text);
    await runEnd(w, bId);
    // latest = b (the one-off team): from_step by id
    const r1 = await w.call('team_continue', { from_step: 'checker' });
    expect(r1.isError).toBeFalsy();
    const [, new1, old1] = r1.text.match(STARTED)!;
    expect(old1).toBe(bId);
    const run1 = await runEnd(w, new1!);
    expect(run1.continues).toEqual({ runId: bId, stepId: 'x-checker' });
    expect(run1.steps.map((s) => `${s.stepId}${s.reused ? '*' : ''}`)).toEqual(['x-fixer*', 'x-checker']);
    // by name (any case), on an older run
    const r2 = await w.call('team_continue', { from_step: 'rEVIEWER', run_id: a });
    const [, new2, old2] = r2.text.match(STARTED)!;
    expect(old2).toBe(a);
    const run2 = await runEnd(w, new2!);
    expect(run2.team!.map((m) => m.id)).toEqual(['decoder', 'implementer', 'reviewer']); // the job's own team, unchanged
    expect(run2.startedBy).toBe('lead');
    // by x- id
    const r3 = await w.call('team_continue', { from_step: 'x-fixer', run_id: bId });
    const [, new3] = r3.text.match(STARTED)!;
    const run3 = await runEnd(w, new3!);
    expect(run3.steps.some((s) => s.reused)).toBe(false);
    expect(r3.text.split('\n')[0]).toContain('from Fixer: nothing is kept (the whole team works again)');
    w.dispose();
  });

  test('task and note go to the run; a model by x- id; the job\'s model choices are not applied', async () => {
    const w = makeWorld();
    w.jobs.update(w.projectId, 'main', { modelPrefs: [{ stepName: 'Reviewer', duty: 'Judge the uncommitted changes against the task and the plan.', model: GPT, at: 1 }] });
    const a = await ownRun(w);
    const r = await w.call('team_continue', { from_step: 'implementer', run_id: a, note: 'Use a 404 for unknown ids.', task: 'New brief', models: { 'x-implementer': SONNET } });
    expect(r.isError).toBeFalsy();
    const run = await runEnd(w, r.text.match(STARTED)![1]!);
    expect(run.task).toBe('New brief');
    expect(run.continues!.note).toBe('Use a 404 for unknown ids.');
    expect(run.team!.map((m) => `${m.id}:${m.model}`)).toEqual([`x-decoder:${OPUS}`, `x-implementer:${SONNET}`, 'x-reviewer:openai/gpt-6.1-sol']);
    expect(r.text).toContain('Implementer gets your note: “Use a 404 for unknown ids.”');
    expect(r.text).toContain('Temporary people do this run');
    const impl = w.prompts.find((p) => p.agentId.endsWith(':x-implementer'))!.text;
    expect(impl).toContain('Task: New brief');
    expect(impl).toContain('The user asked for this part to be done again — take this into account:\nUse a 404 for unknown ids.');
    w.dispose();
  });
});

describe('L3 the plan card', () => {
  test('remaining steps only, the kept names; a model change applies; a kept id is refused; cancel', async () => {
    const w = makeWorld();
    const a = await ownRun(w);
    w.gate.userMessage(w.lead);
    const pending = w.call('team_continue', { from_step: 'reviewer', run_id: a, note: 'Check the tests too.', why: 'Only the review was off.' });
    const card = await w.until(() => w.gate.pending()[0]);
    expect(card.title).toBe('Decode → Implement → Review');
    expect(card.workflowId).toBe('decode-implement-review');
    expect(card.why).toBe('Only the review was off.');
    expect(card.steps.map((s) => s.id)).toEqual(['reviewer']);
    expect(card.steps[0]!.loopBackTo).toBe('implementer');
    expect(card.continues).toEqual({ runId: a, fromStepId: 'reviewer', kept: [{ id: 'decoder', name: 'Decoder' }, { id: 'implementer', name: 'Implementer' }], note: 'Check the tests too.' });
    expect(card.task).toBe('Add PATCH /todos/:id/done');
    // a kept person isn't on the card
    let err: unknown;
    try {
      await w.gate.answer(card.id, true, { decoder: GPT });
    } catch (e) {
      err = e;
    }
    expect((err as Error).message).toBe('This plan has no person “decoder”.');
    // Run with another model for the reviewer
    await w.gate.answer(card.id, true, { reviewer: SONNET });
    const res = await pending;
    expect(res.isError).toBeFalsy();
    expect(res.text).toMatch(STARTED);
    expect(res.text).toContain('The user approved the plan and changed: Reviewer → anthropic/claude-sonnet-5-5.');
    const run = await runEnd(w, res.text.match(STARTED)![1]!);
    expect(run.team!.find((m) => m.id === 'x-reviewer')!.model).toBe(SONNET);
    expect(run.steps.map((s) => `${s.stepId}${s.reused ? '*' : ''}`)).toEqual(['x-decoder*', 'x-implementer*', 'x-reviewer']);
    // the next card: cancel
    w.gate.userMessage(w.lead);
    const p2 = w.call('team_continue', { from_step: 'implementer', run_id: a });
    const card2 = await w.until(() => w.gate.pending()[0]);
    expect(card2.steps.map((s) => s.id)).toEqual(['implementer', 'reviewer']);
    expect(card2.continues!.kept).toEqual([{ id: 'decoder', name: 'Decoder' }]);
    expect(card2.continues!.note).toBeUndefined();
    await w.gate.answer(card2.id, false, {});
    expect((await p2).text).toMatch(/^The user cancelled this plan/);
    w.dispose();
  });

  test('a one-off team\'s continuation card has no workflowId; it validates again when answered', async () => {
    const w = makeWorld();
    const b = await w.call('team_start', { task: 'One-off', steps: ONE_OFF });
    const bId = runOf(b.text);
    await runEnd(w, bId);
    w.gate.userMessage(w.lead);
    const pending = w.call('team_continue', { from_step: 'checker' });
    const card = await w.until(() => w.gate.pending()[0]);
    expect(card.workflowId).toBeUndefined();
    expect(card.title).toBe('Team for this task');
    // meanwhile another run takes the job: Run fails, the card stays
    const other = await w.engine.start(w.projectId, 'main', 'decode-implement-review', 'x', { startedBy: 'user' });
    let err: unknown;
    try {
      await w.gate.answer(card.id, true, {});
    } catch (e) {
      err = e;
    }
    expect((err as Error).message).toContain('already running');
    expect(w.gate.pending().map((p) => p.id)).toEqual([card.id]);
    await runEnd(w, other.id);
    await w.gate.answer(card.id, true, {});
    expect((await pending).text).toMatch(STARTED);
    w.dispose();
  });
});

describe('L4 the loop guard', () => {
  test('continuations count as runs (and started() hears of each)', async () => {
    const w = makeWorld();
    w.jobs.update(w.projectId, 'main', { workStyle: 'auto' });
    const a = await ownRun(w);
    w.gate.userMessage(w.lead);
    const started: string[] = [];
    const deps = { started: (runId: string, agentId: string) => void (started.push(runId), w.gate.noteRun(agentId)) };
    for (let n = 0; n < 5; n++) {
      const r = await w.call('team_continue', { from_step: 'reviewer', run_id: a }, deps);
      expect(r.isError).toBeFalsy();
      await runEnd(w, r.text.match(STARTED)![1]!);
    }
    expect(started).toHaveLength(5);
    const sixth = await w.call('team_continue', { from_step: 'reviewer', run_id: a }, deps);
    expect(sixth).toEqual({ text: "That's 5 team runs for this message — tell the user what happened and let them decide.", isError: true });
    expect((await w.call('team_start', { task: 'x' }, deps)).text).toContain("That's 5 team runs");
    w.dispose();
  });
});

describe('L5 the result', () => {
  test('first line keeps startedText\'s shape; then models and notes', async () => {
    const w = makeWorld();
    const a = await ownRun(w);
    const r = await w.call('team_continue', { from_step: 'implementer', run_id: a });
    const lines = r.text.split('\n');
    const m = lines[0]!.match(STARTED)!;
    expect(m[2]).toBe(a);
    expect(lines[0]).toBe(
      `Started “Decode → Implement → Review” (Implementer → Reviewer), run ${m[1]} — continuing run ${a} from Implementer: Decoder keeps its result, and the files stay as that run left them. ` +
        `It works in the background — you are free to keep talking with the user. Check on it with team_status; you'll get a "[RLT team update]" message when it ends. Each step's output goes to .rlt/runs/${m[1]}/.`,
    );
    expect(lines[1]).toBe('Models: Implementer on deepseek/deepseek-v4-pro, Reviewer on openai/gpt-6.1-sol.');
    await runEnd(w, m[1]!);
    // the demo reads it
    expect(startedReply(r.text, false)).toBe("The team is on it — continuing from Implementer; Decoder keeps its result. I'm free meanwhile; ask me anything, or ask how the team is doing.");
    expect(startedReply(r.text, true)).toBe('ทีมทำต่อจาก Implementer ค่ะ — Decoder ใช้ผลเดิม ระหว่างนี้ถามอะไรก็ได้นะคะ หรือถามว่าทีมถึงไหนแล้วก็ได้ค่ะ');
    const r2 = await w.call('team_continue', { from_step: 'reviewer', run_id: a });
    expect(r2.text.split('\n')[0]).toContain(`from Reviewer: Decoder → Implementer keep their results, and the files stay`);
    expect(startedReply(r2.text, false)).toContain('continuing from Reviewer; Decoder → Implementer keep their results.');
    await runEnd(w, r2.text.match(STARTED)![1]!);
    // an error still reads as one
    const bad = await w.call('team_continue', { from_step: 'zz', run_id: a });
    expect(startedReply(bad.text, false)).toBe("I couldn't start the team: No step “zz” — this run's steps: decoder, implementer, reviewer.");
    w.dispose();
  });
});

describe('L8 tool display and the tool defs', () => {
  test('titles, activity, status; the defs', () => {
    expect(toolTitle('team_continue', { from_step: 'reviewer' })).toBe('continue “latest” from reviewer');
    expect(toolTitle('team_continue', { from_step: 'implementer', run_id: 'run-abc' })).toBe('continue “run-abc” from implementer');
    expect(toolTitle('team_status', {})).toBe('check on the team');
    expect(toolTitle('team_status', { run_id: 'run-abc' })).toBe('check on run “run-abc”');
    expect(activityForTool('team_continue')).toBe('delegating');
    expect(toolDetail('team_continue', {})).toBe('Continuing the team');
    expect(LEAD_TOOL_NAMES.has('team_continue')).toBe(true);
    const def = LEAD_TOOLS.find((t) => t.name === 'team_continue')!;
    expect(LEAD_TOOLS.map((t) => t.name).slice(0, 4)).toEqual(['team_start', 'team_continue', 'team_edit', 'team_status']); // team_edit: a running team's next steps
    expect((def.parameters as { required: string[] }).required).toEqual(['from_step']);
    expect(Object.keys((def.parameters as { properties: object }).properties)).toEqual(['from_step', 'run_id', 'note', 'task', 'models', 'why']);
    expect(def.description).toContain('แก้เฉพาะท่อนหลัง');
    expect(LEAD_TOOLS.find((t) => t.name === 'team_start')!.description).toContain('To redo only a later part of a run that ended, use team_continue — team_start always starts from the first step.');
    expect(Object.keys((LEAD_TOOLS.find((t) => t.name === 'team_status')!.parameters as { properties: object }).properties)).toEqual(['run_id', 'plan', 'step']);
  });
});

describe('D1 the demo lead: which asks are a continuation', () => {
  const tools = new Set(LEAD_TOOL_NAMES);
  test('continue asks, team asks, plain changes', () => {
    for (const ask of [
      'แก้เฉพาะท่อนหลัง ให้ reviewer ตรวจใหม่',
      'just redo the review',
      'fix only the last part',
      'redo only the reviewer step please',
      'carry on from the implementer',
      'run it again from the reviewer step on',
      'ทำต่อจาก reviewer',
      'รันใหม่แค่ขั้น review',
      'แก้แค่ขั้นสุดท้าย',
    ]) {
      expect({ ask, intent: classifyAsk(ask, tools) }).toEqual({ ask, intent: 'team-continue' });
    }
    expect(classifyAsk('ให้ทีมเพิ่ม PATCH /todos/:id/done', tools)).toBe('team-run');
    expect(classifyAsk('have the team add input validation', tools)).toBe('team-run');
    expect(classifyAsk('fix just the typo in README.md', tools)).toBe('change');
    expect(classifyAsk('แก้แค่คำผิดใน README', tools)).toBe('change');
    expect(classifyAsk('how is the team doing?', tools)).toBe('team-status');
    expect(classifyAsk('stop the team', tools)).toBe('team-stop');
    // without the tool (not a lead): never
    expect(teamIntent('just redo the review', new Set(['team_start']))).toBeNull();
  });
});

describe('D2 the demo lead: which step', () => {
  const report = (lines: string[]) => parseRunReport(['“X” — failed, 1 min, $0.10.', 'Task: T', 'Run run-abc.', 'Steps:', ...lines].join('\n'));
  const done = report(['- Decoder: done [decoder]', '- Implementer: done [implementer]', '- Reviewer: done (approve) [reviewer]']);
  test('a named step; a review; the later / last part; the first that didn\'t finish', () => {
    expect(done.steps.map((s) => `${s.name}|${s.id}|${s.state}`)).toEqual(['Decoder|decoder|done', 'Implementer|implementer|done', 'Reviewer|reviewer|done (approve)']);
    expect(done.runId).toBe('run-abc');
    expect(pickFromStep(done.steps, 'แก้เฉพาะท่อนหลัง ให้ reviewer ตรวจใหม่')).toMatchObject({ id: 'reviewer' });
    expect(pickFromStep(done.steps, 'redo only the Implementer and the reviewer')).toMatchObject({ id: 'implementer' });
    expect(pickFromStep(done.steps, 'just redo the review')).toMatchObject({ id: 'reviewer' });
    expect(pickFromStep(done.steps, 'fix only the last part')).toMatchObject({ id: 'reviewer' });
    expect(pickFromStep(done.steps, 'แก้แค่ส่วนท้าย')).toMatchObject({ id: 'reviewer' });
    const failed = report(['- Decoder: done [decoder]', '- Implementer: failed [implementer]', '- Reviewer: skipped [reviewer]']);
    expect(pickFromStep(failed.steps, 'carry on from where it stopped')).toMatchObject({ id: 'implementer' });
    const thai = report(['- นักวิจัย: done [step-1]', '- นักเขียน (at the same time as the one before): done [step-2]', '- บรรณาธิการ: done (revise) [step-3]']);
    expect(thai.steps[1]).toEqual({ name: 'นักเขียน', state: 'done', parallel: true, id: 'step-2' });
    expect(pickFromStep(thai.steps, 'ทำต่อจากนักเขียน')).toMatchObject({ id: 'step-2' });
    // a step called "A" isn't found in every word that has an "a"
    const letters = report(['- A: done [a]', '- B: done [b]', '- C: failed [c]']);
    expect(pickFromStep(letters.steps, 'carry on from a stopped run please')).toMatchObject({ id: 'a' }); // "a" as a word is named
    expect(pickFromStep(letters.steps, 'carry on, it stopped')).toMatchObject({ id: 'c' });
  });
});
