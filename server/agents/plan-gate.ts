// The plan card (work style 'ask' and 'solo'; 'auto' never shows one): the first team a lead starts after each
// message of the user waits in the lead's chat until the user presses Run — optionally with other models or efforts
// for some people — or Cancel. Later teams for the same message start right away (the lead decides alone, following
// the models and efforts the user picked before: job.modelPrefs). Also the loop guard: how many teams a lead started for the
// current message (the house's limit: runsPerAsk, shared/protocol.ts) — or, while the lead works toward a goal on its
// own, since the goal was set or resumed (MAX_RUNS_PER_GOAL).
import { DEFAULT_WORK_STYLE, runsPerAsk, THINKING_LEVELS, type ModelPref, type TeamPlan, type ThinkingLevel, type WorkflowRun } from '../../shared/protocol';
import type { CityStore, Hub, JobStore } from '../contracts';
import type { AgentStore } from './agent-store';
import { MAX_RUNS_PER_GOAL, type NewPlan, type PlanOutcome, type PlanStart, type TeamGate } from './lead-tools';
import type { ModelRegistry } from './models';
import { errorText, log, newId } from './util';
import { EngineError } from './workflow-engine';

/** Model and effort choices kept per job (newest first). */
export const MAX_MODEL_PREFS = 12;
const MODEL_ID = /^[\w.-]+\/[\w./:@-]+$/;

export interface PlanGateDeps {
  hub: Pick<Hub, 'broadcast'>;
  store: Pick<AgentStore, 'upsertItem'>;
  jobs: Pick<JobStore, 'get' | 'update'>;
  /** The house's own loop guard (Project.maxRunsPerAsk). */
  city: Pick<CityStore, 'project'>;
  models: Pick<ModelRegistry, 'anyAvailable' | 'isAvailable' | 'label'>;
  /** Show the lead waiting for the user (null: back to whatever they do). */
  waiting(agentId: string, detail: string | null): void;
  /** The lead works toward a goal on its own now (omp goal mode): its loop guard counts per goal. */
  goalActive?(agentId: string): boolean;
}

interface Lead {
  due: boolean; // the next team shows a card (set by each message of the user, cleared when a plan is approved)
  runs: number; // teams started since the user's last message
  goalRuns: number; // teams started since the goal was set or resumed
}

interface Pending {
  plan: TeamPlan;
  callId: string;
  start: PlanStart;
  resolve: (outcome: PlanOutcome) => void;
  starting: boolean; // Run was pressed and the team is starting: nothing withdraws the card now
}

type Unanswered = Extract<PlanOutcome, { approved: false }>['reason'];

export class PlanGate implements TeamGate {
  #leads = new Map<string, Lead>();
  #pending = new Map<string, Pending>();

  constructor(private readonly d: PlanGateDeps) {}

  /** A message of the user reached this lead (not RLT's "[RLT team update]"): the next team shows a card, the loop
   *  guard starts over, and a card still waiting goes away — the lead reads the new message instead. */
  userMessage(agentId: string): void {
    this.#leads.set(agentId, { due: true, runs: 0, goalRuns: this.#leads.get(agentId)?.goalRuns ?? 0 });
    this.#withdraw((p) => p.plan.agentId === agentId, 'new_message');
  }

  /** The user set or resumed the lead's goal: its goal loop guard starts over. */
  goalStarted(agentId: string): void {
    const lead = this.#leads.get(agentId) ?? { due: false, runs: 0, goalRuns: 0 };
    lead.goalRuns = 0;
    this.#leads.set(agentId, lead);
  }

  runsThisAsk(agentId: string): number {
    return this.#leads.get(agentId)?.runs ?? 0;
  }

  runLimit(agentId: string, projectId: string): { used: number; max: number; per: 'message' | 'goal' } {
    const lead = this.#leads.get(agentId);
    if (this.d.goalActive?.(agentId)) return { used: lead?.goalRuns ?? 0, max: MAX_RUNS_PER_GOAL, per: 'goal' };
    return { used: lead?.runs ?? 0, max: runsPerAsk(this.d.city.project(projectId)), per: 'message' };
  }

  /** The lead started a team (after a card or without one — e.g. work style auto): later teams for this message
   *  start without a card, even when the work style changes meanwhile. */
  noteRun(agentId: string): void {
    const lead = this.#leads.get(agentId) ?? { due: false, runs: 0, goalRuns: 0 };
    lead.runs++;
    lead.goalRuns++;
    lead.due = false;
    this.#leads.set(agentId, lead);
  }

  due(agentId: string, projectId: string, jobId: string): boolean {
    const style = this.d.jobs.get(projectId, jobId)?.workStyle ?? DEFAULT_WORK_STYLE;
    return style !== 'auto' && this.#leads.get(agentId)?.due === true;
  }

  ask(plan: NewPlan, callId: string, start: PlanStart): Promise<PlanOutcome> {
    const full: TeamPlan = { ...plan, id: newId('plan'), status: 'pending', ts: Date.now() };
    return new Promise<PlanOutcome>((resolve) => {
      this.#pending.set(full.id, { plan: full, callId, start, resolve, starting: false });
      this.#show(full);
      this.d.waiting(full.agentId, `Waiting for you: plan for “${full.title}”`);
    });
  }

  /** The user pressed Run (with the models and efforts they changed: step id → model, step id → effort with '' for
   *  omp's default) or Cancel. Run starts the team; when that fails the card stays and the error goes back to the
   *  user. Throws EngineError. */
  async answer(planId: string, run: boolean, models: Record<string, string> = {}, thinking: Record<string, string> = {}): Promise<TeamPlan> {
    const p = this.#pending.get(planId);
    if (!p) throw new EngineError('That plan was already answered.');
    if (p.starting) throw new EngineError('That plan is starting already.');
    if (!run) {
      this.#close(p, 'cancelled', { approved: false, reason: 'cancelled' });
      return structuredClone(p.plan);
    }
    const changed = this.#changes(p.plan, models);
    const efforts = this.#efforts(p.plan, thinking);
    p.starting = true;
    let started: WorkflowRun;
    try {
      started = await p.start(changed, efforts);
    } catch (err) {
      p.starting = false;
      throw err instanceof EngineError ? err : new EngineError(`Couldn't start the team: ${errorText(err)}`);
    }
    const extra: Partial<TeamPlan> = { changed, ...(Object.keys(efforts).length ? { changedThinking: efforts } : {}), runId: started.id };
    this.#close(p, 'approved', { approved: true, run: started, changed, thinking: efforts }, extra);
    const lead = this.#leads.get(p.plan.agentId);
    if (lead) lead.due = false;
    this.#remember(p.plan, changed, efforts);
    return structuredClone(p.plan);
  }

  /** omp called the tool off (the user pressed Stop while the card waited). */
  cancelCall(agentId: string, callId: string): void {
    if (callId) this.#withdraw((p) => p.plan.agentId === agentId && p.callId === callId, 'stopped');
  }

  /** The user stopped the lead, or the lead / its job / its house went away. */
  cancelFor(agentId: string, reason: Unanswered = 'gone'): void {
    this.#withdraw((p) => p.plan.agentId === agentId, reason);
  }

  /** RLT shuts down: no card survives a restart (stored ones load as cancelled). */
  cancelAll(): void {
    this.#withdraw(() => true, 'gone');
  }

  /** The lead moved out: forget its message state too. */
  forget(agentId: string): void {
    this.cancelFor(agentId);
    this.#leads.delete(agentId);
  }

  /** Cards waiting for the user (snapshot.plans). */
  pending(): TeamPlan[] {
    return [...this.#pending.values()].map((p) => structuredClone(p.plan));
  }

  #withdraw(match: (p: Pending) => boolean, reason: Unanswered): void {
    for (const p of [...this.#pending.values()]) if (!p.starting && match(p)) this.#close(p, 'cancelled', { approved: false, reason });
  }

  /** The models the user changed on the card (only real changes), checked: steps of this plan, connected models. */
  #changes(plan: TeamPlan, models: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [id, raw] of Object.entries(models ?? {})) {
      const step = plan.steps.find((s) => s.id === id);
      if (!step) throw new EngineError(`This plan has no person “${id}”.`);
      const model = typeof raw === 'string' ? raw.trim() : '';
      if (!MODEL_ID.test(model)) throw new EngineError(`Pick a model for ${step.name}.`);
      if (model === step.model) continue;
      if (this.d.models.anyAvailable() && !this.d.models.isAvailable(model)) {
        throw new EngineError(`${this.d.models.label(model)} isn't connected — sign in under Models & providers, or pick another model for ${step.name}.`);
      }
      out[id] = model;
    }
    return out;
  }

  /** The efforts the user changed on the card (only real changes; '' = back to omp's default), checked. */
  #efforts(plan: TeamPlan, thinking: Record<string, string>): Record<string, ThinkingLevel | ''> {
    const out: Record<string, ThinkingLevel | ''> = {};
    for (const [id, raw] of Object.entries(thinking ?? {})) {
      const step = plan.steps.find((s) => s.id === id);
      if (!step) throw new EngineError(`This plan has no person “${id}”.`);
      const level = typeof raw === 'string' ? raw.trim() : '';
      if (level !== '' && !THINKING_LEVELS.includes(level as ThinkingLevel)) throw new EngineError(`Pick an effort for ${step.name}.`);
      if (level === (step.thinking ?? '')) continue;
      out[id] = level as ThinkingLevel | '';
    }
    return out;
  }

  #close(p: Pending, status: 'approved' | 'cancelled', outcome: PlanOutcome, extra: Partial<TeamPlan> = {}): void {
    this.#pending.delete(p.plan.id);
    p.plan = { ...p.plan, ...extra, status, answeredAt: Date.now() };
    this.#show(p.plan);
    this.d.waiting(p.plan.agentId, null);
    p.resolve(outcome);
  }

  /** The card in the lead's chat (upserted by id) and for every client. */
  #show(plan: TeamPlan): void {
    this.d.store.upsertItem(plan.agentId, { kind: 'plan', id: plan.id, plan: structuredClone(plan), ts: plan.ts });
    this.d.hub.broadcast({ t: 'plan', plan: structuredClone(plan) });
  }

  /** The user's model and effort choices go on the job (newest first, one per person and duty) — the lead follows
   *  them later. A choice keeps what the user picked before for the same duty unless they changed that part too;
   *  effort back to the default drops the effort, and a choice left with neither goes. */
  #remember(plan: TeamPlan, changed: Record<string, string>, efforts: Record<string, ThinkingLevel | ''>): void {
    const ids = [...new Set([...Object.keys(changed), ...Object.keys(efforts)])];
    const job = ids.length ? this.d.jobs.get(plan.projectId, plan.jobId) : undefined;
    if (!job) return;
    const at = Date.now();
    const same = (a: Pick<ModelPref, 'stepName' | 'duty'>, b: Pick<ModelPref, 'stepName' | 'duty'>) => a.stepName === b.stepName && a.duty === b.duty;
    const old = job.modelPrefs ?? [];
    const fresh: ModelPref[] = [];
    const dropped: Pick<ModelPref, 'stepName' | 'duty'>[] = [];
    for (const id of ids) {
      const step = plan.steps.find((s) => s.id === id);
      if (!step) continue;
      const key = { stepName: step.name, duty: step.duty };
      // two people with the same name and duty (a parallel pair) changed differently: the first one counts
      if (fresh.some((f) => same(f, key)) || dropped.some((d) => same(d, key))) continue;
      const prior = old.find((p) => same(p, key));
      const model = changed[id] ?? prior?.model;
      const thinking = id in efforts ? efforts[id] || undefined : prior?.thinking;
      // the part left as it was keeps when it was picked (a hand edit in between still beats it: pickTeam)
      const modelAt = changed[id] || !prior?.model ? undefined : (prior.modelAt ?? prior.at);
      const thinkingAt = id in efforts || !prior?.thinking ? undefined : (prior.thinkingAt ?? prior.at);
      if (!model && !thinking) dropped.push(key);
      else fresh.push({ ...key, ...(model ? { model } : {}), ...(thinking ? { thinking } : {}), at, ...(model && modelAt !== undefined ? { modelAt } : {}), ...(thinking && thinkingAt !== undefined ? { thinkingAt } : {}) });
    }
    const prefs = [...fresh, ...old.filter((p) => !fresh.some((f) => same(f, p)) && !dropped.some((d) => same(d, p)))].slice(0, MAX_MODEL_PREFS);
    try {
      this.d.jobs.update(plan.projectId, plan.jobId, { modelPrefs: prefs });
    } catch (err) {
      log('agents', `could not keep the model choices of ${plan.projectId}/${plan.jobId}: ${errorText(err)}`);
    }
  }
}
