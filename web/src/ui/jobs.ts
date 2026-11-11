// Jobs (one job = one room = its own people and chats): kind metadata, live status summaries and the
// "which job are the panels acting on" choice shared by the side panel, palette, dialogs and floor switcher.
import type { AgentInfo, Job, JobKind, Project, RoomRef, Vendor, WorkStyle } from '../../../shared/protocol';
import { roomCode } from '../../../shared/house-plan';
import { agentsState, blockOpts } from './agents-health';
import { agentBlocked, agentStatusText, agentTone, anyConnected, modelLabel, problemWord, vendorOfModel, type StatusTone } from './format';
import { pendingPlans } from './plans';
import type { Shell } from './shell';

export const MAIN_JOB = 'main';

export interface KindInfo {
  id: JobKind;
  name: string;
  blurb: string;
  lead: string; // what the lead is usually called
  accent: string;
  placeholder: string; // name suggestion in the new-job dialog
  model: string; // default lead model for this kind
}

export const KINDS: KindInfo[] = [
  { id: 'general', name: 'General', blurb: 'Plan, ask, tidy up', lead: 'Assistant', accent: '#F5C26B', placeholder: 'Weekly cleanup', model: 'anthropic/claude-sonnet-5-5' },
  { id: 'code', name: 'Code', blurb: 'Build, fix, test', lead: 'Developer', accent: '#6FB7E8', placeholder: 'Reader website', model: 'anthropic/claude-sonnet-5-5' },
  { id: 'write', name: 'Write', blurb: 'Draft, edit, polish', lead: 'Writer', accent: '#E58E73', placeholder: 'Write chapter 4', model: 'anthropic/claude-opus-5-5' },
  { id: 'research', name: 'Research', blurb: 'Read, search, sum up', lead: 'Researcher', accent: '#A58CF0', placeholder: 'Market research', model: 'google/gemini-4-argon' },
];

export function kindInfo(kind: JobKind | undefined): KindInfo {
  return KINDS.find((k) => k.id === kind) ?? KINDS[0];
}

/** How a job's lead goes about an ask (Job.workStyle). `hint` takes the lead's name ("Assistant", "Developer"…). */
export const WORK_STYLES: { id: WorkStyle; label: string; short: string; hint(lead: string): string }[] = [
  { id: 'ask', label: 'Show me the plan first', short: 'plan card first', hint: (lead) => `The ${lead} decides how; before a team starts you see who does what on which model, and can change it.` },
  { id: 'auto', label: 'Just go', short: 'no plan card', hint: (lead) => `The ${lead} decides how and starts right away — alone, with helpers or with a team.` },
  { id: 'solo', label: 'Only when I ask', short: 'teams on request', hint: (lead) => `The ${lead} works alone; helpers and teams only when you ask for them.` },
];

export function floorName(floor: number): string {
  return `Floor ${floor + 1}`;
}

export function jobRoomCode(job: Pick<Job, 'room'>): string {
  return roomCode(job.room.floor, job.room.slot);
}

export function projectFloors(p: Project | undefined): number {
  return Math.max(1, Math.floor(p?.floors ?? 1));
}

export interface JobStatus {
  job: Job;
  people: AgentInfo[];
  lead?: AgentInfo;
  leadName: string;
  leadModel: string;
  leadModelLabel: string;
  vendor: Vendor;
  tone: StatusTone;
  busy: number;
  waiting: number;
  cost: number;
  runActive: boolean;
  text: string; // one-line status for rows and tooltips
  problem?: string; // tone 'error': the word for what went wrong ("Couldn’t start", "Interrupted")
}

const TONE_RANK: Record<StatusTone, number> = { wait: 5, error: 4, work: 3, ok: 2, idle: 1, off: 0 };

export function jobStatus(shell: Shell, job: Job): JobStatus {
  const s = shell.store.state;
  const people = shell.store.agentsOfJob(job.projectId, job.id);
  const lead = people.find((a) => a.kind === 'resident') ?? people.find((a) => a.kind !== 'subagent');
  const ids = new Set(people.map((a) => a.id));
  // tool approvals of its people, plus plan cards its lead waits on
  const waiting = Object.values(s.approvals).filter((a) => ids.has(a.agentId)).length + pendingPlans(s, { projectId: job.projectId, jobId: job.id }).length;
  let tone: StatusTone = people.length ? 'off' : 'idle';
  let busy = 0;
  let cost = 0;
  for (const a of people) {
    const t = agentTone(a);
    if (t === 'work') busy++;
    if (TONE_RANK[t] > TONE_RANK[tone]) tone = t;
    cost += a.costUsd ?? 0;
  }
  if (waiting) tone = 'wait';
  if (tone === 'off') tone = 'idle'; // nobody has started yet: that's "ready", not broken
  const runActive = Object.values(s.runs).some(
    (r) => r.projectId === job.projectId && (r.jobId ?? MAIN_JOB) === job.id && (r.status === 'running' || r.status === 'waiting_approval'),
  );
  const leadModel = lead?.model ?? job.leadModel;
  const working = people.find((a) => agentTone(a) === 'work');
  const failing = tone === 'error' ? people.find((a) => agentTone(a) === 'error') : undefined;
  // Nothing going on and the lead can't start (their model isn't connected): say why instead of "Ready" — tone 'off',
  // not 'error' (no red dot on the elevator)
  const cantStart = !waiting && !failing && !working && !runActive && lead && agentBlocked(lead, s.models, blockOpts(s.hello)) ? cantStartWord(shell) : null;
  if (cantStart) tone = 'off';
  const text = waiting
    ? `${waiting} waiting for you`
    : failing
      ? `${failing.name}: ${agentStatusText(failing)}`
      : working
        ? busy > 1
          ? `${busy} people working`
          : `${working.name}: ${working.detail ?? 'working'}`
        : runActive
          ? 'Team run in progress'
          : (cantStart ?? 'Ready');
  return {
    job,
    people,
    lead,
    leadName: lead?.name ?? kindInfo(job.kind).lead,
    leadModel,
    leadModelLabel: lead?.modelLabel ?? modelLabel(leadModel, s.models),
    vendor: lead?.vendor ?? vendorOfModel(leadModel, s.models),
    tone,
    busy,
    waiting,
    cost,
    runActive,
    text,
    ...(failing ? { problem: problemWord(failing) } : {}),
  };
}

/** Why a lead can't start, in a word or two (the chat says more). */
function cantStartWord(shell: Shell): string {
  const s = shell.store.state;
  const st = agentsState(s.hello).kind;
  if (st === 'omp-missing') return 'No agent';
  if (st === 'check-failed') return 'Check failed';
  return anyConnected(s.models) ? 'Not connected' : 'No AI account';
}

export interface FloorStatus {
  floor: number;
  jobs: Job[];
  busy: number;
  waiting: number;
  /** Jobs on this floor whose people hit an error (the elevator button shows a red dot). */
  errors: number;
}

export function floorStatuses(shell: Shell, projectId: string): FloorStatus[] {
  const project = shell.store.project(projectId);
  const n = projectFloors(project);
  const jobs = shell.store.jobsOf(projectId);
  const out: FloorStatus[] = [];
  for (let f = 0; f < n; f++) {
    const here = jobs.filter((j) => j.room.floor === f);
    let busy = 0;
    let waiting = 0;
    let errors = 0;
    for (const j of here) {
      const st = jobStatus(shell, j);
      busy += st.busy;
      waiting += st.waiting;
      if (st.tone === 'error') errors++;
    }
    out.push({ floor: f, jobs: here, busy, waiting, errors });
  }
  return out;
}

export function jobAt(shell: Shell, projectId: string, room: RoomRef): Job | undefined {
  return shell.store.jobsOf(projectId).find((j) => j.room.floor === room.floor && j.room.slot === room.slot);
}

/** Which job the panels act on, per house. Inside the current house this is the store's currentJobId; for a
 *  house the panel shows from the city (palette, focus mode) the choice is remembered here. */
export function createJobChoice(shell: Shell) {
  const { store, bus } = shell;
  const picked = new Map<string, string>();
  return {
    active(projectId: string | null | undefined): Job | undefined {
      if (!projectId) return undefined;
      if (projectId !== store.state.currentProjectId) {
        const id = picked.get(projectId);
        const j = id ? store.job(projectId, id) : undefined;
        if (j) return j;
      }
      return store.activeJob(projectId);
    },
    /** focus: also ask the house to show that job's floor and frame its room (when we are in that house). */
    select(projectId: string, jobId: string, opts: { focus?: boolean } = {}) {
      picked.set(projectId, jobId);
      if (projectId === store.state.currentProjectId) store.setLocal({ currentJobId: jobId });
      else store.setLocal({});
      if (opts.focus && shell.view.view === 'house' && shell.view.projectId === projectId) bus.emit('job:select', { projectId, jobId });
    },
    /** After entering a house: carry over a choice made while looking at it from the city. */
    onEnter(projectId: string) {
      const id = picked.get(projectId);
      if (id && store.job(projectId, id) && store.state.currentJobId !== id) store.setLocal({ currentJobId: id });
    },
  };
}

export type JobChoice = ReturnType<typeof createJobChoice>;
