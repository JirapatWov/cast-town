// Changing a running team (the lead's team_edit, edit_run from the run card): the run keeps going. Its steps that
// haven't started yet can change — prompt, persona, model, effort, review loop — and people can be added, removed or
// moved among them; the group working now and every step before it stay exactly as they are (their results stand,
// nobody is restarted), and a note reaches the person working now. The pure part (parseRunEditOps, planRunEdit) works
// on the engine's RunPlanView; applyRunEdit puts it into the run (WorkflowEngine.editRun) and, when asked, into the
// saved workflow for next time too. A change to a step that finished or works now means redoing work: the planner
// says which step (`frozen`), the caller refuses or — the lead's redo: true, after asking the user — continues the
// run from there (lead-tools).
import { MAX_WORKFLOW_STEPS, THINKING_LEVELS, type RunEditOp, type RunPlanView, type ThinkingLevel, type Workflow, type WorkflowRun, type WorkflowStep } from '../../shared/protocol';
import { VERDICT_FOOTER } from './templates';
import { errorText, truncate } from './util';
import { stepKey, writtenStepId, type RunEditResult, type WorkflowEngine } from './workflow-engine';
import { groupStarts, safeStepId, SLUG, slugify, type WorkflowStore } from './workflow-store';

const MODEL_ID = /^[\w.-]+\/[\w./:@-]+$/;
const MAX_ID = 48;
const MAX_PERSONA = 4000;
const MAX_INSTRUCTION = 8000;
const MAX_OPS = 20;
const OPS = new Set<RunEditOp['op']>(['update', 'add', 'remove', 'move', 'note']);
const UPDATE_FIELDS = ['name', 'model', 'thinking', 'persona', 'instruction', 'add_to_instruction', 'kind', 'loopBackTo', 'maxLoops', 'parallel'] as const;
const STRING_FIELDS = ['step', 'after', 'name', 'model', 'persona', 'instruction', 'add_to_instruction', 'loopBackTo', 'text'] as const;
const FEEDBACK = /\{\{\s*feedback\s*\}\}/;

/** How a step stands in the run, in the words team_status uses. */
const STATE_WORD: Record<RunPlanView['states'][string], string> = { done: 'done', starting: 'starting now', working: 'working', finished: 'done', next: 'not started' };

/** The ops of a team_edit / edit_run call, checked for shape (what each op needs), or why not. */
export function parseRunEditOps(raw: unknown): RunEditOp[] | { error: string } {
  if (!Array.isArray(raw) || !raw.length) return { error: 'Pass ops: a list of changes, e.g. [{"op":"update","step":"editor","add_to_instruction":"…"}].' };
  if (raw.length > MAX_OPS) return { error: `At most ${MAX_OPS} changes at once.` };
  const out: RunEditOp[] = [];
  for (const [i, r] of raw.entries()) {
    const at = `ops[${i}]`;
    if (!r || typeof r !== 'object' || Array.isArray(r)) return { error: `${at} must be an object like {"op":"update","step":"editor","instruction":"…"}.` };
    const o = r as Record<string, unknown>;
    if (typeof o.op !== 'string' || !OPS.has(o.op as RunEditOp['op'])) return { error: `${at}.op must be one of update, add, remove, move, note.` };
    const e: RunEditOp = { op: o.op as RunEditOp['op'] };
    for (const k of STRING_FIELDS) {
      if (o[k] === undefined) continue;
      if (typeof o[k] !== 'string') return { error: `${at}.${k} must be a string.` };
      e[k] = o[k] as string;
    }
    if (o.thinking !== undefined) {
      // 'default' from team_edit (its schema can't list '': Gemini refuses empty enum values), '' from the page
      const t = o.thinking === 'default' ? '' : o.thinking;
      if (t !== '' && !(THINKING_LEVELS as readonly unknown[]).includes(t)) return { error: `${at}.thinking must be one of ${THINKING_LEVELS.join(', ')} (or default).` };
      e.thinking = t as ThinkingLevel | '';
    }
    if (o.kind !== undefined) {
      if (o.kind !== 'work' && o.kind !== 'review') return { error: `${at}.kind must be work or review.` };
      e.kind = o.kind;
    }
    if (o.maxLoops !== undefined) {
      if (typeof o.maxLoops !== 'number' || !Number.isInteger(o.maxLoops) || o.maxLoops < 0 || o.maxLoops > 5) return { error: `${at}.maxLoops must be a whole number 0–5.` };
      e.maxLoops = o.maxLoops;
    }
    if (o.parallel !== undefined) {
      if (typeof o.parallel !== 'boolean') return { error: `${at}.parallel must be true or false.` };
      e.parallel = o.parallel;
    }
    if (o.person !== undefined) {
      if (!o.person || typeof o.person !== 'object' || Array.isArray(o.person)) return { error: `${at}.person must be an object with the new person's name, model and persona.` };
      e.person = o.person as RunEditOp['person'];
    }
    if (e.op === 'add') {
      if (typeof e.person?.name !== 'string' || !e.person.name.trim()) return { error: `${at}: add needs person — at least their name and model (and a persona).` };
    } else if (!e.step?.trim()) {
      return { error: `${at}: ${e.op} needs step — the id (or name) of a step from team_status.` };
    }
    if (e.op === 'note' && !e.text?.trim()) return { error: `${at}: note needs text — what they should know.` };
    if (e.op === 'move' && !e.after?.trim()) return { error: `${at}: move needs after — the step it should come after.` };
    if (e.op === 'update' && !UPDATE_FIELDS.some((k) => e[k] !== undefined)) {
      return { error: `${at}: update needs something to change — instruction, add_to_instruction, persona, model, thinking, name, kind, loopBackTo, maxLoops or parallel.` };
    }
    out.push(e);
  }
  return out;
}

export interface RunEditContext {
  models: { anyAvailable(): boolean; isAvailable(selector: string): boolean; models(): { id: string; available: boolean }[] };
  /** The prompt CAST writes for a person added without one (lead-tools' defaultInstruction). */
  defaultInstruction(name: string, index: number, count: number, kind: WorkflowStep['kind']): string;
  /** More ids a new person can't take (the job's people, the saved workflow's steps). */
  taken?: Iterable<string>;
}

/** The earliest step that finished or works now whose definition an edit changes. */
export interface FrozenTouch {
  index: number;
  id: string;
  name: string;
  state: RunPlanView['states'][string];
  /** Where a redo would continue from: the first step of its group. */
  from: { index: number; id: string; name: string };
}

export interface PlannedEdit {
  steps: WorkflowStep[]; // the whole plan after the edit, step ids as written
  changes: string[]; // short, for run.edits and toasts: "Editor: instruction", "added Proofreader"
  lines: string[]; // for the lead: "- Editor: instruction changed."
  warnings: string[];
  notes: { stepId: string; text: string }[]; // for people of the group working or starting now
  added: string[]; // ids of people added
  frozen?: FrozenTouch;
}

/** Apply `ops` to a run's plan, without side effects: every change checked (steps by id, `x-` id or name; models
 *  connected; a review's loop target earlier and outside its group; at most 12 steps; nobody joins the group working
 *  now), a new person's id unique, an instruction left out written by CAST. Steps before `view.frozen` are never
 *  moved and nothing is inserted before it; a change to their definition is made in the result but reported in
 *  `frozen` — the caller refuses it (or redoes from there). */
export function planRunEdit(view: RunPlanView, ops: RunEditOp[], ctx: RunEditContext): PlannedEdit | { error: string } {
  const before = view.steps;
  const steps = structuredClone(view.steps);
  const F = view.frozen;
  const stateOf = (id: string): RunPlanView['states'][string] => view.states[id] ?? 'next';
  const changes: string[] = [];
  const lines: string[] = [];
  const warnings: string[] = [];
  const notes: PlannedEdit['notes'] = [];
  const added: string[] = [];
  const reviewsTouched = new Set<string>();
  const taken = new Set<string>([...view.taken, ...before.map((s) => s.id), ...(ctx.taken ?? []), 'assistant']);
  const err = (error: string) => ({ error });

  const find = (ref: string): number => {
    const r = ref.trim();
    let i = steps.findIndex((s) => s.id === r);
    if (i < 0) i = steps.findIndex((s) => s.id === writtenStepId(r));
    if (i < 0) i = steps.findIndex((s) => s.name.trim().toLowerCase() === r.toLowerCase());
    return i;
  };
  const unknown = (ref: string) =>
    err(`No step “${truncate(ref.trim(), 60)}” in this run — its steps: ${steps.map((s) => `${s.id} (${STATE_WORD[stateOf(s.id)]})`).join(', ')}.`);
  const groupEnd = (i: number) => {
    const starts = groupStarts(steps);
    let e = i + 1;
    while (e < steps.length && starts[e] === starts[i]) e++;
    return e;
  };
  const nowNames = () => before.slice(view.done, F).map((s) => s.name).join(' + ') || 'the step working now';
  const offModel = (m: string) => ctx.models.anyAvailable() && !ctx.models.isAvailable(m);
  const checkModel = (name: string, m: string): string | null => {
    if (!MODEL_ID.test(m)) return `“${name}” needs a model id like anthropic/claude-opus-5-5 (workflow_list shows them), not “${m}”.`;
    if (offModel(m)) return `“${name}” can't use ${m} — it isn't connected. Connected models: ${ctx.models.models().filter((x) => x.available).map((x) => x.id).join(', ')}.`;
    return null;
  };
  const newId = (given: unknown, name: string, at: number) => {
    const slug = slugify(name).replace(/-+$/, '');
    const g = typeof given === 'string' ? given.trim() : '';
    let base = SLUG.test(g) ? g : /[a-z]/.test(slug) ? slug : `step-${at + 1}`;
    base = safeStepId(base === 'assistant' ? 'assistant-role' : base);
    const used = (x: string) => taken.has(x) || steps.some((s) => s.id === x);
    if (!used(base)) return base;
    for (let n = 2; ; n++) {
      const tail = `-${n}`;
      const id = `${base.slice(0, MAX_ID - tail.length).replace(/-+$/, '')}${tail}`;
      if (!used(id)) return id;
    }
  };
  /** The group leader leaves its place: the next one of its group leads it. */
  const unhook = (i: number) => {
    if (!steps[i]!.parallel && steps[i + 1]?.parallel) delete steps[i + 1]!.parallel;
  };

  for (const op of ops) {
    if (op.op === 'add') {
      const p = op.person!;
      const name = p.name.trim().slice(0, 40);
      let at = steps.length;
      if (op.after?.trim()) {
        const j = find(op.after);
        if (j < 0) return unknown(op.after);
        at = groupEnd(j);
        if (at < F) return err(`“${steps[j]!.name}” already finished — a new person can only come after the group working now (${nowNames()}): add them with after: "${steps[F - 1]!.id}" or a later step.`);
      }
      if (steps.length >= MAX_WORKFLOW_STEPS) return err(`A team can have at most ${MAX_WORKFLOW_STEPS} steps.`);
      const model = typeof p.model === 'string' ? p.model.trim() : '';
      if (!model) return err(`“${name}” needs a model (a connected model id from workflow_list).`);
      const bad = checkModel(name, model);
      if (bad) return err(bad);
      const persona = typeof p.persona === 'string' ? p.persona : '';
      if (persona.length > MAX_PERSONA) return err(`“${name}”'s persona is too long (at most ${MAX_PERSONA} characters).`);
      const step: WorkflowStep = { id: newId(p.id, name, at), name, model, kind: p.kind === 'review' ? 'review' : 'work', persona, instruction: typeof p.instruction === 'string' ? p.instruction : '' };
      if (typeof p.thinking === 'string' && (THINKING_LEVELS as readonly string[]).includes(p.thinking)) step.thinking = p.thinking;
      if (p.parallel === true) {
        if (at === 0) return err(`“${name}” is the first step, so it can't be parallel.`);
        if (at === F && F > 0) return err(`“${name}” can't join the group working now (${nowNames()}) — add them after them, without parallel.`);
        step.parallel = true;
      }
      steps.splice(at, 0, step);
      taken.add(step.id);
      const lead = groupStarts(steps)[at]! - 1; // the step before this one's group (-1: none)
      if (!step.instruction.trim()) step.instruction = ctx.defaultInstruction(name, lead < 0 ? 0 : at, steps.length, step.kind);
      else if (step.kind === 'review' && !/verdict/i.test(step.instruction)) step.instruction += `\n\n${VERDICT_FOOTER}`;
      if (step.instruction.length > MAX_INSTRUCTION) return err(`“${name}”'s instruction is too long (at most ${MAX_INSTRUCTION} characters).`);
      const target = typeof p.loopBackTo === 'string' ? p.loopBackTo.trim() : '';
      if (target) {
        if (step.kind !== 'review') warnings.push(`loopBackTo only works on review steps — ignored on “${name}”.`);
        else {
          const j = find(target);
          if (j < 0 || j >= at) return err(`“${name}” can only loop back to an earlier step — “${truncate(target, 60)}” ${j < 0 ? 'is no step of this run' : 'comes later'}.`);
          step.loopBackTo = steps[j]!.id;
          step.maxLoops = typeof p.maxLoops === 'number' ? Math.max(0, Math.min(5, Math.round(p.maxLoops))) : 2;
          reviewsTouched.add(step.id);
        }
      }
      added.push(step.id);
      const after = steps[at - 1];
      changes.push(`added ${name}`);
      lines.push(`- Added ${name} [${step.id}] ${after ? `after ${after.name}` : 'first'} (${model}${step.thinking ? `, effort ${step.thinking}` : ''}).`);
      continue;
    }

    const i = find(op.step!);
    if (i < 0) return unknown(op.step!);
    const s = steps[i]!;

    if (op.op === 'note') {
      const text = op.text!.trim();
      if (i < F) {
        const st = stateOf(s.id);
        if (st === 'done' || st === 'finished') return err(`“${s.name}” already finished their step in this run — a note can't reach them now (changing their step means redoing it: ask the user first).`);
        notes.push({ stepId: s.id, text });
        changes.push(`note to ${s.name}`);
        lines.push(st === 'starting' ? `- Note for ${s.name}: they get it with their step's prompt.` : `- Note sent to ${s.name} (they read it at their next step).`);
      } else {
        // not started yet: the note goes into their prompt for this run
        s.instruction = addParagraph(s.instruction, `Note from the user for this step:\n${text}`);
        if (s.instruction.length > MAX_INSTRUCTION) return err(`“${s.name}”'s instruction would be too long (at most ${MAX_INSTRUCTION} characters).`);
        changes.push(`${s.name}: note in their prompt`);
        lines.push(`- ${s.name} hasn't started yet: the note is in their prompt.`);
      }
      continue;
    }

    if (op.op === 'remove') {
      if (i < F) return err(`“${s.name}” ${stateOf(s.id) === 'done' || stateOf(s.id) === 'finished' ? 'already finished' : 'works now'} — only steps that haven't started can be removed.`);
      unhook(i);
      steps.splice(i, 1);
      changes.push(`removed ${s.name}`);
      lines.push(`- Removed ${s.name} [${s.id}].`);
      continue;
    }

    if (op.op === 'move') {
      if (i < F) return err(`“${s.name}” ${stateOf(s.id) === 'done' || stateOf(s.id) === 'finished' ? 'already finished' : 'works now'} — only steps that haven't started can move.`);
      const j0 = find(op.after!);
      if (j0 < 0) return unknown(op.after!);
      if (j0 === i) return err(`“${s.name}” can't come after itself.`);
      const afterStep = steps[j0]!;
      unhook(i);
      steps.splice(i, 1);
      delete s.parallel;
      const at = groupEnd(steps.indexOf(afterStep));
      if (at < F) return err(`“${s.name}” can only move after the group working now (${nowNames()}) or a later step.`);
      steps.splice(at, 0, s);
      changes.push(`moved ${s.name} after ${afterStep.name}`);
      lines.push(`- Moved ${s.name} after ${afterStep.name}.`);
      continue;
    }

    // update: `what` says it short (run.edits, toasts), `said` for the lead
    const what: string[] = [];
    const said: string[] = [];
    const did = (short: string, long = `${short} changed`) => {
      what.push(short);
      said.push(long);
    };
    if (op.name !== undefined) {
      const n = op.name.trim().slice(0, 40);
      if (!n) return err("A name can't be empty.");
      if (n !== s.name) {
        did('name', `renamed from ${s.name}`);
        s.name = n;
      }
    }
    if (op.model !== undefined) {
      const m = op.model.trim();
      const bad = checkModel(s.name, m);
      if (bad) return err(bad);
      if (m !== s.model) {
        s.model = m;
        did('model', `model → ${m}`);
      }
    }
    if (op.thinking !== undefined && op.thinking !== (s.thinking ?? '')) {
      if (op.thinking) s.thinking = op.thinking;
      else delete s.thinking;
      did('effort', `effort → ${op.thinking || 'default'}`);
    }
    if (op.persona !== undefined) {
      if (op.persona.length > MAX_PERSONA) return err(`“${s.name}”'s persona is too long (at most ${MAX_PERSONA} characters).`);
      if (op.persona !== s.persona) {
        s.persona = op.persona;
        did('persona');
      }
    }
    if (op.kind !== undefined && op.kind !== s.kind) {
      s.kind = op.kind;
      if (op.kind === 'review') {
        if (!/verdict/i.test(s.instruction)) s.instruction = `${s.instruction.replace(/\s+$/, '')}\n\n${VERDICT_FOOTER}`;
        did('reviews', 'now reviews (ends with a verdict)');
      } else {
        s.instruction = s.instruction.replace(`\n\n${VERDICT_FOOTER}`, '').replace(VERDICT_FOOTER, '').replace(/\s+$/, '') || '{{task}}';
        delete s.loopBackTo;
        delete s.maxLoops;
        did('works', 'now works (no review)');
      }
    }
    if (op.instruction !== undefined) {
      if (!op.instruction.trim()) return err(`“${s.name}”'s instruction can't be empty.`);
      let next = op.instruction;
      if (s.kind === 'review' && !/verdict/i.test(next)) next += `\n\n${VERDICT_FOOTER}`;
      if (next.length > MAX_INSTRUCTION) return err(`“${s.name}”'s instruction is too long (at most ${MAX_INSTRUCTION} characters).`);
      if (next !== s.instruction) {
        s.instruction = next;
        did('instruction');
      }
    }
    if (op.add_to_instruction !== undefined && op.add_to_instruction.trim()) {
      s.instruction = addParagraph(s.instruction, op.add_to_instruction.trim());
      if (s.instruction.length > MAX_INSTRUCTION) return err(`“${s.name}”'s instruction would be too long (at most ${MAX_INSTRUCTION} characters).`);
      if (!what.includes('instruction')) did('instruction', 'instruction changed (a paragraph added)');
    }
    if (op.loopBackTo !== undefined) {
      if (s.kind !== 'review') return err(`loopBackTo only works on review steps — “${s.name}” works (kind: work).`);
      const target = op.loopBackTo.trim();
      if (!target) {
        if (s.loopBackTo) {
          delete s.loopBackTo;
          delete s.maxLoops;
          did('review loop', 'sends nothing back now');
        }
      } else {
        const j = find(target);
        if (j < 0) return unknown(target);
        if (j >= i) return err(`“${s.name}” can only loop back to an earlier step, and “${steps[j]!.name}” comes later (or is the step itself).`);
        if (groupStarts(steps)[j] === groupStarts(steps)[i]) return err(`“${s.name}” works at the same time as “${steps[j]!.name}”, so it can't send the work back to them — loop back to a step before their group.`);
        if (s.loopBackTo !== steps[j]!.id) {
          s.loopBackTo = steps[j]!.id;
          s.maxLoops ??= 2;
          reviewsTouched.add(s.id);
          did('review loop', `sends the work back to ${steps[j]!.name}`);
        }
      }
    }
    if (op.maxLoops !== undefined && s.loopBackTo && op.maxLoops !== (s.maxLoops ?? 2)) {
      s.maxLoops = op.maxLoops;
      did('rounds', `up to ${op.maxLoops} rounds`);
    }
    if (op.parallel !== undefined && op.parallel !== !!s.parallel) {
      if (op.parallel) {
        if (i === 0) return err(`“${s.name}” is the first step, so it can't be parallel.`);
        if (i === F && F > 0) return err(`“${s.name}” can't join the group working now (${nowNames()}) — it starts after them.`);
        s.parallel = true;
        did('same time', 'works at the same time as the step before');
      } else {
        delete s.parallel;
        did('on its own', 'works on its own');
      }
    }
    if (!what.length) {
      lines.push(`- ${s.name}: already like that (no change).`);
      continue;
    }
    changes.push(`${s.name}: ${what.join(', ')}`);
    lines.push(`- ${s.name}: ${said.join(', ')}.`);
  }

  // The team as a whole.
  if (!steps.length) return err('A team needs at least one step.');
  if (steps.length > MAX_WORKFLOW_STEPS) return err(`A team can have at most ${MAX_WORKFLOW_STEPS} steps.`);
  if (steps[0]!.parallel) delete steps[0]!.parallel;
  if (F > 0 && steps[F]?.parallel) return err(`“${steps[F]!.name}” can't join the group working now (${nowNames()}) — it starts after them.`);
  const starts = groupStarts(steps);
  for (const [k, s] of steps.entries()) {
    if (!s.loopBackTo) continue;
    const t = steps.findIndex((x) => x.id === s.loopBackTo);
    if (t < 0) {
      const gone = before.find((x) => x.id === s.loopBackTo)?.name ?? s.loopBackTo;
      return err(`“${s.name}” sends the work back to “${gone}”, which is no longer in the team — change that first ({"op":"update","step":"${s.id}","loopBackTo":"…"}; "" = none) or remove “${s.name}” too.`);
    }
    if (t >= k) return err(`“${s.name}” can only loop back to an earlier step, and “${steps[t]!.name}” comes later.`);
    if (starts[t] === starts[k]) return err(`“${s.name}” works at the same time as “${steps[t]!.name}”, so it can't send the work back to them.`);
    // a review's notes reach its loop target in {{feedback}}
    if (!reviewsTouched.has(s.id) || FEEDBACK.test(steps[t]!.instruction)) continue;
    if (t >= F) steps[t]!.instruction += '{{feedback}}';
    else warnings.push(`${steps[t]!.name}'s instruction has no {{feedback}}, so ${s.name}'s notes reach them only in {{prev}}.`);
  }

  // A change to a step that finished or works now (its definition): the caller refuses or redoes from there.
  let frozen: FrozenTouch | undefined;
  for (let k = 0; k < Math.min(F, steps.length); k++) {
    if (stepKey(steps[k]!) === stepKey(before[k]!)) continue;
    const from = starts[k]!;
    frozen = { index: k, id: before[k]!.id, name: before[k]!.name, state: stateOf(before[k]!.id), from: { index: from, id: steps[from]!.id, name: steps[from]!.name } };
    break;
  }
  return { steps, changes, lines, warnings, notes, added, ...(frozen ? { frozen } : {}) };
}

/** A paragraph added to a prompt: before a review's verdict format (it stays the last thing the reviewer reads). */
export function addParagraph(instruction: string, text: string): string {
  const at = instruction.indexOf(VERDICT_FOOTER);
  if (at < 0) return `${instruction.replace(/\s+$/, '')}\n\n${text}`;
  const head = instruction.slice(0, at).replace(/\s+$/, '');
  return `${head}${head ? '\n\n' : ''}${text}\n\n${instruction.slice(at)}`;
}

/** "A", "A and B", "A, B and C". */
function andList(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** "A → B + C": people in order, those who work at the same time joined with " + ". */
function chainOf(steps: Pick<WorkflowStep, 'name' | 'parallel'>[]): string {
  return steps.map((s, i) => `${i === 0 ? '' : s.parallel ? ' + ' : ' → '}${s.name}`).join('');
}

const uniq = (xs: string[]) => [...new Set(xs)];

/** Who keeps what: "Idea-maker keeps its result, Writer keeps working (not restarted)". */
export function keepsText(view: RunPlanView): string {
  const done = uniq([...view.steps.slice(0, view.done), ...view.steps.slice(view.done, view.frozen).filter((s) => view.states[s.id] === 'finished')].map((s) => s.name));
  const now = view.steps.slice(view.done, view.frozen).filter((s) => view.states[s.id] !== 'finished');
  const parts = [
    done.length ? `${andList(done)} ${done.length === 1 ? 'keeps its result' : 'keep their results'}` : '',
    now.length
      ? now.every((s) => view.states[s.id] === 'starting')
        ? `${andList(now.map((s) => s.name))} start${now.length === 1 ? 's' : ''} as planned`
        : `${andList(now.map((s) => s.name))} keep${now.length === 1 ? 's' : ''} working (not restarted)`
      : '',
  ].filter(Boolean);
  return parts.join(', ') || 'nothing that started changes';
}

/** The lead's refusal for a change to a step that finished or works now: what would be redone, and redo: true. */
export function frozenRefusal(view: RunPlanView, f: FrozenTouch): string {
  const working = view.steps.slice(view.done, view.frozen).filter((s) => view.states[s.id] !== 'finished').map((s) => s.name);
  const keptBefore = uniq(view.steps.slice(0, f.from.index).map((s) => s.name));
  if (f.state === 'done' || f.state === 'finished') {
    const now = working.length ? ` (${andList(working)} ${working.length === 1 ? 'is' : 'are'} working on it now)` : '';
    return (
      `“${f.name}” already finished in this run — changing it means redoing it and the steps after it that used its result${now}. Ask the user first. ` +
      `If they want it redone: team_edit again with the same ops and redo: true — the run stops and continues from ${f.from.name}; nothing before it is lost. ` +
      'Changes to later steps alone never need that.'
    );
  }
  const kept = keptBefore.length ? `; ${andList(keptBefore)} ${keptBefore.length === 1 ? 'keeps its result' : 'keep their results'}` : '';
  return (
    `“${f.name}” is working now and team_edit doesn't restart them. To tell them something now: {"op":"note","step":"${f.id}","text":"…"} — they read it at their next step. ` +
    `If their work must start over with the change, ask the user first, then team_edit with redo: true (continues from ${f.from.name}${kept}).`
  );
}

/** The run card's refusal: the step started meanwhile (it wasn't when the user looked), or works / finished. */
export function frozenUserText(view: RunPlanView, f: FrozenTouch, seen?: { frozen: number }): string {
  if (seen && f.index >= seen.frozen) return `“${f.name}” started meanwhile — it works with the version it had; send them a note instead.`;
  if (f.state === 'done' || f.state === 'finished') return `“${f.name}” already finished — its result stays. To redo it, stop the run and use Run again from here.`;
  return `“${f.name}” is working now — send them a note instead.`;
}

const GONE_USER = 'That step is no longer in this run — the run was changed meanwhile (in another window, or by the lead). Close this and look again.';

/** A planner refusal in the run card's words: the card names steps by id, so one that is gone was taken out meanwhile
 *  (another window, or the lead); a note to someone who finished meanwhile without the lead's "ask the user" hint. */
function userError(error: string): string {
  if (/^No step “/.test(error)) return GONE_USER;
  const done = /^(“.+?” already finished their step) in this run — a note can't reach them now/.exec(error);
  return done ? `${done[1]} — a note can't reach them now.` : error;
}

export interface RunEditDeps {
  engine: Pick<WorkflowEngine, 'planOf' | 'editRun' | 'get'>;
  workflows: Pick<WorkflowStore, 'get'>;
  models: RunEditContext['models'];
  defaultInstruction: RunEditContext['defaultInstruction'];
  /** Save a workflow in the run's house the way the Workflow tab does (validate, store, tell every client, re-sync its
   *  jobs) — bound to that house by whoever builds the deps. */
  saveWorkflow(raw: unknown): Workflow;
  /** The jobs of the run's house whose team this workflow is, by name (bound to that house too). */
  usedBy(workflowId: string): string[];
  /** More ids a new person can't take (the job's people). */
  taken?(run: WorkflowRun): string[];
}

export type AppliedEdit =
  | {
      ok: true;
      run: WorkflowRun;
      view: RunPlanView; // as it was before the change
      plan: PlannedEdit;
      delivered: RunEditResult['delivered'];
      saved?: { workflow: Workflow; usedBy: string[] };
      notSaved?: string;
    }
  | { ok: false; error: string; frozen?: FrozenTouch; view?: RunPlanView; plan?: PlannedEdit };

/** The planner's context for a run: models, CAST's default prompt, the ids taken in its job. */
export function editContext(d: RunEditDeps, run: WorkflowRun | undefined): RunEditContext {
  return { models: d.models, defaultInstruction: d.defaultInstruction, taken: run ? (d.taken?.(run) ?? []) : [] };
}

/** Change a going run (team_edit, edit_run): plan the ops on its plan now, refuse a change to a step that finished or
 *  works now (the lead's text, or the run card's: `seen` = what the card showed), put it into the run, and — `save` —
 *  the same ops into the saved workflow for next time (never a one-off team: the result says why). */
export function applyRunEdit(runId: string, ops: RunEditOp[], o: { by: 'lead' | 'user'; save?: boolean; seen?: { rev: number; frozen: number } }, d: RunEditDeps): AppliedEdit {
  let view: RunPlanView;
  try {
    view = d.engine.planOf(runId);
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
  const run = d.engine.get(runId);
  const plan = planRunEdit(view, ops, editContext(d, run));
  if ('error' in plan) return { ok: false, error: o.by === 'user' ? userError(plan.error) : plan.error, view };
  if (plan.frozen) return { ok: false, error: o.by === 'lead' ? frozenRefusal(view, plan.frozen) : frozenUserText(view, plan.frozen, o.seen), frozen: plan.frozen, view, plan };

  // For next time too: the same changes (notes stay this run's) on the saved workflow as it is now.
  let save: { workflow: Workflow } | { notSaved: string } | null = null;
  if (o.save) save = planSave(view, run, ops, d);
  const input = { by: o.by, steps: plan.steps, changes: plan.changes, notes: plan.notes };
  try {
    d.engine.editRun(runId, input, { dryRun: true });
  } catch (e) {
    return { ok: false, error: errorText(e), view, plan };
  }
  let saved: { workflow: Workflow; usedBy: string[] } | undefined;
  let notSaved = save && 'notSaved' in save ? save.notSaved : undefined;
  if (save && 'workflow' in save) {
    try {
      const w = d.saveWorkflow(save.workflow);
      saved = { workflow: w, usedBy: d.usedBy(w.id) };
    } catch (e) {
      notSaved = `Not saved to the workflow: ${errorText(e)}`;
    }
  }
  let res: RunEditResult;
  try {
    res = d.engine.editRun(runId, { ...input, ...(saved ? { saved: saved.workflow.name } : {}) });
  } catch (e) {
    return { ok: false, error: errorText(e), view, plan };
  }
  return { ok: true, run: res.run, view, plan, delivered: res.delivered, ...(saved ? { saved } : {}), ...(notSaved ? { notSaved } : {}) };
}

/** The saved workflow with the same changes, or why it can't take them. */
function planSave(view: RunPlanView, run: WorkflowRun | undefined, ops: RunEditOp[], d: RunEditDeps): { workflow: Workflow } | { notSaved: string } {
  const runId = view.runId;
  if (!view.workflowId || run?.adhoc) return { notSaved: `Not saved: this is a one-off team — after the run, workflow_save from_run ${runId} keeps it (with these changes) as a workflow.` };
  const saved = run ? d.workflows.get(run.projectId, view.workflowId) : undefined; // the run's house's workflow
  if (!saved) return { notSaved: `Not saved to the workflow: “${view.workflowName}” no longer exists — after the run, workflow_save from_run ${runId} keeps this team as a workflow.` };
  const all = Object.fromEntries(saved.steps.map((s) => [s.id, 'next' as const]));
  const plan = planRunEdit(
    { ...view, steps: saved.steps, done: 0, frozen: 0, states: all, taken: [...view.taken, ...view.steps.map((s) => s.id)] },
    ops.filter((x) => x.op !== 'note'),
    editContext(d, run),
  );
  if ('error' in plan) return { notSaved: `Not saved to the workflow “${saved.name}”: ${plan.error}` };
  return { workflow: { ...saved, steps: plan.steps } };
}

/** team_edit's result for the lead: the first line stays as it is (the scripted test model reads it). */
export function editedText(r: Extract<AppliedEdit, { ok: true }>): string {
  const { run, view, plan } = r;
  const next = plan.steps.slice(Math.min(view.frozen, plan.steps.length));
  const lines = [
    `Changed “${run.workflowName}” while it runs (run ${run.id}) — it keeps going: ${keepsText(view)}.`,
    ...plan.lines,
    ...plan.warnings.map((w) => `Warning: ${w}`),
    `Next: ${next.length ? chainOf(next) : `nobody — the run ends after ${view.steps.slice(view.done, view.frozen).map((s) => s.name).join(' + ')}`}.`,
  ];
  if (r.saved) {
    lines.push(`Also saved to the workflow “${r.saved.workflow.name}” (id ${r.saved.workflow.id}) — used by: ${r.saved.usedBy.length ? r.saved.usedBy.join(', ') : 'no job'}.`);
  } else if (r.notSaved) {
    lines.push(`This run only. ${r.notSaved}`);
  } else if (!view.workflowId || run.adhoc) {
    lines.push(`This run only — a one-off team (after the run, workflow_save from_run ${run.id} keeps it with these changes).`);
  } else {
    lines.push('This run only — the saved workflow is unchanged (team_edit with save: true also changes it for next time; only if the user wants that).');
  }
  return lines.join('\n');
}
