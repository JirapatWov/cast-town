// team_start in every shape against a real WorkflowEngine + PlanGate: the job's team, a saved workflow, a one-off team,
// the lead's `models`, refusals, the loop guard — and who the run's people are (standing vs `x-` temporary).
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { leadSpec } from '../../server/agents/residents.ts';
import { MAX_RUNS_PER_ASK } from '../../shared/protocol.ts';
import { cleanup, DEEPSEEK, GPT, makeWorld, OPUS, runEnd, sleep, SONNET, type World } from './world';

afterAll(cleanup);

const runIdOf = (text: string) => text.match(/run (run-[\w]+)/)?.[1] ?? '';
const startedOk = (r: { text: string; isError?: boolean }) => {
  if (r.isError) throw new Error(r.text);
  expect(r.text).toMatch(/^Started “/);
  return runIdOf(r.text);
};
const mainJob = (w: World) => w.jobs.get(w.projectId, 'main')!;

describe('team_start without a plan card (no user message yet)', () => {
  test("neither workflow_id nor steps → the job's own team with its standing people; job.workflowId unchanged", async () => {
    const w = makeWorld();
    const id = startedOk(await w.call('team_start', { task: 'Fix the tests' }));
    const run = w.engine.get(id)!;
    expect(run.workflowId).toBe('decode-implement-review');
    expect(run.startedBy).toBe('lead');
    expect(run.adhoc).toBeUndefined();
    expect(run.team!.map((m) => m.id)).toEqual(['decoder', 'implementer', 'reviewer']);
    expect(run.team!.map((m) => m.agentId)).toEqual([`${w.projectId}:decoder`, `${w.projectId}:implementer`, `${w.projectId}:reviewer`]);
    expect(run.team![2]!.loopBackTo).toBe('implementer');
    const end = await runEnd(w, id);
    expect(end.status).toBe('completed');
    expect(mainJob(w).workflowId).toBe('decode-implement-review');
    const team = JSON.parse(readFileSync(join(w.city.project(w.projectId)!.path, '.rlt/runs', id, 'team.json'), 'utf8'));
    expect(team.map((s: { id: string }) => s.id)).toEqual(['decoder', 'implementer', 'reviewer']);
    await sleep(100);
    expect(w.left).toHaveLength(0); // standing people never "leave"
    w.dispose();
  });

  test('workflow_id of another workflow → temporary x- people, the job keeps its team, people leave after the end snapshot', async () => {
    const w = makeWorld();
    const id = startedOk(await w.call('team_start', { task: 'Write chapter 5', workflow_id: 'novel' }));
    const run = w.engine.get(id)!;
    expect(run.workflowId).toBe('novel');
    expect(run.team!.map((m) => m.id)).toEqual(['x-idea-maker', 'x-writer', 'x-editor']);
    expect(run.team![2]!.loopBackTo).toBe('x-writer');
    expect(run.team!.map((m) => m.agentId)).toEqual([`${w.projectId}:x-idea-maker`, `${w.projectId}:x-writer`, `${w.projectId}:x-editor`]);
    // everyone moves in when the run starts
    expect(w.ensured.slice(0, 3)).toEqual(run.team!.map((m) => m.agentId));
    expect(w.engine.inActiveRun(`${w.projectId}:x-editor`)).toBe(true);
    const end = await runEnd(w, id);
    expect(end.status).toBe('completed');
    expect(mainJob(w).workflowId).toBe('decode-implement-review');
    // still kept (end snapshot + 6 s), then onPeopleLeave
    expect(w.engine.inActiveRun(`${w.projectId}:x-writer`)).toBe(true);
    expect(w.left).toHaveLength(0);
    await w.until(() => w.left.length, 8000);
    expect(w.left[0]!.id).toBe(id);
    expect(w.engine.inActiveRun(`${w.projectId}:x-writer`)).toBe(false);
    const team = JSON.parse(readFileSync(join(w.city.project(w.projectId)!.path, '.rlt/runs', id, 'team.json'), 'utf8'));
    expect(team.map((s: { id: string }) => s.id)).toEqual(['idea-maker', 'writer', 'editor']); // as written
    expect(existsSync(join(w.city.project(w.projectId)!.path, '.rlt/runs', id, '01-idea-maker.md'))).toBe(true);
    w.dispose();
  }, 15_000);

  test('workflow_id equal to the job’s team → standing people', async () => {
    const w = makeWorld();
    const id = startedOk(await w.call('team_start', { task: 'x', workflow_id: 'decode-implement-review' }));
    expect(w.engine.get(id)!.team![0]!.id).toBe('decoder');
    await runEnd(w, id);
    w.dispose();
  });

  test('steps → a one-off team: workflowId "", default name, adhoc, x- ids, team.json as written', async () => {
    const w = makeWorld();
    const r = await w.call('team_start', {
      task: 'Fix and review',
      steps: [
        { name: 'Fixer', model: OPUS, persona: 'You fix bugs.' },
        { name: 'Reviewer', model: GPT, persona: 'You review.', kind: 'review', loopBackTo: 'Fixer' },
      ],
    });
    const id = startedOk(r);
    const run = w.engine.get(id)!;
    expect(run.workflowId).toBe('');
    expect(run.workflowName).toBe('Team for this task');
    expect(run.adhoc).toBe(true);
    expect(run.team!.map((m) => `${m.id}/${m.model}`)).toEqual([`x-fixer/${OPUS}`, `x-reviewer/${GPT}`]);
    expect(run.team![1]!.loopBackTo).toBe('x-fixer');
    expect(r.text).toMatch(/Started “Team for this task” \(Fixer → Reviewer\)/);
    expect(w.engine.teamOf(id)!.map((s) => s.id)).toEqual(['fixer', 'reviewer']);
    // the prompt the reviewer got has the verdict footer (default instruction)
    await runEnd(w, id);
    expect(w.prompts.find((p) => p.agentId.endsWith(':x-reviewer'))!.text).toMatch(/verdict/);
    // a named one
    const r2 = await w.call('team_start', { task: 'again', name: 'Fix → Review', steps: [{ name: 'Fixer', model: OPUS, persona: 'p' }] });
    expect(w.engine.get(startedOk(r2))!.workflowName).toBe('Fix → Review');
    w.dispose();
  });

  test("models: other models for the job's team this run only → temporary people; job and workflow unchanged", async () => {
    const w = makeWorld();
    const id = startedOk(await w.call('team_start', { task: 'x', models: { reviewer: DEEPSEEK } }));
    const run = w.engine.get(id)!;
    expect(run.workflowId).toBe('decode-implement-review');
    expect(run.team!.map((m) => `${m.id}/${m.model}`)).toEqual([`x-decoder/${OPUS}`, `x-implementer/${DEEPSEEK}`, `x-reviewer/${DEEPSEEK}`]);
    expect(w.workflows.get(w.projectId, 'decode-implement-review')!.steps[2]!.model).toBe(GPT);
    expect(mainJob(w).workflowId).toBe('decode-implement-review');
    // same model as written = no change → standing people
    await runEnd(w, id);
    const id2 = startedOk(await w.call('team_start', { task: 'y', models: { reviewer: GPT } }));
    expect(w.engine.get(id2)!.team![2]!.id).toBe('reviewer');
    w.dispose();
  });

  test('refusals: both, unknown id, no team, bad models, models with steps, a run going, nothing to do', async () => {
    const w = makeWorld({ workflowId: null });
    const e = async (args: Record<string, unknown>, re: RegExp) => {
      const r = await w.call('team_start', args);
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(re);
    };
    await e({ task: '' }, /Give the team a task/);
    await e({ task: 'x' }, /no team of its own — pass workflow_id .* or steps/);
    await e({ task: 'x', workflow_id: 'novel', steps: [{ name: 'A', model: OPUS, persona: '' }] }, /not both/);
    await e({ task: 'x', workflow_id: 'nope' }, /^No workflow with id “nope” in this house — workflow_list shows them\.$/);
    await e({ task: 'x', workflow_id: 'novel', models: { reviewer: GPT } }, /has no step “reviewer” — its step ids: idea-maker, writer, editor/);
    await e({ task: 'x', workflow_id: 'novel', models: { writer: 'gpt' } }, /models.writer must be a model id/);
    await e({ task: 'x', steps: [{ name: 'A', model: OPUS, persona: '' }], models: { a: GPT } }, /models goes with workflow_id/);
    const id = startedOk(await w.call('team_start', { task: 'x', workflow_id: 'novel' }));
    await e({ task: 'y', workflow_id: 'novel' }, /already running “Idea → Write → Edit”/);
    await runEnd(w, id);
    w.dispose();
  });
});

describe('unconnected models (something is connected)', () => {
  test("the job's team on unconnected models is refused before any card, naming steps and connected models", async () => {
    const w = makeWorld({ available: [OPUS, SONNET] });
    w.gate.userMessage(w.lead);
    const r = await w.call('team_start', { task: 'x' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Not connected: “Implementer” \[implementer\] uses deepseek\/deepseek-v4-pro; “Reviewer” \[reviewer\] uses openai\/gpt-6.1-sol\. Pick from the connected models: anthropic\/claude-opus-5-5, anthropic\/claude-sonnet-5-5/);
    expect(w.gate.pending()).toHaveLength(0);
    // the lead's models make it runnable (→ card, since the user wrote)
    const p = w.call('team_start', { task: 'x', models: { implementer: SONNET, reviewer: SONNET } });
    const plan = await w.until(() => w.gate.pending()[0]);
    expect(plan.steps.map((s) => s.model)).toEqual([OPUS, SONNET, SONNET]);
    await w.gate.answer(plan.id, true);
    startedOk(await p);
    w.dispose();
  });

  test('engine.start refuses unconnected models itself (the Workflow tab path)', async () => {
    const w = makeWorld({ available: [OPUS] });
    await expect(w.engine.start(w.projectId, 'main', 'novel', 'x', { startedBy: 'user' })).rejects.toThrow(/Not connected: Idea-maker uses L\(google\/gemini-4-argon\), Editor uses L\(openai\/gpt-6.1-sol\)\. Pick connected models \(claude-opus-5-5\)/);
    w.dispose();
  });

  test('nothing connected: every model runs (demo)', async () => {
    const w = makeWorld({ available: [] });
    const run = await w.engine.start(w.projectId, 'main', 'novel', 'x', { startedBy: 'user' });
    expect(run.startedBy).toBe('user');
    expect(run.team![0]!.id).toBe('x-idea-maker'); // not the job's team → temporary people
    await runEnd(w, run.id);
    w.dispose();
  });
});

describe('loop guard', () => {
  test(`at most ${MAX_RUNS_PER_ASK} lead-started runs per user message; a new message resets it`, async () => {
    const w = makeWorld();
    w.gate.userMessage(w.lead);
    for (let i = 0; i < MAX_RUNS_PER_ASK; i++) {
      const p = w.call('team_start', { task: `t${i}`, workflow_id: 'novel' });
      if (i === 0) {
        const plan = await w.until(() => w.gate.pending()[0]);
        await w.gate.answer(plan.id, true);
      }
      await runEnd(w, startedOk(await p));
    }
    const sixth = await w.call('team_start', { task: 'six', workflow_id: 'novel' });
    expect(sixth.isError).toBe(true);
    expect(sixth.text).toBe("That's 5 team runs for this message — tell the user what happened and let them decide.");
    w.gate.userMessage(w.lead);
    const p = w.call('team_start', { task: 'seven', workflow_id: 'novel' });
    const plan = await w.until(() => w.gate.pending()[0]);
    await w.gate.answer(plan.id, true);
    await runEnd(w, startedOk(await p));
    w.dispose();
  });

  test("a house's own limit replaces the default for its lead (guard and instructions); cleared, the default is back", async () => {
    const w = makeWorld();
    const told = () => leadSpec(w.city.project(w.projectId)!, w.jobs.get(w.projectId, 'main')!, w.jobs.list(w.projectId)).persona;
    w.city.updateProject(w.projectId, { maxRunsPerAsk: 2 });
    expect(told()).toContain('(at most 2 runs per message)');
    w.gate.userMessage(w.lead);
    for (let i = 0; i < 2; i++) {
      const p = w.call('team_start', { task: `t${i}`, workflow_id: 'novel' });
      if (i === 0) await w.gate.answer((await w.until(() => w.gate.pending()[0])).id, true);
      await runEnd(w, startedOk(await p));
    }
    const third = await w.call('team_start', { task: 'three', workflow_id: 'novel' });
    expect(third.text).toBe("That's 2 team runs for this message — tell the user what happened and let them decide.");
    w.city.updateProject(w.projectId, { maxRunsPerAsk: undefined });
    expect(told()).toContain(`(at most ${MAX_RUNS_PER_ASK} runs per message)`);
    await runEnd(w, startedOk(await w.call('team_start', { task: 'three again', workflow_id: 'novel' })));
    w.dispose();
  });
});

describe('nothing connected and no scripted model (production: the user signed out while the lead was busy)', () => {
  test('workflow_list says nobody can work (no test-mode text); team_start is refused before a plan card, with a saved team or steps', async () => {
    const w = makeWorld();
    const prod = { models: { ...w.models, demoActive: () => false } };
    const list = await w.call('workflow_list', {}, prod);
    expect(list.text).toContain('No AI account is connected now — nobody can work until the user connects one under Models & providers. team_start is refused until then;');
    expect(list.text).not.toMatch(/CAST_MOCK_LLM|scripted/);
    for (const args of [{ task: 'Fix the tests' }, { task: 'Fix the tests', workflow_id: 'novel' }, { task: 'Fix the tests', steps: [{ name: 'Maker', model: OPUS, persona: 'You make it.' }] }]) {
      const r = await w.call('team_start', args, prod);
      expect(r.isError).toBe(true);
      expect(r.text).toContain("No AI account is connected now — nobody can work until the user connects one under Models & providers. Tell the user; don't start a team until then.");
    }
    expect(w.engine.runs()).toEqual([]);
    expect(w.waiting.size).toBe(0);
    w.dispose();
  });
});
