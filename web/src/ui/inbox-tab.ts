// Inbox tab: everything waiting for you (plan cards, approvals) + "Recent": the house activity log the server keeps
// (finished runs, agents that couldn't start or hit an error, …: the same on every device) and what happened only on
// this page (inbox-recent.ts). Errors that arrived since the Inbox was last open put a red dot on the top bar's bell.
import type { ServerMsg, TeamPlan } from '../../../shared/protocol';
import { approvalCard, goToRequest } from './approvals';
import { h, setChildren, storage } from './dom';
import { vendorOfModel } from './format';
import { liveAgo } from './live-time';
import { icon } from './icons';
import { recentItems, unseenProblems } from './inbox-recent';
import { codeBadge } from './job-switcher';
import { pendingPlans, planFromName, teamLine } from './plans';
import type { Shell, ToastEntry } from './shell';
import { avatar, emptyState } from './widgets';

const LEVEL_ICON: Record<ToastEntry['level'], string> = { info: 'sparkle', success: 'checkCircle', warn: 'alert', error: 'xCircle' };
const SEEN_KEY = 'rlt.inbox.seen';

let seenTs = Number(storage.get(SEEN_KEY)) || 0;
const seenListeners = new Set<() => void>();
/** The Inbox's Recent was on screen up to `ts`: what came in before no longer counts as unseen. */
function markSeen(ts: number) {
  if (ts <= seenTs) return;
  seenTs = ts;
  storage.set(SEEN_KEY, String(ts));
  for (const fn of seenListeners) fn();
}
/** Errors in Recent the user hasn't seen on this device yet (the bell's red dot). */
export function unseenInboxErrors(shell: Shell): number {
  return unseenProblems(recentItems(shell.store.state.activity, shell.notifications), seenTs);
}
/** fn runs when the Inbox was looked at (the bell's dot goes). */
export function onInboxSeen(fn: () => void): () => void {
  seenListeners.add(fn);
  return () => seenListeners.delete(fn);
}

export function createInboxTab(shell: Shell) {
  const { store } = shell;
  const el = h('div', { class: 'tab-inbox' });
  let projectId: string | null = null; // the house whose inbox this is (null: the town — everything)

  /** A plan card waiting in a lead's chat: the card itself lives there (models to change, Run / Cancel). A card that
   *  continues a run (team_continue) says from whom, and who keeps their result. */
  function planRow(plan: TeamPlan): HTMLElement {
    const lead = store.state.agents[plan.agentId];
    const job = store.job(plan.projectId, plan.jobId);
    const several = !!job && store.jobsOf(plan.projectId).length > 1;
    const project = store.project(plan.projectId);
    const open = () => (lead ? goToRequest(shell, plan) : project && shell.enterProject(project.id));
    return h(
      'article',
      { class: 'inbox-plan' },
      h('span', { class: 'approval-hand' }, icon('hand', 15)),
      h(
        'div',
        { class: 'inbox-plan-main' },
        h(
          'p',
          { class: 'inbox-plan-title' },
          several && job ? codeBadge(job, 'sm') : null,
          h('strong', null, lead?.name ?? 'The lead'),
          plan.continues ? ' wants to continue ' : ' has a plan: ',
          h('span', { class: 'inbox-plan-name' }, `“${plan.title}”`),
          plan.continues ? ` from ${planFromName(plan)}` : null,
        ),
        h(
          'p',
          { class: 'inbox-plan-team' },
          plan.steps.map((st) => avatar(st.name || '?', vendorOfModel(st.model, store.state.models), 'xs')),
          h('span', null, teamLine(plan.steps)),
        ),
        plan.continues?.kept.length
          ? h('p', { class: 'inbox-plan-kept' }, icon('loop', 11), h('span', null, `Kept from the earlier run: ${teamLine(plan.continues.kept)}`))
          : null,
        h('p', { class: 'approval-meta' }, project && plan.projectId !== projectId ? h('span', { class: 'approval-project' }, project.name) : null, liveAgo(plan.ts)),
      ),
      h('button', { type: 'button', class: 'btn btn-amber btn-sm', onclick: open }, 'Open chat'),
    );
  }

  /** Other houses with something waiting: one jump link each (into that house, its inbox open). */
  function elsewhere(): HTMLElement | null {
    if (!projectId) return null;
    const counts = new Map<string, number>();
    for (const a of Object.values(store.state.approvals)) if (a.projectId !== projectId) counts.set(a.projectId, (counts.get(a.projectId) ?? 0) + 1);
    for (const p of pendingPlans(store.state)) if (p.projectId !== projectId) counts.set(p.projectId, (counts.get(p.projectId) ?? 0) + 1);
    const houses = [...counts].map(([id, n]) => ({ project: store.project(id), n })).filter((x) => x.project);
    if (!houses.length) return null;
    const total = houses.reduce((sum, x) => sum + x.n, 0);
    return h(
      'div',
      { class: 'inbox-elsewhere', role: 'note' },
      icon('hand', 13),
      h('span', null, `${total} more waiting in ${houses.length === 1 ? 'another house' : 'other houses'}: `),
      houses.map((x, i) => [
        i ? ', ' : null,
        h(
          'button',
          {
            type: 'button',
            class: 'link-btn',
            title: `Go to ${x.project!.name} and open its inbox`,
            onclick: () => {
              if (shell.view.view === 'house') shell.enterProject(x.project!.id);
              shell.openPanel('inbox', x.project!.id);
            },
          },
          `${x.project!.name} (${x.n})`,
        ),
      ]),
    );
  }

  function render() {
    if (projectId && !store.project(projectId)) projectId = null;
    const house = store.project(projectId);
    const approvals = Object.values(store.state.approvals).filter((a) => !projectId || a.projectId === projectId).sort((a, b) => a.ts - b.ts);
    const plans = pendingPlans(store.state, projectId ? { projectId } : undefined);
    const waiting = approvals.length + plans.length;
    // the server's activity log + this page's own notes; this house's, plus the ones about no house in particular
    const notes = recentItems(store.state.activity, shell.notifications, 200).filter((n) => !projectId || !n.projectId || n.projectId === projectId).slice(0, 40);
    setChildren(el,
      h('h3', { class: 'section-title' }, house ? `Waiting in ${house.name}` : 'Waiting for you', waiting ? h('span', { class: 'count is-amber num' }, String(waiting)) : null),
      waiting
        ? h('div', { class: 'inbox-approvals' }, plans.map(planRow), approvals.map((a) => approvalCard(shell, a)))
        : h('p', { class: 'inbox-clear' }, icon('checkCircle', 15), house ? `Nothing in ${house.name} needs you right now.` : 'Nothing needs you right now.'),
      elsewhere(),
      h('h3', { class: 'section-title' }, 'Recent'),
      notes.length
        ? h(
            'ul',
            { class: 'notes' },
            notes.map((n) => {
              const project = n.projectId ? store.project(n.projectId) : undefined;
              const clickable = !!(n.agentId && store.state.agents[n.agentId]) || !!project;
              const body = [
                h('span', { class: `note-icon level-${n.level}` }, icon(LEVEL_ICON[n.level], 15)),
                h('span', { class: 'note-text' }, n.text),
                h('span', { class: 'note-meta' }, project && n.projectId !== projectId ? h('span', null, project.name) : null, liveAgo(n.ts, '')),
              ];
              return h(
                'li',
                null,
                clickable
                  ? h(
                      'button',
                      {
                        type: 'button',
                        class: 'note',
                        onclick: () => (n.agentId && store.state.agents[n.agentId] ? shell.openAgent(n.agentId) : project && shell.enterProject(project.id)),
                      },
                      body,
                    )
                  : h('div', { class: 'note' }, body),
              );
            }),
          )
        : emptyState('bell', 'All quiet', 'Finished runs, errors and other updates will collect here.'),
    );
    // on screen now: the errors in it count as seen (when the tab isn't hidden behind another one)
    if (el.isConnected && el.offsetParent !== null && !document.hidden) markSeen(Math.max(Date.now(), notes[0]?.ts ?? 0));
  }

  return {
    el,
    /** pid: the house whose inbox to show (its own requests; others get a jump link), null for the whole town. */
    show(pid: string | null = null) {
      projectId = pid;
      render();
    },
    onState(msg?: ServerMsg) {
      if (!msg || msg.t === 'approval' || msg.t === 'approval_resolved' || msg.t === 'snapshot' || msg.t === 'toast' || msg.t === 'plan' || msg.t === 'city' || (msg.t === 'transcript_upsert' && msg.item.kind === 'plan')) render();
    },
    render,
  };
}
