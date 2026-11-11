// Built-in file viewer: a full-screen overlay (like the TV diff) that shows a file of a person's folder — images,
// web pages, PDFs, Markdown, code, JSON, CSV, audio and video — with the folder's files on the left (a drawer on
// phones). Files load from FILES_PATH/<key>/<path> (net/files.ts): every response is CSP-sandboxed by the server,
// with an egress allowlist (a page loads only from CAST and known CDNs), and the app adds its own guards: SVG only
// ever as <img>, web pages in a sandboxed <iframe> without allow-same-origin or allow-popups, file text only through
// the Markdown renderer (raw HTML escaped) or highlight.js (escaped). A web page runs inside a frame shell of its own
// (server/files.ts PAGE_SHIM); the shell's messages — "open this link", "blocked <host>" — become the ask bar and the
// blocked note above the page.
// It also shows chat images (uploads), which replaced the old lightbox.
import './css/viewer.css';
import { fileUrl, type FileEntry, type FilesKey, type ImageRef } from '../../../shared/protocol';
import { filesKey, findFiles, forgetFound, listFiles, sameFolder, type FolderRef } from '../net/files';
import { uploadUrl } from '../net/uploads';
import { copyText, deviceStorage, escapeHtml, h, setChildren, storage } from './dom';
import { markFocus, restoreFocus, type FocusMark } from './focus';
import { baseName, dirName, extOf, fileKind, fmtBytes, hljsLanguage, kindIcon, kindLabel, openTarget, pageMessage, pdfFrameOk, type FileKind, type OpenTarget } from './file-kinds';
import { matchPaths, personRoots, resolvePath, type FileRef, type RootChoice } from './file-paths';
import { looksLikeText, parseDelimited, plainLines, sniffDelimiter, splitHighlightedLines, trimFinalNewline } from './file-text';
import { timeAgo } from './format';
import { highlight as markMatches } from './fuzzy';
import { icon } from './icons';
import { trapFocus } from './layers';
import { openMenu, type MenuItem } from './menu';
import { fileRefOf, renderMarkdown } from './markdown';
import type { Shell } from './shell';
import { vIcon } from './viewer-icons';
import { segmented } from './widgets';

/** Text shown at most (the rest: "first 2 MB shown"); highlighted only below HIGHLIGHT_LIMIT. */
export const TEXT_LIMIT = 2 * 1024 * 1024;
const HIGHLIGHT_LIMIT = 300 * 1024;
const CSV_ROWS = 1000;
const FOUND_SHOWN = 100;
const PHONE = '(max-width: 820px)';
/** The iframe of a web page: scripts, forms and downloads, never allow-same-origin (the server's CSP sandbox says the
 *  same, so it holds even in a new tab). No allow-modals here: an alert() loop would freeze CAST itself. No
 *  allow-popups: a popup could carry the page's data to any site — the page asks the viewer instead (askOpen). */
export const HTML_SANDBOX = 'allow-scripts allow-forms allow-downloads';
/** The ask bar's Open button wakes up this long after the bar shows, and this long after every press on the bar
 *  before then: a click meant for the page never lands on it, nor does a burst of them (a "click as fast as you can"
 *  page that puts its button where Open appears). */
const ASK_ARM_MS = 500;
/** Hosts the blocked note keeps (a page can post any number of made-up ones). */
const BLOCKED_HOSTS_MAX = 20;
/** Tools whose finished call means the file may have changed (reads don't). */
const WRITES = /^(?!read|grep|find|ls|glob|lsp|search|web|fetch)/;

const FIT_KEY = 'rlt.viewer.fit';
const WIDTH_KEY = 'rlt.viewer.width';
const WRAP_KEY = 'rlt.viewer.wrap';
const NAV_KEY = 'rlt.viewer.nav';
/** Text size of documents and code (A− / A+), per device: a phone and a desk screen want different sizes. */
const TEXT_SIZE_KEY = 'rlt.viewer.textSize';
const TEXT_SIZES = [0.85, 0.92, 1, 1.1, 1.22, 1.36, 1.5];

type Source =
  | { type: 'file'; folder: FolderRef; path: string | null; dir: string }
  | { type: 'upload'; ref: ImageRef; label: string };

interface Listing {
  dir: string;
  entries: FileEntry[];
  truncated?: boolean;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

interface Fetched {
  text: string;
  truncated: boolean;
  total: number | null;
  type: string;
}

/** The first `limit` bytes of a file as text (Range, so a huge log never comes down whole). */
async function fetchText(url: string, limit = TEXT_LIMIT): Promise<Fetched> {
  const res = await fetch(url, { headers: { Range: `bytes=0-${limit - 1}` }, cache: 'no-cache' });
  if (res.status === 416) return { text: '', truncated: false, total: 0, type: res.headers.get('content-type') ?? '' }; // an empty file
  if (!res.ok) throw new HttpError(res.status, (await res.text().catch(() => '')).slice(0, 200));
  const buf = await res.arrayBuffer();
  const range = /\/(\d+)\s*$/.exec(res.headers.get('content-range') ?? '');
  const total = range ? Number(range[1]) : Number(res.headers.get('content-length') ?? buf.byteLength);
  const truncated = res.status === 206 && total > buf.byteLength;
  let text = new TextDecoder('utf-8').decode(buf);
  if (truncated) text = text.replace(/�+$/, ''); // a character cut in half at the limit
  return { text, truncated, total, type: res.headers.get('content-type') ?? '' };
}

/** Whether the file is there (and its size), before an <img>/<iframe> that can't say why it failed. */
async function probe(url: string): Promise<{ size: number | null; type: string }> {
  const res = await fetch(url, { method: 'HEAD', cache: 'no-cache' });
  if (!res.ok) throw new HttpError(res.status, '');
  // x-file-size: the file on disk (an HTML page is served with CAST's storage shim added, so its length is larger)
  const len = res.headers.get('x-file-size') ?? res.headers.get('content-length');
  return { size: len === null ? null : Number(len), type: res.headers.get('content-type') ?? '' };
}

function failText(err: unknown): { title: string; body: string } {
  if (err instanceof HttpError) {
    if (err.status === 404) return { title: 'Not found', body: 'It isn’t there any more — it may have been moved, renamed or deleted.' };
    if (err.status === 403) return { title: 'Can’t open this file', body: 'It is hidden (its name starts with “.”) or leads outside the house’s folder.' };
    if (err.status === 400) return { title: 'Can’t open this path', body: 'The path isn’t one CAST can open.' };
    return { title: 'Couldn’t load it', body: `The server answered ${err.status}. Try Reload.` };
  }
  return { title: 'Couldn’t load it', body: (err as Error)?.message || 'Try Reload.' };
}

const isPhone = () => window.matchMedia(PHONE).matches;
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function iconBtn(name: string, label: string, onclick: () => void, extra: Record<string, unknown> = {}): HTMLButtonElement {
  return h('button', { type: 'button', class: 'icon-btn', 'aria-label': label, title: label, onclick, ...extra }, vIcon(name, 16));
}

function toggleBtn(name: string, label: string, on: boolean, onclick: () => void): HTMLButtonElement {
  return h('button', { type: 'button', class: ['vw-tog', on && 'is-on'], 'aria-pressed': String(on), title: label, onclick }, vIcon(name, 14), h('span', null, label));
}

function stateBox(iconName: string, title: string, body: string, ...actions: (HTMLElement | null)[]): HTMLElement {
  return h(
    'div',
    { class: 'vw-state' },
    h('div', { class: 'vw-state-icon' }, vIcon(iconName, 22)),
    h('p', { class: 'vw-state-title' }, title),
    h('p', { class: 'vw-state-body' }, body),
    actions.some(Boolean) ? h('div', { class: 'vw-state-actions' }, ...actions) : null,
  );
}

const loading = (what = 'Loading…') => h('div', { class: 'loading-row' }, h('span', { class: 'spinner' }), what);

interface Viewer {
  openFile(ref: FileRef): void;
  openUpload(ref: ImageRef, label: string): void;
}

const viewers = new WeakMap<Shell, Viewer>();
function viewerOf(shell: Shell): Viewer {
  let v = viewers.get(shell);
  if (!v) {
    v = createViewer(shell);
    viewers.set(shell, v);
  }
  return v;
}

/** Show a file (or, with ref.dir, a folder) of a person's folder. */
export function openFile(shell: Shell, ref: FileRef): void {
  viewerOf(shell).openFile(ref);
}

/** Browse a folder: its files on the left, nothing open yet. */
export function openFolder(shell: Shell, folder: FolderRef, dir = ''): void {
  viewerOf(shell).openFile({ folder, path: dir, dir: true });
}

/** A chat image (sent by the user, or produced by a tool) full size. */
export function openUpload(shell: Shell, ref: ImageRef, label = 'Image'): void {
  viewerOf(shell).openUpload(ref, label);
}

function createViewer(shell: Shell): Viewer {
  const { store } = shell;
  let shown = false; // the overlay is (being) shown; the fade in/out is only the look of it
  let src: Source | null = null;
  let key: FilesKey | null = null;
  let listing: Listing | null = null;
  let listErr: string | null = null;
  let listSeq = 0;
  let viewSeq = 0;
  let query = '';
  let allPaths: string[] | null = null;
  let findErr: string | null = null;
  let findLoading = false;
  let version = 0; // bumped by Reload: a cache-buster for <img>/<iframe>
  let imageDims = '';
  let fileSize: number | null = null;
  let updatedFlash = false;
  let showSource = false;
  let showRaw = false;
  // How the viewer shows things: this device's preferences, the same in every city.
  let fit: 'fit' | 'actual' = deviceStorage.get(FIT_KEY) === 'actual' ? 'actual' : 'fit';
  let width: 'desktop' | 'phone' = deviceStorage.get(WIDTH_KEY) === 'phone' ? 'phone' : 'desktop';
  let wrap = deviceStorage.get(WRAP_KEY) === '1';
  let navHidden = deviceStorage.get(NAV_KEY) === 'hidden'; // desktop: the files column folded away
  let drawer = false; // phones: the files drawer is out
  let textSize = TEXT_SIZES.indexOf(Number(deviceStorage.get(TEXT_SIZE_KEY)));
  if (textSize < 0) textSize = TEXT_SIZES.indexOf(1);
  let removeLayer: (() => void) | null = null;
  let untrap: (() => void) | null = null;
  let previousFocus: FocusMark | null = null; // the opener (or its re-rendered copy) gets focus back
  let touchTimer: ReturnType<typeof setTimeout> | null = null;
  const touched = { open: false, dirs: new Set<string>() };
  // the web page on show: its frame (the shell's window is its contentWindow), the bars above it, what it asked
  let pageFrame: HTMLIFrameElement | null = null;
  let pageBars: HTMLElement | null = null;
  let asking: Extract<OpenTarget, { kind: 'site' }> | null = null;
  let askArmedAt = 0; // performance.now() from when the ask bar's Open works
  const blocked = new Map<string, Set<string>>(); // host → CSP directives
  let blockedDismissed = false;

  // ── DOM ──
  const titleEl = h('h2', { class: 'vw-title', id: 'vw-title' });
  const crumbs = h('div', { class: 'vw-crumbs' });
  const chips = h('div', { class: 'vw-chips' });
  const tools = h('div', { class: 'vw-tools' });
  const navBtn = h('button', { type: 'button', class: 'icon-btn vw-navbtn', 'aria-label': 'Files', title: 'Files', 'aria-expanded': 'false', onclick: () => toggleNav() }, vIcon('sidebar', 17));
  // vw-extra: on a phone these four move into More (moreBtn). At the 44 px a finger needs, the whole row was 446 px
  // wide, and an iPhone 13 has 376: Copy path sat half off the screen, and a 320 px phone hid three of the four.
  const reloadBtn = iconBtn('refresh', 'Reload (R)', () => reload(), { class: 'icon-btn vw-extra' });
  const newTab = h('a', { class: 'icon-btn vw-extra', target: '_blank', rel: 'noopener noreferrer', 'aria-label': 'Open in new tab', title: 'Open in new tab' }, vIcon('external', 16));
  const download = h('a', { class: 'icon-btn vw-extra', 'aria-label': 'Download', title: 'Download' }, vIcon('download', 16));
  const copyBtn = iconBtn('copy', 'Copy path', () => void copyPath(), { class: 'icon-btn vw-extra' });
  const moreBtn = iconBtn('more', 'More: reload, open in new tab, download, copy path', () => openMore(), { class: 'icon-btn vw-more', 'aria-haspopup': 'menu', 'aria-expanded': 'false' });
  let closeMore: (() => void) | null = null;
  function openMore() {
    // a second tap on the button closes the menu (the popover's outside-click ignores its own anchor)
    if (closeMore && moreBtn.getAttribute('aria-expanded') === 'true') return void closeMore();
    const items: MenuItem[] = [];
    if (!reloadBtn.hidden) items.push({ label: 'Reload', icon: 'refresh', onSelect: () => reload() });
    if (!newTab.hidden) items.push({ label: 'Open in new tab', icon: 'external', onSelect: () => newTab.click() });
    if (!download.hidden) items.push({ label: 'Download', icon: 'arrowDown', onSelect: () => download.click() });
    if (!copyBtn.hidden) items.push({ label: copyBtn.title, icon: 'copy', onSelect: () => void copyPath() });
    closeMore = openMenu(shell.root, shell.layers, moreBtn, [{ items }], { id: 'vw-more', align: 'end', placement: 'below', minWidth: 200 });
  }
  const closeBtn = iconBtn('x', 'Close (Esc)', () => close(), { class: 'icon-btn vw-close' });
  // finding #49: the next / previous file of the folder (j / k) and the text size, as buttons anyone can find
  const prevFile = h('button', { type: 'button', class: 'icon-btn vw-step', 'aria-label': 'Previous file (K)', title: 'Previous file (K)', onclick: () => step(-1) }, icon('chevronUp', 16));
  const nextFile = h('button', { type: 'button', class: 'icon-btn vw-step', 'aria-label': 'Next file (J)', title: 'Next file (J)', onclick: () => step(1) }, icon('chevronDown', 16));
  const smaller = h('button', { type: 'button', class: 'icon-btn vw-size', 'aria-label': 'Smaller text', title: 'Smaller text (−)', onclick: () => sizeText(-1) }, h('span', { class: 'vw-size-a is-small', 'aria-hidden': 'true' }, 'A−'));
  const larger = h('button', { type: 'button', class: 'icon-btn vw-size', 'aria-label': 'Larger text', title: 'Larger text (+)', onclick: () => sizeText(1) }, h('span', { class: 'vw-size-a', 'aria-hidden': 'true' }, 'A+'));
  const head = h(
    'header',
    { class: 'vw-head' },
    navBtn,
    h('div', { class: 'vw-titles' }, titleEl, h('div', { class: 'vw-sub' }, crumbs, chips)),
    h('div', { class: 'vw-bar' }, tools, h('div', { class: 'vw-actions' }, h('span', { class: 'vw-steps' }, prevFile, nextFile), h('span', { class: 'vw-sizes' }, smaller, larger), reloadBtn, newTab, download, copyBtn, moreBtn)),
    closeBtn,
  );

  const upBtn = h('button', { type: 'button', class: 'icon-btn vw-up', 'aria-label': 'Up one folder', title: 'Up one folder', onclick: () => goUp() }, vIcon('up', 15));
  const dirLabel = h('span', { class: 'vw-dir' });
  const findInput = h('input', {
    class: 'input vw-find',
    type: 'search',
    placeholder: 'Find a file…',
    'aria-label': 'Find a file in this folder',
    autocomplete: 'off',
    spellcheck: 'false',
  });
  const list = h('ul', { class: 'vw-list', 'aria-label': 'Files' });
  const navNote = h('p', { class: 'vw-nav-note', hidden: true });
  const nav = h(
    'nav',
    { class: 'vw-nav', 'aria-label': 'Files of this folder' },
    h('div', { class: 'vw-nav-head' }, upBtn, dirLabel),
    h('div', { class: 'vw-find-wrap' }, vIcon('search', 14), findInput),
    list,
    navNote,
  );
  const body = h('div', { class: 'vw-body', tabindex: '0' });
  const scrim = h('div', { class: 'vw-scrim', onclick: () => setDrawer(false) });
  const panel = h(
    'div',
    { class: 'vw-panel glass-strong', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'vw-title' },
    head,
    h('div', { class: 'vw-main' }, nav, body, scrim),
  );
  const el = h('div', { class: 'vw-overlay', hidden: true }, panel);
  el.addEventListener('pointerdown', (ev) => {
    if (ev.target === el) close();
  });

  function applyTextSize() {
    panel.style.setProperty('--vw-text', String(TEXT_SIZES[textSize]));
    smaller.disabled = textSize === 0;
    larger.disabled = textSize === TEXT_SIZES.length - 1;
  }
  function sizeText(by: number) {
    const next = Math.max(0, Math.min(TEXT_SIZES.length - 1, textSize + by));
    if (next === textSize) return;
    textSize = next;
    deviceStorage.set(TEXT_SIZE_KEY, String(TEXT_SIZES[textSize]));
    applyTextSize();
  }
  applyTextSize();

  // ── Where things are ──
  const fileSrc = () => (src?.type === 'file' ? src : null);
  const currentPath = () => fileSrc()?.path ?? null;
  const fullPath = (rel: string) => (key ? (rel ? `${key.root.replace(/\/+$/, '')}/${rel}` : key.root) : rel);

  function folderLabel(f: FolderRef): string {
    const project = store.project(f.projectId);
    const job = f.jobId ? store.job(f.projectId, f.jobId) : undefined;
    const name = project?.name ?? 'House';
    return job ? `${name} · ${job.name}’s copy` : name;
  }

  async function ensureKey(): Promise<FilesKey> {
    const s = fileSrc();
    if (!s) throw new Error('No folder');
    const k = await filesKey(store, s.folder);
    if (fileSrc() === s || (fileSrc() && sameFolder(fileSrc()!.folder, s.folder))) key = k;
    return k;
  }

  const urlOf = (k: FilesKey, path: string) => fileUrl(k.base, path) + (version ? `?v=${version}` : '');

  // ── Header ──
  function renderHead() {
    const s = src;
    panel.classList.toggle('no-nav', s?.type === 'upload');
    if (!s) return;
    prevFile.hidden = nextFile.hidden = !(s.type === 'file' && s.path && folderFiles().length > 1);
    if (s.type === 'upload') {
      titleEl.textContent = s.label;
      setChildren(crumbs, h('span', { class: 'vw-crumb is-static' }, 'In the chat'));
      setChildren(chips, h('span', { class: 'chip' }, s.ref.mimeType.replace('image/', '').toUpperCase()), imageDims ? h('span', { class: 'chip' }, imageDims) : null);
      const url = uploadUrl(s.ref.id);
      newTab.href = url;
      download.href = url;
      download.setAttribute('download', s.ref.id);
      newTab.hidden = download.hidden = false;
      copyBtn.hidden = reloadBtn.hidden = true;
      return;
    }
    const path = s.path;
    titleEl.textContent = path ? baseName(path) : s.dir ? baseName(s.dir) : folderLabel(s.folder);
    titleEl.title = path ? fullPath(path) : fullPath(s.dir);
    // breadcrumb: house › folder › folder (each opens that folder on the left)
    const segs = (path ? dirName(path) : s.dir).split('/').filter(Boolean);
    const crumbNodes: Node[] = [h('button', { type: 'button', class: 'vw-crumb', title: 'Show the top folder', onclick: () => navigate('') }, folderLabel(s.folder))];
    segs.forEach((seg, i) => {
      const dir = segs.slice(0, i + 1).join('/');
      crumbNodes.push(h('span', { class: 'vw-crumb-sep', 'aria-hidden': 'true' }, '/'), h('button', { type: 'button', class: 'vw-crumb', title: `Show ${dir}/`, onclick: () => navigate(dir) }, seg));
    });
    setChildren(crumbs, ...crumbNodes);
    const kind = path ? fileKind(path) : null;
    const entry = path ? entryOf(path) : undefined;
    const size = fileSize ?? entry?.size;
    setChildren(chips,
      kind ? h('span', { class: 'chip' }, kindLabel(path!, kind)) : null,
      size !== undefined && size !== null ? h('span', { class: 'chip num' }, fmtBytes(size)) : null,
      imageDims ? h('span', { class: 'chip num' }, imageDims) : null,
      entry?.mtime ? h('span', { class: 'chip vw-chip-time', title: new Date(entry.mtime).toLocaleString() }, `changed ${timeAgo(entry.mtime)}`) : null,
      updatedFlash ? h('span', { class: 'chip vw-chip-new' }, 'Updated') : null,
    );
    const url = path && key ? fileUrl(key.base, path) : null;
    newTab.hidden = download.hidden = !url;
    if (url) {
      newTab.href = url;
      download.href = url;
      download.setAttribute('download', baseName(path!));
    }
    copyBtn.hidden = false;
    reloadBtn.hidden = false;
    copyBtn.title = copyBtn.ariaLabel = path ? 'Copy path' : 'Copy folder path';
  }

  function entryOf(path: string): FileEntry | undefined {
    if (!listing || listing.dir !== dirName(path)) return undefined;
    const name = baseName(path);
    return listing.entries.find((e) => e.name === name && !e.isDir);
  }

  async function copyPath() {
    const s = fileSrc();
    if (!s) return;
    try {
      await ensureKey();
    } catch {
      /* the relative path, then */
    }
    const p = fullPath(s.path ?? s.dir);
    const ok = await copyText(p);
    shell.toast(ok ? 'success' : 'error', ok ? `Copied ${p}` : 'Couldn’t copy the path.');
  }

  // ── Files column ──
  function setDrawer(open: boolean) {
    drawer = open;
    panel.classList.toggle('nav-open', open);
    syncNavBtn();
  }

  function toggleNav() {
    if (isPhone()) setDrawer(!drawer);
    else {
      navHidden = !navHidden;
      deviceStorage.set(NAV_KEY, navHidden ? 'hidden' : 'shown');
      panel.classList.toggle('nav-hidden', navHidden);
      syncNavBtn();
    }
  }

  function syncNavBtn() {
    const open = isPhone() ? drawer : !navHidden;
    navBtn.setAttribute('aria-expanded', String(open));
    navBtn.classList.toggle('is-on', open);
    navBtn.title = open ? 'Hide files' : 'Show files';
  }

  async function loadListing(dir: string, quiet = false) {
    const s = fileSrc();
    if (!s) return;
    const seq = ++listSeq;
    if (!quiet || listing?.dir !== dir) {
      listing = listing?.dir === dir ? listing : null;
      listErr = null;
      if (!listing) renderNav();
    }
    try {
      const got = await listFiles(store, s.folder, dir);
      if (seq !== listSeq || fileSrc() !== s) return;
      listing = { dir: got.dir ?? dir, entries: got.entries ?? [], truncated: got.truncated };
      listErr = null;
    } catch (err) {
      if (seq !== listSeq || fileSrc() !== s) return;
      listErr = (err as Error).message;
      if (!quiet) listing = null;
    }
    renderNav();
    renderHead();
  }

  function navigate(dir: string) {
    const s = fileSrc();
    if (!s) return;
    s.dir = dir;
    clearFind();
    if (isPhone()) setDrawer(true);
    void loadListing(dir);
    if (s.path === null) {
      renderHead();
      void loadView();
    }
  }

  function goUp() {
    const s = fileSrc();
    if (!s || !s.dir) return;
    navigate(dirName(s.dir));
    requestAnimationFrame(() => list.querySelector<HTMLElement>('.vw-entry')?.focus({ preventScroll: true }));
  }

  function entryRow(path: string, isDir: boolean, label: Node[] | string, meta: string, extraCls?: string): HTMLElement {
    const kind = isDir ? null : fileKind(path);
    const on = !isDir && path === currentPath();
    return h(
      'li',
      null,
      h(
        'button',
        {
          type: 'button',
          class: ['vw-entry', isDir && 'is-dir', on && 'is-on', extraCls],
          'data-path': path,
          'aria-current': on ? 'true' : undefined,
          title: isDir ? `${path}/` : path,
          onclick: () => (isDir ? navigate(path) : pick(path)),
        },
        h('span', { class: 'vw-entry-icon' }, vIcon(isDir ? 'folder' : kindIcon(kind!), 15)),
        h('span', { class: 'vw-entry-name' }, label),
        meta ? h('span', { class: 'vw-entry-meta num' }, meta) : null,
      ),
    );
  }

  function renderNav() {
    const s = fileSrc();
    if (!s) return;
    upBtn.disabled = !s.dir;
    dirLabel.textContent = s.dir ? `${s.dir}/` : folderLabel(s.folder);
    dirLabel.title = fullPath(s.dir);
    navNote.hidden = true;
    if (query) return renderFound();
    if (listErr && !listing) {
      setChildren(list, h('li', { class: 'vw-nav-msg is-error' }, `Couldn’t list this folder: ${listErr}`));
      return;
    }
    if (!listing || listing.dir !== s.dir) {
      setChildren(list, h('li', null, loading('Listing…')));
      return;
    }
    const rows = listing.entries.map((e) => {
      const path = s.dir ? `${s.dir}/${e.name}` : e.name;
      return entryRow(path, e.isDir, e.name, e.isDir ? '' : fmtBytes(e.size));
    });
    setChildren(list, ...(rows.length ? rows : [h('li', { class: 'vw-nav-msg' }, 'Nothing here yet.')]));
    if (listing.truncated) {
      navNote.hidden = false;
      navNote.textContent = `Only the first ${listing.entries.length} entries are listed — use Find for the rest.`;
    }
  }

  function renderFound() {
    if (findErr) {
      setChildren(list, h('li', { class: 'vw-nav-msg is-error' }, `Couldn’t search: ${findErr}`));
      return;
    }
    if (!allPaths) {
      setChildren(list, h('li', null, loading('Searching…')));
      return;
    }
    const hits = matchPaths(query, allPaths, FOUND_SHOWN);
    if (!hits.length) {
      setChildren(list, h('li', { class: 'vw-nav-msg' }, `No file matches “${query}”.`));
      return;
    }
    setChildren(list,
      ...hits.map(({ path, indices }) => {
        const cut = path.lastIndexOf('/') + 1;
        const name = markMatches(path.slice(cut), indices.filter((i) => i >= cut).map((i) => i - cut));
        const dir = cut ? h('span', { class: 'vw-entry-dir' }, markMatches(path.slice(0, cut), indices.filter((i) => i < cut))) : null;
        return entryRow(path, false, [h('span', null, name), dir].filter(Boolean) as Node[], '', 'is-found');
      }),
    );
  }

  function clearFind() {
    if (!query && !findInput.value) return;
    query = '';
    findInput.value = '';
  }

  async function ensureFound() {
    const s = fileSrc();
    if (!s || allPaths || findLoading) return;
    findLoading = true;
    findErr = null;
    try {
      const got = await findFiles(store, s.folder);
      if (fileSrc() !== s) return;
      allPaths = got.paths ?? [];
      if (got.truncated) {
        navNote.hidden = false;
        navNote.textContent = 'This folder has a lot of files: only some are searched.';
      }
    } catch (err) {
      if (fileSrc() === s) findErr = (err as Error).message;
    } finally {
      findLoading = false;
    }
    if (query) renderNav();
  }

  let findTimer: ReturnType<typeof setTimeout> | null = null;
  findInput.addEventListener('input', () => {
    if (findTimer) clearTimeout(findTimer);
    findTimer = setTimeout(() => {
      query = findInput.value.trim();
      if (query) void ensureFound();
      renderNav();
    }, 90);
  });
  findInput.addEventListener('keydown', (ev) => {
    if (ev.isComposing) return;
    if (ev.key === 'Escape' && findInput.value) {
      ev.preventDefault();
      ev.stopPropagation(); // the first Esc clears the search, the next closes the viewer
      clearFind();
      renderNav();
    } else if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      list.querySelector<HTMLElement>('.vw-entry')?.focus();
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      if (findTimer) {
        clearTimeout(findTimer);
        query = findInput.value.trim();
        renderNav();
      }
      list.querySelector<HTMLButtonElement>('.vw-entry')?.click();
    }
  });

  list.addEventListener('keydown', (ev) => {
    const items = [...list.querySelectorAll<HTMLElement>('.vw-entry')];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    const go = (n: number) => {
      ev.preventDefault();
      items[Math.max(0, Math.min(items.length - 1, n))]?.focus();
    };
    if (ev.key === 'ArrowDown') go(i + 1);
    else if (ev.key === 'ArrowUp') i === 0 && query ? (ev.preventDefault(), findInput.focus()) : go(i - 1);
    else if (ev.key === 'Home') go(0);
    else if (ev.key === 'End') go(items.length - 1);
    else if (ev.key === 'ArrowLeft' && !query) {
      ev.preventDefault();
      goUp();
    } else if (ev.key === 'ArrowRight' && items[i].classList.contains('is-dir')) {
      ev.preventDefault();
      items[i].click();
      requestAnimationFrame(() => list.querySelector<HTMLElement>('.vw-entry')?.focus({ preventScroll: true }));
    }
  });

  /** Open a file of the folder on show (from the list, a link inside a Markdown file, j/k). */
  function pick(path: string) {
    const s = fileSrc();
    if (!s) return;
    if (isPhone()) setDrawer(false);
    if (path === s.path) return;
    s.path = path;
    resetPerFile();
    renderHead();
    markCurrent();
    void loadView();
    if (dirName(path) !== s.dir && !query) {
      s.dir = dirName(path);
      void loadListing(s.dir);
    }
  }

  function markCurrent() {
    const cur = currentPath();
    list.querySelectorAll<HTMLElement>('.vw-entry').forEach((b) => {
      const on = b.dataset.path === cur && !b.classList.contains('is-dir');
      b.classList.toggle('is-on', on);
      if (on) b.setAttribute('aria-current', 'true');
      else b.removeAttribute('aria-current');
    });
  }

  /** The files of the folder on the left (the one the file on show is in). */
  function folderFiles(): string[] {
    const s = fileSrc();
    if (!s || !listing || listing.dir !== s.dir) return [];
    return listing.entries.filter((e) => !e.isDir).map((e) => (s.dir ? `${s.dir}/${e.name}` : e.name));
  }

  /** j / k (and the arrows in the header): the next / previous file of the folder on the left. */
  function step(by: number) {
    const s = fileSrc();
    const files = folderFiles();
    if (!s || !files.length) return;
    const i = s.path ? files.indexOf(s.path) : -1;
    pick(files[(i + by + files.length) % files.length]);
  }

  // ── Body ──
  function resetPerFile() {
    showSource = false;
    showRaw = false;
    imageDims = '';
    fileSize = null;
    updatedFlash = false;
    version = 0;
  }

  function stopBody() {
    // a page's scripts and sounds stop with it
    pageFrame = pageBars = asking = null;
    body.querySelectorAll('iframe').forEach((f) => f.setAttribute('src', 'about:blank'));
    body.querySelectorAll<HTMLMediaElement>('audio, video').forEach((m) => m.pause());
  }

  function setBody(...nodes: (Node | null)[]) {
    stopBody();
    body.classList.remove('is-flush', 'is-center');
    setChildren(body, ...nodes);
  }

  function failBox(err: unknown): HTMLElement {
    const { title, body: text } = failText(err);
    return stateBox(
      'alert',
      title,
      text,
      h('button', { type: 'button', class: 'btn btn-soft btn-sm', onclick: () => reload() }, vIcon('refresh', 14), 'Reload'),
      fileSrc()?.path ? h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => navigateAndShow() }, vIcon('folder', 14), 'Show its folder') : null,
    );
  }

  function navigateAndShow() {
    const s = fileSrc();
    if (!s) return;
    if (isPhone()) setDrawer(true);
    else if (navHidden) toggleNav();
    void loadListing(s.dir);
    list.querySelector<HTMLElement>('.vw-entry')?.focus();
  }

  function setTools(...nodes: (Node | null)[]) {
    setChildren(tools, ...nodes);
    tools.hidden = !nodes.some(Boolean);
  }

  async function loadView(keepScroll = false) {
    const seq = ++viewSeq;
    const s = src;
    const scroll = keepScroll ? body.scrollTop : 0;
    const stale = () => seq !== viewSeq || src !== s;
    setTools();
    if (!s) return;
    if (s.type === 'upload') {
      renderImage(uploadUrl(s.ref.id), s.label, false);
      return;
    }
    if (s.path === null) {
      renderFolderBody();
      return;
    }
    const path = s.path;
    if (!keepScroll) setBody(loading());
    let k: FilesKey;
    try {
      k = await ensureKey();
    } catch (err) {
      if (!stale()) setBody(failBox(err));
      return;
    }
    if (stale()) return;
    renderHead();
    const url = urlOf(k, path);
    const name = baseName(path);
    let kind: FileKind = fileKind(path);
    try {
      if (kind === 'image' || kind === 'svg' || kind === 'html' || kind === 'pdf' || kind === 'audio' || kind === 'video' || kind === 'binary') {
        const got = await probe(url);
        if (stale()) return;
        fileSize = got.size;
        renderHead();
        if ((kind === 'svg' && showSource) || (kind === 'html' && showSource)) {
          const text = await fetchText(url);
          if (stale()) return;
          await renderCode(text, name, 'xml');
        } else if (kind === 'image' || kind === 'svg') renderImage(url, name, kind === 'svg');
        else if (kind === 'html') renderHtml(url, name);
        else if (kind === 'pdf') pdfFrameOk(got.type) ? renderPdf(url, name) : renderBinary(name, got.size, got.type);
        else if (kind === 'audio' || kind === 'video') renderMedia(url, kind);
        else renderBinary(name, got.size, got.type);
      } else {
        const text = await fetchText(url, kind === 'unknown' ? 64 * 1024 : TEXT_LIMIT);
        if (stale()) return;
        if (kind === 'unknown') {
          const textual = /^text\/|json|javascript/.test(text.type) || (text.type === '' && looksLikeText(text.text));
          if (!textual) {
            fileSize = text.total;
            renderHead();
            renderBinary(name, text.total, text.type);
            return;
          }
          kind = 'text';
          const full = text.truncated ? await fetchText(url) : text;
          if (stale()) return;
          await renderText(full, name, kind);
        } else await renderText(text, name, kind);
        if (stale()) return;
        fileSize = text.total;
        renderHead();
      }
    } catch (err) {
      if (!stale()) setBody(failBox(err));
      return;
    }
    if (keepScroll && !stale()) requestAnimationFrame(() => (body.scrollTop = scroll));
  }

  function renderFolderBody() {
    const s = fileSrc();
    if (!s) return;
    setTools();
    const phone = isPhone();
    setBody(
      stateBox(
        'folder',
        s.dir ? `${baseName(s.dir)}/` : folderLabel(s.folder),
        phone ? 'Pick a file to see it here.' : 'Pick a file on the left to see it here. Pictures, web pages, PDFs, Markdown, code, tables, audio and video open right in CAST.',
        phone ? h('button', { type: 'button', class: 'btn btn-soft btn-sm', onclick: () => setDrawer(true) }, vIcon('sidebar', 14), 'Show files') : null,
      ),
    );
    body.classList.add('is-center');
  }

  function renderImage(url: string, name: string, svg: boolean) {
    const img = h('img', { class: 'vw-img', src: url, alt: name, decoding: 'async', draggable: 'false' });
    const stage = h('div', { class: ['vw-stage', 'is-checker', `is-${fit}`] }, img);
    img.addEventListener('load', () => {
      imageDims = `${img.naturalWidth} × ${img.naturalHeight}`;
      renderHead();
      stage.classList.toggle('is-small', img.naturalWidth <= stage.clientWidth && img.naturalHeight <= stage.clientHeight);
    });
    img.addEventListener('error', () => {
      setBody(stateBox('alert', 'Can’t show this image', 'The browser can’t read it — the file may be broken, half-written or not really an image.', h('button', { type: 'button', class: 'btn btn-soft btn-sm', onclick: () => reload() }, vIcon('refresh', 14), 'Reload')));
    });
    stage.addEventListener('click', () => setFit(fit === 'fit' ? 'actual' : 'fit'));
    setBody(stage);
    body.classList.add('is-flush');
    setTools(
      segmented<'fit' | 'actual'>(
        [
          { value: 'fit', label: 'Fit' },
          { value: 'actual', label: '1:1' },
        ],
        fit,
        (v) => setFit(v),
        'Image size',
      ),
      svg ? toggleBtn('source', 'Source', false, () => toggleSource()) : null,
    );
  }

  function setFit(v: 'fit' | 'actual') {
    fit = v;
    deviceStorage.set(FIT_KEY, v);
    const stage = body.querySelector('.vw-stage');
    stage?.classList.toggle('is-fit', v === 'fit');
    stage?.classList.toggle('is-actual', v === 'actual');
    tools.querySelectorAll<HTMLElement>('.segmented .seg').forEach((b, i) => {
      const on = (i === 0) === (v === 'fit');
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-checked', String(on));
    });
  }

  function toggleSource() {
    showSource = !showSource;
    void loadView();
  }

  function renderHtml(url: string, name: string) {
    const frame = h('iframe', { class: 'vw-frame', src: url, title: name, sandbox: HTML_SANDBOX, referrerpolicy: 'no-referrer', allow: '' });
    const bars = h('div', { class: 'vw-page-bars' });
    const wrapEl = h('div', { class: ['vw-frame-wrap', `is-${width}`] }, frame, bars);
    setBody(wrapEl, h('p', { class: 'vw-note' }, vIcon('globe', 13), 'Runs isolated: it can’t use your CAST session, it loads only from known CDNs, and anything it saves is gone when it reloads.'));
    body.classList.add('is-flush');
    pageFrame = frame;
    pageBars = bars;
    blocked.clear();
    blockedDismissed = false;
    setTools(
      segmented<'desktop' | 'phone'>(
        [
          { value: 'desktop', label: 'Desktop' },
          { value: 'phone', label: 'Phone' },
        ],
        width,
        (v) => {
          width = v;
          deviceStorage.set(WIDTH_KEY, v);
          wrapEl.classList.toggle('is-desktop', v === 'desktop');
          wrapEl.classList.toggle('is-phone', v === 'phone');
        },
        'Page width',
      ),
      toggleBtn('source', 'Source', false, () => toggleSource()),
    );
  }

  // ── A web page's messages (through its shell: server/files.ts PAGE_SHIM) ──
  window.addEventListener('message', (ev) => {
    if (!pageFrame || !shown || ev.source !== pageFrame.contentWindow || ev.origin !== 'null') return;
    const msg = pageMessage(ev.data);
    if (!msg) return;
    if (msg.t === 'blocked') {
      if (!blocked.has(msg.host) && blocked.size >= BLOCKED_HOSTS_MAX) return;
      const dirs = blocked.get(msg.host) ?? new Set<string>();
      const dir = msg.directive.replace(/-(elem|attr)$/, '');
      if (dirs.has(dir)) return; // nothing new: no re-render (it would rebuild the ask bar under the user's pointer)
      dirs.add(dir);
      blocked.set(msg.host, dirs);
      return renderBars();
    }
    const target = openTarget(msg.url, location.origin, key?.base ?? null);
    if (!target) return;
    // Only right after a click or key press (the shell checks it was one in the page; the browser passes it up to
    // CAST too): a page can't pop the question, or a tab, on its own.
    if (navigator.userActivation && !navigator.userActivation.isActive) return console.warn(`[viewer] the page tried to open ${msg.url.slice(0, 200)} without a click`);
    if (target.kind === 'house') window.open(target.url, '_blank', 'noopener,noreferrer'); // another file of this house: sandboxed too
    else if (!asking) {
      asking = target;
      askArmedAt = performance.now() + ASK_ARM_MS;
      renderBars();
    }
  });

  /** The bars over a web page: "Open <host>?" (the page asked to leave for another site) and the blocked note. */
  function renderBars() {
    if (!pageBars) return;
    const ask = asking;
    let askEl: HTMLElement | null = null;
    if (ask) {
      const answer = (go: boolean) => {
        if (go) window.open(ask.url, '_blank', 'noopener,noreferrer');
        asking = null;
        renderBars();
      };
      // aria-disabled, not disabled: a press on it must still reach us, to push the wake-up back
      const armed = () => performance.now() >= askArmedAt;
      const showArmed = () => {
        if (armed()) openBtn.removeAttribute('aria-disabled');
        else {
          openBtn.setAttribute('aria-disabled', 'true');
          setTimeout(showArmed, askArmedAt - performance.now() + 15);
        }
      };
      const rearm = () => {
        askArmedAt = performance.now() + ASK_ARM_MS;
        showArmed();
      };
      const openBtn = h('button', { type: 'button', class: 'btn btn-primary btn-sm', onclick: () => (armed() ? answer(true) : rearm()) }, vIcon('external', 14), 'Open');
      showArmed();
      askEl = h(
        'div',
        { class: 'vw-ask', role: 'alertdialog', 'aria-labelledby': 'vw-ask-title', onpointerdown: () => armed() || rearm() },
        h('div', { class: 'vw-ask-text' },
          h('strong', { id: 'vw-ask-title' }, `Open ${ask.host}?`),
          h('span', null, 'This page wants to take you to another site. It opens in a new tab, with only what is in this link:'),
          h('code', { class: 'vw-ask-url', title: ask.url }, ask.url),
        ),
        h('div', { class: 'vw-ask-actions' }, h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => answer(false) }, 'Cancel'), openBtn),
      );
    }
    let note: HTMLElement | null = null;
    if (blocked.size && !blockedDismissed) {
      const hosts = [...blocked.keys()];
      const what = hosts.length === 1 ? hosts[0] : `${hosts[0]} and ${hosts.length - 1} more`;
      note = h(
        'div',
        { class: 'vw-blocked', role: 'status', title: [...blocked].map(([host, dirs]) => `${host} (${[...dirs].join(', ')})`).join('\n') },
        vIcon('alert', 13),
        h('span', null, `Blocked ${what} — CAST only lets pages load from known CDNs`),
        h('button', { type: 'button', class: 'icon-btn vw-blocked-x', 'aria-label': 'Dismiss', title: 'Dismiss', onclick: () => { blockedDismissed = true; renderBars(); } }, vIcon('x', 13)),
      );
    }
    setChildren(pageBars, askEl, note);
  }

  function renderPdf(url: string, name: string) {
    // No sandbox attribute: a sandboxed frame kills Chrome's PDF viewer. The server's CSP sandbox still applies.
    const frame = h('iframe', { class: 'vw-frame', src: url, title: name, referrerpolicy: 'no-referrer' });
    setBody(
      isIOS()
        ? h('p', { class: 'vw-note is-top' }, vIcon('external', 13), 'On iPhone and iPad only the first page may show here — ', h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, 'open it in a new tab'), ' to read it all.')
        : null,
      h('div', { class: 'vw-frame-wrap is-desktop is-pdf' }, frame),
    );
    body.classList.add('is-flush');
  }

  function renderMedia(url: string, kind: 'audio' | 'video') {
    const media = kind === 'video'
      ? h('video', { class: 'vw-video', src: url, controls: true, playsinline: true, preload: 'metadata' })
      : h('audio', { class: 'vw-audio', src: url, controls: true, preload: 'metadata' });
    media.addEventListener('error', () => setBody(stateBox('alert', 'Can’t play this', 'This browser can’t play this file. Download it to play it elsewhere.', downloadBtn())));
    setBody(h('div', { class: ['vw-media', `is-${kind}`] }, media));
    body.classList.add('is-center');
  }

  function downloadBtn(): HTMLElement | null {
    const s = fileSrc();
    if (!s?.path || !key) return null;
    return h('a', { class: 'btn btn-soft btn-sm', href: fileUrl(key.base, s.path), download: baseName(s.path) }, vIcon('download', 14), 'Download');
  }

  function renderBinary(name: string, size: number | null, type: string) {
    const s = fileSrc();
    const url = s?.path && key ? fileUrl(key.base, s.path) : null;
    setBody(
      stateBox(
        'file',
        name,
        `${[kindLabel(name), size !== null ? fmtBytes(size) : '', type && !type.startsWith('application/octet-stream') ? type.split(';')[0] : ''].filter(Boolean).join(' · ')}. CAST can’t show this kind of file — download it, or try opening it in a new tab.`,
        downloadBtn(),
        url ? h('a', { class: 'btn btn-ghost btn-sm', href: url, target: '_blank', rel: 'noopener noreferrer' }, vIcon('external', 14), 'Open in new tab') : null,
      ),
    );
    body.classList.add('is-center');
  }

  function truncNote(f: Fetched): HTMLElement | null {
    return f.truncated ? h('p', { class: 'vw-note is-top' }, vIcon('alert', 13), `Only the first ${fmtBytes(TEXT_LIMIT)} of ${fmtBytes(f.total ?? undefined)} are shown. Download it for the rest.`) : null;
  }

  async function renderText(f: Fetched, name: string, kind: FileKind) {
    if (kind === 'markdown') {
      setTools(segmentedRaw('Preview', 'Markdown'));
      if (!showRaw) return renderMd(f);
      return renderCode(f, name, 'markdown', true);
    }
    if (kind === 'csv' || kind === 'tsv') {
      setTools(segmentedRaw('Table', 'Raw'));
      if (!showRaw) return renderTable(f, kind === 'tsv' ? '\t' : sniffDelimiter(f.text));
      return renderCode(f, name, null, true);
    }
    if (kind === 'json' && !f.truncated && f.text.length <= TEXT_LIMIT) {
      try {
        const pretty = JSON.stringify(JSON.parse(f.text), null, 2);
        return renderCode({ ...f, text: pretty }, name, 'json');
      } catch {
        /* not valid JSON (jsonc, json5, a half-written file): as written */
      }
    }
    return renderCode(f, name, hljsLanguage(name));
  }

  function segmentedRaw(a: string, b: string): HTMLElement {
    return segmented<'a' | 'b'>(
      [
        { value: 'a', label: a },
        { value: 'b', label: b },
      ],
      showRaw ? 'b' : 'a',
      (v) => {
        showRaw = v === 'b';
        void loadView();
      },
      'Show as',
    );
  }

  async function renderCode(f: Fetched, name: string, lang: string | null, keepTools = false) {
    const seq = viewSeq;
    const text = trimFinalNewline(f.text);
    let lines: string[] | null = null;
    if (lang && text.length <= HIGHLIGHT_LIMIT) {
      try {
        const mod = await import('./hljs');
        const html = mod.highlight(text, lang);
        if (html !== null) lines = splitHighlightedLines(html);
      } catch (err) {
        console.warn('[viewer] highlighter failed to load', err);
      }
      if (seq !== viewSeq) return;
    }
    lines ??= plainLines(text);
    const code = h('div', { class: ['vw-code', 'hljs', wrap && 'is-wrap'], style: { '--vw-gutter': `${String(lines.length).length + 1}ch` } });
    // The line's text sits in its own span: .vw-ln is a flex row (gutter + text), and a flex row drops whitespace-only
    // text nodes — the spaces between two highlighted tokens and a line's indent would vanish.
    code.innerHTML = lines.map((l, i) => `<div class="vw-ln" data-n="${i + 1}"><span class="vw-lt">${l}</span></div>`).join('');
    setBody(truncNote(f), text ? code : stateBox('doc', 'Empty file', 'There is nothing in it yet.'));
    body.classList.add('is-flush');
    const wrapBtn = toggleBtn('wrap', 'Wrap', wrap, () => {
      wrap = !wrap;
      deviceStorage.set(WRAP_KEY, wrap ? '1' : '0');
      code.classList.toggle('is-wrap', wrap);
      wrapBtn.classList.toggle('is-on', wrap);
      wrapBtn.setAttribute('aria-pressed', String(wrap));
    });
    const kind = fileKind(name);
    if (keepTools) tools.append(wrapBtn);
    else setTools((kind === 'svg' || kind === 'html') && showSource ? toggleBtn('source', 'Source', true, () => toggleSource()) : null, wrapBtn);
  }

  function renderMd(f: Fetched) {
    const s = fileSrc();
    if (!s?.path || !key) return;
    const k = key;
    const folder = s.folder;
    const roots: RootChoice[] = [{ root: k.root.replace(/\/+$/, '') || '/', folder }];
    const html = renderMarkdown(trimFinalNewline(f.text), {
      resolve: (raw) => resolvePath(raw, roots, dirName(s.path!)),
      srcNow: (ref) => (sameFolder(ref.folder, folder) ? fileUrl(k.base, ref.path) : null),
    });
    const doc = h('article', { class: 'md vw-md', html });
    doc.addEventListener('click', (ev) => {
      const a = (ev.target as Element).closest('a');
      if (!a || !doc.contains(a)) return;
      if (a.classList.contains('md-file')) {
        ev.preventDefault();
        const ref = fileRefOf(a);
        if (ref) openRef(ref);
      } else if (a.getAttribute('href')?.startsWith('#')) {
        ev.preventDefault(); // an in-page anchor: never the app's own URL
        const id = decodeURIComponent(a.getAttribute('href')!.slice(1));
        doc.querySelector(`[id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      }
    });
    setBody(truncNote(f), f.text.trim() ? doc : stateBox('doc', 'Empty file', 'There is nothing in it yet.'));
  }

  function renderTable(f: Fetched, delimiter: string) {
    const table = parseDelimited(f.text, delimiter, CSV_ROWS + 1);
    if (!table.rows.length) return setBody(stateBox('table', 'Empty table', 'There is nothing in it yet.'));
    const cols = Math.max(...table.rows.map((r) => r.length));
    const cell = (tag: 'th' | 'td', v: string) => `<${tag}>${escapeHtml(v)}</${tag}>`;
    const [header, ...rows] = table.rows;
    const pad = (r: string[]) => (r.length < cols ? [...r, ...Array(cols - r.length).fill('')] : r);
    const html =
      `<thead><tr><th class="vw-rn">#</th>${pad(header).map((v) => cell('th', v)).join('')}</tr></thead>` +
      `<tbody>${rows.map((r, i) => `<tr><td class="vw-rn">${i + 1}</td>${pad(r).map((v) => cell('td', v)).join('')}</tr>`).join('')}</tbody>`;
    const el2 = h('table', { class: 'vw-table', html });
    const more = table.more || f.truncated;
    setBody(
      more ? h('p', { class: 'vw-note is-top' }, vIcon('table', 13), `The first ${rows.length.toLocaleString()} rows are shown. Switch to Raw, or download it, for all of it.`) : null,
      h('div', { class: 'vw-table-wrap' }, el2),
    );
    body.classList.add('is-flush');
  }

  /** A link inside a Markdown file: open it here (a folder: show it on the left). */
  function openRef(ref: FileRef) {
    const s = fileSrc();
    if (!s || !sameFolder(s.folder, ref.folder)) return openFileAt(ref);
    if (ref.dir) navigate(ref.path);
    else pick(ref.path);
  }

  // ── Reload / live updates ──
  function reload(keepScroll = true) {
    if (src?.type !== 'file') return void loadView();
    version++;
    void loadView(keepScroll);
    void loadListing(src.dir, true);
  }

  /** A person wrote files: reload the open one (and the listing of the folder on show) a moment later. */
  function onWrite(paths: string[], roots: RootChoice[]) {
    const s = fileSrc();
    if (!s) return;
    let hit = false;
    for (const p of paths) {
      const r = resolvePath(p, roots);
      if (!r?.ok || !sameFolder(r.folder, s.folder)) continue;
      hit = true;
      if (r.path === s.path) touched.open = true;
      touched.dirs.add(dirName(r.path));
    }
    if (!hit) return;
    forgetFound(s.folder);
    allPaths = null;
    if (touchTimer) clearTimeout(touchTimer);
    touchTimer = setTimeout(() => {
      touchTimer = null;
      const cur = fileSrc();
      if (!cur || !shown) return;
      if (touched.open) {
        version++;
        void loadView(true).then(() => {
          updatedFlash = true;
          renderHead();
          setTimeout(() => {
            updatedFlash = false;
            renderHead();
          }, 2400);
        });
      }
      if (touched.dirs.has(cur.dir)) void loadListing(cur.dir, true);
      touched.open = false;
      touched.dirs.clear();
    }, 500);
  }

  store.subscribe((_s, msg) => {
    if (!shown || !msg) return;
    if (msg.t === 'transcript_upsert' && msg.item.kind === 'tool' && msg.item.status === 'done' && !msg.item.isError && msg.item.paths?.length && WRITES.test(msg.item.tool)) {
      const roots = personRoots(store.state.agents[msg.agentId], (id) => store.project(id), (p, j) => store.job(p, j));
      onWrite(msg.item.paths, roots);
    } else if ((msg.t === 'city' || msg.t === 'jobs' || msg.t === 'snapshot') && src?.type === 'file') {
      renderHead(); // a renamed house or job
    }
  });

  // ── Keys ──
  panel.addEventListener('keydown', (ev) => {
    if (ev.defaultPrevented || ev.metaKey || ev.ctrlKey || ev.altKey || ev.isComposing) return;
    const t = ev.target as HTMLElement;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t.isContentEditable) return;
    if (t instanceof HTMLMediaElement) return;
    if (ev.key === 'j' || ev.key === 'J') step(1);
    else if (ev.key === 'k' || ev.key === 'K') step(-1);
    else if (ev.key === 'r' || ev.key === 'R') reload();
    else if (ev.key === '+' || ev.key === '=') sizeText(1);
    else if (ev.key === '-' || ev.key === '_') sizeText(-1);
    else if (ev.key === '/' && src?.type === 'file') {
      if (isPhone()) setDrawer(true);
      else if (navHidden) toggleNav();
      findInput.focus();
    } else return;
    ev.preventDefault();
  });

  const phoneQuery = window.matchMedia(PHONE);
  phoneQuery.addEventListener?.('change', () => {
    setDrawer(false);
    panel.classList.toggle('nav-hidden', !phoneQuery.matches && navHidden);
    syncNavBtn();
  });

  // ── Open / close ──
  function show() {
    if (!el.isConnected) shell.root.appendChild(el);
    if (shown) return;
    shown = true;
    previousFocus = markFocus();
    el.hidden = false;
    requestAnimationFrame(() => {
      if (!shown) return; // closed again before the first frame
      el.classList.add('is-open');
      (isPhone() ? closeBtn : body).focus({ preventScroll: true });
    });
    removeLayer = shell.layers.push({ id: 'viewer', close: () => close(), modal: true });
    untrap = trapFocus(panel);
  }

  function close() {
    if (!shown) return;
    shown = false;
    removeLayer?.();
    untrap?.();
    removeLayer = untrap = null;
    el.classList.remove('is-open');
    stopBody();
    viewSeq++;
    setTimeout(() => {
      if (shown) return; // opened again meanwhile
      el.hidden = true;
      setChildren(body);
    }, 180);
    restoreFocus(previousFocus);
  }

  function openFileAt(ref: FileRef) {
    const prev = fileSrc();
    const sameF = !!prev && sameFolder(prev.folder, ref.folder);
    const path = ref.dir ? null : ref.path;
    const dir = ref.dir ? ref.path.replace(/\/+$/, '') : dirName(ref.path);
    src = { type: 'file', folder: ref.folder, path, dir };
    if (!sameF) {
      key = null;
      allPaths = null;
      findErr = null;
      listing = null;
    }
    clearFind();
    resetPerFile();
    panel.classList.toggle('nav-hidden', !isPhone() && navHidden);
    setDrawer(isPhone() && path === null);
    show();
    renderHead();
    renderNav();
    void loadListing(dir, sameF);
    void loadView();
  }

  return {
    openFile: openFileAt,
    openUpload(ref, label) {
      src = { type: 'upload', ref, label };
      resetPerFile();
      setDrawer(false);
      show();
      renderHead();
      void loadView();
    },
  };
}
