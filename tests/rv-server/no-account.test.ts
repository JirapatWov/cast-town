// The production default with no AI account connected (a fresh install before sign-in), on a real AgentSystemImpl
// with fake omp processes: nobody works, and every way in says so in plain words — a chat message, a team run,
// compact, a goal. No omp is started (no scripted stand-in: that is CAST_MOCK_LLM, tests only), nobody is "demo",
// and nothing of the scripted model is written. With another vendor signed in, a person on an unconnected model gets
// the usual "isn't connected — sign in … or pick another model".
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ModelRegistry } from '../../server/agents/models.ts';
import { OmpHealth } from '../../server/agents/omp-health.ts';
import { residentInfo } from '../../server/agents/residents.ts';
import type { ServerMsg } from '../../shared/protocol.ts';
import { cleanupTmp, fakeOmp, tmp } from '../resilience/fake-omp';
import { cleanup, makeSys, sleep, type SysWorld } from './sys-world';

afterAll(() => {
  cleanup();
  cleanupTmp();
});

type Ack = { t: string; ok: boolean; error?: string; data?: { runId?: string } };
const ackOf = (m: unknown) => m as Ack;
const NONE = "Assistant can't work yet: no AI account is connected. Connect one under Models & providers.";

/** A registry whose omp answered: signed in to these models (none: nothing connected). */
async function registry(models: { provider: string; id: string }[] = [], o: { delay?: number; exit?: number } = {}): Promise<ModelRegistry> {
  const dir = tmp();
  const omp = fakeOmp(dir, 'omp', { models, modelsDelay: o.delay, modelsExit: o.exit });
  const r = new ModelRegistry(omp.bin, { HOME: dir, PATH: process.env.PATH });
  if (!o.delay) await r.detect();
  return r;
}

/** The production default: no scripted model. The house's team is its copy of the old code team. */
async function noAccount(): Promise<{ w: SysWorld; models: ModelRegistry }> {
  const models = await registry();
  expect(models.state).toBe('ok');
  expect(models.anyAvailable()).toBe(false);
  const w = makeSys({ models, scripted: false });
  return { w, models };
}

describe('no AI account connected (production)', () => {
  test('a chat message is refused with how to fix it; omp is never started', async () => {
    const { w } = await noAccount();
    const ack = ackOf(await w.handle({ t: 'prompt', agentId: w.lead, text: 'explain this project' }));
    expect(ack.ok).toBe(false);
    expect(ack.error).toBe(NONE);
    await sleep(50);
    expect(w.specs).toEqual([]);
    expect(w.procs.size).toBe(0);
    await w.dispose();
  });

  test('a message sent while the first check runs waits for it; the check finds nothing: refused then, omp never starts', async () => {
    const models = await registry([], { delay: 0.4 });
    const pending = models.detect();
    const w = makeSys({ models, scripted: false });
    const sending = w.handle({ t: 'prompt', agentId: w.lead, text: 'hi' });
    await sleep(100);
    expect(w.sys.store.get(w.lead)?.detail).toBe('Checking AI accounts…');
    const ack = ackOf(await sending);
    await pending;
    expect(ack.ok).toBe(false);
    expect(ack.error).toBe(NONE);
    expect(w.specs).toEqual([]); // never started on the scripted model's rlt-demo/… stand-in
    await w.dispose();
  });

  test('a team run is refused before anyone starts', async () => {
    const { w } = await noAccount();
    const ack = ackOf(await w.handle({ t: 'run_workflow', projectId: w.projectId, workflowId: 'decode-implement-review', task: 'tidy up' }));
    expect(ack.ok).toBe(false);
    expect(ack.error).toBe('No AI account is connected yet — connect one under Models & providers before starting a team.');
    expect(w.sys.engine.runs()).toEqual([]);
    await sleep(50);
    expect(w.specs).toEqual([]);
    await w.dispose();
  });

  test('compact and a goal (create, resume) get the same refusal', async () => {
    const { w } = await noAccount();
    const compact = ackOf(await w.handle({ t: 'compact', agentId: w.lead }));
    expect(compact.ok).toBe(false);
    expect(compact.error).toBe(NONE);
    const goal = ackOf(await w.handle({ t: 'goal', agentId: w.lead, op: 'create', objective: 'Ship the release' }));
    expect(goal.ok).toBe(false);
    expect(goal.error).toBe(NONE);
    const resume = ackOf(await w.handle({ t: 'goal', agentId: w.lead, op: 'resume' }));
    expect(resume.ok).toBe(false);
    expect(resume.error).toBe(NONE);
    await sleep(50);
    expect(w.specs).toEqual([]);
    await w.dispose();
  });

  test('goal pause and drop with no omp running: the same refusal (not "no longer lives here")', async () => {
    const { w } = await noAccount();
    for (const op of ['pause', 'drop'] as const) {
      const ack = ackOf(await w.handle({ t: 'goal', agentId: w.lead, op }));
      expect(ack.ok).toBe(false);
      expect(ack.error).toBe(NONE);
    }
    await sleep(50);
    expect(w.specs).toEqual([]);
    await w.dispose();
  });

  test('nobody is "demo", demoMode is off, and a model check writes nothing of the scripted model', async () => {
    const { w } = await noAccount();
    expect(w.sys.demoMode()).toBe(false);
    const agents = w.sys.snapshot().agents;
    expect(agents.length).toBeGreaterThan(1); // the lead and the house team's people
    expect(agents.every((a) => a.demo === false)).toBe(true);
    expect(agents.every((a) => a.notConnected === true)).toBe(true); // the page locks their chats on this
    // after a check (Refresh, or the background check: healthChanged)
    const before = w.sent.length;
    await w.handle({ t: 'refresh_models' });
    w.sys.healthChanged(true);
    const models = w.sent.slice(before).filter((m): m is Extract<ServerMsg, { t: 'models' }> => m.t === 'models');
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => m.demoMode === false)).toBe(true);
    const toast = w.sent.slice(before).find((m): m is Extract<ServerMsg, { t: 'toast' }> => m.t === 'toast');
    expect(toast?.text).toBe('Nobody is signed in yet — connect an AI account under Models & providers.');
    expect(existsSync(join(w.root, 'data', 'omp-demo-agent'))).toBe(false);
    expect(w.sys.snapshot().agents.every((a) => a.demo === false)).toBe(true);
    await w.dispose();
  });

  test('a team run while the first check still runs: try again in a moment; after a failed check: press Refresh', async () => {
    const checking = await registry([], { delay: 1 });
    const pending = checking.detect();
    const w1 = makeSys({ models: checking, scripted: false });
    expect(checking.state).toBe('checking');
    const early = ackOf(await w1.handle({ t: 'run_workflow', projectId: w1.projectId, workflowId: 'decode-implement-review', task: 'x' }));
    expect(early.error).toBe('Checking AI accounts — try again in a moment.');
    await pending;
    await w1.dispose();

    const broken = await registry([], { exit: 1 });
    expect(broken.state).toBe('failed');
    const w2 = makeSys({ models: broken, scripted: false });
    const failed = ackOf(await w2.handle({ t: 'run_workflow', projectId: w2.projectId, workflowId: 'decode-implement-review', task: 'x' }));
    expect(failed.error).toMatch(/^CAST couldn't check your AI accounts \(.+\) — it tries again by itself; press Refresh under Models & providers before starting a team\.$/);
    await w2.dispose();
  });

  test('choosing is not working: a job and a team can be set up before sign-in', async () => {
    const { w } = await noAccount();
    expect(w.sys.unusableModel('openai/gpt-6.1-sol')).toBeNull();
    const steps = [{ id: 'maker', name: 'Maker', model: 'openai/gpt-6.1-sol', kind: 'work', persona: 'You make it.', instruction: '{{task}}' }];
    const saved = ackOf(await w.handle({ t: 'save_workflow', projectId: w.projectId, workflow: { id: 'mine', name: 'Mine', description: '', icon: '', steps } }));
    expect(saved.ok).toBe(true);
    await w.dispose();
  });
});

describe('the last account signed out while a lead works on a goal', () => {
  test('pause and drop still reach its running omp; a new goal is refused', async () => {
    const dir = tmp();
    const omp = fakeOmp(dir, 'omp', { models: [{ provider: 'anthropic', id: 'claude-opus-5-5' }] });
    const models = new ModelRegistry(omp.bin, { HOME: dir, PATH: process.env.PATH });
    await models.detect();
    const w = makeSys({ models, scripted: false });
    expect(ackOf(await w.handle({ t: 'goal', agentId: w.lead, op: 'create', objective: 'Ship it' })).ok).toBe(true);
    const proc = w.procs.get(w.lead)!;
    expect(w.sys.store.get(w.lead)?.notConnected).toBe(false);
    // signed out: omp lists nothing now; the check ends as after a sign-out (Models & providers, or outside CAST)
    fakeOmp(dir, 'omp', { models: [] });
    await models.detect();
    expect(models.anyAvailable()).toBe(false);
    w.sys.healthChanged(true);
    await sleep(20);
    expect(proc.alive).toBe(true);
    expect(w.sys.store.get(w.lead)?.notConnected).toBe(true); // re-sent after the check
    const goals = () => proc.calls.filter((c) => c.type === 'goal').length;
    const before = goals();
    for (const op of ['pause', 'drop'] as const) expect(ackOf(await w.handle({ t: 'goal', agentId: w.lead, op })).ok).toBe(true);
    expect(goals()).toBe(before + 2);
    const again = ackOf(await w.handle({ t: 'goal', agentId: w.lead, op: 'create', objective: 'Ship it again' }));
    expect(again.error).toBe(NONE);
    await w.dispose();
  });
});

describe('omp not installed', () => {
  test('starting or continuing a team says omp is missing (not that a check failed)', async () => {
    const dir = tmp();
    const models = new ModelRegistry('/nonexistent/omp', { HOME: dir });
    const health = new OmpHealth({ bin: '/nonexistent/omp', env: { HOME: dir }, models, timeouts: { checkMs: 2000, startMs: 45_000 }, onChange: () => {}, missingRetryMs: 60_000 });
    await health.start();
    expect(models.state).toBe('failed');
    const w = makeSys({ models, health, scripted: false });
    const run = ackOf(await w.handle({ t: 'run_workflow', projectId: w.projectId, workflowId: 'decode-implement-review', task: 'tidy up' }));
    expect(run.error).toStartWith("The agent (cast-agent) wasn't found at /nonexistent/omp, so nobody can work yet.");
    const cont = ackOf(await w.handle({ t: 'continue_run', runId: 'run-x', fromStepId: 'decoder' }));
    expect(cont.error).toStartWith("The agent (cast-agent) wasn't found at /nonexistent/omp");
    health.dispose();
    await w.dispose();
  });
});

describe('the page locks on the server’s word (AgentInfo.notConnected), not on its capped model list', () => {
  test('a connected model the list leaves out (e.g. a ChatGPT route past the cap) is not "not connected"', async () => {
    const route = 'openai-codex/gpt-6.1-sol';
    const many = [...Array.from({ length: 70 }, (_, i) => ({ provider: 'anthropic', id: `claude-x-${String(i).padStart(2, '0')}` })), { provider: 'openai-codex', id: 'gpt-6.1-sol' }];
    const models = await registry(many);
    expect(models.isAvailable(route)).toBe(true);
    expect(models.models().some((m) => m.id === route)).toBe(false);
    const spec = { agentId: 'p:assistant', projectId: 'p', jobId: 'main', kind: 'resident', name: 'Assistant', roleId: 'assistant', model: route };
    expect(residentInfo(spec as never, models, undefined, undefined).notConnected).toBe(false);
    expect(residentInfo({ ...spec, model: 'deepseek/deepseek-v4-pro' } as never, models, undefined, undefined).notConnected).toBe(true);
  });
});

describe('another vendor signed in (regression)', () => {
  test('a lead on Opus while only OpenAI is connected: isn’t connected — sign in, or pick another model', async () => {
    const models = await registry([{ provider: 'openai', id: 'gpt-6.1-sol' }]);
    expect(models.anyAvailable()).toBe(true);
    const w = makeSys({ models, scripted: false });
    expect(w.sys.store.get(w.lead)?.model).toBe('anthropic/claude-opus-5-5');
    expect(w.sys.store.get(w.lead)?.notConnected).toBe(true);
    const ack = ackOf(await w.handle({ t: 'prompt', agentId: w.lead, text: 'hi' }));
    expect(ack.ok).toBe(false);
    expect(ack.error).toBe("Assistant uses Claude Opus 5.5, which isn't connected — sign in under Models & providers, or pick another model (job menu → Edit job…).");
    expect(w.sys.demoMode()).toBe(false);
    await sleep(50);
    expect(w.specs).toEqual([]);
    await w.dispose();
  });
});

describe('a lead model given before any account was connected is not the user’s choice', () => {
  const OPENAI = [{ provider: 'openai', id: 'gpt-6.1-sol' }];
  const CLAUDE = 'anthropic/claude-sonnet-5-5';

  /** Nothing connected; two jobs made then: one without a model (the default), one on a Claude model the user picked. */
  async function setUp() {
    const dir = tmp();
    fakeOmp(dir, 'omp', { models: [] });
    const models = new ModelRegistry(join(dir, 'omp.sh'), { HOME: dir, PATH: process.env.PATH });
    await models.detect();
    const w = makeSys({ models, scripted: false });
    w.city.updateProject(w.projectId, { floors: 3 });
    const make = async (name: string, leadModel?: string) => {
      const job = w.jobs.create(w.projectId, { name, kind: 'code', room: w.jobs.freeRoom(w.projectId)!, ...(leadModel ? { leadModel } : {}) });
      await w.sys.onJobsChanged(w.projectId);
      return job;
    };
    const defaulted = await make('Defaulted');
    const picked = await make('Picked', CLAUDE);
    const connect = async (accounts: { provider: string; id: string }[]) => {
      fakeOmp(dir, 'omp', { models: accounts });
      await models.detect();
    };
    const signIn = async (accounts: { provider: string; id: string }[]) => {
      await connect(accounts);
      w.sys.healthChanged(true);
    };
    const lead = (id: string) => w.sys.store.get(`${w.projectId}:${id}:assistant`)!;
    return { w, connect, signIn, lead, defaulted, picked };
  }

  test('connecting only OpenAI moves the defaulted job to an OpenAI model; the picked Claude job stays', async () => {
    const { w, signIn, lead, defaulted, picked } = await setUp();
    expect(w.jobs.get(w.projectId, defaulted.id)).toMatchObject({ leadModel: 'anthropic/claude-opus-5-5', leadModelDefault: true });
    expect(w.jobs.get(w.projectId, picked.id)?.leadModelDefault).toBeUndefined();
    expect(lead(defaulted.id).notConnected).toBe(true);

    await signIn(OPENAI);

    const now = w.jobs.get(w.projectId, defaulted.id)!;
    expect(now.leadModel).toBe('openai/gpt-6.1-sol');
    expect(now.leadModelDefault).toBeUndefined();
    expect(lead(defaulted.id)).toMatchObject({ model: 'openai/gpt-6.1-sol', notConnected: false });
    expect(w.jobs.get(w.projectId, picked.id)?.leadModel).toBe(CLAUDE);
    expect(lead(picked.id).notConnected).toBe(true); // still locked: that was a choice
    const ack = ackOf(await w.handle({ t: 'prompt', agentId: lead(defaulted.id).id, text: 'hi' }));
    expect(ack?.error).toBeUndefined();
    await w.dispose();
  });

  test('once it has followed an account it is a normal choice: a later sign-in does not move it again', async () => {
    const { w, signIn, defaulted } = await setUp();
    await signIn(OPENAI);
    await signIn([...OPENAI, { provider: 'anthropic', id: 'claude-opus-5-5' }]);
    expect(w.jobs.get(w.projectId, defaulted.id)?.leadModel).toBe('openai/gpt-6.1-sol');
    await w.dispose();
  });

  test('choosing a model by hand ends the stand-in, even the model it already had', async () => {
    const { w, signIn, defaulted } = await setUp();
    w.jobs.update(w.projectId, defaulted.id, { leadModel: 'anthropic/claude-opus-5-5' });
    expect(w.jobs.get(w.projectId, defaulted.id)?.leadModelDefault).toBeUndefined();
    await signIn(OPENAI);
    expect(w.jobs.get(w.projectId, defaulted.id)?.leadModel).toBe('anthropic/claude-opus-5-5');
    await w.dispose();
  });

  test('a job whose people are working keeps its model until they stop', async () => {
    const { w, connect, defaulted } = await setUp();
    await connect(OPENAI);
    w.jobs.followDefaultLead(() => true);
    expect(w.jobs.get(w.projectId, defaulted.id)).toMatchObject({ leadModel: 'anthropic/claude-opus-5-5', leadModelDefault: true });
    w.jobs.followDefaultLead(() => false);
    expect(w.jobs.get(w.projectId, defaulted.id)).toMatchObject({ leadModel: 'openai/gpt-6.1-sol' });
    await w.dispose();
  });

  test('a job made while an account is connected is not a stand-in', async () => {
    const { w, connect } = await setUp();
    await connect(OPENAI);
    const job = w.jobs.create(w.projectId, { name: 'Later', kind: 'code', room: w.jobs.freeRoom(w.projectId)! });
    expect(job).toMatchObject({ leadModel: 'openai/gpt-6.1-sol' });
    expect(job.leadModelDefault).toBeUndefined();
    await w.dispose();
  });
});
