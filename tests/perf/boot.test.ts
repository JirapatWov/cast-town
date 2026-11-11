// #67: the boot bar never sits on a frozen percentage — it maps real asset progress, stops at each phase's ceiling,
// and says "still working" (sheen + seconds) when nothing measurable moves, at once for steps with nothing to measure.
import { describe, expect, test } from 'bun:test';

// boot.ts → ui/dom.ts → net/base.ts reads location once at import time; leave no stub behind for other test files
const g = globalThis as { location?: unknown };
const stub = g.location === undefined;
if (stub) g.location = { pathname: '/', search: '', protocol: 'http:', host: 'localhost' };
const { BootMeter, STALL_MS, classify, townProgress } = await import('../../web/src/boot');
const { TOWN_FILES_SHARE } = await import('../../web/src/ui/view-mode');
if (stub) delete g.location;

describe('BootMeter', () => {
  test('maps progress into the phase and never past its ceiling, never backwards', () => {
    const m = new BootMeter(0);
    m.phase(0.12, 0.8, 0);
    m.advance(0.5, 10);
    expect(m.value).toBeCloseTo(0.46);
    m.advance(0.25, 20); // a newly discovered file lowers the fraction: the bar holds
    expect(m.value).toBeCloseTo(0.46);
    m.advance(1.5, 30);
    expect(m.value).toBeCloseTo(0.8);
    m.phase(0.5, 0.9, 40); // a later phase never starts below what is shown
    expect(m.value).toBeCloseTo(0.8);
    m.finish();
    expect(m.value).toBe(1);
  });

  test('waiting after STALL_MS without progress, cleared by progress or a new phase', () => {
    const m = new BootMeter(0);
    m.phase(0, 0.8, 0);
    expect(m.waiting(STALL_MS - 1)).toBe(false);
    expect(m.waiting(STALL_MS + 1)).toBe(true);
    m.advance(0.1, STALL_MS + 2);
    expect(m.waiting(STALL_MS + 3)).toBe(false);
    m.phase(0.8, 0.9, 10_000);
    expect(m.waiting(10_001)).toBe(false);
  });

  test('a phase with nothing to measure is "still working" at once; done() ends it', () => {
    const m = new BootMeter(0);
    m.phase(0.12, 0.8, 0);
    m.advance(0.3, 5);
    m.phase(0.8, 0.8, 100);
    expect(m.indeterminate).toBe(true);
    expect(m.value).toBeCloseTo(0.8);
    expect(m.waiting(101)).toBe(true);
    m.finish();
    expect(m.waiting(102)).toBe(false);
  });
});

test('classify: interior files count for the house, not the city', () => {
  expect(classify('/assets/hdri/lebombo_1k.hdr').group).toBe('house');
  expect(classify('/assets/hdri/kloofendal_48d_partly_cloudy_puresky_1k.hdr')).toEqual({ label: 'Painting the sky', group: 'city' });
  expect(classify('/assets/textures/laminate_floor_02/512/laminate_floor_02_diff_1k.webp').group).toBe('house');
  expect(classify('/assets/textures/asphalt_02/asphalt_02_diff_1k.webp').group).toBe('city');
  expect(classify('/assets/characters/rocketbox/f07.glb').group).toBe('house');
  expect(classify('/assets/props-city/street_lamp_01_1k.glb').group).toBe('city');
});

// After the curtain lifts onto the board (STAND_IN_MS), the board's lead line and the top bar's 3D label show the
// town's progress. They used tracker.progress() raw: 0 % for 20 s, then 14 → 100 → 53 % (new files raise the total),
// then 53 % for 9 s while the town was built — the frozen bar of #67, moved to a new place.
describe('townProgress (the board and the top bar)', () => {
  function fakeTracker() {
    let frac = 0;
    const fns = new Set<() => void>();
    return {
      set(f: number) {
        frac = f;
        fns.forEach((fn) => fn());
      },
      progress: () => frac,
      onChange(fn: () => void) {
        fns.add(fn);
        return () => fns.delete(fn);
      },
      listeners: () => fns.size,
    };
  }

  test('never goes back, stops below 100 % until the town is built, then says it is getting the graphics ready', () => {
    let t = 0;
    const tr = fakeTracker();
    const seen: [number, boolean][] = [];
    const p = townProgress(tr, (v, w) => seen.push([v, w]), { now: () => t, every: 60_000, weight: 125 });
    expect(seen.at(-1)).toEqual([0, false]);
    t = 100;
    tr.set(0.14);
    t = 200;
    tr.set(1); // the first files are all in…
    t = 300;
    tr.set(0.53); // …then the town asks for more: the old bar dropped to 53 %
    const values = seen.map(([v]) => v);
    expect(values.every((v, i) => i === 0 || v >= values[i - 1])).toBe(true);
    expect(Math.max(...values)).toBeCloseTo(TOWN_FILES_SHARE);
    p.preparing();
    expect(seen.at(-1)).toEqual([TOWN_FILES_SHARE, true]);
    p.stop();
    expect(tr.listeners()).toBe(0);
  });

  test('says "still working" when nothing measurable moved for a while, and not once files arrive again', () => {
    let t = 0;
    const tr = fakeTracker();
    const seen: [number, boolean][] = [];
    const p = townProgress(tr, (v, w) => seen.push([v, w]), { now: () => t, every: 60_000, weight: 125 });
    t = STALL_MS + 10;
    tr.set(0); // a tick with no progress (the interval does this in the app)
    expect(seen.at(-1)?.[1]).toBe(true);
    t += 10;
    tr.set(0.2);
    expect(seen.at(-1)).toEqual([0.2 * TOWN_FILES_SHARE, false]);
    p.stop();
  });
});
