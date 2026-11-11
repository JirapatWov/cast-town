// Time of day: the user's choice (Auto / Day / Golden hour / Night), resolved against the local clock for Auto.
// Views read `night` / `golden` to switch practical lights; the engine re-lights sky, sun, grade and GI.
import type { TimeOfDay, TimeOfDayMode, TimeOfDayPhase } from '../core/types';
import { deviceStorage } from '../ui/dom';

const STORAGE_KEY = 'rlt.tod';
const MODES: TimeOfDayMode[] = ['auto', 'day', 'golden', 'night'];

/** Per-phase values every view can rely on. */
const PHASE_VALUES: Record<TimeOfDayPhase, { night: number; golden: number }> = {
  day: { night: 0, golden: 0 },
  golden: { night: 0.35, golden: 1 },
  night: { night: 1, golden: 0 },
};

export function isTimeOfDayMode(v: unknown): v is TimeOfDayMode {
  return typeof v === 'string' && (MODES as string[]).includes(v);
}

/** Local clock → phase. Golden hour around sunrise and in the late afternoon, night from dusk to dawn. */
export function phaseFromClock(d: Date = new Date()): TimeOfDayPhase {
  const h = d.getHours() + d.getMinutes() / 60;
  if (h < 5.5 || h >= 19.5) return 'night';
  if (h < 7.5 || h >= 17) return 'golden';
  return 'day';
}

/** The phase Auto switches to within the next `minutes` (null when it stays put): the engine fetches that sky shortly
 *  before it is needed instead of downloading every sky on the first visit. */
export function upcomingPhase(d: Date, minutes: number): TimeOfDayPhase | null {
  const now = phaseFromClock(d);
  const later = phaseFromClock(new Date(d.getTime() + minutes * 60_000));
  return later !== now ? later : null;
}

function loadMode(): TimeOfDayMode {
  try {
    const q = new URLSearchParams(location.search);
    const p = q.get('tod') ?? q.get('sky'); // ?sky= kept for older screenshot scripts
    if (isTimeOfDayMode(p)) return p;
  } catch {
    /* no location (tests) */
  }
  const v = deviceStorage.get(STORAGE_KEY); // the device's choice, the same in every city
  return isTimeOfDayMode(v) ? v : 'auto';
}

function saveMode(m: TimeOfDayMode) {
  deviceStorage.set(STORAGE_KEY, m);
}

export class TimeOfDayClock {
  private mode_: TimeOfDayMode = loadMode();
  private phase_: TimeOfDayPhase;
  private listeners = new Set<(tod: TimeOfDay) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.phase_ = this.resolve();
    // Auto follows the clock; checking twice a minute is plenty for phase boundaries.
    this.timer = setInterval(() => this.refresh(), 30_000);
  }

  get state(): TimeOfDay {
    const v = PHASE_VALUES[this.phase_];
    return { mode: this.mode_, phase: this.phase_, night: v.night, golden: v.golden };
  }

  get phase(): TimeOfDayPhase {
    return this.phase_;
  }

  setMode(m: TimeOfDayMode) {
    if (!isTimeOfDayMode(m)) return;
    const changedMode = m !== this.mode_;
    this.mode_ = m;
    saveMode(m);
    if (!this.refresh() && changedMode) this.emit(); // mode label changed even if the phase did not
  }

  /** Re-resolve the phase; returns true (and notifies) when it changed. */
  refresh(): boolean {
    const next = this.resolve();
    if (next === this.phase_) return false;
    this.phase_ = next;
    this.emit();
    return true;
  }

  subscribe(fn: (tod: TimeOfDay) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.listeners.clear();
  }

  private resolve(): TimeOfDayPhase {
    return this.mode_ === 'auto' ? phaseFromClock() : this.mode_;
  }

  private emit() {
    const s = this.state;
    for (const fn of this.listeners) {
      try {
        fn(s);
      } catch (e) {
        console.error('[engine] time-of-day listener failed', e);
      }
    }
  }
}

// ── shared instances ───────────────────────────────────────────────────────────────────────────
// One clock per page (the user's choice); the engine publishes the phase it actually shows at the moment it
// re-lights, so views that have no engine handle (house lighting) switch on the same frame as the sky.

let clock: TimeOfDayClock | null = null;
export function timeOfDayClock(): TimeOfDayClock {
  clock ??= new TimeOfDayClock();
  return clock;
}

let applied: TimeOfDay | null = null;
const appliedListeners = new Set<(tod: TimeOfDay) => void>();

/** The time of day on screen (before any engine publishes: the clock's current value). */
export function appliedTimeOfDay(): TimeOfDay {
  return applied ?? timeOfDayClock().state;
}

/** Subscribe to the time of day on screen; called now and on every change. */
export function onAppliedTimeOfDay(fn: (tod: TimeOfDay) => void): () => void {
  appliedListeners.add(fn);
  fn(appliedTimeOfDay());
  return () => appliedListeners.delete(fn);
}

export function publishTimeOfDay(tod: TimeOfDay) {
  applied = tod;
  for (const fn of appliedListeners) {
    try {
      fn(tod);
    } catch (e) {
      console.error('[engine] time-of-day listener failed', e);
    }
  }
}
