// `?settings=<section>` (web/src/ui/settings-link.ts): the Mac menu bar's "Pair a phone…" opens CAST at
// `/?settings=pair`; the page opens Settings there and takes the parameter out of the address (a reload must not open
// the dialog again), keeping everything else in it.
import { describe, expect, test } from 'bun:test';
import { holdInView, searchWithoutSettings, settingsFromSearch, takeSettingsLink, type HoldEnv } from '../../web/src/ui/settings-link';

describe('?settings= deep link', () => {
  test('a known section, Settings without one, nothing', () => {
    expect(settingsFromSearch('?settings=pair')).toBe('pair');
    expect(settingsFromSearch('?2d&settings=Devices')).toBe('devices');
    expect(settingsFromSearch('?settings')).toBe('');
    expect(settingsFromSearch('?settings=nope')).toBe('');
    expect(settingsFromSearch('')).toBeNull();
    expect(settingsFromSearch('?view=board')).toBeNull();
  });

  test('the parameter leaves the address; the rest stays', () => {
    expect(searchWithoutSettings('?settings=pair')).toBe('');
    expect(searchWithoutSettings('?2d=&settings=pair&q=low')).toBe('?2d=&q=low');
    // as written: a flag stays a flag (`?2d`, not `?2d=`), encodings are not redone
    expect(searchWithoutSettings('?2d&settings=pair')).toBe('?2d');
    expect(searchWithoutSettings('?settings&a=x%20y&b=1+2&settings=devices')).toBe('?a=x%20y&b=1+2');
    expect(searchWithoutSettings('?%73ettings=pair&2d')).toBe('?2d');
    expect(searchWithoutSettings('?2d')).toBe('?2d');
    expect(searchWithoutSettings('')).toBe('');
  });

  test('takeSettingsLink replaces the address once, keeping the history state and the hash', () => {
    const calls: [unknown, string][] = [];
    const hist = { state: { depth: 3 }, replaceState: (s: unknown, _t: string, url?: string | URL | null) => void calls.push([s, String(url)]) };
    expect(takeSettingsLink({ pathname: '/', search: '?settings=pair', hash: '#/house/todo' }, hist)).toBe('pair');
    expect(calls).toEqual([[{ depth: 3 }, '/#/house/todo']]);
    expect(takeSettingsLink({ pathname: '/', search: '', hash: '' }, hist)).toBeNull();
    expect(calls.length).toBe(1);
  });

  test('the asked-for section stays at the top while the devices list above it loads, until the person moves', () => {
    // A fake browser: a ResizeObserver whose callback the test fires (the devices list arriving), a timer, and the
    // window's event listeners.
    let resized: (() => void) | null = null;
    let observing: unknown = null;
    let disconnected = 0;
    class FakeRO {
      constructor(cb: () => void) {
        resized = cb;
      }
      observe(t: unknown) {
        observing = t;
      }
      disconnect() {
        disconnected++;
        resized = null;
      }
    }
    const listeners = new Map<string, () => void>();
    let timer: (() => void) | null = null;
    const env: HoldEnv = {
      ResizeObserver: FakeRO,
      events: {
        addEventListener: (type, fn) => void listeners.set(type, fn as () => void),
        removeEventListener: (type) => void listeners.delete(type),
      },
      setTimeout: (fn) => ((timer = fn), 1),
      clearTimeout: () => void (timer = null),
    };
    const scrolls: unknown[] = [];
    const section = { scrollIntoView: (o?: unknown) => void scrolls.push(o) };
    const content = { id: 'set-body' };

    // the list arrives twice (loading → rows): the section is scrolled back to the top each time
    holdInView(section, content, 3000, env);
    expect(observing).toBe(content);
    resized!();
    resized!();
    expect(scrolls).toEqual([{ block: 'start' }, { block: 'start' }]);
    // the person scrolls the dialog themselves: from then on it is theirs
    expect([...listeners.keys()].sort()).toEqual(['keydown', 'pointerdown', 'touchstart', 'wheel']);
    listeners.get('wheel')!();
    expect(disconnected).toBe(1);
    expect(listeners.size).toBe(0);
    expect(timer).toBeNull();

    // or the time is up; stopping twice is harmless
    scrolls.length = 0;
    const stop = holdInView(section, content, 3000, env);
    timer!();
    expect(resized).toBeNull();
    stop();
    expect(disconnected).toBe(2);
    expect(scrolls).toEqual([]);

    // no ResizeObserver (an old browser): nothing to hold, nothing breaks
    expect(() => holdInView(section, content, 3000, { ...env, ResizeObserver: undefined })()).not.toThrow();
  });
});

describe('PWA links', () => {
  test('?settings=notifications opens Notifications & app (the manifest shortcut)', () => {
    expect(settingsFromSearch('?settings=notifications')).toBe('notifications');
  });

  test('?panel=inbox (the Inbox shortcut, a summary notification) is read once and leaves the address', async () => {
    const { panelFromSearch, takePanelLink } = await import('../../web/src/pwa/launch');
    expect(panelFromSearch('?panel=inbox&x=1')).toBe('inbox');
    expect(panelFromSearch('?panel=nope')).toBeNull();
    expect(panelFromSearch('?x=1')).toBeNull();
    const calls: string[] = [];
    const hist = { state: null, replaceState: (_s: unknown, _t: string, url?: string | URL | null) => void calls.push(String(url)) };
    expect(takePanelLink({ search: '?panel=inbox&x=1', pathname: '/', hash: '#/house/a' }, hist)).toBe('inbox');
    expect(calls).toEqual(['/?x=1#/house/a']);
    expect(takePanelLink({ search: '?x=1', pathname: '/', hash: '' }, hist)).toBeNull();
    expect(calls).toHaveLength(1);
  });
});
