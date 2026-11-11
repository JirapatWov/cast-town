// Plan card: the team the lead wants to start (work style 'ask'), shown in the lead's chat — who does what on which
// model and effort. The user may change each person's model and effort, then Run or Cancel; the lead's turn waits for
// the answer. Answered cards stay in the chat as a short record ("Running — you changed Reviewer to GPT-6.1 Sol"). A
// card for team_continue
// lists only the people who work again, under a line naming who keeps their result from the earlier run.
import { DEFAULT_WORK_STYLE, type PlanStep, type TeamPlan, type ThinkingLevel, type TranscriptItem, type Vendor } from '../../../shared/protocol';
import { thirdPerson } from '../../../shared/team-text';
import { h, setChildren } from './dom';
import { DEFAULT_THINKING, effortItems } from './effort-chip';
import { THINKING_LABEL, modelGroupTitle, modelLabel, vendorColor, vendorOfModel } from './format';
import { icon } from './icons';
import { kindInfo } from './jobs';
import {
  changedModels,
  changedPeople,
  changedThinking,
  finalModel,
  finalThinking,
  modelOptions,
  planFromName,
  planOutcome,
  stepNote,
  teamLine,
  type EffortPick,
} from './plans';
import type { Shell } from './shell';
import type { ItemView, PlanItem } from './transcript';
import { avatar, modelChip } from './widgets';
import { setWorkStyle } from './work-style';

// Per plan, kept across chat rebuilds (switching people re-creates the transcript): the user's model and effort picks,
// an answer on the wire (until the server's upsert shows the result), the server's refusal.
const picks = new Map<string, Record<string, string>>();
const efforts = new Map<string, Record<string, EffortPick>>();
const sending = new Map<string, ReturnType<typeof setTimeout>>();
const errors = new Map<string, string>();
const views = new Set<{ planId: string; render(): void }>();
const moreOpen = new Set<string>(); // "<plan id>:<step id>" whose whole description is open

/** What a person does, in the third person, with their whole description behind "More" (personas speak to the model). */
function dutyView(plan: TeamPlan, step: PlanStep): HTMLElement | null {
  if (!step.duty && !step.about) return null;
  const key = `${plan.id}:${step.id}`;
  const open = moreOpen.has(key);
  const more = step.about
    ? h(
        'button',
        {
          type: 'button',
          class: 'plan-step-more',
          'aria-expanded': String(open),
          onclick: () => {
            if (open) moreOpen.delete(key);
            else moreOpen.add(key);
            rerender(plan.id);
          },
        },
        open ? 'Less' : 'More',
      )
    : null;
  return h('p', { class: 'plan-step-duty' }, open && step.about ? thirdPerson(step.about) : thirdPerson(step.duty), more ? ' ' : null, more);
}

const SEND_TIMEOUT_MS = 20_000;

function rerender(planId: string) {
  for (const v of views) if (v.planId === planId) v.render();
}

function settle(planId: string) {
  const t = sending.get(planId);
  if (t) clearTimeout(t);
  sending.delete(planId);
}

async function answer(shell: Shell, plan: TeamPlan, run: boolean) {
  if (sending.has(plan.id)) return;
  // Stays "sending" after the ack until the plan's upsert arrives (or a while passes), so Run can't go out twice.
  sending.set(plan.id, setTimeout(() => (sending.delete(plan.id), rerender(plan.id)), SEND_TIMEOUT_MS));
  errors.delete(plan.id);
  rerender(plan.id);
  const models = run ? changedModels(plan, picks.get(plan.id) ?? {}) : {};
  const thinking = run ? changedThinking(plan, efforts.get(plan.id) ?? {}) : {};
  try {
    await shell.store.request({
      t: 'answer_plan',
      reqId: '',
      planId: plan.id,
      run,
      ...(Object.keys(models).length ? { models } : {}),
      ...(Object.keys(thinking).length ? { thinking } : {}),
    });
  } catch (err) {
    settle(plan.id);
    errors.set(plan.id, (err as Error).message);
    rerender(plan.id);
  }
}

function leadName(shell: Shell, plan: TeamPlan): string {
  const s = shell.store.state;
  return s.agents[plan.agentId]?.name ?? kindInfo(shell.store.job(plan.projectId, plan.jobId)?.kind).lead;
}

/** A native select (works the same on phones), grouped by vendor. */
function modelSelect(shell: Shell, step: PlanStep, value: string, disabled: boolean, onPick: (id: string) => void): HTMLSelectElement {
  const { models } = shell.store.state;
  const options = modelOptions(models, step.model);
  if (!options.some((o) => o.id === value)) options.push(...modelOptions(models, value).filter((o) => o.id === value));
  // one group per maker, and one per other sign-in ("Google · via Antigravity")
  const groups = new Map<string, typeof options>();
  for (const o of options) groups.set(`${o.vendor}|${o.route ?? ''}`, [...(groups.get(`${o.vendor}|${o.route ?? ''}`) ?? []), o]);
  const sel = h(
    'select',
    { class: 'input input-inline plan-model', 'aria-label': `Model for ${step.name}`, disabled },
    [...groups.values()].map((list) =>
      h(
        'optgroup',
        { label: modelGroupTitle(list[0]!) },
        list.map((o) =>
          h(
            'option',
            { value: o.id, selected: o.id === value, disabled: o.disabled },
            `${o.label}${o.disabled ? ' — not connected' : ''}${o.id === step.model && value !== step.model ? ' (planned)' : ''}`,
          ),
        ),
      ),
    ),
  );
  sel.value = value;
  sel.addEventListener('change', () => onPick(sel.value));
  return sel;
}

/** "High", "Default (High)": an effort for the card (undefined = omp's default). */
function effortName(t: ThinkingLevel | undefined): string {
  return t ? THINKING_LABEL[t] : `Default (${THINKING_LABEL[DEFAULT_THINKING]})`;
}

/** The effort select beside the model: Default plus the levels the model has; a level the model lacks says what it runs
 *  as there ("Max → High"). */
function effortSelect(shell: Shell, step: PlanStep, model: string, value: ThinkingLevel | undefined, disabled: boolean, onPick: (t: EffortPick) => void): HTMLElement {
  const items = effortItems(model, shell.store.state.models, value);
  const planned = step.thinking ?? 'default';
  const sel = h(
    'select',
    { class: 'input input-inline plan-effort', 'aria-label': `Effort for ${step.name}`, title: 'Effort: how hard they think — more is slower and costs more', disabled },
    items.map((it) =>
      h(
        'option',
        { value: it.value, selected: it.value === (value ?? 'default') },
        `${it.value === 'default' ? effortName(undefined) : it.label}${it.becomes ? ` → ${THINKING_LABEL[it.becomes]}` : ''}${it.value === planned && (value ?? 'default') !== planned ? ' (planned)' : ''}`,
      ),
    ),
  );
  sel.value = value ?? 'default';
  sel.addEventListener('change', () => onPick(sel.value === 'default' ? '' : (sel.value as ThinkingLevel)));
  return h('label', { class: 'plan-effort-wrap' }, icon('brain', 12), h('span', { class: 'plan-effort-word' }, 'Effort'), sel);
}

export function planView(shell: Shell, initial: PlanItem): ItemView {
  let plan = initial.plan;
  let last = '';
  let briefOpen = false;
  const el = h('article', { class: 'plan', 'aria-label': `${plan.continues ? 'Continue the team run' : 'Team plan'}: ${plan.title}` });
  const view = { planId: plan.id, render };
  for (const v of views) if (v.planId === plan.id) views.delete(v); // the chat was rebuilt: its old card is gone
  views.add(view);

  function render() {
    // A card that left the chat (the transcript was rebuilt) stops listening.
    if (last && !el.isConnected) {
      views.delete(view);
      return;
    }
    const s = shell.store.state;
    const models = s.models;
    const pending = plan.status === 'pending';
    const busy = sending.has(plan.id);
    const error = errors.get(plan.id);
    const mine = picks.get(plan.id) ?? {};
    const mineEffort = efforts.get(plan.id) ?? {};
    const lead = leadName(shell, plan);
    last = stamp();
    el.className = ['plan', `is-${plan.status}`, busy && 'is-sending'].filter(Boolean).join(' ');

    const rows = plan.steps.map((step, i) => {
      const model = pending ? (mine[step.id] ?? step.model) : finalModel(plan, step);
      const effort = pending ? (step.id in mineEffort ? mineEffort[step.id] || undefined : step.thinking) : finalThinking(plan, step);
      const modelChanged = pending ? model !== step.model : !!plan.changed?.[step.id];
      const effortChanged = pending ? (effort ?? '') !== (step.thinking ?? '') : !!plan.changedThinking && step.id in plan.changedThinking;
      const changed = modelChanged || effortChanged;
      const planned = `Planned: ${modelLabel(step.model, models)} · ${effortName(step.thinking)} effort`;
      const vendor = vendorOfModel(model, models);
      const note = stepNote(step, plan.steps, plan.continues?.kept);
      return h(
        'li',
        { class: ['plan-step', i > 0 && step.parallel && 'is-par', changed && 'is-changed'], style: { '--vc': vendorColor(vendor) } },
        avatar(step.name || '?', vendor, 'sm'),
        h(
          'div',
          { class: 'plan-step-main' },
          h(
            'p',
            { class: 'plan-step-top' },
            h('span', { class: 'plan-step-name' }, step.name),
            note ? h('span', { class: 'plan-step-note' }, icon(step.kind === 'review' ? 'loop' : 'columns', 11), note) : null,
          ),
          dutyView(plan, step),
          h(
            'div',
            { class: 'plan-step-model' },
            pending
              ? [
                  modelSelect(shell, step, model, busy, (id) => {
                    const next = { ...(picks.get(plan.id) ?? {}) };
                    if (id === step.model) delete next[step.id];
                    else next[step.id] = id;
                    picks.set(plan.id, next);
                    errors.delete(plan.id);
                    render();
                    el.querySelectorAll<HTMLSelectElement>('select.plan-model')[i]?.focus({ preventScroll: true });
                  }),
                  effortSelect(shell, step, model, effort, busy, (t) => {
                    const next = { ...(efforts.get(plan.id) ?? {}) };
                    if (t === (step.thinking ?? '')) delete next[step.id];
                    else next[step.id] = t;
                    efforts.set(plan.id, next);
                    errors.delete(plan.id);
                    render();
                    el.querySelectorAll<HTMLSelectElement>('select.plan-effort')[i]?.focus({ preventScroll: true });
                  }),
                  changed ? h('span', { class: 'chip chip-changed', title: planned }, 'changed') : null,
                ]
              : [
                  h('span', { class: 'vendor-dot', style: { background: vendorColor(vendor) }, 'aria-hidden': 'true' }),
                  h('span', { class: 'plan-model-label' }, modelLabel(model, models)),
                  h('span', { class: 'plan-effort-label', title: 'Effort' }, icon('brain', 11), effortName(effort)),
                  changed ? h('span', { class: 'chip chip-changed', title: planned }, 'changed') : modelChip(model, models),
                ],
          ),
        ),
      );
    });

    const changes = changedPeople(changedModels(plan, mine), changedThinking(plan, mineEffort));
    const run = plan.runId ? s.runs[plan.runId] : undefined;
    const foot = pending
      ? h(
          'footer',
          { class: 'plan-foot' },
          error ? h('p', { class: 'form-error plan-error', role: 'alert' }, error) : null,
          h(
            'p',
            { class: 'plan-hint' },
            busy
              ? 'Sending your answer…'
              : changes
                ? `You changed ${changes === 1 ? 'one person' : `${changes} people`} — the ${lead} keeps your picks for later teams of this job.`
                : plan.continues
                  ? 'Only these people work again. Change a model or effort if you like, then Run.'
                  : 'Change a model or effort if you like, then Run.',
          ),
          h(
            'div',
            { class: 'plan-actions' },
            noMoreCards(plan, lead),
            h('button', { type: 'button', class: 'btn btn-ghost btn-sm', disabled: busy, onclick: () => void answer(shell, plan, false) }, 'Cancel'),
            h(
              'button',
              { type: 'button', class: 'btn btn-primary btn-sm', disabled: busy, onclick: () => void answer(shell, plan, true) },
              busy ? h('span', { class: 'spinner spinner-sm' }) : icon('play', 13),
              'Run',
            ),
          ),
        )
      : h(
          'footer',
          { class: 'plan-foot' },
          h('p', { class: 'plan-outcome' }, icon(plan.status === 'approved' ? 'checkCircle' : 'xCircle', 14), h('span', null, planOutcome(plan, run, models))),
          plan.status === 'approved' && plan.runId && run
            ? h(
                'button',
                {
                  type: 'button',
                  class: 'link-btn plan-open-run',
                  onclick: () => {
                    if (shell.store.job(plan.projectId, plan.jobId)) shell.selectJob(plan.projectId, plan.jobId);
                    shell.openWorkflow(plan.projectId, plan.runId); // the run this card started, not the job's latest
                  },
                },
                'Open run',
              )
            : null,
        );

    setChildren(el,
      h(
        'header',
        { class: 'plan-head' },
        h('span', { class: 'plan-icon' }, icon(pending ? 'hand' : plan.continues ? 'loop' : 'users', 15)),
        h(
          'div',
          { class: 'plan-titles' },
          h(
            'p',
            { class: 'plan-kicker' },
            plan.continues
              ? pending ? `${lead} wants to continue a team run` : 'Team plan · continued'
              : pending ? `${lead} wants to start a team` : 'Team plan',
          ),
          h('h4', { class: 'plan-title' }, plan.title),
          plan.why ? h('p', { class: 'plan-why' }, plan.why) : null,
        ),
      ),
      continues(),
      h('ol', { class: 'plan-steps' }, rows),
      plan.task
        ? h(
            'details',
            { class: 'plan-brief', open: briefOpen, ontoggle: (ev: Event) => (briefOpen = (ev.currentTarget as HTMLDetailsElement).open) },
            h('summary', null, icon('file', 13), h('span', null, 'What the team gets'), icon('chevronDown', 13, 'plan-brief-chev')),
            h('div', { class: 'plan-brief-text' }, briefText(plan)),
          )
        : null,
      foot,
    );
  }

  /** "Don't ask again for this job": the job's work style becomes Just go (this card still waits for Run or Cancel). */
  function noMoreCards(plan: TeamPlan, lead: string): HTMLElement | null {
    const job = shell.store.job(plan.projectId, plan.jobId);
    if (!job || (job.workStyle ?? DEFAULT_WORK_STYLE) !== 'ask') return null;
    return h(
      'button',
      {
        type: 'button',
        class: 'link-btn plan-no-ask',
        title: `The ${lead} starts teams in “${job.name}” right away from now on. Change it back on the Workflow tab or in the job’s ⋯ menu.`,
        onclick: () => void setWorkStyle(shell, job, 'auto', lead),
      },
      'Don’t ask again for this job',
    );
  }

  /** The brief with the house's folder (or the job's own copy) left out of paths: "src/app.ts", not "/home/…/src/app.ts". */
  function briefText(plan: TeamPlan): string {
    const p = shell.store.project(plan.projectId);
    const wt = shell.store.job(plan.projectId, plan.jobId)?.worktree?.path;
    let text = plan.task;
    for (const dir of [wt, p?.path].filter((d): d is string => !!d && d.length > 1)) {
      const base = dir.replace(/\/+$/, '');
      text = text.split(`${base}/`).join('').split(base).join(`the “${p?.name ?? 'house'}” folder`);
    }
    return text;
  }

  /** What the card shows depends on, besides the plan: to skip rebuilds that would change nothing. */
  function stamp(): string {
    const s = shell.store.state;
    const earlier = plan.continues ? !!s.runs[plan.continues.runId] : null;
    return JSON.stringify([plan, picks.get(plan.id) ?? {}, efforts.get(plan.id) ?? {}, sending.has(plan.id), errors.get(plan.id), s.models, plan.runId ? s.runs[plan.runId]?.status : null, earlier, shell.store.job(plan.projectId, plan.jobId)?.workStyle]);
  }

  /** A continuation (team_continue): who works again first, who keeps their result, and the lead's note for them. */
  function continues(): HTMLElement | null {
    const cont = plan.continues;
    if (!cont) return null;
    const earlier = shell.store.state.runs[cont.runId];
    const openEarlier = () => {
      if (shell.store.job(plan.projectId, plan.jobId)) shell.selectJob(plan.projectId, plan.jobId);
      shell.openWorkflow(plan.projectId, cont.runId);
    };
    const runLink = earlier
      ? h('button', { type: 'button', class: 'link-btn', title: 'Open the earlier run in the Workflow tab', onclick: openEarlier }, 'the earlier run')
      : 'the earlier run';
    return h(
      'div',
      { class: 'plan-continues' },
      icon('loop', 13),
      h(
        'div',
        { class: 'plan-continues-main' },
        h(
          'p',
          null,
          h('strong', null, `From ${planFromName(plan)}`),
          cont.kept.length ? [' — kept from ', runLink, ': ', h('span', { class: 'plan-continues-kept' }, teamLine(cont.kept))] : [' — nothing is kept from ', runLink, ': everyone works again.'],
        ),
        cont.note ? h('p', { class: 'plan-continues-note' }, h('span', { class: 'muted' }, 'Note: '), `“${cont.note}”`) : null,
        // a running team changed in a way that redoes work (team_edit redo): what changes
        cont.changes?.length ? h('p', { class: 'plan-continues-note' }, h('span', { class: 'muted' }, 'Changes: '), cont.changes.join('; ')) : null,
      ),
    );
  }

  function update(next: TranscriptItem) {
    if (next.kind !== 'plan') return;
    if (next.plan.status !== 'pending') {
      settle(next.plan.id);
      errors.delete(next.plan.id);
      picks.delete(next.plan.id);
      efforts.delete(next.plan.id);
    }
    plan = next.plan;
    render();
  }

  render();
  return {
    el,
    update,
    refresh() {
      // only when something it shows changed (models, its run's status, the earlier run it continues)
      if (stamp() === last) return;
      render();
    },
  };
}
