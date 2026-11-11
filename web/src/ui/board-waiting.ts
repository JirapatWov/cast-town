// "Waiting for you" at the top of the Town board: every question, approval and plan card of the whole town in one
// list, each with the chat it is answered in — on a phone the house cards that hold them are far down the page.
import { approvalLine, isQuestion } from '../../../shared/ask';
import { h } from './dom';
import { icon } from './icons';
import { codeBadge } from './job-switcher';
import { MAIN_JOB } from './jobs';
import { pendingPlans } from './plans';
import type { Shell } from './shell';

const SHOWN = 5; // more than that: the Inbox has them all, the houses stay in reach

interface WaitItem {
  ts: number;
  projectId: string;
  jobId: string | undefined;
  agentId: string;
  who: string;
  what: string;
}

/** Nothing waits: null (the board shows no empty block). open: opens that person's chat. */
export function waitingSummary(shell: Shell, open: (agentId: string, projectId: string) => void): HTMLElement | null {
  const { store } = shell;
  const s = store.state;
  const items: WaitItem[] = [
    ...Object.values(s.approvals).map((a) => {
      const agent = s.agents[a.agentId];
      const who = agent?.name ?? 'Someone';
      return { ts: a.ts, projectId: a.projectId, jobId: agent?.jobId, agentId: a.agentId, who, what: `${isQuestion(a) ? 'asks' : 'needs your OK'}: ${approvalLine(a)}` };
    }),
    ...pendingPlans(s).map((p) => ({ ts: p.ts, projectId: p.projectId, jobId: p.jobId || MAIN_JOB, agentId: p.agentId, who: s.agents[p.agentId]?.name ?? 'The lead', what: `has a plan: “${p.title}”` })),
  ].sort((a, b) => a.ts - b.ts);
  if (!items.length) return null;
  const rows = items.slice(0, SHOWN).map((it) => {
    const house = store.project(it.projectId)?.name ?? 'A house';
    const job = it.jobId ? store.jobsOf(it.projectId).find((j) => j.id === it.jobId) : undefined;
    return h(
      'li',
      { class: 'fv-wait-row' },
      job ? codeBadge(job, 'sm') : h('span', { class: 'fv-wait-nocode', 'aria-hidden': 'true' }, icon('hand', 14)),
      h(
        'span',
        { class: 'fv-wait-text' },
        h('span', { class: 'fv-wait-where' }, job ? `${house} · ${job.name}` : house),
        h('span', { class: 'fv-wait-what', title: `${it.who} ${it.what}` }, h('b', null, it.who), ` ${it.what}`),
      ),
      h('button', { type: 'button', class: 'btn btn-primary btn-sm', 'aria-label': `Open ${it.who}’s chat in ${house}`, onclick: () => open(it.agentId, it.projectId) }, 'Open'),
    );
  });
  const more = items.length - SHOWN;
  return h(
    'section',
    { class: 'fv-waiting glass', 'aria-labelledby': 'fv-waiting-title' },
    h('h3', { id: 'fv-waiting-title', class: 'fv-waiting-title' }, icon('hand', 15), 'Waiting for you', h('span', { class: 'fv-pill is-amber num' }, String(items.length))),
    h('ul', { class: 'fv-waiting-list' }, rows),
    more > 0 ? h('button', { type: 'button', class: 'btn btn-ghost btn-sm fv-waiting-more', onclick: () => shell.openPanel('inbox', null) }, `${more} more in the Inbox`, icon('chevronRight', 14)) : null,
  );
}
