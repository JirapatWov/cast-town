// Who is in a job, for rosters (the chat's people row, the Town board): the lead first, then the standing team, then
// the people of a team run who aren't on the standing team, then helpers — each with a name that is unique in the list.
// A run made for one task brings its own people (roleId `x-<step>`), often with the same names as the standing team
// ("Decoder" twice, one Off duty), so the run's copies say whose they are: "Decoder · run 08:57".
import type { AgentInfo, WorkflowRun } from '../../../shared/protocol';
import { timeOfDay } from './format';

export interface RosterEntry {
  agent: AgentInfo;
  /** Unique within the roster. */
  label: string;
  /** Set for the people of a team run who aren't on the standing team (they leave when the run ends). */
  run?: WorkflowRun;
}

const RANK: Record<string, number> = { lead: 0, team: 1, run: 2, helper: 3 };

function place(a: AgentInfo): keyof typeof RANK {
  if (a.kind === 'subagent') return 'helper';
  if (a.kind === 'resident') return 'lead';
  return a.roleId.startsWith('x-') ? 'run' : 'team';
}

/** The run a person belongs to: the run whose team lists them (newest first). */
export function runOfPerson(a: AgentInfo, runs: WorkflowRun[]): WorkflowRun | undefined {
  return runs.filter((r) => r.team?.some((m) => m.agentId === a.id)).sort((x, y) => y.startedAt - x.startedAt)[0];
}

/** The people of one job (or house), ordered and labelled for a roster. `runs`: the runs to look the run people up in. */
export function rosterOf(people: AgentInfo[], runs: WorkflowRun[]): RosterEntry[] {
  const ordered = people
    .map((agent, i) => ({ agent, i, at: place(agent) }))
    .sort((x, y) => RANK[x.at] - RANK[y.at] || x.i - y.i);
  const names = new Map<string, number>();
  for (const { agent } of ordered) names.set(agent.name, (names.get(agent.name) ?? 0) + 1);
  const used = new Set<string>();
  const out: RosterEntry[] = [];
  for (const { agent, at } of ordered) {
    const run = at === 'run' ? runOfPerson(agent, runs) : undefined;
    let label = agent.name;
    if (at === 'run' && (names.get(agent.name) ?? 0) > 1) label = `${agent.name} · run${run ? ` ${timeOfDay(run.startedAt)}` : ''}`;
    // anything still doubled (two helpers of the same kind…) gets a number
    for (let n = 2; used.has(label); n++) label = `${agent.name} ${n}`;
    used.add(label);
    out.push({ agent, label, ...(at === 'run' ? { run } : {}) });
  }
  return out;
}
