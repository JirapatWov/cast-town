// The Town board: every house as a card — its people, what waits for you, the same actions as the 3D town. A
// first-class view (keyboard and screen-reader friendly, quick on slow machines), not only a pause screen: the top
// bar switches Board / 3D, and without WebGL it is the whole town.
import { needsAccount } from './agents-health';
import { gitTarget, viewerFolder } from './changes-tab';
import { openFolder } from './file-viewer';
import { h, setChildren } from './dom';
import { agentTone } from './format';
import { pathLine } from './path-line';
import { icon } from './icons';
import { buildingIllustration } from './illustrations';
import { isRunActive, runsOf } from './runs';
import { openHouseMenu } from './house-menu';
import { houseJobs } from './board-jobs';
import { createBoardUnread } from './board-unread';
import { waitingSummary } from './board-waiting';
import type { Shell } from './shell';
import { houseTermTarget } from './terminal';
import { terminalOffered } from './terminal-gate';
import { pendingPlans } from './plans';
import { TOWN_FILES_SHARE, threeD } from './view-mode';
import { housesLoading } from './town-loading';

export function createFocusView(shell: Shell) {
  const { store } = shell;
  const grid = h('div', { class: 'fv-grid' });
  const lead = h('p', { class: 'muted fv-lead' });
  const asks = h('div', { class: 'fv-waiting-slot' });
  const el = h(
    'section',
    { class: 'focus-view', hidden: true, 'aria-labelledby': 'fv-title' },
    h('header', { class: 'fv-head' }, h('h2', { id: 'fv-title' }, 'Town board'), lead),
    asks,
    grid,
  );
  let frame = 0;
  const later = () => {
    if (!frame) frame = requestAnimationFrame(() => ((frame = 0), render()));
  };
  const unread = createBoardUnread(shell, later);
  // the house you are in goes first: the board follows walking in and out (no store change says so)
  shell.bus.on('view:changed', later);
  // "New reply · 3m ago" ages while nothing else changes
  setInterval(() => {
    if (!el.hidden && unread.size && !document.hidden) later();
  }, 60_000);

  function openChat(agentId: string, projectId: string) {
    const a = store.state.agents[agentId];
    if (!a) return shell.openPanel('chat', projectId);
    unread.clear(a.projectId, a.jobId);
    shell.openAgent(agentId);
  }

  /** What the board is right now: the whole town (no 3D here), a 3D town on its way, or a choice. */
  function leadText(): string {
    const st = threeD.state;
    if (st === 'unavailable') return '3D isn’t available in this browser — the board has everything.';
    // how far: a number while files arrive, words for the step with nothing to count (#67: no frozen percentage)
    const pct = Math.round(threeD.progress * 100);
    const far = !threeD.working ? `(${pct}%)` : threeD.progress >= TOWN_FILES_SHARE ? '(getting the graphics ready)' : `(${pct}%, still working)`;
    // a 3D start (or someone who asked for 3D) gets the town when it is ready; the board can be kept instead
    if (st === 'loading' && threeD.wanted) return `Every house, its people and what waits for you. The 3D town is loading ${far} and opens when it’s ready — pick Board in the top bar to stay here.`;
    if (st === 'loading') return `Every house, its people and what waits for you. The 3D town is loading ${far}.`;
    return 'Every house, its people and what waits for you. Switch to the 3D town in the top bar any time.';
  }

  function render() {
    if (el.hidden) return;
    unread.sync();
    lead.textContent = leadText();
    const s = store.state;
    setChildren(asks, waitingSummary(shell, openChat));
    // only the house you are in moves (to the top); the others keep city order, so cards never jump as work changes
    const here = shell.view.view === 'house' ? s.city.projects.find((p) => p.id === shell.view.projectId) : undefined;
    const projects = here ? [here, ...s.city.projects.filter((p) => p !== here)] : s.city.projects;
    const cards = projects.map((p) => {
      const isHere = p === here;
      const people = store.agentsOf(p.id);
      const waiting = Object.values(s.approvals).filter((a) => a.projectId === p.id).length + pendingPlans(s, { projectId: p.id }).length;
      const fresh = unread.count(p.id);
      const busy = people.filter((a) => agentTone(a) === 'work').length;
      const run = runsOf(s, p.id).find(isRunActive);
      const lot = s.city.lots.find((l) => l.id === p.lotId);
      const target = gitTarget(shell, p.id);
      const files = s.git[target.key]?.files.length ?? 0; // what Changes opens: the job's own copy when it has one
      const changesOf = target.job ? `${target.job.name}’s own copy` : 'the house folder';
      const art = h('div', { class: 'fv-art', html: buildingIllustration(p.style) });
      art.querySelector('svg')?.setAttribute('preserveAspectRatio', 'xMidYMid slice');
      return h(
        'article',
        { class: ['fv-card', 'glass', waiting > 0 && 'is-waiting', isHere && 'is-here'], 'aria-current': isHere ? 'location' : undefined },
        art,
        h(
          'div',
          { class: 'fv-body' },
          h(
            'div',
            { class: 'fv-title' },
            // the name and its folder together: on a phone they sit beside the thumbnail as one block
            h('div', { class: 'fv-name' }, h('h3', null, p.name), pathLine('p', 'fv-path', p.path, s.hello?.home, 44)),
            h('button', { type: 'button', class: 'icon-btn fv-menu', 'aria-label': `${p.name}: browse files, rename, move or remove`, title: 'Browse files, rename, move or remove this house', 'aria-haspopup': 'menu', onclick: (ev: MouseEvent) => openHouseMenu(shell, ev.currentTarget as HTMLElement, p) }, icon('dots', 16)),
            isHere
              ? h('button', { type: 'button', class: 'btn btn-primary btn-sm fv-enter', onclick: () => shell.openPanel('chat', p.id), 'aria-label': `Open chat in ${p.name}` }, icon('chat', 14), 'Open chat')
              : h('button', { type: 'button', class: 'btn btn-primary btn-sm fv-enter', onclick: () => shell.enterProject(p.id, { focusPanel: true }), 'aria-label': `Enter ${p.name}` }, 'Enter', icon('chevronRight', 14)),
          ),
          h(
            'p',
            { class: ['fv-status', !isHere && !waiting && !busy && !run && !fresh && 'is-quiet'] },
            isHere ? h('span', { class: 'fv-pill is-here' }, icon('pin', 12), 'You’re here') : null,
            waiting ? h('span', { class: 'fv-pill is-amber' }, icon('hand', 12), `${waiting} waiting for you`) : null,
            fresh ? h('span', { class: 'fv-pill is-new' }, h('span', { class: 'fv-new-dot', 'aria-hidden': 'true' }), `${fresh} new ${fresh === 1 ? 'reply' : 'replies'}`) : null,
            busy ? h('span', { class: 'fv-pill is-work' }, `${busy} working`) : null,
            run ? h('span', { class: 'fv-pill is-run', title: run.workflowName }, icon('workflow', 12), h('span', { class: 'fv-pill-text' }, run.workflowName)) : null,
            !isHere && !waiting && !busy && !run && !fresh ? h('span', { class: 'muted small fv-district' }, lot ? lot.district : 'Quiet') : null,
          ),
          houseJobs(shell, p, unread),
          h(
            'div',
            { class: 'fv-actions' },
            h('button', { type: 'button', class: 'btn btn-soft btn-sm', onclick: () => shell.openWorkflow(p.id) }, icon('workflow', 14), 'Workflow'),
            h('button', { type: 'button', class: 'btn btn-soft btn-sm', onclick: () => shell.openDiff(p.id), title: `What changed in ${changesOf}` }, icon('tv', 14), files ? `Changes (${files})` : 'Changes', target.job ? h('span', { class: 'muted small' }, `· ${target.job.name}`) : null),
            // the house's files, as the 3D action bar's Files (finding #49: reading what people wrote is one click away)
            h('button', { type: 'button', class: 'btn btn-soft btn-sm', 'aria-label': `Files in ${p.name}`, onclick: () => openFolder(shell, viewerFolder(shell, p.id)) }, icon('folder', 14), 'Files'),
            // the 3D action bar's Terminal is gone on the board; a phone has no Ctrl+` either (none when the owner turned it off)
            terminalOffered() ? h('button', { type: 'button', class: 'btn btn-soft btn-sm', 'aria-label': `Terminal in ${p.name}`, onclick: () => shell.openTerminal(houseTermTarget(shell, p.id)) }, icon('terminal', 14), 'Terminal') : null,
          ),
        ),
      );
    });
    // the houses are on their way (before the first snapshot): say so, not "place one" or "connect an account" — the
    // accounts and the free lots come with the snapshot too
    const loading = housesLoading(s);
    if (loading) {
      grid.setAttribute('aria-busy', 'true');
      setChildren(grid,
        h('div', { class: 'fv-card fv-add is-loading', role: 'status' },
          h('span', { class: 'spinner', 'aria-hidden': 'true' }),
          h('span', null, loading.title),
          h('span', { class: 'muted small' }, loading.detail),
        ),
      );
      return;
    }
    grid.removeAttribute('aria-busy');
    cards.push(
      h(
        'button',
        { type: 'button', class: 'fv-card fv-add', onclick: () => shell.openPlacement() },
        icon('folderPlus', 22),
        h('span', null, 'Place project'),
        h('span', { class: 'muted small' }, 'Turn any folder into a house'),
      ),
    );
    // no AI account yet: nobody can work, so connecting one comes first
    if (needsAccount(s)) {
      cards.unshift(
        h(
          'button',
          { type: 'button', class: 'fv-card fv-add is-setup', onclick: () => shell.openProviders() },
          icon('key', 22),
          h('span', null, 'Connect an AI account'),
          h('span', { class: 'muted small' }, 'Nobody can work until one is connected'),
        ),
      );
    }
    setChildren(grid, ...cards);
  }

  return {
    el,
    render,
    setOn(on: boolean) {
      el.hidden = !on;
      if (on) render();
    },
  };
}
