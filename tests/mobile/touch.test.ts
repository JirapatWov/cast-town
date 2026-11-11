// Phones and tablets: the pure helpers in web/src/ui/touch.ts (Return key, on-screen keyboard inset, sheet snapping,
// "Tap" vs "Click") and the fix that keeps the shared 3D canvas at touch-action: none (web/src/house/camera.ts).
// Run: bun test tests/mobile
import { describe, expect, test } from 'bun:test';
import { enterSends, KEYBOARD_MIN_PX, keyboardInset, pointWord, sheetSnap } from '../../web/src/ui/touch';

describe('enterSends', () => {
  test('hardware keyboard: Return sends, on-screen keyboard: Return adds a line', () => {
    expect(enterSends({ touch: false, pref: null })).toBe(true);
    expect(enterSends({ touch: true, pref: null })).toBe(false);
    expect(enterSends({ touch: true, pref: undefined })).toBe(false);
  });
  test("the user's choice wins on any device", () => {
    expect(enterSends({ touch: true, pref: '1' })).toBe(true);
    expect(enterSends({ touch: false, pref: '0' })).toBe(false);
  });
  test('an unknown stored value falls back to the device default', () => {
    expect(enterSends({ touch: true, pref: 'yes' })).toBe(false);
    expect(enterSends({ touch: false, pref: '' })).toBe(true);
  });
});

describe('keyboardInset', () => {
  test('no visual viewport or no layout height: no keyboard', () => {
    expect(keyboardInset(800, null)).toBe(0);
    expect(keyboardInset(800, undefined)).toBe(0);
    expect(keyboardInset(0, { height: 400, offsetTop: 0 })).toBe(0);
  });
  test('iPhone 13 portrait with the keyboard up', () => {
    // 664 px layout viewport, the keyboard takes 336 px
    const kb = keyboardInset(664, { height: 328, offsetTop: 0, scale: 1 });
    expect(kb).toBe(336);
    expect(kb).toBeGreaterThanOrEqual(KEYBOARD_MIN_PX);
  });
  test('the visual viewport scrolled up by the browser counts', () => {
    expect(keyboardInset(664, { height: 328, offsetTop: 40 })).toBe(296);
  });
  test('browser bars sliding away stay under the keyboard threshold', () => {
    expect(keyboardInset(664, { height: 600, offsetTop: 0 })).toBeLessThan(KEYBOARD_MIN_PX);
  });
  test('a pinch-zoomed page is not a keyboard', () => {
    expect(keyboardInset(664, { height: 300, offsetTop: 120, scale: 2 })).toBe(0);
  });
  test('never negative', () => {
    expect(keyboardInset(500, { height: 520, offsetTop: 0 })).toBe(0);
  });
});

describe('sheetSnap', () => {
  const half = 412; // 62 % of 664
  const full = 600; // 664 - 64
  test('a slow drag settles on the nearest stop', () => {
    expect(sheetSnap(430, 0, half, full)).toBe('half');
    expect(sheetSnap(560, 0.1, half, full)).toBe('full');
    expect(sheetSnap(520, -0.2, half, full)).toBe('full');
    expect(sheetSnap(480, 0, half, full)).toBe('half');
  });
  test('dragged below half of the half height: closed', () => {
    expect(sheetSnap(180, 0, half, full)).toBe('closed');
    expect(sheetSnap(220, 0, half, full)).toBe('half');
  });
  test('a flick down goes one stop down', () => {
    expect(sheetSnap(580, 1.2, half, full)).toBe('half');
    expect(sheetSnap(400, 0.9, half, full)).toBe('closed');
    expect(sheetSnap(half + 4, 0.9, half, full)).toBe('closed');
  });
  test('a flick up goes one stop up', () => {
    expect(sheetSnap(300, -0.9, half, full)).toBe('half');
    expect(sheetSnap(430, -1.5, half, full)).toBe('full');
  });
});

describe('pointWord', () => {
  test('Tap under a finger, Click with a mouse', () => {
    expect(pointWord(true)).toBe('Tap');
    expect(pointWord(false)).toBe('Click');
  });
  test('without matchMedia (no DOM) it says Click', () => {
    expect(pointWord()).toBe('Click');
  });
});
