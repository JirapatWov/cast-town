// The owner (2026-11-04): a lead made a workflow, the user changed a model in it by hand in the Workflow tab and told
// the lead to start — and the lead saved the workflow again from its own copy, so the old model was back and the team
// ran wrong. So a lead's workflow_save is a merge. Each workflow has a base (WorkflowStore.chatBase): what a lead last
// sent for it, or its first version; hand edits (the Workflow tab, a run card's "for next time") never move it. Against
// that base, field by field and person by person:
//   - only the lead changed it → the lead's value;
//   - the lead sent the base's value again (its copy is older than the hand edit) → the hand edit stays (it hears so);
//   - both changed it, differently → nothing is saved: the lead hears what was changed by hand, and `override` lets
//     its value through when the user asked for it in chat.
// Pure functions; lead-tools.ts saves and tells the lead.
import type { Workflow, WorkflowStep } from '../../shared/protocol';
import { VERDICT_FOOTER } from './templates';
import { groupStarts, normalizeWorkflow } from './workflow-store';

const STEP_FIELDS = ['name', 'model', 'thinking', 'persona', 'instruction', 'kind', 'loopBackTo', 'maxLoops', 'parallel'] as const;
type StepField = (typeof STEP_FIELDS)[number];
const TOP_FIELDS = ['name', 'description', 'icon'] as const;

/** A difference between the lead's save and the workflow as it is now, on something changed by hand. */
export interface HandChange {
  /** What `override` names: "<step id>.<field>", "name" / "description" / "icon", or "steps". */
  key: string;
  /** "Brainstorm", or "the workflow" for its name, description and icon. */
  who: string;
  /** The value now (set by hand), as the lead reads it. */
  now: string;
  /** What the lead sent. */
  sent: string;
}

export type LeadMerge =
  | {
      workflow: Workflow;
      /** The lead sent the earlier value of something changed by hand: the hand edit stays. */
      kept: HandChange[];
      /** The lead's own changes that go in (now = the value before). */
      applied: HandChange[];
      /** People added, removed or moved by hand (kept), and repairs (a loop that no longer fits the order). */
      notes: string[];
    }
  | { conflict: string; changes: HandChange[] };

/** A field's value as the merge compares it: absent, false and '' are the same (normalizeWorkflow leaves them out);
 *  maxLoops only counts on a review that loops back; an instruction without what CAST adds itself (the verdict format,
 *  {{feedback}}: prepareSteps / finishInstructions), so making someone a review isn't a change of their text. */
function val(s: WorkflowStep | undefined, f: StepField): string {
  if (!s) return '';
  let v: unknown = f === 'maxLoops' && !s.loopBackTo ? undefined : s[f];
  if (f === 'instruction' && typeof v === 'string') v = bareInstruction(v);
  return v === undefined || v === null || v === false || v === '' ? '' : JSON.stringify(v);
}

function bareInstruction(text: string): string {
  let t = text.trimEnd();
  for (let again = true; again; ) {
    again = false;
    if (t.endsWith(VERDICT_FOOTER)) [t, again] = [t.slice(0, -VERDICT_FOOTER.length).trimEnd(), true];
    const fb = /\{\{\s*feedback\s*\}\}$/.exec(t);
    if (fb) [t, again] = [t.slice(0, fb.index).trimEnd(), true];
  }
  return t;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? '') === JSON.stringify(b ?? '');

function show(field: string, v: unknown): string {
  if (field === 'thinking') return typeof v === 'string' && v ? v : 'default';
  if (field === 'parallel') return v ? 'yes' : 'no';
  if (field === 'loopBackTo') return typeof v === 'string' && v ? v : 'none';
  if (field === 'maxLoops') return v === undefined ? 'none' : String(v);
  if (field === 'persona' || field === 'instruction' || field === 'description') {
    const text = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
    return text ? `“${text.length > 60 ? `${text.slice(0, 59)}…` : text}”` : '(empty)';
  }
  return typeof v === 'string' && v ? v : '(none)';
}

/** "A, B and C". */
function names(steps: Pick<WorkflowStep, 'name'>[]): string {
  const n = steps.map((s) => `“${s.name}”`);
  return n.length > 1 ? `${n.slice(0, -1).join(', ')} and ${n.at(-1)}` : (n[0] ?? '');
}

/** The lead saves `sent` over `now`; `base` is the workflow as chat last saved it (all three normalized, people matched
 *  by id). See the top of this file. */
export function mergeLeadSave(
  base: Workflow,
  now: Workflow,
  sent: Workflow,
  override: ReadonlySet<string> = new Set(),
  /** "<step id>.model" / ".thinking" set by hand after the base was (even back to the base's value). */
  handAfter: (key: string) => boolean = () => false,
): LeadMerge {
  const kept: HandChange[] = [];
  const clashes: HandChange[] = [];
  const applied: HandChange[] = [];
  const notes: string[] = [];
  /** b / t / o: the base's, the current and the lead's value, compared as `val` does; known: the base had the person. */
  const pick = <T>(key: string, who: string, field: string, b: string, t: string, o: string, theirs: T, ours: T, known: boolean): T => {
    if (o === t) return ours;
    const change = { key, who, now: show(field, theirs), sent: show(field, ours) };
    if (known && t === b && !handAfter(key)) {
      applied.push(change); // only the lead changed it
      return ours;
    }
    if (override.has(key)) return ours;
    if (known && o === b) kept.push(change); // the lead's earlier value: keep the hand edit
    else clashes.push(change); // the lead changed it too
    return theirs;
  };

  const top: Pick<Workflow, (typeof TOP_FIELDS)[number]> = { name: now.name, description: now.description, icon: now.icon };
  for (const f of TOP_FIELDS) {
    const [b, t, o] = [base[f], now[f], sent[f]].map((x) => JSON.stringify(x ?? ''));
    top[f] = pick(f, 'the workflow', f, b!, t!, o!, now[f], sent[f], true);
  }

  // Who is in the team, in what order.
  const ids = (w: Workflow) => w.steps.map((s) => s.id);
  const [B, T, O] = [ids(base), ids(now), ids(sent)];
  const byId = (w: Workflow) => new Map(w.steps.map((s) => [s.id, s]));
  const [mB, mT, mO] = [byId(base), byId(now), byId(sent)];
  const changedByHand = (id: string) => mB.has(id) && mT.has(id) && STEP_FIELDS.some((f) => val(mB.get(id), f) !== val(mT.get(id), f));
  let order: string[];
  if (same(T, B) || same(O, T) || override.has('steps')) {
    order = O;
    if (!same(O, T)) applied.push({ key: 'steps', who: 'the team', now: now.steps.map((s) => s.name).join(' → '), sent: sent.steps.map((s) => s.name).join(' → ') });
  }
  else if (same(O, B)) {
    order = T; // only changed by hand: kept
    const added = now.steps.filter((s) => !mB.has(s.id));
    const removed = base.steps.filter((s) => !mT.has(s.id));
    const parts = [added.length ? `added ${names(added)}` : '', removed.length ? `removed ${names(removed)}` : ''].filter(Boolean);
    notes.push(
      `The people were changed by hand after the last save from chat (${parts.length ? parts.join(', ') : 'a new order'}) — kept: ${now.steps.map((s) => s.name).join(' → ')}. ` +
        'Only if the user asked you in this chat for exactly your people, save again with override: ["steps"].',
    );
    const lost = removed.filter((s) => mO.has(s.id) && STEP_FIELDS.some((f) => val(s, f) !== val(mO.get(s.id), f)));
    if (lost.length) notes.push(`Your changes to ${names(lost)} were not saved: removed by hand.`);
  } else if (builtOn(B, T, O)) {
    order = O;
    applied.push({ key: 'steps', who: 'the team', now: now.steps.map((s) => s.name).join(' → '), sent: sent.steps.map((s) => s.name).join(' → ') });
  }
  else {
    clashes.push({ key: 'steps', who: 'the team', now: now.steps.map((s) => s.name).join(' → '), sent: sent.steps.map((s) => s.name).join(' → ') });
    order = T;
  }
  if (order === O && !override.has('steps')) {
    // the lead left out someone changed by hand: a removal it meant, or a rename without the person's id
    const gone = T.filter((id) => !mO.has(id) && changedByHand(id)).map((id) => mT.get(id)!);
    if (gone.length) {
      clashes.push({ key: 'steps', who: names(gone), now: 'changed by hand', sent: `left out (to rename someone, keep their id: ${gone.map((s) => `"${s.id}"`).join(', ')})` });
    }
  }

  const steps = order.map((id) => {
    const t = mT.get(id);
    const o = mO.get(id);
    if (!o) return structuredClone(t!); // added by hand; the lead didn't know of them
    if (!t) return structuredClone(o); // the lead added them
    const b = mB.get(id);
    const out: Record<string, unknown> = { id };
    for (const f of STEP_FIELDS) {
      const v = pick(`${id}.${f}`, t.name, f, val(b, f), val(t, f), val(o, f), t[f], o[f], !!b);
      if (v !== undefined && v !== false && v !== '') out[f] = v;
    }
    out.persona ??= '';
    out.instruction ??= '';
    return out as unknown as WorkflowStep;
  });

  if (clashes.length) {
    const steps = clashes.some((c) => c.key === 'steps');
    return {
      changes: clashes,
      conflict: [
        `Not saved: these were changed by hand (in the Workflow tab or on a run card) after the last save from chat, and you sent something else:`,
        ...clashes.map((c) => `- ${c.key} — ${c.who}: now ${c.now} (you sent ${c.sent})`),
        `Save again with what is there now (workflow_get shows it, with each person's id)${steps ? ' and your own changes on top' : ''}. ` +
          `Only if the user asked you in this chat for exactly your values, save again with override: ${JSON.stringify([...new Set(clashes.map((c) => c.key))])}.`,
      ].join('\n'),
    };
  }
  const repaired = repairShape(steps, mO, notes);
  finishInstructions(steps);
  // a kept value the repair replaced isn't what runs: the note says what does
  return { workflow: { ...now, ...top, steps }, applied, kept: kept.filter((k) => !repaired.has(k.key) && !(k.key.endsWith('.maxLoops') && repaired.has(k.key.replace(/maxLoops$/, 'loopBackTo')))), notes };
}

/** The lead's people list is built on the current one: it has everyone added by hand, no one removed by hand, and
 *  the people it kept are in the current order — its own additions and removals go in. */
function builtOn(B: string[], T: string[], O: string[]): boolean {
  if (T.some((id) => !B.includes(id) && !O.includes(id))) return false; // dropped someone added by hand
  if (O.some((id) => B.includes(id) && !T.includes(id))) return false; // put back someone removed by hand
  return same(
    T.filter((id) => O.includes(id)),
    O.filter((id) => T.includes(id)),
  );
}

/** A value kept from the hand edit can stop fitting the merged order (a loop to someone now later or gone, the first
 *  person working beside nobody): take the lead's value there, else leave it out. */
function repairShape(steps: WorkflowStep[], ours: Map<string, WorkflowStep>, notes: string[]): Set<string> {
  const repaired = new Set<string>();
  if (steps[0]?.parallel) {
    repaired.add(`${steps[0].id}.parallel`);
    delete steps[0].parallel;
    notes.push(`“${steps[0].name}” is first now, so they no longer work beside the step before.`);
  }
  const groups = groupStarts(steps);
  const fits = (i: number, target: string | undefined) => {
    const j = target ? steps.findIndex((s) => s.id === target) : -1;
    return j >= 0 && j < i && groups[j] !== groups[i];
  };
  for (const [i, s] of steps.entries()) {
    if (s.kind !== 'review') {
      delete s.loopBackTo;
      delete s.maxLoops;
      continue;
    }
    if (!s.loopBackTo || fits(i, s.loopBackTo)) continue;
    repaired.add(`${s.id}.loopBackTo`);
    const mine = ours.get(s.id);
    if (mine?.loopBackTo && fits(i, mine.loopBackTo)) {
      notes.push(`“${s.name}” loops back to ${mine.loopBackTo} (yours): ${s.loopBackTo} no longer comes before them.`);
      s.loopBackTo = mine.loopBackTo;
      s.maxLoops = mine.maxLoops ?? 2;
    } else {
      notes.push(`“${s.name}” no longer loops back: ${s.loopBackTo} no longer comes before them.`);
      delete s.loopBackTo;
      delete s.maxLoops;
    }
  }
  return repaired;
}

/** What prepareSteps adds to the lead's instructions, on text kept from a hand edit too (keep in step with it): a
 *  review ends with the verdict format, a loop target gets the reviewer's notes. */
function finishInstructions(steps: WorkflowStep[]): void {
  for (const s of steps) if (s.kind === 'review' && s.instruction.trim() && !/verdict/i.test(s.instruction)) s.instruction += `\n\n${VERDICT_FOOTER}`;
  for (const s of steps) {
    const target = s.loopBackTo && steps.find((x) => x.id === s.loopBackTo);
    if (target && !/\{\{\s*feedback\s*\}\}/.test(target.instruction)) target.instruction += '{{feedback}}';
  }
}

/** What was changed by hand since the last save from chat, as HandChanges and notes (for team_start). */
export function changesSince(base: Workflow, now: Workflow): { changes: HandChange[]; notes: string[] } {
  const m = mergeLeadSave(base, now, base);
  return 'conflict' in m ? { changes: m.changes, notes: [] } : { changes: m.kept, notes: m.notes.slice(0, 1) };
}

/** The lines telling the lead what its save left as changed by hand. */
export function keptText(merge: Extract<LeadMerge, { workflow: Workflow }>): string[] {
  const lines = [...merge.notes];
  if (merge.kept.length) {
    lines.push(
      'Kept what was changed by hand after the last save from chat — you sent the earlier values:',
      ...merge.kept.map((k) => `- ${k.key} — ${k.who}: ${k.now} (you sent the earlier ${k.sent})`),
      `This is the version that runs; don't send the earlier values again. Only if the user asked you in this chat for those earlier values, save again with override: ${JSON.stringify(merge.kept.map((k) => k.key))}.`,
    );
  }
  return lines;
}

/** Ids for the lead's people that came without one, when it changes an existing workflow: the id of the person with
 *  that name — in the base first (the lead's copy was made from it, even when the user renamed someone by hand
 *  since), then as it is now — the k-th of a name taking the k-th id, so a name with no ASCII letters (Thai: `step-N`
 *  by position) or a moved person keeps who they are. reserved: the ids no one new may take (everyone's who exists
 *  now or in the base and wasn't claimed). */
export function claimStepIds(raw: unknown, now: Workflow, base: Workflow | undefined): { steps: unknown; reserved: Set<string> } {
  const all = [...(base?.steps ?? []), ...now.steps];
  const reserved = new Set(all.map((s) => s.id));
  if (!Array.isArray(raw)) return { steps: raw, reserved };
  const name = (v: unknown) => (typeof v === 'string' ? v.trim().slice(0, 40).trim().toLowerCase() : ''); // as stored
  const idOf = (v: unknown) => (v && typeof v === 'object' && typeof (v as Record<string, unknown>).id === 'string' ? ((v as Record<string, unknown>).id as string).trim() : '');
  const taken = new Set(raw.map(idOf).filter(Boolean));
  const free = (list: WorkflowStep[]) => list.filter((s) => !taken.has(s.id));
  const pools = [free(base?.steps ?? []), free(now.steps)];
  const steps = raw.map((s) => {
    if (!s || typeof s !== 'object' || idOf(s)) return s;
    const step = s as Record<string, unknown>;
    const found = pools.map((pool) => pool.find((x) => !taken.has(x.id) && name(x.name) === name(step.name)));
    // the name is one person in the base and another now (renamed by hand, e.g. two names swapped): the one whose
    // persona the lead sent, else the base's (its copy was made from it)
    const persona = typeof step.persona === 'string' ? step.persona.trim() : null;
    const match = found[0] && found[1] && found[0].id !== found[1].id ? (found.find((x) => x!.persona.trim() === persona) ?? found[0]) : (found[0] ?? found[1]);
    if (!match) return step;
    taken.add(match.id);
    return { ...step, id: match.id };
  });
  for (const id of taken) reserved.delete(id);
  return { steps, reserved };
}

/** The lead's team_edit with save: true changed the stored workflow (`before` → `after`) by its ops: the same changes
 *  go into the base, so they count as chat's (a later workflow_save or team_start doesn't call them hand edits) while
 *  what was changed by hand stays a difference. Moves: when the base has those people in `before`'s order (no hand
 *  reorder among them), `after`'s. People the ops added go in after the person before them. A loop or parallel that
 *  doesn't fit the base's people goes; a base that still isn't valid stays as it was. */
export function carryOver(base: Workflow, before: Workflow, after: Workflow): Workflow {
  const mBefore = new Map(before.steps.map((s) => [s.id, s]));
  const mAfter = new Map(after.steps.map((s) => [s.id, s]));
  const steps: WorkflowStep[] = [];
  for (const b of base.steps) {
    const was = mBefore.get(b.id);
    const is = mAfter.get(b.id);
    if (was && !is) continue; // the ops removed them
    if (!was) {
      // removed by hand: stays a difference — unless the ops added someone under that id
      steps.push(structuredClone(is ?? b));
      continue;
    }
    const out: Record<string, unknown> = { ...structuredClone(b) };
    for (const f of STEP_FIELDS) {
      if (val(was, f) === val(is, f)) continue;
      if (is![f] === undefined) delete out[f];
      else out[f] = is![f];
    }
    steps.push(out as unknown as WorkflowStep);
  }
  const shared = steps.map((s) => s.id).filter((id) => mBefore.has(id) && mAfter.has(id));
  const order = (w: Workflow) => w.steps.map((s) => s.id).filter((id) => shared.includes(id));
  if (same(shared, order(before)) && !same(shared, order(after))) {
    const slots = steps.flatMap((s, i) => (shared.includes(s.id) ? [i] : []));
    const byId = new Map(steps.map((s) => [s.id, s]));
    order(after).forEach((id, k) => (steps[slots[k]!] = byId.get(id)!));
  }
  for (const [i, s] of after.steps.entries()) {
    if (mBefore.has(s.id) || steps.some((x) => x.id === s.id)) continue; // not added by the ops
    const prev = after.steps.slice(0, i).reverse().find((p) => steps.some((x) => x.id === p.id));
    steps.splice(prev ? steps.findIndex((x) => x.id === prev.id) + 1 : 0, 0, structuredClone(s));
  }
  repairShape(steps, new Map(), []);
  const next = { ...base, steps };
  try {
    normalizeWorkflow(next);
    return next;
  } catch {
    return base;
  }
}
