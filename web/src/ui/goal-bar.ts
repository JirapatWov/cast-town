// Goal mode for a lead (omp goal): "Set a goal…" asks for an objective and an optional token budget; the lead then
// keeps working on its own, turn after turn, until it marks the goal done or the budget runs out. A bar pinned at the
// top of the lead's chat shows the objective, its state and the tokens used, with Pause / Resume and Drop.
import type { AgentInfo, GoalInfo } from '../../../shared/protocol';
import { chatIcon } from './chat-icons';
import { autosize, h, memo, setChildren } from './dom';
import { fmtDuration, fmtTokens, isAgentBusy } from './format';
import { icon } from './icons';
import { openModal } from './modal';
import type { Shell } from './shell';

type GoalOp = 'pause' | 'resume' | 'drop';

const OBJECTIVE_MAX = 4000;
const pending = new Map<string, GoalOp>(); // agentId → the op on the wire
const bars = new Set<() => void>();

const rerender = () => {
  for (const r of bars) r();
};

/** Goals are for a job's lead only. */
export function canHaveGoal(a: AgentInfo | undefined): a is AgentInfo {
  return !!a && a.kind === 'resident';
}

const STATUS: Record<GoalInfo['status'], string> = { active: 'Active', paused: 'Paused', 'budget-limited': 'Budget reached — wrapping up' };

/** Pause, resume or drop the lead's goal (drop asks first). */
export async function goalAction(shell: Shell, agentId: string, op: GoalOp): Promise<void> {
  const a = shell.store.state.agents[agentId];
  if (!a?.goal || pending.has(agentId)) return;
  if (op === 'drop') {
    const ok = await shell.confirm({
      title: 'Drop the goal?',
      body: h(
        'div',
        null,
        h('p', null, `${a.name} stops working on it by itself:`),
        h('blockquote', { class: 'goal-quote' }, a.goal.objective),
        h('p', { class: 'muted small' }, 'The chat stays. You can set a new goal any time.'),
      ),
      confirmLabel: 'Drop goal',
      tone: 'danger',
      icon: 'x',
    });
    if (!ok) return;
  }
  pending.set(agentId, op);
  rerender();
  try {
    await shell.store.request({ t: 'goal', reqId: '', agentId, op });
  } catch (err) {
    shell.toast('error', `Could not ${op} the goal: ${(err as Error).message}`, { agentId });
  } finally {
    pending.delete(agentId);
    rerender();
  }
}

/** "Set a goal…": objective + optional token budget. */
export function openGoalDialog(shell: Shell, agentId: string): void {
  const a = shell.store.state.agents[agentId];
  if (!canHaveGoal(a)) return;
  const objective = h('textarea', {
    class: 'input',
    rows: 4,
    maxlength: OBJECTIVE_MAX,
    id: 'goal-objective',
    placeholder: 'e.g. Make every test in tests/ pass, then get the change reviewed',
  });
  const budget = h('input', { class: 'input goal-budget', type: 'number', min: 1000, step: 1000, inputmode: 'numeric', id: 'goal-budget', placeholder: 'No limit' });
  const error = h('p', { class: 'form-error', hidden: true, role: 'alert' });
  const start = h('button', { type: 'submit', class: 'btn btn-primary', form: 'goal-form' }, chatIcon('target', 15), 'Start');
  let busy = false;

  const fail = (text: string, field?: HTMLElement) => {
    error.textContent = text;
    error.hidden = false;
    if (field) {
      field.classList.remove('is-invalid');
      void field.offsetWidth; // restart the shake
      field.classList.add('is-invalid');
      field.focus();
    }
  };

  const submit = async () => {
    if (busy) return;
    const text = objective.value.trim();
    if (!text) return fail('Say what the goal is.', objective);
    const raw = budget.value.trim();
    const tokens = raw ? Math.round(Number(raw)) : undefined;
    if (raw && (!Number.isFinite(tokens) || !tokens || tokens <= 0)) return fail('The budget is a number of tokens, or empty for no limit.', budget);
    busy = true;
    error.hidden = true;
    start.disabled = true;
    setChildren(start, h('span', { class: 'spinner spinner-sm' }), 'Starting…');
    try {
      await shell.store.request({ t: 'goal', reqId: '', agentId, op: 'create', objective: text, ...(tokens ? { tokenBudget: tokens } : {}) });
      modal.close();
    } catch (err) {
      fail((err as Error).message);
    } finally {
      busy = false;
      start.disabled = false;
      setChildren(start, chatIcon('target', 15), 'Start');
    }
  };

  const form = h(
    'form',
    { class: 'goal-form', id: 'goal-form', novalidate: true },
    h('p', { class: 'goal-intro' }, `${a.name} keeps working on its own — turn after turn — until it marks the goal done or the budget runs out. Pause or drop it any time; Stop pauses it.`),
    h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'goal-objective' }, `What should ${a.name} get done?`), objective),
    h(
      'div',
      { class: 'field' },
      h('label', { class: 'field-label', for: 'goal-budget' }, 'Token budget (optional)'),
      budget,
      h('p', { class: 'field-hint' }, `Input + output tokens of every model call toward the goal. When it runs out, ${a.name} wraps up.`),
    ),
    error,
  );
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    void submit();
  });
  objective.addEventListener('input', () => {
    autosize(objective, 260);
    objective.classList.remove('is-invalid');
  });
  objective.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      void submit();
    }
  });
  budget.addEventListener('input', () => budget.classList.remove('is-invalid'));

  const modal = openModal(shell.root, shell.layers, {
    id: 'goal-dialog',
    className: 'modal-goal',
    title: 'Set a goal',
    subtitle: `For ${a.name}, in this chat`,
    body: form,
    footer: [h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => modal.close() }, 'Cancel'), start],
  });
  requestAnimationFrame(() => objective.focus());
}

/** The bar at the top of a lead's chat while it has a goal. */
export function createGoalBar(shell: Shell) {
  let agentId: string | null = null;
  let open = false;
  const changed = memo();
  const el = h('div', { class: 'goal-bar', hidden: true, role: 'region', 'aria-label': 'Goal' });

  function render() {
    const a = agentId ? shell.store.state.agents[agentId] : undefined;
    const goal = canHaveGoal(a) ? a.goal : undefined;
    const op = agentId ? pending.get(agentId) : undefined;
    if (!changed([agentId, goal, op, open, isAgentBusy(a)])) return;
    el.hidden = !goal;
    if (!goal || !a) {
      setChildren(el);
      return;
    }
    el.className = ['goal-bar', `is-${goal.status}`, open && 'is-open'].filter(Boolean).join(' ');
    const working = goal.status === 'active' && isAgentBusy(a);
    const share = goal.tokenBudget ? Math.min(100, (goal.tokensUsed / goal.tokenBudget) * 100) : 0;
    const used = goal.tokenBudget ? `${fmtTokens(goal.tokensUsed)} of ${fmtTokens(goal.tokenBudget)} tokens` : `${fmtTokens(goal.tokensUsed)} tokens used`;
    const btn = (label: string, iconEl: Node, which: GoalOp, title: string, cls = 'btn-ghost') =>
      h(
        'button',
        { type: 'button', class: ['btn', 'btn-sm', cls, 'goal-btn'], disabled: !!op, title, onclick: () => void goalAction(shell, a.id, which) },
        op === which ? h('span', { class: 'spinner spinner-sm' }) : iconEl,
        h('span', null, label),
      );
    // A button, so the keyboard opens the clamped objective too.
    const objective = h(
      'button',
      { type: 'button', class: 'goal-objective', 'aria-expanded': String(open), title: open ? 'Show less' : 'Show all' },
      h('span', { class: 'goal-objective-text' }, goal.objective),
    );
    objective.addEventListener('click', () => {
      open = !open;
      render();
    });
    // Rebuilt on every change: the keyboard focus stays on the same button (the objective, Pause → Resume).
    const focusAt = [...el.querySelectorAll('button')].indexOf(document.activeElement as HTMLButtonElement);
    setChildren(el,
      h(
        'div',
        { class: 'goal-top' },
        h('span', { class: 'goal-kicker' }, chatIcon('target', 14), 'Goal'),
        h('span', { class: ['chip', 'goal-chip', `is-${goal.status}`] }, working ? h('span', { class: 'spinner spinner-sm' }) : null, working ? 'Working on it' : STATUS[goal.status]),
        h('span', { class: 'goal-spacer' }),
        goal.status === 'paused'
          ? btn('Resume', icon('play', 13), 'resume', `${a.name} picks the goal up again`, 'btn-soft')
          : btn('Pause', chatIcon('pause', 13), 'pause', `${a.name} finishes this turn, then waits`),
        btn('Drop', icon('x', 13), 'drop', 'Stop working toward this goal'),
      ),
      objective,
      h(
        'div',
        { class: 'goal-usage', title: goal.tokenBudget ? `${Math.round(share)}% of the token budget` : 'No token budget' },
        goal.tokenBudget ? h('span', { class: 'goal-meter' }, h('span', { style: { width: `${share}%` } })) : null,
        h('span', { class: 'num' }, used),
        goal.timeUsedSeconds ? h('span', { class: 'num' }, `· ${fmtDuration(goal.timeUsedSeconds * 1000)}`) : null,
      ),
    );
    if (focusAt >= 0) el.querySelectorAll('button')[focusAt]?.focus({ preventScroll: true });
  }
  bars.add(render);

  return {
    el,
    show(id: string | null) {
      if (id !== agentId) open = false;
      agentId = id;
      render();
    },
    render,
  };
}
