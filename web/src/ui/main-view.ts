// The page's <main>: a heading that says where you are (one h1 per view, read by screen readers and focused when a
// view change would otherwise drop focus to <body>), the Town board, and — in the 3D town — a keyboard way to the
// houses. The 3D canvas can't be tabbed through, so after the top bar the first Tab stop in the town is this list:
// switch to the board, or enter a house. It stays out of sight until it has focus, so the town's picture is unchanged
// for mouse users.
import { needsAccount } from './agents-health';
import { h, memo, setChildren } from './dom';
import { focusRegion } from './focus';
import { agentTone } from './format';
import { icon } from './icons';
import { pendingPlans } from './plans';
import type { Shell } from './shell';
import { threeD } from './view-mode';

/** "2 waiting for you, 1 working" — or "quiet". */
export function houseStatusText(waiting: number, working: number): string {
  const parts = [waiting ? `${waiting} waiting for you` : '', working ? `${working} working` : ''].filter(Boolean);
  return parts.length ? parts.join(', ') : 'quiet';
}

export function createMainView(shell: Shell, board: HTMLElement) {
  const { store } = shell;
  const heading = h('h1', { class: 'sr-only', id: 'cast-h1', tabindex: '-1' });
  const list = h('ul', { class: 'ch-list' });
  const houses = h(
    'nav',
    { class: 'city-houses glass-strong', 'aria-label': 'Houses' },
    h('p', { class: 'ch-title' }, 'Houses in town'),
    list,
  );
  const el = h('main', { class: 'cast-main', 'aria-labelledby': 'cast-h1' }, heading, houses, board);
  const changed = memo();

  function headingText(): string {
    const { view, projectId } = shell.view;
    const project = store.project(projectId);
    if (view === 'house' && project) {
      const job = store.activeJob(project.id);
      return job && job.id !== 'main' ? `${project.name} — ${job.name}` : project.name;
    }
    if (view === 'drive') return 'Driving through the town';
    return shell.focusMode ? 'Town board' : 'The town (3D)';
  }

  function render() {
    heading.textContent = headingText();
    const { view } = shell.view;
    const show = view === 'city' && !shell.focusMode;
    houses.hidden = !show;
    if (!show) return;
    const s = store.state;
    const rows = s.city.projects.map((p) => {
      const waiting = Object.values(s.approvals).filter((a) => a.projectId === p.id).length + pendingPlans(s, { projectId: p.id }).length;
      const working = store.agentsOf(p.id).filter((a) => agentTone(a) === 'work').length;
      return { id: p.id, name: p.name, status: houseStatusText(waiting, working) };
    });
    const connect = needsAccount(s);
    if (!changed([rows, threeD.state, connect])) return;
    setChildren(list,
      // no AI account yet: nobody can work, so connecting one comes first
      connect
        ? h('li', null, h('button', { type: 'button', class: 'ch-item', 'data-focus-key': 'ch:connect', onclick: () => shell.openProviders() }, icon('key', 15), h('span', null, 'Connect an AI account')))
        : null,
      h('li', null,
        h('button', { type: 'button', class: 'ch-item ch-board', 'data-focus-key': 'ch:board', onclick: () => shell.setFocusMode(true) },
          icon('board', 15),
          h('span', null, 'Use the board — every house as a list'),
        ),
      ),
      rows.map((r) =>
        h('li', null,
          h('button', { type: 'button', class: 'ch-item', 'data-focus-key': `ch:${r.id}`, 'aria-label': `Enter ${r.name}, ${r.status}`, onclick: () => shell.enterProject(r.id, { focusPanel: true }) },
            icon('home', 15),
            h('span', { class: 'ch-name' }, `Enter ${r.name}`),
            h('span', { class: 'ch-status' }, r.status),
          ),
        ),
      ),
      rows.length
        ? null
        : h('li', null, h('button', { type: 'button', class: 'ch-item', onclick: () => shell.openPlacement() }, icon('folderPlus', 15), h('span', null, 'Place your first project'))),
    );
  }

  return {
    el,
    render,
    /** Where focus goes when the view changed under it: the new view's heading. */
    focusHeading() {
      focusRegion(heading);
    },
  };
}
