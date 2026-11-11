// `?settings=<section>` opens Settings at that section once the page is up (`/?settings=pair` = Pair a phone: the Mac
// menu-bar app's "Pair a phone…" lands there through a one-time sign-in link). `?settings` alone opens Settings. The
// parameter is taken out of the address right away, so a reload or a shared link doesn't open the dialog again.
import type { SettingsSection } from './settings';

const SECTIONS: readonly SettingsSection[] = ['view', 'keyboard', 'a11y', 'devices', 'pair', 'terminal', 'data', 'notifications'];

/** The section `?settings=` asks for: a section id, '' for Settings without one, null when the address has none
 *  (an unknown section counts as none given: Settings opens at the top). */
export function settingsFromSearch(search: string): SettingsSection | '' | null {
  const q = new URLSearchParams(search);
  if (!q.has('settings')) return null;
  const v = (q.get('settings') ?? '').trim().toLowerCase();
  return (SECTIONS as readonly string[]).includes(v) ? (v as SettingsSection) : '';
}

/** The search string without `settings`, the rest as it was written (URLSearchParams would turn a flag like `?2d`
 *  into `?2d=` and re-encode values). */
export function searchWithoutSettings(search: string): string {
  return searchWithout(search, 'settings');
}

/** The search string without the parameter `name`, the rest as it was written. */
export function searchWithout(search: string, name: string): string {
  const key = (part: string) => {
    const k = part.split('=', 1)[0]!.replace(/\+/g, ' ');
    try {
      return decodeURIComponent(k);
    } catch {
      return k;
    }
  };
  const kept = search.replace(/^\?/, '').split('&').filter((part) => part && key(part) !== name);
  return kept.length ? `?${kept.join('&')}` : '';
}

/** Read and remove `?settings=` from this page's address (keeping its history entry's state). */
export function takeSettingsLink(loc: Pick<Location, 'search' | 'pathname' | 'hash'> = location, hist: Pick<History, 'replaceState' | 'state'> = history): SettingsSection | '' | null {
  const asked = settingsFromSearch(loc.search);
  if (asked === null) return null;
  try {
    hist.replaceState(hist.state, '', `${loc.pathname}${searchWithoutSettings(loc.search)}${loc.hash}`);
  } catch {
    /* the dialog still opens; only the address keeps the parameter */
  }
  return asked;
}

type Observer = { observe(target: never): void; disconnect(): void };
/** What holdInView needs from the browser (tests pass a fake). */
export interface HoldEnv {
  ResizeObserver: (new (cb: () => void) => Observer) | undefined;
  events: { addEventListener(type: string, fn: () => void, capture: boolean): void; removeEventListener(type: string, fn: () => void, capture: boolean): void };
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

const browserEnv = (): HoldEnv => ({
  ResizeObserver: typeof ResizeObserver === 'function' ? (ResizeObserver as unknown as HoldEnv['ResizeObserver']) : undefined,
  events: window,
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (id) => window.clearTimeout(id as number),
});

/** The person's own scrolling, clicking or typing: from then on the dialog's scroll position is theirs. */
const PERSON_MOVES = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;

/** Keep `el` (the section Settings opened at, e.g. Pair a phone) at the top of the dialog while `content` changes size
 *  above it: the devices list loads after the dialog opens and pushes every section below it down, out of view on a
 *  machine with a few paired devices. Holds until the person scrolls, clicks or types, or `ms` have passed — generous,
 *  because a page still starting up (the town loading) can keep the list from arriving for seconds. Returns a function
 *  that stops it. */
export function holdInView(el: { scrollIntoView(o: ScrollIntoViewOptions): void }, content: object, ms = 10_000, env: HoldEnv = browserEnv()): () => void {
  const RO = env.ResizeObserver;
  if (!RO) return () => {};
  let done = false;
  let timer: unknown = null;
  const ro = new RO(() => {
    if (!done) el.scrollIntoView({ block: 'start' });
  });
  const stop = () => {
    if (done) return;
    done = true;
    ro.disconnect();
    env.clearTimeout(timer);
    for (const t of PERSON_MOVES) env.events.removeEventListener(t, stop, true);
  };
  timer = env.setTimeout(stop, ms);
  for (const t of PERSON_MOVES) env.events.addEventListener(t, stop, true);
  ro.observe(content as never);
  return stop;
}
