// The lead's team tools: RLT registers them in every lead's omp (set_host_tools) and runs them here, so the lead can
// design workflows (teams) and set its job's team from chat, start a team — the job's own, any workflow of its house, or
// a one-off team made for the task (the WorkflowEngine run the Workflow tab starts) — redo only a later part of a run
// that ended (team_continue), check on it and stop it, and stay free to talk while the team works. The first team
// after each message of the user waits for the plan card (work style 'ask'/'solo', AgentSystem's PlanGate). omp asks
// approval for host tools like any exec tool; ApprovalBook answers these itself (the team's own steps still ask as the
// house's mode says). The defs are static on purpose: they are part of each lead's process spec key, so anything
// dynamic (models, workflows) goes into tool results. A saved workflow belongs to one house (the lead's: c.projectId);
// the shared library holds copies the user promoted, which a house imports to use (workflow-store.ts).
import { DEFAULT_WORK_STYLE, MAX_WORKFLOW_STEPS, THINKING_LEVELS, type Job, type LibraryWorkflow, type PlanStep, type RunEditOp, type TeamPlan, type ThinkingLevel, type Workflow, type WorkflowRun, type WorkflowStep, type WorkStyle } from '../../shared/protocol';
import type { JobStore } from '../contracts';
import { MAIN_JOB_ID } from '../data-layout';
import type { AgentStore } from './agent-store';
import type { ModelRegistry } from './models';
import type { HostToolDef } from './process-pool';
import { VERDICT_FOOTER } from './templates';
import { errorText, truncate } from './util';
import { applyRunEdit, editContext, editedText, parseRunEditOps, planRunEdit, type RunEditDeps } from './run-edit';
import { writtenStepId, type ContinuePlan, type WorkflowEngine } from './workflow-engine';
import { carryOver, changesSince, claimStepIds, keptText, mergeLeadSave } from './workflow-merge';
import { groupStarts, normalizeWorkflow, safeStepId, SLUG, slugify, type WorkflowStore } from './workflow-store';

export const LEAD_TOOL_NAMES = new Set(['team_start', 'team_continue', 'team_edit', 'team_status', 'team_stop', 'team_assign', 'workflow_list', 'workflow_get', 'workflow_save', 'workflow_delete', 'workflow_import', 'workflow_promote']);

/** The loop guard while the lead works toward a goal on its own (counted from when the goal was set or resumed); per
 *  message of the user it is the house's runsPerAsk (shared/protocol.ts). */
export const MAX_RUNS_PER_GOAL = 20;

/** The name of a one-off team the lead didn't name. */
export const ADHOC_NAME = 'Team for this task';
const ADHOC_ICON = '👥';
const MODEL_ID = /^[\w.-]+\/[\w./:@-]+$/;

const NO_ARGS = { type: 'object', properties: {}, additionalProperties: false };

const WORKFLOW_STEP_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', description: "ASCII slug [a-z0-9-], the person's role id. Leave out and CAST derives it from the name." },
    name: { type: 'string', description: 'Who this person is, in any language (≤ 40 characters), e.g. "Researcher" or "นักวิจัย".' },
    model: { type: 'string', description: 'A connected model id from workflow_list, e.g. anthropic/claude-opus-5-5.' },
    kind: { type: 'string', enum: ['work', 'review'], description: 'review = judges the previous work and ends with a JSON verdict (CAST adds the format). Default work.' },
    thinking: { type: 'string', enum: [...THINKING_LEVELS], description: 'How hard the model thinks: high for planning and review, medium for doing; xhigh or max for the hardest work, on models that have them (workflow_list says each model\'s top level; the agent lowers a level a model lacks).' },
    persona: { type: 'string', description: 'Who this person is and how they work (their system prompt, ≤ 4000 characters).' },
    instruction: {
      type: 'string',
      description:
        "This step's prompt; placeholders {{task}} {{prev}} {{prevName}} {{runDir}} {{feedback}}. Leave out and CAST writes a good default " +
        '(start with "Task: {{task}}", hand long work on in files under `{{runDir}}/`, end with what to reply).',
    },
    loopBackTo: { type: 'string', description: 'Review steps only: id or name of an EARLIER step that gets the work back on "revise".' },
    maxLoops: { type: 'integer', minimum: 0, maximum: 5, description: 'How often the work may go back (default 2, counted across the whole run).' },
    parallel: {
      type: 'boolean',
      description: 'true = works at the same time as the step before it (never the first step); give each one a separate part. The next step gets all their results.',
    },
  },
  required: ['name', 'model', 'persona'],
  additionalProperties: false,
};

export const LEAD_TOOLS: HostToolDef[] = [
  {
    name: 'team_start',
    label: 'Start a team',
    description:
      "Start a team on a task: this job's team (leave workflow_id and steps out), any workflow of this house (workflow_id — the job's team " +
      'stays as it is), or a one-off team made for this task (steps; its people leave after the run). ' +
      'Returns once the team starts; it works in the background while you keep talking with the user. You get a "[RLT team update]" ' +
      'message when the run ends. Write the task as a complete brief: the team does not see this chat. The first team after a message ' +
      'of the user may wait for the user to approve the plan (they can change models or cancel) — the result says what they chose. ' +
      'To redo only a later part of a run that ended, use team_continue — team_start always starts from the first step. ' +
      'A team already running in this job: change its later steps with team_edit, never stop and restart it.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'What the team should do, with every detail it needs.' },
        why: { type: 'string', description: 'One line for the user: why this team for this task (shown on the plan card).' },
        workflow_id: { type: 'string', description: 'Run this workflow of this house (from workflow_list) for this task. One in the library runs only after workflow_import.' },
        models: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'With workflow_id or the job\'s team: other connected models for some steps, this run only — {"<step id>": "<model id>"}.',
        },
        steps: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_WORKFLOW_STEPS,
          items: WORKFLOW_STEP_SCHEMA,
          description: `A one-off team for this task: the people in the order they work (1–${MAX_WORKFLOW_STEPS}), same fields as workflow_save.`,
        },
        name: { type: 'string', description: `The one-off team's name (default “${ADHOC_NAME}”).` },
      },
      required: ['task'],
      additionalProperties: false,
    },
    loadMode: 'essential',
  },
  {
    name: 'team_continue',
    label: 'Continue a team run',
    description:
      'Redo only part of a team run that ended (completed, failed or stopped): the steps before from_step are kept — their final replies feed {{prev}} as before and their hand-off files are copied — and from_step and every step after it work again, on the files as they are now (nothing is reverted). ' +
      'Use it whenever the user wants only a later part redone or fixed ("just redo the review", "fix only the last part", "แก้เฉพาะท่อนหลัง"), or a run failed or was stopped partway — team_start runs the whole team again from its first step. ' +
      "team_status shows each step's id and result. A review that sends the work back to an earlier step still works (that step runs again too). Same plan card and run limits as team_start; you get a \"[RLT team update]\" when it ends.",
    parameters: {
      type: 'object',
      properties: {
        from_step: { type: 'string', description: 'Id (or name) of the first step to run again, from team_status. A step that works at the same time as others runs again with its whole group.' },
        run_id: { type: 'string', description: "The run to continue (team_status lists this job's runs). Default: this job's latest run." },
        note: {
          type: 'string',
          description: "What must be different this time, as a complete instruction (the team does not see this chat). from_step's people get it with the earlier results, and again if the work comes back to them.",
        },
        task: { type: 'string', description: "Only when the task itself changed: the new brief for the steps that run. Default: the earlier run's task." },
        models: { type: 'object', additionalProperties: { type: 'string' }, description: 'Other connected models for steps that run again, this run only — {"<step id>": "<model id>"}.' },
        why: { type: 'string', description: 'One line for the user: why continue from this step (shown on the plan card).' },
      },
      required: ['from_step'],
      additionalProperties: false,
    },
    loadMode: 'essential',
  },
  {
    name: 'team_edit',
    label: 'Change the running team',
    description:
      "Change this job's team WHILE IT RUNS — the run keeps going: finished steps keep their results and the person working now is not restarted. " +
      "Use it for every change to later steps — a step that hasn't started yet: its prompt (instruction or add_to_instruction), persona, model, effort or review loop; adding a person; removing or moving steps that haven't started — and to send a note to the person working now. Never team_stop + team_start for that. " +
      'Changes apply to this run only; save: true also saves them to the workflow for next time (only when the user wants that). ' +
      'A change to a step that already finished or is working now means redoing work: the result says what — ask the user first, then call again with redo: true (the run stops and continues from that step; the steps before it keep their results).',
    parameters: {
      type: 'object',
      properties: {
        ops: {
          type: 'array',
          minItems: 1,
          maxItems: 20,
          description: 'The changes, applied in order, all or nothing.',
          items: {
            type: 'object',
            properties: {
              op: {
                type: 'string',
                enum: ['update', 'add', 'remove', 'move', 'note'],
                description: 'update = change a step that has not started yet; add = a new person; remove / move = a step that has not started yet; note = tell the person working now something (read at their next step).',
              },
              step: { type: 'string', description: 'update / remove / move / note: the step id (or name) from team_status.' },
              after: { type: 'string', description: 'add / move: the id (or name) of the step it comes after — the step working now = next. add without it: at the end.' },
              person: { ...WORKFLOW_STEP_SCHEMA, description: 'add: the new person (same fields as workflow_save steps; instruction left out = CAST writes one).' },
              name: { type: 'string' },
              model: { type: 'string', description: 'A connected model id from workflow_list.' },
              thinking: { type: 'string', enum: ['default', ...THINKING_LEVELS], description: "'default' = the model's default effort (drops one set before)." }, // never '' here: Gemini refuses a whole request with an empty enum value
              persona: { type: 'string' },
              instruction: { type: 'string', description: 'The whole new prompt (team_status with step shows the current one).' },
              add_to_instruction: { type: 'string', description: 'A paragraph added to the prompt — for small tweaks (a review gets it before its verdict format).' },
              kind: { type: 'string', enum: ['work', 'review'] },
              loopBackTo: { type: 'string', description: "Review: id or name of an earlier step, '' = none." },
              maxLoops: { type: 'integer', minimum: 0, maximum: 5 },
              parallel: { type: 'boolean' },
              text: { type: 'string', description: 'note: what they should know, as a complete instruction.' },
            },
            required: ['op'],
            additionalProperties: false,
          },
        },
        save: { type: 'boolean', description: 'true = also change the saved workflow for next time (not one-off teams). Only when the user asked.' },
        redo: { type: 'boolean', description: 'Only after the user agreed to redo finished or working steps: stop the run and continue it from the earliest step you change, with all the changes.' },
        why: { type: 'string', description: 'redo only: one line for the plan card.' },
      },
      required: ['ops'],
      additionalProperties: false,
    },
    loadMode: 'essential',
  },
  {
    name: 'team_status',
    label: 'Check on the team',
    description:
      "How this job's team run is going (or how the last one ended): the run id, each step's id, state and a line of its result, who works on what now, cost, where the results are, " +
      "and this job's earlier runs — pick team_continue's from_step here.",
    parameters: {
      type: 'object',
      properties: {
        run_id: { type: 'string', description: "One of this job's runs (default: the one going now, else the latest)." },
        plan: { type: 'boolean', description: "true = also the full prompt (instruction) of each step that hasn't started yet, as this run uses it — before changing one with team_edit." },
        step: { type: 'string', description: "One step's full definition (persona, instruction, model, effort) as this run uses it." },
      },
      additionalProperties: false,
    },
    loadMode: 'essential',
  },
  {
    name: 'team_stop',
    label: 'Stop the team',
    description: "Stop this job's running team. Only when the user asks for it to stop — never to change later steps (team_edit changes a running team without stopping it).",
    parameters: NO_ARGS,
    loadMode: 'essential',
  },
  {
    name: 'team_assign',
    label: "Set the job's team",
    description:
      "Make a workflow this job's team (its steps move into the job's room as people), or pass \"\" for no team. " +
      'Not while the team is running. Wait for the result before team_start.',
    parameters: {
      type: 'object',
      properties: { workflow_id: { type: 'string', description: 'A workflow id of this house (workflow_list), or "" for no team.' } },
      required: ['workflow_id'],
      additionalProperties: false,
    },
    loadMode: 'essential',
  },
  {
    name: 'workflow_list',
    label: 'List workflows',
    description:
      "This house's workflows (teams) with their steps — which one is this job's team and which jobs use each — then the shared library " +
      "(workflows the user promoted from any house; workflow_import copies one here), the models you can use, this job's work style and " +
      "the user's model choices. Look here before starting, designing or changing a team.",
    parameters: NO_ARGS,
    loadMode: 'essential',
  },
  {
    name: 'workflow_get',
    label: 'Read a workflow',
    description:
      "One of this house's workflows in full as JSON (every step with its persona and instruction), e.g. before changing it. " +
      'A workflow that is only in the library is shown too, marked read-only (workflow_import it to run or change it).',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The workflow id from workflow_list.' },
        library: {
          type: 'boolean',
          description: "true = the library's workflow with this id (read-only), even when this house has its own under that id — e.g. to tell the user what importing it with replace would change.",
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
    loadMode: 'essential',
  },
  {
    name: 'workflow_save',
    label: 'Save a workflow',
    description:
      'Create a workflow (a team: people who take a task one after another, top to bottom — parallel: true puts a step beside the one before it), ' +
      'or change an existing one with id + replace: true. ' +
      "A workflow belongs to this house: other houses don't see it (only a copy the user had promoted to the library), and changing it changes only this house's. " +
      'The user also changes workflows by hand (the Workflow tab, a run card): what they changed after the last save from chat stays — ' +
      "your save changes only what you changed; to change an existing one, start from workflow_get and keep each person's id. " +
      'Never save a workflow again just to run it: team_start runs it as it is now. ' +
      'Each step is a person with their own model and persona who never sees this chat: only their persona, their instruction and the files. ' +
      'Instruction placeholders: {{task}} the task given to team_start; {{prev}} the previous step\'s final reply (after people who worked at ' +
      'the same time: each one\'s reply under "## <Name>"); {{prevName}} its name ("A + B" after a parallel group); ' +
      '{{runDir}} the run\'s folder for hand-off files; {{feedback}} a reviewer\'s notes when the work came back (empty otherwise). ' +
      'A review step judges the work before it and ends with a JSON verdict; on "revise" the work goes back to its loopBackTo step and ' +
      'every step from there runs again (at most maxLoops times per run; a target inside a parallel group runs the whole group again). ' +
      'Steps with parallel: true start together with the step before them, each on its own part; the next step starts when all are done. ' +
      'Pick each model from the connected ones in workflow_list; ' +
      'a different vendor for the reviewer catches more.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: "Only to change one of this house's workflows (with replace: true). Leave out to create one — CAST picks the id." },
        name: { type: 'string', description: 'The team\'s name in any language (≤ 80 characters), e.g. "Research → Write → Edit".' },
        description: { type: 'string', description: 'What the team does, in a sentence or two (≤ 400 characters).' },
        icon: { type: 'string', description: 'One emoji.' },
        steps: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_WORKFLOW_STEPS,
          items: WORKFLOW_STEP_SCHEMA,
          description: `The people, in the order they work (1–${MAX_WORKFLOW_STEPS}).`,
        },
        from_run: { type: 'string', description: 'Instead of steps: keep the team of this finished run (e.g. a one-off team the user liked) as a workflow.' },
        replace: { type: 'boolean', description: 'true = overwrite the existing workflow `id`. Only when the user asked to change that one.' },
        override: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Only when the user asked you in this chat for exactly your values over ones changed by hand: the keys an earlier workflow_save named, e.g. ["reviewer.model"] or ["steps"].',
        },
        use_for_this_job: { type: 'boolean', description: "true = also make it this job's team (same as team_assign)." },
      },
      required: ['name'],
      additionalProperties: false,
    },
    loadMode: 'essential',
  },
  {
    name: 'workflow_delete',
    label: 'Delete a workflow',
    description:
      "Delete one of this house's workflows. Only when the user asks. Never while it runs; a copy in the library stays " +
      "(only the user takes one out of the library). A workflow that is some job's team is refused unless clear_teams is true: then " +
      'those jobs (in this house) get no fixed team and it is deleted.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The workflow id from workflow_list.' },
        clear_teams: { type: 'boolean', description: "true = it may be some job's team: those jobs get no fixed team. Only when the user wants it deleted anyway." },
      },
      required: ['id'],
      additionalProperties: false,
    },
    loadMode: 'essential',
  },
  {
    name: 'workflow_import',
    label: 'Import a workflow',
    description:
      "Copy a workflow from the shared library (workflow_list lists it) into this house, under its id: from then on it is this house's own — " +
      "run it, make it a job's team, change it; changing it changes only this house's copy, never the library or other houses. " +
      'A library workflow runs only once imported. If this house already has a workflow with that id, it is refused unless replace is true.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The id of a workflow in the library, from workflow_list.' },
        replace: { type: 'boolean', description: "true = replace this house's workflow with that id by the library's. Only when the user asked." },
      },
      required: ['id'],
      additionalProperties: false,
    },
    loadMode: 'essential',
  },
  {
    name: 'workflow_promote',
    label: 'Put a workflow in the library',
    description:
      'Only when the user asks to share a workflow with other houses (promote it, make it global, put it in the library): puts a copy of ' +
      "this house's workflow in the shared library, where every house sees it and can workflow_import it. This house keeps its own; " +
      'later changes to it reach the library only when it is promoted again (replace: true).',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: "The id of one of this house's workflows, from workflow_list." },
        replace: { type: 'boolean', description: "true = replace the library's workflow with that id by this house's. Only when the user asked." },
      },
      required: ['id'],
      additionalProperties: false,
    },
    loadMode: 'essential',
  },
];

/** What the user answered on a plan card (or why the card went away unanswered). */
export type PlanOutcome =
  | { approved: true; run: WorkflowRun; changed: Record<string, string>; thinking?: Record<string, ThinkingLevel | ''> }
  | { approved: false; reason: 'cancelled' | 'new_message' | 'stopped' | 'gone' };

/** A plan card before it is shown (the gate gives it an id, the status and the time). */
export type NewPlan = Omit<TeamPlan, 'id' | 'status' | 'ts' | 'changed' | 'changedThinking' | 'runId' | 'answeredAt'>;

/** Starts a plan card's team with what the user changed: step id → model, step id → effort ('' = omp's default). */
export type PlanStart = (changed: Record<string, string>, thinking?: Record<string, ThinkingLevel | ''>) => Promise<WorkflowRun>;

/** The plan card and the loop guard (AgentSystem's PlanGate keeps them per lead). */
export interface TeamGate {
  /** Team runs this lead started since the user's last message. */
  runsThisAsk(agentId: string): number;
  /** The loop guard now: per message of the user (the house's limit), or per goal while the lead works toward one. */
  runLimit(agentId: string, projectId: string): { used: number; max: number; per: 'message' | 'goal' };
  /** A card is due: the first team since the user's last message, and the job's work style asks first. */
  due(agentId: string, projectId: string, jobId: string): boolean;
  /** Show the card and wait for the user. `start` runs the team with the models and efforts the user changed; it may
   *  throw (the card then stays, and the user sees why). */
  ask(plan: NewPlan, callId: string, start: PlanStart): Promise<PlanOutcome>;
}

/** What the lead's tools need. The lead's house is the call's projectId: the store's methods take it (c.projectId),
 *  and the workflow deps below (saveWorkflow, deleteWorkflow, usedBy, promoteWorkflow, importWorkflow) are bound to
 *  it by whoever builds them (agent-system). */
export interface LeadToolDeps {
  engine: WorkflowEngine;
  jobs: JobStore;
  workflows: WorkflowStore;
  store: AgentStore;
  models: Pick<ModelRegistry, 'models' | 'isAvailable' | 'anyAvailable' | 'demoActive'>;
  gate: TeamGate;
  /** The house's default team (projects made before jobs existed keep it there). */
  houseWorkflowId(projectId: string): string | null;
  /** The lead started this run: tell them when it ends (and count it for the loop guard). */
  started(runId: string, agentId: string): void;
  /** The lead stopped this run itself: no need to tell them it ended. */
  stopped(runId: string): void;
  /** Save a workflow in the lead's house the way the Workflow tab does: validate, store, tell every client, re-sync
   *  the jobs using it. */
  saveWorkflow(raw: unknown): Workflow;
  /** Delete one of the lead's house's workflows the way the Workflow tab does (workflowDeleteProblem's refusals; a
   *  job's team only with clearTeams: those jobs get no fixed team). Throws. */
  deleteWorkflow(id: string, opts?: { clearTeams?: boolean }): Workflow;
  /** Set (null: clear) a job's team through the core's job update — the path the job dialog takes. */
  assignTeam(projectId: string, jobId: string, workflowId: string | null): Promise<Job>;
  /** The jobs of the lead's house whose team this workflow is, by name (`except` leaves one job out). */
  usedBy(workflowId: string, except?: { projectId: string; jobId: string }): string[];
  /** Put a copy of the lead's house's workflow in the shared library (store + tell every client). Throws
   *  WorkflowValidationError (WorkflowExistsError: the library has that id and replace isn't set). */
  promoteWorkflow(id: string, o: { replace?: boolean }): LibraryWorkflow;
  /** Copy a library workflow into the lead's house (store + tell every client + re-sync the people of the jobs whose
   *  team it replaced). Throws WorkflowValidationError (WorkflowExistsError: the house has that id, no replace). */
  importWorkflow(id: string, o: { replace?: boolean }): Workflow;
  /** The task tool's helpers on other models (helper-agents.ts): agent name and model label. */
  helpers?(): { name: string; label: string }[];
}

export interface LeadToolCall {
  tool: string;
  args: Record<string, unknown>;
  agentId: string;
  projectId: string;
  jobId: string;
  /** omp's id of this host tool call (host_tool_cancel names it). */
  callId?: string;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

export async function runLeadTool(c: LeadToolCall, d: LeadToolDeps): Promise<{ text: string; isError?: boolean }> {
  switch (c.tool) {
    case 'team_start':
      return teamStart(c, d);
    case 'team_continue':
      return teamContinue(c, d);
    case 'team_edit':
      return teamEdit(c, d);
    case 'team_status': {
      const runId = str(c.args.run_id).trim();
      const asked = runId ? d.engine.get(runId) : undefined;
      if (runId && (!asked || asked.projectId !== c.projectId || asked.jobId !== c.jobId)) {
        return { text: `No run “${runId}” in this job — team_status without run_id shows the latest one and lists the earlier ones.`, isError: true };
      }
      const run = asked ?? d.engine.activeRunOf(c.projectId, c.jobId) ?? latestRun(d.engine, c.projectId, c.jobId);
      if (!run) return { text: 'This job has no team runs yet.' };
      const earlier = runsOf(d.engine, c.projectId, c.jobId).filter((r) => r.id !== run.id);
      const text = describeRun(run, d, { detail: true, earlier });
      const one = str(c.args.step).trim();
      if (!one && c.args.plan !== true) return { text };
      const more = planDetail(run, d, one);
      return 'error' in more ? { text: more.error, isError: true } : { text: `${text}\n${more.text}` };
    }
    case 'team_stop': {
      const run = d.engine.activeRunOf(c.projectId, c.jobId);
      if (!run) return { text: 'No team run is going in this job.' };
      d.stopped(run.id);
      await d.engine.abort(run.id);
      return { text: `Stopped “${run.workflowName}”. Files the team already changed stay as they are (the user can revert the run in the Workflow tab).` };
    }
    case 'team_assign': {
      if (typeof c.args.workflow_id !== 'string') return { text: 'Pass workflow_id: a workflow id from workflow_list, or "" for no team.', isError: true };
      const id = c.args.workflow_id.trim();
      if (!d.jobs.get(c.projectId, c.jobId)) return { text: 'This job no longer exists.', isError: true };
      const run = d.engine.activeRunOf(c.projectId, c.jobId);
      if (run) return { text: `The team is running “${run.workflowName}” now — change it after the run ends (or team_stop) — to change what this run does next, use team_edit (it keeps going).`, isError: true };
      const workflow = id ? d.workflows.get(c.projectId, id) : undefined;
      if (id && !workflow) return { text: notHere(id, d), isError: true };
      if ((teamIdOf(c, d) ?? '') === id) return { text: workflow ? `This job's team is already “${workflow.name}”.` : 'This job already has no team.' };
      await d.assignTeam(c.projectId, c.jobId, id || null);
      if (!workflow) return { text: 'This job has no team now.' };
      return { text: `This job's team is now “${workflow.name}” (${teamChain(workflow.steps)}). Start it with team_start.` };
    }
    case 'workflow_list':
      return { text: listWorkflows(c, d) };
    case 'workflow_get': {
      const id = str(c.args.id).trim();
      const fromLibrary = c.args.library === true;
      const workflow = fromLibrary ? undefined : d.workflows.get(c.projectId, id);
      if (workflow) return { text: JSON.stringify(workflow, null, 2) };
      // the library's: shown so the lead can tell whether it fits, but it isn't this house's
      const lib = d.workflows.libraryGet(id);
      if (!lib) return { text: fromLibrary ? `The library has no workflow with id “${id}” — workflow_list lists the library.` : notHere(id, d), isError: true };
      const mine = fromLibrary ? d.workflows.get(c.projectId, id) : undefined;
      const where = mine
        ? `is the library's (${fromText(lib, c.projectId)}); this house has its own “${mine.name}” under this id — read-only here: workflow_import with replace: true would put this one in its place (only when the user wants that).`
        : `is in the library, not in this house (${fromText(lib, c.projectId)}) — read-only here: workflow_import copies it into this house, where it can run and be changed.`;
      return { text: `“${lib.workflow.name}” (id ${id}) ${where}\n${JSON.stringify(lib.workflow, null, 2)}` };
    }
    case 'workflow_delete': {
      const id = str(c.args.id).trim();
      const clear = c.args.clear_teams === true;
      const lib = d.workflows.get(c.projectId, id) ? undefined : d.workflows.libraryGet(id);
      if (lib) return { text: `“${lib.workflow.name}” (id ${id}) is in the library, not in this house — there is nothing to delete here (only the user takes a workflow out of the library).`, isError: true };
      const users = d.usedBy(id); // the jobs whose team it is: refused without clear_teams, left with no team with it
      try {
        const gone = d.deleteWorkflow(id, clear ? { clearTeams: true } : undefined);
        const freed = clear && users.length ? ` ${upper(jobsText(users))} ${users.length === 1 ? 'has' : 'have'} no fixed team now.` : '';
        return { text: `Deleted the workflow “${gone.name}” (id ${gone.id}).${freed}` };
      } catch (err) {
        // team_assign reaches only this job: say how to free the others when the user wants it gone anyway
        const own = d.workflows.get(c.projectId, id);
        const hint = !clear && users.length && own ? ' If the user wants it deleted anyway, call workflow_delete again with clear_teams: true — those jobs then have no fixed team.' : '';
        return { text: `${errorText(err)}${hint}`, isError: true };
      }
    }
    case 'workflow_save': {
      const prep = prepareWorkflowSave(c.args, { ...d, projectId: c.projectId });
      if ('error' in prep) return { text: prep.error, isError: true };
      // Over an existing workflow: a merge with what was changed by hand since the last save from chat
      // (workflow-merge.ts). What the lead sent is the base from now on.
      const sent = normalizeWorkflow(prep.workflow);
      const base = prep.replacing ? d.workflows.chatBase(c.projectId, sent.id) : undefined;
      const override = new Set(Array.isArray(c.args.override) ? c.args.override.filter((k): k is string => typeof k === 'string').map((k) => k.trim()) : []);
      const merge = base && prep.replacing ? mergeLeadSave(base, prep.replacing, sent, override, (key) => d.workflows.handSetSinceBase(c.projectId, sent.id, key)) : null;
      if (merge && 'conflict' in merge) return { text: merge.conflict, isError: true };
      if (merge?.applied.length && d.workflows.chatBaseSeeded(c.projectId, sent.id)) {
        // Last saved before CAST kept bases: a hand edit made then is in the base, so the lead's earlier value would
        // read as a change of its own. Shown once; the next save goes through (hand edits since stay protected).
        d.workflows.unseedChatBase(c.projectId, sent.id);
        return {
          text: [
            `Not saved yet: “${(prep.replacing ?? sent).name}” was last saved before CAST kept track of hand edits, so it can't tell whether the user set these by hand (in the Workflow tab) — your save would change them:`,
            ...merge.applied.map((k) => `- ${k.key} — ${k.who}: now ${k.now} (you sent ${k.sent})`),
            "Save again, with what is there now (workflow_get) for anything the user didn't ask you to change — that save goes through.",
          ].join('\n'),
          isError: true,
        };
      }
      if (merge) {
        try {
          normalizeWorkflow(merge.workflow);
        } catch (err) {
          return {
            text: `Not saved: with what was changed by hand (in the Workflow tab or on a run card) it would not be a valid workflow — ${errorText(err)}. Start from workflow_get (it as it is now, with each person's id) and save your change on top of that.`,
            isError: true,
          };
        }
      }
      const saved = d.saveWorkflow(merge ? merge.workflow : prep.workflow);
      d.workflows.setChatBase(c.projectId, sent);
      const lines = [`Saved workflow “${saved.name}” (id ${saved.id}): ${teamChain(saved.steps)}.`];
      const run = d.engine.activeRunOf(c.projectId, c.jobId);
      if (teamIdOf(c, d) === saved.id) {
        lines.push(`This job's team is now “${saved.name}”. Start it with team_start.`);
      } else if (c.args.use_for_this_job === true && run) {
        lines.push(`It is not this job's team yet: the team is running “${run.workflowName}” now — set it with team_assign (workflow_id "${saved.id}") after the run.`);
      } else if (c.args.use_for_this_job === true) {
        try {
          await d.assignTeam(c.projectId, c.jobId, saved.id);
          lines.push(`This job's team is now “${saved.name}”. Start it with team_start.`);
        } catch (err) {
          lines.push(`It is saved, but it could not be made this job's team: ${errorText(err)}`);
        }
      } else {
        lines.push(`It is not this job's team yet — team_assign with workflow_id "${saved.id}" sets it, or team_start with workflow_id "${saved.id}" runs it once.`);
      }
      if (prep.replacing) {
        lines.push(...replacedLines(c, d, saved));
        // what the user promoted from here earlier stays as it was in the library
        const lib = d.workflows.libraryGet(saved.id);
        if (lib?.from?.projectId === c.projectId) lines.push("The library's copy (promoted from this house) stays as it was — workflow_promote with replace: true updates it, only when the user asks.");
      }
      if (merge) lines.push(...keptText(merge));
      lines.push(...prep.notes, `Steps: ${saved.steps.map((s) => stepLine(s, d)).join(' → ')}`);
      return { text: lines.join('\n') };
    }
    case 'workflow_import':
      return importWorkflow(c, d);
    case 'workflow_promote':
      return promoteWorkflow(c, d);
    default:
      return { text: `Unknown CAST tool ${c.tool}.`, isError: true };
  }
}

/** The id of the job's team; the Main job falls back to the house's team, like the Workflow tab does. */
function teamIdOf(c: Pick<LeadToolCall, 'projectId' | 'jobId'>, d: Pick<LeadToolDeps, 'jobs' | 'houseWorkflowId'>): string | null {
  const job = d.jobs.get(c.projectId, c.jobId);
  if (!job) return null;
  return job.workflowId ?? (job.id === MAIN_JOB_ID ? d.houseWorkflowId(c.projectId) : null);
}

/** A run of this house's workflow that is going now, in any of its jobs. */
export function liveRunOf(engine: Pick<WorkflowEngine, 'runs'>, projectId: string, workflowId: string): WorkflowRun | undefined {
  return engine.runs().find((r) => r.projectId === projectId && r.workflowId === workflowId && (r.status === 'running' || r.status === 'waiting_approval'));
}

/** Why this house has no workflow with that id: it is only in the library (import it first), or there is none. */
function notHere(id: string, d: Pick<LeadToolDeps, 'workflows'>): string {
  const lib = d.workflows.libraryGet(id);
  return lib
    ? `“${lib.workflow.name}” (id ${id}) is in the library, not in this house — workflow_import it first (then it is this house's own).`
    : `No workflow with id “${id}” in this house — workflow_list shows them.`;
}

/** Where a library workflow came from, for the lead. */
function fromText(e: LibraryWorkflow, projectId: string): string {
  if (!e.from) return 'kept from before workflows belonged to houses';
  return e.from.projectId === projectId ? 'promoted from this house' : `promoted from the “${e.from.house}” house`;
}

/** “the Main job”, “the Main and Side jobs”: usedBy's job names (all in the lead's house). */
function jobsText(names: string[]): string {
  return names.length === 1 ? `the ${names[0]} job` : `the ${names.slice(0, -1).join(', ')} and ${names.at(-1)} jobs`;
}

const upper = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const peopleCount = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`;
/** The same workflow (both normalized: the store keeps them so). */
const sameWorkflow = (a: Workflow, b: Workflow) => JSON.stringify(a) === JSON.stringify(b);

/** After this house's workflow was replaced (workflow_save replace, workflow_import replace): who uses it, and a run of
 *  it going now — it keeps the plan it has (its own copy): saving is for next time. */
function replacedLines(c: LeadToolCall, d: LeadToolDeps, w: Workflow): string[] {
  const used = d.usedBy(w.id);
  const lines = [`Replaced the earlier version; used by ${used.length ? jobsText(used) : 'no job'}.`];
  const going = liveRunOf(d.engine, c.projectId, w.id);
  const where = going ? d.jobs.get(going.projectId, going.jobId)?.name : undefined;
  if (going) lines.push(`“${w.name}” is running now (run ${going.id}${where ? ` in the ${where} job` : ''}) — that run keeps its own plan; to change what it does next, use team_edit.`);
  return lines;
}

/** How to use a workflow that just became this house's (saved, imported). */
function useLine(c: LeadToolCall, d: LeadToolDeps, w: Workflow): string {
  return teamIdOf(c, d) === w.id
    ? `This job's team is now “${w.name}”. Start it with team_start.`
    : `It is not this job's team — team_assign with workflow_id "${w.id}" sets it, or team_start with workflow_id "${w.id}" runs it once.`;
}

/** workflow_import: a copy of a library workflow becomes this house's own. */
function importWorkflow(c: LeadToolCall, d: LeadToolDeps): { text: string; isError?: boolean } {
  const id = str(c.args.id).trim();
  if (!id) return { text: 'Pass id: the id of a workflow in the library (workflow_list lists the library).', isError: true };
  const lib = d.workflows.libraryGet(id);
  const mine = d.workflows.get(c.projectId, id);
  if (!lib) {
    return { text: `The library has no workflow with id “${id}”${mine ? ` — “${mine.name}” is this house's own already` : ' — workflow_list lists the library'}.`, isError: true };
  }
  if (mine && sameWorkflow(mine, lib.workflow)) return { text: `This house already has “${mine.name}” (id ${id}) as it is in the library — nothing to import. ${useLine(c, d, mine)}` };
  if (mine && c.args.replace !== true) {
    return {
      text:
        `This house already has a workflow with id “${id}”: “${mine.name}”, not the same as the library's “${lib.workflow.name}”. ` +
        "Pass replace: true to replace this house's with the library's (only when the user wants that), or keep this house's. " +
        'workflow_get with library: true shows the library\'s.',
      isError: true,
    };
  }
  let w: Workflow;
  try {
    w = d.importWorkflow(id, mine ? { replace: true } : {});
  } catch (err) {
    return { text: errorText(err), isError: true };
  }
  const renamed = w.name !== lib.workflow.name ? ` (named “${w.name}”: this house already has a workflow called “${lib.workflow.name}”)` : '';
  const lines = [
    `Imported “${lib.workflow.name}” (id ${w.id}) from the library (${fromText(lib, c.projectId)})${renamed}: ${teamChain(w.steps)}. ` +
      "It is this house's own now — changing it changes only this house's copy, not the library or other houses.",
    useLine(c, d, w),
  ];
  if (mine) lines.push(...replacedLines(c, d, w));
  lines.push(`Steps: ${w.steps.map((s) => stepLine(s, d)).join(' → ')}`);
  return { text: lines.join('\n') };
}

/** workflow_promote (only when the user asks): a copy of this house's workflow goes into the shared library. */
function promoteWorkflow(c: LeadToolCall, d: LeadToolDeps): { text: string; isError?: boolean } {
  const id = str(c.args.id).trim();
  if (!id) return { text: "Pass id: the id of one of this house's workflows (workflow_list).", isError: true };
  const w = d.workflows.get(c.projectId, id);
  if (!w) {
    const lib = d.workflows.libraryGet(id);
    return { text: lib ? `“${lib.workflow.name}” (id ${id}) is in the library already (${fromText(lib, c.projectId)}), and not in this house.` : notHere(id, d), isError: true };
  }
  const there = d.workflows.libraryGet(id);
  if (there && sameWorkflow(there.workflow, w)) return { text: `The library already has “${w.name}” (id ${id}) as it is in this house — nothing to promote.` };
  if (there && c.args.replace !== true) {
    return {
      text:
        `The library already has a workflow with id “${id}”: “${there.workflow.name}” (${fromText(there, c.projectId)}). ` +
        "Pass replace: true to replace it with this house's (only when the user wants that), or save this one as a new workflow and promote that.",
      isError: true,
    };
  }
  try {
    d.promoteWorkflow(id, there ? { replace: true } : {});
  } catch (err) {
    return { text: errorText(err), isError: true };
  }
  return {
    text: [
      `Put a copy of “${w.name}” (id ${id}) in the library${there ? ", replacing the library's earlier one" : ''}: every house sees it there now and can workflow_import it.`,
      "This house keeps its own — later changes to it reach the library only when it is promoted again (replace: true).",
      ...(there ? ['Houses that imported the earlier one keep their copies (workflow_import with replace: true there takes this one).'] : []),
    ].join('\n'),
  };
}

/** `Reviewer [reviewer] openai/gpt-6.1-sol, effort high, review: loops back to implementer up to 2×` */
function stepLine(s: WorkflowStep, d: Pick<LeadToolDeps, 'models'>): string {
  let out = `${s.name} [${s.id}] ${s.model}`;
  if (d.models.anyAvailable() && !d.models.isAvailable(s.model)) out += ' (not connected)';
  if (s.thinking) out += `, effort ${s.thinking}`;
  if (s.kind === 'review') out += s.loopBackTo ? `, review: loops back to ${s.loopBackTo} up to ${s.maxLoops ?? 2}×` : ', review';
  if (s.parallel) out += ', at the same time as the step before';
  return out;
}

/** workflow_list's library section starts with this (the scripted test model's parseWorkflowList stops there). */
const LIBRARY_HEADER = 'The library';

const WORK_STYLE: Record<WorkStyle, string> = {
  ask: 'ask — the first team you start after each message of the user shows them a plan card (they can change models or cancel); later teams for the same message start right away',
  auto: 'auto — teams start right away, no plan card',
  solo: 'solo — helpers and teams only when the user asks for them; the first team after each message of the user shows them a plan card',
};

function listWorkflows(c: LeadToolCall, d: LeadToolDeps): string {
  const teamId = teamIdOf(c, d);
  const team = d.workflows.get(c.projectId, teamId);
  const job = d.jobs.get(c.projectId, c.jobId);
  const teamInLibrary = !team && teamId ? d.workflows.libraryGet(teamId) : undefined;
  const lines = [
    team
      ? `This job's team: “${team.name}” (id ${team.id}).`
      : teamInLibrary
        ? `This job's team “${teamInLibrary.workflow.name}” (id ${teamId}) is in the library, not in this house — workflow_import it to use it.`
        : 'This job has no team yet (team_start with workflow_id or steps).',
  ];
  const run = d.engine.activeRunOf(c.projectId, c.jobId);
  if (run) lines.push(`It is running “${run.workflowName}” now.`);
  if (job) lines.push(`Work style of this job: ${WORK_STYLE[job.workStyle ?? DEFAULT_WORK_STYLE]}.`);
  if (job?.modelPrefs?.length) {
    // a model / effort the user set by hand in a workflow after picking it on a card is what runs there (pickTeam)
    const handSince = (p: NonNullable<Job['modelPrefs']>[number], field: 'model' | 'thinking') =>
      d.workflows.list(c.projectId).flatMap((w) =>
        w.steps
          .filter((s) => s.name === p.stepName && dutyOf(s) === p.duty && (d.workflows.handSetAt?.(c.projectId, w.id, s.id, field) ?? 0) > ((field === 'model' ? p.modelAt : p.thinkingAt) ?? p.at))
          .map((s) => `${field === 'model' ? s.model : `effort ${s.thinking ?? 'default'}`} set by hand in “${w.name}” since — that one runs there`),
      );
    const choice = (p: NonNullable<Job['modelPrefs']>[number]) =>
      [p.model, p.thinking ? `effort ${p.thinking}` : '', ...handSince(p, 'model'), ...handSince(p, 'thinking')].filter(Boolean).join(', ');
    lines.push(`The user's model choices (follow them for these duties): ${job.modelPrefs.map((p) => `${p.stepName} (${truncate(p.duty, 80)}) → ${choice(p)}`).join('; ')}.`);
  }
  const houseList = d.workflows.list(c.projectId);
  if (houseList.length) lines.push("This house's workflows (other houses don't see them; changing one changes only this house's):");
  else lines.push('This house has no workflows yet — team_start with steps makes a one-off team; workflow_save keeps one.');
  for (const w of houseList) {
    const others = d.usedBy(w.id, { projectId: c.projectId, jobId: c.jobId });
    const tags = [
      w.id === team?.id ? "this job's team" : '',
      others.length ? `${w.id === team?.id ? 'also used by' : 'used by'} ${jobsText(others)}` : '',
      liveRunOf(d.engine, c.projectId, w.id) ? 'running now' : '',
    ].filter(Boolean);
    lines.push(`- ${w.icon} “${w.name}” (id ${w.id})${tags.length ? ` — ${tags.join(' · ')}` : ''}`);
    if (w.description.trim()) lines.push(`  ${truncate(w.description.trim().replace(/\s+/g, ' '), 200)}`);
    lines.push(`  ${w.steps.map((s) => stepLine(s, d)).join(' → ')}`);
  }
  // The library: not this house's (nothing here runs them) — listed apart, one line each.
  const library = d.workflows.library();
  if (library.length) {
    lines.push(`${LIBRARY_HEADER} (copies the user promoted from houses; not this house's — workflow_import copies one here, then it runs and changes as this house's own):`);
    for (const e of library) {
      const w = e.workflow;
      const mine = d.workflows.get(c.projectId, w.id);
      const here = mine ? (sameWorkflow(mine, w) ? '; this house has it too' : `; this house has a different “${mine.name}” under this id`) : '';
      lines.push(`* ${w.icon} “${w.name}” — library id ${w.id}, ${peopleCount(w.steps.length)} (${teamChain(w.steps)}), ${fromText(e, c.projectId)}${here}`);
    }
  }
  const models = d.models.models();
  if (d.models.demoActive()) {
    lines.push(
      'No AI account is connected (CAST_MOCK_LLM test mode: steps run on the scripted model) — any of these ids is fine: ' +
        `${models.map((m) => m.id).join(', ')}.`,
    );
  } else if (!d.models.anyAvailable()) {
    lines.push(`${NO_ACCOUNT} team_start is refused until then; workflow_save still takes these model ids: ${models.map((m) => m.id).join(', ')}.`);
  } else {
    lines.push(`Models you can use: ${models.filter((m) => m.available).map((m) => `${m.id} (${m.label}${m.thinking?.length ? `, thinking up to ${m.thinking.at(-1)}` : ''})`).join(', ')}.`);
    const helpers = d.helpers?.() ?? [];
    if (helpers.length) lines.push(`Helpers by model (task tool \`agent\`): ${helpers.map((h) => `${h.name} (${h.label})`).join(', ')}.`);
    const off = models.filter((m) => !m.available);
    if (off.length) {
      lines.push(`Not connected (they can't be used until the user signs in under Models & providers): ${off.map((m) => m.id).join(', ')}.`);
    }
  }
  return lines.join('\n');
}

// ───────────────────────── team_start ─────────────────────────

/** The team a team_start call picked, before the plan card. */
interface TeamPick {
  workflow: Workflow; // step ids as written; the lead's `models` applied
  own: boolean; // the job's own team, unchanged: its standing people do the work
  adhoc: boolean; // a one-off team made for this task
  notes: string[];
}

const CANCELLED: Record<Exclude<PlanOutcome, { approved: true }>['reason'], string> = {
  cancelled: "The user cancelled this plan — don't start it. Ask what they want, or do it another way if they said so.",
  new_message: 'The user wrote a new message instead of answering the plan — read it and go from there.',
  stopped: "The user pressed Stop before answering the plan — don't start it.",
  gone: "The plan was withdrawn before the user answered it (the job went away or CAST restarted) — don't start it.",
};

async function teamStart(c: LeadToolCall, d: LeadToolDeps): Promise<{ text: string; isError?: boolean }> {
  const task = str(c.args.task).trim();
  if (!task) return { text: 'Give the team a task.', isError: true };
  const pick = pickTeam(c, d);
  if ('error' in pick) return { text: pick.error, isError: true };
  const going = d.engine.activeRunOf(c.projectId, c.jobId);
  if (going) return { text: goingText(going), isError: true };
  const limit = runLimitError(c, d);
  if (limit) return { text: limit, isError: true };

  const start: PlanStart = async (changed, thinking = {}) => {
    const steps = pick.workflow.steps.map((s) => withEffort(changed[s.id] ? { ...s, model: changed[s.id]! } : s, thinking[s.id]));
    const own = pick.own && !Object.keys(changed).length && !Object.keys(thinking).length;
    const run = await d.engine.start(c.projectId, c.jobId, own ? pick.workflow.id : { ...pick.workflow, steps }, task, { startedBy: 'lead', adhoc: pick.adhoc });
    d.started(run.id, c.agentId);
    return run;
  };
  if (!d.gate.due(c.agentId, c.projectId, c.jobId)) return { text: startedText(await start({}), pick.notes) };

  const plan: NewPlan = {
    agentId: c.agentId,
    projectId: c.projectId,
    jobId: c.jobId,
    title: pick.workflow.name,
    ...(pick.adhoc ? {} : { workflowId: pick.workflow.id }),
    ...(str(c.args.why).trim() ? { why: truncate(str(c.args.why).trim().replace(/\s+/g, ' '), 200) } : {}),
    task,
    steps: pick.workflow.steps.map(planStep),
  };
  const outcome = await d.gate.ask(plan, c.callId ?? '', start);
  if (!outcome.approved) return { text: CANCELLED[outcome.reason] };
  const changes = choiceChanges(outcome, pick.workflow.steps);
  const efforts = Object.keys(outcome.thinking ?? {}).length > 0;
  // How to keep them: RLT applies them to saved teams itself (pickTeam); the ids show the `models` form.
  const how = changes.length
    ? ` — CAST gives them to a saved team's people you pass no model for${Object.keys(outcome.changed).length ? ` (as models ${JSON.stringify(outcome.changed)})` : ''}; in a one-off team, give people with the same duty the same model${efforts ? ' and effort' : ''}`
    : '';
  return {
    text: `${startedText(outcome.run, pick.notes)}\nThe user approved the plan${changes.length ? ` and changed: ${changes.join(', ')}` : ''}. Keep their model choices for later teams in this job${how}.`,
  };
}

/** team_start / team_continue while a team runs in the job: change it in place (team_edit), don't stop and restart it. */
function goingText(going: WorkflowRun): string {
  return `A team is already running “${going.workflowName}” in this job — to change what it does next, use team_edit (it keeps going); otherwise wait for its update (team_stop only if the user wants it stopped).`;
}

/** The loop guard (per message of the user, or per goal): why no more team runs may start now, or null. */
function runLimitError(c: LeadToolCall, d: LeadToolDeps): string | null {
  const limit = d.gate.runLimit(c.agentId, c.projectId);
  if (limit.used < limit.max) return null;
  return limit.per === 'goal'
    ? `That's ${limit.max} team runs for this goal — stop starting teams, tell the user what happened and let them decide (they can resume the goal).`
    : `That's ${limit.max} team runs for this message — tell the user what happened and let them decide.`;
}

/** A step with the effort a plan card gave it: '' = omp's default (no thinking set), undefined = unchanged. */
function withEffort(s: WorkflowStep, level: ThinkingLevel | '' | undefined): WorkflowStep {
  if (level === undefined) return s;
  const { thinking: _, ...rest } = s;
  return level ? { ...rest, thinking: level } : rest;
}

/** "Reviewer → openai/gpt-6.1-sol, effort max", "Writer → effort default": what the user changed on the card (the UI's word). */
function choiceChanges(outcome: Extract<PlanOutcome, { approved: true }>, steps: { id: string; name: string }[]): string[] {
  const thinking = outcome.thinking ?? {};
  const ids = [...new Set([...Object.keys(outcome.changed), ...Object.keys(thinking)])];
  return ids.map((id) => {
    const parts = [outcome.changed[id] ?? '', id in thinking ? `effort ${thinking[id] || 'default'}` : ''].filter(Boolean);
    return `${steps.find((s) => s.id === id)?.name ?? id} → ${parts.join(', ')}`;
  });
}

/** One person on the plan card. */
function planStep(s: WorkflowStep): PlanStep {
  const duty = dutyOf(s);
  const about = s.persona.replace(/\s+/g, ' ').trim();
  return {
    id: s.id,
    name: s.name,
    duty,
    ...(about && about !== duty ? { about: truncate(about, 2000) } : {}),
    model: s.model,
    ...(s.thinking ? { thinking: s.thinking } : {}),
    kind: s.kind,
    ...(s.loopBackTo ? { loopBackTo: s.loopBackTo, maxLoops: s.maxLoops ?? 2 } : {}),
    ...(s.parallel ? { parallel: true } : {}),
  };
}

// ───────────────────────── team_continue ─────────────────────────

/** Redo only part of an ended run (WorkflowEngine.continueFrom): the steps before from_step keep their results. Same
 *  refusals, plan card and loop guard as team_start; the job's model choices don't apply (it runs as it ran — the
 *  card lets the user change models). */
async function teamContinue(c: LeadToolCall, d: LeadToolDeps): Promise<{ text: string; isError?: boolean }> {
  const going = d.engine.activeRunOf(c.projectId, c.jobId);
  if (going) return { text: goingText(going), isError: true };
  const runId = str(c.args.run_id).trim();
  const from = runId ? d.engine.get(runId) : latestRun(d.engine, c.projectId, c.jobId);
  if (!from) {
    return {
      text: runId ? `No run “${runId}” — team_status lists this job's runs.` : 'This job has no team run to continue — start one with team_start.',
      isError: true,
    };
  }
  if (from.projectId !== c.projectId || from.jobId !== c.jobId) return { text: `Run ${from.id} belongs to another job — team_status lists this job's runs.`, isError: true };
  const limit = runLimitError(c, d);
  if (limit) return { text: limit, isError: true };
  const fromStep = str(c.args.from_step).trim();
  if (!fromStep) return { text: "Pass from_step: the id (or name) of the first step to run again — team_status shows each step's id.", isError: true };
  let models: Record<string, string> = {};
  if (c.args.models !== undefined) {
    const m = c.args.models;
    if (!m || typeof m !== 'object' || Array.isArray(m)) return { text: 'models is an object: {"<step id>": "<model id>"}.', isError: true };
    for (const [id, value] of Object.entries(m as Record<string, unknown>)) {
      const model = str(value).trim();
      if (!MODEL_ID.test(model)) return { text: `models.${id} must be a model id like anthropic/claude-opus-5-5 (workflow_list shows them).`, isError: true };
      models[id] = model;
    }
  }
  const note = str(c.args.note).trim();
  const task = str(c.args.task).trim();
  const opts = { ...(note ? { note } : {}), ...(task ? { task } : {}), models };
  let plan: ContinuePlan;
  try {
    plan = d.engine.planContinue(from.id, fromStep, opts);
  } catch (err) {
    return { text: errorText(err), isError: true };
  }
  // the card's ids are written ids; the lead's may be `x-` ones
  models = Object.fromEntries(Object.entries(models).map(([id, m]) => [writtenStepId(id), m]));

  const start: PlanStart = async (changed, thinking = {}) => {
    const run = await d.engine.continueFrom(from.id, plan.fromStepId, { ...opts, models: { ...models, ...changed }, ...(Object.keys(thinking).length ? { thinking } : {}), startedBy: 'lead' });
    d.started(run.id, c.agentId);
    return run;
  };
  if (!d.gate.due(c.agentId, c.projectId, c.jobId)) return { text: continuedText(await start({}), plan) };

  const newPlan: NewPlan = {
    agentId: c.agentId,
    projectId: c.projectId,
    jobId: c.jobId,
    title: from.workflowName,
    ...(from.adhoc || !from.workflowId ? {} : { workflowId: from.workflowId }),
    ...(str(c.args.why).trim() ? { why: truncate(str(c.args.why).trim().replace(/\s+/g, ' '), 200) } : {}),
    task: plan.task,
    steps: plan.team.slice(plan.startIndex).map(planStep), // the first is a group's first step: never parallel
    continues: { runId: from.id, fromStepId: plan.fromStepId, kept: plan.kept.map((k) => ({ id: k.step.id, name: k.step.name })), ...(plan.note ? { note: plan.note } : {}) },
  };
  const outcome = await d.gate.ask(newPlan, c.callId ?? '', start);
  if (!outcome.approved) return { text: CANCELLED[outcome.reason] };
  const changes = choiceChanges(outcome, plan.team);
  return {
    text: `${continuedText(outcome.run, plan)}\nThe user approved the plan${changes.length ? ` and changed: ${changes.join(', ')}` : ''}.${changes.length ? ' Keep their model choices for later teams in this job.' : ''}`,
  };
}

// ───────────────────────── team_edit ─────────────────────────

const NO_RUN =
  'No team is running in this job — team_edit changes a running team. To redo part of a run that ended use team_continue; to change a saved workflow use workflow_save.';

/** What run-edit needs, from the lead's deps (the run is in the lead's house: projectId). */
function editDeps(d: LeadToolDeps, projectId: string): RunEditDeps {
  return {
    engine: d.engine,
    workflows: d.workflows,
    models: d.models,
    defaultInstruction,
    saveWorkflow: (raw) => {
      // the lead's own change (team_edit save: true): into the base too, so it never reads as a hand edit
      const id = raw && typeof raw === 'object' ? String((raw as { id?: unknown }).id ?? '') : '';
      const before = d.workflows.get(projectId, id);
      const saved = d.saveWorkflow(raw);
      const base = d.workflows.chatBase(projectId, saved.id);
      if (before && base) d.workflows.setChatBase(projectId, carryOver(base, before, saved), { carry: true });
      return saved;
    },
    usedBy: (id) => d.usedBy(id),
    taken: (run) => takenIds(d, run),
  };
}

/** Ids a person added to a run can't take: the job's people (their chats and settings would be shared) and the
 *  steps of its saved workflow (in the run's house). */
export function takenIds(d: Pick<LeadToolDeps, 'store' | 'workflows'>, run: WorkflowRun): string[] {
  const people = d.store.list().filter((a) => a.projectId === run.projectId && a.jobId === run.jobId && a.kind !== 'subagent').map((a) => writtenStepId(a.roleId));
  return [...people, ...(d.workflows.get(run.projectId, run.workflowId)?.steps.map((s) => s.id) ?? [])];
}

/** Change the job's running team (run-edit.ts): it keeps going. A change to a step that finished or works now is
 *  refused with what it would redo; redo: true (after the user agreed) continues the run from there instead. */
async function teamEdit(c: LeadToolCall, d: LeadToolDeps): Promise<{ text: string; isError?: boolean }> {
  const run = d.engine.activeRunOf(c.projectId, c.jobId);
  if (!run) return { text: NO_RUN, isError: true };
  const ops = parseRunEditOps(c.args.ops);
  if ('error' in ops) return { text: ops.error, isError: true };
  const deps = editDeps(d, c.projectId);
  const save = c.args.save === true;
  if (c.args.redo === true) {
    const view = d.engine.planOf(run.id);
    const planned = planRunEdit(view, ops, editContext(deps, run));
    if ('error' in planned) return { text: planned.error, isError: true };
    if (planned.frozen) return teamRedo(c, d, run, ops, deps, planned.frozen.from, planned.changes);
  }
  const r = applyRunEdit(run.id, ops, { by: 'lead', save }, deps);
  if (!r.ok) return { text: r.error, isError: true };
  const text = editedText(r);
  return { text: c.args.redo === true ? `${text}\nNo redo was needed: none of these changes touch a step that finished or works now.` : text };
}

/** team_edit redo: true — the run stops and continues from the earliest step the changes touch, with the changed
 *  team (the steps before it keep their results). Planned before anything stops; the plan card (when due) answers
 *  later, so the changes go onto the run as it is then, checked again, and only then is the run stopped. */
async function teamRedo(
  c: LeadToolCall,
  d: LeadToolDeps,
  run: WorkflowRun,
  ops: RunEditOp[],
  deps: RunEditDeps,
  from: { id: string; name: string },
  changes: string[],
): Promise<{ text: string; isError?: boolean }> {
  if (ops.some((o) => o.op === 'note')) return { text: 'A redo starts those steps again — leave out the note ops (put what they should know into their instruction).', isError: true };
  const limit = runLimitError(c, d);
  if (limit) return { text: limit, isError: true };
  /** The changed team on the run as it is now: its plan while it goes, else the team it ran with. */
  const teamNow = (): WorkflowStep[] => {
    const going = d.engine.activeRunOf(c.projectId, c.jobId)?.id === run.id;
    const view = going ? d.engine.planOf(run.id) : null;
    const base = view ?? (() => {
      const steps = d.engine.teamOf(run.id);
      if (!steps) throw new Error(`CAST didn't keep the team of run ${run.id} — start the team again with team_start.`);
      return { runId: run.id, rev: 0, workflowId: run.workflowId, workflowName: run.workflowName, own: false, steps, done: 0, frozen: 0, states: {}, taken: [] };
    })();
    const p = planRunEdit(base, ops, editContext(deps, run));
    if ('error' in p) throw new Error(p.error);
    return p.steps;
  };
  let plan: ContinuePlan;
  try {
    plan = d.engine.planContinue(run.id, from.id, { team: teamNow(), live: true });
  } catch (err) {
    return { text: errorText(err), isError: true };
  }
  let stopped = false; // the run was still going when the redo started (else it had ended meanwhile)
  const start: PlanStart = async (changed, thinking = {}) => {
    const team = teamNow();
    if (d.engine.activeRunOf(c.projectId, c.jobId)?.id === run.id) {
      d.engine.planContinue(run.id, from.id, { team, live: true }); // still fine: only now does the run stop
      d.stopped(run.id);
      stopped = true;
      await d.engine.abort(run.id);
    }
    const next = await d.engine.continueFrom(run.id, from.id, { team, models: changed, ...(Object.keys(thinking).length ? { thinking } : {}), startedBy: 'lead' });
    d.started(next.id, c.agentId);
    return next;
  };
  const stoppedLine = () => `${stopped ? 'The run was stopped' : 'The run had ended meanwhile'} and continues from ${from.name} with your changes (${changes.join('; ')}).`;
  if (!d.gate.due(c.agentId, c.projectId, c.jobId)) {
    try {
      return { text: `${continuedText(await start({}), plan)}\n${stoppedLine()}` };
    } catch (err) {
      return { text: errorText(err), isError: true };
    }
  }
  const newPlan: NewPlan = {
    agentId: c.agentId,
    projectId: c.projectId,
    jobId: c.jobId,
    title: run.workflowName,
    ...(run.adhoc || !run.workflowId ? {} : { workflowId: run.workflowId }),
    ...(str(c.args.why).trim() ? { why: truncate(str(c.args.why).trim().replace(/\s+/g, ' '), 200) } : {}),
    task: plan.task,
    steps: plan.team.slice(plan.startIndex).map(planStep),
    continues: { runId: run.id, fromStepId: plan.fromStepId, kept: plan.kept.map((k) => ({ id: k.step.id, name: k.step.name })), changes },
  };
  const outcome = await d.gate.ask(newPlan, c.callId ?? '', start);
  if (!outcome.approved) {
    const goesOn = d.engine.activeRunOf(c.projectId, c.jobId)?.id === run.id ? ' The run goes on as it was — nothing was stopped or changed.' : '';
    return { text: outcome.reason === 'cancelled' ? `The user cancelled the redo — don't redo those steps.${goesOn} Ask what they want instead.` : `${CANCELLED[outcome.reason]}${goesOn}` };
  }
  return { text: `${continuedText(outcome.run, plan)}\n${stoppedLine()}` };
}

/** team_status plan / step: the steps as the run uses them (going: its plan now — the steps that haven't started;
 *  ended: the team it ran with), or one step in full. */
function planDetail(run: WorkflowRun, d: LeadToolDeps, one: string): { text: string } | { error: string } {
  const live = run.status === 'running' || run.status === 'waiting_approval';
  let steps: WorkflowStep[] | null = null;
  let from = 0;
  if (live) {
    try {
      const v = d.engine.planOf(run.id);
      [steps, from] = [v.steps, v.frozen];
    } catch {
      /* ended meanwhile */
    }
  }
  steps ??= d.engine.teamOf(run.id);
  if (!steps) return { error: `CAST didn't keep the team of run ${run.id} (it ran before teams were kept with the run).` };
  const show = (s: WorkflowStep) =>
    [
      `### ${s.name} [${s.id}] — ${s.model}${s.thinking ? `, effort ${s.thinking}` : ''}${s.kind === 'review' ? `, review${s.loopBackTo ? ` (back to ${s.loopBackTo} up to ${s.maxLoops ?? 2}×)` : ''}` : ''}${s.parallel ? ', at the same time as the step before' : ''}`,
      `Persona: ${one ? s.persona : truncate(s.persona.replace(/\s+/g, ' ').trim(), 300)}`,
      'Instruction:',
      s.instruction,
    ].join('\n');
  if (one) {
    const s = steps.find((x) => x.id === one || x.id === writtenStepId(one)) ?? steps.find((x) => x.name.trim().toLowerCase() === one.toLowerCase());
    if (!s) return { error: `No step “${truncate(one, 60)}” in run ${run.id} — its steps: ${steps.map((x) => x.id).join(', ')}.` };
    return { text: `As this run uses it:\n${show(s)}` };
  }
  const left = steps.slice(from);
  if (!left.length) return { text: 'Every step of this run has started — nothing left that team_edit can change.' };
  return { text: [live ? "The steps that haven't started yet, as this run uses them (team_edit can change these):" : 'The steps as this run used them:', ...left.map(show)].join('\n') };
}

/** `Started “X” (C → D), run <new> — continuing run <old> from C: A → B keep their results, …` — the first line keeps
 *  startedText's shape (the scripted test model reads it), then the rest of startedText and the plan's notes. */
function continuedText(run: WorkflowRun, plan: ContinuePlan): string {
  const team = run.team ?? [];
  const from = plan.team[plan.startIndex]!;
  const remaining = teamChain(team.slice(plan.startIndex));
  const kept = plan.kept.length ? `${teamChain(plan.kept.map((k) => k.step))} keep${plan.kept.length === 1 ? 's' : ''} ${plan.kept.length === 1 ? 'its result' : 'their results'}` : 'nothing is kept (the whole team works again)';
  return [
    `Started “${run.workflowName}” (${remaining}), run ${run.id} — continuing run ${plan.from.id} from ${from.name}: ${kept}, and the files stay as that run left them. ` +
      `It works in the background — you are free to keep talking with the user. Check on it with team_status; you'll get a "[RLT team update]" message when it ends. ` +
      `Each step's output goes to .rlt/runs/${run.id}/.`,
    ...(team.length ? [`Models: ${team.slice(plan.startIndex).map((m) => `${m.name} on ${m.model}`).join(', ')}.`] : []),
    ...(plan.note ? [`${from.name} gets your note: “${truncate(plan.note.replace(/\s+/g, ' '), 200)}”.`] : []),
    ...plan.notes,
  ].join('\n');
}

/** "A → B + C → D": people in order, those who work at the same time joined with " + ". */
export function teamChain(steps: { name: string; parallel?: boolean }[]): string {
  return steps.map((s, i) => `${i === 0 ? '' : s.parallel ? ' + ' : ' → '}${s.name}`).join('');
}

/** `Started “X” (A → B → C), run <id>. …` and who works on which model — the scripted test model reads the first line. */
function startedText(run: WorkflowRun, notes: string[]): string {
  const team = run.team ?? [];
  const names = teamChain(team);
  return [
    `Started “${run.workflowName}”${names ? ` (${names})` : ''}, run ${run.id}. It works in the background — ` +
      `you are free to keep talking with the user. Check on it with team_status; you'll get a "[RLT team update]" message when it ends. ` +
      `Each step's output goes to .rlt/runs/${run.id}/.`,
    ...(team.length ? [`Models: ${team.map((m) => `${m.name} on ${m.model}`).join(', ')}.`] : []),
    ...notes,
  ].join('\n');
}

/** Which team a team_start call means: the job's own (no workflow_id, no steps), a saved workflow, or a one-off team —
 *  with the lead's `models` for this run, all on connected models. */
function pickTeam(c: LeadToolCall, d: LeadToolDeps): TeamPick | { error: string } {
  if (!d.models.anyAvailable() && !d.models.demoActive()) return { error: `${NO_ACCOUNT} Tell the user; don't start a team until then.` };
  const givenId = str(c.args.workflow_id).trim();
  const hasSteps = c.args.steps !== undefined && c.args.steps !== null;
  if (givenId && hasSteps) return { error: 'Pass workflow_id (a saved workflow) or steps (a one-off team for this task), not both.' };
  const teamId = teamIdOf(c, d);
  let workflow: Workflow;
  let notes: string[] = [];
  if (hasSteps) {
    if (c.args.models !== undefined) return { error: "models goes with workflow_id or the job's team — in steps, give each person their model." };
    const prep = prepareSteps(c.args.steps, d, 'team');
    if ('error' in prep) return prep;
    const name = str(c.args.name).trim().slice(0, 80) || ADHOC_NAME;
    try {
      workflow = { ...normalizeWorkflow({ id: 'team', name, description: '', icon: ADHOC_ICON, steps: prep.steps }), id: '' };
    } catch (err) {
      return { error: errorText(err) };
    }
    notes = prep.notes;
  } else {
    const id = givenId || teamId;
    if (!id) return { error: 'This job has no team of its own — pass workflow_id (a workflow of this house from workflow_list) or steps (a one-off team for this task).' };
    const saved = d.workflows.get(c.projectId, id);
    if (!saved) return { error: givenId || d.workflows.libraryGet(id) ? notHere(id, d) : "This job's team no longer exists — pass workflow_id or steps." };
    workflow = saved;
  }

  // The lead's other models for some steps, this run only.
  let changed = false;
  const chosen = new Set<string>(); // step ids the lead gave a model (every one-off person has one)
  if (c.args.models !== undefined) {
    const models = c.args.models;
    if (!models || typeof models !== 'object' || Array.isArray(models)) return { error: 'models is an object: {"<step id>": "<model id>"}.' };
    const steps = workflow.steps.map((s) => ({ ...s }));
    for (const [id, value] of Object.entries(models as Record<string, unknown>)) {
      const step = steps.find((s) => s.id === id);
      if (!step) return { error: `“${workflow.name}” has no step “${id}” — its step ids: ${steps.map((s) => s.id).join(', ')}.` };
      const model = str(value).trim();
      if (!MODEL_ID.test(model)) return { error: `models.${id} must be a model id like anthropic/claude-opus-5-5 (workflow_list shows them).` };
      chosen.add(id);
      if (model !== step.model) [step.model, changed] = [model, true];
    }
    workflow = { ...workflow, steps };
  }
  if (hasSteps) for (const s of workflow.steps) chosen.add(s.id);

  // The models the user picked on earlier plan cards (job.modelPrefs: same name and duty) go to the people the lead
  // gave no model; where the lead chose another one, it hears about the user's pick.
  const prefs = d.jobs.get(c.projectId, c.jobId)?.modelPrefs ?? [];
  // A model or effort the user set by hand in this saved workflow after picking on a card is the newer choice.
  const byHand = (step: WorkflowStep, field: 'model' | 'thinking', at: number) => !hasSteps && (d.workflows.handSetAt?.(c.projectId, workflow.id, step.id, field) ?? 0) > at;
  const pickedAt = (p: (typeof prefs)[number], field: 'model' | 'thinking') => (field === 'model' ? p.modelAt : p.thinkingAt) ?? p.at;
  if (prefs.length) {
    const steps = workflow.steps.map((s) => ({ ...s }));
    for (const step of steps) {
      const pref = prefs.find((p) => p.stepName === step.name && p.duty === dutyOf(step));
      if (!pref) continue;
      if (pref.model && pref.model !== step.model && !chosen.has(step.id) && byHand(step, 'model', pickedAt(pref, 'model'))) {
        notes.push(`${step.name} [${step.id}] runs on ${step.model}, which the user set by hand after picking ${pref.model} on a plan card.`);
      } else if (pref.model && pref.model !== step.model) {
        const usable = !d.models.anyAvailable() || d.models.isAvailable(pref.model);
        if (usable && !chosen.has(step.id)) {
          [step.model, changed] = [pref.model, true];
          notes.push(`${step.name} [${step.id}] runs on ${pref.model}, the model the user picked for this duty (pass models to change it).`);
        } else {
          notes.push(`${step.name} [${step.id}] runs on ${step.model}; the user picked ${pref.model} for this duty before${usable ? '' : ' (not connected now)'}.`);
        }
      }
      // the effort the user picked: for a saved team's people, and one-off people the lead gave no thinking
      if (pref.thinking && pref.thinking !== step.thinking && byHand(step, 'thinking', pickedAt(pref, 'thinking'))) {
        notes.push(`${step.name} [${step.id}] thinks at ${step.thinking ?? 'the default'}, which the user set by hand after picking ${pref.thinking} on a plan card.`);
      } else if (pref.thinking && pref.thinking !== step.thinking) {
        if (!hasSteps || step.thinking === undefined) {
          [step.thinking, changed] = [pref.thinking, true];
          notes.push(`${step.name} [${step.id}] thinks at ${pref.thinking}, the effort the user picked for this duty.`);
        } else {
          notes.push(`${step.name} [${step.id}] thinks at ${step.thinking}; the user picked ${pref.thinking} for this duty before.`);
        }
      }
    }
    workflow = { ...workflow, steps };
  }
  const off = notConnected(workflow.steps, d);
  if (off) return { error: `${off} — pass models {"<step id>": "<model id>"} for this run, or steps for a one-off team.` };
  if (!hasSteps) notes.push(...handNotes(c.projectId, workflow.id, chosen, d));
  return { workflow, own: !hasSteps && !changed && workflow.id === teamId, adhoc: hasSteps, notes };
}

/** team_start of a saved workflow: what the user changed in it by hand since the last save from chat — it runs as it
 *  is now (the lead should keep that, not save its earlier values back) — and where the lead's `models` for this run
 *  replace a model set by hand. */
function handNotes(projectId: string, workflowId: string, chosen: ReadonlySet<string>, d: LeadToolDeps): string[] {
  const saved = d.workflows.get(projectId, workflowId);
  const base = d.workflows.chatBase?.(projectId, workflowId);
  if (!saved || !base) return [];
  const since = changesSince(base, saved);
  if (!since.changes.length && !since.notes.length) return [];
  const line = (k: (typeof since.changes)[number]) => {
    const id = k.key.endsWith('.model') ? k.key.slice(0, -'.model'.length) : '';
    return id && chosen.has(id) ? `- ${k.key} — ${k.who}: set by hand to ${k.now} (was ${k.sent}); your models gives them another one for this run` : `- ${k.key} — ${k.who}: ${k.now} (was ${k.sent})`;
  };
  return [
    `“${saved.name}” was changed by hand after the last save from chat; this run uses it as it is now — keep these, don't save the earlier values back:`,
    ...since.notes.map((n) => `- ${n}`),
    ...since.changes.map(line),
  ];
}

/** Nothing is connected and no scripted test model stands in: nobody can work (the user may have signed out while a
 *  lead was busy). */
const NO_ACCOUNT = 'No AI account is connected now — nobody can work until the user connects one under Models & providers.';

/** Why these steps can't run now (some model isn't connected while others are), or null. */
function notConnected(steps: WorkflowStep[], d: Pick<LeadToolDeps, 'models'>): string | null {
  if (!d.models.anyAvailable()) return null;
  const off = steps.filter((s) => !d.models.isAvailable(s.model));
  if (!off.length) return null;
  const ok = d.models.models().filter((m) => m.available).map((m) => m.id);
  return `Not connected: ${off.map((s) => `“${s.name}” [${s.id}] uses ${s.model || 'no model'}`).join('; ')}. Pick from the connected models: ${ok.join(', ')}`;
}

/** One line for the plan card: what this person does — the first sentence of their persona that isn't the
 *  "You are the X …" introduction (the card shows the name already), else of their instruction. */
export function dutyOf(step: Pick<WorkflowStep, 'persona' | 'instruction' | 'kind'>): string {
  const sentences = (text: string) =>
    text
      .replace(/\{\{[^{}]*\}\}/g, ' ')
      .split(/(?<=[.!?。])\s+|\n+/)
      .map((x) => x.replace(/^[#>*•\s-]+/, '').replace(/\s+/g, ' ').trim())
      .filter((x) => x.length > 3 && !/^(?:task|brief):?$/i.test(x));
  const persona = sentences(step.persona);
  const line = persona.find((x) => !/^you are (?:the|a|an)\b/i.test(x)) ?? persona[0] ?? sentences(step.instruction)[0];
  return truncate(line ?? (step.kind === 'review' ? 'Checks the work.' : 'Does the work.'), 120);
}

// ───────────────────────── workflow_save / workflow_delete ─────────────────────────

/** What workflow_save needs to look up (LeadToolDeps has it all; tests pass fakes): in the house it saves in. */
export type WorkflowSaveContext = Pick<LeadToolDeps, 'models' | 'usedBy'> & {
  /** The house the workflow is saved in (usedBy is bound to it). */
  projectId: string;
  workflows: Pick<WorkflowStore, 'get'> & Partial<Pick<WorkflowStore, 'list' | 'chatBase' | 'libraryGet'>>;
  engine: Pick<WorkflowEngine, 'runs' | 'get' | 'teamOf'>;
};

/** The workflow to hand to saveWorkflow (ids derived, defaults written), or why it can't be saved. */
export type PreparedWorkflow = { error: string } | { workflow: Workflow; replacing?: Workflow; notes: string[] };

/** Steps with ids, loop targets, instructions and models checked (prepareSteps). */
export type PreparedSteps = { error: string } | { steps: WorkflowStep[]; notes: string[] };

const MAX_ID = 48;
const PLACEHOLDERS = new Set(['task', 'prev', 'prevName', 'runDir', 'feedback']);
const FILES_LINE = 'Put anything long (plans, drafts, reports) in files under `{{runDir}}/` and say which.';
const CHECK_LINE = 'Check the work (the files under `{{runDir}}/` and the changed files) against the task and decide.';

/** `base`, else `base-2`, `base-3`, … — kept within the 48 characters an id may have. */
function uniqueId(base: string, taken: (id: string) => boolean): string {
  if (!taken(base)) return base;
  for (let n = 2; ; n++) {
    const tail = `-${n}`;
    const id = `${base.slice(0, MAX_ID - tail.length).replace(/-+$/, '')}${tail}`;
    if (!taken(id)) return id;
  }
}

/** The prompt RLT writes for a step the lead left without an instruction. */
export function defaultInstruction(name: string, index: number, count: number, kind: WorkflowStep['kind']): string {
  if (kind === 'review') {
    const prev = index > 0 ? ['{{prevName}} reports:', '{{prev}}', ''] : [];
    return ['Task: {{task}}', '', ...prev, CHECK_LINE, VERDICT_FOOTER].join('\n');
  }
  const you = `You are the ${name}. Do your part of the task. ${FILES_LINE}`;
  if (index === 0) {
    return ['Task: {{task}}', '', you, '', count > 1 ? 'Reply with a short summary for the next person.' : 'Reply with a short summary of what you did.'].join('\n');
  }
  return ['Task: {{task}}', '', '{{prevName}} handed this on:', '{{prev}}{{feedback}}', '', you, '', 'Reply with a short summary of what you did.'].join('\n');
}

/** The steps of a workflow_save or a one-off team_start, without side effects: derive unique ASCII step ids (never
 *  `assistant`, `jobs`, `sub` or `x-…`), resolve loopBackTo (an earlier step by id or name, not in the review's own
 *  parallel group), check `parallel` (never the first step), write default instructions (review → verdict footer,
 *  loop target → {{feedback}}) and check that every model is connected (unless nothing is). */
export function prepareSteps(raw: unknown, d: Pick<LeadToolDeps, 'models'>, what: 'workflow' | 'team' = 'workflow', reserved?: ReadonlySet<string>): PreparedSteps {
  if (!Array.isArray(raw) || raw.length === 0) return { error: what === 'team' ? 'A team needs at least one person (steps).' : 'A workflow needs at least one step.' };
  if (raw.length > MAX_WORKFLOW_STEPS) return { error: `A ${what} can have at most ${MAX_WORKFLOW_STEPS} steps.` };
  const notes: string[] = [];
  const input = (raw as unknown[]).map((s) => (s && typeof s === 'object' ? (s as Record<string, unknown>) : {}));
  const taken = new Set<string>();
  // Ids given further down (or kept by people who exist: `reserved`) are theirs: a person whose id is derived never
  // takes one, e.g. someone new put first with a Thai name would otherwise take the `step-1` of the person after them.
  const givenIds = new Set(input.map((s) => str(s.id).trim()).filter((x) => SLUG.test(x)));
  const steps: WorkflowStep[] = [];
  for (const [i, s] of input.entries()) {
    const sname = str(s.name).trim().slice(0, 40);
    if (!sname) return { error: `Step ${i + 1} needs a name.` };
    const given = str(s.id).trim();
    // A name with no ASCII letters (Thai, digits only) gives `step-N`, not a bare number.
    const slug = slugify(sname).replace(/-+$/, '');
    let base = SLUG.test(given) ? given : /[a-z]/.test(slug) ? slug : `step-${i + 1}`;
    base = safeStepId(base === 'assistant' ? 'assistant-role' : base);
    const sid = uniqueId(base, (x) => taken.has(x) || (x !== given && (givenIds.has(x) || !!reserved?.has(x))));
    taken.add(sid);
    const model = str(s.model).trim();
    if (model && !MODEL_ID.test(model)) return { error: `“${sname}” needs a model id like anthropic/claude-opus-5-5 (workflow_list shows them), not “${model}”.` };
    const step: WorkflowStep = {
      id: sid,
      name: sname,
      model,
      kind: s.kind === 'review' ? 'review' : 'work',
      persona: str(s.persona),
      instruction: str(s.instruction),
    };
    if (typeof s.thinking === 'string' && (THINKING_LEVELS as readonly string[]).includes(s.thinking)) step.thinking = s.thinking as WorkflowStep['thinking'];
    if (s.parallel === true) {
      if (i === 0) return { error: `“${sname}” is the first step, so it can't be parallel (parallel: true = works at the same time as the step before it).` };
      step.parallel = true;
    }
    steps.push(step);
  }

  // loopBackTo: an earlier step by its given id, final id or name — not one of the review's own parallel group.
  const key = (v: string) => v.trim().toLowerCase();
  const groups = groupStarts(steps);
  for (const [i, s] of input.entries()) {
    const step = steps[i]!;
    const target = str(s.loopBackTo).trim();
    if (!target) continue;
    if (step.kind !== 'review') {
      notes.push(`loopBackTo only works on review steps — ignored on “${step.name}”.`);
      continue;
    }
    const byId = (j: number) => key(str(input[j]!.id)) === key(target) || key(steps[j]!.id) === key(target);
    const byName = (j: number) => key(steps[j]!.name) === key(target);
    const earlier = [...steps.keys()].slice(0, i);
    const j = earlier.find(byId) ?? earlier.find(byName);
    if (j === undefined) {
      const later = [...steps.keys()].slice(i).some((k) => byId(k) || byName(k));
      return {
        error: later
          ? `“${step.name}” can only loop back to an earlier step, and “${target}” comes later (or is the step itself).`
          : `“${step.name}” loops back to “${target}”, which is no step of this ${what} — use the id or name of an earlier step.`,
      };
    }
    if (groups[j] === groups[i]) {
      return { error: `“${step.name}” works at the same time as “${steps[j]!.name}”, so it can't send the work back to them — loop back to a step before their group.` };
    }
    step.loopBackTo = steps[j]!.id;
    if (typeof s.maxLoops === 'number') step.maxLoops = s.maxLoops;
  }

  // Instructions: RLT's default when left out; reviews end with the verdict format, loop targets get the notes.
  // People of the first group (the first step and those beside it) have no previous step.
  for (const [i, step] of steps.entries()) {
    const before = groups[i]! - 1; // the step before this one's group (-1: none)
    if (!step.instruction.trim()) {
      step.instruction = defaultInstruction(step.name, before < 0 ? 0 : i, steps.length, step.kind);
      continue;
    }
    if (step.kind === 'review' && !/verdict/i.test(step.instruction)) step.instruction += `\n\n${VERDICT_FOOTER}`;
    for (const m of step.instruction.matchAll(/\{\{\s*([^{}]*?)\s*\}\}/g)) {
      if (!PLACEHOLDERS.has(m[1]!)) notes.push(`Warning: “${step.name}” uses {{${m[1]}}}, which CAST doesn't fill (it stays as written) — the placeholders are {{task}} {{prev}} {{prevName}} {{runDir}} {{feedback}}.`);
    }
    if (before >= 0 && !/\{\{\s*(prev|runDir)\s*\}\}/.test(step.instruction)) {
      notes.push(`Note: “${step.name}”'s instruction has neither {{prev}} nor {{runDir}}, so it won't see what ${steps[before]!.name} did.`);
    }
  }
  for (const step of steps) {
    const target = step.loopBackTo && steps.find((x) => x.id === step.loopBackTo);
    if (target && !/\{\{\s*feedback\s*\}\}/.test(target.instruction)) target.instruction += '{{feedback}}';
  }

  // Models: only connected ones. Nothing connected: any (choosing isn't working; a team can't start until one is,
  // and with CAST_MOCK_LLM everyone runs on the scripted model).
  if (d.models.anyAvailable()) {
    const off = notConnected(steps, d);
    if (off) return { error: `${off}. If the user wants that model they must sign in under Models & providers first.` };
  } else if (d.models.demoActive()) {
    notes.push('No AI account is connected (CAST_MOCK_LLM test mode: steps run on the scripted model).');
  } else {
    notes.push(`${NO_ACCOUNT} The models weren't checked; team_start is refused until then.`);
  }
  return { steps, notes };
}

/** The steps of a finished run's team in this house (its team.json, `x-` taken off), or why there are none. */
function stepsOfRun(runId: string, d: Pick<WorkflowSaveContext, 'engine' | 'projectId'>): WorkflowStep[] | string {
  const run = d.engine.get(runId);
  if (!run || run.projectId !== d.projectId) return `No run with id “${runId}” in this house (team_status shows this job's runs).`;
  if (run.status === 'running' || run.status === 'waiting_approval') return `“${run.workflowName}” is still running — keep its team after the run ends.`;
  return d.engine.teamOf(runId) ?? `CAST didn't keep the team of run ${runId} — it ran before teams were kept with the run.`;
}

/** workflow_save's checks and fill-ins in the house d.projectId, without side effects: pick the id (creating never
 *  overwrites; workflows without replace: true and ids only in the library are refused), then prepareSteps
 *  (or the team of `from_run`, a run of this house). The result still goes through normalizeWorkflow when saved. */
export function prepareWorkflowSave(args: Record<string, unknown>, d: WorkflowSaveContext): PreparedWorkflow {
  let name = str(args.name).trim().slice(0, 80);
  if (!name) return { error: 'Give the workflow a name.' };
  const notes: string[] = [];

  // The workflow's id.
  const givenId = str(args.id).trim();
  const existing = givenId ? d.workflows.get(d.projectId, givenId) : undefined;
  let id: string;
  if (existing) {
    if (args.replace !== true) {
      const used = d.usedBy(givenId);
      return {
        error:
          `There already is a workflow “${existing.name}” (id ${givenId}, ${used.length ? `used by ${jobsText(used)}` : 'no job uses it'}). ` +
          'Pass replace: true to change it, or leave id out to make a new one.',
      };
    }
    id = givenId;
  } else {
    // an id only in the library: changing it means importing it first (a new workflow under its id would clash there)
    const lib = givenId ? d.workflows.libraryGet?.(givenId) : undefined;
    if (lib) return { error: `“${lib.workflow.name}” (id ${givenId}) is in the library, not in this house — workflow_import it first, then change it here (id and replace: true); or leave id out to make a new one.` };
    if (givenId && args.replace === true) notes.push(`No workflow had the id “${givenId}”, so this is a new one.`);
    // A new workflow never takes the name of one in this house's list: two "Planner → Builder → Checker" read as one
    // listed twice. It becomes "… 2", like the Workflow tab's Save as copy (#46). Other houses' names don't count.
    const twin = (n: string) => d.workflows.list?.(d.projectId).find((w) => w.name.trim().toLowerCase() === n.toLowerCase());
    const first = twin(name);
    if (first) {
      const base = name.slice(0, 76);
      for (let n = 2; twin(name); n++) name = `${base} ${n}`;
      notes.push(`A workflow called “${first.name}” already exists, so this one is “${name}”. To change that one instead, save with id "${first.id}" and replace: true.`);
    }
    const slug = slugify(name).replace(/-+$/, '');
    // nor an id in the library (importing that one here would clash with it)
    id = SLUG.test(givenId) ? givenId : uniqueId(/[a-z]/.test(slug) ? slug : 'team', (x) => !!d.workflows.get(d.projectId, x) || !!d.workflows.libraryGet?.(x));
  }

  // The steps: given, or the team of a finished run.
  let raw: unknown = args.steps;
  const fromRun = str(args.from_run).trim();
  if (fromRun) {
    if (args.steps !== undefined) return { error: 'Pass steps or from_run, not both.' };
    const team = stepsOfRun(fromRun, d);
    if (typeof team === 'string') return { error: team };
    raw = team;
  }
  // Changing a workflow: people sent without an id keep the id of the person with their name (a Thai name would
  // get `step-N` by position; a new person never takes the id of someone who exists or existed).
  const claimed = existing && !fromRun ? claimStepIds(raw, existing, d.workflows.chatBase?.(d.projectId, id)) : null;
  const prep = prepareSteps(claimed ? claimed.steps : raw, d, 'workflow', claimed?.reserved);
  if ('error' in prep) return prep;
  notes.push(...prep.notes);

  // Replacing keeps the stored description and icon unless the args give new ones.
  const keep = (given: unknown, stored: string | undefined) => (str(given).trim() ? str(given) : (stored ?? ''));
  const fromRunDesc = fromRun ? `Kept from a run: “${truncate((d.engine.get(fromRun)?.task ?? '').replace(/\s+/g, ' '), 200)}”` : undefined;
  const workflow: Workflow = {
    id,
    name,
    description: keep(args.description, existing?.description ?? fromRunDesc),
    icon: keep(args.icon, existing?.icon ?? (fromRun ? ADHOC_ICON : undefined)),
    steps: prep.steps,
  };
  return { workflow, replacing: existing, notes };
}

/** Why this house's workflow can't be deleted (some job's team, running now), or null. */
export function workflowDeleteProblem(id: string, d: Pick<WorkflowSaveContext, 'usedBy' | 'workflows' | 'projectId'> & { engine: Pick<WorkflowEngine, 'runs'> }): string | null {
  const w = d.workflows.get(d.projectId, id);
  if (!w) return `No workflow with id “${id}” in this house.`;
  const used = d.usedBy(id);
  if (used.length) return `“${w.name}” is the team of ${jobsText(used)} — pick another team there first (Edit job → Team), or delete it and leave ${used.length === 1 ? 'that job' : 'those jobs'} with no fixed team.`;
  if (liveRunOf(d.engine, d.projectId, id)) return `“${w.name}” is running right now — delete it after the run ends.`;
  return null;
}

function latestRun(engine: WorkflowEngine, projectId: string, jobId: string): WorkflowRun | undefined {
  return runsOf(engine, projectId, jobId)[0];
}

/** A job's runs, newest first. */
function runsOf(engine: Pick<WorkflowEngine, 'runs'>, projectId: string, jobId: string): WorkflowRun[] {
  return engine
    .runs()
    .filter((r) => r.projectId === projectId && r.jobId === jobId)
    .sort((a, b) => b.startedAt - a.startedAt);
}

const STATUS: Record<WorkflowRun['status'], string> = {
  running: 'running',
  waiting_approval: 'waiting for the user to approve a step',
  completed: 'completed',
  failed: 'failed',
  aborted: 'stopped',
};

export function duration(ms: number): string {
  const secs = Math.max(0, Math.round(ms / 1000));
  return secs >= 90 ? `${Math.round(secs / 60)} min` : `${secs}s`;
}

/** "14:05" — when a run started (the server's local time). */
function clock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** The run in a few lines: status, its id (and the run it continues), each step of the team with its id (latest
 *  attempt; kept from an earlier run), what the current person does now, and — once it ended — how to redo only part
 *  of it. `detail` (team_status): a line of each step's result; `earlier`: this job's other runs (newest first). The
 *  first line stays as it is: the scripted test model reads it. */
export function describeRun(run: WorkflowRun, d: Pick<LeadToolDeps, 'workflows' | 'store'>, opts: { detail?: boolean; earlier?: WorkflowRun[] } = {}): string {
  const live = run.status === 'running' || run.status === 'waiting_approval';
  // The run's own team (a one-off team is in no workflow); runs saved before teams were kept: the workflow, else
  // the steps the run went through (named after their people).
  const steps: { id: string; name: string; parallel?: boolean; edited?: true }[] =
    run.team ??
    d.workflows.get(run.projectId, run.workflowId)?.steps ??
    [...new Map(run.steps.map((s) => [s.stepId, { id: s.stepId, name: d.store.get(s.agentId)?.name ?? s.stepId }])).values()];
  const from = run.continues ? steps.find((s) => s.id === run.continues!.stepId) : undefined;
  const lines = [
    `“${run.workflowName}” — ${STATUS[run.status]}, ${duration((run.endedAt ?? Date.now()) - run.startedAt)}${live ? ' so far' : ''}, $${run.costUsd.toFixed(2)}.` +
      `${run.loop ? ` Review rounds: ${run.loop}.` : ''}`,
    `Task: ${truncate(run.task.replace(/\s+/g, ' '), 300)}`,
    `Run ${run.id}${run.continues ? ` — continues run ${run.continues.runId} from ${from?.name ?? writtenStepId(run.continues.stepId)}${run.continues.note ? `, note: “${truncate(run.continues.note.replace(/\s+/g, ' '), 200)}”` : ''}` : ''}.`,
    'Steps:',
  ];
  for (const step of steps) {
    const rs = run.steps.filter((s) => s.stepId === step.id).at(-1);
    let state = rs ? (rs.status === 'running' ? 'working' : rs.status) : live ? 'not started' : 'skipped';
    if (rs?.verdict) state += ` (${rs.verdict})`;
    if (rs?.reused) state += ` (kept from ${rs.reused.runId})`;
    if (step.edited) state += ' (changed during the run)';
    if (rs?.status === 'running') {
      const a = d.store.get(rs.agentId);
      if (a?.detail) state += ` — ${a.detail}`;
    }
    // the step's id last, so the line still reads "- Name: state" (team_continue's from_step takes the id)
    lines.push(`- ${step.name}${step.parallel ? ' (at the same time as the one before)' : ''}: ${state} [${writtenStepId(step.id)}]`);
    if (opts.detail && rs?.output && rs.status !== 'running') lines.push(`    said: “${truncate(rs.output.replace(/\s+/g, ' ').trim(), 160)}”`);
  }
  const last = run.steps.filter((s) => s.output && s.status !== 'running').at(-1);
  if (last) {
    const name = steps.find((s) => s.id === last.stepId)?.name ?? last.stepId;
    lines.push(`Latest output (${name}): ${truncate(last.output!.replace(/\s+/g, ' '), 600)}`);
  }
  lines.push(`Folder: .rlt/runs/${run.id}/ (task.md, then one NN-<step>.md per finished step).`);
  if (run.edits?.length) {
    const by = (e: NonNullable<WorkflowRun['edits']>[number]) => (e.by === 'user' ? 'by the user on the run card' : 'by you');
    const shown = run.edits.slice(-3).map((e) => `${clock(e.at)} ${e.changes.join('; ')} (${by(e)}${e.saved ? `, also saved to “${e.saved}”` : ''})`);
    const more = (run.planRev ?? run.edits.length) - shown.length;
    lines.push(`Changed while it ran: ${shown.join(' · ')}${more > 0 ? ` (and ${more} earlier change${more === 1 ? '' : 's'})` : ''} — this run only unless it says saved.`);
  }
  // while it runs: what team_edit can still change (never stop and restart it for that)
  const left = live && run.planAt ? steps.slice(run.planAt.end) : [];
  if (left.length) lines.push(`While it runs: team_edit changes the steps that haven't started (${left.map((s) => writtenStepId(s.id)).join(', ')}) without stopping it.`);
  if (!live && steps.length) {
    lines.push(
      run.revertedAt
        ? 'Its files were reverted, so it can only run again from the start — team_start (or team_continue from its first step).'
        : `To redo only part of this run: team_continue with from_step (${steps.map((s) => writtenStepId(s.id)).join(', ')}) — the steps before it keep their results; the files stay as they are.`,
    );
  }
  const earlier = (opts.earlier ?? []).slice(0, 3);
  if (earlier.length) lines.push(`Earlier runs of this job: ${earlier.map((r) => `${r.id} “${r.workflowName}” ${STATUS[r.status]} ${clock(r.startedAt)}`).join(' · ')}.`);
  return lines.join('\n');
}
