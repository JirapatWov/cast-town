// Rosters (web/src/ui/roster.ts): the lead first, the standing team, a run's own people, helpers last — and no two
// entries with the same name ("Decoder" of the standing team vs. the run's "Decoder").
import { describe, expect, test } from 'bun:test';
import type { AgentInfo, WorkflowRun } from '../../shared/protocol';
import { rosterOf, runOfPerson } from '../../web/src/ui/roster';
import { timeOfDay } from '../../web/src/ui/format';

const agent = (id: string, name: string, kind: AgentInfo['kind'], roleId: string): AgentInfo =>
  ({ id, name, kind, roleId, projectId: 'p', jobId: 'main', status: 'idle', activity: 'idle' }) as AgentInfo;
const run = (id: string, startedAt: number, members: string[]): WorkflowRun =>
  ({ id, startedAt, projectId: 'p', workflowName: 'Review', team: members.map((agentId) => ({ id: agentId, agentId, name: '', model: '', kind: 'work' })) }) as unknown as WorkflowRun;

describe('rosterOf', () => {
  test('orders lead, team, run people, helpers and keeps names unique', () => {
    const at = new Date(2026, 10, 1, 8, 57).getTime();
    const people = [
      agent('h1', 'Explore helper', 'subagent', 'explore'),
      agent('x1', 'Decoder', 'role', 'x-decoder'),
      agent('d1', 'Decoder', 'role', 'decoder'),
      agent('lead', 'Assistant', 'resident', 'assistant'),
      agent('h2', 'Explore helper', 'subagent', 'explore'),
      agent('x2', 'Checker', 'role', 'x-checker'),
    ];
    const r = rosterOf(people, [run('r1', at, ['x1', 'x2'])]);
    expect(r.map((e) => e.agent.id)).toEqual(['lead', 'd1', 'x1', 'x2', 'h1', 'h2']);
    expect(r.map((e) => e.label)).toEqual(['Assistant', 'Decoder', `Decoder · run ${timeOfDay(at)}`, 'Checker', 'Explore helper', 'Explore helper 2']);
    expect(new Set(r.map((e) => e.label)).size).toBe(r.length);
    expect(r.find((e) => e.agent.id === 'x2')?.run?.id).toBe('r1');
    expect(r.find((e) => e.agent.id === 'd1')?.run).toBeUndefined();
  });

  test('a run person without a known run still gets a distinct label', () => {
    const r = rosterOf([agent('d', 'Reviewer', 'role', 'reviewer'), agent('x', 'Reviewer', 'role', 'x-reviewer')], []);
    expect(r.map((e) => e.label)).toEqual(['Reviewer', 'Reviewer · run']);
  });

  test('runOfPerson picks the newest run listing them', () => {
    const a = agent('x', 'Decoder', 'role', 'x-decoder');
    expect(runOfPerson(a, [run('old', 1, ['x']), run('new', 5, ['x']), run('other', 9, ['y'])])?.id).toBe('new');
  });
});
