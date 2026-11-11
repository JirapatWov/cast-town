// The house and the city share one canvas. three's OrbitControls.disconnect() resets the element's touch-action to
// '' (auto), and the house camera disconnects whenever the city is on screen, so phones lost one-finger panning
// (pointercancel after the first move) and pinch zoom (the whole page zoomed instead). The house camera must leave
// touch-action at 'none'. A tiny fake element stands in for the canvas (no DOM in bun test).
import { describe, expect, test } from 'bun:test';
import { HouseCamera, keepTouchAction } from '../../web/src/house/camera';

function fakeCanvas() {
  const listeners = new Map<string, Set<unknown>>();
  const el = {
    style: { touchAction: '' } as { touchAction: string },
    clientWidth: 390,
    clientHeight: 664,
    addEventListener(type: string, fn: unknown) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener(type: string, fn: unknown) {
      listeners.get(type)?.delete(fn);
    },
    getRootNode() {
      return el;
    },
    setPointerCapture() {},
    releasePointerCapture() {},
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 390, height: 664, right: 390, bottom: 664 };
    },
    ownerDocument: null as unknown,
    listeners,
  };
  el.ownerDocument = { addEventListener() {}, removeEventListener() {}, pointerLockElement: null };
  return el;
}

describe('house camera keeps touch-action none', () => {
  test('keepTouchAction sets none and ignores a missing element', () => {
    const el = fakeCanvas();
    keepTouchAction(el as unknown as HTMLElement);
    expect(el.style.touchAction).toBe('none');
    expect(() => keepTouchAction(null)).not.toThrow();
  });

  test('after construction (controls disconnected) and after connect / disconnect', () => {
    const el = fakeCanvas();
    const cam = new HouseCamera(el as unknown as HTMLElement);
    expect(el.style.touchAction).toBe('none');
    cam.connect(el as unknown as HTMLElement);
    expect(el.style.touchAction).toBe('none');
    cam.disconnect();
    expect(el.style.touchAction).toBe('none');
  });
});
