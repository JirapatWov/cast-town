// What the Help panel (help.ts) says and copies: the shortcut list, project links, the diagnostics text. No DOM here,
// so it is tested directly (tests/help/help-info.test.ts).
import { repository, version } from '../../../package.json';
import { OMP_TESTED_VERSION, ompCoreVersion } from '../../../shared/omp-version';

/** This web app's version (the package.json it was built from). The server reports its own in `hello`; the two differ
 *  when a browser still runs an old cached app — worth seeing in a bug report. */
export const APP_VERSION: string = version;

// ── Shortcuts ──
// Shortcuts come from the registry (contract C5, web/src/ui/shortcuts.ts): the key handler, Settings and this help
// read one list. Re-exported here so the help's tests and layout keep one import.
import { SCOPE_LABEL, SHORTCUTS, displayKeys, type Shortcut as ShortcutEntry, type ShortcutScope } from './shortcuts';
export { SCOPE_LABEL, SHORTCUTS, type ShortcutEntry, type ShortcutScope };

/** Keys as people read them: 'Mod' becomes ⌘ or Ctrl. */
export function keyLabels(keys: string[], mac: boolean): string[] {
  return displayKeys(keys, mac);
}

/** The combination as one string for screen readers and copying ("Ctrl + K"). */
export function keysText(keys: string[], mac: boolean): string {
  const parts = keyLabels(keys, mac);
  // a run of single arrows / letters pressed one at a time reads as a list, a combination with "+"
  return keys.length > 1 && keys.every((k) => k.length === 1) ? parts.join(' ') : parts.join(' + ');
}

/** The shortcut list grouped by scope, in SCOPE_LABEL order. */
export function shortcutGroups(list: ShortcutEntry[] = SHORTCUTS): { scope: ShortcutScope; label: string; items: ShortcutEntry[] }[] {
  return (Object.keys(SCOPE_LABEL) as ShortcutScope[])
    .map((scope) => ({ scope, label: SCOPE_LABEL[scope], items: list.filter((s) => s.scope === scope) }))
    .filter((g) => g.items.length > 0);
}

// ── Project links ──

/** Placeholder left in package.json until the project has a public home. */
const REPO_PLACEHOLDER = 'CHANGE-ME';

/** package.json `repository` → the project's web address ("https://github.com/owner/cast"); null when it isn't set. */
export function repoWebUrl(repo: string | { url?: string } | undefined | null): string | null {
  const raw = (typeof repo === 'string' ? repo : repo?.url ?? '').trim();
  if (!raw || raw.includes(REPO_PLACEHOLDER)) return null;
  let url = raw
    .replace(/^git\+/, '')
    .replace(/^git@([^:]+):/, 'https://$1/')
    .replace(/^ssh:\/\/git@/, 'https://')
    .replace(/^git:\/\//, 'https://')
    .replace(/^github:/, 'https://github.com/')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
  if (/^[\w.-]+\/[\w.-]+$/.test(url)) url = `https://github.com/${url}`; // npm's "owner/repo" shorthand
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href.replace(/\/+$/, '') : null;
  } catch {
    return null;
  }
}

export interface ProjectLinks {
  home: string;
  docs: string;
  issues: string;
  /** A new bug report, prefilled with `body` where the host supports it (GitHub). */
  newIssue(body: string): string;
  /** Where to report a vulnerability privately (GitHub private reporting), else the project page. */
  security: string;
}

/** Longest prefilled issue body we put in a URL (browsers and GitHub cope with ~8 KB URLs; keep well under). */
const MAX_BODY = 3500;

export function projectLinks(repo: string | { url?: string } | undefined | null = repository): ProjectLinks | null {
  const home = repoWebUrl(repo);
  if (!home) return null;
  const github = new URL(home).hostname === 'github.com';
  return {
    home,
    docs: `${home}#readme`,
    issues: `${home}/issues`,
    newIssue: (body) => (github ? `${home}/issues/new?body=${encodeURIComponent(body.slice(0, MAX_BODY))}` : `${home}/issues`),
    security: github ? `${home}/security/advisories/new` : home,
  };
}

/** The report template a bug link is prefilled with: the questions, then the diagnostics. */
export function bugReportBody(diagnostics: string): string {
  return ['### What did you do?', '', '### What did you expect?', '', '### What happened instead?', '', '### Diagnostics', '', '```', diagnostics, '```', ''].join('\n');
}

// ── omp status ──

export type OmpState = 'ok' | 'untested' | 'missing' | 'unknown';

/** How the server's omp compares to the tested one (unknown: no hello from the server yet). */
export function ompState(hello: { ompVersion: string | null; ompTested?: string } | null | undefined): OmpState {
  if (!hello) return 'unknown';
  if (!hello.ompVersion) return 'missing';
  const tested = hello.ompTested || OMP_TESTED_VERSION;
  return ompCoreVersion(hello.ompVersion) === ompCoreVersion(tested) ? 'ok' : 'untested';
}

// ── Diagnostics ──

export interface DiagnosticsInput {
  appVersion: string;
  serverVersion?: string | null;
  ompVersion?: string | null; // null: not found; undefined: not known yet
  ompTested?: string | null;
  /** AI accounts (providers) connected; null: not known yet. */
  connectedProviders?: number | null;
  connected: boolean;
  /** null: this server's own city; else the id of a city opened through this hub. */
  cityId: string | null;
  view: string;
  focusMode: boolean;
  quality: string;
  webgl: { webgl2: boolean; renderer?: string | null } | null;
  userAgent: string;
  platform?: string | null;
  language?: string | null;
  viewport: { width: number; height: number; dpr: number };
  touch: boolean;
  reducedMotion: boolean;
  projects: number;
  people: number;
  time: Date;
}

/** Masks anything that may be private in text pasted into a public issue: e-mail addresses (a Tailscale login),
 *  pairing tokens in URLs, and long opaque strings (keys, tokens, session ids). */
export function redact(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '<e-mail>')
    .replace(/([?&](?:token|key|session|code)=)[^&\s]+/gi, '$1<hidden>')
    .replace(/\b(?:sk|pk|rk)-[\w-]{8,}/g, '<key>')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '<hidden>');
}

/** Plain text for "Copy diagnostics": versions, connection, browser and graphics. Never the page address (it may hold
 *  a pairing token), the signed-in login, file paths, project names or chat content. */
export function diagnosticsText(d: DiagnosticsInput): string {
  const omp =
    d.ompVersion === undefined
      ? 'unknown (not connected yet)'
      : d.ompVersion === null
        ? 'not found'
        : `${d.ompVersion}${d.ompTested && ompCoreVersion(d.ompVersion) !== ompCoreVersion(d.ompTested) ? ` (tested: ${d.ompTested})` : ''}`;
  const gl = d.webgl ? `${d.webgl.webgl2 ? 'WebGL 2' : 'WebGL 1'}${d.webgl.renderer ? ` · ${d.webgl.renderer}` : ''}` : 'unavailable (2D mode)';
  const lines: [string, string][] = [
    ['CAST app', d.appVersion],
    ['CAST server', d.serverVersion ?? 'unknown (not connected yet)'],
    ['cast-agent', omp],
    ['Models', d.connectedProviders == null ? 'unknown' : d.connectedProviders === 0 ? 'none connected' : `${d.connectedProviders} provider${d.connectedProviders === 1 ? '' : 's'} connected`],
    ['Connection', d.connected ? 'connected' : 'not connected'],
    ['City', d.cityId ? 'another machine, through this hub' : 'this server (home)'],
    ['View', `${d.view}${d.focusMode ? ' · focus mode' : ''}`],
    ['Town', `${d.projects} ${d.projects === 1 ? 'house' : 'houses'}, ${d.people} ${d.people === 1 ? 'person' : 'people'}`],
    ['Graphics', `${d.quality} · ${gl}`],
    ['Screen', `${d.viewport.width}×${d.viewport.height} @${Math.round(d.viewport.dpr * 100) / 100}x${d.touch ? ' · touch' : ''}${d.reducedMotion ? ' · reduced motion' : ''}`],
    ['Browser', d.userAgent],
    ['Platform', [d.platform, d.language].filter(Boolean).join(' · ') || 'unknown'],
    ['Time', d.time.toISOString()],
  ];
  const width = Math.max(...lines.map(([k]) => k.length));
  return redact(lines.map(([k, v]) => `${k.padEnd(width)}  ${v}`).join('\n'));
}
