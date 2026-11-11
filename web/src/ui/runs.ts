// Derived views over workflow runs, shared by the top-bar strip and the Workflow tab timeline.
import type { AgentInfo, Vendor, Workflow, WorkflowRun, WorkflowRunStep } from '../../../shared/protocol';
import { workflowOf as houseWorkflowOf } from '../../../shared/house-workflows';
import type { ClientState } from '../core/types';
import { modelLabel, vendorOfModel } from './format';

const MAIN_JOB = 'main';

export type ChipStatus = 'pending' | 'running' | 'waiting' | 'done' | 'failed' | 'skipped';

export interface StepChip {
  stepId: string;
  name: string;
  vendor: Vendor;
  modelLabel: string;
  status: ChipStatus;
  attempts: number;
  verdict?: 'approve' | 'revise';
  agentId?: string;
  parallel?: boolean; // works at the same time as the chip before it
  reused?: boolean; // its latest attempt was kept from an earlier run (a continuation): not run again here
}

/** One person of a run, as the run shows them. */
export interface TeamMember {
  id: string; // step id in the run
  name: string;
  model: string;
  kind: 'work' | 'review';
  loopBackTo?: string;
  maxLoops?: number;
  parallel?: boolean;
  agentId?: string;
  edited?: true; // added or changed while the run went (run.team)
}

const ACTIVE = new Set<WorkflowRun['status']>(['running', 'waiting_approval']);
const LINGER_MS = 25_000; // finished runs stay in the strip briefly so the result is noticed

export function isRunActive(run: WorkflowRun): boolean {
  return ACTIVE.has(run.status);
}

export function runsOf(s: ClientState, projectId: string): WorkflowRun[] {
  return Object.values(s.runs)
    .filter((r) => r.projectId === projectId)
    .sort((a, b) => b.startedAt - a.startedAt);
}

/** The run worth showing in the top bar for this context (active first, else recently finished). */
export function runForStrip(s: ClientState, projectId: string | null, now = Date.now()): WorkflowRun | undefined {
  const all = Object.values(s.runs).filter((r) => !projectId || r.projectId === projectId);
  const active = all.filter(isRunActive).sort((a, b) => b.startedAt - a.startedAt)[0];
  if (active) return active;
  return all
    .filter((r) => r.endedAt && now - r.endedAt < LINGER_MS)
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))[0];
}

/** What the page knows of the workflows (each house's own): ClientState has it. */
type Lists = Pick<ClientState, 'workflows' | 'houseWorkflows'>;

/** The saved workflow a run ran: its house's workflow with that id. */
export function workflowOf(s: Lists, run: WorkflowRun): Workflow | undefined {
  return houseWorkflowOf(s, run.projectId, run.workflowId);
}

/** A one-off team the lead made for this task (no saved workflow behind it). */
export function isAdhocRun(run: WorkflowRun): boolean {
  return !!run.adhoc || run.workflowId === '';
}

/** The people of a run: run.team (the run's own plan — one-off teams are in no workflow, a workflow may have changed
 *  since, and its later steps may have changed while it ran), else the workflow's steps (runs saved before teams), else the steps the run worked through. */
export function runTeam(s: Lists & Pick<ClientState, 'agents'>, run: WorkflowRun): TeamMember[] {
  if (run.team?.length) return run.team.map((m) => ({ ...m }));
  const wf = workflowOf(s, run);
  if (wf) return wf.steps.map((x) => ({ id: x.id, name: x.name, model: x.model, kind: x.kind, loopBackTo: x.loopBackTo, maxLoops: x.maxLoops, parallel: x.parallel }));
  const out: TeamMember[] = [];
  for (const st of run.steps) {
    if (out.some((m) => m.id === st.stepId)) continue;
    const a = s.agents[st.agentId];
    out.push({ id: st.stepId, name: a?.name ?? st.stepId, model: a?.model ?? '', kind: st.verdict ? 'review' : 'work', agentId: st.agentId });
  }
  return out;
}

/** The run as a workflow, for views that draw one (the room's corkboard): its team, or its workflow, or — a run from
 *  before teams whose workflow was deleted since — the people it worked through (runTeam). */
export function runAsWorkflow(s: Lists & Pick<ClientState, 'agents'>, run: WorkflowRun): Workflow | null {
  const wf = workflowOf(s, run);
  if (!run.team?.length && wf) return wf;
  const team = runTeam(s, run);
  if (!team.length) return null;
  return {
    id: run.workflowId,
    name: run.workflowName,
    description: wf?.description ?? '',
    icon: wf?.icon ?? '👥',
    steps: team.map((m) => ({ id: m.id, name: m.name, model: m.model, kind: m.kind, loopBackTo: m.loopBackTo, parallel: m.parallel, persona: '', instruction: '' })),
  };
}

/** The active run this person works for — their chat waits until it ends. Runs that list their team lock only those
 *  people (the lead and its helpers stay free); runs saved without a team lock every team member of their job. */
export function lockingRun(a: Pick<AgentInfo, 'id' | 'kind' | 'projectId' | 'jobId'>, runs: WorkflowRun[]): WorkflowRun | undefined {
  const active = runs.filter((r) => isRunActive(r) && r.projectId === a.projectId);
  const mine = active.find((r) => r.team?.some((m) => m.agentId === a.id));
  if (mine) return mine;
  if (a.kind !== 'role') return undefined;
  const job = a.jobId ?? MAIN_JOB;
  return active.find((r) => !r.team?.length && (r.jobId ?? MAIN_JOB) === job);
}

/** Every step working now (a parallel group has several). */
export function currentSteps(run: WorkflowRun): string[] {
  if (run.currentStepIds?.length) return run.currentStepIds;
  return run.currentStepId ? [run.currentStepId] : [];
}

/** This person waits for the user (an approval card, or the server says so). */
function asking(s: Pick<ClientState, 'agents'> & Partial<Pick<ClientState, 'approvals'>>, agentId: string): boolean {
  return s.agents[agentId]?.activity === 'waiting_approval' || Object.values(s.approvals ?? {}).some((a) => a.agentId === agentId);
}

/** A running attempt waits when the run does — in a parallel group only the one who asks (the others keep working). */
export function attemptWaits(s: Pick<ClientState, 'agents'> & Partial<Pick<ClientState, 'approvals'>>, run: WorkflowRun, step: WorkflowRunStep): boolean {
  if (step.status !== 'running' || run.status !== 'waiting_approval') return false;
  const working = currentSteps(run).length || run.steps.filter((x) => x.status === 'running').length;
  return working <= 1 || asking(s, step.agentId);
}

function attemptStatus(s: Pick<ClientState, 'agents'> & Partial<Pick<ClientState, 'approvals'>>, run: WorkflowRun, step: WorkflowRunStep): ChipStatus {
  if (step.status === 'running') return attemptWaits(s, run, step) ? 'waiting' : 'running';
  return step.status;
}

/** One chip per person of the run; status comes from that step's latest attempt. */
export function stepChips(s: Lists & Pick<ClientState, 'agents' | 'models'> & Partial<Pick<ClientState, 'approvals'>>, run: WorkflowRun): StepChip[] {
  const team = runTeam(s, run);
  // steps the run worked through that its team doesn't list (a workflow edited since) still get a chip
  for (const st of run.steps) if (!team.some((m) => m.id === st.stepId)) team.push({ id: st.stepId, name: s.agents[st.agentId]?.name ?? st.stepId, model: s.agents[st.agentId]?.model ?? '', kind: 'work' });
  return team.map((def, i) => {
    const attempts = run.steps.filter((x) => x.stepId === def.id);
    const last = attempts[attempts.length - 1];
    const agent = last ? s.agents[last.agentId] : undefined;
    const model = def.model || agent?.model || '';
    return {
      stepId: def.id,
      name: def.name || agent?.name || def.id,
      vendor: agent?.vendor ?? vendorOfModel(model, s.models),
      modelLabel: agent?.modelLabel ?? modelLabel(model, s.models),
      status: last ? attemptStatus(s, run, last) : 'pending',
      attempts: attempts.length,
      verdict: [...attempts].reverse().find((a) => a.verdict)?.verdict,
      agentId: last?.agentId ?? def.agentId,
      parallel: i > 0 && !!def.parallel,
      ...(last?.reused ? { reused: true } : {}),
    };
  });
}

/** Where each parallel group of a team ends: index → the index of the last person of its group. The first person
 *  never works beside an earlier one (as stepGroups in plans.ts). */
function groupEnd(team: { parallel?: boolean }[], i: number): number {
  let j = i;
  while (j + 1 < team.length && team[j + 1].parallel) j++;
  return j;
}

/** The latest attempt of each step of a run. */
function lastAttempts(run: WorkflowRun): Map<string, WorkflowRunStep> {
  const out = new Map<string, WorkflowRunStep>();
  for (const st of run.steps) out.set(st.stepId, st);
  return out;
}

/** How far the run got in its current pass: the index (in its team) of the last person reached since the last loop
 *  back, moved to the end of that person's parallel group (a group starts together). -1 when nobody started. */
export function reachedThrough(run: WorkflowRun, team: { id: string; parallel?: boolean }[]): number {
  let last = -1;
  for (const st of run.steps) {
    const idx = team.findIndex((x) => x.id === st.stepId);
    if (idx < 0) continue;
    last = idx < last ? idx : Math.max(last, idx);
  }
  if (last < 0) return -1;
  let start = 0;
  while (groupEnd(team, start) < last) start = groupEnd(team, start) + 1;
  return groupEnd(team, start);
}

/** The steps a run that ended can be run again from (continue_run), as step id → the first step of its parallel
 *  group (the whole group works again). Walks the groups in order and stops after the first one whose people didn't
 *  all finish their latest attempt: every step before the start must keep a finished result. A run whose files were
 *  reverted only from its first group — and a result kept from an earlier run (a continuation) whose files were
 *  reverted since can't be kept either (`runs`: the runs known, to look that up). Empty while the run is going. The
 *  server checks again and has the last word. */
export function continuableSteps(run: WorkflowRun, team: { id: string; parallel?: boolean }[], runs: Record<string, WorkflowRun> = {}): Map<string, string> {
  const out = new Map<string, string>();
  if (isRunActive(run)) return out;
  const last = lastAttempts(run);
  for (let i = 0; i < team.length; ) {
    const end = groupEnd(team, i);
    const group = team.slice(i, end + 1);
    for (const m of group) out.set(m.id, group[0].id);
    if (run.revertedAt || !group.every((m) => last.get(m.id)?.status === 'done' && !keptFromReverted(last.get(m.id)!, runs))) break;
    i = end + 1;
  }
  return out;
}

/** A kept row (continuation) whose result was made in a run whose files were reverted since (followed through
 *  continuations of continuations, as far as the runs are known). */
export function keptFromReverted(attempt: WorkflowRunStep, runs: Record<string, WorkflowRun>): boolean {
  let at: WorkflowRunStep | undefined = attempt;
  for (let hops = 0; at?.reused && hops < 100; hops++) {
    const src: WorkflowRun | undefined = runs[at.reused.runId];
    if (!src) return false;
    at = src.steps[at.reused.index];
    if (at && !at.reused && src.revertedAt) return true;
  }
  return false;
}

/** Later runs that continue this one (continue_run), newest first. */
export function continuedBy(s: Pick<ClientState, 'runs'>, run: Pick<WorkflowRun, 'id'>): WorkflowRun[] {
  return Object.values(s.runs)
    .filter((r) => r.continues?.runId === run.id)
    .sort((a, b) => b.startedAt - a.startedAt);
}

export function runElapsed(run: WorkflowRun, now = Date.now()): number {
  return (run.endedAt ?? now) - run.startedAt;
}

/** How long something waited for the user so far: its closed waits plus the one going on now (ms). */
export function waitedFor(x: { waitedMs?: number; waitingSince?: number }, now = Date.now()): number {
  return (x.waitedMs ?? 0) + (x.waitingSince !== undefined ? Math.max(0, now - x.waitingSince) : 0);
}

/** A step attempt's working time: from its start to its end (or now), minus the time it waited for the user. null for
 *  an attempt that hasn't started, or one kept from an earlier run (it didn't work in this run). */
export function workedFor(st: WorkflowRunStep, now = Date.now()): number | null {
  if (st.startedAt == null || st.reused) return null;
  return Math.max(0, (st.endedAt ?? now) - st.startedAt - waitedFor(st, now));
}

/** A run's working time: its elapsed time minus the time it waited for the user. */
export function runWorked(run: WorkflowRun, now = Date.now()): number {
  return Math.max(0, runElapsed(run, now) - waitedFor(run, now));
}

export const RUN_STATUS_TEXT: Record<WorkflowRun['status'], string> = {
  running: 'Running',
  waiting_approval: 'Waiting for you',
  completed: 'Completed',
  failed: 'Failed',
  aborted: 'Stopped',
};
