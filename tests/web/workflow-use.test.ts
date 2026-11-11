// Deleting a workflow from the Workflow tab (web/src/ui/workflow-use.ts): the dialog knows which jobs of its house have
// it as their team (the Main job through its house too, as the server counts) and which runs of it are going there,
// and offers the way past each: stop using it in those jobs and delete, or stop the run first. A saved workflow is one
// house's: another house with the same id (an import keeps the id) has its own copy, which doesn't count. Run: bun test
// <this file>
import { describe, expect, test } from 'bun:test';
import type { Job, Project, WorkflowRun } from '../../shared/protocol';
import { emptyState } from '../../web/src/net/reducer';
import { deleteAsk, teamOfJob, workflowUse } from '../../web/src/ui/workflow-use';

const project = (id: string, name: string, workflowId: string | null) => ({ id, name, workflowId }) as Project;
const job = (projectId: string, id: string, name: string, workflowId: string | null) => ({ projectId, id, name, workflowId }) as Job;
const run = (id: string, projectId: string, jobId: string, workflowId: string, status: WorkflowRun['status']) => ({ id, projectId, jobId, workflowId, status, steps: [], startedAt: 1 }) as unknown as WorkflowRun;

function state() {
  const s = emptyState();
  s.city.projects = [project('terminal', 'terminal', 'spec-compare-186y'), project('my-novel', 'my-novel', 'brief-draft-review-publish'), project('home', 'home', null)];
  s.jobs = {
    terminal: [job('terminal', 'main', 'Main', 'spec-compare-186y'), job('terminal', 'side', 'Side', null)],
    'my-novel': [job('my-novel', 'main', 'Main', null)], // the house's team only (older data)
    home: [job('home', 'main', 'Main', null), job('home', 'docs', 'Docs', 'spec-compare-186y')],
  };
  s.houseWorkflows = {}; // a server where workflows are the houses' own
  return s;
}

describe('teamOfJob', () => {
  test("a job's own team; the Main job falls back to its house's, other jobs never do", () => {
    expect(teamOfJob(job('p', 'main', 'Main', 'a'), project('p', 'p', 'b'))).toBe('a');
    expect(teamOfJob(job('p', 'main', 'Main', null), project('p', 'p', 'b'))).toBe('b');
    expect(teamOfJob(job('p', 'side', 'Side', null), project('p', 'p', 'b'))).toBeNull();
    expect(teamOfJob(undefined, project('p', 'p', 'b'))).toBe('b');
    expect(teamOfJob(undefined, undefined)).toBeNull();
  });
});

describe('workflowUse', () => {
  test("the house's jobs whose team it is, by job name, and its runs going there now — not another house's copy", () => {
    const s = state();
    s.runs = {
      r1: run('r1', 'home', 'docs', 'spec-compare-186y', 'waiting_approval'),
      r2: run('r2', 'terminal', 'main', 'spec-compare-186y', 'completed'),
      r3: run('r3', 'terminal', 'side', 'novel-cover', 'running'),
    };
    // the same id in terminal and home: two copies, each counted in its own house
    expect(workflowUse(s, 'terminal', 'spec-compare-186y')).toEqual({ teams: [{ projectId: 'terminal', jobId: 'main', label: 'Main' }], runs: [], everywhere: false });
    expect(workflowUse(s, 'home', 'spec-compare-186y')).toEqual({
      teams: [{ projectId: 'home', jobId: 'docs', label: 'Docs' }],
      runs: [{ runId: 'r1', label: 'Docs' }],
      everywhere: false,
    });
    expect(workflowUse(s, 'my-novel', 'spec-compare-186y')).toEqual({ teams: [], runs: [], everywhere: false });
    expect(workflowUse(s, 'my-novel', 'brief-draft-review-publish').teams.map((t) => t.label)).toEqual(['Main']);
    expect(workflowUse(s, 'terminal', 'novel-cover')).toEqual({ teams: [], runs: [{ runId: 'r3', label: 'Side' }], everywhere: false });
    expect(workflowUse(s, 'home', 'novel-cover')).toEqual({ teams: [], runs: [], everywhere: false });
  });

  test('an older server (one list every house sees): every house counts, as it refuses a delete while any job uses it', () => {
    const s = state();
    delete s.houseWorkflows;
    s.runs = { r1: run('r1', 'home', 'docs', 'spec-compare-186y', 'waiting_approval') };
    const use = workflowUse(s, 'terminal', 'spec-compare-186y');
    expect(use).toEqual({
      teams: [
        { projectId: 'terminal', jobId: 'main', label: 'terminal / Main' },
        { projectId: 'home', jobId: 'docs', label: 'home / Docs' },
      ],
      runs: [{ runId: 'r1', label: 'home / Docs' }],
      everywhere: true,
    });
    s.runs = {};
    const ask = deleteAsk({ name: 'Spec', steps: [] }, workflowUse(s, 'terminal', 'spec-compare-186y'));
    expect(ask.clearTeams).toBe(true); // the old server deletes it only with clearTeams
    expect(ask.text[0]).toBe('The workflow and its 0 people go away. Past runs, their files and chats stay.');
    expect(ask.text[1]).toStartWith('It is the team of “terminal / Main” and “home / Docs”. Deleting it');
  });
});

describe('deleteAsk', () => {
  const wf = { name: 'Spec-Compare', steps: [{}, {}, {}] as never[] };
  test('used by no one: a plain delete', () => {
    expect(deleteAsk(wf, { teams: [], runs: [] })).toEqual({
      title: 'Delete “Spec-Compare”?',
      text: ['The workflow and its 3 people leave this house. Past runs, their files and chats stay.'],
      confirmLabel: 'Delete workflow',
      clearTeams: false,
      stopRuns: false,
    });
  });
  test("some job's team: says which and offers to stop using it there and delete", () => {
    const one = deleteAsk(wf, { teams: [{ projectId: 'terminal', jobId: 'main', label: 'Main' }], runs: [] });
    expect(one.text[1]).toBe('It is the team of “Main” in this house. Deleting it leaves that job with no fixed team: its lead picks a team for each task.');
    expect(one).toMatchObject({ confirmLabel: 'Stop using it and delete', clearTeams: true, stopRuns: false });
    const two = deleteAsk(wf, { teams: [{ projectId: 'terminal', jobId: 'main', label: 'Main' }, { projectId: 'terminal', jobId: 'docs', label: 'Docs' }], runs: [] });
    expect(two.text[1]).toBe('It is the team of “Main” and “Docs” in this house. Deleting it leaves those jobs with no fixed team: their leads pick a team for each task.');
  });
  test('in the library: says the library keeps its copy', () => {
    expect(deleteAsk(wf, { teams: [], runs: [] }, { inLibrary: true }).text).toEqual([
      'The workflow and its 3 people leave this house. Past runs, their files and chats stay.',
      'The library keeps its copy: any house can still import it.',
    ]);
  });
  test('running: never deleted while it runs — offers to stop the run first', () => {
    const ask = deleteAsk(wf, { teams: [{ projectId: 'terminal', jobId: 'main', label: 'Main' }], runs: [{ runId: 'r1', label: 'Main' }] });
    expect(ask).toEqual({
      title: '“Spec-Compare” is running',
      text: [
        'It is running in “Main” right now, and a workflow can’t be deleted while it runs.',
        'Stop the run first, then delete it. Files the team already changed stay as they are.',
      ],
      confirmLabel: 'Stop the run',
      clearTeams: false,
      stopRuns: true,
    });
    const two = deleteAsk(wf, { teams: [], runs: [{ runId: 'a', label: 'Main' }, { runId: 'b', label: 'Main' }, { runId: 'c', label: 'Docs' }] });
    expect(two.confirmLabel).toBe('Stop the runs');
    expect(two.text[0]).toBe('It is running in “Main” and “Docs” right now, and a workflow can’t be deleted while it runs.');
  });
});
