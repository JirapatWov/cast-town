// What an empty chat suggests saying first, by what the house is for: a book gets writing asks, research gets reading
// asks, code gets code asks ("Fix the failing tests" in a novel house reads like the app doesn't know where it is).
// The welcome's next steps live here too. Pure: callers pass the person and what they know about the house and the job.
import type { AgentInfo, JobKind, Project } from '../../../shared/protocol';

export type WorkKind = 'code' | 'write' | 'research' | 'general';

/** What the house/job is for: the job's kind when it was set, else nothing in particular. */
export function workKindOf(ctx: { jobKind?: JobKind | null }): WorkKind {
  return ctx.jobKind ?? 'general';
}

const LEAD: Record<WorkKind, string[]> = {
  code: ['What does this project do?', 'Fix the failing tests and get them reviewed', 'Find the riskiest part of the code'],
  write: ['Summarize the plot so far', 'Write the next chapter', 'Check the characters stay consistent'],
  research: ['What is in this folder?', 'Summarize the main findings so far', 'List the open questions and what would answer them'],
  general: ['What is in this folder?', 'Summarize what changed here lately', 'Suggest what to do next'],
};

export function chatSuggestions(agent: Pick<AgentInfo, 'kind' | 'roleId' | 'name'>, kind: WorkKind): string[] {
  if (agent.kind === 'subagent') return [];
  if (agent.roleId === 'assistant') return [...LEAD[kind], 'Design a team workflow for this job'];
  if (agent.kind === 'resident') return LEAD[kind];
  return [`What will you look for as ${agent.name}?`, 'Summarize what you did last time'];
}

/** The next step the welcome offers after connecting an AI account: the first house, else placing one. Pure, for
 *  tests. */
export function onboardingTargets(projects: Pick<Project, 'id' | 'name'>[]): { id: string | null; label: string; kind: 'enter' | 'place' }[] {
  const first = projects[0];
  return first ? [{ id: first.id, label: `Enter ${first.name}`, kind: 'enter' }] : [{ id: null, label: 'Place your first project', kind: 'place' }];
}
