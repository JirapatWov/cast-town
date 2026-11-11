// A house card's jobs on the Town board: one row per job (room code, name, lead, what's going on, waiting and changed
// files) with its people folded under it, so two teams' "Decoder"s are never one flat list and it's clear who works.
import type { AgentInfo, Project } from '../../../shared/protocol';
import { gitKey } from '../net/reducer';
import type { BoardUnread } from './board-unread';
import { h } from './dom';
import { OFF_DUTY_HINT, agentStatusText, agentTone, fmtUsd, timeAgo } from './format';
import { icon } from './icons';
import { codeBadge } from './job-switcher';
import { jobStatus } from './jobs';
import { rosterOf, type RosterEntry } from './roster';
import type { Shell } from './shell';
import { isPhoneBoard } from './touch';
import { agentAvatar, statusDot } from './widgets';

/** People lists the viewer opened or closed by hand (the board is rebuilt on every change). */
const folded = new Map<string, boolean>();

function personRow(shell: Shell, e: RosterEntry, opened?: () => void): HTMLElement {
  const a = e.agent;
  const runNote = e.run ? ` · here for the “${e.run.workflowName}” run, leaves when it ends` : '';
  const open = () => {
    opened?.();
    shell.openAgent(a.id, { focusComposer: true });
  };
  return h(
    'li',
    null,
    h(
      'button',
      { type: 'button', class: 'fv-person', onclick: open, title: `${e.label} · ${a.modelLabel}${runNote}` },
      agentAvatar(a, 'sm'),
      h('span', { class: 'fv-person-name' }, e.label),
      h('span', { class: 'fv-person-status', title: a.status === 'offline' ? OFF_DUTY_HINT : undefined }, statusDot(agentTone(a)), agentStatusText(a)),
      a.costUsd ? h('span', { class: 'num muted small', title: `Spent: ${fmtUsd(a.costUsd)}` }, fmtUsd(a.costUsd)) : h('span'),
    ),
  );
}

function peopleList(shell: Shell, entries: RosterEntry[], opened?: () => void): HTMLElement {
  return h('ul', { class: 'fv-people' }, entries.map((e) => personRow(shell, e, opened)));
}

function working(people: AgentInfo[]): number {
  return people.filter((a) => agentTone(a) === 'work').length;
}

/** The jobs of one house with their people (a house without jobs yet lists its people as before). */
export function houseJobs(shell: Shell, p: Project, unread: BoardUnread): HTMLElement {
  const { store } = shell;
  const s = store.state;
  const runs = Object.values(s.runs).filter((r) => r.projectId === p.id);
  const jobs = [...store.jobsOf(p.id)].sort((a, b) => a.room.floor - b.room.floor || a.room.slot - b.room.slot);
  if (!jobs.length) return peopleList(shell, rosterOf(store.agentsOf(p.id), runs));
  return h(
    'ul',
    { class: 'fv-jobs', 'aria-label': `Jobs in ${p.name}` },
    jobs.map((job) => {
      const st = jobStatus(shell, job);
      const files = job.worktree ? (s.git[gitKey(p.id, job.id)]?.files.length ?? 0) : 0;
      const busy = working(st.people);
      const key = `${p.id}/${job.id}`;
      const fresh = unread.of(p.id, job.id);
      const read = () => unread.clear(p.id, job.id);
      const phone = isPhoneBoard(shell.focusMode);
      // open by default while someone works or waits, or when it's the house's only job. Not on a phone's board: there
      // the people (a team can be 19 of them) open only when asked — the row says who leads and that someone works.
      const open = folded.get(key) ?? (!phone && (jobs.length === 1 || busy > 0 || st.waiting > 0));
      // (a phone's row: "Working", not which role and what it does — the long role names crowded the row out)
      const statusText = phone && st.tone === 'work' ? (busy > 1 ? `${busy} working` : 'Working') : st.text;
      const people = st.people.length
        ? h(
            'details',
            { class: 'fv-job-people', open: open || undefined },
            // remembered only when the viewer clicks (a details built open fires 'toggle' too)
            h(
              'summary',
              { onclick: (ev: MouseEvent) => folded.set(key, !((ev.currentTarget as HTMLElement).parentElement as HTMLDetailsElement).open) },
              `${st.people.length} ${st.people.length === 1 ? 'person' : 'people'}${busy ? ` · ${busy} working` : ''}`,
              // a phone's fold starts closed: the chevron says the line opens (houses.css)
              phone ? h('span', { class: 'fv-people-chev', 'aria-hidden': 'true' }, icon('chevronDown', 14)) : null,
            ),
            peopleList(shell, rosterOf(st.people, runs), read),
          )
        : h('p', { class: 'fv-job-empty muted small' }, 'Nobody has moved in yet');
      return h(
        'li',
        // is-solo: the lead alone — the row already names them (a phone's board drops the "1 person" fold, houses.css)
        { class: ['fv-job', st.waiting > 0 && 'is-waiting', fresh && 'is-new', st.people.length === 1 && 'is-solo'] },
        h(
          'button',
          {
            type: 'button',
            class: 'fv-job-row',
            title: `Open ${job.name} (lead: ${st.leadName})`,
            onclick: () => {
              read();
              shell.selectJob(p.id, job.id, { openPanel: true });
            },
          },
          codeBadge(job, 'sm'),
          h('span', { class: 'fv-job-name' }, job.name),
          h('span', { class: 'fv-job-status', title: st.text }, statusDot(st.tone), h('span', { class: 'fv-job-status-text' }, statusText)),
          fresh
            ? h(
                'span',
                { class: 'fv-job-new', title: `${shell.store.state.agents[fresh.agentId]?.name ?? st.leadName} finished ${timeAgo(fresh.ts)} — not read yet` },
                h('span', { class: 'fv-new-dot', 'aria-hidden': 'true' }),
                `New reply · ${timeAgo(fresh.ts)}`,
              )
            : null,
          h(
            'span',
            { class: 'fv-job-meta muted small' },
            `Lead: ${st.leadName}`,
            st.waiting ? h('span', { class: 'fv-pill is-amber' }, icon('hand', 11), String(st.waiting)) : null,
            files ? h('span', { class: 'fv-pill', title: `${files} changed file${files === 1 ? '' : 's'} in ${job.name}’s own copy` }, `${files} changed`) : null,
          ),
        ),
        people,
      );
    }),
  );
}
