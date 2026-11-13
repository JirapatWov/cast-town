// Help: the "?" button in the top bar, the ? key and the palette's Help commands all open it. People who self-host CAST
// have nobody to ask, so it holds what they would otherwise search the README for: the town's words, every keyboard
// shortcut, whether the server's agent is the tested one (with the build command), the docs and bug-report
// links, and "Copy diagnostics" — versions, browser and graphics, nothing private — to paste into a report.
// The content lives in help-info.ts (no DOM, tested); this file only lays it out.
import './css/help.css';
import type { WebGLRenderer } from 'three';
import { APP_NAME } from '../../../shared/brand';
import { AGENT_BUILD_COMMAND, OMP_TESTED_VERSION } from '../../../shared/omp-version';
import { CITY_ID } from '../net/base';
import { copyText, h, type Child } from './dom';
import { APP_VERSION, bugReportBody, diagnosticsText, keyLabels, keysText, ompState, projectLinks, shortcutGroups, type DiagnosticsInput } from './help-info';
import { icon } from './icons';
import { liveProviders } from '../../../shared/live-providers';
import { openModal, type ModalHandle } from './modal';
import type { Shell } from './shell';
import { isMac } from './widgets';
import { singleKeysEnabled } from './shortcuts';

export type HelpSection = 'basics' | 'shortcuts' | 'omp' | 'support' | 'about';

const SECTIONS: { id: HelpSection; label: string }[] = [
  { id: 'basics', label: 'Basics' },
  { id: 'shortcuts', label: 'Shortcuts' },
  { id: 'omp', label: 'Agent' },
  { id: 'support', label: 'Docs & bugs' },
  { id: 'about', label: 'About' },
];

/** The town's words, in the order people meet them. */
const GLOSSARY: [string, string][] = [
  ['Town', 'Your workspace. Every house in it is a project folder on the machine that runs CAST.'],
  ['Person', 'An AI agent — one cast-agent process. Click someone to chat; they walk to a station while they work.'],
  ['Job and room', 'A separate line of work in the same folder, with its own people and chats. Each job has a room; 1A is the ground-floor workroom.'],
  ['Off duty', 'That person’s agent isn’t running right now. It starts when you write to them.'],
  ['Effort', 'How hard a person thinks before answering. Low is quick and cheap; High (the default) and Max are slower and cost more.'],
  ['TV', 'What changed in the folder (the git diff). Revert files undoes a team run.'],
  ['Branch', 'A line of saved history in git. A job with its own copy works on its own branch until you bring it into the house; a deleted job’s branch stays listed under Changes.'],
  ['Tokens', 'How AI work is counted: a token is about ¾ of a word. A chat’s working memory holds only so many, so long chats get tidied into a summary.'],
  ['Talent Agency', 'Models & providers: connect your AI accounts here. Each machine (city) keeps its own.'],
  ['AI account', 'A sign-in or API key for a model provider (Anthropic, OpenAI, Google, DeepSeek, OpenRouter). Nobody can work until one is connected — in Models & providers.'],
  ['cast-agent', 'The open-source coding agent CAST runs every person on, based on omp (oh-my-pi). It keeps your AI sign-ins on this machine.'],
];

/** The GPU as WebGL reports it (null: no WebGL, the 2D fallback is running). */
function webglInfo(shell: Shell): DiagnosticsInput['webgl'] {
  const renderer = shell.engine?.renderer as WebGLRenderer | null | undefined;
  if (!renderer || typeof renderer.getContext !== 'function') return null;
  try {
    const gl = renderer.getContext();
    const webgl2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
    return { webgl2, renderer: typeof name === 'string' && name ? name : null };
  } catch {
    return { webgl2: false, renderer: null };
  }
}

function collectDiagnostics(shell: Shell): string {
  const s = shell.store.state;
  const hello = s.hello;
  return diagnosticsText({
    appVersion: APP_VERSION,
    serverVersion: hello?.serverVersion ?? null,
    ompVersion: hello ? hello.ompVersion : undefined,
    ompTested: hello?.ompTested || OMP_TESTED_VERSION,
    connectedProviders: hello ? liveProviders(s) : null,
    connected: s.connected,
    cityId: CITY_ID,
    view: shell.view.view,
    focusMode: shell.focusMode,
    quality: shell.quality,
    webgl: webglInfo(shell),
    userAgent: navigator.userAgent,
    platform: (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform || null,
    language: navigator.language || null,
    viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio || 1 },
    touch: window.matchMedia?.('(pointer: coarse)').matches ?? false,
    reducedMotion: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
    projects: s.city.projects.length,
    people: Object.keys(s.agents).length,
    time: new Date(),
  });
}

/** A button that copies `text()` and says how it went. */
function copyButton(label: string, text: () => string, cls = 'btn btn-soft btn-sm'): HTMLButtonElement {
  const state = h('span', null, label);
  const btn = h('button', { type: 'button', class: cls }, icon('copy', 14), state);
  btn.addEventListener('click', async () => {
    const ok = await copyText(text());
    state.textContent = ok ? 'Copied' : 'Copy failed — select the text and copy it';
    setTimeout(() => (state.textContent = label), ok ? 1400 : 4000);
  });
  return btn;
}

/** The keys of a shortcut as <kbd>s, with the combination as readable text for screen readers. */
function keysCell(keys: string[]): HTMLElement {
  const labels = keyLabels(keys, isMac);
  const parts: Child[] = [];
  const combo = !(keys.length > 1 && keys.every((k) => k.length === 1));
  labels.forEach((k, i) => {
    if (i) parts.push(h('span', { class: 'help-plus', 'aria-hidden': 'true' }, combo ? '+' : ' '));
    parts.push(h('kbd', { 'aria-hidden': 'true' }, k));
  });
  return h('span', { class: 'help-keys' }, h('span', { class: 'sr-only' }, keysText(keys, isMac)), parts);
}

function section(id: HelpSection, title: string, ...body: Child[]): HTMLElement {
  return h('section', { class: 'help-sec', 'aria-labelledby': `help-${id}` }, h('h3', { id: `help-${id}`, class: 'help-h', tabindex: '-1' }, title), body);
}

function link(href: string, text: string, iconName = 'external'): HTMLAnchorElement {
  return h('a', { class: 'help-link', href, target: '_blank', rel: 'noopener noreferrer' }, icon(iconName, 14), text);
}

export function createHelp(shell: Shell) {
  let modal: ModalHandle | null = null;

  function basics(): HTMLElement {
    return section(
      'basics',
      'The town at a glance',
      h('dl', { class: 'help-terms' }, GLOSSARY.map(([term, text]) => [h('dt', null, term), h('dd', null, text)])),
      h(
        'div',
        { class: 'help-actions' },
        h('button', { type: 'button', class: 'btn btn-soft btn-sm', onclick: () => (close(), shell.openOnboarding()) }, icon('sparkle', 14), 'Show welcome tour'),
        h('button', { type: 'button', class: 'btn btn-soft btn-sm', onclick: () => (close(), shell.openProviders()) }, icon('agency', 14), 'Models & providers'),
      ),
    );
  }

  function shortcuts(): HTMLElement {
    const touchOnly = window.matchMedia?.('(pointer: coarse)').matches && !window.matchMedia?.('(any-pointer: fine)').matches;
    return section(
      'shortcuts',
      'Keyboard shortcuts',
      touchOnly ? h('p', { class: 'help-note' }, 'These need a keyboard. On a touch screen everything is in the buttons and menus.') : null,
      h(
        'p',
        { class: 'help-note' },
        singleKeysEnabled()
          ? 'Single keys work when you are not typing in a box. Switch them off in Settings (voice control, dictation, screen readers).'
          : 'Single-key shortcuts are off on this device; turn them on in Settings.',
      ),
      shortcutGroups().map((g) =>
        h(
          'div',
          { class: 'help-keygroup' },
          h('h4', { class: 'help-sub' }, g.label),
          h(
            'ul',
            { class: 'help-keylist', role: 'list' },
            g.items.map((s) =>
              h('li', { class: ['help-keyrow', s.single && !singleKeysEnabled() && 'is-off'] }, keysCell(s.keys), h('span', { class: 'help-keylabel' }, s.label, s.single && !singleKeysEnabled() ? h('span', { class: 'muted' }, ' — off') : null)),
            ),
          ),
        ),
      ),
    );
  }

  function omp(): HTMLElement {
    const hello = shell.store.state.hello;
    const st = ompState(hello);
    const tested = hello?.ompTested || OMP_TESTED_VERSION;
    const status: Record<typeof st, [string, string, string]> = {
      ok: ['is-ok', 'checkCircle', `cast-agent ${hello?.ompVersion ?? ''} — the version ${APP_NAME} is tested with.`],
      untested: ['is-warn', 'alert', `cast-agent ${hello?.ompVersion ?? ''} is running, but ${APP_NAME} is tested with ${tested}. Some features may break.`],
      missing: ['is-err', 'xCircle', `${APP_NAME} can’t find its agent (cast-agent), so nobody can work.`],
      unknown: ['', 'circleDashed', 'Not connected to the server yet.'],
    };
    const [cls, ic, text] = status[st];
    const links = projectLinks();
    return section(
      'omp',
      'cast-agent, the agent behind every person',
      h('p', { class: ['help-status', cls] }, icon(ic, 16), h('span', null, text)),
      st === 'ok'
        ? null
        : [
            h('p', null, `On the machine that runs ${APP_NAME}, build the agent in the ${APP_NAME} folder and restart ${APP_NAME}:`),
            h('div', { class: 'cmd' }, h('code', null, AGENT_BUILD_COMMAND), copyButton('Copy', () => AGENT_BUILD_COMMAND, 'cmd-copy')),
            h('p', { class: 'help-note' }, 'Using another cast-agent build on purpose? Point CAST_AGENT_BIN at it before starting the server.'),
          ],
      links ? h('p', null, link(`${links.home}#install`, 'Install guide')) : h('p', { class: 'help-note' }, 'The install guide is README.md in the CAST folder.'),
    );
  }

  function support(): HTMLElement {
    const links = projectLinks();
    return section(
      'support',
      'Documentation and bug reports',
      links
        ? h(
            'div',
            { class: 'help-actions' },
            link(links.docs, 'Read the guide', 'book'),
            link(links.newIssue(bugReportBody(collectDiagnostics(shell))), 'Report a bug', 'alert'),
            link(links.issues, 'Known issues', 'search'),
          )
        : [
            h('p', null, 'The guide is ', h('code', null, 'README.md'), ' in the CAST folder on the machine that runs the server (also ', h('code', null, 'CONTRIBUTING.md'), ' and ', h('code', null, 'SECURITY.md'), ').'),
            h('p', null, 'To report a bug, copy the diagnostics below and send them with what you did, what you expected and what happened.'),
          ],
      h(
        'p',
        { class: 'help-note' },
        'Found a security problem? Please report it privately, not in a public issue',
        links ? [' — ', link(links.security, 'private report', 'key')] : ' (see SECURITY.md)',
        '.',
      ),
    );
  }

  function about(): HTMLElement {
    const s = shell.store.state;
    const hello = s.hello;
    const pre = h('pre', { class: 'help-diag', tabindex: '0', 'aria-label': 'Diagnostics' }, collectDiagnostics(shell));
    const rows: [string, string][] = [
      [`${APP_NAME} app`, APP_VERSION],
      [`${APP_NAME} server`, hello?.serverVersion ?? '—'],
      ['cast-agent', hello ? (hello.ompVersion ?? 'not found') : '—'],
      ['Workspace', hello?.workspaceRoot ?? '—'],
    ];
    return section(
      'about',
      `About ${APP_NAME}`,
      h('dl', { class: 'help-about' }, rows.map(([k, v]) => [h('dt', null, k), h('dd', null, v)])),
      h('p', { class: 'help-note' }, 'Diagnostics for a bug report: versions, browser and graphics. No addresses, logins, paths, project names or chats.'),
      pre,
      h('div', { class: 'help-actions' }, copyButton('Copy diagnostics', () => (pre.textContent = collectDiagnostics(shell)))),
    );
  }

  function close() {
    modal?.close();
  }

  /** Scroll the dialog's body (only it: scrollIntoView would also scroll the overflow-hidden dialog and hide its
   *  header) so the section's heading sits under the sticky chips, and move focus there for screen readers. An instant
   *  jump, not a smooth scroll: a smooth one waits on the busy 3D frame behind the dialog and can lag for seconds. */
  function go(id: HelpSection, dialog: HTMLElement) {
    const target = dialog.querySelector<HTMLElement>(`#help-${id}`);
    const scroller = dialog.querySelector<HTMLElement>('.modal-body');
    if (!target || !scroller) return;
    const nav = dialog.querySelector<HTMLElement>('.help-nav');
    const top = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - (nav?.offsetHeight ?? 0) - 10;
    scroller.scrollTo({ top: Math.max(0, top), behavior: 'instant' });
    target.focus({ preventScroll: true });
  }

  function open(sectionId?: HelpSection) {
    if (modal) {
      if (sectionId) go(sectionId, modal.dialog);
      return;
    }
    const body = h('div', { class: 'help' });
    const nav = h(
      'nav',
      { class: 'help-nav', 'aria-label': 'Help sections' },
      SECTIONS.map((s) => h('button', { type: 'button', class: 'help-nav-btn', onclick: () => modal && go(s.id, modal.dialog) }, s.label)),
    );
    body.append(nav, basics(), shortcuts(), omp(), support(), about());
    const hello = shell.store.state.hello;
    modal = openModal(shell.root, shell.layers, {
      id: 'help',
      title: 'Help',
      subtitle: `${APP_NAME} ${APP_VERSION}${hello?.ompVersion ? ` · cast-agent ${hello.ompVersion}` : ''}`,
      className: 'modal-help',
      body,
      onClose: () => (modal = null),
    });
    if (sectionId && sectionId !== 'basics') {
      const dialog = modal.dialog;
      // After the dialog's pop-in (measured mid-scale, the jump lands short) and the modal's own first focus (a frame).
      const popIn = dialog.getAnimations?.().map((a) => a.finished.catch(() => undefined)) ?? [];
      void Promise.all(popIn).then(() =>
        requestAnimationFrame(() => requestAnimationFrame(() => {
          if (modal?.dialog === dialog) go(sectionId, dialog);
        })),
      );
    }
  }

  return {
    open,
    get isOpen() {
      return !!modal;
    },
  };
}

/** The top bar's "?" button. */
export function helpButton(shell: Shell): HTMLButtonElement {
  return h(
    'button',
    { type: 'button', class: 'tb-btn tb-icon tb-help', 'aria-label': 'Help and keyboard shortcuts', title: 'Help and keyboard shortcuts (?)', onclick: () => shell.openHelp() },
    icon('help', 17),
  );
}

/** Palette entries (Ctrl/⌘K): "help", "docs", "shortcut", "keyboard", "bug", "version" all find something. */
export function helpCommands(): { id: string; title: string; subtitle?: string; keywords: string; icon: string; shortcut?: string[]; section: HelpSection; boost: number }[] {
  return [
    { id: 'a:help', title: 'Help', subtitle: 'Shortcuts, docs, versions, report a bug', keywords: 'help support question how faq manual guide ?', icon: 'help', shortcut: ['?'], section: 'basics', boost: 0 },
    { id: 'a:keys', title: 'Keyboard shortcuts', subtitle: 'Every key CAST knows', keywords: 'keys keyboard shortcuts hotkeys keybindings accessibility a11y', icon: 'command', section: 'shortcuts', boost: -2 },
    { id: 'a:docs', title: 'Open documentation', subtitle: 'The CAST guide', keywords: 'docs documentation readme guide manual install setup help', icon: 'book', section: 'support', boost: -4 },
    { id: 'a:bug', title: 'Report a bug', subtitle: 'With diagnostics attached', keywords: 'bug issue problem report feedback broken support github', icon: 'alert', section: 'support', boost: -4 },
    { id: 'a:about', title: `About ${APP_NAME}`, subtitle: `Version ${APP_VERSION} · copy diagnostics`, keywords: 'about version cast-agent agent omp diagnostics system info browser webgl', icon: 'agency', section: 'about', boost: -4 },
    { id: 'a:omp', title: 'cast-agent version and build', subtitle: `${APP_NAME} is tested with cast-agent ${OMP_TESTED_VERSION}`, keywords: 'cast-agent agent omp install build version update upgrade missing not found', icon: 'terminal', section: 'omp', boost: -6 },
  ];
}
