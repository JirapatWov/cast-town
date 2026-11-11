// A going run's plan on the run card (get_run_plan / edit_run, like the lead's team_edit): which steps can still
// change, the edit op for a changed step, a person to add and the "Changed during the run" line. Pure — the dialogs
// are in run-edit.ts.
import type { RunEdit, RunEditOp, RunPlanView, RunTeamMember, WorkflowRun, WorkflowStep } from '../../../shared/protocol';
import { timeOfDay } from './format';

/** Index into run.team from which steps can still change: after the group working or starting now (run.planAt).
 *  Infinity while nothing can (the run ended, or a server without run edits). */
export function editableFrom(run: Pick<WorkflowRun, 'status' | 'planAt'>): number {
  if (run.status !== 'running' && run.status !== 'waiting_approval') return Infinity;
  return run.planAt ? run.planAt.end : Infinity;
}

/** The step ids of the group working now (a note can reach them). */
export function workingNow(run: Pick<WorkflowRun, 'status' | 'planAt'>, team: Pick<RunTeamMember, 'id'>[]): string[] {
  if (run.status !== 'running' && run.status !== 'waiting_approval') return [];
  return run.planAt ? team.slice(run.planAt.start, run.planAt.end).map((m) => m.id) : [];
}

const FIELDS = ['name', 'model', 'thinking', 'persona', 'instruction', 'kind', 'loopBackTo', 'maxLoops', 'parallel'] as const;

/** The update op for a step changed in the editor, or null when nothing changed. thinking / loopBackTo that went
 *  away become '' (the default effort / sends nothing back; not for a step that no longer reviews); parallel that went
 *  away is false. */
export function stepOps(before: WorkflowStep, after: WorkflowStep): RunEditOp | null {
  const op: RunEditOp = { op: 'update', step: before.id };
  let any = false;
  for (const k of FIELDS) {
    const a = before[k];
    const b = after[k];
    if ((a ?? null) === (b ?? null) || (k === 'parallel' && !a && !b)) continue;
    // a step that stops reviewing sends nothing back any more (the server drops it with the kind)
    if ((k === 'loopBackTo' || k === 'maxLoops') && after.kind !== 'review') continue;
    any = true;
    if (k === 'thinking') op.thinking = b === undefined ? '' : (b as RunEditOp['thinking']);
    else if (k === 'loopBackTo') op.loopBackTo = typeof b === 'string' ? b : '';
    else if (k === 'parallel') op.parallel = b === true;
    else if (k === 'maxLoops') op.maxLoops = typeof b === 'number' ? b : 2;
    else if (k === 'kind') op.kind = b as WorkflowStep['kind'];
    else op[k] = (b as string | undefined) ?? '';
  }
  return any ? op : null;
}

/** The add op for a new person after `after` (a step id; '' = at the end). */
export function addOp(step: WorkflowStep, after: string): RunEditOp {
  const person: RunEditOp['person'] = { name: step.name.trim() || 'New person', model: step.model, kind: step.kind, persona: step.persona };
  if (step.instruction.trim()) person.instruction = step.instruction;
  if (step.thinking) person.thinking = step.thinking;
  if (step.kind === 'review' && step.loopBackTo) {
    person.loopBackTo = step.loopBackTo;
    person.maxLoops = step.maxLoops ?? 2;
  }
  return { op: 'add', ...(after ? { after } : {}), person };
}

/** Where a new person can go: after the group working now (its last step) or after any later step. */
export function addPlaces(view: Pick<RunPlanView, 'steps' | 'frozen'>): { after: string; label: string }[] {
  const out: { after: string; label: string }[] = [];
  const now = view.steps[view.frozen - 1];
  if (now) out.push({ after: now.id, label: `After ${now.name} (next)` });
  for (const s of view.steps.slice(view.frozen)) out.push({ after: s.id, label: `After ${s.name}` });
  return out;
}

/** One edit for the card: "14:02 · Editor: instruction; added Proofreader — by you (also saved)". */
export function editedLine(e: RunEdit): string {
  return `${timeOfDay(e.at)} · ${e.changes.join('; ')} — by ${e.by === 'user' ? 'you' : 'the lead'}${e.saved ? ` (also saved to “${e.saved}”)` : ''}`;
}

/** A blank person for "Add a person": the model of the step before. */
export function blankStep(view: Pick<RunPlanView, 'steps'>, after: string): WorkflowStep {
  const prev = view.steps.find((s) => s.id === after) ?? view.steps.at(-1);
  return { id: `new-${Date.now().toString(36)}`, name: '', model: prev?.model ?? 'anthropic/claude-sonnet-5-5', persona: '', instruction: '', kind: 'work' };
}
