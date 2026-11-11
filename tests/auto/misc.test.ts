// The rest of the server side: describeRun from run.team, workflow_delete, workflow_save from_run, work style and
// model choices on jobs, the new client messages, cards left pending across a restart, the lead persona's marker,
// and whose edits a run's undo record keeps.
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describeRun, prepareWorkflowSave, workflowDeleteProblem } from '../../server/agents/lead-tools.ts';
import { leadSpec } from '../../server/agents/residents.ts';
import { ThreadBook } from '../../server/agents/thread-store.ts';
import { WorkflowStore } from '../../server/agents/workflow-store.ts';
import { createJobStore } from '../../server/job-store.ts';
import { parseClientMsg } from '../../server/validate.ts';
import { cleanup, GPT, makeWorld, OPUS, runEnd, sleep, SONNET } from './world';

afterAll(cleanup);

describe('describeRun / team_status', () => {
  test("a one-off team's run lists its own people (no workflow has them)", async () => {
    const w = makeWorld();
    const r = await w.call('team_start', { task: 'T', steps: [{ name: 'Fixer', model: OPUS, persona: 'p' }, { name: 'Checker', model: GPT, persona: 'q', kind: 'review', loopBackTo: 'Fixer' }] });
    const id = r.text.match(/run (run-\w+)/)![1]!;
    await runEnd(w, id);
    const text = describeRun(w.engine.get(id)!, w.deps());
    expect(text).toMatch(/^“Team for this task” — completed/);
    expect(text).toContain('- Fixer: done');
    expect(text).toContain('- Checker: done (approve)');
    expect(text).toContain('Latest output (Checker)');
    const status = await w.call('team_status', {});
    expect(status.text).toContain('- Fixer: done');
    // an old run without a team: the workflow's steps
    const old = { ...w.engine.get(id)!, team: undefined, workflowId: 'novel', steps: [] };
    expect(describeRun(old, w.deps())).toContain('- Idea-maker: skipped');
    w.dispose();
  });
});

describe('workflow_delete', () => {
  test('refusals and the delete', async () => {
    const w = makeWorld();
    const saved = w.workflows.save(w.projectId, { id: 'pair', name: 'Pair', steps: [{ id: 'a', name: 'A', model: OPUS, persona: 'p', instruction: 'Do {{task}}', kind: 'work' }] });
    const ctx = { projectId: w.projectId, workflows: w.workflows, engine: w.engine, usedBy: (id: string) => (id === 'used' ? ['Main'] : id === 'both' ? ['Main', 'Side'] : []) };
    expect(workflowDeleteProblem('nope', ctx)).toBe('No workflow with id “nope” in this house.');
    // the house's copy of an old example team is deleted like any of its workflows; a house without one has none
    expect(workflowDeleteProblem('novel', ctx)).toBeNull();
    const bare = w.addHouse('bare', { workflowId: null, examples: false });
    expect(workflowDeleteProblem('novel', { ...ctx, projectId: bare })).toBe('No workflow with id “novel” in this house.');
    w.workflows.save(w.projectId, { id: 'used', name: 'Used', steps: saved.steps });
    expect(workflowDeleteProblem('used', ctx)).toBe('“Used” is the team of the Main job — pick another team there first (Edit job → Team), or delete it and leave that job with no fixed team.');
    w.workflows.save(w.projectId, { id: 'both', name: 'Both', steps: saved.steps });
    expect(workflowDeleteProblem('both', ctx)).toBe('“Both” is the team of the Main and Side jobs — pick another team there first (Edit job → Team), or delete it and leave those jobs with no fixed team.');
    // another house's workflow isn't this house's to delete
    const other = w.addHouse('other');
    expect(workflowDeleteProblem('pair', { ...ctx, projectId: other })).toBe('No workflow with id “pair” in this house.');
    const run = await w.engine.start(w.projectId, 'main', 'pair', 'x', { startedBy: 'user' });
    expect(workflowDeleteProblem('pair', ctx)).toBe('“Pair” is running right now — delete it after the run ends.');
    await runEnd(w, run.id);
    expect(workflowDeleteProblem('pair', ctx)).toBeNull();
    // through the tool
    const deleted: string[] = [];
    const r = await w.call('workflow_delete', { id: 'pair' }, { deleteWorkflow: (id) => (deleted.push(id), w.workflows.get(w.projectId, id)!) });
    expect(r).toEqual({ text: 'Deleted the workflow “Pair” (id pair).' });
    const cleared = await w.call('workflow_delete', { id: 'both', clear_teams: true }, { usedBy: () => ['Main', 'Side'], deleteWorkflow: (id) => w.workflows.get(w.projectId, id)! });
    expect(cleared).toEqual({ text: 'Deleted the workflow “Both” (id both). The Main and Side jobs have no fixed team now.' });
    const bad = await w.call('workflow_delete', { id: 'novel' }, { deleteWorkflow: () => { throw new Error('Could not write workflows.json.'); } });
    expect(bad).toEqual({ text: 'Could not write workflows.json.', isError: true });
    expect(w.workflows.remove(w.projectId, 'pair')).toBe(true);
    expect(w.workflows.remove(w.projectId, 'pair')).toBe(false);
    expect(w.workflows.remove(w.projectId, 'novel')).toBe(true); // the house's own copy: stored, and gone for good
    expect(w.workflows.get(w.projectId, 'novel')).toBeUndefined();
    const again = new WorkflowStore(`${w.root}/data`);
    expect(again.get(w.projectId, 'used')?.name).toBe('Used'); // (so the next line isn't true of any id)
    expect(again.get(w.projectId, 'pair')).toBeUndefined();
    w.dispose();
  });
});

describe('workflow_save: names stay unique', () => {
  test('a new workflow under a taken name becomes "… 2" and says how to change the first one instead', async () => {
    const w = makeWorld();
    const steps = [{ name: 'Planner', model: OPUS, persona: 'You plan.' }, { name: 'Checker', model: GPT, persona: 'You check.', kind: 'review', loopBackTo: 'Planner' }];
    const first = await w.call('workflow_save', { name: 'Planner → Checker', steps });
    expect(first.text).toStartWith('Saved workflow “Planner → Checker” (id planner-checker)');
    const again = await w.call('workflow_save', { name: 'planner → checker ', steps });
    expect(again.isError).toBeFalsy();
    // the same name in other letters and spacing is the same name; the copy keeps the letters it was given
    expect(again.text).toStartWith('Saved workflow “planner → checker 2”');
    expect(again.text).toContain('A workflow called “Planner → Checker” already exists, so this one is “planner → checker 2”. To change that one instead, save with id "planner-checker" and replace: true.');
    const third = await w.call('workflow_save', { name: 'Planner → Checker', steps });
    expect(third.text).toStartWith('Saved workflow “Planner → Checker 3”');
    const names = w.workflows.list(w.projectId).map((x) => x.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    // the name of the house's copy of an old example team: renamed too, with the same hint (it is the house's own)
    const example = await w.call('workflow_save', { name: 'Decode → Implement → Review', steps });
    expect(example.text).toStartWith('Saved workflow “Decode → Implement → Review 2”');
    expect(example.text).toContain('To change that one instead, save with id "decode-implement-review" and replace: true.');
    // changing the first one in place keeps its name
    const replaced = await w.call('workflow_save', { id: 'planner-checker', replace: true, name: 'Planner → Checker', steps });
    expect(replaced.text).toStartWith('Saved workflow “Planner → Checker” (id planner-checker)');
    w.dispose();
  });
});

describe('workflow_save from_run', () => {
  test("keeps a finished run's team as written (no x-), with a description from the task", async () => {
    const w = makeWorld();
    const r = await w.call('team_start', { task: 'Fix   the\nlogin bug', steps: [{ name: 'Fixer', model: OPUS, persona: 'You fix.' }, { name: 'Checker', model: GPT, persona: 'You check.', kind: 'review', loopBackTo: 'Fixer' }] });
    const id = r.text.match(/run (run-\w+)/)![1]!;
    const ctx = { projectId: w.projectId, workflows: w.workflows, engine: w.engine, usedBy: () => [], models: w.models };
    expect(prepareWorkflowSave({ name: 'Too soon', from_run: id }, ctx)).toEqual({ error: expect.stringMatching(/still running|running/) });
    await runEnd(w, id);
    const prep = prepareWorkflowSave({ name: 'Fix pair', from_run: id }, ctx);
    if ('error' in prep) throw new Error(prep.error);
    expect(prep.workflow).toMatchObject({ id: 'fix-pair', name: 'Fix pair', icon: '👥', description: 'Kept from a run: “Fix the login bug”' });
    expect(prep.workflow.steps.map((s) => `${s.id}/${s.model}/${s.loopBackTo ?? ''}`)).toEqual([`fixer/${OPUS}/`, `checker/${GPT}/fixer`]);
    expect(prepareWorkflowSave({ name: 'x', from_run: id, steps: [] }, ctx)).toEqual({ error: 'Pass steps or from_run, not both.' });
    expect('error' in prepareWorkflowSave({ name: 'x', from_run: 'run-nope' }, ctx)).toBe(true);
    // the tool saves it
    const saved = await w.call('workflow_save', { name: 'Fix pair', from_run: id });
    expect(saved.isError).toBeFalsy();
    expect(w.workflows.get(w.projectId, 'fix-pair')!.steps).toHaveLength(2);
    w.dispose();
  });

  test("a run with other models keeps them (the run's team, not the workflow)", async () => {
    const w = makeWorld();
    const r = await w.call('team_start', { task: 'x', models: { reviewer: SONNET } });
    const id = r.text.match(/run (run-\w+)/)![1]!;
    await runEnd(w, id);
    expect(w.engine.teamOf(id)!.map((s) => `${s.id}/${s.model}`)).toEqual([`decoder/${OPUS}`, 'implementer/deepseek/deepseek-v4-pro', `reviewer/${SONNET}`]);
    w.dispose();
  });
});

describe('jobs: work style and model choices', () => {
  test('stored, cleaned on load, refused when wrong', () => {
    const w = makeWorld();
    const job = w.jobs.update(w.projectId, 'main', { workStyle: 'auto', modelPrefs: [{ stepName: 'Reviewer', duty: 'Checks.', model: GPT, at: 1 }] });
    expect(job.workStyle).toBe('auto');
    expect(() => w.jobs.update(w.projectId, 'main', { workStyle: 'lazy' as never })).toThrow('Pick how the Assistant works: ask, auto or solo');
    const file = join(w.root, 'data', 'jobs.json');
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const j = (raw.jobs ?? raw).find((x: { id: string }) => x.id === 'main');
    j.modelPrefs.push({ stepName: '', model: 'x' }, { stepName: 'Old', duty: 'd', model: OPUS, at: 0 }, 'junk');
    j.workStyle = 'weird';
    writeFileSync(file, JSON.stringify(raw));
    const again = createJobStore(join(w.root, 'data'), w.city).get(w.projectId, 'main')!;
    expect(again.workStyle).toBeUndefined();
    expect(again.modelPrefs!.map((p) => p.stepName)).toEqual(['Reviewer', 'Old']); // newest first, junk dropped
    // created with a style
    w.city.updateProject(w.projectId, { floors: 2 });
    const created = w.jobs.create(w.projectId, { name: 'Docs', kind: 'write', room: { floor: 1, slot: 0 }, leadModel: OPUS, workStyle: 'solo' });
    expect(created.workStyle).toBe('solo');
    w.dispose();
  });

  test("the lead's persona carries the work style", () => {
    const w = makeWorld();
    const p = w.city.project(w.projectId)!;
    const persona = (style?: 'ask' | 'auto' | 'solo') => leadSpec(p, { ...w.jobs.get(w.projectId, 'main')!, ...(style ? { workStyle: style } : {}) }, w.jobs.list(w.projectId)).persona;
    expect(persona()).toContain('[rlt-work-style:ask]');
    expect(persona()).toContain('Decide how to do each ask yourself');
    expect(persona()).toContain('shows them a plan card');
    expect(persona('auto')).toContain('[rlt-work-style:auto]');
    expect(persona('auto')).not.toContain('plan card');
    expect(persona('solo')).toContain('[rlt-work-style:solo]');
    expect(persona('solo')).not.toContain('Decide how to do each ask yourself');
    w.dispose();
  });
});

describe('client messages', () => {
  const ok = (m: unknown) => parseClientMsg(JSON.stringify(m));
  test('answer_plan / save_run_team / delete_workflow / workStyle', () => {
    expect(ok({ t: 'answer_plan', reqId: 'r1', planId: 'plan-1', run: true, models: { reviewer: GPT } }).ok).toBe(true);
    expect(ok({ t: 'answer_plan', reqId: 'r1', planId: 'plan-1', run: false }).ok).toBe(true);
    expect(ok({ t: 'answer_plan', reqId: 'r1', planId: 'plan-1', run: 'yes' }).ok).toBe(false);
    expect(ok({ t: 'answer_plan', reqId: 'r1', planId: 'plan-1', run: true, models: { 'Bad Key': GPT } }).ok).toBe(false);
    expect(ok({ t: 'answer_plan', reqId: 'r1', planId: 'plan-1', run: true, models: { reviewer: '' } }).ok).toBe(false); // the gate checks the id's shape
    expect(ok({ t: 'save_run_team', reqId: 'r', runId: 'run-1', name: 'Kept' }).ok).toBe(true);
    expect(ok({ t: 'save_run_team', reqId: 'r', runId: 'run-1', name: '' }).ok).toBe(false);
    expect(ok({ t: 'delete_workflow', reqId: 'r', workflowId: 'pair' }).ok).toBe(true);
    expect(ok({ t: 'delete_workflow', reqId: 'r', workflowId: '../x' }).ok).toBe(false);
    expect(ok({ t: 'delete_workflow', reqId: 'r', workflowId: 'pair', clearTeams: true }).ok).toBe(true);
    expect(ok({ t: 'delete_workflow', reqId: 'r', workflowId: 'pair', clearTeams: 'yes' }).ok).toBe(false);
    expect(ok({ t: 'delete_workflow', reqId: 'r', projectId: 'todo', workflowId: 'pair' }).ok).toBe(true);
    // the library: promote / import name the house; taking one out of the library doesn't
    expect(ok({ t: 'promote_workflow', reqId: 'r', projectId: 'todo', workflowId: 'pair' }).ok).toBe(true);
    expect(ok({ t: 'promote_workflow', reqId: 'r', workflowId: 'pair' }).ok).toBe(false);
    expect(ok({ t: 'import_workflow', reqId: 'r', projectId: 'todo', workflowId: 'pair', replace: true }).ok).toBe(true);
    expect(ok({ t: 'import_workflow', reqId: 'r', projectId: 'todo', workflowId: '../x' }).ok).toBe(false);
    expect(ok({ t: 'delete_library_workflow', reqId: 'r', workflowId: 'pair' }).ok).toBe(true);
    expect(ok({ t: 'update_job', reqId: 'r', projectId: 'p', jobId: 'main', patch: { workStyle: 'auto' } }).ok).toBe(true);
    expect(ok({ t: 'update_job', reqId: 'r', projectId: 'p', jobId: 'main', patch: { workStyle: 'never' } }).ok).toBe(false);
  });
});

describe('cards across a restart', () => {
  test('a plan saved pending loads as cancelled', () => {
    const w = makeWorld();
    const dir = join(w.root, 'tx');
    mkdirSync(dir, { recursive: true });
    const tid = 't-abcd1234';
    writeFileSync(join(dir, 'threads.json'), JSON.stringify({ version: 1, current: tid, threads: [{ id: tid, title: 'x', createdAt: 1, updatedAt: 1, messages: 1 }] }));
    const plan = { id: 'plan-1', agentId: 'a', projectId: 'p', jobId: 'main', title: 'T', task: 't', steps: [], status: 'pending', ts: 1 };
    writeFileSync(join(dir, `${tid}.json`), JSON.stringify({ items: [{ kind: 'plan', id: 'plan-1', plan, ts: 1 }, { kind: 'plan', id: 'plan-2', plan: { ...plan, id: 'plan-2', status: 'approved' }, ts: 2 }] }));
    const book = new ThreadBook(() => {});
    const { items } = book.attach({ agentId: 'a', transcriptDir: dir, sessionDir: join(w.root, 'sess') });
    expect(items.map((i) => (i.kind === 'plan' ? i.plan.status : '?'))).toEqual(['cancelled', 'approved']);
    w.dispose();
  });
});

describe('undo record: whose edits are "others"', () => {
  test("the lead's own edits during its team's run are kept as someone else's; the team's aren't", async () => {
    const w = makeWorld();
    w.store.upsert({ id: w.lead, projectId: w.projectId, jobId: 'main', kind: 'resident', name: 'Assistant', roleId: 'assistant', model: OPUS, modelLabel: OPUS, vendor: 'other', demo: true, status: 'idle', activity: 'idle', appearance: { seed: 1, gender: 'f' } });
    const r = await w.call('team_start', { task: 'x', workflow_id: 'novel' });
    const id = r.text.match(/run (run-\w+)/)![1]!;
    // while the run goes (each fake step takes 5 ms): the lead edits, a team member edits
    expect(w.engine.get(id)!.status).toBe('running');
    w.engine.noteFileTool(w.lead, 'write', { path: 'notes.md' });
    w.engine.noteFileTool(`${w.projectId}:x-writer`, 'write', { path: 'ch5.md' });
    await runEnd(w, id);
    const undo = await w.until(() => {
      try {
        return JSON.parse(readFileSync(join(w.city.project(w.projectId)!.path, '.rlt/runs', id, 'undo.json'), 'utf8'));
      } catch {
        return null;
      }
    });
    expect(undo.others).toEqual([{ label: expect.stringContaining('Assistant'), paths: ['notes.md'], unknown: false }]);
    await sleep(10);
    w.dispose();
  });
});
