// Who lives in a house: per job, its lead (kind 'resident') plus one person per step of the job's team
// (workflow). Every person knows which job they belong to, the other jobs of the house, and to stay in scope.
import { DEFAULT_WORK_STYLE, runsPerAsk, THINKING_LEVELS, type AgentInfo, type Job, type JobKind, type ModelOwner, type Project, type ThinkingLevel, type Workflow, type WorkflowStep, type WorkStyle } from '../../shared/protocol';
import { agentIdFor, MAIN_JOB_ID, sessionDirFor, transcriptDirFor } from '../data-layout';
import type { ModelRegistry } from './models';
import { vendorOf } from './models';
import { hash32, truncate } from './util';

export { agentIdFor };

export interface ResidentSpec {
  agentId: string;
  projectId: string;
  jobId: string;
  roleId: string;
  kind: 'resident' | 'role';
  name: string;
  model: string; // requested catalog selector
  persona: string;
  thinking?: string;
  stepKind?: WorkflowStep['kind'];
  /** Leads: the job's advisor model (Job.advisorModel) — a second model that reviews each turn. */
  advisorModel?: string;
}

/** Every lead keeps this role id (and the [rlt-role:assistant] marker the scripted test model keys off), whatever the
 *  job kind. */
export const ASSISTANT_ROLE = 'assistant';

export const LEAD_NAMES: Record<JobKind, string> = {
  general: 'Assistant',
  code: 'Developer',
  write: 'Writer',
  research: 'Researcher',
};

const FLAVOUR: Record<JobKind, string> = {
  general: 'Help with anything in this project: answer questions, explain what is here (code, notes or documents), make focused changes.',
  code:
    'You are the developer: read the relevant code before changing it, make small focused edits that match the existing style, ' +
    'add or update tests for what you change, and run them when you can.',
  write:
    'You are the writer: draft, revise and polish prose in the language and voice the project already uses, keep continuity ' +
    'with what is written, and put longer text into files rather than only in chat.',
  research:
    'You are the researcher: dig through the project (and the web when you have it), compare sources, and report findings with ' +
    'file paths or links; write longer notes into a file and summarize them in chat.',
};

export function residentAppearance(id: string): AgentInfo['appearance'] {
  const h = hash32(id);
  return { seed: h, gender: (h >>> 7) & 1 ? 'f' : 'm' };
}

export function sessionDirOf(dataDir: string, spec: ResidentSpec): string {
  return sessionDirFor(dataDir, spec.projectId, spec.jobId, spec.roleId);
}

export function transcriptDirOf(dataDir: string, spec: ResidentSpec): string {
  return transcriptDirFor(dataDir, spec.projectId, spec.jobId, spec.roleId);
}

const quote = (s: string) => `“${s}”`;

/** What a job with its own copy of the files (Job.worktree) is told about it. */
function ownCopy(job: Job): string {
  const wt = job.worktree!;
  return (
    `You work in your own copy of the house's files (a git worktree at ${wt.path}, branch ${wt.branch}), not in the house's folder. ` +
    "Other jobs and the house don't see your changes until the user brings them in (Changes tab → Bring into house), and you don't see theirs. " +
    "Files git ignores, such as node_modules, build output or .env, aren't in your copy: install dependencies (e.g. bun install / npm install) before you run or test, and ask the user for secrets you need. " +
    'Commit only if the user asks (your commits stay on that branch).'
  );
}

/** The job part of every persona: which job, its brief, the other jobs of the house (names + briefs) and the
 *  scope rule. Room codes are left out on purpose: moving a room must not change anyone's system prompt (that
 *  restarts their omp process). Empty for a house with a single job and no brief. */
export function jobContext(project: Project, job: Job, allJobs: Job[]): string {
  // Oldest first, not by room: moving a room must not reorder (and so change) anyone's prompt.
  const others = allJobs.filter((j) => j.id !== job.id).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const brief = job.brief.trim();
  if (!others.length && !brief && !job.worktree) return '';
  const lines: string[] = [`Your job in this house: ${quote(job.name)}.`];
  if (brief) lines.push(`Brief for everyone in this job:\n${brief}`);
  if (job.worktree) lines.push(ownCopy(job));
  const line = (j: Job) => `- ${quote(j.name)}${j.brief.trim() ? `: ${truncate(j.brief.trim().replace(/\s+/g, ' '), 300)}` : ''}`;
  const shared = others.filter((j) => !j.worktree);
  const copies = others.filter((j) => j.worktree);
  if (others.length) {
    if (job.worktree) {
      lines.push(`Other jobs in the "${project.name}" house — other people work on them at the same time, outside your copy:\n${others.map(line).join('\n')}`);
    } else {
      if (shared.length) lines.push(`Other jobs in the "${project.name}" house — other people work on them at the same time, in the same folder:\n${shared.map(line).join('\n')}`);
      if (copies.length) {
        lines.push(
          `${shared.length ? 'These jobs' : `Other jobs in the "${project.name}" house`} work at the same time in their own copy of the files — you don't see their changes until the user brings them into the house:\n${copies.map(line).join('\n')}`,
        );
      }
    }
    lines.push(
      "Stay within your job's scope: don't edit files or redo work that belongs to another job. If a request clearly belongs to another job, say which one and suggest asking there.",
    );
  } else {
    lines.push("Stay within your job's scope.");
  }
  return lines.join('\n\n');
}

/** How the lead decides between working alone, helpers and a team ('ask'/'auto': on its own, Claude Code style).
 *  `runs`: the house's loop guard per message of the user (runsPerAsk). */
const decide = (runs: number) =>
  'Decide how to do each ask yourself; the user states goals, not methods. Work alone for questions and for changes you can finish and check in one sitting — most asks. ' +
  'Use the task tool (one batch) for independent parts — many files to search or check, options to compare — then merge what the helpers found. ' +
  'Use team_start for staged work that must be right: build then check, long writing with an edit pass, or a review the user asked for. ' +
  "Prefer this job's team or a fitting workflow of this house (workflow_id); otherwise pass steps for a one-off team of 2–4 people, each on the model that suits the duty: " +
  'connected models only, a reviewer from another vendor with loopBackTo, cheaper models for bulk work, parallel:true for independent parts that can be done at the same time (give each a separate part). ' +
  "Follow the user's model choices (workflow_list shows them) and anything they said about models. Give the team a complete brief — it doesn't see this chat. " +
  'Say in one line what you chose and why, then end your turn. ' +
  `When a team update shows more work is needed, you may start another team for the same ask without asking (at most ${runs} runs per message); otherwise sum up for the user. ` +
  "When only a later part of a team's work must change — the user asks to redo or fix just the review, the last step or the rest, or a run failed or was stopped partway (one the user stopped: only when they ask) — continue that run with team_continue from the first step that must change (team_status shows the step ids): the steps before it keep their results and the files stay as they are. " +
  "Start the whole team again with team_start only when the early steps' results are wrong too or the task itself changed. " +
  "While a team runs, a change to its later steps (a step that hasn't started: its prompt, persona, model or effort; adding, removing or moving later steps) goes into the running team with team_edit: it keeps going, finished steps keep their results and nobody working is interrupted. Never stop and restart a team for that. " +
  'Only a change to a step that finished or works now redoes work — say what and ask the user first. team_edit changes this run only (save: true only when the user wants the workflow changed for next time too). ' +
  "Don't edit files while your team runs. If the user says how to do it, do it that way.";
const PLAN_CARD = "The first team you start after each message of the user shows them a plan card; they can change models or cancel — team_start's result tells you what they chose.";
/** Goal mode (the user sets a goal from the chat menu; omp then keeps the lead going turn after turn). */
const GOAL =
  'The user may set you a goal: then you keep working on it on your own, turn after turn, until it is done — say in a line or two what you did after each step, ' +
  'and mark the goal complete with the goal tool only when it really is. Teams you start for a goal count against it (at most 20 runs per goal).';

/** Designing teams from chat: the same in every work style. */
const DESIGN = [
  "The user can also ask you to design or change a team: look at workflow_list first (the connected models, this house's teams and the library).",
  'If the ask is clear, save it right away with workflow_save (use_for_this_job when they want it for this job) and tell them in a few lines who does what with which model; ask only when you cannot tell what the steps should be.',
  "A workflow you save is this house's own: other houses don't see it. Change an existing one (replace) only when the user asks for that one.",
  'To change a team other jobs of this house use, for this job only, save your version as a new workflow with use_for_this_job.',
  "The library holds workflows the user promoted from any house: to use one here, workflow_import it first (then it is this house's own copy). Put one of this house's workflows in the library (workflow_promote) only when the user asks.",
  'After team_assign or use_for_this_job, wait for the result before team_start.',
];

function leadPersona(project: Project, job: Job, allJobs: Job[]): string {
  const name = LEAD_NAMES[job.kind];
  const style: WorkStyle = job.workStyle ?? DEFAULT_WORK_STYLE;
  const intro =
    job.id === MAIN_JOB_ID && allJobs.length <= 1
      ? `You are the ${name} who lives in the "${project.name}" house in CAST, a friendly town where every project is a house.`
      : `You are the ${name} who leads the ${quote(job.name)} job in the "${project.name}" house in CAST, a friendly town where every project is a house and every job is a room.`;
  const helpers = [
    'Helpers work in the background: hand out the work, tell the user in a line who does what, and end your turn — do not call wait unless the user asks you to wait.',
    'The user can keep talking to you meanwhile; when they ask how the helpers are doing, read proc:// and answer briefly. When the helpers report back, sum up what they found.',
    "Pick a helper's model with the task item's agent (rlt-* helpers, connected models only).",
  ];
  const team =
    style === 'solo'
      ? [
          'This job can also have a team (its workflow, set in the Workflow tab).',
          'When the user wants the team to do something, start it with team_start and stay available — the team works on its own.',
          'Check on it with team_status, stop it with team_stop only when the user asks.',
          'To redo only part of a run, use team_continue from the first step that must change; team_start always starts the whole team from its first step.',
          "To change a running team's later steps use team_edit — never stop and restart it for that.",
          'A message starting with "[RLT team update]" comes from CAST when a run you started ends: tell the user briefly what the team did and what to check — when only part needs redoing, offer to continue from that step rather than starting over.',
          PLAN_CARD,
        ]
      : [
          decide(runsPerAsk(project)),
          ...(style === 'ask' ? [PLAN_CARD] : []),
          'Check on a team with team_status, stop it with team_stop only when the user asks.',
          'A message starting with "[RLT team update]" comes from CAST when a team run ends: tell the user briefly what the team did and what to check — when only part needs redoing, offer to continue from that step rather than starting over.',
        ];
  return [
    [intro, FLAVOUR[job.kind], 'Keep replies short and concrete, reference real file paths, and prefer small safe edits.', ...(style === 'solo' ? ['When the user asks for helpers or parallel work, delegate with the task tool.'] : []), ...helpers].join(' '),
    [...team, ...DESIGN, GOAL, `[rlt-work-style:${style}]`].join(' '),
    jobContext(project, job, allJobs),
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function leadSpec(project: Project, job: Job, allJobs: Job[]): ResidentSpec {
  return {
    agentId: agentIdFor(project.id, job.id, ASSISTANT_ROLE),
    projectId: project.id,
    jobId: job.id,
    roleId: ASSISTANT_ROLE,
    kind: 'resident',
    name: LEAD_NAMES[job.kind],
    model: job.leadModel,
    thinking: job.leadThinking,
    persona: leadPersona(project, job, allJobs),
    ...(job.advisorModel ? { advisorModel: job.advisorModel } : {}),
  };
}

export function stepSpec(project: Project, job: Job, step: WorkflowStep, allJobs: Job[]): ResidentSpec {
  const persona = [step.persona.trim(), `You are on the team of the ${quote(job.name)} job in the "${project.name}" house.`, jobContext(project, job, allJobs)]
    .filter(Boolean)
    .join('\n\n');
  return {
    agentId: agentIdFor(project.id, job.id, step.id),
    projectId: project.id,
    jobId: job.id,
    roleId: step.id,
    kind: 'role',
    name: step.name,
    model: step.model,
    persona,
    thinking: step.thinking,
    stepKind: step.kind,
  };
}

/** The people of one job: its lead, then its team (the job's workflow steps). */
export function residentsFor(project: Project, job: Job, workflow: Workflow | undefined, allJobs: Job[]): ResidentSpec[] {
  const out = [leadSpec(project, job, allJobs)];
  for (const step of workflow?.steps ?? []) {
    if (step.id === ASSISTANT_ROLE) continue;
    out.push(stepSpec(project, job, step, allJobs));
  }
  return out;
}

/** The text appended to omp's system prompt: persona + machine-readable role markers (the scripted test model keys
 *  off them). */
export function systemPromptFor(spec: ResidentSpec): string {
  const parts = [spec.persona.trim()];
  if (spec.stepKind === 'review') {
    parts.push('Finish every review with a fenced ```json block: {"verdict": "approve" | "revise", "notes": "…"}.');
  }
  parts.push(`[rlt-role:${spec.roleId}]`);
  if (spec.stepKind) parts.push(`[rlt-step-kind:${spec.stepKind}]`);
  return parts.join('\n\n');
}

/** Nobody is started on this model now: it isn't connected. Not while the very first check runs (a message waits
 *  for it), and never while the scripted test model stands in (CAST_MOCK_LLM, nothing connected). */
export function modelOff(models: Pick<ModelRegistry, 'demoActive' | 'isAvailable' | 'state'>, model: string): boolean {
  return !models.demoActive() && !models.isAvailable(model) && models.state !== 'checking';
}

/** Fresh offline AgentInfo for a resident (keeps live fields from `prev` when re-upserting). */
export function residentInfo(spec: ResidentSpec, models: ModelRegistry, prev: AgentInfo | undefined, threadId: string | undefined): AgentInfo {
  // Really on the scripted model (CAST_MOCK_LLM, nothing connected): its spend is simulated, never money.
  const demo = models.demoActive() && !models.isAvailable(spec.model);
  return {
    id: spec.agentId,
    projectId: spec.projectId,
    jobId: spec.jobId,
    kind: spec.kind,
    name: spec.name,
    roleId: spec.roleId,
    model: spec.model,
    modelLabel: models.label(spec.model),
    vendor: vendorOf(spec.model),
    demo,
    notConnected: modelOff(models, spec.model),
    status: prev?.status ?? 'offline',
    activity: prev?.activity ?? 'idle',
    detail: prev?.detail,
    tool: prev?.tool,
    tokens: prev?.tokens ?? { input: 0, output: 0 },
    costUsd: prev?.costUsd ?? 0,
    appearance: prev?.appearance ?? residentAppearance(spec.agentId),
    threadId: threadId ?? prev?.threadId,
    available: prev?.available,
    // live state the runtime keeps up to date (a re-sync must not drop it)
    context: prev?.context,
    queue: prev?.queue,
    goal: prev?.goal,
    ...(thinkingOf(spec) ? { thinking: thinkingOf(spec) } : {}),
    modelBy: modelOwner(spec),
    // the chat's account: the agent system sets it (it knows the accounts); kept until then
    ...(prev?.account ? { account: prev.account } : {}),
  };
}

/** Who sets this person's model and effort (AgentInfo.modelBy): a lead's job, a standing team member's workflow step,
 *  or the plan of the run a temporary (`x-`) person is on. */
export function modelOwner(spec: Pick<ResidentSpec, 'kind' | 'roleId'>): ModelOwner {
  return spec.kind === 'resident' ? 'job' : spec.roleId.startsWith('x-') ? 'run' : 'team';
}

/** The effort the person is set to (undefined: the default, which omp runs as 'high'). */
export function thinkingOf(spec: Pick<ResidentSpec, 'thinking'>): ThinkingLevel | undefined {
  return (THINKING_LEVELS as readonly string[]).includes(spec.thinking ?? '') ? (spec.thinking as ThinkingLevel) : undefined;
}
