// T1–T8: the lead's team_edit (a running team's later steps change, it keeps going), its refusals and redo, and how the
// other team tools point to it: team_start / team_continue / team_assign while a team runs, workflow_save of a running
// workflow, team_status plan / step, describeRun's edit lines, the persona and the tool defs.
import { afterAll, describe, expect, test } from 'bun:test';
import { describeRun, LEAD_TOOL_NAMES, LEAD_TOOLS } from '../../server/agents/lead-tools.ts';
import { leadSpec } from '../../server/agents/residents.ts';
import { activityForTool, toolDetail, toolTitle } from '../../server/agents/tool-display.ts';
import { VERDICT_FOOTER } from '../../server/agents/templates.ts';
import type { WorkflowStep } from '../../shared/protocol.ts';
import { cleanup, GPT, makeWorld, OPUS, runEnd, SONNET, type World } from './world';

afterAll(cleanup);

const runOf = (text: string) => text.match(/run (run-\w+)/)![1]!;

/** Hold the implementer's step open until the returned function is called. */
function holdImplementer(w: World): () => void {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const answer = w.answer;
  w.answer = (step, text) => (step.id === 'implementer' ? gate.then(() => 'Implementer done') : answer(step, text));
  return () => release();
}

/** The job's team (the house's copy of the old example Decode → Implement → Review) started, the implementer working. */
async function midRun(w: World): Promise<{ runId: string; release: () => void }> {
  const release = holdImplementer(w);
  const r = await w.call('team_start', { task: 'Add PATCH /todos/:id/done' });
  expect(r.isError).toBeFalsy();
  const runId = runOf(r.text);
  await w.until(() => w.prompts.some((p) => p.agentId.endsWith(':implementer')));
  return { runId, release };
}

const promptsOf = (w: World, role: string) => w.prompts.filter((p) => p.agentId.endsWith(`:${role}`)).map((p) => p.text);

describe('T1 team_edit with no run', () => {
  test('the exact text', async () => {
    const w = makeWorld();
    const r = await w.call('team_edit', { ops: [{ op: 'update', step: 'reviewer', add_to_instruction: 'x' }] });
    expect(r).toEqual({
      text: 'No team is running in this job — team_edit changes a running team. To redo part of a run that ended use team_continue; to change a saved workflow use workflow_save.',
      isError: true,
    });
    w.dispose();
  });
});

describe('T2 a change to later steps while it runs', () => {
  test("the first line, the 'This run only' line and Next; the decoder and the implementer are asked once; the reviewer gets the change", async () => {
    const w = makeWorld();
    const { runId, release } = await midRun(w);
    const r = await w.call('team_edit', {
      ops: [
        { op: 'update', step: 'reviewer', add_to_instruction: 'Check the 404 path too.' },
        { op: 'add', person: { name: 'Proofreader', model: SONNET, persona: 'Reads the docs.' } },
        { op: 'note', step: 'implementer', text: 'Use the existing router.' },
      ],
    });
    expect(r.isError).toBeFalsy();
    const lines = r.text.split('\n');
    expect(lines[0]).toBe(`Changed “Decode → Implement → Review” while it runs (run ${runId}) — it keeps going: Decoder keeps its result, Implementer keeps working (not restarted).`);
    expect(lines).toContain('- Reviewer: instruction changed (a paragraph added).');
    expect(lines).toContain(`- Added Proofreader [proofreader] after Reviewer (${SONNET}).`);
    expect(lines).toContain('- Note sent to Implementer (they read it at their next step).');
    expect(lines).toContain('Next: Reviewer → Proofreader.');
    expect(lines.at(-1)).toBe('This run only — the saved workflow is unchanged (team_edit with save: true also changes it for next time; only if the user wants that).');
    expect(w.steered.map((s) => s.shown)).toEqual(['Note for this step: Use the existing router.']);
    expect(w.engine.get(runId)!.status).toBe('running');
    release();
    const end = await runEnd(w, runId);
    expect(end.status).toBe('completed');
    expect(promptsOf(w, 'decoder')).toHaveLength(1);
    expect(promptsOf(w, 'implementer')).toHaveLength(1);
    const reviewer = promptsOf(w, 'reviewer');
    expect(reviewer).toHaveLength(1);
    expect(reviewer[0]).toContain(`Check the 404 path too.\n\n${VERDICT_FOOTER}`);
    expect(promptsOf(w, 'proofreader')).toHaveLength(1);
    expect(w.workflows.get(w.projectId, 'decode-implement-review')!.steps).toHaveLength(3); // the saved workflow as it was
    // team_status: the change shows, and the line about it
    const status = await w.call('team_status', { run_id: runId });
    expect(status.text).toContain('- Reviewer: done (approve) (changed during the run) [reviewer]');
    expect(status.text).toMatch(/Changed while it ran: \d\d:\d\d Reviewer: instruction; added Proofreader; note to Implementer \(by you\) — this run only unless it says saved\./);
    w.dispose();
  });

  test("save: true — an own workflow changes for next time (usedBy), the old example team's copy too; one deleted since doesn't (from_run); a one-off team gets the from_run hint", async () => {
    const w = makeWorld();
    // own workflow (a copy of the house's code team) as the job's team
    const steps = structuredClone(w.workflows.get(w.projectId, 'decode-implement-review')!.steps) as WorkflowStep[];
    w.workflows.save(w.projectId, { id: 'mine', name: 'Mine', description: '', icon: '🧪', steps });
    await w.call('team_assign', { workflow_id: 'mine' });
    const usedBy = () => ['Main']; // the jobs of this house whose team it is
    const { runId, release } = await midRun(w);
    const r = await w.call('team_edit', { ops: [{ op: 'update', step: 'reviewer', thinking: 'max' }], save: true }, { usedBy });
    expect(r.text).toContain('Also saved to the workflow “Mine” (id mine) — used by: Main.');
    expect(w.workflows.get(w.projectId, 'mine')!.steps[2]!.thinking).toBe('max');
    expect(w.engine.get(runId)!.edits!.at(-1)!.saved).toBe('Mine');
    release();
    await runEnd(w, runId);

    // the house's copy of an old example team is its own workflow: saved like any other
    const b = makeWorld();
    const mid = await midRun(b);
    const example = await b.call('team_edit', { ops: [{ op: 'update', step: 'reviewer', model: GPT }], save: true });
    expect(example.isError).toBeFalsy();
    expect(example.text).toContain('Also saved to the workflow “Decode → Implement → Review” (id decode-implement-review)');
    expect(b.workflows.get(b.projectId, 'decode-implement-review')!.steps[2]!.model).toBe(GPT);
    expect(b.workflows.get(b.projectId, 'decode-implement-review')!.builtin).toBeUndefined();
    // deleted while it runs: the run still changes, the workflow isn't there to save to
    expect(b.workflows.remove(b.projectId, 'decode-implement-review')).toBe(true);
    const gone = await b.call('team_edit', { ops: [{ op: 'update', step: 'reviewer', model: SONNET }], save: true });
    expect(gone.isError).toBeFalsy();
    expect(gone.text).toContain(`This run only. Not saved to the workflow: “Decode → Implement → Review” no longer exists — after the run, workflow_save from_run ${mid.runId} keeps this team as a workflow.`);
    expect(b.engine.get(mid.runId)!.team![2]!.model).toBe(SONNET); // the run change still applied
    expect(b.workflows.get(b.projectId, 'decode-implement-review')).toBeUndefined(); // nothing comes back in its place
    mid.release();
    await runEnd(b, mid.runId);

    const c = makeWorld();
    const release2 = holdImplementer(c);
    const one = await c.call('team_start', { task: 'T', steps: [{ name: 'Implementer', id: 'implementer', model: OPUS, persona: 'p' }, { name: 'Checker', model: OPUS, persona: 'q' }] });
    const oneRun = runOf(one.text);
    await c.until(() => c.prompts.some((p) => p.agentId.endsWith(':x-implementer')));
    const adhoc = await c.call('team_edit', { ops: [{ op: 'update', step: 'checker', persona: 'Strict.' }], save: true });
    expect(adhoc.text).toContain(`Not saved: this is a one-off team — after the run, workflow_save from_run ${oneRun} keeps it (with these changes) as a workflow.`);
    const plain = await c.call('team_edit', { ops: [{ op: 'update', step: 'checker', persona: 'Stricter.' }] });
    expect(plain.text.split('\n').at(-1)).toBe(`This run only — a one-off team (after the run, workflow_save from_run ${oneRun} keeps it with these changes).`);
    release2();
    await runEnd(c, oneRun);
    for (const x of [w, b, c]) x.dispose();
  });
});

describe('T3 refusals: a step that finished or works now', () => {
  test("they say what would be redone, 'ask the user' and redo: true; the run goes on unchanged", async () => {
    const w = makeWorld();
    const { runId, release } = await midRun(w);
    const done = await w.call('team_edit', { ops: [{ op: 'update', step: 'decoder', add_to_instruction: 'More detail.' }] });
    expect(done.isError).toBe(true);
    expect(done.text).toBe(
      '“Decoder” already finished in this run — changing it means redoing it and the steps after it that used its result (Implementer is working on it now). Ask the user first. ' +
        'If they want it redone: team_edit again with the same ops and redo: true — the run stops and continues from Decoder; nothing before it is lost. Changes to later steps alone never need that.',
    );
    const working = await w.call('team_edit', { ops: [{ op: 'update', step: 'Implementer', model: GPT }] });
    expect(working.text).toBe(
      '“Implementer” is working now and team_edit doesn\'t restart them. To tell them something now: {"op":"note","step":"implementer","text":"…"} — they read it at their next step. ' +
        'If their work must start over with the change, ask the user first, then team_edit with redo: true (continues from Implementer; Decoder keeps its result).',
    );
    expect((await w.call('team_edit', { ops: [{ op: 'remove', step: 'zz' }] })).text).toBe('No step “zz” in this run — its steps: decoder (done), implementer (working), reviewer (not started).');
    expect((await w.call('team_edit', { ops: [{ op: 'flip' }] })).text).toBe('ops[0].op must be one of update, add, remove, move, note.');
    expect(w.engine.get(runId)!.planRev).toBeUndefined();
    release();
    await runEnd(w, runId);
    expect(promptsOf(w, 'decoder')).toHaveLength(1);
    w.dispose();
  });
});

describe('T4 redo: true', () => {
  test('no card due: the run stops and continues from that step with the changes; earlier steps keep their results', async () => {
    const w = makeWorld();
    const { runId, release } = await midRun(w);
    const r = await w.call('team_edit', { ops: [{ op: 'update', step: 'implementer', add_to_instruction: 'Use the router.' }], redo: true });
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(new RegExp(`^Started “Decode → Implement → Review” \\(Implementer → Reviewer\\), run (run-\\w+) — continuing run ${runId} from Implementer: Decoder keeps its result`));
    expect(r.text).toContain('The run was stopped and continues from Implementer with your changes (Implementer: instruction).');
    expect(w.engine.get(runId)!.status).toBe('aborted');
    release();
    const next = runOf(r.text.split('— continuing')[0]!);
    const end = await runEnd(w, next);
    expect(end.status).toBe('completed');
    expect(promptsOf(w, 'x-implementer').at(-1)).toContain('Use the router.');
    expect(promptsOf(w, 'decoder')).toHaveLength(1);
    w.dispose();
  });

  test('a card due: nothing stops until Run; Cancel leaves the run going; the loop guard', async () => {
    const w = makeWorld();
    const { runId, release } = await midRun(w);
    w.gate.userMessage(w.lead);
    const pending = w.call('team_edit', { ops: [{ op: 'update', step: 'decoder', persona: 'Thorough.' }], redo: true, why: 'The user wants a deeper decode.' });
    const card = await w.until(() => w.gate.pending()[0]);
    expect(card.continues).toEqual({ runId, fromStepId: 'decoder', kept: [], changes: ['Decoder: persona'] });
    expect(card.steps.map((s) => s.id)).toEqual(['decoder', 'implementer', 'reviewer']);
    expect(w.engine.get(runId)!.status).toBe('running'); // nothing stopped yet
    await w.gate.answer(card.id, false);
    const r = await pending;
    expect(r.text).toBe("The user cancelled the redo — don't redo those steps. The run goes on as it was — nothing was stopped or changed. Ask what they want instead.");
    expect(w.engine.get(runId)!.status).toBe('running');
    // the loop guard: five runs this message
    for (let k = 0; k < 5; k++) w.gate.noteRun(w.lead);
    const limited = await w.call('team_edit', { ops: [{ op: 'update', step: 'decoder', persona: 'x' }], redo: true });
    expect(limited).toEqual({ text: "That's 5 team runs for this message — tell the user what happened and let them decide.", isError: true });
    release();
    await runEnd(w, runId);
    w.dispose();
  });

  test('a card due, the run ends before Run: it continues from that step and says the run had ended (not stopped)', async () => {
    const w = makeWorld();
    const { runId, release } = await midRun(w);
    w.gate.userMessage(w.lead);
    const pending = w.call('team_edit', { ops: [{ op: 'update', step: 'implementer', add_to_instruction: 'REDO-IMPL' }], redo: true });
    const card = await w.until(() => w.gate.pending()[0]);
    release();
    expect((await runEnd(w, runId)).status).toBe('completed');
    await w.gate.answer(card.id, true, {});
    const r = await pending;
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain('The run had ended meanwhile and continues from Implementer with your changes (Implementer: instruction).');
    const end = await runEnd(w, runOf(r.text.split('— continuing')[0]!));
    expect(end.status).toBe('completed');
    expect(promptsOf(w, 'x-implementer').at(-1)).toContain('REDO-IMPL');
    w.dispose();
  });

  test('redo when nothing frozen changes: applied in place, no redo', async () => {
    const w = makeWorld();
    const { runId, release } = await midRun(w);
    const r = await w.call('team_edit', { ops: [{ op: 'update', step: 'reviewer', persona: 'Kind.' }], redo: true });
    expect(r.text).toStartWith(`Changed “Decode → Implement → Review” while it runs (run ${runId})`);
    expect(r.text).toContain('No redo was needed');
    release();
    await runEnd(w, runId);
    w.dispose();
  });
});

describe('T5 the other tools point to team_edit while a team runs', () => {
  test('team_start, team_continue, team_assign refuse with team_edit; workflow_save of a running workflow saves and says the run keeps its plan', async () => {
    const w = makeWorld();
    const steps = structuredClone(w.workflows.get(w.projectId, 'decode-implement-review')!.steps) as WorkflowStep[];
    w.workflows.save(w.projectId, { id: 'mine', name: 'Mine', description: '', icon: '🧪', steps });
    await w.call('team_assign', { workflow_id: 'mine' });
    const { runId, release } = await midRun(w);
    const going = 'A team is already running “Mine” in this job — to change what it does next, use team_edit (it keeps going); otherwise wait for its update (team_stop only if the user wants it stopped).';
    expect(await w.call('team_start', { task: 'x' })).toEqual({ text: going, isError: true });
    expect(await w.call('team_continue', { from_step: 'reviewer' })).toEqual({ text: going, isError: true });
    expect((await w.call('team_assign', { workflow_id: 'novel' })).text).toContain('to change what this run does next, use team_edit (it keeps going)');
    const saved = await w.call('workflow_save', { id: 'mine', replace: true, name: 'Mine', steps: steps.map((s) => ({ ...s, persona: `${s.persona} Next time.` })) });
    expect(saved.isError).toBeFalsy();
    expect(saved.text).toContain(`“Mine” is running now (run ${runId} in the Main job) — that run keeps its own plan; to change what it does next, use team_edit.`);
    expect(w.engine.planOf(runId).steps[2]!.persona).not.toContain('Next time.'); // the run's own plan
    // team_status plan / step
    const plan = await w.call('team_status', { plan: true });
    expect(plan.text).toContain("The steps that haven't started yet, as this run uses them (team_edit can change these):\n### Reviewer [reviewer]");
    expect(plan.text).not.toContain('### Decoder');
    expect(plan.text).toContain('While it runs: team_edit changes the steps that haven\'t started (reviewer) without stopping it.');
    const one = await w.call('team_status', { step: 'decoder' });
    expect(one.text).toContain('As this run uses it:\n### Decoder [decoder]');
    expect((await w.call('team_status', { step: 'zz' })).isError).toBe(true);
    release();
    await runEnd(w, runId);
    w.dispose();
  });

  test("describeRun has no edit lines without edits (the goldens stay)", async () => {
    const w = makeWorld();
    const r = await w.call('team_start', { task: 'Plain' });
    const end = await runEnd(w, runOf(r.text));
    const text = describeRun(end, w.deps(), { detail: true });
    expect(text).not.toContain('Changed while it ran');
    expect(text).not.toContain('changed during the run');
    expect(text).not.toContain('While it runs');
    w.dispose();
  });
});

describe('T6 the persona and the tool defs', () => {
  test('team_edit is a lead tool, schema closed at every level; the persona (ask, auto, solo) and team_stop point to it', () => {
    expect(LEAD_TOOL_NAMES.has('team_edit')).toBe(true);
    const def = LEAD_TOOLS.find((t) => t.name === 'team_edit')!;
    expect(def.loadMode).toBe('essential');
    const closed = (o: unknown, at: string): void => {
      if (!o || typeof o !== 'object') return;
      const x = o as Record<string, unknown>;
      if (x.type === 'object') expect({ at, ap: x.additionalProperties }).toEqual({ at, ap: false });
      for (const [k, v] of Object.entries(x)) if (k !== 'additionalProperties') closed(v, `${at}.${k}`);
    };
    closed(def.parameters, 'team_edit');
    expect(def.description).toContain('Never team_stop + team_start for that.');
    expect(LEAD_TOOLS.find((t) => t.name === 'team_stop')!.description).toContain('never to change later steps');
    expect(LEAD_TOOLS.find((t) => t.name === 'team_start')!.description).toContain('change its later steps with team_edit, never stop and restart it');
    const w = makeWorld();
    const project = w.city.project(w.projectId)!;
    for (const workStyle of ['ask', 'auto', 'solo'] as const) {
      const job = { ...w.jobs.get(w.projectId, 'main')!, workStyle };
      const persona = leadSpec(project, job, [job]).persona;
      expect(persona).toContain('team_edit');
      expect(persona.toLowerCase()).toContain('never stop and restart');
    }
    w.dispose();
  });

  test('tool display: title, detail, activity', () => {
    const args = { ops: [{ op: 'update', step: 'editor', add_to_instruction: 'x' }, { op: 'add', person: { name: 'Proofreader' } }, { op: 'note', step: 'writer', text: 'y' }] };
    expect(toolTitle('team_edit', args)).toBe("change the team's next steps — editor: instruction · add Proofreader · note to writer");
    expect(toolTitle('team_edit', { ...args, redo: true })).toStartWith("change the team's next steps (redo) — ");
    expect(toolDetail('team_edit', args)).toBe("Changing the team's next steps");
    expect(activityForTool('team_edit')).toBe('thinking');
  });
});
