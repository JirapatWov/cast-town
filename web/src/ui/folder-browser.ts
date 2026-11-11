// Server-side folder browser (fs_list): breadcrumbs, folders only, git and "already a house" badges.
// Nothing is chosen until the user says so: the dialog opens with no folder selected, opening a folder from the list
// selects it, and the top of a browse root (which holds every project) is never selected by just arriving there —
// placing it would give a house's people the whole tree. Its git state comes from the server for the folder itself,
// so a folder opened directly (not from its parent's list) isn't wrongly called "not a git repo".
import type { FsEntry, Project, ServerMsg } from '../../../shared/protocol';
import { shortPath } from './display-path';
import { h, storage, setChildren } from './dom';
import { icon } from './icons';
import type { Shell } from './shell';

type FsListMsg = Extract<ServerMsg, { t: 'fs_list' }>;
const LAST_PATH_KEY = 'rlt.place.lastPath';

/** The folder the user chose, with what the dialog needs to warn about it. */
export interface FolderChoice {
  path: string;
  isGit: boolean;
  /** It is one of the places CAST may browse (RLT_FS_ROOTS) — the container of everything, not a project. */
  isRoot: boolean;
  /** Folders right inside it that are git repositories: ≥ 2 → it holds several projects. */
  gitRepos: number;
  /** It already is this house. */
  house?: Project;
}

export interface FolderBrowser {
  readonly el: HTMLElement;
  readonly path: string | null;
  readonly choice: FolderChoice | null;
  /** select: choose the folder too (unless it is a browse root); otherwise only show it. */
  load(path: string, opts?: { select?: boolean; isGit?: boolean }): Promise<boolean>;
}

/** Whether arriving at a folder chooses it: only when the user asked (opened it from the list, went up to it, …) and
 *  never for a browse root — that has to be chosen on purpose ("Use this whole folder"). */
export function choosesOnArrival(select: boolean, isRoot: boolean): boolean {
  return select && !isRoot;
}

/** At the top of one browse root, the other places CAST may look in (RLT_FS_ROOTS lists several): there is no "Up one
 *  level" there, so without these rows the second root could not be reached at all. Pure, for tests. */
export function otherRoots(current: string | null, isRoot: boolean, roots: readonly string[] | undefined): string[] {
  if (!isRoot || !current || !roots || roots.length < 2) return [];
  const norm = (p: string) => p.replace(/\/+$/, '') || '/';
  return [...new Set(roots.map(norm))].filter((r) => r !== norm(current));
}

/** `createNew`: where an empty folder sends you — the place dialog's "Create new" tab (its templates). */
export function createFolderBrowser(shell: Shell, onChange: (choice: FolderChoice | null) => void, createNew?: () => void): FolderBrowser {
  const crumbs = h('nav', { class: 'fb-crumbs', 'aria-label': 'Folder path' });
  const list = h('div', { class: 'fb-list', role: 'listbox', 'aria-label': 'Folders' });
  const here = h('div', { class: 'fb-here' });
  const el = h('div', { class: 'folder-browser' }, crumbs, list, here);

  let current: string | null = null;
  let currentIsGit = false;
  let currentRoot = false;
  let entries: FsEntry[] = [];
  let parent: string | null = null;
  let choice: FolderChoice | null = null;
  let seq = 0;
  const gitCache = new Map<string, boolean>(); // isGit learned from parent listings (older servers send none for the folder)

  const houseAt = (path: string) => shell.store.state.city.projects.find((p) => p.path === path);
  const roots = () => shell.store.state.hello?.fsRoots ?? [];
  const childPath = (name: string) => `${current === '/' ? '' : current}/${name}`;

  function setChoice(next: FolderChoice | null) {
    choice = next;
    if (next) storage.set(LAST_PATH_KEY, next.path);
    renderHere();
    onChange(next);
  }

  function chooseCurrent() {
    if (!current) return;
    setChoice({ path: current, isGit: currentIsGit, isRoot: currentRoot, gitRepos: entries.filter((e) => e.isDir && e.isGit).length, house: houseAt(current) });
  }

  /** Under the list: "Choose a folder above" with a way to take the folder on show, when nothing is chosen. */
  function renderHere() {
    if (!current || choice?.path === current) {
      setChildren(here);
      here.hidden = true;
      return;
    }
    here.hidden = false;
    setChildren(here,
      h(
        'span',
        { class: 'fb-here-text' },
        !currentRoot
          ? 'Open a folder above to choose it.'
          : roots().length > 1
            ? 'This is the top of one of the places CAST may look in. Open the project folder you want.'
            : 'This is the top of the places CAST may look in — it holds all your folders. Open the project folder you want.',
      ),
      h(
        'button',
        { type: 'button', class: ['link-btn', 'fb-use', currentRoot && 'is-risky'], onclick: chooseCurrent },
        currentRoot ? 'Use this whole folder anyway' : 'Use this folder',
      ),
    );
  }

  function renderCrumbs(path: string) {
    const parts = path.split('/').filter(Boolean);
    const nodes: Node[] = [];
    nodes.push(h('button', { type: 'button', class: 'fb-crumb', onclick: () => void api.load('/', { select: true }), 'aria-label': 'Root' }, '/'));
    parts.forEach((part, i) => {
      const p = `/${parts.slice(0, i + 1).join('/')}`;
      if (i > 0) nodes.push(h('span', { class: 'fb-sep', 'aria-hidden': 'true' }, '/'));
      nodes.push(h('button', { type: 'button', class: ['fb-crumb', i === parts.length - 1 && 'is-current'], onclick: () => void api.load(p, { select: true }) }, part));
    });
    setChildren(crumbs, ...nodes);
    crumbs.scrollLeft = crumbs.scrollWidth;
  }

  function renderEntries() {
    // Opening a folder from the keyboard replaces the row that had focus: carry focus to the new listing (its first
    // folder, else "Up one level") and say where we are, instead of dropping it.
    const hadFocus = list.contains(document.activeElement) || el.contains(document.activeElement);
    const dirs = entries.filter((e) => e.isDir);
    const rows: HTMLElement[] = [];
    if (parent)
      rows.push(
        h('button', { type: 'button', class: 'fb-row fb-up', onclick: () => void api.load(parent!, { select: true }) }, icon('arrowLeft', 15), h('span', { class: 'fb-name' }, 'Up one level')),
      );
    for (const e of dirs) {
      const full = childPath(e.name);
      const git = !!e.isGit || currentIsGit; // inside a repository, every folder is in it too
      gitCache.set(full, git);
      const house = houseAt(full);
      rows.push(
        h(
          'button',
          {
            type: 'button',
            class: ['fb-row', e.isGit && 'is-git', house && 'is-house'],
            role: 'option',
            'aria-selected': String(choice?.path === full),
            'aria-label': `${e.name}${e.isGit ? ', git repository' : ''}${house ? `, already the house ${house.name}` : ''}`,
            onclick: () => void api.load(full, { select: true, isGit: git }),
          },
          icon('folder', 16),
          h('span', { class: 'fb-name' }, e.name),
          house ? h('span', { class: 'house-badge', title: `Already the house “${house.name}”` }, icon('home', 11), 'house') : null,
          e.isGit ? h('span', { class: 'git-badge' }, icon('branch', 11), 'git') : null,
          icon('chevronRight', 14, 'fb-chev'),
        ),
      );
    }
    if (!dirs.length)
      rows.push(
        h(
          'p',
          { class: 'fb-empty' },
          createNew
            ? h('span', null, 'No folders inside. To start from a template, use ', h('button', { type: 'button', class: 'link-btn', onclick: createNew }, 'Create new'), '.')
            : 'No folders inside.',
        ),
      );
    const others = otherRoots(current, currentRoot, roots());
    if (others.length) {
      rows.push(h('p', { class: 'fb-group' }, 'Other places CAST may look in'));
      for (const r of others)
        rows.push(
          h(
            'button',
            { type: 'button', class: 'fb-row fb-root', 'aria-label': `Open ${r}`, title: r, onclick: () => void api.load(r) },
            icon('folder', 16),
            h('span', { class: 'fb-name' }, shortPath(r, shell.store.state.hello?.home, 48)),
            icon('chevronRight', 14, 'fb-chev'),
          ),
        );
    }
    setChildren(list, ...rows);
    list.scrollTop = 0;
    if (hadFocus) {
      (list.querySelector<HTMLElement>('.fb-row[role="option"]') ?? list.querySelector<HTMLElement>('.fb-row'))?.focus({ preventScroll: true });
      const name = current === '/' ? 'the root folder' : (current ?? '').split('/').filter(Boolean).pop();
      shell.announce(`${name}: ${dirs.length ? `${dirs.length} folder${dirs.length === 1 ? '' : 's'} inside` : 'no folders inside'}.`);
    }
  }

  const api: FolderBrowser = {
    el,
    get path() {
      return current;
    },
    get choice() {
      return choice;
    },
    async load(path: string, opts: { select?: boolean; isGit?: boolean } = {}) {
      const mine = ++seq;
      list.classList.add('is-loading');
      try {
        const res = await shell.store.request<FsListMsg>({ t: 'fs_list', reqId: '', path });
        if (mine !== seq) return false;
        current = res.path;
        parent = res.parent;
        entries = res.entries;
        currentRoot = res.parent === null; // the server gives no way up only at a browse root
        // The server says whether the folder itself is in a repository; older ones only report it per entry.
        currentIsGit = res.isGit ?? opts.isGit ?? gitCache.get(res.path) ?? false;
        renderCrumbs(res.path);
        if (choosesOnArrival(!!opts.select, currentRoot)) chooseCurrent();
        else setChoice(null);
        renderEntries();
        return true;
      } catch (err) {
        if (mine === seq) setChildren(list, h('p', { class: 'fb-error' }, icon('alert', 15), (err as Error).message || 'Could not open this folder.'));
        return false;
      } finally {
        if (mine === seq) list.classList.remove('is-loading');
      }
    },
  };
  return api;
}

/** Where Place project opens: the folder that holds the last one chosen (so its neighbours are one click away), with
 *  nothing selected; else `fallback`. */
export function startFolder(fallback: string): string {
  const last = storage.get(LAST_PATH_KEY);
  if (!last || !last.startsWith('/')) return fallback;
  const up = last.replace(/\/+$/, '').replace(/\/[^/]+$/, '');
  return up || '/';
}
