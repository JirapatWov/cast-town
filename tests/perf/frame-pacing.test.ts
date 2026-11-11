// #71: the render loop rests when nothing moves, and slow devices get one offer to step quality down.
import { describe, expect, test } from 'bun:test';
import type { Quality } from '../../web/src/core/types';
import { BUDGET_DEFAULTS, FrameBudget, FramePacer, lowerQuality } from '../../web/src/engine/frame-pacing';

/** Simulated 60 Hz vsync: which frames get drawn between t0 and t1. */
function drawn(p: FramePacer, t0: number, t1: number, focused = true, vsync = 1000 / 60): number[] {
  const out: number[] = [];
  for (let t = t0; t < t1; t += vsync) if (p.shouldRender(t, focused)) out.push(t);
  return out;
}

describe('FramePacer', () => {
  test('full rate right after input, then 30 fps, then 15 fps in the background', () => {
    const p = new FramePacer(0);
    p.poke(0, true);
    expect(drawn(p, 0, 1000).length).toBeGreaterThanOrEqual(59); // within activeMs: every vsync
    const idle = drawn(p, 2000, 3000);
    expect(idle.length).toBeGreaterThanOrEqual(29);
    expect(idle.length).toBeLessThanOrEqual(31); // every other vsync, not every third
    const bg = drawn(p, 3000, 4000, false);
    expect(bg.length).toBeGreaterThanOrEqual(14);
    expect(bg.length).toBeLessThanOrEqual(16);
  });

  test('two minutes without input count as background even with the window focused', () => {
    const p = new FramePacer(0);
    expect(p.interval(60_000, true)).toBeCloseTo(1000 / 30);
    expect(p.interval(121_000, true)).toBeCloseTo(1000 / 15);
    p.poke(121_000); // motion that is not input (a camera easing out) gives full rate but does not count as use
    expect(p.interval(121_500, true)).toBe(0);
    expect(p.interval(123_000, true)).toBeCloseTo(1000 / 15);
    p.poke(124_000, true);
    expect(p.interval(126_000, true)).toBeCloseTo(1000 / 30);
  });

  test('input brings the very next frame back', () => {
    const p = new FramePacer(0);
    expect(p.shouldRender(5000, true)).toBe(true);
    expect(p.shouldRender(5016, true)).toBe(false);
    p.poke(5020, true);
    expect(p.shouldRender(5033, true)).toBe(true);
    expect(p.fullRate(5033)).toBe(true);
  });
});

describe('FrameBudget', () => {
  const N = BUDGET_DEFAULTS.window;
  const feed = (b: FrameBudget, ms: number, n: number, t0: number) => {
    let hit = -1;
    for (let i = 0; i < n; i++) if (b.sample(ms, t0 + i * ms) && hit < 0) hit = i;
    return hit;
  };

  test('consistently slow frames trigger once, fast or mixed frames never', () => {
    expect(feed(new FrameBudget(), 16.7, 600, 0)).toBe(-1);
    const mixed = new FrameBudget();
    let hits = 0;
    for (let i = 0; i < 600; i++) if (mixed.sample(i % 2 ? 50 : 16, i * 33)) hits++;
    expect(hits).toBe(0); // half the frames slow: a hiccup pattern, not a slow device
    const b = new FrameBudget();
    expect(feed(b, 45, N, 0)).toBe(N - 1);
  });

  test('after a verdict and after hold() it waits out the settle time', () => {
    const b = new FrameBudget();
    expect(feed(b, 45, N, 0)).toBe(N - 1);
    const t = (N - 1) * 45;
    expect(feed(b, 45, N, t + 10)).toBe(-1); // within settleMs: ignored
    const later = t + BUDGET_DEFAULTS.settleMs + 1;
    expect(feed(b, 45, N, later)).toBe(N - 1);
    b.hold(100_000);
    expect(feed(b, 45, N, 100_000)).toBe(-1);
  });
});

test('lowerQuality steps one preset down and stops at low', () => {
  expect(lowerQuality('ultra')).toBe('high');
  expect(lowerQuality('high')).toBe('medium');
  expect(lowerQuality('medium')).toBe('low');
  expect(lowerQuality('low')).toBeNull();
});

describe('auto quality (UI side)', async () => {
  // ui/dom.ts → net/base.ts reads location once at import time; leave no stub behind for other test files
  const g = globalThis as { location?: unknown };
  const stub = g.location === undefined;
  if (stub) g.location = { pathname: '/', search: '', protocol: 'http:', host: 'localhost' };
  const { autoQuality, AUTO_QUALITY_KEY } = await import('../../web/src/ui/auto-quality');
  if (stub) delete g.location;

  function rig(start: Quality) {
    let q = start;
    const kv = new Map<string, string>();
    const toasts: { text: string; onClick?: () => void }[] = [];
    const subs = new Set<(q: Quality) => void>();
    const setQ = (n: Quality) => {
      if (n === q) return;
      q = n;
      for (const fn of subs) fn(n);
    };
    const a = autoQuality({
      quality: () => q,
      setQuality: setQ,
      toast: (text, onClick) => toasts.push({ text, onClick }),
      onQualityChange: (fn) => {
        subs.add(fn);
        return () => subs.delete(fn);
      },
      store: { get: (k) => kv.get(k) ?? null, set: (k, v) => void kv.set(k, v) },
    });
    return { a, kv, toasts, get q() { return q; }, pick: setQ };
  }

  test('steps down with a toast; clicking it undoes and opts the device out', () => {
    const r = rig('high');
    r.a.advise('high', 'medium');
    expect(r.q).toBe('medium');
    expect(r.toasts[0].text).toContain('Medium');
    r.toasts[0].onClick!();
    expect(r.q).toBe('high');
    expect(r.kv.get(AUTO_QUALITY_KEY)).toBe('off');
    r.a.advise('high', 'medium');
    expect(r.q).toBe('high'); // opted out
  });

  test('picking a higher preset by hand after a step-down also opts out; a lower one does not', () => {
    const r = rig('ultra');
    r.a.advise('ultra', 'high');
    r.pick('low');
    expect(r.kv.get(AUTO_QUALITY_KEY)).toBeUndefined();
    const r2 = rig('ultra');
    r2.a.advise('ultra', 'high');
    r2.pick('ultra');
    expect(r2.kv.get(AUTO_QUALITY_KEY)).toBe('off');
  });

  test('stale advice (quality changed meanwhile) and step-ups are ignored', () => {
    const r = rig('medium');
    r.a.advise('high', 'medium');
    r.a.advise('medium', 'high');
    expect(r.q).toBe('medium');
    expect(r.toasts.length).toBe(0);
  });
});
