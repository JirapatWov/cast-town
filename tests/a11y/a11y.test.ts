// Accessibility helpers (g6): the shortcut registry and single-key setting, Board/3D start, page titles and
// announcements, focus keys, option-group arrows, toast timing, the city's house list and the engine slot.
// The web modules read `location` when loaded (net/base.ts): give them one before importing.
import { beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

(globalThis as { location?: unknown }).location ??= { pathname: '/', protocol: 'http:', host: 'localhost' };

let shortcuts: typeof import('../../web/src/ui/shortcuts.ts');
let viewMode: typeof import('../../web/src/ui/view-mode.ts');
let announce: typeof import('../../web/src/ui/announce.ts');
let toasts: typeof import('../../web/src/ui/toasts.ts');
let mainView: typeof import('../../web/src/ui/main-view.ts');

beforeAll(async () => {
  shortcuts = await import('../../web/src/ui/shortcuts.ts');
  viewMode = await import('../../web/src/ui/view-mode.ts');
  announce = await import('../../web/src/ui/announce.ts');
  toasts = await import('../../web/src/ui/toasts.ts');
  mainView = await import('../../web/src/ui/main-view.ts');
});

describe('shortcut registry (C5)', () => {
  test('ids are unique and every entry names keys, a label and a known scope', () => {
    const ids = shortcuts.SHORTCUTS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of shortcuts.SHORTCUTS) {
      expect(s.keys.length).toBeGreaterThan(0);
      expect(s.label.trim().length).toBeGreaterThan(0);
      expect(shortcuts.SCOPE_LABEL[s.scope]).toBeTruthy();
    }
  });
  test('bare keys are flagged single; nothing with Ctrl/⌘/Alt is', () => {
    for (const s of shortcuts.SHORTCUTS) {
      if (s.keys.some((k) => ['Mod', 'Ctrl', 'Alt'].includes(k))) expect(s.single).toBeFalsy();
    }
    for (const id of ['chat', 'view', 'enter-house', 'workflow', 'changes', 'jobs', 'drive', 'approve', 'deny']) {
      expect(shortcuts.shortcut(id)?.single).toBe(true);
    }
  });
  test('the permission mode is Alt+M, not Shift+Tab (Shift+Tab moves focus back)', () => {
    expect(shortcuts.shortcut('mode')?.keys).toEqual(['Alt', 'M']);
    expect(shortcuts.SHORTCUTS.some((s) => s.keys.join('+') === 'Shift+Tab')).toBe(false);
  });
  test('displayKeys: Mod is ⌘ on a Mac, Ctrl elsewhere', () => {
    expect(shortcuts.displayKeys(['Mod', 'K'], true)).toEqual(['⌘', 'K']);
    expect(shortcuts.displayKeys(['Mod', 'K'], false)).toEqual(['Ctrl', 'K']);
    expect(shortcuts.displayKeys(['Ctrl', '`'], true)).toEqual(['Ctrl', '`']);
  });
  test('isSingleKeyHint: one bare key only', () => {
    for (const k of ['W', 't', '1', '`', '/', '1–9']) expect(shortcuts.isSingleKeyHint([k])).toBe(true);
    expect(shortcuts.isSingleKeyHint(['Ctrl', 'K'])).toBe(false);
    expect(shortcuts.isSingleKeyHint(['Esc'])).toBe(false);
    expect(shortcuts.isSingleKeyHint(['Enter'])).toBe(false);
  });
  test('single-key setting: stored choice wins; default on for keyboards, off for touch', () => {
    expect(shortcuts.singleKeysFrom('1', true)).toBe(true);
    expect(shortcuts.singleKeysFrom('0', false)).toBe(false);
    expect(shortcuts.singleKeysFrom(null, false)).toBe(true);
    expect(shortcuts.singleKeysFrom(null, true)).toBe(false);
    expect(shortcuts.singleKeysFrom('junk', true)).toBe(false);
  });
});

describe('Board or 3D at start', () => {
  test('the address decides for one visit', () => {
    expect(viewMode.viewFromSearch('?2d')).toBe('board');
    expect(viewMode.viewFromSearch('?board')).toBe('board');
    expect(viewMode.viewFromSearch('?view=board')).toBe('board');
    expect(viewMode.viewFromSearch('?3d')).toBe('3d');
    expect(viewMode.viewFromSearch('?view=3d')).toBe('3d');
    expect(viewMode.viewFromSearch('?token=abc')).toBeNull();
    expect(viewMode.viewFromSearch('')).toBeNull();
  });
  test('reloading into 3D drops only what asks for the board (#70: after the town’s code failed to arrive)', () => {
    expect(viewMode.searchWithoutBoard('?2d')).toBe('');
    expect(viewMode.searchWithoutBoard('?board&city=x')).toBe('?city=x');
    expect(viewMode.searchWithoutBoard('?view=board&a=1')).toBe('?a=1');
    expect(viewMode.searchWithoutBoard('?view=3d')).toBe('?view=3d');
    expect(viewMode.searchWithoutBoard('')).toBe('');
    expect(viewMode.startOnBoard(viewMode.searchWithoutBoard('?2d&view=2d'), '0')).toBe(false);
  });
  test('otherwise the remembered choice; with none, the board on a phone and 3D elsewhere', () => {
    expect(viewMode.startOnBoard('', '1')).toBe(true);
    expect(viewMode.startOnBoard('', '0')).toBe(false);
    expect(viewMode.startOnBoard('', null)).toBe(false);
    expect(viewMode.startOnBoard('', null, true)).toBe(true);
    expect(viewMode.startOnBoard('', '0', true)).toBe(false); // a phone that picked 3D keeps it
    expect(viewMode.startOnBoard('?3d', null, true)).toBe(false);
    expect(viewMode.startOnBoard('?3d', '1')).toBe(false);
    expect(viewMode.startOnBoard('?2d', '0')).toBe(true);
  });
  test('threeD store: load() asks the loader only while idle, listeners hear changes', () => {
    let loads = 0;
    let changes = 0;
    const off = viewMode.threeD.onChange(() => changes++);
    viewMode.threeD.setLoader(() => loads++);
    viewMode.threeD.set('ready');
    viewMode.threeD.load();
    expect(loads).toBe(0);
    viewMode.threeD.set('idle');
    viewMode.threeD.load();
    expect(loads).toBe(1);
    viewMode.threeD.set('loading', 0.4);
    expect(viewMode.threeD.progress).toBe(0.4);
    viewMode.threeD.load();
    expect(loads).toBe(1);
    viewMode.threeD.set('ready');
    expect(viewMode.threeD.progress).toBe(1);
    expect(changes).toBe(4);
    off();
  });
});

describe('titles and announcements', () => {
  test('pageTitle: waiting count first, empty parts dropped', () => {
    expect(announce.pageTitle({ waiting: 2, tab: 'Inbox', place: 'todo-api', app: 'CAST' })).toBe('(2) Inbox · todo-api · CAST');
    expect(announce.pageTitle({ waiting: 0, tab: 'Chat', place: 'todo-api', job: 'Refactor', app: 'CAST' })).toBe('Chat · todo-api · Refactor · CAST');
    expect(announce.pageTitle({ waiting: 0, tab: null, place: 'Town board', job: ' ', app: 'CAST' })).toBe('Town board · CAST');
  });
  test('placeAnnouncement says where you arrived', () => {
    expect(announce.placeAnnouncement('house', { house: 'todo-api' })).toBe('Entered todo-api.');
    expect(announce.placeAnnouncement('house', { house: 'todo-api', job: 'Refactor' })).toBe('Entered todo-api, job Refactor.');
    expect(announce.placeAnnouncement('city', { board: true })).toBe('Back on the town board.');
    expect(announce.placeAnnouncement('city')).toBe('Back in the town.');
    expect(announce.placeAnnouncement('drive')).toContain('Esc leaves the car');
  });
  test('houseStatusText', () => {
    expect(mainView.houseStatusText(0, 0)).toBe('quiet');
    expect(mainView.houseStatusText(2, 1)).toBe('2 waiting for you, 1 working');
    expect(mainView.houseStatusText(0, 3)).toBe('3 working');
  });
  test('toastTtl: longer for warnings and errors, at least 12 s with an action to reach', () => {
    expect(toasts.toastTtl('info', false)).toBe(5000);
    expect(toasts.toastTtl('success', false)).toBe(5000);
    expect(toasts.toastTtl('warn', false)).toBe(7000);
    expect(toasts.toastTtl('error', false)).toBe(10_000);
    expect(toasts.toastTtl('info', true)).toBe(12_000);
    expect(toasts.toastTtl('error', true)).toBe(12_000);
  });
});

describe('focus keys and option groups', () => {
  test('keyFrom: focus key, then id, then tag/role/name/accessible name', async () => {
    const { keyFrom } = await import('../../web/src/ui/focus.ts');
    expect(keyFrom({ tag: 'BUTTON', focusKey: 'role:writer', id: 'x' })).toBe('k:role:writer');
    expect(keyFrom({ tag: 'BUTTON', id: 'ptab-chat' })).toBe('#ptab-chat');
    expect(keyFrom({ tag: 'BUTTON', role: 'radio', label: 'Low', text: 'ignored' })).toBe('button|radio||Low');
    expect(keyFrom({ tag: 'INPUT', name: 'q', text: '  two\n words ' })).toBe('input||q|two words');
    // the same control re-rendered has the same key
    expect(keyFrom({ tag: 'BUTTON', text: 'Copy' })).toBe(keyFrom({ tag: 'button', text: ' Copy ' }));
  });
  test('nextIndex: arrows wrap, Home/End jump, other keys are not moves', async () => {
    const { nextIndex } = await import('../../web/src/ui/radios.ts');
    expect(nextIndex(0, 3, 'ArrowRight')).toBe(1);
    expect(nextIndex(2, 3, 'ArrowDown')).toBe(0);
    expect(nextIndex(0, 3, 'ArrowLeft')).toBe(2);
    expect(nextIndex(1, 3, 'ArrowUp')).toBe(0);
    expect(nextIndex(-1, 3, 'ArrowRight')).toBe(0);
    expect(nextIndex(-1, 3, 'ArrowLeft')).toBe(2);
    expect(nextIndex(1, 3, 'Home')).toBe(0);
    expect(nextIndex(1, 3, 'End')).toBe(2);
    expect(nextIndex(1, 3, 'Enter')).toBeNull();
    expect(nextIndex(0, 0, 'ArrowRight')).toBeNull();
  });
});

describe('dialogs and menus (round 3 keyboard / screen-reader pass)', () => {
  test('menuName: a menu is named after its button, without the current value or the action', async () => {
    const { menuName } = await import('../../web/src/ui/menu.ts');
    expect(menuName('Permission mode: Ask first. Change')).toBe('Permission mode');
    expect(menuName('Model: Opus 5.5 · not connected. Change')).toBe('Model');
    expect(menuName('Effort: Default (High). Change')).toBe('Effort');
    expect(menuName('City: home-box. Switch city')).toBe('City');
    expect(menuName('More: Town board, search, terminal, models, graphics')).toBe('More');
    expect(menuName('todo-api: browse files, rename, move or remove')).toBe('todo-api');
    expect(menuName('More for Main')).toBe('More for Main');
    expect(menuName('  New\n terminal ')).toBe('New terminal');
    expect(menuName(null)).toBe('');
  });

  // stand-ins for elements: what tabbable() reads
  const el = (o: { tabIndex?: number; disabled?: boolean; hidden?: boolean; inClosedDetails?: boolean; visible?: boolean; rects?: number }) => ({
    tabIndex: o.tabIndex ?? 0,
    disabled: o.disabled,
    closest: (sel: string) => ((o.hidden && sel.includes('[hidden]')) || (o.inClosedDetails && sel.includes('details:not([open]) > :not(summary)')) ? {} : null),
    getClientRects: () => ({ length: o.rects ?? 1 }),
    ...(o.visible === undefined ? {} : { checkVisibility: () => o.visible as boolean }),
  });
  test('tabbable: Tab stops only — no roving options, disabled, hidden or unrendered elements', async () => {
    const { tabbable } = await import('../../web/src/ui/layers.ts');
    expect(tabbable(el({}))).toBe(true); // a <summary> ("Or set it up by hand") counts: the trap missed it
    expect(tabbable(el({ tabIndex: -1 }))).toBe(false); // a radio that is not the group's Tab stop
    expect(tabbable(el({ disabled: true }))).toBe(false);
    expect(tabbable(el({ hidden: true }))).toBe(false);
    expect(tabbable(el({ rects: 0 }))).toBe(false); // display: none
    // the copy buttons in a closed "Or set it up by hand": Chrome gives them a box, Tab skips them — the trap took the
    // last of them for the dialog's last stop, so Tab from the summary before it left the dialog
    expect(tabbable(el({ inClosedDetails: true }))).toBe(false);
    expect(tabbable(el({ visible: false }))).toBe(false); // content-visibility / visibility: hidden
    expect(tabbable(el({ visible: true }))).toBe(true);
  });
  test('trapTarget: Tab past the last stop wraps to the first, Shift+Tab before the first to the last', async () => {
    const { trapTarget } = await import('../../web/src/ui/layers.ts');
    const stops = ['close', 'sign-in', 'by-hand'];
    expect(trapTarget(stops, 'by-hand', true, false)).toBe('close');
    expect(trapTarget(stops, 'close', true, true)).toBe('by-hand');
    expect(trapTarget(stops, 'sign-in', true, false)).toBeNull(); // a move inside: the browser's
    expect(trapTarget(stops, null, true, false)).toBeNull(); // on a region focused by script: the browser moves on
    expect(trapTarget(stops, null, false, false)).toBe('close'); // from outside the dialog: back in
    expect(trapTarget(stops, null, false, true)).toBe('by-hand');
    expect(trapTarget([], 'x', true, false)).toBeNull();
  });
});

describe('card options (round 3 screen-reader pass)', () => {
  test('optionNames: the name alone names a card option and its line describes it', async () => {
    const { optionNames } = await import('../../web/src/ui/widgets.ts');
    const name = { id: '' } as HTMLElement;
    const desc = { id: '' } as HTMLElement;
    const attrs = optionNames(name, desc);
    expect(name.id).not.toBe('');
    expect(desc.id).not.toBe('');
    expect(name.id).not.toBe(desc.id);
    expect(attrs).toEqual({ 'aria-labelledby': name.id, 'aria-describedby': desc.id });
    const again = optionNames({ id: 'kept' } as HTMLElement);
    expect(again).toEqual({ 'aria-labelledby': 'kept' }); // an id already there is kept; no line, no description
  });
});

describe('engine slot (board start, 3D built later)', () => {
  type FrameFn = (dt: number, elapsed: number) => void;
  const fakeEngine = (name: string) => {
    const frames = new Set<FrameFn>();
    const calls: string[] = [];
    const engine = {
      name,
      calls,
      frames,
      renderer: null,
      canvas: null,
      assets: null,
      quality: 'low',
      labelLayer: null,
      setView: () => calls.push('setView'),
      setQuality: (q: string) => calls.push(`quality:${q}`),
      pick: () => null,
      fade: async () => {},
      setPaused: (p: boolean) => calls.push(`paused:${p}`),
      onFrame(fn: FrameFn) {
        frames.add(fn);
        return () => frames.delete(fn);
      },
    };
    return engine;
  };

  test('forwards to the flat engine, then to the real one; frame callbacks move over once', async () => {
    const { createEngineSlot } = await import('../../web/src/engine-slot.ts');
    const flat = fakeEngine('flat');
    const real = fakeEngine('real');
    const slot = createEngineSlot(flat as never);
    const ticks: number[] = [];
    const off = slot.onFrame((dt) => ticks.push(dt));
    slot.setPaused(true);
    expect(flat.calls).toEqual(['paused:true']);
    expect(flat.frames.size).toBe(1);
    expect(slot.attached).toBe(false);

    slot.attach(real as never);
    expect(slot.attached).toBe(true);
    expect(flat.frames.size).toBe(0);
    expect(real.frames.size).toBe(1);
    for (const fn of real.frames) fn(0.016, 1);
    expect(ticks).toEqual([0.016]);
    slot.setQuality('high' as never);
    expect(real.calls).toEqual(['quality:high']);

    slot.attach(fakeEngine('again') as never); // only once
    expect(real.frames.size).toBe(1);
    off();
    expect(real.frames.size).toBe(0);
  });
  test('no time of day on the flat engine: the slot says so instead of throwing', async () => {
    const { createEngineSlot } = await import('../../web/src/engine-slot.ts');
    const slot = createEngineSlot(fakeEngine('flat') as never);
    expect(() => slot.setTimeOfDay?.('auto' as never)).not.toThrow();
    const off = slot.onTimeOfDay?.(() => {});
    expect(typeof off).toBe('function');
  });
});

describe('page order', () => {
  test('the top bar comes before the board in the page (screen reader and Tab order); the board still paints under it', () => {
    const ui = readFileSync(resolve(import.meta.dir, '../../web/src/ui/index.ts'), 'utf8');
    const append = ui.slice(ui.indexOf('root.append('), ui.indexOf(');', ui.indexOf('root.append(')));
    const parts = append.replace('root.append(', '').split(',').map((x) => x.trim()).filter(Boolean);
    expect(parts[0]).toBe('topbar.el');
    expect(parts.indexOf('topbar.el')).toBeLessThan(parts.indexOf('mainView.el'));
    const hud = readFileSync(resolve(import.meta.dir, '../../web/src/ui/css/hud.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const board = /\.rlt-ui \.focus-view \{([^}]*)\}/.exec(hud)?.[1] ?? '';
    expect(board).toMatch(/z-index:\s*-1/);
    const top = readFileSync(resolve(import.meta.dir, '../../web/src/ui/css/topbar.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(/\.rlt-ui \.topbar \{([^}]*)\}/.exec(top)?.[1]).not.toMatch(/z-index:\s*-/);
  });
});
