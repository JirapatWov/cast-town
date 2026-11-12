// Terminal dock: real shells on the server (shared/terminal-protocol.ts), one tab per place — the town
// (workspace root), a project folder, or a job's own copy of the files (Job.worktree). NOT an omp session: nothing
// typed here goes to a model.
// xterm.js loads on first open so it never weighs on the town's first load. Shells outlive the dock, page
// reloads and dropped connections; a reconnect resumes from the last byte this tab saw.
import type { FitAddon } from '@xterm/addon-fit';
import type { ITheme, Terminal } from '@xterm/xterm';
import type { Job } from '../../../shared/protocol';
import {
  TERM_INPUT_CHUNK, TERM_TOWN, TERM_WS_PATH, type TermClientMsg, type TermServerMsg,
} from '../../../shared/terminal-protocol';
import { wsUrl } from '../net/base';
import { onA11yPref, a11yPref, setA11yPref } from './a11y-prefs';
import { currentTheme, onThemeChange, type Theme } from './theme';
import { deviceStorage, h, rootFontScale, setChildren, storage } from './dom';
import { markFocus, restoreFocus, type FocusMark } from './focus';
import { icon } from './icons';
import { openMenu, type MenuItem } from './menu';
import type { Shell } from './shell';
import { confirmTerminal, terminalWhoChip } from './terminal-gate';
import { isTouchUI } from './touch';
import { noHousesItem } from './town-loading';

const TABS_KEY = 'rlt.term.tabs';
const ACTIVE_KEY = 'rlt.term.active';
const HEIGHT_KEY = 'rlt.term.h';
const MIN_H = 160;
const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 8000;

const DARK_THEME: ITheme = {
  background: '#00000000',
  foreground: '#ece7e1',
  cursor: '#f5c26b',
  cursorAccent: '#17161a',
  selectionBackground: 'rgba(245, 194, 107, 0.3)',
  black: '#2c2a2b', red: '#ef6f6c', green: '#7fcf9a', yellow: '#f2c46d',
  blue: '#7aa7f7', magenta: '#c79bf2', cyan: '#6fd0d6', white: '#d9d4cd',
  brightBlack: '#77706a', brightRed: '#ff8a8d', brightGreen: '#9fe0b5', brightYellow: '#ffd88f',
  brightBlue: '#a9c6fa', brightMagenta: '#dcbaf8', brightCyan: '#98e4e8', brightWhite: '#f7f3ee',
};
/** The light theme's terminal (#77): dark ink on the light dock; the ANSI colours darkened to read on it (AA for the
 *  normal ones; "white" stays a light grey, as programs use it for backgrounds and dim text). */
const LIGHT_THEME: ITheme = {
  background: '#00000000',
  foreground: '#2b2520',
  cursor: '#966200',
  cursorAccent: '#fbfaf8',
  selectionBackground: 'rgba(150, 98, 0, 0.22)',
  black: '#2b2520', red: '#b3261e', green: '#2f6f1f', yellow: '#7d5500',
  blue: '#2a5aa8', magenta: '#8a3a9a', cyan: '#176b73', white: '#8a8279',
  brightBlack: '#5e564f', brightRed: '#c53a32', brightGreen: '#3a7f28', brightYellow: '#8f6300',
  brightBlue: '#3567c8', brightMagenta: '#9c48ad', brightCyan: '#1f7b84', brightWhite: '#a39b92',
};
const termTheme = (t: Theme): ITheme => (t === 'light' ? LIGHT_THEME : DARK_THEME);

const DIM = (s: string) => `\x1b[2m${s}\x1b[0m`;

type Xterm = {
  Terminal: typeof Terminal;
  FitAddon: typeof FitAddon;
  Unicode11Addon: typeof import('@xterm/addon-unicode11').Unicode11Addon;
  WebLinksAddon: typeof import('@xterm/addon-web-links').WebLinksAddon;
};
let xtermLoading: Promise<Xterm> | null = null;
function loadXterm(): Promise<Xterm> {
  xtermLoading ??= Promise.all([
    import('@xterm/xterm'),
    import('@xterm/addon-fit'),
    import('@xterm/addon-unicode11'),
    import('@xterm/addon-web-links'),
    import('@xterm/xterm/css/xterm.css'),
    // xterm measures the cell size once; measuring a fallback font would misplace every glyph later.
    document.fonts?.load('13px "JetBrains Mono"').catch(() => undefined),
  ]).then(([x, fit, uni, links]) => ({
    Terminal: x.Terminal,
    FitAddon: fit.FitAddon,
    Unicode11Addon: uni.Unicode11Addon,
    WebLinksAddon: links.WebLinksAddon,
  }));
  return xtermLoading;
}

type TabState = 'connecting' | 'live' | 'exited' | 'offline' | 'closed';

/** A job's shell target (shared/terminal-protocol.ts): the folder that job works in. */
export const termJobTarget = (projectId: string, jobId: string): string => `${projectId}:${jobId}`;

/** The shell for working on a house as the panels show it: the current job's own copy of the files when it has one
 *  (its people work there, not in the house folder), else the house folder. */
export function houseTermTarget(shell: Shell, projectId: string): string {
  const job = shell.jobs.active(projectId);
  return job?.worktree ? termJobTarget(projectId, job.id) : projectId;
}

interface Tab {
  target: string;
  host: HTMLElement;
  term: Terminal;
  fit: FitAddon;
  ws: WebSocket | null;
  sid: string | null;
  offset: number; // stream bytes received
  state: TabState;
  retries: number;
  timer: ReturnType<typeof setTimeout> | null;
  title: string; // set by the shell (OSC 0/2), e.g. "root@host: ~/project"
  cwd: string;
  noticeShown: boolean; // "connection lost" printed for this outage
}

export function createTerminalDock(shell: Shell) {
  const { store } = shell;
  const tabs: Tab[] = [];
  let active: Tab | null = null;
  let restored = false;
  let maximized = false;
  // the dock's height: this screen's, the same in every city
  let height = Number(deviceStorage.get(HEIGHT_KEY)) || Math.round(Math.min(380, window.innerHeight * 0.42));

  const tabBar = h('div', { class: 'term-tabs', role: 'tablist', 'aria-label': 'Terminals' });
  const addBtn = h('button', { type: 'button', class: 'icon-btn term-add', 'aria-label': 'New terminal', title: 'New terminal', 'aria-haspopup': 'menu' }, icon('plus', 16));
  const title = h('div', { class: 'term-title' });
  const maxBtn = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Maximize terminal', title: 'Maximize' }, icon('focus', 16));
  const hideBtn = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Hide terminal', title: 'Hide (Ctrl+`) — shells keep running' }, icon('chevronDown', 18));
  // Screen-reader mode (xterm mirrors the output into a list a reader can browse): a per-device setting, also in
  // Settings. The hint is the shell input's description: Tab and Esc belong to the shell, Ctrl+` is the way out.
  const readerBtn = h('button', { type: 'button', class: 'icon-btn term-reader', 'aria-label': 'Screen reader support', title: 'Screen reader support: lets screen readers read the output' }, icon('reader', 16));
  const hint = h('span', { class: 'sr-only', id: 'term-hint' }, 'Plain shell on this machine. Press Control and backquote to leave the terminal; shells keep running.');
  let opener: FocusMark | null = null; // focus goes back here when the dock hides
  const body = h('div', { class: 'term-body' });
  const resizer = h('div', { class: 'term-resize', role: 'separator', 'aria-orientation': 'horizontal', 'aria-label': 'Resize terminal', title: 'Drag to resize' });
  const keys = h('div', { class: 'term-keys', 'aria-label': 'Terminal keys' });
  const el = h(
    'section',
    { class: 'term-dock glass-strong', role: 'region', 'aria-label': 'Terminal', tabindex: '-1', hidden: true },
    resizer,
    h('header', { class: 'term-head' },
      tabBar,
      addBtn,
      title,
      h('span', { class: 'term-chip', title: 'Commands run directly on this machine — nothing here is sent to an AI model' }, icon('terminal', 13), 'Plain shell'),
      terminalWhoChip(),
      readerBtn,
      maxBtn,
      hideBtn,
    ),
    hint,
    body,
    keys,
  );
  const renderReader = () => {
    const on = a11yPref('termReader');
    readerBtn.setAttribute('aria-pressed', String(on));
    readerBtn.classList.toggle('is-on', on);
  };
  renderReader();
  readerBtn.addEventListener('click', () => setA11yPref('termReader', !a11yPref('termReader')));
  onThemeChange((t) => {
    for (const tab of tabs) tab.term.options.theme = termTheme(t);
  });
  onA11yPref((pref, on) => {
    if (pref !== 'termReader') return;
    renderReader();
    for (const t of tabs) t.term.options.screenReaderMode = on;
  });

  // ───────── place helpers ─────────
  /** A job target's job ("<projectId>:<jobId>"); undefined for the town, a house, or a job that is gone. */
  function jobOf(target: string): Job | undefined {
    const i = target.indexOf(':');
    return i < 0 ? undefined : store.job(target.slice(0, i), target.slice(i + 1));
  }
  function labelOf(target: string): string {
    if (target === TERM_TOWN) return 'Town';
    const i = target.indexOf(':');
    if (i < 0) return store.project(target)?.name ?? target;
    const job = jobOf(target);
    return job ? `${store.project(job.projectId)?.name ?? job.projectId} · ${job.name}` : target;
  }
  function targetExists(target: string): boolean {
    return target === TERM_TOWN || (target.includes(':') ? !!jobOf(target) : !!store.project(target));
  }
  function defaultTarget(): string {
    const { view, projectId } = shell.view;
    return view === 'house' && projectId && store.project(projectId) ? houseTermTarget(shell, projectId) : TERM_TOWN;
  }
  function persist() {
    storage.set(TABS_KEY, JSON.stringify(tabs.map((t) => t.target)));
    if (active) storage.set(ACTIVE_KEY, active.target);
  }

  // ───────── connection ─────────
  function send(tab: Tab, msg: TermClientMsg) {
    if (tab.ws?.readyState === WebSocket.OPEN) tab.ws.send(JSON.stringify(msg));
  }

  function connect(tab: Tab) {
    if (tab.state === 'closed') return;
    if (tab.timer) clearTimeout(tab.timer);
    tab.timer = null;
    const q = new URLSearchParams({ target: tab.target, cols: String(tab.term.cols), rows: String(tab.term.rows) });
    if (tab.sid) {
      q.set('sid', tab.sid);
      q.set('since', String(tab.offset));
    }
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl(`${TERM_WS_PATH}?${q}`));
    } catch {
      return retryLater(tab);
    }
    ws.binaryType = 'arraybuffer';
    tab.ws = ws;
    if (tab.state !== 'offline') setState(tab, 'connecting');
    let fatal = false;

    ws.onmessage = (ev) => {
      if (ws !== tab.ws) return;
      if (typeof ev.data !== 'string') {
        const bytes = new Uint8Array(ev.data as ArrayBuffer);
        tab.offset += bytes.length;
        tab.term.write(bytes);
        return;
      }
      let msg: TermServerMsg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.t === 'ready') {
        const hadOutput = tab.offset > 0 || tab.sid !== null;
        if (msg.mode === 'replay') tab.term.reset();
        else if (msg.mode === 'fresh' && hadOutput) tab.term.write(`\r\n${DIM('── new shell ──')}\r\n`);
        else if (tab.noticeShown) tab.term.write(`${DIM('[reconnected]')}\r\n`);
        tab.sid = msg.sid;
        tab.offset = msg.offset;
        tab.cwd = msg.cwd;
        tab.retries = 0;
        tab.noticeShown = false;
        setState(tab, msg.running ? 'live' : 'exited');
        if (!msg.running) queueMicrotask(() => exitNotice(tab, msg.exitCode));
      } else if (msg.t === 'exit') {
        setState(tab, 'exited');
        exitNotice(tab, msg.code);
      } else if (msg.t === 'started') {
        setState(tab, 'live');
      } else if (msg.t === 'error') {
        if (msg.fatal) {
          fatal = true;
          if (tab.state !== 'closed') {
            tab.term.write(`\r\n\x1b[31m${msg.message}\x1b[0m\r\n`);
            setState(tab, 'exited');
            tab.sid = null; // the server forgot this shell; Enter starts a new one
            tab.term.write(`${DIM('Press Enter to open a new shell here.')}\r\n`);
          }
        } else shell.toast('error', msg.message);
      }
    };
    ws.onclose = () => {
      if (ws !== tab.ws) return;
      tab.ws = null;
      if (tab.state === 'closed' || fatal) return;
      if (!tab.noticeShown && tab.offset > 0) {
        tab.term.write(`\r\n${DIM('[connection lost — reconnecting…]')}\r\n`);
        tab.noticeShown = true;
      }
      setState(tab, 'offline');
      retryLater(tab);
    };
  }

  function retryLater(tab: Tab) {
    if (tab.state === 'closed' || tab.timer) return;
    const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** tab.retries) * (0.8 + Math.random() * 0.4);
    tab.retries++;
    tab.timer = setTimeout(() => {
      tab.timer = null;
      connect(tab);
    }, delay);
  }

  function retryNow() {
    for (const t of tabs) if (t.state === 'offline' && !t.ws) connect(t);
  }
  window.addEventListener('online', retryNow);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') retryNow();
  });

  function exitNotice(tab: Tab, code: number | null) {
    const how = code === null ? '' : ` with code ${code}`;
    tab.term.write(`\r\n${DIM(`[shell exited${how} — press Enter to start a new one]`)}\r\n`);
  }

  function setState(tab: Tab, state: TabState) {
    tab.state = state;
    renderTabs();
  }

  function sendInput(tab: Tab, data: string) {
    if (tab.state === 'exited') {
      if (!data.includes('\r')) return;
      if (tab.ws?.readyState === WebSocket.OPEN && tab.sid) send(tab, { t: 'restart' });
      else connect(tab); // the shell was forgotten (or never came up): ask for a fresh one
      return;
    }
    if (tab.state !== 'live') return;
    for (let i = 0; i < data.length; i += TERM_INPUT_CHUNK) send(tab, { t: 'in', d: data.slice(i, i + TERM_INPUT_CHUNK) });
  }

  // ───────── tabs ─────────
  async function createTab(target: string): Promise<Tab> {
    const X = await loadXterm();
    const existing = tabs.find((t) => t.target === target);
    if (existing) return existing; // created while xterm was loading
    // Open on a visible host so xterm measures real cells and the shell starts at the right size.
    for (const t of tabs) t.host.hidden = true;
    const host = h('div', { class: 'term-host', role: 'tabpanel' });
    body.appendChild(host);
    const term = new X.Terminal({
      fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
      // follows the browser's text size like the rest of the UI (#55)
      fontSize: Math.round((window.innerWidth < 600 ? 12 : 13) * rootFontScale()),
      lineHeight: 1.18,
      cursorBlink: true,
      scrollback: 5000,
      allowTransparency: true,
      allowProposedApi: true, // unicode11 widths (Thai combining marks, emoji)
      macOptionIsMeta: true,
      theme: termTheme(currentTheme()),
      screenReaderMode: a11yPref('termReader'),
    });
    const fit = new X.FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new X.Unicode11Addon());
    term.unicode.activeVersion = '11';
    term.loadAddon(new X.WebLinksAddon((_ev, uri) => window.open(uri, '_blank', 'noopener')));
    term.open(host);
    term.textarea?.setAttribute('aria-describedby', 'term-hint');
    term.textarea?.setAttribute('aria-label', `Terminal input — ${labelOf(target)}`);

    const tab: Tab = {
      target, host, term, fit, ws: null, sid: null, offset: 0, state: 'connecting',
      retries: 0, timer: null, title: '', cwd: '', noticeShown: false,
    };
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown') return true;
      if (ev.ctrlKey && ev.code === 'Backquote') return false; // the global shortcut hides the dock
      if (ev.ctrlKey && ev.shiftKey && ev.code === 'KeyC') {
        // Ctrl+C stays SIGINT; Ctrl+Shift+C copies (and keeps Chrome's inspector from opening).
        if (term.hasSelection()) void navigator.clipboard?.writeText(term.getSelection()).catch(() => undefined);
        ev.preventDefault();
        return false;
      }
      if (ev.ctrlKey && ev.shiftKey && ev.code === 'KeyV') return false; // the browser pastes into xterm's textarea
      return true;
    });
    term.onData((d) => sendInput(tab, d));
    term.onResize(({ cols, rows }) => send(tab, { t: 'resize', cols, rows }));
    term.onTitleChange((t) => {
      tab.title = t;
      if (tab === active) renderTitle();
    });
    tabs.push(tab);
    if (!el.hidden) fitTab(tab);
    connect(tab);
    persist();
    return tab;
  }

  function activate(tab: Tab, focus = true) {
    active = tab;
    for (const t of tabs) t.host.hidden = t !== tab;
    renderTabs();
    renderTitle();
    persist();
    // Focus right away: keys typed before it lands would hit the town's single-key shortcuts instead.
    if (focus) tab.term.focus();
    requestAnimationFrame(() => fitTab(tab));
  }

  function closeTab(tab: Tab) {
    send(tab, { t: 'kill' });
    tab.state = 'closed';
    if (tab.timer) clearTimeout(tab.timer);
    const ws = tab.ws;
    tab.ws = null;
    // Give the kill frame a moment to leave before closing the socket.
    if (ws) setTimeout(() => ws.close(1000, 'Tab closed'), 150);
    tab.term.dispose();
    tab.host.remove();
    const i = tabs.indexOf(tab);
    tabs.splice(i, 1);
    if (active === tab) {
      active = tabs[Math.min(i, tabs.length - 1)] ?? null;
      if (active) activate(active);
      else hide();
    }
    renderTabs();
    persist();
  }

  /** The × stops the shell. On a touch screen it sits a fingertip from the tab's name: ask first while one runs. */
  async function askClose(tab: Tab) {
    if (isTouchUI() && tab.state === 'live') {
      const ok = await shell.confirm({
        title: 'Close this terminal?',
        body: `This stops the shell in ${labelOf(tab.target)} and anything still running in it.`,
        confirmLabel: 'Close terminal',
        tone: 'danger',
        icon: 'x',
      });
      if (!ok) return;
    }
    if (tabs.includes(tab)) closeTab(tab);
  }

  function fitTab(tab: Tab) {
    if (el.hidden || tab.host.hidden || !tab.host.clientWidth) return;
    try {
      tab.fit.fit();
    } catch {
      /* not measurable yet */
    }
  }

  new ResizeObserver(() => {
    if (active) fitTab(active);
  }).observe(body);

  // ───────── rendering ─────────
  const STATE_HINT: Record<TabState, string> = {
    connecting: 'Connecting…',
    live: 'Running',
    exited: 'Exited — press Enter to restart',
    offline: 'Reconnecting…',
    closed: 'Closed',
  };

  function renderTabs() {
    setChildren(tabBar,
      ...tabs.map((t) =>
        h('div', { class: ['term-tab', t === active && 'is-on', `is-${t.state}`], role: 'presentation' },
          h('button', {
            type: 'button',
            class: 'term-tab-main',
            role: 'tab',
            'aria-selected': t === active ? 'true' : 'false',
            title: `${t.cwd || labelOf(t.target)} · ${STATE_HINT[t.state]}`,
            onclick: () => activate(t),
          },
          h('span', { class: 'term-dot', 'aria-hidden': 'true' }),
          icon(t.target === TERM_TOWN ? 'building' : t.target.includes(':') ? 'copy' : 'home', 13),
          h('span', { class: 'term-tab-name' }, labelOf(t.target))),
          h('button', {
            type: 'button',
            class: 'term-tab-x',
            'aria-label': `Close ${labelOf(t.target)} terminal (stops the shell)`,
            title: 'Close — stops this shell',
            onclick: () => void askClose(t),
          }, icon('x', 12)),
        ),
      ),
    );
  }

  function renderTitle() {
    const t = active;
    title.textContent = t ? t.title || t.cwd : '';
    title.title = title.textContent ?? '';
  }

  function applyHeight() {
    const max = Math.max(MIN_H, window.innerHeight - 150);
    height = Math.min(max, Math.max(MIN_H, height));
    shell.root.style.setProperty('--term-h', `${height}px`);
  }

  // ───────── chrome interactions ─────────
  addBtn.addEventListener('click', () => {
    const open = new Set(tabs.map((t) => t.target));
    const item = (target: string, iconName: string, hint?: string): MenuItem => ({
      label: labelOf(target),
      icon: iconName,
      hint: hint ?? (open.has(target) ? 'open' : undefined),
      onSelect: () => void api.open(target),
    });
    // jobs with their own copy of the files work in that copy, not in the house folder: a shell each
    const copies = store.state.city.projects.flatMap((p) => store.jobsOf(p.id).filter((j) => j.worktree));
    openMenu(shell.root, shell.layers, addBtn, [
      { title: 'Shell in…', items: [item(TERM_TOWN, 'building', open.has(TERM_TOWN) ? 'open' : 'workspace')] },
      {
        title: 'Projects',
        items: store.state.city.projects.length
          ? store.state.city.projects.map((p) => item(p.id, 'home'))
          : [noHousesItem(store.state)],
      },
      ...(copies.length
        ? [{ title: 'Jobs’ own copies', items: copies.map((j) => { const t = termJobTarget(j.projectId, j.id); return item(t, 'copy', open.has(t) ? 'open' : 'own copy'); }) }]
        : []),
    ], { id: 'term-add-menu', placement: 'below', align: 'start', minWidth: 220 });
  });

  maxBtn.addEventListener('click', () => {
    maximized = !maximized;
    el.classList.toggle('is-max', maximized);
    maxBtn.setAttribute('aria-label', maximized ? 'Restore terminal size' : 'Maximize terminal');
    maxBtn.title = maximized ? 'Restore' : 'Maximize';
    requestAnimationFrame(() => active && fitTab(active));
  });
  hideBtn.addEventListener('click', () => hide());

  resizer.addEventListener('pointerdown', (ev) => {
    if (maximized) return;
    ev.preventDefault();
    resizer.setPointerCapture(ev.pointerId);
    const startY = ev.clientY;
    const startH = height;
    el.classList.add('is-resizing');
    const move = (e: PointerEvent) => {
      height = startH + (startY - e.clientY);
      applyHeight();
    };
    const up = () => {
      resizer.removeEventListener('pointermove', move);
      el.classList.remove('is-resizing');
      deviceStorage.set(HEIGHT_KEY, String(Math.round(height)));
      if (active) fitTab(active);
    };
    resizer.addEventListener('pointermove', move);
    resizer.addEventListener('pointerup', up, { once: true });
    resizer.addEventListener('pointercancel', up, { once: true });
  });
  window.addEventListener('resize', () => {
    if (!el.hidden) applyHeight();
  });

  // Touch keyboards have no Esc / Tab / Ctrl / arrows.
  const KEYS: [string, string][] = [['Esc', '\x1b'], ['Tab', '\t'], ['Ctrl-C', '\x03'], ['Ctrl-D', '\x04'], ['↑', '\x1b[A'], ['↓', '\x1b[B'], ['←', '\x1b[D'], ['→', '\x1b[C']];
  setChildren(keys, ...KEYS.map(([label, seq]) =>
    h('button', {
      type: 'button',
      class: 'term-key',
      onpointerdown: (ev: PointerEvent) => ev.preventDefault(), // keep the on-screen keyboard up
      onclick: () => {
        if (!active) return;
        sendInput(active, seq);
        active.term.focus();
      },
    }, label)));

  // ───────── show / hide ─────────
  function show() {
    if (!el.hidden) return;
    if (!el.contains(document.activeElement)) opener = markFocus();
    el.hidden = false;
    shell.root.classList.add('has-term');
    applyHeight();
    requestAnimationFrame(() => el.classList.add('is-open'));
  }

  function hide() {
    if (el.hidden) return;
    const at = document.activeElement;
    const hadFocus = el.contains(at) || !at || at === document.body;
    el.classList.remove('is-open');
    el.hidden = true;
    shell.root.classList.remove('has-term');
    // back where Ctrl+` (or the Terminal button) was pressed, not to <body>
    if (hadFocus) restoreFocus(opener);
    opener = null;
    shell.announce('Terminal hidden. Shells keep running.');
  }

  /** First open after a page load: bring back the tabs this browser had (their shells may still be running). */
  async function restore() {
    if (restored) return;
    restored = true;
    let saved: string[] = [];
    try {
      saved = JSON.parse(storage.get(TABS_KEY) ?? '[]');
    } catch {
      /* ignore */
    }
    for (const target of Array.isArray(saved) ? saved : []) {
      if (typeof target === 'string' && targetExists(target)) await createTab(target);
    }
  }

  const api = {
    el,
    get isOpen() {
      return !el.hidden;
    },
    /** Show the dock; with a target, switch to (or open) that place's shell. */
    async open(target?: string) {
      // A real shell on the server: off when the owner turned it off, and confirmed once per machine and user.
      if (el.hidden && !tabs.length && !(await confirmTerminal(shell))) return;
      show();
      // Until xterm is up, hold focus in the dock so early keystrokes don't trigger town shortcuts.
      if (!active) el.focus({ preventScroll: true });
      await restore();
      let want = target && targetExists(target) ? target : undefined;
      if (!want) {
        if (active) return activate(active);
        const last = storage.get(ACTIVE_KEY);
        want = last && tabs.some((t) => t.target === last) ? last : (tabs[0]?.target ?? defaultTarget());
      }
      const tab = tabs.find((t) => t.target === want) ?? (await createTab(want));
      if (!el.hidden) activate(tab);
    },
    hide,
    /** Show (at `target`, when given) or hide the dock. */
    toggle(target?: string) {
      if (el.hidden) void api.open(target);
      else hide();
    },
    /** Projects and jobs can be renamed or removed: keep labels honest and drop tabs whose project or job left (the
     *  server already stopped those shells). Called on `city`, `jobs` and `snapshot`. */
    onCity() {
      for (const t of [...tabs]) if (!targetExists(t.target)) closeTab(t);
      if (tabs.length) renderTabs();
    },
  };
  return api;
}
