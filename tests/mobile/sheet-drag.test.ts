// The phone sheet's drag (web/src/ui/touch.ts installSheetDrag). Regression: the drag used to capture the pointer on
// press, so a mouse or trackpad click on the handle (a narrow desktop window) went to the panel and the handle's
// own click (half ↔ full) never ran. The pointer is now captured only once the finger or mouse really moves.
import { describe, expect, test } from 'bun:test';
import { installSheetDrag, type SheetPointer, type SheetSnap } from '../../web/src/ui/touch';

function fakePanel(height = 412) {
  const listeners = new Map<string, ((ev: SheetPointer) => void)[]>();
  const classes = new Set<string>();
  const captured = new Set<number>();
  const el = {
    offsetHeight: height,
    style: { height: '' },
    classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c), contains: (c: string) => classes.has(c) },
    addEventListener(type: string, fn: (ev: SheetPointer) => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    setPointerCapture: (id: number) => void captured.add(id),
    hasPointerCapture: (id: number) => captured.has(id),
    releasePointerCapture: (id: number) => void captured.delete(id),
    captures: 0,
  };
  const orig = el.setPointerCapture;
  el.setPointerCapture = (id: number) => {
    el.captures++;
    orig(id);
  };
  const fire = (type: string, clientY: number, timeStamp: number, target: unknown = 'handle') =>
    (listeners.get(type) ?? []).forEach((f) => f({ type, pointerId: 1, clientY, timeStamp, button: 0, target }));
  return { el, fire, classes, captured };
}

const ROOT_H = 664;

describe('sheet drag', () => {
  test('a tap on the handle never captures the pointer, so the click reaches the handle', () => {
    const { el, fire } = fakePanel();
    const settled: SheetSnap[] = [];
    const drag = installSheetDrag(el, { canStart: (t) => t === 'handle', rootH: () => ROOT_H, settle: (s) => settled.push(s) });
    fire('pointerdown', 300, 0);
    fire('pointermove', 302, 16); // a wobble under the 6 px threshold
    fire('pointerup', 302, 40);
    expect(el.captures).toBe(0);
    expect(settled).toEqual([]);
    expect(drag.consumeClick()).toBe(false); // the handle's click toggles half ↔ full
  });

  test('a real drag captures once, follows the finger and settles; its click is swallowed once', () => {
    const { el, fire, classes, captured } = fakePanel(600);
    const settled: SheetSnap[] = [];
    let started = 0;
    const drag = installSheetDrag(el, { canStart: () => true, rootH: () => ROOT_H, onStart: () => started++, settle: (s) => settled.push(s) });
    fire('pointerdown', 100, 0);
    expect(el.captures).toBe(0);
    for (let i = 1; i <= 10; i++) fire('pointermove', 100 + i * 20, i * 120); // slow: 20 px every 120 ms
    expect(el.captures).toBe(1);
    expect(started).toBe(1);
    expect(classes.has('is-dragging')).toBe(true);
    expect(el.style.height).toBe('400px');
    el.offsetHeight = 400; // what the browser lays out from that height
    fire('pointerup', 300, 1300);
    expect(settled).toEqual(['half']); // 400 px is nearest the 62 % stop (412)
    expect(captured.size).toBe(0);
    expect(classes.has('is-dragging')).toBe(false);
    expect(el.style.height).toBe('');
    expect(drag.consumeClick()).toBe(true);
    expect(drag.consumeClick()).toBe(false);
  });

  test('a flick down from half closes; presses outside the drag zone do nothing', () => {
    const { el, fire } = fakePanel(412);
    const settled: SheetSnap[] = [];
    installSheetDrag(el, { canStart: (t) => t === 'handle', rootH: () => ROOT_H, settle: (s) => settled.push(s) });
    fire('pointerdown', 260, 0, 'transcript');
    fire('pointermove', 400, 30, 'transcript');
    fire('pointerup', 400, 40, 'transcript');
    expect(settled).toEqual([]);
    expect(el.captures).toBe(0);
    fire('pointerdown', 260, 100);
    fire('pointermove', 310, 110);
    fire('pointermove', 410, 120);
    el.offsetHeight = 262;
    fire('pointerup', 410, 125);
    expect(settled).toEqual(['closed']);
  });

  test('a cancelled drag goes back to where the sheet was', () => {
    const { el, fire, classes } = fakePanel(600);
    classes.add('is-expanded');
    const settled: SheetSnap[] = [];
    installSheetDrag(el, { canStart: () => true, rootH: () => ROOT_H, settle: (s) => settled.push(s) });
    fire('pointerdown', 100, 0);
    fire('pointermove', 200, 100);
    fire('pointercancel', 200, 120);
    expect(settled).toEqual(['full']);
  });
});

describe('sheetSnap counts a flick from the stop it started at', () => {
  // iPhone SE: 568 px root → full 504, half 352: a 150 px flick down from full lifts at ~354 px
  const half = 568 * 0.62;
  const full = 568 - 64;
  test('a long flick down from full stops at half on a short phone', async () => {
    const { sheetSnap } = await import('../../web/src/ui/touch');
    expect(sheetSnap(354, 5, half, full, 'full')).toBe('half');
    expect(sheetSnap(354, 5, half, full, 'half')).toBe('closed');
    // without knowing where it started: the old rule (one stop from where the finger lifted)
    expect(sheetSnap(354, 5, half, full)).toBe('closed');
    // flung almost to the bottom from full: closed after all
    expect(sheetSnap(150, 5, half, full, 'full')).toBe('closed');
  });
  test('the drag passes where it started (is-expanded → full)', () => {
    const { el, fire, classes } = fakePanel(504);
    classes.add('is-expanded');
    const settled: SheetSnap[] = [];
    installSheetDrag(el, { canStart: () => true, rootH: () => 568, settle: (s) => settled.push(s) });
    fire('pointerdown', 100, 0);
    fire('pointermove', 175, 5);
    fire('pointermove', 250, 10);
    el.offsetHeight = 354;
    fire('pointerup', 250, 15);
    expect(settled).toEqual(['half']);
  });
});
