// In-app Help (finding #34): the shortcut list matches the keys the app really binds, project links come from
// package.json (and stay off until the placeholder is replaced), and "Copy diagnostics" never carries anything private.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pkg from '../../package.json';
import {
  APP_VERSION,
  SHORTCUTS,
  bugReportBody,
  diagnosticsText,
  keyLabels,
  keysText,
  ompState,
  projectLinks,
  redact,
  repoWebUrl,
  shortcutGroups,
  type DiagnosticsInput,
} from '../../web/src/ui/help-info';

const src = (f: string) => readFileSync(join(import.meta.dir, '..', '..', f), 'utf8');

describe('shortcuts', () => {
  test('every single-key shortcut keyboard.ts handles is listed, and nothing listed is invented', () => {
    const kb = src('web/src/ui/keyboard.ts');
    // bare keys are handled after the single-key gate: a switch case, or a comparison (A / D on a focused approval card)
    const bare = kb.slice(kb.indexOf('if (!singleKeysEnabled()) return;'));
    expect(bare.length).toBeLessThan(kb.length);
    const codes = [...new Set([...bare.matchAll(/(?:case |ev\.code === )'Key([A-Z])'/g)].map((m) => m[1]))];
    expect(codes.sort()).toEqual(['A', 'D', 'J', 'T', 'W']);
    const listed = new Set(SHORTCUTS.filter((s) => s.keys.length === 1).map((s) => s.keys[0]));
    // what keyboard.ts handles after the single-key gate is flagged single in the registry (the setting turns it off)
    const gated = new Set([...codes, '/', '`', '?', '1–9']);
    for (const s of SHORTCUTS.filter((x) => x.keys.length === 1 && gated.has(x.keys[0]) && x.scope !== 'drive')) expect(s.single).toBe(true);
    for (const c of codes) expect(listed.has(c)).toBe(true);
    expect(kb).toContain("case 'Slash'");
    expect(listed.has('/')).toBe(true);
    expect(kb).toContain("case 'Backquote'");
    expect(listed.has('`')).toBe(true);
    expect(kb).toContain("ev.key === '?'");
    expect(listed.has('?')).toBe(true);
    expect(kb).toContain('Digit([1-9])');
    expect(listed.has('1–9')).toBe(true);
  });

  test('the chat box keys exist in composer.ts and PageUp/PageDown in the floor switcher', () => {
    const composer = src('web/src/ui/composer.ts');
    expect(composer).toMatch(/KeyP/);
    expect(composer).toMatch(/KeyT/);
    expect(src('web/src/ui/floor-switcher.ts')).toMatch(/PageUp/);
  });

  test('ids are unique, every entry has a scope group, Mod reads per platform', () => {
    expect(new Set(SHORTCUTS.map((s) => s.id)).size).toBe(SHORTCUTS.length);
    expect(shortcutGroups().flatMap((g) => g.items)).toHaveLength(SHORTCUTS.length);
    expect(shortcutGroups()[0].label).toBe('Anywhere');
    expect(keyLabels(['Mod', 'K'], true)).toEqual(['⌘', 'K']);
    expect(keysText(['Mod', 'K'], false)).toBe('Ctrl + K');
    expect(keysText(['W', 'A', 'S', 'D'], false)).toBe('W A S D');
  });
});

describe('project links', () => {
  test('the placeholder in package.json means "not set": no links, the panel explains instead', () => {
    expect(repoWebUrl('git+https://github.com/CHANGE-ME/cast.git')).toBeNull();
    expect(repoWebUrl(undefined)).toBeNull();
    expect(repoWebUrl({ url: '' })).toBeNull();
    if (JSON.stringify(pkg.repository).includes('CHANGE-ME')) expect(projectLinks()).toBeNull();
  });

  test('npm repository forms → the web address', () => {
    for (const form of ['git+https://github.com/acme/cast.git', 'https://github.com/acme/cast', 'git@github.com:acme/cast.git', 'github:acme/cast', 'acme/cast', { url: 'git+ssh://git@github.com/acme/cast.git' }])
      expect(repoWebUrl(form as never)).toBe('https://github.com/acme/cast');
    expect(repoWebUrl('https://gitlab.com/acme/cast.git')).toBe('https://gitlab.com/acme/cast');
    expect(repoWebUrl('javascript:alert(1)')).toBeNull();
  });

  test('GitHub: docs, issues, a prefilled new issue and private security reporting', () => {
    const l = projectLinks({ url: 'git+https://github.com/acme/cast.git' })!;
    expect(l.docs).toBe('https://github.com/acme/cast#readme');
    expect(l.security).toBe('https://github.com/acme/cast/security/advisories/new');
    const url = new URL(l.newIssue(bugReportBody('CAST app  0.1.0')));
    expect(url.pathname).toBe('/acme/cast/issues/new');
    expect(url.searchParams.get('body')).toContain('### What happened instead?');
    expect(url.searchParams.get('body')).toContain('CAST app  0.1.0');
    expect(l.newIssue('x'.repeat(20_000)).length).toBeLessThan(12_000);
    expect(projectLinks('https://gitlab.com/acme/cast')!.newIssue('x')).toBe('https://gitlab.com/acme/cast/issues');
  });
});

describe('omp state', () => {
  test('tested, untested, missing, not known yet', () => {
    expect(ompState({ ompVersion: '18.13.2', ompTested: '18.13.2' })).toBe('ok');
    expect(ompState({ ompVersion: 'omp/18.13.2-cast.1', ompTested: '18.13.2' })).toBe('ok');
    expect(ompState({ ompVersion: '18.14.2', ompTested: '18.13.2' })).toBe('untested');
    expect(ompState({ ompVersion: null, ompTested: '18.13.2' })).toBe('missing');
    expect(ompState(null)).toBe('unknown');
  });
});

describe('diagnostics', () => {
  const base: DiagnosticsInput = {
    appVersion: APP_VERSION,
    serverVersion: '0.1.0',
    ompVersion: '18.14.2',
    ompTested: '18.13.2',
    connectedProviders: 0,
    connected: true,
    cityId: null,
    view: 'house',
    focusMode: false,
    quality: 'medium',
    webgl: { webgl2: true, renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)' },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
    platform: 'macOS',
    language: 'th-TH',
    viewport: { width: 1440, height: 900, dpr: 2 },
    touch: false,
    reducedMotion: true,
    projects: 2,
    people: 5,
    time: new Date('2026-11-01T10:00:00Z'),
  };

  test('versions, the agent against the tested one, browser and graphics', () => {
    const t = diagnosticsText(base);
    expect(t).toContain(`CAST app     ${APP_VERSION}`);
    expect(t).toContain('18.14.2 (tested: 18.13.2)');
    expect(t).toMatch(/Models +none connected/);
    expect(t).not.toMatch(/\bdemo\b/i);
    expect(t).toContain('WebGL 2 · ANGLE (Apple');
    expect(t).toContain('1440×900 @2x · reduced motion');
    expect(t).toContain('2 houses, 5 people');
    expect(t).toContain('macOS · th-TH');
    expect(diagnosticsText({ ...base, ompVersion: null })).toContain('cast-agent   not found');
    expect(diagnosticsText({ ...base, webgl: null })).toContain('unavailable (2D mode)');
    expect(diagnosticsText({ ...base, cityId: 'lab' })).toContain('another machine, through this hub');
  });

  test('models: how many AI accounts are connected, none, or not known yet', () => {
    expect(diagnosticsText({ ...base, connectedProviders: 1 })).toMatch(/Models +1 provider connected/);
    expect(diagnosticsText({ ...base, connectedProviders: 3 })).toMatch(/Models +3 providers connected/);
    expect(diagnosticsText({ ...base, connectedProviders: null })).toMatch(/Models +unknown/);
    expect(diagnosticsText({ ...base, connectedProviders: undefined })).toMatch(/Models +unknown/);
  });

  test('nothing private gets through, even if it sneaks into a field', () => {
    const t = diagnosticsText({
      ...base,
      userAgent: 'Mozilla/5.0 owner@example.com http://127.0.0.1:4860/?token=9f2c4e1a7b',
      platform: 'Linux sk-ant-api03-abcdefghijklmnop',
      language: 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb7c',
    });
    expect(t).not.toContain('owner@example.com');
    expect(t).not.toContain('9f2c4e1a7b');
    expect(t).not.toContain('sk-ant-api03');
    expect(t).not.toContain('Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb7c');
    expect(t).toContain('<e-mail>');
    expect(t).toContain('token=<hidden>');
  });

  test('redact keeps ordinary diagnostics intact', () => {
    const t = diagnosticsText(base);
    expect(redact(t)).toBe(t);
  });
});
