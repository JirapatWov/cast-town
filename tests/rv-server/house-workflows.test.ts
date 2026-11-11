// Workflows belong to houses, through the real AgentSystem and the core's job / house services: a workflow saved in
// one house is only that house's (listed, run, picked as a team there only); the shared library holds copies a house
// promoted, and a house imports a copy that is its own from then on. Removing a house drops its workflows, not the
// library's. CAST has no workflows of its own: a new house lists none. And the first start with a workflows.json from
// before houses moves each workflow to the houses using it.
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentIdFor } from '../../server/data-layout.ts';
import type { WorkflowStore } from '../../server/agents/workflow-store.ts';
import { createCityStore } from '../../server/city-store.ts';
import { createFsBrowser } from '../../server/fs-browse.ts';
import { createGitService } from '../../server/git.ts';
import { createJobStore } from '../../server/job-store.ts';
import { createJobService } from '../../server/jobs.ts';
import { createProjectService } from '../../server/projects.ts';
import { LOTS } from '../../shared/city-layout.ts';
import { workflowsOf } from '../../shared/house-workflows.ts';
import type { LibraryWorkflow, ServerMsg, Workflow } from '../../shared/protocol';
import { NOVEL_EXAMPLE } from '../legacy-examples';
import { cleanup, makeSys, type SysWorld } from './sys-world';

const roots: string[] = [];
afterAll(() => {
  cleanup();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const OPUS = 'anthropic/claude-opus-5-5';
const MINE: Workflow = {
  id: 'spec-compare-186y',
  name: 'Spec-Compare',
  description: 'Mine',
  icon: '🔎',
  steps: [{ id: 'analyst', name: 'Analyst', model: OPUS, persona: 'You analyse.', instruction: 'Do {{task}}', kind: 'work' }],
};

type Ack = { t: string; ok: boolean; error?: string; data?: { workflow?: Workflow; entry?: LibraryWorkflow; workflowId?: string; runId?: string } };
const ackOf = (m: unknown) => m as Ack;

/** proj (house A, makeSys's) and a second house, "other" (B); neither has a workflow yet. */
function twoHouses(): { w: SysWorld; a: string; b: string } {
  const w = makeSys({ workflowId: null, examples: false });
  const path = join(w.root, 'ws', 'other');
  mkdirSync(path, { recursive: true });
  const b = w.city.addProject({ name: 'other', path, lotId: LOTS[1]!.id, style: 'cottage', isGit: false, workflowId: null, approvalMode: 'bypass' });
  w.jobs.list(b.id);
  return { w, a: w.projectId, b: b.id };
}

const store = (w: SysWorld) => (w.sys as unknown as { o: { workflows: WorkflowStore } }).o.workflows;
/** What the page shows for this house (its own). */
const listOf = (w: SysWorld, projectId: string) => workflowsOf(w.sys.snapshot(), projectId);
const has = (w: SysWorld, projectId: string, id = MINE.id) => listOf(w, projectId).some((x) => x.id === id);
const save = async (w: SysWorld, projectId: string, workflow: Workflow = MINE) => ackOf(await w.handle({ t: 'save_workflow', projectId, workflow }));
const lastWorkflows = (w: SysWorld) => w.sent.filter((m): m is Extract<ServerMsg, { t: 'workflows' }> => m.t === 'workflows').at(-1);
const services = (w: SysWorld) => {
  const git = createGitService();
  const dataDir = join(w.root, 'data');
  return {
    jobs: createJobService({ city: w.city, jobs: w.jobs, agents: w.sys, git, dataDir }),
    projects: createProjectService({ city: w.city, jobs: w.jobs, git, fs: createFsBrowser([w.root]), agents: w.sys, workspaceRoot: join(w.root, 'ws'), dataDir }),
  };
};

describe('a workflow belongs to the house it was saved in', () => {
  test('saved in A: not in B’s list and not runnable there; CAST adds none of its own to either', async () => {
    const { w, a, b } = twoHouses();
    const saved = await save(w, a);
    expect(saved.ok).toBe(true);
    expect(has(w, a)).toBe(true);
    expect(has(w, b)).toBe(false);
    const snap = w.sys.snapshot();
    expect(snap.workflows).toEqual([]); // no built-ins (the field stays for older pages)
    expect(Object.keys(snap.houseWorkflows)).toEqual([a]);
    expect(snap.library).toEqual([]);
    expect(listOf(w, a).map((x) => x.id)).toEqual([MINE.id]);
    expect(listOf(w, b)).toEqual([]);
    for (const p of [a, b]) for (const id of ['decode-implement-review', 'novel']) expect(has(w, p, id)).toBe(false);
    // every window hears it with the houses' lists
    expect(lastWorkflows(w)?.houseWorkflows?.[a]?.map((x) => x.id)).toEqual([MINE.id]);
    expect(lastWorkflows(w)?.workflows).toEqual([]);

    const inB = ackOf(await w.handle({ t: 'run_workflow', projectId: b, workflowId: MINE.id, task: 'Compare' }));
    expect(inB.ok).toBe(false);
    expect(inB.error).toBe('Unknown workflow.');
    const inA = ackOf(await w.handle({ t: 'run_workflow', projectId: a, workflowId: MINE.id, task: 'Compare' }));
    expect(inA.ok).toBe(true);
    await w.until(() => w.sys.engine.get(inA.data!.runId!)?.status === 'completed', 3000, 'run done');
    await w.dispose();
  });

  test('a job in B can’t take A’s workflow as its team (create_job, update_job, the house’s team); in A it can', async () => {
    const { w, a, b } = twoHouses();
    expect((await save(w, a)).ok).toBe(true);
    const s = services(w);
    const unknown = /Unknown team \(workflow\) spec-compare-186y — this house has no workflow with that id/;
    await expect(s.jobs.create({ projectId: b, name: 'Side', kind: 'general', room: { floor: 1, slot: 0 }, workflowId: MINE.id })).rejects.toThrow(unknown);
    await expect(s.jobs.update(b, 'main', { workflowId: MINE.id })).rejects.toThrow(unknown);
    await expect(s.projects.update(b, { workflowId: MINE.id })).rejects.toThrow(unknown);
    expect(w.jobs.get(b, 'main')?.workflowId).toBeNull();
    expect(w.city.project(b)?.workflowId).toBeNull();
    // an old example id is no house's team until the house has a workflow with it; A's own workflow in A
    await expect(s.jobs.update(b, 'main', { workflowId: 'novel' })).rejects.toThrow(/Unknown team \(workflow\) novel — this house has no workflow with that id/);
    expect((await save(w, b, structuredClone(NOVEL_EXAMPLE))).ok).toBe(true);
    expect((await s.jobs.update(b, 'main', { workflowId: 'novel' })).workflowId).toBe('novel');
    await expect(s.jobs.update(a, 'main', { workflowId: 'novel' })).rejects.toThrow(/Unknown team \(workflow\) novel/); // B's, not A's
    expect((await s.jobs.update(a, 'main', { workflowId: MINE.id })).workflowId).toBe(MINE.id);
    // promoted to the library it still isn't B's: B imports it first (and is told so)
    expect(ackOf(await w.handle({ t: 'promote_workflow', projectId: a, workflowId: MINE.id })).ok).toBe(true);
    await expect(s.jobs.update(b, 'main', { workflowId: MINE.id })).rejects.toThrow('“Spec-Compare” is in the library, not in this house — import it into this house first');
    expect(ackOf(await w.handle({ t: 'import_workflow', projectId: b, workflowId: MINE.id })).ok).toBe(true);
    expect((await s.jobs.update(b, 'main', { workflowId: MINE.id })).workflowId).toBe(MINE.id);
    await w.dispose();
  });

  test('a page from before houses had their own workflows (no projectId) is told to reload; an unknown house is refused', async () => {
    const { w } = twoHouses();
    const old = ackOf(await w.handle({ t: 'save_workflow', workflow: MINE }));
    expect(old.ok).toBe(false);
    expect(old.error).toBe('This page is out of date — reload it to save workflows.');
    const oldDelete = ackOf(await w.handle({ t: 'delete_workflow', workflowId: MINE.id }));
    expect(oldDelete.ok).toBe(false);
    expect(oldDelete.error).toBe('This page is out of date — reload it to delete workflows.');
    expect((await save(w, 'gone')).error).toBe('That house no longer exists.');
    expect(w.sys.snapshot().houseWorkflows).toEqual({});
    await w.dispose();
  });
});

describe('the shared library', () => {
  test('promote: a copy goes to the library (every window hears it); A keeps its own; again only with replace; an old example id like any other', async () => {
    const { w, a, b } = twoHouses();
    expect((await save(w, a)).ok).toBe(true);
    const promoted = ackOf(await w.handle({ t: 'promote_workflow', projectId: a, workflowId: MINE.id }));
    expect(promoted.ok).toBe(true);
    expect(promoted.data?.entry).toMatchObject({ workflow: { id: MINE.id, name: 'Spec-Compare' }, from: { projectId: a, house: 'proj' } });
    const msg = lastWorkflows(w);
    expect(msg?.library?.map((e) => e.workflow.id)).toEqual([MINE.id]);
    expect(msg?.library?.[0]?.from).toEqual({ projectId: a, house: 'proj' });
    expect(w.sys.snapshot().library.map((e) => e.workflow.id)).toEqual([MINE.id]);
    expect(has(w, a)).toBe(true);
    // not B's until it imports it: not listed, not runnable
    expect(has(w, b)).toBe(false);
    expect(ackOf(await w.handle({ t: 'run_workflow', projectId: b, workflowId: MINE.id, task: 'Compare' })).error).toBe('Unknown workflow.');

    expect((await save(w, a, { ...MINE, name: 'Spec-Compare v2' })).ok).toBe(true);
    const again = ackOf(await w.handle({ t: 'promote_workflow', projectId: a, workflowId: MINE.id }));
    expect(again.ok).toBe(false);
    expect(again.error).toContain('The library already has a workflow with id “spec-compare-186y” (“Spec-Compare”)');
    expect(w.sys.snapshot().library[0]?.workflow.name).toBe('Spec-Compare');
    expect(ackOf(await w.handle({ t: 'promote_workflow', projectId: a, workflowId: MINE.id, replace: true })).ok).toBe(true);
    expect(w.sys.snapshot().library.map((e) => e.workflow.name)).toEqual(['Spec-Compare v2']);

    const notHers = ackOf(await w.handle({ t: 'promote_workflow', projectId: b, workflowId: MINE.id }));
    expect(notHers.ok).toBe(false);
    expect(notHers.error).toBe('This house has no workflow with id “spec-compare-186y”.');
    // "novel" is no house's until one saves it; then it is promoted like any of its workflows
    const none = ackOf(await w.handle({ t: 'promote_workflow', projectId: a, workflowId: 'novel' }));
    expect(none.ok).toBe(false);
    expect(none.error).toBe('This house has no workflow with id “novel”.');
    expect((await save(w, a, structuredClone(NOVEL_EXAMPLE))).ok).toBe(true);
    const novel = ackOf(await w.handle({ t: 'promote_workflow', projectId: a, workflowId: 'novel' }));
    expect(novel.ok).toBe(true);
    expect(novel.data?.entry?.workflow.builtin).toBeUndefined();
    expect(w.sys.snapshot().library.map((e) => e.workflow.id)).toEqual([MINE.id, 'novel']);
    await w.dispose();
  });

  test('import into B makes B’s own copy: changing it leaves A’s and the library’s alone', async () => {
    const { w, a, b } = twoHouses();
    expect((await save(w, a)).ok).toBe(true);
    expect(ackOf(await w.handle({ t: 'promote_workflow', projectId: a, workflowId: MINE.id })).ok).toBe(true);
    const imported = ackOf(await w.handle({ t: 'import_workflow', projectId: b, workflowId: MINE.id }));
    expect(imported.ok).toBe(true);
    expect(imported.data?.workflow?.id).toBe(MINE.id);
    expect(has(w, b)).toBe(true);
    expect(lastWorkflows(w)?.houseWorkflows?.[b]?.map((x) => x.id)).toEqual([MINE.id]);

    const mine = { ...MINE, name: 'Spec-Compare (B)', steps: [{ ...MINE.steps[0]!, persona: 'You analyse for B.' }] };
    expect((await save(w, b, mine)).ok).toBe(true);
    expect(listOf(w, b).find((x) => x.id === MINE.id)?.name).toBe('Spec-Compare (B)');
    expect(listOf(w, a).find((x) => x.id === MINE.id)).toMatchObject({ name: 'Spec-Compare', steps: [{ persona: 'You analyse.' }] });
    expect(w.sys.snapshot().library[0]?.workflow).toMatchObject({ name: 'Spec-Compare', steps: [{ persona: 'You analyse.' }] });
    // B's own now: it runs there
    expect(ackOf(await w.handle({ t: 'run_workflow', projectId: b, workflowId: MINE.id, task: 'Compare' })).ok).toBe(true);
    await w.dispose();
  });

  test('import over a workflow of the house with that id needs replace; then the jobs whose team it is get its people', async () => {
    const { w, a, b } = twoHouses();
    expect((await save(w, a)).ok).toBe(true);
    expect(ackOf(await w.handle({ t: 'promote_workflow', projectId: a, workflowId: MINE.id })).ok).toBe(true);
    const theirs: Workflow = { ...MINE, name: 'B’s own', steps: [{ id: 'critic', name: 'Critic', model: OPUS, persona: 'You criticise.', instruction: '{{task}}', kind: 'work' }] };
    expect((await save(w, b, theirs)).ok).toBe(true);
    w.jobs.update(b, 'main', { workflowId: MINE.id });
    await w.sys.onJobsChanged(b);
    const people = () => w.sys.snapshot().agents.filter((x) => x.projectId === b && x.kind === 'role').map((x) => x.roleId);
    expect(people()).toEqual(['critic']);

    const refused = ackOf(await w.handle({ t: 'import_workflow', projectId: b, workflowId: MINE.id }));
    expect(refused.ok).toBe(false);
    expect(refused.error).toBe('This house already has a workflow with id “spec-compare-186y” (“B’s own”) — replace it with the library\'s, or keep it.');
    expect(listOf(w, b).find((x) => x.id === MINE.id)?.name).toBe('B’s own');

    const replaced = ackOf(await w.handle({ t: 'import_workflow', projectId: b, workflowId: MINE.id, replace: true }));
    expect(replaced.ok).toBe(true);
    expect(listOf(w, b).find((x) => x.id === MINE.id)?.name).toBe('Spec-Compare');
    expect(people()).toEqual(['analyst']); // B's Main job has the library's team now
    // like a hand edit: the base stays what B's lead last saved, and the library's models count as set by hand now,
    // so a lead's older copy can't undo the import and an older plan-card pick doesn't beat them
    expect(store(w).chatBase(b, MINE.id)?.name).toBe('B’s own');
    for (const s of listOf(w, b).find((x) => x.id === MINE.id)!.steps) expect(store(w).handSetSinceBase(b, MINE.id, `${s.id}.model`)).toBe(true);
    await w.dispose();
  });

  test('delete_library_workflow takes it out of the library; the houses’ copies stay', async () => {
    const { w, a, b } = twoHouses();
    expect((await save(w, a)).ok).toBe(true);
    expect(ackOf(await w.handle({ t: 'promote_workflow', projectId: a, workflowId: MINE.id })).ok).toBe(true);
    expect(ackOf(await w.handle({ t: 'import_workflow', projectId: b, workflowId: MINE.id })).ok).toBe(true);
    const gone = ackOf(await w.handle({ t: 'delete_library_workflow', workflowId: MINE.id }));
    expect(gone.ok).toBe(true);
    expect(gone.data?.workflowId).toBe(MINE.id);
    expect(w.sys.snapshot().library).toEqual([]);
    expect(lastWorkflows(w)?.library).toEqual([]);
    expect(has(w, a)).toBe(true);
    expect(has(w, b)).toBe(true);
    const again = ackOf(await w.handle({ t: 'delete_library_workflow', workflowId: MINE.id }));
    expect(again.ok).toBe(false);
    expect(again.error).toBe('The library has no workflow with id “spec-compare-186y”.');
    await w.dispose();
  });

  test('removing house A drops its workflows; the library keeps the one it promoted (B can still import it)', async () => {
    const { w, a, b } = twoHouses();
    expect((await save(w, a)).ok).toBe(true);
    expect((await save(w, a, { ...MINE, id: 'only-a', name: 'Only A' })).ok).toBe(true);
    expect(ackOf(await w.handle({ t: 'promote_workflow', projectId: a, workflowId: MINE.id })).ok).toBe(true);
    const sent = w.sent.length;
    await services(w).projects.remove(a, { deleteHistory: false });
    expect(w.sys.snapshot().houseWorkflows).toEqual({});
    expect(w.sys.snapshot().library).toMatchObject([{ workflow: { id: MINE.id }, from: { projectId: a, house: 'proj' } }]);
    expect(w.sent.slice(sent).some((m) => m.t === 'workflows' && m.houseWorkflows && !m.houseWorkflows[a])).toBe(true);
    // on disk too (a new house with A's id later starts with none)
    const file = JSON.parse(readFileSync(store(w).file, 'utf8')) as { version: number; houses: Record<string, unknown>; library: unknown[] };
    expect(file.version).toBe(3);
    expect(file.houses[a]).toBeUndefined();
    expect(file.library).toHaveLength(1);
    expect(ackOf(await w.handle({ t: 'import_workflow', projectId: b, workflowId: MINE.id })).ok).toBe(true);
    expect(has(w, b)).toBe(true);
    await w.dispose();
  });
});

describe('the leads’ workflow tools work in their own house (agent-system binds them)', () => {
  /** A lead tool call by the Main job's lead of this house, through the real AgentSystem (omp's host_tool_call). */
  async function lead(w: SysWorld, projectId: string, tool: string, args: Record<string, unknown>) {
    const id = agentIdFor(projectId, 'main', 'assistant');
    let lp = w.procs.get(id);
    if (!lp) {
      await w.handle({ t: 'prompt', agentId: id, text: 'about our teams' });
      lp = await w.until(() => w.procs.get(id), 2000, `lead proc of ${projectId}`);
      await w.until(() => lp!.prompts.length >= 1, 2000, 'lead prompt');
    }
    const call = lp.hostCall(tool, args);
    return w.until(() => lp!.hostResults.find((r) => r.id === call.id), 4000, `${tool} result`);
  }
  const STEPS = [{ name: 'Analyst', model: OPUS, persona: 'You analyse.' }];

  test('workflow_save goes into the lead’s house; workflow_promote names it; the other house’s lead imports it and its job gets the people', async () => {
    const { w, a, b } = twoHouses();
    await w.sys.onProjectAdded(w.city.project(b)!);
    const saved = await lead(w, a, 'workflow_save', { name: 'Spec-Compare', steps: STEPS });
    expect(saved.isError).toBeFalsy();
    expect(saved.text).toStartWith('Saved workflow “Spec-Compare” (id spec-compare)');
    expect(has(w, a, 'spec-compare')).toBe(true);
    expect(has(w, b, 'spec-compare')).toBe(false);
    expect(lastWorkflows(w)?.houseWorkflows?.[a]?.map((x) => x.id)).toEqual(['spec-compare']);
    expect((await lead(w, b, 'workflow_list', {})).text).not.toContain('Spec-Compare');

    const promoted = await lead(w, a, 'workflow_promote', { id: 'spec-compare' });
    expect(promoted.isError).toBeFalsy();
    expect(w.sys.snapshot().library).toMatchObject([{ workflow: { id: 'spec-compare' }, from: { projectId: a, house: 'proj' } }]);
    expect(lastWorkflows(w)?.library?.map((e) => e.workflow.id)).toEqual(['spec-compare']);
    expect((await lead(w, b, 'workflow_list', {})).text).toContain('library id spec-compare, 1 person (Analyst), promoted from the “proj” house');

    // B's Main job names it before B has it (as a house made earlier might): no people for it until it is imported
    w.jobs.update(b, 'main', { workflowId: 'spec-compare' });
    await w.sys.onJobsChanged(b);
    const people = () => w.sys.snapshot().agents.filter((x) => x.projectId === b && x.kind === 'role').map((x) => x.roleId);
    expect(people()).toEqual([]);
    const imported = await lead(w, b, 'workflow_import', { id: 'spec-compare' });
    expect(imported.isError).toBeFalsy();
    expect(imported.text).toContain("This job's team is now “Spec-Compare”.");
    expect(has(w, b, 'spec-compare')).toBe(true);
    expect(lastWorkflows(w)?.houseWorkflows?.[b]?.map((x) => x.id)).toEqual(['spec-compare']);
    await w.until(() => people().length === 1, 2000, 'B’s team people');
    expect(people()).toEqual(['analyst']);
    // B's copy is B's: its lead changes it, A's and the library's stay
    const changed = await lead(w, b, 'workflow_save', { id: 'spec-compare', replace: true, name: 'Spec-Compare', steps: [{ ...STEPS[0]!, persona: 'You analyse for B.' }] });
    expect(changed.isError).toBeFalsy();
    expect(listOf(w, b).find((x) => x.id === 'spec-compare')?.steps[0]?.persona).toBe('You analyse for B.');
    expect(listOf(w, a).find((x) => x.id === 'spec-compare')?.steps[0]?.persona).toBe('You analyse.');
    expect(w.sys.snapshot().library[0]?.workflow.steps[0]?.persona).toBe('You analyse.');
    await w.dispose();
  });
});

describe('moving a workflows.json from before workflows belonged to houses', () => {
  test('each workflow goes to the houses using it (a team, a run on disk), an edited old example team to every house, an unused one to the library; bases and hand edits come along', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cast-test-tmp-'));
    roots.push(root);
    const dataDir = join(root, 'data');
    const ws = join(root, 'ws');
    mkdirSync(dataDir, { recursive: true });
    for (const d of ['proj', 'other']) mkdirSync(join(ws, d), { recursive: true });
    const city = createCityStore(dataDir, ws);
    const a = city.addProject({ name: 'proj', path: join(ws, 'proj'), lotId: LOTS[0]!.id, style: 'house', isGit: false, workflowId: null, approvalMode: 'bypass' }).id;
    const b = city.addProject({ name: 'other', path: join(ws, 'other'), lotId: LOTS[1]!.id, style: 'cottage', isGit: false, workflowId: null, approvalMode: 'bypass' }).id;
    const jobs = createJobStore(dataDir, city);
    jobs.list(a);
    jobs.list(b);

    const wf = (id: string, name: string): Workflow => ({ ...MINE, id, name });
    const usedByA = wf('used-by-a', 'Used by A'); // A's Main job's team
    const ranInB = wf('ran-in-b', 'Ran in B'); // a run of it in B's folder
    const ranInCopy = wf('ran-in-copy', 'Ran in a copy'); // a run of it in a job's own copy of A
    const nobody = wf('nobody', 'Nobody uses it');
    // an older CAST wrote its edited built-ins with the flag
    const editedNovel: Workflow = { ...structuredClone(NOVEL_EXAMPLE), name: 'Novel (edited)', builtin: true };
    jobs.update(a, 'main', { workflowId: usedByA.id });
    const run = (folder: string, id: string, workflowId: string) => {
      mkdirSync(join(folder, '.rlt', 'runs', id), { recursive: true });
      const r = { id, workflowId, workflowName: 'x', projectId: 'whatever', jobId: 'main', task: 't', status: 'completed', currentStepId: null, loop: 0, steps: [], startedAt: 1, endedAt: 2, costUsd: 0 };
      writeFileSync(join(folder, '.rlt', 'runs', id, 'run.json'), `${JSON.stringify(r, null, 2)}\n`);
    };
    run(join(ws, 'other'), 'run-b', ranInB.id);
    run(join(dataDir, 'worktrees', a, 'side'), 'run-copy', ranInCopy.id);
    mkdirSync(join(ws, 'other', '.rlt', 'runs', 'broken'), { recursive: true });
    writeFileSync(join(ws, 'other', '.rlt', 'runs', 'broken', 'run.json'), '{ not json'); // skipped
    const v1 = `${JSON.stringify({ workflows: [usedByA, ranInB, ranInCopy, nobody, editedNovel] }, null, 2)}\n`;
    writeFileSync(join(dataDir, 'workflows.json'), v1);
    const bases = {
      bases: [
        { workflow: usedByA, at: 100, handSet: { analyst: { model: 200 } } },
        { workflow: editedNovel, at: 50, handSet: { writer: { thinking: 300 } } },
      ],
    };
    const v1Bases = JSON.stringify(bases);
    writeFileSync(join(dataDir, 'workflow-bases.json'), v1Bases);

    const w = makeSys({ root, examples: false });
    expect(w.projectId).toBe(a);
    const s = store(w);
    const ids = (p: string) => (s.byHouse()[p] ?? []).map((x) => x.id).sort();
    expect(ids(a)).toEqual(['novel', 'ran-in-copy', 'used-by-a']);
    expect(ids(b)).toEqual(['novel', 'ran-in-b']);
    expect(s.library().map((e) => e.workflow.id)).toEqual(['nobody']);
    expect(s.library()[0]?.from).toBeUndefined();
    // what the page shows
    expect(has(w, a, 'used-by-a')).toBe(true);
    expect(has(w, b, 'used-by-a')).toBe(false);
    expect(has(w, b, 'ran-in-b')).toBe(true);
    expect(has(w, a, 'ran-in-b')).toBe(false);
    expect(has(w, a, 'nobody') || has(w, b, 'nobody')).toBe(false);
    for (const p of [a, b]) {
      const copy = listOf(w, p).find((x) => x.id === 'novel');
      expect(copy?.name).toBe('Novel (edited)');
      expect(copy?.builtin).toBeUndefined(); // an ordinary workflow of each house now
    }
    expect(ids(a)).not.toContain('decode-implement-review'); // no house uses it: the one-time move gives none
    // the bases and the hand edits came along, to each copy
    expect(s.chatBase(a, 'used-by-a')?.name).toBe('Used by A');
    expect(s.chatBaseSeeded(a, 'used-by-a')).toBe(false);
    expect(s.handSetAt(a, 'used-by-a', 'analyst', 'model')).toBe(200);
    for (const p of [a, b]) {
      expect(s.chatBase(p, 'novel')?.name).toBe('Novel (edited)');
      expect(s.handSetAt(p, 'novel', 'writer', 'thinking')).toBe(300);
    }
    expect(s.chatBaseSeeded(b, 'ran-in-b')).toBe(true); // it had no base: seeded from what is stored
    // the old files are kept as they were; the new one is per house
    expect(readFileSync(join(dataDir, 'workflows.v1.json'), 'utf8')).toBe(v1);
    expect(readFileSync(join(dataDir, 'workflow-bases.v1.json'), 'utf8')).toBe(v1Bases);
    // then the one-time move of the old example teams (nothing to give here) marks the file v3, keeping the v2 one
    expect((JSON.parse(readFileSync(join(dataDir, 'workflows.json'), 'utf8')) as { version: number }).version).toBe(3);
    expect((JSON.parse(readFileSync(join(dataDir, 'workflows.v2.json'), 'utf8')) as { version: number }).version).toBe(2);
    expect(readFileSync(join(dataDir, 'workflows.json'), 'utf8')).not.toContain('"builtin"');
    await w.dispose();

    // the next start reads the moved file as it is
    const again = makeSys({ root, examples: false });
    const s2 = store(again);
    expect((s2.byHouse()[a] ?? []).map((x) => x.id).sort()).toEqual(['novel', 'ran-in-copy', 'used-by-a']);
    expect(s2.handSetAt(b, 'novel', 'writer', 'thinking')).toBe(300);
    expect(existsSync(join(dataDir, 'workflows.v1.json'))).toBe(true);
    await again.dispose();
  });
});
