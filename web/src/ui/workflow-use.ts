// Who uses a workflow in its house, and what the Workflow tab's delete says about it. The server counts teams the same
// way (agent-system #teamsOf): a job's own team, and for the Main job its house's team when the job has none of its own.
// A saved workflow belongs to one house (shared/house-workflows.ts), so only that house's jobs and runs count: another
// house with a workflow of the same id has its own copy. A workflow that is some job's team is deleted only when the
// user says so (those jobs get no fixed team); one that is running is never deleted: the dialog offers to stop the run
// first.
import type { Job, Project, Workflow } from '../../../shared/protocol';
import type { ClientState } from '../core/types';
import { listJoin } from './format';
import { isRunActive } from './runs';

const MAIN_JOB = 'main';

/** A job's team: its own, or for the Main job the house's (houses made before jobs existed keep it there). */
export function teamOfJob(job: Pick<Job, 'id' | 'workflowId'> | undefined, project: Pick<Project, 'workflowId'> | undefined): string | null {
  if (!job) return project?.workflowId ?? null;
  return job.workflowId ?? (job.id === MAIN_JOB ? (project?.workflowId ?? null) : null);
}

export interface WorkflowUse {
  /** Every job of the house whose team it is; label: the job's name ("House / Job" when everywhere). */
  teams: { projectId: string; jobId: string; label: string }[];
  /** Its runs going now in the house; label: the name of the job they run in ("House / Job" when everywhere). */
  runs: { runId: string; label: string }[];
  /** An older server: one list every house sees, so every house's jobs and runs count (and it refuses a delete
   *  while another house's job has it as its team). */
  everywhere: boolean;
}

/** The house's workflow `workflowId`: the house's jobs that have it as their team, and its runs going there now. */
export function workflowUse(s: Pick<ClientState, 'city' | 'jobs' | 'runs' | 'houseWorkflows'>, projectId: string, workflowId: string): WorkflowUse {
  const everywhere = !s.houseWorkflows;
  const houses = everywhere ? s.city.projects.map((p) => p.id) : [projectId];
  const label = (pid: string, job: string) => (everywhere ? `${s.city.projects.find((x) => x.id === pid)?.name ?? pid} / ${job}` : job);
  const teams: WorkflowUse['teams'] = [];
  for (const pid of houses) {
    const p = s.city.projects.find((x) => x.id === pid);
    for (const j of s.jobs[pid] ?? []) if (teamOfJob(j, p) === workflowId) teams.push({ projectId: pid, jobId: j.id, label: label(pid, j.name) });
  }
  const runs: WorkflowUse['runs'] = [];
  for (const r of Object.values(s.runs)) {
    if (!houses.includes(r.projectId) || r.workflowId !== workflowId || !isRunActive(r)) continue;
    const j = s.jobs[r.projectId]?.find((x) => x.id === (r.jobId ?? MAIN_JOB));
    runs.push({ runId: r.id, label: label(r.projectId, j?.name ?? 'Main') });
  }
  return { teams, runs, everywhere };
}

const quoted = (names: string[]) => [...new Set(names)].map((n) => `“${n}”`);

/** The delete dialog: a plain delete; "Stop using it and delete" (clearTeams) for some job's team; or, while it runs,
 *  "Stop the run" (stopRuns) — it is deleted after the run, never during it. Only the house's copy goes: inLibrary,
 *  the library has a workflow with its id (which stays). */
export function deleteAsk(
  wf: Pick<Workflow, 'name' | 'steps'>,
  use: WorkflowUse,
  o: { inLibrary?: boolean } = {},
): { title: string; text: string[]; confirmLabel: string; clearTeams: boolean; stopRuns: boolean } {
  if (use.runs.length) {
    return {
      title: `“${wf.name}” is running`,
      text: [
        `It is running in ${listJoin(quoted(use.runs.map((r) => r.label)))} right now, and a workflow can’t be deleted while it runs.`,
        'Stop the run first, then delete it. Files the team already changed stay as they are.',
      ],
      confirmLabel: use.runs.length === 1 ? 'Stop the run' : 'Stop the runs',
      clearTeams: false,
      stopRuns: true,
    };
  }
  const n = wf.steps.length;
  const text = [`The workflow and its ${n} ${n === 1 ? 'person' : 'people'} ${use.everywhere ? 'go away' : 'leave this house'}. Past runs, their files and chats stay.`];
  const one = use.teams.length === 1;
  if (use.teams.length) {
    text.push(
      `It is the team of ${listJoin(quoted(use.teams.map((t) => t.label)))}${use.everywhere ? '' : ' in this house'}. Deleting it leaves ${one ? 'that job' : 'those jobs'} with no fixed team: ${one ? 'its lead picks' : 'their leads pick'} a team for each task.`,
    );
  }
  if (o.inLibrary) text.push('The library keeps its copy: any house can still import it.');
  return {
    title: `Delete “${wf.name}”?`,
    text,
    confirmLabel: use.teams.length ? 'Stop using it and delete' : 'Delete workflow',
    clearTeams: use.teams.length > 0,
    stopRuns: false,
  };
}
