// Browser Back / Forward (finding #50): main.ts used history.replaceState for every view change, so Back after
// entering a house left CAST altogether. web/src/ui/nav-history.ts makes entering a house its own entry and leaving
// it step back to the town entry; an open dialog or phone panel sheet takes one Back of its own (it closes, the place
// stays). Run: bun test tests/chat/nav-history.test.ts
import { describe, expect, test } from 'bun:test';
import { createLayerStack } from '../../web/src/ui/layers';
import { createNavHistory, type NavEnv } from '../../web/src/ui/nav-history';

/** A browser history in miniature: entries, an index, async back() (popstate + hashchange later, like browsers). */
function fakeBrowser(start = 'https://cast.local/') {
  const entries: { url: string; state: unknown }[] = [{ url: start, state: null }];
  let i = 0;
  const listeners: Record<string, ((ev: { state?: unknown }) => void)[]> = { popstate: [], hashchange: [] };
  const timers: (() => void)[] = [];
  const loc = () => new URL(entries[i].url);
  const fire = (from: string) => {
    for (const fn of listeners.popstate) fn({ state: entries[i].state });
    if (new URL(from).hash !== loc().hash) for (const fn of listeners.hashchange) fn({});
  };
  const go = (d: number) => {
    const from = entries[i].url;
    const j = i + d;
    if (j < 0 || j >= entries.length) return; // nothing there: the app would leave
    i = j;
    queueMicrotask(() => fire(from));
  };
  const env: NavEnv = {
    history: {
      get state() {
        return entries[i].state;
      },
      pushState(state, _u, url) {
        entries.splice(i + 1);
        entries.push({ url: new URL(url ?? entries[i].url, entries[i].url).href, state });
        i++;
      },
      replaceState(state, _u, url) {
        entries[i] = { url: new URL(url ?? entries[i].url, entries[i].url).href, state };
      },
      back: () => go(-1),
    },
    location: {
      get hash() {
        return loc().hash;
      },
      get href() {
        return loc().href;
      },
      get pathname() {
        return loc().pathname;
      },
      get search() {
        return loc().search;
      },
    },
    addEventListener: (type, fn) => void listeners[type].push(fn),
    setTimeout: (fn) => void timers.push(fn),
  };
  return {
    env,
    /** The user presses Back / Forward. */
    back: () => go(-1),
    forward: () => go(1),
    get hash() {
      return loc().hash;
    },
    get length() {
      return entries.length;
    },
    get index() {
      return i;
    },
    timers,
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('nav history', () => {
  test('enter a house, Back returns to the town (the app stays), Forward goes in again', async () => {
    const b = fakeBrowser();
    const nav = createNavHistory(b.env);
    const seen: string[] = [];
    nav.onNavigate(() => seen.push(b.hash));
    nav.push('#/house/todo-api');
    expect(b.length).toBe(2);
    b.back();
    await tick();
    expect(b.hash).toBe('');
    expect(seen).toEqual(['']);
    b.forward();
    await tick();
    expect(seen).toEqual(['', '#/house/todo-api']);
  });

  test('leaving a house from inside the app steps back (no pile-up), and does not count as the user navigating', async () => {
    const b = fakeBrowser();
    const nav = createNavHistory(b.env);
    let calls = 0;
    nav.onNavigate(() => calls++);
    for (let k = 0; k < 3; k++) {
      nav.push('#/house/todo-api');
      nav.up('');
      await tick();
    }
    expect(b.index).toBe(0);
    expect(b.hash).toBe('');
    expect(calls).toBe(0);
  });

  test('exit then quickly enter another house: the push waits for the step back, and lands on top', async () => {
    const b = fakeBrowser();
    const nav = createNavHistory(b.env);
    nav.push('#/house/a');
    nav.up('');
    nav.push('#/house/b'); // before the back() arrived
    await tick();
    expect(b.hash).toBe('#/house/b');
    expect(b.index).toBe(1);
    expect(b.length).toBe(2);
  });

  test('the job picked only updates the address', () => {
    const b = fakeBrowser();
    const nav = createNavHistory(b.env);
    nav.push('#/house/a');
    nav.replace('#/house/a/fix-login');
    expect(b.length).toBe(2);
    expect(b.hash).toBe('#/house/a/fix-login');
  });

  test('a deep link gets a town entry underneath, so Back from the house stays in CAST', async () => {
    const b = fakeBrowser('https://cast.local/#/house/a');
    const nav = createNavHistory(b.env);
    nav.seedTown();
    expect(b.length).toBe(2);
    expect(b.hash).toBe('#/house/a');
    nav.up('');
    await tick();
    expect(b.index).toBe(0);
    expect(b.hash).toBe('');
  });

  test('after a reload inside a house, leaving it replaces instead of stepping back into the old page', () => {
    const b = fakeBrowser();
    createNavHistory(b.env).push('#/house/a');
    // reload: a new page on the same entry
    const nav = createNavHistory(b.env);
    nav.up('');
    expect(b.index).toBe(1);
    expect(b.hash).toBe('');
  });

  test('a back() that never arrives does not hold later steps forever', () => {
    const b = fakeBrowser();
    const nav = createNavHistory(b.env);
    nav.push('#/house/a');
    b.env.history.back = () => {}; // ignored by the browser
    nav.up('');
    nav.push('#/house/b');
    expect(b.hash).toBe('#/house/a');
    for (const t of b.timers) t();
    expect(b.hash).toBe('#/house/b');
  });
  // Finding #50, second part: a dialog or the phone's panel sheet is one step too.
  test('Back closes an open dialog and the place stays; the next Back leaves the house', async () => {
    const b = fakeBrowser();
    const nav = createNavHistory(b.env);
    const seen: string[] = [];
    nav.onNavigate(() => seen.push(b.hash));
    nav.push('#/house/a');
    let closed = 0;
    nav.overlay(() => closed++);
    expect(b.length).toBe(3);
    expect(b.hash).toBe('#/house/a');
    b.back();
    await tick();
    expect(closed).toBe(1);
    expect(b.hash).toBe('#/house/a');
    expect(seen).toEqual([]); // not a navigation
    b.back();
    await tick();
    expect(seen).toEqual(['']);
  });

  test('a dialog closed with Esc / × takes its entry back with it (no dead Back step)', async () => {
    const b = fakeBrowser();
    const nav = createNavHistory(b.env);
    let calls = 0;
    nav.onNavigate(() => calls++);
    nav.push('#/house/a');
    const done = nav.overlay(() => {
      throw new Error('Back must not close it again');
    });
    done();
    await tick();
    expect(b.index).toBe(1);
    expect(b.hash).toBe('#/house/a');
    expect(calls).toBe(0);
    b.back();
    await tick();
    expect(b.hash).toBe('');
    expect(calls).toBe(1);
  });

  test('two open (a confirm over a dialog, a dialog over the sheet): one Back closes one, newest first', async () => {
    const b = fakeBrowser();
    const nav = createNavHistory(b.env);
    const order: string[] = [];
    nav.overlay(() => order.push('sheet'));
    nav.overlay(() => order.push('dialog'));
    expect(b.length).toBe(2); // one guard for both
    b.back();
    await tick();
    expect(order).toEqual(['dialog']);
    b.back();
    await tick();
    expect(order).toEqual(['dialog', 'sheet']);
    expect(b.index).toBe(0);
  });

  test('closing the newest one by hand keeps Back for the one still open', async () => {
    const b = fakeBrowser();
    const nav = createNavHistory(b.env);
    let sheet = 0;
    nav.overlay(() => sheet++);
    const done = nav.overlay(() => {});
    done();
    await tick();
    expect(b.length).toBe(2);
    b.back();
    await tick();
    expect(sheet).toBe(1);
  });

  test('entering a house while the sheet is open: Back closes the sheet, then returns to the town', async () => {
    const b = fakeBrowser();
    const nav = createNavHistory(b.env);
    const seen: string[] = [];
    nav.onNavigate(() => seen.push(b.hash));
    let closed = 0;
    nav.overlay(() => closed++);
    nav.push('#/house/a');
    expect(b.hash).toBe('#/house/a');
    b.back();
    await tick();
    expect(closed).toBe(1);
    expect(b.hash).toBe('#/house/a');
    b.back();
    await tick();
    expect(seen).toEqual(['']);
  });

  test('a job picked while a dialog is open: Back closes the dialog and keeps the new address', async () => {
    const b = fakeBrowser();
    const nav = createNavHistory(b.env);
    const seen: string[] = [];
    nav.onNavigate(() => seen.push(b.hash));
    nav.push('#/house/a');
    nav.overlay(() => {});
    nav.replace('#/house/a/fix');
    b.back();
    await tick();
    await tick();
    expect(b.hash).toBe('#/house/a/fix');
    expect(seen).toEqual([]);
  });

  test('leaving the house while the sheet stays open: lands in the town, Back still closes the sheet', async () => {
    const b = fakeBrowser();
    const nav = createNavHistory(b.env);
    nav.push('#/house/a');
    let closed = 0;
    nav.overlay(() => closed++);
    nav.up('');
    for (let k = 0; k < 4; k++) await tick();
    expect(b.hash).toBe('');
    expect(b.index).toBe(1); // town + the sheet's guard
    b.back();
    await tick();
    expect(closed).toBe(1);
    expect(b.index).toBe(0);
  });

  test('Forward onto the entry of a dialog that is closed now steps back over it', async () => {
    const b = fakeBrowser();
    const nav = createNavHistory(b.env);
    let calls = 0;
    nav.onNavigate(() => calls++);
    nav.overlay(() => {});
    b.back(); // closes it
    await tick();
    b.forward();
    await tick();
    await tick();
    expect(b.index).toBe(0);
    expect(calls).toBe(0);
  });

  test('a deep link with a dialog already open (the welcome) still gets its town entry underneath', async () => {
    const b = fakeBrowser('https://cast.local/#/house/a');
    const nav = createNavHistory(b.env);
    let closed = 0;
    nav.overlay(() => closed++);
    nav.seedTown();
    for (let k = 0; k < 3; k++) await tick();
    expect(b.hash).toBe('#/house/a');
    b.back();
    await tick();
    expect(closed).toBe(1);
    expect(b.hash).toBe('#/house/a');
    nav.up('');
    await tick();
    expect(b.hash).toBe('');
    expect(b.index).toBe(0);
  });

  test('a reload while a dialog was open forgets its entry', () => {
    const b = fakeBrowser();
    createNavHistory(b.env).overlay(() => {});
    createNavHistory(b.env); // reload on the guard entry
    expect((b.env.history.state as Record<string, unknown>).castOverlay).toBeUndefined();
  });
});

describe('dialogs on the layer stack and Back', () => {
  test('a modal layer registers with Back; Back closes it and takes it off the stack; Esc releases it', async () => {
    const b = fakeBrowser();
    const nav = createNavHistory(b.env);
    const layers = createLayerStack({ onModal: (close) => nav.overlay(close) });
    let closed = 0;
    const remove = layers.push({ id: 'dlg', modal: true, close: () => (closed++, remove()) });
    layers.push({ id: 'menu', close: () => {} }); // menus don't take a Back step
    expect(b.length).toBe(2);
    b.back();
    await tick();
    expect(closed).toBe(1);
    expect(layers.has('dlg')).toBe(false);
    expect(layers.has('menu')).toBe(true);
    layers.push({ id: 'dlg2', modal: true, close: () => {} });
    expect(b.index).toBe(1);
    expect(layers.closeTop()).toBe(true); // Esc
    await tick();
    expect(b.index).toBe(0);
  });

  test('re-opening a dialog with the same id keeps one Back step, and Back closes the new one', async () => {
    const b = fakeBrowser();
    const nav = createNavHistory(b.env);
    const layers = createLayerStack({ onModal: (close) => nav.overlay(close) });
    const shut: string[] = [];
    layers.push({ id: 'viewer', modal: true, close: () => shut.push('old') });
    layers.push({ id: 'viewer', modal: true, close: () => shut.push('new') });
    expect(b.length).toBe(2);
    b.back();
    await tick();
    expect(shut).toEqual(['new']);
    expect(layers.top()).toBeUndefined();
  });
});
