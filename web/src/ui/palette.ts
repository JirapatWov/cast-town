// Cmd/Ctrl+K command palette: fuzzy search over projects, people, workflows and actions. "Open file…" turns it into
// a file finder over the current house's folder (find_files), opening the pick in the built-in viewer.
import { findFiles, type FolderRef } from '../net/files';
import { viewerFolder } from './changes-tab';
import { h, setChildren } from './dom';
import { markFocus, restoreFocus, type FocusMark } from './focus';
import { baseName, fileKind, kindIcon } from './file-kinds';
import { matchPaths } from './file-paths';
import { openFile, openFolder } from './file-viewer';
import { vIcon } from './viewer-icons';
import { blockOpts } from './agents-health';
import { agentBlocked, agentStatusText, agentTone } from './format';
import { fuzzy, highlight } from './fuzzy';
import { icon } from './icons';
import { focusFirst, trapFocus } from './layers';
import type { Shell } from './shell';
import { houseTermTarget } from './terminal';
import { TERMINAL_OFF_TEXT, terminalOffered } from './terminal-gate';
import { openSettings } from './settings';
import { agentAvatar, kbd } from './widgets';
import type { Quality } from '../core/types';
import { codeBadge } from './job-switcher';
import { jobRoomCode, jobStatus, kindInfo } from './jobs';
import { TERM_TOWN } from '../../../shared/terminal-protocol';
import { timeOfDayCommands } from './time-menu';
import { helpCommands } from './help';
import { houseCommands } from './house-menu';
import { waitingCount } from './plans';
import { setSingleKeys, singleKeysEnabled } from './shortcuts';
import { threeD } from './view-mode';
import { inboxScope } from './last-house';

type Group = 'Projects' | 'Jobs' | 'People' | 'Workflows' | 'Actions';
const GROUP_ORDER: Group[] = ['Actions', 'Jobs', 'Projects', 'People', 'Workflows'];

interface Command {
  id: string;
  group: Group;
  title: string;
  subtitle?: string;
  keywords?: string;
  leading: () => Node;
  shortcut?: string[];
  run(): void;
  boost?: number;
}

/** Context the commands need from the palette itself. */
interface PaletteHooks {
  openFiles(folder: FolderRef, label: string): void;
}

function buildCommands(shell: Shell, hooks: PaletteHooks): Command[] {
  const { store, bus } = shell;
  const s = store.state;
  const here = shell.view;
  const ctxPid = shell.contextProjectId();
  const ctxProject = store.project(ctxPid);
  const cmds: Command[] = [];
  const ic = (name: string) => () => h('span', { class: 'pal-icon' }, icon(name, 16));

  // Actions (context-aware first)
  if (here.view === 'house' && ctxProject) {
    cmds.push(
      { id: 'a:chat', group: 'Actions', title: 'Chat with the assistant', subtitle: ctxProject.name, leading: ic('chat'), shortcut: ['/'], boost: 30, run: () => shell.openPanel('chat', ctxProject.id) },
      { id: 'a:workflow', group: 'Actions', title: 'Run a workflow', subtitle: ctxProject.name, keywords: 'team job board', leading: ic('workflow'), shortcut: ['W'], boost: 30, run: () => shell.openWorkflow(ctxProject.id) },
      { id: 'a:tv', group: 'Actions', title: 'Watch TV — see changes', subtitle: ctxProject.name, keywords: 'diff git changes', leading: ic('tv'), shortcut: ['T'], boost: 30, run: () => shell.openDiff(ctxProject.id) },
      { id: 'a:exit', group: 'Actions', title: 'Exit to the city', leading: ic('exit'), keywords: 'leave back', run: () => bus.emit('nav:city', {}) },
    );
    if (store.jobsOf(ctxProject.id).length) {
      cmds.push(
        { id: 'a:newjob', group: 'Actions', title: 'New job', subtitle: `A separate line of work with its own room in ${ctxProject.name}`, keywords: 'session room create add start', leading: ic('plus'), boost: 28, run: () => shell.openNewJob(ctxProject.id) },
        { id: 'a:floor', group: 'Actions', title: 'Add a floor', subtitle: `${ctxProject.name} gets 4 more rooms`, keywords: 'storey level build rooms', leading: ic('layers'), boost: 4, run: () => void shell.addFloor(ctxProject.id) },
      );
    }
  } else {
    cmds.push({ id: 'a:drive', group: 'Actions', title: 'Drive', subtitle: 'Take the car around town', keywords: 'car', leading: ic('car'), shortcut: ['D'], boost: 10, run: () => bus.emit('nav:drive', {}) });
  }
  if (ctxProject) {
    const folder = viewerFolder(shell, ctxProject.id);
    const copy = folder.jobId ? store.job(ctxProject.id, folder.jobId) : undefined;
    const where = copy ? `${ctxProject.name} · “${copy.name}”’s own copy` : ctxProject.name;
    const inHouse = here.view === 'house';
    cmds.push(
      { id: 'a:openfile', group: 'Actions', title: 'Open file…', subtitle: `Find a file in ${where} and view it`, keywords: 'find file open view viewer image picture html page pdf markdown preview go to', leading: ic('search'), boost: inHouse ? 26 : 2, run: () => hooks.openFiles(folder, where) },
      { id: 'a:browse', group: 'Actions', title: 'Browse files', subtitle: `The files in ${where}`, keywords: 'folder files explorer viewer tree', leading: ic('folder'), boost: inHouse ? 12 : 0, run: () => openFolder(shell, folder) },
    );
  }
  if (ctxProject) {
    const anchor = () => shell.root.querySelector<HTMLElement>('.panel-house-menu, .crumb.is-current') ?? shell.root;
    for (const c of houseCommands(shell, ctxProject, anchor)) cmds.push({ ...c, group: 'Actions', leading: ic(c.icon), boost: here.view === 'house' ? 2 : -2 });
  }
  const termHere = here.view === 'house' && ctxProject ? ctxProject : null;
  const termCopy = termHere ? shell.jobs.active(termHere.id) : undefined; // a job with its own copy: its shell is there
  cmds.push(
    { id: 'a:term', group: 'Actions', title: 'Open terminal', subtitle: !terminalOffered() ? TERMINAL_OFF_TEXT : termHere ? (termCopy?.worktree ? `Plain shell in “${termCopy.name}”’s own copy` : `Plain shell in ${termHere.name}`) : 'Plain shell in the workspace', keywords: 'shell bash command line console cli mkdir', leading: ic('terminal'), shortcut: ['Ctrl', '`'], boost: termHere ? 20 : 6, run: () => shell.openTerminal(termHere ? houseTermTarget(shell, termHere.id) : TERM_TOWN) },
    { id: 'a:place', group: 'Actions', title: 'Place project', subtitle: 'Turn a folder into a house', keywords: 'add new folder create build', leading: ic('folderPlus'), boost: 8, run: () => shell.openPlacement() },
    { id: 'a:agency', group: 'Actions', title: 'Models & providers', subtitle: 'Sign in to AI providers — the Talent Agency building', keywords: 'models providers keys api talent agency connect sign in', leading: ic('agency'), run: () => { shell.openProviders(); bus.emit('nav:flyto', { landmarkId: 'agency' }); } },
    { id: 'a:usage', group: 'Actions', title: 'Usage limits', subtitle: 'How much each signed-in account has used', keywords: 'quota limit used remaining accounts switch account sign out models providers', leading: ic('gauge'), run: () => shell.openProviders() },
    ...(threeD.state === 'unavailable'
      ? []
      : [
          shell.focusMode
            ? { id: 'a:focus', group: 'Actions' as const, title: 'Switch to the 3D town', subtitle: threeD.state === 'ready' ? 'Leave the board' : 'Loads the 3D town first', keywords: '3d view focus mode city map', leading: ic('cube'), shortcut: ['`'], run: () => shell.setFocusMode(false) }
            : { id: 'a:focus', group: 'Actions' as const, title: 'Switch to the board', subtitle: 'Every house as a list — pauses the 3D town', keywords: '2d text view list board focus mode pause accessible screen reader keyboard', leading: ic('board'), shortcut: ['`'], run: () => shell.setFocusMode(true) },
        ]),
    { id: 'a:settings', group: 'Actions', title: 'Settings', subtitle: 'View, keyboard, accessibility, devices and your data', keywords: 'preferences options keyboard shortcuts keys accessibility a11y screen reader single key voice contrast transparency board 3d security devices pairing data', leading: ic('settings'), run: () => shell.openSettings() },
    singleKeysEnabled()
      ? { id: 'a:keys', group: 'Actions', title: 'Turn off single-key shortcuts', subtitle: 'For voice control, dictation and screen readers', keywords: 'keyboard shortcuts accessibility letters', leading: ic('command'), run: () => { setSingleKeys(false); shell.toast('info', 'Single-key shortcuts are off. Shortcuts with Ctrl, ⌘ or Alt still work.'); } }
      : { id: 'a:keys', group: 'Actions', title: 'Turn on single-key shortcuts', subtitle: 'W workflow, T changes, 1–9 houses…', keywords: 'keyboard shortcuts accessibility letters', leading: ic('command'), run: () => { setSingleKeys(true); shell.toast('info', 'Single-key shortcuts are on.'); } },
    { id: 'a:inbox', group: 'Actions', title: 'Open inbox', subtitle: `${waitingCount(s)} waiting for you`, keywords: 'approvals notifications', leading: ic('inbox'), run: () => shell.openPanel('inbox', inboxScope(shell.view)) },
    { id: 'a:city', group: 'Actions', title: 'Go to city overview', keywords: 'home town map', leading: ic('home'), run: () => bus.emit('nav:city', {}) },
    { id: 'a:refresh', group: 'Actions', title: 'Refresh models', subtitle: 'Re-check API keys', keywords: 'providers keys', leading: ic('refresh'), run: () => { store.send({ t: 'refresh_models' }); shell.toast('info', 'Checking for API keys…'); } },
    { id: 'a:pair', group: 'Actions', title: 'Pair a phone', subtitle: 'Show a one-time code to scan', keywords: 'qr mobile device login sign in link token', leading: ic('plus'), run: () => openSettings(shell, 'pair') },
    { id: 'a:devices', group: 'Actions', title: 'Devices — sign out', subtitle: 'See and remove paired browsers', keywords: 'sign out logout revoke lost phone security sessions pairing token', leading: ic('exit'), run: () => openSettings(shell, 'devices') },
    { id: 'a:wipe', group: 'Actions', title: 'Delete all CAST data…', subtitle: 'Chats, AI sessions, the town — not your project folders', keywords: 'erase reset wipe privacy remove history', leading: ic('trash'), run: () => openSettings(shell, 'data') },
    { id: 'a:welcome', group: 'Actions', title: 'Show welcome tour', keywords: 'onboarding help intro', leading: ic('sparkle'), run: () => shell.openOnboarding() },
  );
  for (const c of helpCommands()) {
    cmds.push({ id: c.id, group: 'Actions', title: c.title, subtitle: c.subtitle, keywords: c.keywords, leading: ic(c.icon), shortcut: c.shortcut, boost: c.boost, run: () => shell.openHelp(c.section) });
  }
  // graphics presets only mean something with a 3D town on hand
  for (const q of threeD.state === 'ready' ? (['low', 'medium', 'high', 'ultra'] as Quality[]) : []) {
    cmds.push({
      id: `a:q:${q}`,
      group: 'Actions',
      title: `Graphics: ${q[0].toUpperCase()}${q.slice(1)}`,
      subtitle: shell.quality === q ? 'current' : undefined,
      keywords: 'quality performance',
      leading: ic('gauge'),
      boost: -20,
      run: () => shell.setQuality(q),
    });
  }
  for (const t of timeOfDayCommands(shell)) {
    cmds.push({
      id: `a:tod:${t.mode}`,
      group: 'Actions',
      title: t.title,
      subtitle: t.current ? 'current' : undefined,
      keywords: 'time of day night evening sunset golden hour daylight sky light',
      leading: ic('clock'),
      boost: -18,
      run: t.run,
    });
  }

  // Projects
  s.city.projects.forEach((p, i) => {
    const lot = s.city.lots.find((l) => l.id === p.lotId);
    cmds.push({
      id: `p:${p.id}`,
      group: 'Projects',
      title: p.name,
      subtitle: `${p.path}${lot ? ` — ${lot.district}` : ''}`,
      keywords: `${p.style} house enter`,
      leading: ic('home'),
      shortcut: i < 9 ? [String(i + 1)] : undefined,
      boost: p.id === ctxPid ? 5 : 0,
      run: () => shell.enterProject(p.id),
    });
  });

  // Jobs (every house's lines of work; the current house first)
  for (const p of s.city.projects) {
    const jobs = store.jobsOf(p.id);
    if (jobs.length < 2 && p.id !== ctxPid) continue; // a lone 'main' job in another house is just that house
    const active = shell.jobs.active(p.id)?.id;
    for (const j of jobs) {
      const st = jobStatus(shell, j);
      cmds.push({
        id: `j:${p.id}:${j.id}`,
        group: 'Jobs',
        title: j.name,
        subtitle: `${jobRoomCode(j)} · ${p.name} — ${st.leadName} (${st.leadModelLabel}) — ${st.text}`,
        keywords: `${kindInfo(j.kind).name} job room ${j.brief}`,
        leading: () => codeBadge(j),
        boost: (p.id === ctxPid ? 7 : 0) + (j.id === active && p.id === ctxPid ? -3 : 0) + (st.waiting ? 12 : 0),
        run: () => {
          if (shell.view.projectId !== p.id) shell.enterProject(p.id);
          shell.selectJob(p.id, j.id, { focus: true, openPanel: true });
        },
      });
    }
  }

  // People
  for (const a of Object.values(s.agents)) {
    const p = store.project(a.projectId);
    const job = a.jobId && store.jobsOf(a.projectId).length > 1 ? store.job(a.projectId, a.jobId) : undefined;
    cmds.push({
      id: `g:${a.id}`,
      group: 'People',
      title: a.name,
      subtitle: `${a.modelLabel}${agentBlocked(a, s.models, blockOpts(s.hello)) ? ' (not connected)' : ''} — ${p?.name ?? ''}${job ? ` · ${job.name}` : ''} — ${agentStatusText(a)}`,
      keywords: `${a.roleId} ${a.vendor} ${a.model}`,
      leading: () => agentAvatar(a, 'sm'),
      boost: (a.projectId === ctxPid ? 6 : 0) + (agentTone(a) === 'wait' ? 12 : 0),
      run: () => {
        if (shell.view.projectId !== a.projectId) shell.enterProject(a.projectId);
        shell.openAgent(a.id, { focusComposer: true });
      },
    });
  }

  // Workflows: the context house's own (each house has its own; a new house has none until you or its lead make one).
  // No house in the town: none (workflows run inside a house).
  if (ctxProject) {
    for (const w of store.workflowsOf(ctxProject.id)) {
      cmds.push({
        id: `w:${w.id}`,
        group: 'Workflows',
        title: w.name,
        subtitle: `${ctxProject.name} — ${w.description}`,
        keywords: `${w.steps.map((x) => x.name).join(' ')} ${ctxProject.name}`,
        leading: () => h('span', { class: 'pal-icon pal-emoji', 'aria-hidden': 'true' }, w.icon || '•'),
        run: () => shell.openWorkflow(ctxProject.id),
      });
    }
  }
  return cmds;
}

export function createPalette(shell: Shell) {
  const input = h('input', {
    class: 'pal-input',
    type: 'text',
    placeholder: 'Search jobs, projects, people, workflows, actions…',
    'aria-label': 'Command palette',
    role: 'combobox',
    'aria-expanded': 'true',
    'aria-controls': 'pal-list',
    autocomplete: 'off',
    spellcheck: 'false',
  });
  const list = h('div', { class: 'pal-list', id: 'pal-list', role: 'listbox', 'aria-label': 'Results' });
  const panel = h(
    'div',
    { class: 'palette glass-strong', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Command palette' },
    h('div', { class: 'pal-search' }, icon('search', 18), input, kbd('Esc')),
    list,
    h('footer', { class: 'pal-foot' }, h('span', null, kbd('↑', '↓'), ' move'), h('span', null, kbd('Enter'), ' open'), h('span', null, kbd('Esc'), ' close')),
  );
  const el = h('div', { class: 'palette-backdrop', hidden: true }, panel);

  let commands: Command[] = [];
  let results: { cmd: Command; indices: number[] }[] = [];
  /** "Open file…": the palette lists the files of one folder instead of commands. */
  let fileMode: { folder: FolderRef; label: string; paths: string[] | null; error: string | null; truncated: boolean } | null = null;
  let fileSeq = 0;
  const DEFAULT_PLACEHOLDER = input.placeholder;
  let active = 0;
  let removeLayer: (() => void) | null = null;
  let untrap: (() => void) | null = null;
  let previousFocus: FocusMark | null = null; // the opener (or its re-rendered copy) gets focus back

  function fileCommand(path: string, indices: number[], folder: FolderRef): { cmd: Command; indices: number[] } {
    const cut = path.lastIndexOf('/') + 1;
    return {
      cmd: {
        id: `f:${path}`,
        group: 'Actions',
        title: baseName(path),
        subtitle: cut ? path.slice(0, cut - 1) : undefined,
        leading: () => h('span', { class: 'pal-icon' }, vIcon(kindIcon(fileKind(path)), 16)),
        run: () => openFile(shell, { folder, path }),
      },
      indices: indices.filter((i) => i >= cut).map((i) => i - cut),
    };
  }

  function filterFiles() {
    const m = fileMode!;
    if (m.error) {
      results = [];
      setChildren(list, h('div', { class: 'pal-empty' }, `Couldn’t list the files: ${m.error}`));
      return;
    }
    if (!m.paths) {
      results = [];
      setChildren(list, h('div', { class: 'pal-empty' }, h('span', { class: 'spinner spinner-sm' }), ' Looking for files…'));
      return;
    }
    results = matchPaths(input.value, m.paths, 50).map((x) => fileCommand(x.path, x.indices, m.folder));
    active = 0;
    if (!results.length) {
      setChildren(list, h('div', { class: 'pal-empty' }, m.paths.length ? `No file matches “${input.value.trim()}”.` : 'This folder has no files yet.'));
      input.removeAttribute('aria-activedescendant');
      return;
    }
    renderList();
  }

  function enterFileMode(folder: FolderRef, label: string) {
    const seq = ++fileSeq;
    fileMode = { folder, label, paths: null, error: null, truncated: false };
    input.placeholder = `Open a file in ${label}…`;
    input.value = '';
    filter();
    findFiles(shell.store, folder).then(
      (got) => {
        if (seq !== fileSeq || !fileMode) return;
        fileMode.paths = got.paths ?? [];
        fileMode.truncated = !!got.truncated;
        filter();
      },
      (err: Error) => {
        if (seq !== fileSeq || !fileMode) return;
        fileMode.error = err.message;
        filter();
      },
    );
  }

  function leaveFileMode() {
    fileMode = null;
    fileSeq++;
    input.placeholder = DEFAULT_PLACEHOLDER;
  }

  function filter() {
    if (fileMode) return filterFiles();
    const q = input.value;
    if (!q.trim()) {
      results = GROUP_ORDER.flatMap((g) =>
        commands
          .filter((c) => c.group === g && (c.boost ?? 0) >= 0)
          .sort((a, b) => (b.boost ?? 0) - (a.boost ?? 0))
          .slice(0, g === 'Actions' ? 6 : g === 'Jobs' ? 6 : 5)
          .map((cmd) => ({ cmd, indices: [] })),
      );
    } else {
      results = commands
        .map((cmd) => {
          const t = fuzzy(q, cmd.title);
          const k = t ? null : fuzzy(q, `${cmd.subtitle ?? ''} ${cmd.keywords ?? ''}`);
          if (!t && !k) return null;
          return { cmd, indices: t?.indices ?? [], score: (t ? t.score : (k!.score * 0.5)) + (cmd.boost ?? 0) * 3 };
        })
        .filter((x): x is { cmd: Command; indices: number[]; score: number } => !!x)
        .sort((a, b) => b.score - a.score)
        .slice(0, 30);
    }
    active = 0;
    renderList();
  }

  function renderList() {
    if (!results.length) {
      setChildren(list, h('div', { class: 'pal-empty' }, `Nothing matches “${input.value.trim()}”.`));
      input.removeAttribute('aria-activedescendant');
      return;
    }
    const grouped = !input.value.trim() && !fileMode;
    let lastGroup: Group | null = null;
    const nodes: Node[] = [];
    results.forEach(({ cmd, indices }, i) => {
      if (grouped && cmd.group !== lastGroup) {
        nodes.push(h('div', { class: 'pal-group', role: 'presentation' }, cmd.group));
        lastGroup = cmd.group;
      }
      nodes.push(
        h(
          'div',
          {
            class: ['pal-item', i === active && 'is-active'],
            id: `pal-${i}`,
            role: 'option',
            'aria-selected': String(i === active),
            onpointermove: () => {
              if (active !== i) {
                active = i;
                markActive();
              }
            },
            onclick: () => runAt(i),
          },
          cmd.leading(),
          h('span', { class: 'pal-text' }, h('span', { class: 'pal-title' }, highlight(cmd.title, indices)), cmd.subtitle ? h('span', { class: 'pal-sub' }, cmd.subtitle) : null),
          grouped ? null : h('span', { class: 'pal-kind' }, fileMode ? 'File' : cmd.group.replace(/s$/, '')),
          cmd.shortcut ? kbd(...cmd.shortcut) : null,
        ),
      );
    });
    setChildren(list, ...nodes);
    markActive();
  }

  function markActive() {
    list.querySelectorAll('.pal-item').forEach((n, i) => {
      n.classList.toggle('is-active', i === active);
      n.setAttribute('aria-selected', String(i === active));
    });
    input.setAttribute('aria-activedescendant', `pal-${active}`);
    list.querySelector(`#pal-${active}`)?.scrollIntoView({ block: 'nearest' });
  }

  function runAt(i: number) {
    const r = results[i];
    if (!r) return;
    api.close();
    r.cmd.run();
  }

  const hooks: PaletteHooks = { openFiles: (folder, label) => api.openFiles(folder, label) };

  input.addEventListener('input', filter);
  input.addEventListener('keydown', (ev) => {
    if (ev.isComposing) return;
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      active = Math.min(results.length - 1, active + 1);
      markActive();
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      active = Math.max(0, active - 1);
      markActive();
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      runAt(active);
    } else if (ev.key === 'Backspace' && fileMode && !input.value) {
      ev.preventDefault(); // back to the commands
      leaveFileMode();
      commands = buildCommands(shell, hooks);
      filter();
    }
  });
  el.addEventListener('pointerdown', (ev) => {
    if (ev.target === el) api.close();
  });

  const api = {
    el,
    get isOpen() {
      return !el.hidden;
    },
    open(query = '') {
      leaveFileMode();
      commands = buildCommands(shell, hooks);
      input.value = query;
      filter();
      if (!el.hidden) return input.select();
      previousFocus = markFocus();
      el.hidden = false;
      requestAnimationFrame(() => el.classList.add('is-open'));
      removeLayer = shell.layers.push({ id: 'palette', close: () => api.close(), modal: true });
      untrap = trapFocus(panel);
      focusFirst(panel);
    },
    /** Straight to the file finder of a folder (the "Open file…" command). */
    openFiles(folder: FolderRef, label: string) {
      api.open();
      enterFileMode(folder, label);
    },
    close() {
      if (el.hidden) return;
      removeLayer?.();
      untrap?.();
      removeLayer = untrap = null;
      el.classList.remove('is-open');
      el.hidden = true;
      restoreFocus(previousFocus);
    },
    toggle() {
      if (el.hidden) api.open();
      else api.close();
    },
  };
  return api;
}
