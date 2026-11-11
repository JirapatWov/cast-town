// Pure helpers behind the plan card, the run views and the client state (web/src/ui/plans.ts, runs.ts, format.ts,
// net/reducer.ts). Run: bun test <this file>
import { describe, expect, test } from 'bun:test';
import type { AgentInfo, ModelInfo, ServerMsg, TeamPlan, WorkflowRun } from '../../shared/protocol';
import { agentBlocked, anyConnected, listJoin, modelBlocked } from '../../web/src/ui/format';
import {
  changedModels, finalModel, fixLoopTargets, modelOptions, pendingPlans, planOutcome, stepGroups, stepNote, teamLine, waitingCount,
} from '../../web/src/ui/plans';
import { attemptWaits, currentSteps, isAdhocRun, lockingRun, runAsWorkflow, runTeam, stepChips } from '../../web/src/ui/runs';
import { applyServerMsg, emptyState } from '../../web/src/net/reducer';

const M = (id: string, available: boolean, vendor: ModelInfo['vendor'] = id.split('/')[0] as ModelInfo['vendor'], label = id.split('/')[1]): ModelInfo => ({ id, label, vendor, available });
const OPUS = 'anthropic/claude-opus-5-5';
const SOL = 'openai/gpt-6.1-sol';
const GEM = 'google/gemini-4-argon';
const DS = 'deepseek/deepseek-v4-pro';
const someConnected = [M(OPUS, true, 'anthropic', 'Claude Opus 5.5'), M(SOL, false, 'openai', 'GPT-6.1 Sol'), M(GEM, true, 'google', 'Gemini 4 Argon'), M(DS, false, 'deepseek', 'DeepSeek V4 Pro')];
const noneConnected = someConnected.map((m) => ({ ...m, available: false }));

function plan(over: Partial<TeamPlan> = {}): TeamPlan {
  return {
    id: 'p1',
    agentId: 'proj:main:assistant',
    projectId: 'proj',
    jobId: 'main',
    title: 'Fix and review',
    why: 'Build then check',
    task: 'Fix the failing tests.',
    steps: [
      { id: 'dev', name: 'Developer', duty: 'Fixes the tests', model: OPUS, kind: 'work' },
      { id: 'test', name: 'Tester', duty: 'Writes new tests', model: GEM, kind: 'work', parallel: true },
      { id: 'rev', name: 'Reviewer', duty: 'Checks the code', model: SOL, kind: 'review', loopBackTo: 'dev', maxLoops: 3 },
    ],
    status: 'pending',
    ts: 1000,
    ...over,
  };
}

function run(over: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'r1',
    workflowId: 'wf',
    workflowName: 'Team',
    projectId: 'proj',
    jobId: 'main',
    task: 't',
    status: 'running',
    currentStepId: null,
    loop: 0,
    steps: [],
    startedAt: 1,
    costUsd: 0,
    ...over,
  };
}

function agent(over: Partial<AgentInfo>): AgentInfo {
  return {
    id: 'a', projectId: 'proj', jobId: 'main', kind: 'role', name: 'A', roleId: 'a', model: OPUS, modelLabel: 'Claude Opus 5.5', vendor: 'anthropic',
    demo: false, status: 'idle', activity: 'idle', appearance: { seed: 1, gender: 'f' }, ...over,
  };
}

describe('format', () => {
  test('anyConnected / modelBlocked: something connected blocks the others; nothing connected blocks no pick', () => {
    expect(anyConnected(someConnected)).toBe(true);
    expect(anyConnected(noneConnected)).toBe(false);
    expect(anyConnected([])).toBe(false);
    expect(modelBlocked(SOL, someConnected)).toBe(true);
    expect(modelBlocked(OPUS, someConnected)).toBe(false);
    expect(modelBlocked(SOL, noneConnected)).toBe(false); // nothing connected: any model can be picked, people work once one is
    expect(modelBlocked('other/unknown', someConnected)).toBe(true);
  });
  test('agentBlocked: a person whose model isn’t connected is locked — also when no account is connected at all', () => {
    expect(agentBlocked({ model: SOL }, someConnected)).toBe(true);
    expect(agentBlocked({ model: OPUS }, someConnected)).toBe(false);
    expect(agentBlocked({ model: OPUS }, noneConnected)).toBe(true); // no account: nobody can work
    expect(agentBlocked({ model: SOL }, noneConnected)).toBe(true);
    expect(agentBlocked({ model: OPUS }, [])).toBe(true); // no model list yet
    expect(agentBlocked({ model: 'other/unknown' }, someConnected)).toBe(true);
    // the old per-person demo flag no longer decides anything
    expect(agentBlocked({ model: OPUS, demo: true } as never, someConnected)).toBe(false);
    expect(agentBlocked({ model: SOL, demo: false } as never, someConnected)).toBe(true);
  });
  test('agentBlocked: not locked on the scripted test model or while the first account check runs (the server waits)', () => {
    expect(agentBlocked({ model: OPUS }, noneConnected, { scripted: true })).toBe(false);
    expect(agentBlocked({ model: OPUS }, noneConnected, { checking: true })).toBe(false);
    expect(agentBlocked({ model: SOL }, someConnected, { checking: true })).toBe(false);
    expect(agentBlocked({ model: OPUS }, noneConnected, { scripted: false, checking: false })).toBe(true);
    expect(agentBlocked({ model: OPUS }, noneConnected, {})).toBe(true);
  });
  test('listJoin', () => {
    expect(listJoin([])).toBe('');
    expect(listJoin(['A'])).toBe('A');
    expect(listJoin(['A', 'B'])).toBe('A and B');
    expect(listJoin(['A', 'B', 'C'])).toBe('A, B and C');
  });
});

describe('plans', () => {
  test('stepGroups: consecutive parallel steps join the one before; the first step never does', () => {
    const steps = [{ id: 'a', parallel: true }, { id: 'b', parallel: true }, { id: 'c' }, { id: 'd', parallel: true }, { id: 'e', parallel: true }, { id: 'f' }];
    expect(stepGroups(steps).map((g) => g.map((s) => s.id))).toEqual([['a', 'b'], ['c', 'd', 'e'], ['f']]);
    expect(stepGroups([])).toEqual([]);
  });
  test('stepNote: review loop and parallel', () => {
    const p = plan();
    expect(stepNote(p.steps[0], p.steps)).toBe('');
    expect(stepNote(p.steps[1], p.steps)).toBe('at the same time as Developer');
    expect(stepNote(p.steps[2], p.steps)).toBe('checks · sends back to Developer up to 3×');
    const three = [p.steps[0], p.steps[1], { ...p.steps[2], parallel: true, loopBackTo: undefined }];
    expect(stepNote(three[2], three)).toBe('at the same time as Developer and Tester · checks');
    const dflt = [p.steps[0], { ...p.steps[2], maxLoops: undefined }];
    expect(stepNote(dflt[1], dflt)).toBe('checks · sends back to Developer up to 2×');
  });
  test('changedModels sends only steps whose model changed', () => {
    const p = plan();
    expect(changedModels(p, {})).toEqual({});
    expect(changedModels(p, { dev: OPUS, rev: GEM, ghost: SOL })).toEqual({ rev: GEM });
  });
  test('finalModel and planOutcome', () => {
    const p = plan({ status: 'approved', changed: { rev: GEM }, runId: 'r1' });
    expect(finalModel(p, p.steps[2])).toBe(GEM);
    expect(finalModel(p, p.steps[0])).toBe(OPUS);
    expect(planOutcome(p, run(), someConnected)).toBe('Running — you changed Reviewer to Gemini 4 Argon');
    expect(planOutcome(p, undefined, someConnected)).toBe('Started — you changed Reviewer to Gemini 4 Argon');
    expect(planOutcome(p, run({ status: 'completed' }), someConnected)).toBe('Completed — you changed Reviewer to Gemini 4 Argon');
    expect(planOutcome(plan({ status: 'approved' }), run({ status: 'aborted' }), someConnected)).toBe('Stopped');
    expect(planOutcome(plan({ status: 'approved', changed: { rev: GEM, dev: GEM } }), undefined, someConnected)).toBe('Started — you changed Reviewer to Gemini 4 Argon and Developer to Gemini 4 Argon');
    expect(planOutcome(plan({ status: 'cancelled' }), undefined, someConnected)).toBe('Cancelled');
  });
  test('modelOptions: connected only when something is connected; the current model stays listed, disabled', () => {
    const opts = modelOptions(someConnected, SOL);
    expect(opts.map((o) => [o.id, o.disabled])).toEqual([
      [OPUS, false],
      [SOL, true],
      [GEM, false],
    ]);
    expect(modelOptions(someConnected, OPUS).map((o) => o.id)).toEqual([OPUS, GEM]);
    // no account yet: every model can be picked (none works until one is connected), and no option says "demo"
    const none = modelOptions(noneConnected, SOL);
    expect(none.length).toBe(4);
    expect(none.every((o) => !o.disabled)).toBe(true);
    expect(none.every((o) => !('demo' in o))).toBe(true);
    expect(none.map((o) => o.vendor)).toEqual(['anthropic', 'openai', 'deepseek', 'google']); // vendor order
  });
  test('pendingPlans / waitingCount', () => {
    const s = emptyState();
    s.plans = { p1: plan(), p2: plan({ id: 'p2', jobId: 'side', ts: 500 }), p3: plan({ id: 'p3', status: 'approved' }) };
    s.approvals = { x: { id: 'x', agentId: 'a', projectId: 'proj', tool: 'bash', title: 't', options: [], ts: 1 } };
    expect(pendingPlans(s).map((p) => p.id)).toEqual(['p2', 'p1']);
    expect(pendingPlans(s, { projectId: 'proj', jobId: 'main' }).map((p) => p.id)).toEqual(['p1']);
    expect(pendingPlans(s, { projectId: 'other' })).toEqual([]);
    expect(waitingCount(s)).toBe(3);
  });
  test('teamLine', () => {
    expect(teamLine(plan().steps)).toBe('Developer + Tester → Reviewer');
  });
  test('fixLoopTargets: a review never sends back into or after its own group', () => {
    const steps = [
      { id: 'a', kind: 'work' as const },
      { id: 'b', kind: 'work' as const },
      { id: 'r', kind: 'review' as const, loopBackTo: 'b', parallel: true },
    ];
    expect(fixLoopTargets(steps)[2].loopBackTo).toBe('a');
    const first = [{ id: 'a', kind: 'work' as const }, { id: 'r', kind: 'review' as const, loopBackTo: 'a', parallel: true }];
    expect(fixLoopTargets(first)[1].loopBackTo).toBeUndefined();
    const fine = [{ id: 'a', kind: 'work' as const }, { id: 'r', kind: 'review' as const, loopBackTo: 'a' }];
    expect(fixLoopTargets(fine)[1].loopBackTo).toBe('a');
  });
});

describe('runs', () => {
  // the run's workflow is its house's (run.projectId 'proj'): the built-ins plus that house's own
  const s = {
    workflows: [],
    houseWorkflows: { proj: [{ id: 'wf', name: 'WF', description: '', icon: '', steps: [{ id: 'dec', name: 'Decoder', model: OPUS, persona: '', instruction: '', kind: 'work' as const }] }] },
    agents: {} as Record<string, AgentInfo>,
    models: someConnected,
  };
  const team = [
    { id: 'x-dev', agentId: 'proj:main:x-dev', name: 'Developer', model: OPUS, kind: 'work' as const },
    { id: 'x-test', agentId: 'proj:main:x-test', name: 'Tester', model: GEM, kind: 'work' as const, parallel: true },
    { id: 'x-rev', agentId: 'proj:main:x-rev', name: 'Reviewer', model: GEM, kind: 'review' as const, loopBackTo: 'x-dev' },
  ];
  test('runTeam: run.team first, then the workflow, then the steps it ran', () => {
    expect(runTeam(s, run({ team })).map((m) => m.id)).toEqual(['x-dev', 'x-test', 'x-rev']);
    expect(runTeam(s, run()).map((m) => m.name)).toEqual(['Decoder']);
    expect(runTeam(s, run({ projectId: 'other' }))).toEqual([]); // another house has no “wf” (and the run never started a step)
    expect(runTeam({ ...s, houseWorkflows: undefined, workflows: s.houseWorkflows.proj }, run({ projectId: 'other' })).map((m) => m.name)).toEqual(['Decoder']); // an older server: one list
    const old = run({ workflowId: 'gone', steps: [{ stepId: 'a', status: 'done', agentId: 'ag' }, { stepId: 'b', status: 'done', agentId: 'bg', verdict: 'approve' }, { stepId: 'a', status: 'running', agentId: 'ag' }] });
    expect(runTeam({ ...s, agents: { ag: agent({ id: 'ag', name: 'Alpha' }) } }, old).map((m) => [m.id, m.name, m.kind])).toEqual([['a', 'Alpha', 'work'], ['b', 'b', 'review']]);
  });
  test('adhoc runs and runAsWorkflow', () => {
    expect(isAdhocRun(run({ workflowId: '' }))).toBe(true);
    expect(isAdhocRun(run({ adhoc: true }))).toBe(true);
    expect(isAdhocRun(run())).toBe(false);
    const wf = runAsWorkflow(s, run({ workflowId: '', workflowName: 'Team for this task', team }));
    expect(wf?.name).toBe('Team for this task');
    expect(wf?.steps.map((x) => [x.id, x.parallel ?? false])).toEqual([['x-dev', false], ['x-test', true], ['x-rev', false]]);
    expect(runAsWorkflow(s, run())?.id).toBe('wf');
    expect(runAsWorkflow(s, run({ workflowId: 'gone' }))).toBeNull();
  });
  test('stepChips: names and models from the team, parallel marked', () => {
    const r = run({ team, steps: [{ stepId: 'x-dev', status: 'running', agentId: 'proj:main:x-dev' }, { stepId: 'x-test', status: 'running', agentId: 'proj:main:x-test' }] });
    const chips = stepChips(s, r);
    expect(chips.map((c) => [c.name, c.status, c.parallel])).toEqual([['Developer', 'running', false], ['Tester', 'running', true], ['Reviewer', 'pending', false]]);
    expect(chips[2].modelLabel).toBe('Gemini 4 Argon');
  });
  test('lockingRun: only the run team; old runs lock every role of the job', () => {
    const r = run({ team });
    const member = agent({ id: 'proj:main:x-dev', roleId: 'x-dev' });
    const standing = agent({ id: 'proj:main:dec', roleId: 'dec' });
    const lead = agent({ id: 'proj:main:assistant', kind: 'resident', roleId: 'assistant' });
    expect(lockingRun(member, [r])?.id).toBe('r1');
    expect(lockingRun(standing, [r])).toBeUndefined();
    expect(lockingRun(lead, [r])).toBeUndefined();
    expect(lockingRun(member, [run({ team, status: 'completed' })])).toBeUndefined();
    // a run saved before teams: today's rule
    const old = run({ id: 'old' });
    expect(lockingRun(standing, [old])?.id).toBe('old');
    expect(lockingRun(lead, [old])).toBeUndefined();
    expect(lockingRun(agent({ jobId: 'side' }), [old])).toBeUndefined();
  });
  test('attemptWaits: in a parallel group only the one who asks waits', () => {
    const a = { stepId: 'x-dev', status: 'running' as const, agentId: 'A' };
    const b = { stepId: 'x-test', status: 'running' as const, agentId: 'B' };
    const both = run({ status: 'waiting_approval', currentStepIds: ['x-dev', 'x-test'], steps: [a, b] });
    const agents = { A: agent({ id: 'A' }), B: agent({ id: 'B', activity: 'waiting_approval' }) };
    expect(attemptWaits({ agents }, both, a)).toBe(false);
    expect(attemptWaits({ agents }, both, b)).toBe(true);
    expect(attemptWaits({ agents: { A: agents.A, B: agent({ id: 'B' }) }, approvals: { q: { id: 'q', agentId: 'A', projectId: 'proj', tool: 'bash', title: '', options: [], ts: 1 } } }, both, a)).toBe(true);
    const single = run({ status: 'waiting_approval', currentStepId: 'x-dev', steps: [a] });
    expect(attemptWaits({ agents: {} }, single, a)).toBe(true); // one at work: the run's state is theirs
    expect(attemptWaits({ agents }, run({ steps: [a, b] }), b)).toBe(false);
  });
  test('currentSteps', () => {
    expect(currentSteps(run({ currentStepId: 'a', currentStepIds: ['a', 'b'] }))).toEqual(['a', 'b']);
    expect(currentSteps(run({ currentStepId: 'a' }))).toEqual(['a']);
    expect(currentSteps(run())).toEqual([]);
  });
});

describe('reducer: pending plans', () => {
  const apply = (s: ReturnType<typeof emptyState>, msg: unknown) => applyServerMsg(s, msg as ServerMsg);
  test('snapshot keeps pending plans; servers without plans are fine', () => {
    const s = emptyState();
    apply(s, { t: 'snapshot', city: { lots: [], projects: [] }, agents: [], workflows: [], houseWorkflows: {}, library: [], runs: [], approvals: [], models: [], providers: [], jobs: [], plans: [plan(), plan({ id: 'p2', status: 'cancelled' })] });
    expect(Object.keys(s.plans)).toEqual(['p1']);
    apply(s, { t: 'snapshot', city: { lots: [], projects: [] }, agents: [], workflows: [], runs: [], approvals: [], models: [], providers: [], jobs: [] });
    expect(s.plans).toEqual({});
  });
  test('plan messages and transcript items add and remove', () => {
    const s = emptyState();
    apply(s, { t: 'plan', plan: plan() });
    expect(Object.keys(s.plans)).toEqual(['p1']);
    apply(s, { t: 'transcript_upsert', agentId: 'proj:main:assistant', item: { kind: 'plan', id: 'p1', plan: plan({ status: 'approved', runId: 'r1' }), ts: 1 } });
    expect(s.plans).toEqual({});
    // not loaded yet: an upsert must not create a partial list (opening the chat would then never fetch its history)
    expect(s.transcripts['proj:main:assistant']).toBeUndefined();
    apply(s, { t: 'transcript_upsert', agentId: 'proj:main:assistant', item: { kind: 'plan', id: 'p9', plan: plan({ id: 'p9' }), ts: 1 } });
    expect(Object.keys(s.plans)).toEqual(['p9']);
    apply(s, { t: 'transcript_reset', agentId: 'proj:main:assistant', items: [{ kind: 'plan', id: 'p9', plan: plan({ id: 'p9', status: 'cancelled' }), ts: 1 }] });
    expect(s.plans).toEqual({});
    apply(s, { t: 'transcript_upsert', agentId: 'proj:main:assistant', item: { kind: 'system', id: 's1', text: 'x', ts: 2 } as never });
    expect(s.transcripts['proj:main:assistant'].length).toBe(2); // loaded now: upserts apply
    apply(s, { t: 'plan', plan: plan({ id: 'p5' }) });
    apply(s, { t: 'agent_removed', agentId: 'proj:main:assistant' });
    expect(s.plans).toEqual({});
  });
});

describe('reducer: the scripted-model flag', () => {
  const apply = (s: ReturnType<typeof emptyState>, msg: unknown) => applyServerMsg(s, msg as ServerMsg);
  const hello = (demoMode: boolean) => ({ t: 'hello', demoMode }) as unknown;
  test('a models message keeps the server’s own flag, never guesses it from an empty list', () => {
    const s = emptyState();
    apply(s, hello(false));
    // nothing connected: the town is not on a scripted model, so nothing turns it on
    apply(s, { t: 'models', models: [M(OPUS, false)], providers: [] });
    expect(s.hello?.demoMode).toBe(false);
    apply(s, { t: 'models', models: [M(OPUS, false)], providers: [], demoMode: true });
    expect(s.hello?.demoMode).toBe(true);
    apply(s, { t: 'models', models: [M(OPUS, true)], providers: [] });
    expect(s.hello?.demoMode).toBe(true); // no flag sent: the one hello had
    apply(s, { t: 'models', models: [M(OPUS, true)], providers: [], demoMode: false });
    expect(s.hello?.demoMode).toBe(false);
  });
});
