// Elevator-style floor switcher shown over the house: one lit button per floor (top floor first), a busy count and
// an amber dot per floor (red when a job there hit an error), and "+" to build another floor. Emits 'floor:show'; the lit button follows 'floor:changed'.
import { MAX_FLOORS } from '../../../shared/house-plan';
import { h, isTypingTarget, memo, setChildren } from './dom';
import { icon } from './icons';
import { floorName, floorStatuses, jobRoomCode } from './jobs';
import type { Shell } from './shell';

export function createFloorSwitcher(shell: Shell) {
  const { store, bus } = shell;
  const current = new Map<string, number>(); // projectId → floor shown in 3D
  const reportedAt = new Map<string, number>(); // when the house last reported a floor for that project
  let pending: number | null = null;
  let adding = false;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  const changed = memo();

  const display = h('div', { class: 'fs-display', 'aria-hidden': 'true' });
  const buttons = h('div', { class: 'fs-buttons' });
  const el = h('nav', { class: 'floor-switch glass', 'aria-label': 'Floors', hidden: true }, display, buttons);

  const pid = () => (shell.view.view === 'house' ? shell.view.projectId : null);
  const floorOf = (projectId: string) => current.get(projectId) ?? 0;

  function show(floor: number) {
    const p = pid();
    if (!p) return;
    if (floor === floorOf(p) && pending === null) {
      bus.emit('floor:show', { floor }); // re-frame
      return;
    }
    pending = floor;
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => {
      pending = null;
      render(true);
    }, 4000);
    bus.emit('floor:show', { floor });
    render(true);
  }

  async function add() {
    const p = pid();
    if (!p || adding) return;
    adding = true;
    render(true);
    const floor = await shell.addFloor(p);
    adding = false;
    render(true);
    if (floor !== null) show(floor);
  }

  function render(force = false) {
    const p = pid();
    const project = store.project(p);
    // Hidden outside the house, in focus mode, and on servers that don't know about floors.
    if (!project || shell.focusMode || typeof project.floors !== 'number') {
      el.hidden = true;
      changed(null);
      return;
    }
    const floors = floorStatuses(shell, project.id);
    const cur = floorOf(project.id);
    const sig = [project.id, cur, pending, adding, floors.map((f) => [f.busy, f.waiting, f.errors, f.jobs.map((j) => [j.id, j.name, j.room.slot])])];
    if (!changed(sig) && !force) return;
    el.hidden = false;
    const shown = pending ?? cur;
    setChildren(display,
      h('span', { class: ['fs-arrow', pending !== null && pending > cur && 'is-up', pending !== null && pending < cur && 'is-down'] }, icon(pending !== null && pending < cur ? 'chevronDown' : 'chevronUp', 11)),
      h('span', { class: 'fs-digit num' }, String(shown + 1)),
    );
    const canAdd = floors.length < MAX_FLOORS;
    const btns: HTMLElement[] = [
      h(
        'button',
        {
          type: 'button',
          class: 'fs-btn fs-add',
          disabled: !canAdd || adding,
          'aria-label': canAdd ? `Add ${floorName(floors.length)}` : `This house has the most floors (${MAX_FLOORS})`,
          title: canAdd ? `Add ${floorName(floors.length)} (4 rooms)` : `${MAX_FLOORS} floors is the most`,
          onclick: () => void add(),
        },
        adding ? h('span', { class: 'spinner spinner-sm' }) : icon('plus', 15),
      ),
    ];
    for (let i = floors.length - 1; i >= 0; i--) {
      const f = floors[i];
      const on = f.floor === cur;
      const jobsText = f.jobs.length ? f.jobs.map((j) => `${jobRoomCode(j)} ${j.name}`).join(', ') : 'no jobs yet';
      const errText = f.errors ? `, ${f.errors === 1 ? 'a job' : `${f.errors} jobs`} hit an error` : '';
      const label = `${floorName(f.floor)}${on ? ' (showing)' : ''}: ${jobsText}${f.busy ? `, ${f.busy} working` : ''}${f.waiting ? `, ${f.waiting} waiting for you` : ''}${errText}`;
      btns.push(
        h(
          'button',
          {
            type: 'button',
            class: ['fs-btn', on && 'is-on', pending === f.floor && 'is-pending', f.waiting > 0 && 'is-waiting', f.errors > 0 && 'is-error', !f.jobs.length && 'is-empty'],
            'aria-pressed': String(on),
            'aria-label': label,
            title: label,
            onclick: () => show(f.floor),
          },
          h('span', { class: 'fs-num num' }, String(f.floor + 1)),
          f.waiting
            ? h('span', { class: 'fs-wait', 'aria-hidden': 'true' })
            : f.errors
              ? h('span', { class: 'fs-err', 'aria-hidden': 'true' })
              : f.busy
                ? h('span', { class: 'fs-busy num', 'aria-hidden': 'true' }, String(f.busy))
                : null,
        ),
      );
    }
    setChildren(buttons, ...btns);
  }

  // PageUp / PageDown ride the elevator while in a house (not while typing or in a dialog).
  window.addEventListener('keydown', (ev) => {
    if (ev.key !== 'PageUp' && ev.key !== 'PageDown') return;
    if (el.hidden || ev.metaKey || ev.ctrlKey || ev.altKey || isTypingTarget(ev.target) || shell.layers.hasModal) return;
    if (ev.target instanceof Element && ev.target.closest('.term-dock, .transcript, .modal, .wf-scroll')) return;
    const p = pid();
    const project = store.project(p);
    if (!p || !project) return;
    const next = (pending ?? floorOf(p)) + (ev.key === 'PageUp' ? 1 : -1);
    if (next < 0 || next >= Math.max(1, project.floors)) return;
    ev.preventDefault();
    show(next);
  });

  return {
    el,
    render: () => render(),
    onFloorChanged(projectId: string, floor: number) {
      current.set(projectId, floor);
      reportedAt.set(projectId, performance.now());
      if (pending === floor || projectId !== pid()) {
        pending = null;
        if (pendingTimer) clearTimeout(pendingTimer);
      }
      render(true);
    },
    /** A fresh entry into a house starts on the ground floor until the house reports otherwise ('floor:changed'). */
    onEnter(projectId: string) {
      // The house may already have reported the floor it opened on (it can emit before 'view:changed').
      if (performance.now() - (reportedAt.get(projectId) ?? -1e9) > 5000) current.set(projectId, 0);
      pending = null;
      render(true);
    },
    floorOf,
  };
}
