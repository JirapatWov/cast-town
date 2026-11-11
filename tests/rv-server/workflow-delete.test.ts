// Deleting a workflow the user made, through the real AgentSystem (delete_workflow from the Workflow tab, the lead's
// workflow_delete): a workflow that is some job's team can be deleted when the user says so (those jobs get no fixed
// team), never while it runs, and no job or house keeps pointing at a deleted workflow. A workflow belongs to its house:
// deleting it there never touches another house's workflow with the same id. A house's copy of an old example team is
// one of its workflows like any other.
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { LOTS } from '../../shared/city-layout.ts';
import { workflowsOf } from '../../shared/house-workflows.ts';
import type { Workflow } from '../../shared/protocol';
import { cleanup, makeSys, type SysWorld } from './sys-world';
afterAll(cleanup);

const OPUS = 'anthropic/claude-opus-5-5';
const MINE: Workflow = {
  id: 'spec-compare-186y',
  name: 'Spec-Compare',
  description: 'Mine',
  icon: '',
  steps: [{ id: 'analyst', name: 'Analyst', model: OPUS, persona: 'You analyse.', instruction: 'Do {{task}}', kind: 'work' }],
};

/** A house whose Main job has the user's workflow as its team (the job dialog keeps the house in step), plus a
 *  second job "Side" with the same team. */
async function world(): Promise<SysWorld> {
  const w = makeSys({ workflowId: null });
  expect(((await w.handle({ t: 'save_workflow', projectId: w.projectId, workflow: MINE })) as { ok: boolean }).ok).toBe(true);
  w.jobs.update(w.projectId, 'main', { workflowId: MINE.id });
  w.city.updateProject(w.projectId, { workflowId: MINE.id });
  w.city.updateProject(w.projectId, { floors: 2 });
  w.jobs.create(w.projectId, { name: 'Side', kind: 'general', room: { floor: 1, slot: 0 }, leadModel: OPUS, workflowId: MINE.id });
  return w;
}

const ackOf = (m: unknown) => m as { t: string; ok: boolean; error?: string; data?: { workflow?: Workflow; cleared?: string[] } };
/** The house lists it (its own workflows). */
const listed = (w: SysWorld, projectId = w.projectId) => workflowsOf(w.sys.snapshot(), projectId).some((x) => x.id === MINE.id);
const teams = (w: SysWorld) => ({
  house: w.city.project(w.projectId)?.workflowId ?? null,
  jobs: w.jobs.list(w.projectId).map((j) => `${j.name}:${j.workflowId ?? '-'}`),
});

describe('delete_workflow on a job’s team', () => {
  test('refused without clearTeams (and says how to get past it); with clearTeams the jobs and the house get no team and it is gone', async () => {
    const w = await world();
    const refused = ackOf(await w.handle({ t: 'delete_workflow', projectId: w.projectId, workflowId: MINE.id }));
    expect(refused.ok).toBe(false);
    expect(refused.error).toBe('“Spec-Compare” is the team of the Main and Side jobs — pick another team there first (Edit job → Team), or delete it and leave those jobs with no fixed team.');
    expect(listed(w)).toBe(true);

    const ok = ackOf(await w.handle({ t: 'delete_workflow', projectId: w.projectId, workflowId: MINE.id, clearTeams: true }));
    expect(ok.ok).toBe(true);
    expect(ok.data?.workflow?.id).toBe(MINE.id);
    expect(ok.data?.cleared).toEqual(['Main', 'Side']);
    expect(listed(w)).toBe(false);
    expect(teams(w)).toEqual({ house: null, jobs: ['Main:-', 'Side:-'] });
    // every window hears it: the jobs, the house and the workflows
    expect(w.sent.some((m) => m.t === 'workflows' && !!m.houseWorkflows && !workflowsOf(m, w.projectId).some((x) => x.id === MINE.id))).toBe(true);
    await w.dispose();
  });

  test('a Main job with no team of its own whose house still has it (older data): clearTeams frees the house too', async () => {
    const w = await world();
    w.jobs.update(w.projectId, 'main', { workflowId: null });
    w.jobs.update(w.projectId, 'side', { workflowId: null });
    expect(teams(w)).toEqual({ house: MINE.id, jobs: ['Main:-', 'Side:-'] });
    expect(ackOf(await w.handle({ t: 'delete_workflow', projectId: w.projectId, workflowId: MINE.id })).error).toContain('is the team of the Main job —');
    const ok = ackOf(await w.handle({ t: 'delete_workflow', projectId: w.projectId, workflowId: MINE.id, clearTeams: true }));
    expect(ok.ok).toBe(true);
    expect(ok.data?.cleared).toEqual(['Main']);
    expect(teams(w)).toEqual({ house: null, jobs: ['Main:-', 'Side:-'] });
    await w.dispose();
  });

  test('a house that still names it while its Main job has another team does not keep pointing at the deleted workflow', async () => {
    const w = await world();
    w.jobs.update(w.projectId, 'main', { workflowId: 'decode-implement-review' });
    w.jobs.update(w.projectId, 'side', { workflowId: null });
    const ok = ackOf(await w.handle({ t: 'delete_workflow', projectId: w.projectId, workflowId: MINE.id }));
    expect(ok.ok).toBe(true);
    expect(teams(w)).toEqual({ house: 'decode-implement-review', jobs: ['Main:decode-implement-review', 'Side:-'] });
    await w.dispose();
  });

  test('never while it runs — not even with clearTeams, and then no team is cleared; after the run ends it goes', async () => {
    const w = await world();
    w.member = () => 'hold'; // the team keeps working
    const started = ackOf(await w.handle({ t: 'run_workflow', projectId: w.projectId, jobId: 'side', workflowId: MINE.id, task: 'Compare' })) as { ok: boolean; data?: { runId?: string } };
    expect(started.ok).toBe(true);
    const runId = started.data!.runId!;
    const refused = ackOf(await w.handle({ t: 'delete_workflow', projectId: w.projectId, workflowId: MINE.id, clearTeams: true }));
    expect(refused.ok).toBe(false);
    expect(refused.error).toBe('“Spec-Compare” is running right now — delete it after the run ends.');
    expect(teams(w)).toEqual({ house: MINE.id, jobs: ['Main:spec-compare-186y', 'Side:spec-compare-186y'] });
    await w.handle({ t: 'abort_run', runId });
    await w.until(() => w.sys.engine.get(runId)?.status === 'aborted', 2000, 'run stopped');
    expect(ackOf(await w.handle({ t: 'delete_workflow', projectId: w.projectId, workflowId: MINE.id, clearTeams: true })).ok).toBe(true);
    expect(teams(w)).toEqual({ house: null, jobs: ['Main:-', 'Side:-'] });
    await w.dispose();
  });

  test('a house’s copy of an old example team is deleted like any workflow: nothing comes back in its place', async () => {
    const w = makeSys(); // the house's team is its copy of decode-implement-review
    const code = 'decode-implement-review';
    const has = () => workflowsOf(w.sys.snapshot(), w.projectId).some((x) => x.id === code);
    expect(has()).toBe(true);
    const refused = ackOf(await w.handle({ t: 'delete_workflow', projectId: w.projectId, workflowId: code }));
    expect(refused.ok).toBe(false);
    expect(refused.error).toBe('“Decode → Implement → Review” is the team of the Main job — pick another team there first (Edit job → Team), or delete it and leave that job with no fixed team.');
    const ok = ackOf(await w.handle({ t: 'delete_workflow', projectId: w.projectId, workflowId: code, clearTeams: true }));
    expect(ok.ok).toBe(true);
    expect(ok.data?.cleared).toEqual(['Main']);
    expect(teams(w)).toEqual({ house: null, jobs: ['Main:-'] });
    expect(has()).toBe(false);
    expect(w.sys.snapshot().workflows).toEqual([]);
    await w.dispose();
  });
});

describe('the lead’s workflow_delete', () => {
  async function leadCall(w: SysWorld, args: Record<string, unknown>) {
    await w.handle({ t: 'prompt', agentId: w.lead, text: 'delete the Spec-Compare workflow' });
    const lp = await w.until(() => w.procs.get(w.lead), 2000, 'lead proc');
    await w.until(() => lp.prompts.length >= 1, 2000, 'lead prompt');
    const call = lp.hostCall('workflow_delete', args);
    return w.until(() => lp.hostResults.find((r) => r.id === call.id), 2000, 'tool result');
  }

  test('refused for other jobs’ team, with the way out; clear_teams: true (the user asked) frees them and deletes it — only in its own house', async () => {
    const w = await world();
    // the lead's own job no longer uses it; another job of the house still does: team_assign can't reach that one
    w.jobs.update(w.projectId, 'main', { workflowId: null });
    w.city.updateProject(w.projectId, { workflowId: null });
    // another house: proj's workflow is not its own — it has a workflow of its own under the same id (its Main job's team)
    const novelPath = join(w.root, 'ws', 'my-novel');
    mkdirSync(novelPath, { recursive: true });
    const novel = w.city.addProject({ name: 'my-novel', path: novelPath, lotId: LOTS[1]!.id, style: 'cottage', isGit: false, workflowId: null, approvalMode: 'bypass' });
    expect(listed(w, novel.id)).toBe(false); // saved in proj: not my-novel's
    const theirs = { ...MINE, name: 'Spec-Compare (novel)' };
    expect(ackOf(await w.handle({ t: 'save_workflow', projectId: novel.id, workflow: theirs })).ok).toBe(true);
    w.jobs.update(novel.id, 'main', { workflowId: MINE.id });
    w.city.updateProject(novel.id, { workflowId: MINE.id });

    const first = await leadCall(w, { id: MINE.id });
    expect(first.isError).toBe(true);
    expect(first.text).toContain('“Spec-Compare” is the team of the Side job —'); // my-novel's Main job is not this workflow's
    expect(first.text).not.toContain('my-novel');
    expect(first.text).toContain('call workflow_delete again with clear_teams: true');
    const lp = w.procs.get(w.lead)!;
    const call = lp.hostCall('workflow_delete', { id: MINE.id, clear_teams: true });
    const second = await w.until(() => lp.hostResults.find((r) => r.id === call.id), 2000, 'tool result');
    expect(second.isError).toBeFalsy();
    expect(second.text).toBe('Deleted the workflow “Spec-Compare” (id spec-compare-186y). The Side job has no fixed team now.');
    expect(teams(w)).toEqual({ house: null, jobs: ['Main:-', 'Side:-'] });
    expect(listed(w)).toBe(false);
    // my-novel's own workflow and its team are untouched
    expect(w.city.project(novel.id)?.workflowId).toBe(MINE.id);
    expect(w.jobs.get(novel.id, 'main')?.workflowId).toBe(MINE.id);
    expect(workflowsOf(w.sys.snapshot(), novel.id).find((x) => x.id === MINE.id)?.name).toBe('Spec-Compare (novel)');
    await w.dispose();
  });
});
