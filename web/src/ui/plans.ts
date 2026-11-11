// Plan cards (team_start in work style 'ask'): pure helpers for the card in the lead's chat, the inbox and badges.
import type { ModelInfo, TeamPlan, ThinkingLevel, Vendor, WorkflowRun } from '../../../shared/protocol';
import type { ClientState } from '../core/types';
import { THINKING_LABEL, VENDOR_ORDER, anyConnected, listJoin, modelLabel, modelNames, vendorOfModel } from './format';
import { RUN_STATUS_TEXT, isRunActive } from './runs';

const MAIN_JOB = 'main';

/** What a plan row needs of a step (PlanStep, WorkflowStep and run team members all fit). */
interface StepLike {
  id: string;
  name: string;
  kind: 'work' | 'review';
  loopBackTo?: string;
  maxLoops?: number;
  parallel?: boolean;
}

/** Parallel groups: a step plus the consecutive steps after it with parallel:true. The first step never works beside
 *  an earlier one, so its flag is ignored. */
export function stepGroups<T extends { parallel?: boolean }>(steps: T[]): T[][] {
  const groups: T[][] = [];
  steps.forEach((s, i) => {
    if (i > 0 && s.parallel && groups.length) groups[groups.length - 1].push(s);
    else groups.push([s]);
  });
  return groups;
}

/** Reviews send work back to someone before their own parallel group (the server refuses a target inside it or
 *  after it): such a target moves to the person right before the group. A review in the first group has nobody
 *  before it and loses its target; `parked` (step id → target) keeps it, so it comes back once someone is before the
 *  review again (unticking "same time" undoes ticking it). Mutates and returns the steps. */
export function fixLoopTargets<T extends { id: string; kind: 'work' | 'review'; loopBackTo?: string; parallel?: boolean }>(steps: T[], parked?: Map<string, string>): T[] {
  for (const group of stepGroups(steps)) {
    const first = steps.indexOf(group[0]);
    for (const s of group) {
      if (s.kind !== 'review') continue;
      const kept = parked?.get(s.id);
      if (!s.loopBackTo && kept && first > 0) {
        s.loopBackTo = kept; // checked below like any other target
        parked!.delete(s.id);
      }
      if (!s.loopBackTo) continue;
      const target = steps.findIndex((x) => x.id === s.loopBackTo);
      if (target >= 0 && target < first) continue;
      if (first > 0) s.loopBackTo = steps[first - 1].id;
      else {
        parked?.set(s.id, s.loopBackTo);
        delete s.loopBackTo;
      }
    }
  }
  return steps;
}

/** The small print under a person: "checks · sends back to Writer up to 2×" for a review, "at the same time as
 *  Writer" for a parallel step (both, joined, for a parallel review); '' for a plain worker. `kept`: the people a
 *  continuation card keeps from the earlier run (not on the card) — a review can still send work back to one of them:
 *  "sends back to Implementer (kept) up to 2×". */
export function stepNote(step: StepLike, steps: StepLike[], kept?: { id: string; name: string }[]): string {
  const parts: string[] = [];
  const i = steps.indexOf(step);
  if (i > 0 && step.parallel) {
    const group = stepGroups(steps).find((g) => g.includes(step)) ?? [];
    const before = group.slice(0, group.indexOf(step)).map((s) => s.name);
    if (before.length) parts.push(`at the same time as ${listJoin(before)}`);
  }
  if (step.kind === 'review') {
    const target = step.loopBackTo ? steps.find((s) => s.id === step.loopBackTo) : undefined;
    const keptTarget = !target && step.loopBackTo ? kept?.find((s) => s.id === step.loopBackTo) : undefined;
    const name = target?.name ?? (keptTarget ? `${keptTarget.name} (kept)` : undefined);
    parts.push(name ? `checks · sends back to ${name} up to ${step.maxLoops ?? 2}×` : 'checks');
  }
  return parts.join(' · ');
}

/** The models the user picked that differ from the plan — what answer_plan sends (only the changed steps). */
export function changedModels(plan: Pick<TeamPlan, 'steps'>, picked: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of plan.steps) {
    const m = picked[s.id];
    if (m && m !== s.model) out[s.id] = m;
  }
  return out;
}

/** The model a step ends up on: the user's change, else the plan's. */
export function finalModel(plan: Pick<TeamPlan, 'changed'>, step: { id: string; model: string }): string {
  return plan.changed?.[step.id] ?? step.model;
}

/** An effort pick on a card: a level, or '' for omp's default. */
export type EffortPick = ThinkingLevel | '';

/** The efforts the user picked that differ from the plan — what answer_plan sends ('' = back to the default). */
export function changedThinking(plan: Pick<TeamPlan, 'steps'>, picked: Record<string, EffortPick>): Record<string, EffortPick> {
  const out: Record<string, EffortPick> = {};
  for (const s of plan.steps) {
    if (!(s.id in picked)) continue;
    const t = picked[s.id]!;
    if (t !== (s.thinking ?? '')) out[s.id] = t;
  }
  return out;
}

/** The effort a step ends up with (undefined = omp's default): the user's change, else the plan's. */
export function finalThinking(plan: Pick<TeamPlan, 'changedThinking'>, step: { id: string; thinking?: ThinkingLevel }): ThinkingLevel | undefined {
  const c = plan.changedThinking;
  return c && step.id in c ? c[step.id] || undefined : step.thinking;
}

/** "High effort", "default effort" — for the answered card's line. */
export function effortWords(t: EffortPick | undefined): string {
  return t ? `${THINKING_LABEL[t]} effort` : 'default effort';
}

/** How many people the user changed on a card (a model, an effort or both). */
export function changedPeople(models: Record<string, string>, thinking: Record<string, EffortPick>): number {
  return new Set([...Object.keys(models), ...Object.keys(thinking)]).size;
}

/** One line for an answered card: "Running — you changed Reviewer to GPT-6.1 Sol", "… Writer to Max effort",
 *  "… Reviewer to GPT-6.1 Sol at High effort", "Completed", "Cancelled". A run
 *  the client doesn't have (the server keeps the latest 60, or it hasn't arrived yet) reads "Started": never a
 *  "Running" that stays forever. */
export function planOutcome(plan: TeamPlan, run: WorkflowRun | undefined, models: ModelInfo[]): string {
  if (plan.status === 'cancelled') return 'Cancelled';
  if (plan.status === 'pending') return 'Waiting for you';
  const head = !run ? 'Started' : isRunActive(run) ? 'Running' : RUN_STATUS_TEXT[run.status];
  const byModel = plan.changed ?? {};
  const byEffort = plan.changedThinking ?? {};
  const ids = [...new Set([...Object.keys(byModel), ...Object.keys(byEffort)])];
  const changes = ids.map((id) => {
    const name = plan.steps.find((s) => s.id === id)?.name ?? id;
    const m = byModel[id];
    const effort = id in byEffort ? effortWords(byEffort[id]) : '';
    return `${name} to ${m ? `${modelLabel(m, models)}${effort ? ` at ${effort}` : ''}` : effort}`;
  });
  return changes.length ? `${head} — you changed ${listJoin(changes)}` : head;
}

export interface ModelOption {
  id: string;
  label: string;
  vendor: Vendor;
  /** The sign-in it runs through when that isn't its maker's API (ModelInfo.route): its own group in the select. */
  route?: string;
  /** Shown but can't be picked: the step's own model when it isn't connected while something else is. */
  disabled: boolean;
}

/** A plan row's model choices, by vendor: the connected models when anything is connected (others can't be used),
 *  else every model (none works until an account is connected). The step's current model is always listed so the
 *  select can show it. */
export function modelOptions(models: ModelInfo[], current: string): ModelOption[] {
  const any = anyConnected(models);
  const usable = any ? models.filter((m) => m.available) : models;
  const names = modelNames(models);
  const out: ModelOption[] = usable.map((m) => ({ id: m.id, label: names.get(m.id) ?? m.label, vendor: m.vendor, ...(m.route ? { route: m.route } : {}), disabled: false }));
  if (current && !out.some((o) => o.id === current)) {
    out.push({ id: current, label: modelLabel(current, models), vendor: vendorOfModel(current, models), disabled: any });
  }
  const rank = (v: Vendor) => {
    const r = VENDOR_ORDER.indexOf(v);
    return r < 0 ? VENDOR_ORDER.length : r;
  };
  // each maker's own models first, then the ones other sign-ins bring (grouped by route, in the order they came)
  const routes = [...new Set(out.map((o) => o.route ?? ''))];
  return out
    .map((o, i) => ({ o, i }))
    .sort((a, b) => rank(a.o.vendor) - rank(b.o.vendor) || routes.indexOf(a.o.route ?? '') - routes.indexOf(b.o.route ?? '') || a.i - b.i)
    .map((x) => x.o);
}

/** Pending plans, oldest first; optionally of one job. */
export function pendingPlans(s: Pick<ClientState, 'plans'>, where?: { projectId: string; jobId?: string }): TeamPlan[] {
  return Object.values(s.plans ?? {})
    .filter((p) => p.status === 'pending')
    .filter((p) => !where || (p.projectId === where.projectId && (where.jobId === undefined || (p.jobId || MAIN_JOB) === where.jobId)))
    .sort((a, b) => a.ts - b.ts);
}

/** Everything waiting for the user: tool approvals plus plan cards (of one house, given its id). */
export function waitingCount(s: Pick<ClientState, 'approvals' | 'plans'>, projectId?: string): number {
  if (projectId === undefined) return Object.keys(s.approvals).length + pendingPlans(s).length;
  return Object.values(s.approvals).filter((a) => a.projectId === projectId).length + pendingPlans(s, { projectId }).length;
}

/** "Decoder → Implementer + Tester → Reviewer": the plan's people in order, parallel ones joined with +. */
export function teamLine(steps: { name: string; parallel?: boolean }[]): string {
  return stepGroups(steps)
    .map((g) => g.map((s) => s.name).join(' + '))
    .join(' → ');
}

/** A continuation card (team_continue): the name of the first person who works again, '' for a plain plan. */
export function planFromName(plan: Pick<TeamPlan, 'steps' | 'continues'>): string {
  if (!plan.continues) return '';
  return (plan.steps.find((s) => s.id === plan.continues!.fromStepId) ?? plan.steps[0])?.name ?? plan.continues.fromStepId;
}

/** One line about a waiting plan card, for a system notification: "“X” — Decoder, Reviewer. Run it or change the
 *  models." or, continuing a run, "Continue “X” from Reviewer — Reviewer. Run it or change the models." */
export function planSummary(plan: Pick<TeamPlan, 'title' | 'steps' | 'continues'>): string {
  const names = plan.steps.map((s) => s.name).join(', ');
  const head = plan.continues ? `Continue “${plan.title}” from ${planFromName(plan)}` : `“${plan.title}”`;
  return `${head} — ${names}. Run it or change the models.`;
}
