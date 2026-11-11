// Loading screen driver: real asset progress from three's DefaultLoadingManager (every GLTF/texture/HDR load
// goes through it), split into what the city needs to appear and what the house interiors need. The bar never claims
// more than it knows (finding #67): loads are counted against the size of the last complete boot (files are
// discovered while the town is built, so "done / requested so far" ran to 94% early and sat there), and when nothing
// measurable moves for a moment it says so — in words with the seconds elapsed ("· still working 6s"), while the
// town's lit windows breathe, instead of a frozen percentage.
// No three import here: the app's first chunk must not wait for three (finding #70). main.ts attaches the tracker to
// three's DefaultLoadingManager when the renderer's chunk arrives, before the first asset is asked for.
import { deviceStorage } from './ui/dom';
import { endNight } from './ui/theme';
import { TOWN_FILES_SHARE } from './ui/view-mode';

export type AssetGroup = 'city' | 'house';

interface Item {
  group: AssetGroup;
  weight: number;
  pending: number;
  done: boolean;
  label: string;
}

const LABELS: [RegExp, string, AssetGroup][] = [
  [/\/hdri\/lebombo/, 'Lighting the rooms', 'house'], // the interior's light, not a sky
  [/\/hdri\//, 'Painting the sky', 'city'],
  [/\/props-city\//, 'Lighting the streets', 'city'],
  [/\/vehicles\//, 'Parking the car', 'city'],
  [/\/textures\/(interior|laminate_floor|marble)/, 'Furnishing the houses', 'house'],
  [/\/textures\//, 'Laying the streets', 'city'],
  [/\/props-interior\//, 'Furnishing the houses', 'house'],
  [/\/characters\//, 'Waking up the residents', 'house'],
  [/\/animations\//, 'Teaching everyone to walk', 'house'],
];

let lastGroup: AssetGroup = 'city';
export function classify(url: string): { label: string; group: AssetGroup } {
  for (const [re, label, group] of LABELS) {
    if (re.test(url)) {
      lastGroup = group;
      return { label, group };
    }
  }
  // blob:/data: URLs are textures embedded in a glTF that is already being counted: no caption of their own
  if (/^(blob|data):/.test(url)) return { label: '', group: lastGroup };
  return { label: 'Loading', group: 'city' };
}

function weightOf(url: string): number {
  if (/\.(glb|gltf)(\?|$)/i.test(url)) return 6;
  if (/\.(hdr|exr)(\?|$)/i.test(url)) return 5;
  return 1;
}

/** The part of three's LoadingManager the tracker hooks (every GLTF/texture/HDR load reports through it). */
export interface LoadingManagerLike {
  itemStart(url: string): void;
  itemEnd(url: string): void;
  itemError(url: string): void;
}

export interface AssetTracker {
  /** Count the loads of this manager from now on (three's DefaultLoadingManager; once per manager). */
  attach(manager: LoadingManagerLike): void;
  /** 0..1 over everything requested so far in the given groups (or `expected` weight, when that is more). */
  progress(groups: AssetGroup[], expected?: number): number;
  /** Total weight requested so far in the given groups. */
  weight(groups: AssetGroup[]): number;
  /** Label of the most recent load still in flight. */
  current(groups: AssetGroup[]): string | null;
  onChange(fn: () => void): () => void;
}

export function trackAssets(manager?: LoadingManagerLike): AssetTracker {
  const items = new Map<string, Item>();
  const order: string[] = [];
  const listeners = new Set<() => void>();
  const changed = () => listeners.forEach((fn) => fn());
  const hooked = new WeakSet<LoadingManagerLike>();

  const finish = (url: string) => {
    const it = items.get(url);
    if (it) {
      it.pending = Math.max(0, it.pending - 1);
      if (it.pending === 0) it.done = true;
    }
    changed();
  };
  function attach(m: LoadingManagerLike) {
    if (hooked.has(m)) return;
    hooked.add(m);
    const start = m.itemStart.bind(m);
    const end = m.itemEnd.bind(m);
    const error = m.itemError.bind(m);
    m.itemStart = (url: string) => {
      let it = items.get(url);
      if (!it) {
        const c = classify(url);
        it = { ...c, weight: weightOf(url), pending: 0, done: false };
        items.set(url, it);
      }
      it.pending++;
      it.done = false;
      order.push(url);
      start(url);
      changed();
    };
    m.itemEnd = (url: string) => {
      finish(url);
      end(url);
    };
    m.itemError = (url: string) => {
      finish(url);
      error(url);
    };
  }
  if (manager) attach(manager);

  return {
    attach,
    progress(groups, expected = 0) {
      let total = 0;
      let done = 0;
      for (const it of items.values()) {
        if (!groups.includes(it.group)) continue;
        total += it.weight;
        if (it.done) done += it.weight;
      }
      total = Math.max(total, expected);
      return total ? done / total : 0;
    },
    weight(groups) {
      let total = 0;
      for (const it of items.values()) if (groups.includes(it.group)) total += it.weight;
      return total;
    },
    current(groups) {
      for (let i = order.length - 1; i >= 0; i--) {
        const it = items.get(order[i]);
        if (it && it.label && !it.done && groups.includes(it.group)) return it.label;
      }
      return null;
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/** No measurable progress for this long → the splash says "still working" (in words, with the elapsed seconds). */
export const STALL_MS = 2500;

/** The bar's arithmetic, without the DOM: phases map asset progress into [from, to]; the value only moves forward,
 *  never past the phase ceiling before done(); `waiting` is true while nothing has moved for STALL_MS, and at once in
 *  a phase with nothing to measure (from = to: compiling shaders, the first frames). */
export class BootMeter {
  private from = 0;
  private to = 0.08;
  private value_ = 0;
  private movedAt: number;
  private finished = false;
  /** The current phase has no measurable range. */
  indeterminate = false;

  constructor(now: number) {
    this.movedAt = now;
  }

  get value(): number {
    return this.value_;
  }

  phase(from: number, to: number, now: number) {
    this.from = Math.max(this.from, from, this.value_);
    this.to = Math.max(this.from, to);
    this.indeterminate = this.to - this.from < 1e-3;
    if (this.indeterminate) this.value_ = this.from;
    this.movedAt = now; // a new step is news too
    this.advance(0, now);
  }

  /** Asset progress (0..1) of the current phase. */
  advance(fraction: number, now: number) {
    const v = Math.min(this.to, this.from + (this.to - this.from) * Math.max(0, Math.min(1, fraction)));
    if (v > this.value_ + 1e-4) {
      this.value_ = v;
      this.movedAt = now;
    }
  }

  finish() {
    this.finished = true;
    this.value_ = 1;
  }

  waiting(now: number): boolean {
    return !this.finished && (this.indeterminate || now - this.movedAt > STALL_MS);
  }
}

/** Weight of the city's loads in the last complete boot: the denominator before the town has asked for its files. */
const CITY_WEIGHT_KEY = 'rlt.boot.cityWeight';
/** First visit: about what the city requested when this was written (≈60 files; GLB 6, HDR 5, image 1). */
const CITY_WEIGHT_DEFAULT = 110;

export interface BootScreen {
  /** Phase caption + progress floor/ceiling for this phase (asset progress is mapped into [from, to]). */
  phase(label: string, from: number, to: number, groups?: AssetGroup[]): void;
  setFoot(text: string): void;
  fail(message: string, actions: { reload(): void; continue2d(): void }): void;
  /** The city's files are all in: count the next boot's bar against what it really asked for. */
  cityLoaded(): void;
  /** Fade the splash away. `quick`: no pause for the bar to land first (the board takes over while the town loads). */
  done(opts?: { quick?: boolean }): Promise<void>;
}

/** What the city's loads are counted against before the town has asked for its files: the last complete boot's weight. */
export function expectedCityWeight(): number {
  const remembered = Number(deviceStorage.get(CITY_WEIGHT_KEY));
  return Number.isFinite(remembered) && remembered > 0 ? remembered : CITY_WEIGHT_DEFAULT;
}

/** The 3D town's progress for the board and the top bar after the curtain has lifted onto the board (#67) — the same
 *  rules as the curtain's bar: the city's files count against the last boot's weight, the value never goes back
 *  (newly found files used to drop it from 100 % to 53 %) and stops at TOWN_FILES_SHARE; `preparing()` marks the
 *  step with nothing to measure (building, compiling). `working` is true in that step, and while nothing measurable
 *  has moved for STALL_MS, so the UI can say "still working" instead of a frozen number. */
export function townProgress(
  tracker: Pick<AssetTracker, 'progress' | 'onChange'>,
  report: (value: number, working: boolean) => void,
  o: { now?: () => number; every?: number; weight?: number } = {},
): { preparing(): void; stop(): void } {
  const now = o.now ?? (() => performance.now());
  const weight = o.weight ?? expectedCityWeight();
  const meter = new BootMeter(now());
  meter.phase(0, TOWN_FILES_SHARE, now());
  let last = '';
  const push = () => {
    const t = now();
    meter.advance(tracker.progress(['city'], weight), t);
    const working = meter.waiting(t);
    const key = `${meter.value.toFixed(3)}|${working}`;
    if (key === last) return;
    last = key;
    report(meter.value, working);
  };
  const off = tracker.onChange(push);
  const timer = setInterval(push, o.every ?? 1000);
  push();
  return {
    preparing() {
      meter.phase(TOWN_FILES_SHARE, TOWN_FILES_SHARE, now());
      push();
    },
    stop() {
      off();
      clearInterval(timer);
    },
  };
}

/** The splash's words while nothing measurable moves, after the step's caption ("Preparing graphics… · still working 6s"). */
export const STILL_WORKING = 'still working';
const FAILED = 'Could not finish loading';

export function createBootScreen(tracker: AssetTracker): BootScreen {
  const root = document.getElementById('boot');
  const fill = document.getElementById('boot-fill');
  const step = document.getElementById('boot-step');
  const pct = document.getElementById('boot-pct');
  const foot = document.getElementById('boot-foot');
  const bar = document.getElementById('boot-bar');
  let label = 'Waking up the town…';
  let groups: AssetGroup[] = ['city'];
  const started = performance.now();
  const meter = new BootMeter(started);
  const cityWeight = expectedCityWeight();
  let shown = 0;
  let raf = 0;
  let finished = false;
  /** fail() was called: the error stays as it left it (no caption, no "still working" over it). */
  let failed = false;
  /** done({ quick }): the splash lifts onto the Town board while the 3D town is still loading, so no percentage. */
  let quick = false;

  const expected = () => (groups.length === 1 && groups[0] === 'city' ? cityWeight : 0);
  const compute = () => meter.advance(groups.length ? tracker.progress(groups, expected()) : 0, performance.now());

  const tick = () => {
    raf = 0;
    if (failed) return;
    const now = performance.now();
    compute();
    const target = meter.value;
    // ease toward the target so bursts of tiny files don't make the bar jitter
    shown += (target - shown) * 0.18;
    if (target - shown < 0.002) shown = target;
    if (fill) fill.style.transform = `scaleX(${shown.toFixed(4)})`;
    root?.style.setProperty('--boot-p', shown.toFixed(3)); // the town's windows and the sky follow the progress
    const n = Math.round(shown * 100);
    const waiting = meter.waiting(now);
    root?.classList.toggle('is-waiting', waiting);
    const live = tracker.current(groups);
    const caption = finished ? 'Welcome to town' : live ? `${live}…` : label;
    if (step) step.textContent = caption;
    // nothing measurable is moving (building geometry, compiling shaders): say so, and show time passing, not a stuck
    // number
    const secs = Math.round((now - started) / 1000);
    const handoff = finished && quick; // the board says how far the 3D town is; a number here would disagree with it
    if (pct) pct.textContent = waiting ? `· ${STILL_WORKING} ${secs}s` : handoff ? '' : `${n}%`;
    bar?.setAttribute('aria-valuenow', String(n));
    bar?.setAttribute('aria-valuetext', waiting ? `${caption} still working, ${secs} seconds` : handoff ? caption : `${caption} ${n}%`);
    if (shown < target || !finished) raf = requestAnimationFrame(tick);
  };
  const kick = () => {
    if (!raf) raf = requestAnimationFrame(tick);
  };
  tracker.onChange(() => {
    compute();
    kick();
  });
  kick();

  return {
    phase(l, f, t, g) {
      label = l;
      if (g) groups = g;
      meter.phase(f, t, performance.now());
      compute();
      if (meter.indeterminate) {
        // nothing to ease toward; draw it now, so the windows' breathing (a compositor animation) is already running
        // when the next frames block the main thread compiling shaders
        shown = meter.value;
        if (raf) cancelAnimationFrame(raf);
        tick();
      } else kick();
    },
    setFoot(text) {
      if (foot) foot.textContent = text;
    },
    cityLoaded() {
      const w = tracker.weight(['city']);
      if (w > 0) deviceStorage.set(CITY_WEIGHT_KEY, String(Math.round(w)));
    },
    fail(message, actions) {
      failed = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      root?.classList.remove('is-waiting');
      root?.classList.add('is-error');
      const t = document.getElementById('boot-error-text');
      if (t) t.textContent = message;
      if (step) step.textContent = FAILED;
      if (pct) pct.textContent = '';
      bar?.setAttribute('aria-valuetext', FAILED);
      document.getElementById('boot-reload')?.addEventListener('click', actions.reload, { once: true });
      document.getElementById('boot-2d')?.addEventListener('click', actions.continue2d, { once: true });
    },
    async done(opts) {
      finished = true;
      quick = !!opts?.quick;
      meter.finish();
      root?.classList.remove('is-waiting');
      if (!failed) {
        root?.classList.add('is-ready'); // the lamp flares: the last beat before the dive
        if (opts?.quick) root?.classList.add('is-quick'); // no beat to wait for: the flare rides the dive
      }
      // the caption now, in the frame that shows the flare: the next frames may all be the 3D town's
      if (raf) cancelAnimationFrame(raf);
      tick();
      // let the town light up, then dive into it
      if (!opts?.quick) await new Promise((r) => setTimeout(r, 380));
      root?.classList.add('is-done');
      await new Promise((r) => setTimeout(r, 720));
      if (raf) cancelAnimationFrame(raf);
      root?.remove();
      endNight(); // the installed app's night went with the splash, whether or not its sunrise had ended
    },
  };
}

/** Small caption shown over the black curtain while a slow step finishes (e.g. house still loading). */
export function curtainNote(): { show(text: string): void; hide(): void } {
  const el = document.getElementById('curtain-note');
  const txt = document.getElementById('curtain-text');
  return {
    show(text) {
      if (txt) txt.textContent = text;
      el?.classList.add('is-on');
    },
    hide() {
      el?.classList.remove('is-on');
    },
  };
}
