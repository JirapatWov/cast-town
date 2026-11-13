// Contextual bottom action bar: the two or three things you most likely want to do right here.
import { LANDMARKS } from '../../../shared/city-layout';
import { TERM_TOWN } from '../../../shared/terminal-protocol';
import { h, memo, setChildren } from './dom';
import { icon } from './icons';
import { kindInfo } from './jobs';
import { openMenu } from './menu';
import type { Shell } from './shell';
import { houseTermTarget } from './terminal';
import { terminalOffered } from './terminal-gate';
import { onSession } from '../net/session';
import { viewerFolder } from './changes-tab';
import { openFolder } from './file-viewer';
import { isNarrow } from './touch';
import { kbd } from './widgets';
import { noHousesItem, townFull, townFullLabel } from './town-loading';

export function createActionBar(shell: Shell) {
  const { bus, store } = shell;
  const el = h('nav', { class: 'actionbar glass', 'aria-label': 'Actions' });
  const changed = memo();

  /** The lead of the job the panels act on: the person you ask (they decide alone, with helpers or with a team). */
  function leadOf(projectId: string) {
    const job = shell.jobs.active(projectId);
    const people = job ? store.agentsOfJob(projectId, job.id) : store.agentsOf(projectId);
    return { job, lead: people.find((a) => a.roleId === 'assistant' && a.kind !== 'subagent') ?? people.find((a) => a.kind === 'resident') };
  }

  function ask(projectId: string) {
    const { job, lead } = leadOf(projectId);
    if (lead) return shell.openAgent(lead.id, { focusComposer: true });
    shell.toast('info', `The ${kindInfo(job?.kind).lead} hasn't moved into this room yet — try again in a moment.`);
  }

  // `short`: the caption under the icon on phones (touch never shows a title tooltip, so the icons need words)
  const action = (label: string, iconName: string, onclick: (ev: MouseEvent) => void, key?: string, extra?: { primary?: boolean; menu?: boolean; short?: string }) =>
    h(
      'button',
      { type: 'button', class: ['ab-btn', extra?.primary && 'is-primary'], onclick, 'aria-haspopup': extra?.menu ? 'menu' : undefined, 'aria-label': label, title: label },
      icon(iconName, 16),
      h('span', { class: 'ab-label' }, label),
      h('span', { class: 'ab-short', 'aria-hidden': 'true' }, extra?.short ?? label),
      extra?.menu ? icon('chevronUp', 13, 'ab-chev') : null,
      key ? kbd(key) : null,
    );

  function openFlyTo(anchor: HTMLElement) {
    const projects = store.state.city.projects;
    openMenu(
      shell.root,
      shell.layers,
      anchor,
      [
        {
          title: 'Go into a house',
          items: projects.length
            ? projects.map((p, i) => ({
                label: p.name,
                icon: 'home',
                hint: i < 9 ? kbd(String(i + 1)) : undefined,
                // into the house, not just near it: a house can stand behind taller buildings
                onSelect: () => shell.enterProject(p.id),
              }))
            : [noHousesItem(store.state)],
        },
        {
          title: 'Places',
          items: LANDMARKS.map((l) => ({
            label: l.name,
            icon: l.kind === 'agency' ? 'agency' : 'pin',
            onSelect: () => bus.emit('nav:flyto', { landmarkId: l.id }),
          })),
        },
      ],
      { id: 'flyto-menu', placement: 'above', align: 'center', minWidth: 220 },
    );
  }

  function render() {
    const { view, projectId } = shell.view;
    const project = store.project(projectId);
    const leadName = project ? (() => {
      const { job, lead } = leadOf(project.id);
      return lead?.name ?? kindInfo(job?.kind).lead;
    })() : '';
    const term = terminalOffered(); // off when the owner turned the terminal off on this server
    const full = townFull(store.state);
    if (!changed([view, project?.id, project?.name, leadName, store.state.city.projects.map((p) => [p.id, p.name]), term, full?.lots])) return;
    if (view === 'house' && project) {
      setChildren(el,
        // goal first: tell the lead what you want; they pick how (alone, helpers, a team)
        action(`Ask the ${leadName}`, 'chat', () => ask(project.id), undefined, { primary: true, short: 'Ask' }),
        action('Run workflow', 'workflow', () => shell.openWorkflow(project.id), 'W', { short: 'Workflow' }),
        action('Watch TV', 'tv', () => shell.openDiff(project.id), 'T', { short: 'TV' }),
        // the house's files, one tap away (finding #49: they hid behind an icon in the Changes tab)
        action('Files', 'folder', () => openFolder(shell, viewerFolder(shell, project.id))),
        term ? action('Terminal', 'terminal', () => shell.openTerminal(houseTermTarget(shell, project.id)), 'Ctrl `') : null,
        h('span', { class: 'ab-sep' }),
        action('Exit', 'exit', () => bus.emit('nav:city', {}), 'Esc'),
      );
    } else if (view === 'drive') {
      setChildren(el,
        h('span', { class: 'ab-hint' }, kbd('W', 'A', 'S', 'D'), ' steer', kbd('Space'), ' brake', kbd('E'), ' enter a house'),
        h('span', { class: 'ab-sep' }),
        action('Leave car', 'exit', () => bus.emit('nav:city', {}), 'Esc'),
      );
    } else {
      const fly = action('Fly to', 'pin', (ev) => openFlyTo(ev.currentTarget as HTMLElement), undefined, { menu: true });
      setChildren(el,
        // a full town says so (it opens the dialog with the ways to make room) instead of promising a lot
        full
          ? action(townFullLabel(full), 'home', () => shell.openPlacement(), undefined, { short: 'Town full' })
          : action('Place project', 'folderPlus', () => shell.openPlacement(), undefined, { primary: true, short: 'Place' }),
        action('Drive', 'car', () => bus.emit('nav:drive', {}), 'D'),
        fly,
        term ? action('Terminal', 'terminal', () => shell.openTerminal(TERM_TOWN), 'Ctrl `') : null,
      );
    }
    fitSoon();
  }

  // Desktop: the bar sits centred in the room the panel leaves. When it doesn't fit there (the panel dragged wide, a
  // small window), the key hints go first (is-snug), then the words — icons only, as with the terminal open
  // (is-compact). Each button keeps its name as tooltip and aria-label. Phones have their own compact bar.
  const fit = () => {
    el.classList.remove('is-snug', 'is-compact');
    if (isNarrow() || shell.root.classList.contains('has-term') || !el.childElementCount) return;
    const room = roomLeft();
    if (el.scrollWidth <= room) return;
    el.classList.add('is-snug');
    if (el.scrollWidth <= room) return;
    el.classList.add('is-compact');
  };
  /** How wide the bar may be: the width left of an open panel (or the whole window), less a gap on each side. */
  const roomLeft = () => {
    const panel = shell.root.querySelector<HTMLElement>('.sidepanel');
    watchPanel(panel);
    const open = !!panel && !panel.hidden && shell.root.classList.contains('has-panel');
    const gap = parseFloat(getComputedStyle(el).bottom) || 12; // the bar's own gap to the edge of the window
    return (open ? panel!.offsetLeft : shell.root.clientWidth) - gap * 2;
  };
  let frame = 0;
  const fitSoon = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      fit();
    });
  };
  const resized = typeof ResizeObserver === 'function' ? new ResizeObserver(fitSoon) : null;
  resized?.observe(shell.root); // the window
  let watched: HTMLElement | null = null;
  const watchPanel = (panel: HTMLElement | null) => {
    if (!panel || panel === watched || !resized) return;
    watched = panel;
    resized.observe(panel); // dragged wider or narrower (panel-resize.ts), opened, closed
  };
  new MutationObserver(fitSoon).observe(shell.root, { attributes: true, attributeFilter: ['class'] }); // has-panel, has-term

  onSession(() => render());
  return { el, render };
}
