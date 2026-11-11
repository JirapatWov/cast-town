// Render-loop pacing and the slow-frame watchdog (finding #71). CAST is usually left open all day: a town that
// redraws 60 times a second while nobody touches it keeps a laptop's fan and battery busy for nothing.
//   FramePacer   full rate while something moves (input on the canvas, the camera, a transition, a GI bake); 30 fps
//                when only the residents' idle animations play; 15 fps when the window is in the background or
//                untouched for two minutes. Input brings full rate back on the very next frame.
//   FrameBudget  frames that stay slower than 30 fps for a few seconds (while drawing every frame) → suggest the next
//                lower quality preset. The UI asks first-time with a toast and an Undo; it never steps up on its own.
// Both are plain state machines fed with timestamps, so they are tested without a renderer.
import type { Quality } from '../core/types';

export interface PacerOptions {
  /** Full rate for this long after the last sign of motion. */
  activeMs: number;
  idleFps: number;
  backgroundFps: number;
  /** No input for this long counts as "in the background" even with the window focused. */
  backgroundAfterMs: number;
}

export const PACER_DEFAULTS: PacerOptions = { activeMs: 1500, idleFps: 30, backgroundFps: 15, backgroundAfterMs: 120_000 };

export class FramePacer {
  private lastMotion = -Infinity;
  private lastInput: number;
  private lastRender = -Infinity;

  constructor(
    now: number,
    private readonly o: PacerOptions = PACER_DEFAULTS,
  ) {
    this.lastInput = now; // a fresh page counts as just used
  }

  /** Something moved (camera, transition, bake) or, with `input`, the person did something on the canvas. */
  poke(now: number, input = false) {
    this.lastMotion = now;
    if (input) this.lastInput = now;
  }

  /** Minimum time between frames now (0 = every frame). */
  interval(now: number, focused: boolean): number {
    if (now - this.lastMotion < this.o.activeMs) return 0;
    if (!focused || now - this.lastInput > this.o.backgroundAfterMs) return 1000 / this.o.backgroundFps;
    return 1000 / this.o.idleFps;
  }

  /** Called on every animation frame: true when this one should be drawn. */
  shouldRender(now: number, focused: boolean): boolean {
    const iv = this.interval(now, focused);
    // a few ms of slack: at 60 Hz a 30 fps cap must draw every other vsync, not every third
    if (iv === 0 || now - this.lastRender >= iv - 4) {
      this.lastRender = now;
      return true;
    }
    return false;
  }

  /** True while drawing every frame (frame times then say how fast the device really is). */
  fullRate(now: number): boolean {
    return now - this.lastMotion < this.o.activeMs;
  }
}

export interface BudgetOptions {
  /** A frame slower than this misses 30 fps. */
  slowMs: number;
  /** Frames looked at. */
  window: number;
  /** Share of them that must be slow. */
  share: number;
  /** After a view switch, a quality change or a step down: shaders compile, frames are slow on purpose. */
  settleMs: number;
}

export const BUDGET_DEFAULTS: BudgetOptions = { slowMs: 1000 / 30 + 0.5, window: 90, share: 0.75, settleMs: 8000 };

export class FrameBudget {
  private samples: number[] = [];
  private quietUntil = 0;

  constructor(private readonly o: BudgetOptions = BUDGET_DEFAULTS) {}

  /** Ignore frames for a while (and forget what was seen). */
  hold(now: number, ms = this.o.settleMs) {
    this.quietUntil = Math.max(this.quietUntil, now + ms);
    this.samples.length = 0;
  }

  /** One frame time (ms) of back-to-back drawing. True once frames have been consistently too slow; then it holds
   *  itself so the next verdict looks at the frames after whatever the caller changes. */
  sample(ms: number, now: number): boolean {
    if (now < this.quietUntil) return false;
    this.samples.push(ms);
    if (this.samples.length > this.o.window) this.samples.shift();
    if (this.samples.length < this.o.window) return false;
    const slow = this.samples.filter((s) => s > this.o.slowMs).length;
    if (slow < this.o.share * this.o.window) return false;
    this.hold(now);
    return true;
  }
}

const ORDER: Quality[] = ['low', 'medium', 'high', 'ultra'];

/** The preset one step below, or null at the bottom. */
export function lowerQuality(q: Quality): Quality | null {
  const i = ORDER.indexOf(q);
  return i > 0 ? ORDER[i - 1] : null;
}

// ── advice for the UI (the engine has no UI handle; the UI decides and asks) ─────────────────────
const adviceListeners = new Set<(from: Quality, to: Quality) => void>();

/** The engine saw consistently slow frames at `from`; `to` is the suggested preset. */
export function onQualityAdvice(fn: (from: Quality, to: Quality) => void): () => void {
  adviceListeners.add(fn);
  return () => adviceListeners.delete(fn);
}

export function adviseQuality(from: Quality, to: Quality) {
  for (const fn of adviceListeners) {
    try {
      fn(from, to);
    } catch (e) {
      console.error('[engine] quality advice listener failed', e);
    }
  }
}
