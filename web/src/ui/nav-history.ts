// The browser's Back and Forward for CAST (finding #50): entering a house is a step of its own in the history, so
// Back (or the Android back gesture) returns to the town instead of leaving the app, and Forward goes in again.
// Leaving a house from inside the app steps back to the town entry it came from (no city → house → city → house …
// pile-up); picking another job only updates the address.
// A dialog or the phone's panel sheet is a step too: while one is open, one extra entry (the "guard", same address)
// sits on top, so Back closes the newest one instead of leaving the place — one Back, one step back. Closing it any
// other way (Esc, ×) steps back over the guard again, so no dead entries pile up.
// Entries this page makes carry a depth in history.state. Steps are serialized: while one of our own history.back()
// calls is on its way, later pushes and replaces wait for it, so a quick "exit, then enter another house" can't
// land on the wrong entry. Only Back/Forward/address edits by the user reach onNavigate — never our own steps.

const KEY = 'castDepth';
/** Marks the guard entry of an open dialog / sheet in history.state. */
const GUARD = 'castOverlay';

export interface NavHistory {
  /** Going in (town → house): a new entry, so Back comes back here. */
  push(hash: string): void;
  /** Same place, new detail (the job picked, a link that didn't open). */
  replace(hash: string): void;
  /** Coming out (house → town): back to the entry before when this page made it, else a replace. */
  up(hash: string): void;
  /** Put a town entry under a deep link (`#/house/x` opened directly), so Back from the house lands in the town. */
  seedTown(): void;
  /** A dialog or the phone's panel sheet opened: Back calls `close` (the newest open one first, one per Back) instead
   *  of leaving the place. Call the returned function when it closes any other way. */
  overlay(close: () => void): () => void;
  /** The user went Back / Forward or edited the address — not this page's own steps. */
  onNavigate(fn: () => void): () => void;
}

/** What a history entry looks like to this module (window.history / location in the app, fakes in tests). */
export interface HistoryLike {
  readonly state: unknown;
  pushState(data: unknown, unused: string, url?: string): void;
  replaceState(data: unknown, unused: string, url?: string): void;
  back(): void;
}
export interface NavEnv {
  history: HistoryLike;
  location: { readonly hash: string; readonly href: string; readonly pathname: string; readonly search: string };
  addEventListener(type: 'popstate' | 'hashchange', fn: (ev: { state?: unknown }) => void): void;
  setTimeout(fn: () => void, ms: number): unknown;
}

const depthOf = (state: unknown): number | undefined => {
  const d = (state as Record<string, unknown> | null)?.[KEY];
  return typeof d === 'number' ? d : undefined;
};
const isGuard = (state: unknown): boolean => !!(state as Record<string, unknown> | null)?.[GUARD];

export function createNavHistory(env: NavEnv = window as unknown as NavEnv): NavHistory {
  const { history, location } = env;
  let depth = depthOf(history.state) ?? 0;
  /** The depth this document started at: entries below it belong to an earlier load (Back there reloads the page). */
  const base = depth;
  let pending = 0; // our own back() calls not yet arrived
  let queue: (() => void)[] = [];
  let lastHref = location.href;
  const fns = new Set<() => void>();
  /** Open dialogs / sheets, oldest first: Back closes the last one. */
  const overlays: { close: () => void }[] = [];
  /** The current entry is the guard of the open overlays (depth is its depth). */
  let guarded = false;
  let guardHref = '';

  /** This entry's state with our depth (and the guard mark when `guard`); a reload on a guard entry drops the mark. */
  const tag = (d: number, guard = false) => {
    const { [GUARD]: _old, ...rest } = (history.state as Record<string, unknown> | null) ?? {};
    return guard ? { ...rest, [KEY]: d, [GUARD]: 1 } : { ...rest, [KEY]: d };
  };
  history.replaceState(tag(depth), '', location.href);

  const urlOf = (hash: string) => hash || location.pathname + location.search;
  const same = (hash: string) => location.hash === hash || (hash === '' && !location.hash);
  const run = (op: () => void) => (pending ? queue.push(op) : op());
  function flush() {
    const ops = queue;
    queue = [];
    for (const op of ops) run(op);
  }
  function arrived() {
    pending = Math.max(0, pending - 1);
    lastHref = location.href;
    if (!pending) flush();
  }
  function notify() {
    if (location.href === lastHref) return;
    lastHref = location.href;
    for (const fn of fns) fn();
  }
  /** One of our own steps back. `fallback`: the address to show if the browser ignores it. */
  function stepBack(fallback?: string) {
    pending += 1;
    history.back();
    // a back() that never arrives (a browser that ignores it) must not hold later steps forever
    env.setTimeout(() => {
      if (pending) {
        pending = 0;
        if (fallback !== undefined && !same(fallback)) history.replaceState(tag(depth), '', urlOf(fallback));
        else if (isGuard(history.state)) history.replaceState(tag(depth), '', location.href);
        lastHref = location.href;
        flush();
      }
    }, 800);
  }
  /** The guard goes on top while anything is open (only from inside run()). */
  function guardOn() {
    if (guarded || !overlays.length) return;
    depth += 1;
    history.pushState({ [KEY]: depth, [GUARD]: 1 }, '', location.href);
    guarded = true;
    guardHref = lastHref = location.href;
  }
  /** …and comes off again when the last one closed some other way than Back (only from inside run()). */
  function guardOff() {
    if (!guarded || overlays.length) return;
    guarded = false;
    stepBack();
  }

  env.addEventListener('popstate', (ev) => {
    const from = depth;
    const wasGuarded = guarded;
    const d = depthOf(ev.state);
    if (d !== undefined) depth = d;
    else {
      // a new entry the browser made (the address edited by hand): one step deeper
      depth += 1;
      history.replaceState(tag(depth), '', location.href);
    }
    if (pending) return arrived();
    if (wasGuarded && depth < from) {
      // Back over the guard: the newest dialog / sheet closes, the place stays
      guarded = false;
      const top = overlays.pop();
      const onePlace = depth === from - 1;
      // the place keeps the address the guard showed (a job picked while the dialog was open)
      if (onePlace && location.href !== guardHref) history.replaceState(tag(depth), '', guardHref);
      if (onePlace) lastHref = location.href;
      top?.close();
      if (overlays.length) run(guardOn);
      if (!onePlace) notify(); // further back at once (the browser's history menu): somewhere else too
      return;
    }
    if (isGuard(ev.state) && !guarded) {
      if (overlays.length) {
        guarded = true;
        guardHref = lastHref = location.href;
        return;
      }
      // Forward onto the guard of a dialog that is closed now: nothing to show there, step back over it
      stepBack();
      return;
    }
    notify();
  });
  // Some browsers send only hashchange for an edited address; for history steps it follows popstate (same href).
  env.addEventListener('hashchange', () => {
    if (!pending) notify();
  });

  const api: NavHistory = {
    push(hash) {
      run(() => {
        if (same(hash)) return;
        if (guarded) {
          // a dialog is open over this place: the new place takes the guard's entry, the guard goes on top again
          history.replaceState({ [KEY]: depth }, '', urlOf(hash));
          guarded = false;
          lastHref = location.href;
          guardOn();
          return;
        }
        depth += 1;
        history.pushState({ [KEY]: depth }, '', urlOf(hash));
        lastHref = location.href;
      });
    },
    replace(hash) {
      run(() => {
        if (same(hash)) return;
        history.replaceState(tag(depth, guarded), '', urlOf(hash));
        lastHref = location.href;
        if (guarded) guardHref = location.href;
      });
    },
    up(hash) {
      run(() => {
        if (same(hash)) return;
        if (guarded) {
          // off the guard first, then out of the place, then the guard again for what is still open
          guarded = false;
          stepBack();
          run(() => api.up(hash));
          run(guardOn);
          return;
        }
        if (depth <= base) return api.replace(hash);
        stepBack(hash);
      });
    },
    seedTown() {
      run(() => {
        const hash = location.hash;
        if (!hash) return;
        if (guarded) {
          guarded = false;
          stepBack();
          run(() => api.seedTown());
          run(guardOn);
          return;
        }
        history.replaceState(tag(depth), '', urlOf(''));
        depth += 1;
        history.pushState({ [KEY]: depth }, '', hash);
        lastHref = location.href;
      });
    },
    overlay(close) {
      const entry = { close };
      overlays.push(entry);
      run(guardOn);
      return () => {
        const i = overlays.indexOf(entry);
        if (i < 0) return; // Back closed it
        overlays.splice(i, 1);
        if (!overlays.length) run(guardOff);
      };
    },
    onNavigate(fn) {
      fns.add(fn);
      return () => fns.delete(fn);
    },
  };
  return api;
}

let shared: NavHistory | null = null;
/** The page's one NavHistory (main.ts moves between town and houses with it; dialogs and the sheet register on it). */
export function appNav(): NavHistory {
  return (shared ??= createNavHistory());
}
