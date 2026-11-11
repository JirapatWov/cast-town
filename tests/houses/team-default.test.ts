// #72: a new house has no fixed team and no workflows: the lead picks or builds a team for each task. The Workflow
// tab says so instead of opening an example team, shows the house's own workflow when it has one ("Team", with a line
// when the job itself has no team), and offers no task box while there is nothing to run.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { workflowsOf } from '../../shared/house-workflows';
import type { Workflow } from '../../shared/protocol';
import * as teamDefault from '../../web/src/ui/team-default';
import { teamHeading } from '../../web/src/ui/team-default';

const tab = readFileSync(join(import.meta.dir, '../../web/src/ui/workflow-tab.ts'), 'utf8');

describe('Workflow tab for a job without a team (#72)', () => {
  test('the heading is "Team", with the note when the job has no team of its own', () => {
    expect(teamHeading(null, 'Developer')).toEqual({ title: 'Team', note: 'No team is set for this job — the Developer picks or builds one for each task.' });
    expect(teamHeading(undefined, 'Writer').note).toBe('No team is set for this job — the Writer picks or builds one for each task.');
    expect(teamHeading('novel', 'Assistant')).toEqual({ title: 'Team', note: null });
    expect(teamHeading('pair', 'Assistant')).toEqual({ title: 'Team', note: null });
  });
  test('there are no example teams to fall back on', () => {
    expect('exampleFor' in teamDefault).toBe(false);
    expect(tab).not.toContain('exampleFor');
    expect(tab).not.toMatch(/Example team|'Example'|\.builtin\b/);
  });
  test("a new house sees no workflows; a house's copy of an old example is its own", () => {
    const wf = (id: string, name = id) => ({ id, name, description: '', icon: '', steps: [] }) as Workflow;
    const lists = { workflows: [], houseWorkflows: { 'my-novel': [wf('novel', 'Novel (edited here)'), wf('mine')] } };
    expect(workflowsOf(lists, 'new-house')).toEqual([]);
    expect(workflowsOf(lists, 'my-novel').map((w) => w.name)).toEqual(['Novel (edited here)', 'mine']);
  });
});

describe('Workflow tab with no workflows (a new house)', () => {
  test('an empty state in place of the list says the lead builds a team, and how to keep one', () => {
    expect(tab).toContain("emptyState('users', 'No workflows in this house yet', `The ${name} builds a team for each task. To keep one, press Create with the ${name}.`)");
    expect(tab).toContain('templatesEl.hidden = none;');
    expect(tab).toContain('emptyEl.hidden = !none;');
  });
  test("the tab opens the job's team, else the house's first workflow, else nothing", () => {
    expect(tab).toContain('const wf = workflowById(id) ?? workflows()[0];');
    expect(tab).toContain('select(seenTeam);');
  });
  test('no task box and Run while there is no workflow to give a task to', () => {
    expect(tab).toContain('compose.hidden = !draft;');
  });
});

describe('the job dialog’s Team menu in a house with no workflows', () => {
  const dialog = readFileSync(join(import.meta.dir, '../../web/src/ui/job-dialog.ts'), 'utf8');
  test('"Or a fixed team" only when the house has some; else a line on how to keep one', () => {
    expect(dialog).toMatch(/if \(wfs\.length\)\s*sections\.push\(\{\s*title: 'Or a fixed team/);
    expect(dialog).toContain('This house has no workflows yet. To keep a team, ask the ${leadName()} to save one, or use the Workflow tab.');
    expect(dialog).not.toMatch(/Example · |\.builtin\b/);
  });
  test('a new job in a writing house is a writing job by its Main job’s kind, not by a team id', () => {
    expect(dialog).toContain("const writingHouse = store.jobsOf(opts.projectId).some((j) => j.id === 'main' && j.kind === 'write');");
    expect(dialog).not.toContain("=== 'novel'");
  });
});
