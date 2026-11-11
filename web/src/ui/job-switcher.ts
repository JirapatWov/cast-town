// Side-panel job switcher. A compact bar shows the active job (room code, name, lead + model, live status, cost)
// and a status peek of the other jobs; it opens a dropdown with every job grouped by floor (top floor first).
import type { Job } from '../../../shared/protocol';
import { h, memo, setChildren } from './dom';
import { fmtUsd, vendorColor } from './format';
import { icon } from './icons';
import { openJobMenu } from './job-menu';
import { floorName, jobRoomCode, jobStatus, kindInfo, projectFloors, type JobStatus } from './jobs';
import { fitPlacement, openPopover } from './popover';
import type { Shell } from './shell';
import { kbd, statusDot } from './widgets';

const STATUS_WORD: Record<JobStatus['tone'], string> = {
  wait: 'Needs you',
  error: 'Error',
  work: 'Working',
  ok: 'Done',
  idle: 'Ready',
  off: 'Not connected', // its lead can't start: st.text says why
};

export function codeBadge(job: Job, size: 'sm' | 'md' = 'md'): HTMLElement {
  const k = kindInfo(job.kind);
  const code = jobRoomCode(job);
  // "1A" means nothing on its own: floor number + room letter of the room this job works in
  return h('span', { class: ['room-code', `room-code-${size}`], style: { '--kc': k.accent }, title: `Room ${code} — this job’s room in the house (floor ${job.room.floor + 1}, room ${code.slice(-1)}) · ${k.name}` }, code);
}

function statusWord(st: JobStatus): string {
  if (st.waiting > 1) return `${st.waiting} need you`;
  if (st.tone === 'work' && st.busy > 1) return `${st.busy} working`;
  if (st.runActive && st.tone === 'idle') return 'Team run';
  if (st.tone === 'error' && st.problem) return st.problem; // the person's own word, not a bare "Error"
  if (st.tone === 'off') return st.text;
  return STATUS_WORD[st.tone];
}

function statusMark(st: JobStatus): HTMLElement {
  return st.tone === 'wait' ? h('span', { class: 'job-wait-dot', 'aria-hidden': 'true' }) : statusDot(st.tone);
}

export function createJobSwitcher(shell: Shell) {
  const { store } = shell;
  let projectId: string | null = null;
  const changed = memo();
  let dropClose: (() => void) | null = null;
  let dropList: HTMLElement | null = null;

  const head = h('div', { class: 'jobs-head' });
  const bar = h('div', { class: 'jobs-bar' });
  const el = h('section', { class: 'jobs', 'aria-label': 'Jobs', hidden: true }, head, bar);

  /** One job: the main button (select / open switcher) and its own "⋯" menu. */
  function row(st: JobStatus, opts: { active: boolean; inBar: boolean }): HTMLElement {
    const { job } = st;
    const more = h(
      'button',
      {
        type: 'button',
        class: 'job-more icon-btn',
        'aria-label': `More for ${job.name}`,
        'aria-haspopup': 'menu',
        title: 'Rename, edit, move or delete this job, or change how its lead works (plan first, just go, only when asked)',
        onclick: (ev: MouseEvent) => {
          ev.stopPropagation();
          openJobMenu(shell, ev.currentTarget as HTMLElement, job);
        },
      },
      icon('dots', 16),
    );
    const label = `${jobRoomCode(job)} ${job.name}. Lead ${st.leadName}, ${st.leadModelLabel}. ${st.text}${st.cost ? `. Spent ${fmtUsd(st.cost)}` : ''}`;
    const main = h(
      'button',
      {
        type: 'button',
        class: 'job-main',
        'data-job': job.id,
        'aria-current': opts.active ? 'true' : undefined,
        'aria-haspopup': opts.inBar ? 'dialog' : undefined,
        'aria-label': opts.inBar ? `Current job: ${label}. Switch job` : label,
        title: opts.inBar ? 'Switch job' : `${job.name} — ${st.text}`,
        onclick: () => {
          if (opts.inBar) return toggleDrop();
          dropClose?.();
          shell.selectJob(job.projectId, job.id, { focus: true });
        },
      },
      codeBadge(job),
      h(
        'span',
        { class: 'job-text' },
        h('span', { class: 'job-name' }, job.name),
        h(
          'span',
          { class: 'job-lead' },
          h('span', { class: 'job-lead-name' }, st.leadName),
          h('span', { class: 'model-chip', style: { '--vc': vendorColor(st.vendor) } }, h('span', { class: 'vendor-dot', style: { background: vendorColor(st.vendor) } }), st.leadModelLabel),
        ),
      ),
      h(
        'span',
        { class: 'job-side' },
        h('span', { class: ['job-status', `tone-${st.tone}`] }, statusMark(st), statusWord(st)),
        st.cost > 0 ? h('span', { class: 'job-cost num', title: `Spent: ${fmtUsd(st.cost)}` }, fmtUsd(st.cost)) : null,
      ),
      opts.inBar ? icon('chevronDown', 16, 'job-chev') : null,
    );
    const r = h(
      'div',
      { class: ['job-row', opts.active && 'is-on', opts.inBar && 'is-bar', st.tone === 'wait' && 'is-waiting'], role: opts.inBar ? undefined : 'listitem', style: { '--kc': kindInfo(job.kind).accent } },
      main,
      more,
    );
    r.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      openJobMenu(shell, more, job);
    });
    return r;
  }

  function renderDrop() {
    const project = store.project(projectId);
    if (!dropList || !project) return;
    const jobs = store.jobsOf(project.id);
    const active = shell.jobs.active(project.id);
    const floors = projectFloors(project);
    const nodes: HTMLElement[] = [];
    for (let f = floors - 1; f >= 0; f--) {
      const here = jobs.filter((j) => j.room.floor === f).map((j) => jobStatus(shell, j));
      const busy = here.reduce((n, s) => n + s.busy, 0);
      const waiting = here.reduce((n, s) => n + s.waiting, 0);
      nodes.push(
        h(
          'div',
          { class: 'jobs-floor', role: 'presentation' },
          h('span', null, f === 0 ? 'Ground floor' : floorName(f)),
          waiting ? h('span', { class: 'jobs-floor-wait' }, `${waiting} waiting`) : busy ? h('span', { class: 'jobs-floor-busy' }, `${busy} working`) : !here.length ? h('span', { class: 'jobs-floor-free' }, 'empty') : null,
        ),
      );
      for (const st of here) nodes.push(row(st, { active: st.job.id === active?.id, inBar: false }));
    }
    // Live status updates re-render the list; keep keyboard focus on the same job.
    const focused = dropList.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.job : undefined;
    setChildren(dropList, ...nodes);
    if (focused) dropList.querySelector<HTMLElement>(`.job-main[data-job="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  }

  function toggleDrop() {
    if (dropClose) return dropClose();
    const project = store.project(projectId);
    if (!project) return;
    dropList = h('div', { class: 'jobs-list', role: 'list', 'aria-label': `Jobs in ${project.name}` });
    const pop = h(
      'div',
      { class: 'jobs-drop glass-strong', role: 'dialog', 'aria-label': 'Switch job', style: { width: `${el.offsetWidth - 8}px` } },
      dropList,
      h(
        'footer',
        { class: 'jobs-drop-foot' },
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-soft btn-sm',
            onclick: () => {
              dropClose?.();
              shell.openNewJob(project.id);
            },
          },
          icon('plus', 14),
          'New job',
        ),
        h('span', { class: 'jobs-drop-hint' }, kbd('↑', '↓'), ' move ', kbd('Enter'), ' open'),
      ),
    );
    pop.addEventListener('keydown', (ev) => {
      if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
      const rows = [...pop.querySelectorAll<HTMLButtonElement>('.job-main')];
      const i = rows.indexOf(document.activeElement as HTMLButtonElement);
      ev.preventDefault();
      rows[(i + (ev.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length]?.focus();
    });
    renderDrop();
    const anchor = bar.querySelector<HTMLElement>('.job-main') ?? bar;
    const fit = fitPlacement(anchor, 260, 560);
    pop.style.maxHeight = `${fit.maxHeight}px`;
    dropClose = openPopover(shell.root, shell.layers, anchor, pop, {
      id: 'jobs-drop',
      placement: fit.placement,
      align: 'start',
      onClose: () => {
        dropClose = null;
        dropList = null;
        el.classList.remove('is-open');
      },
    });
    // Line the dropdown up with the bar (the anchor is the row button inside it).
    pop.style.left = `${el.getBoundingClientRect().left + 4}px`;
    el.classList.add('is-open');
    (pop.querySelector<HTMLElement>('.job-row.is-on .job-main') ?? pop.querySelector<HTMLElement>('.job-main'))?.focus({ preventScroll: true });
    pop.querySelector('.job-row.is-on')?.scrollIntoView({ block: 'nearest' });
  }

  function render(force = false) {
    const project = store.project(projectId);
    const jobs = projectId ? store.jobsOf(projectId) : [];
    if (!project || !jobs.length) {
      el.hidden = true;
      changed(null);
      dropClose?.();
      return;
    }
    const active = shell.jobs.active(project.id) ?? jobs[0];
    const statuses = jobs.map((j) => jobStatus(shell, j));
    const sig = [
      project.id,
      projectFloors(project),
      active.id,
      statuses.map((s) => [s.job, s.tone, s.busy, s.waiting, s.cost.toFixed(2), s.leadName, s.leadModelLabel, s.vendor, s.runActive, s.text]),
    ];
    if (!changed(sig) && !force) return;
    el.hidden = false;

    const cur = statuses.find((s) => s.job.id === active.id) ?? statuses[0];
    const others = statuses.filter((s) => s.job.id !== cur.job.id);
    const waitingElsewhere = others.reduce((n, s) => n + s.waiting, 0);
    const busyElsewhere = others.reduce((n, s) => n + s.busy, 0);

    setChildren(head,
      h('span', { class: 'jobs-title' }, 'Jobs', h('span', { class: 'jobs-count num' }, String(jobs.length))),
      others.length
        ? h(
            'button',
            {
              type: 'button',
              class: ['jobs-peek', waitingElsewhere > 0 && 'is-amber'],
              onclick: () => toggleDrop(),
              title: others.map((s) => `${jobRoomCode(s.job)} ${s.job.name}: ${s.text}`).join('\n'),
              'aria-label': `${others.length} other job${others.length > 1 ? 's' : ''}${waitingElsewhere ? `, ${waitingElsewhere} waiting for you` : busyElsewhere ? `, ${busyElsewhere} working` : ''}. Switch job`,
            },
            others.slice(0, 6).map((s) => statusMark(s)),
            h('span', null, waitingElsewhere ? `${waitingElsewhere} need${waitingElsewhere > 1 ? '' : 's'} you` : busyElsewhere ? `${busyElsewhere} working` : `${others.length} more`),
          )
        : null,
      h('span', { class: 'jobs-spacer' }),
      h(
        'button',
        { type: 'button', class: 'btn btn-ghost btn-sm jobs-new', onclick: () => shell.openNewJob(project.id), title: 'Start a separate line of work in its own room' },
        icon('plus', 14),
        'New job',
      ),
    );
    setChildren(bar, row(cur, { active: true, inBar: true }));
    if (dropList) renderDrop();
  }

  return {
    el,
    show(pid: string | null) {
      if (pid !== projectId) {
        projectId = pid;
        dropClose?.();
        render(true);
      } else render();
    },
    render: () => render(),
    /** Open the switcher (keyboard: J). */
    open() {
      if (!el.hidden && !dropClose) toggleDrop();
    },
  };
}
