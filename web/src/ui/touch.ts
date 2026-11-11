// Phones and tablets: what a finger can't do (hover, Shift+Enter, a pinch the page must not take), which layout the
// side panel uses, and where the on-screen keyboard is. The pure helpers at the top are unit-tested
// (tests/mobile/touch.test.ts); the install* functions wire them to the page once. No imports: the tests load this
// file without a DOM.

/** A touch screen without hover: a phone, or a tablet without a trackpad. Matches the CSS `(hover: none)` rules. */
export const TOUCH_QUERY = '(hover: none) and (pointer: coarse)';
/** The side panel is a bottom sheet (responsive.css / mobile.css use the same width). */
export const NARROW_QUERY = '(max-width: 820px)';
/** A phone held sideways: too short for a bottom sheet, so the panel docks at the right (mobile.css, same query). */
export const LANDSCAPE_PHONE_QUERY = '(max-width: 820px) and (max-height: 520px) and (orientation: landscape)';
/** The Town board on a phone (upright or sideways) or a narrow window: the chat is a full-screen page with a compact
 *  header, not a sheet over the board (mobile.css "Board on a phone" uses the same query under `.rlt-ui.is-focus`). */
export const PHONE_BOARD_QUERY = '(max-width: 820px), (pointer: coarse) and (max-height: 520px)';

function matches(query: string): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia(query).matches;
  } catch {
    return false;
  }
}

export const isTouchUI = (): boolean => matches(TOUCH_QUERY);
/** The bottom-sheet layout (portrait phones, narrow windows): the sheet can be dragged and expanded. */
export const isSheetLayout = (): boolean => matches(NARROW_QUERY) && !matches(LANDSCAPE_PHONE_QUERY);
/** Any phone-sized layout (the sheet, or the docked panel of a phone held sideways). */
export const isNarrow = (): boolean => matches(NARROW_QUERY);
/** A phone (upright or sideways) or a narrow window: the board's phone layout, and where CAST starts on the board. */
export const isPhoneSized = (): boolean => matches(PHONE_BOARD_QUERY);
/** The board's phone layout: `focusMode` is the shell's (Board on). */
export const isPhoneBoard = (focusMode: boolean): boolean => focusMode && isPhoneSized();

/** "Tap" where a finger does it, "Click" elsewhere (first-run cards, empty states, room plates). */
export function pointWord(touch = isTouchUI()): 'Tap' | 'Click' {
  return touch ? 'Tap' : 'Click';
}

/** deviceStorage key: '1' → Return sends the chat message, '0' → Return adds a line; absent → by device (below). */
export const ENTER_SENDS_KEY = 'rlt.enter.sends';

/** Whether Return (without Shift / Ctrl / Cmd) sends the message. A hardware keyboard sends with Return and adds a line
 *  with Shift+Return; an on-screen keyboard has no Shift+Return, so there Return adds a line and the Send button sends
 *  (a half-written instruction must never start a paid run). The user's choice (the More menu) wins either way. */
export function enterSends(opts: { touch: boolean; pref: string | null | undefined }): boolean {
  if (opts.pref === '1') return true;
  if (opts.pref === '0') return false;
  return !opts.touch;
}

/** How much of the layout viewport the on-screen keyboard covers at the bottom (px, ≥ 0): the layout viewport's
 *  height minus where the visual viewport ends. While the page is pinch-zoomed the visual viewport is small for
 *  another reason, so that counts as no keyboard (the sheet must not jump while someone zooms into text). */
export function keyboardInset(layoutH: number, vv: { height: number; offsetTop: number; scale?: number } | null | undefined): number {
  if (!vv || !(layoutH > 0)) return 0;
  if ((vv.scale ?? 1) > 1.05) return 0;
  return Math.max(0, Math.round(layoutH - vv.height - vv.offsetTop));
}

/** Above this many px of inset the on-screen keyboard is taken to be up (browser bars that slide away are smaller). */
export const KEYBOARD_MIN_PX = 120;

export type SheetSnap = 'closed' | 'half' | 'full';

/** Where a dragged bottom sheet settles. `h`: its height when the finger lifts; `v`: the finger's speed in px/ms,
 *  positive downward; `half` / `full`: the two open heights; `from`: where the drag started, when known. A flick goes
 *  one stop in its direction — from the stop it started at, so a long flick down from full on a short phone (where
 *  full and half are only ~150 px apart) still stops at half; a slow drag settles on the nearest stop (closed counts
 *  from below half of the half height). */
export function sheetSnap(h: number, v: number, half: number, full: number, from?: 'half' | 'full'): SheetSnap {
  const FLICK = 0.5;
  if (v > FLICK) return (from === 'full' ? h > half * 0.5 : h > half + 8) ? 'half' : 'closed';
  if (v < -FLICK) return h < half - 8 ? 'half' : 'full';
  if (h < half * 0.5) return 'closed';
  return Math.abs(h - half) <= Math.abs(h - full) ? 'half' : 'full';
}

/** A pointer event as the sheet drag reads it. */
export interface SheetPointer {
  type: string;
  pointerId: number;
  clientY: number;
  timeStamp: number;
  button: number;
  target: unknown;
}

/** The parts of the panel element the sheet drag touches (structural, so the tests can hand in a stand-in). */
export interface SheetDragEl {
  offsetHeight: number;
  style: { height: string };
  classList: { add(c: string): void; remove(c: string): void; contains(c: string): boolean };
  addEventListener(type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel', fn: (ev: SheetPointer) => void): void;
  setPointerCapture(id: number): void;
  hasPointerCapture(id: number): boolean;
  releasePointerCapture(id: number): void;
}

export interface SheetDragOptions {
  /** Whether a press on `target` may start a drag now (the sheet is open, in the sheet layout, on its handle or header). */
  canStart(target: unknown): boolean;
  /** The root's height (px): full = all but 64 px, half = 62 % (responsive.css). */
  rootH(): number;
  /** The finger really moved (past a few px): the drag begins. */
  onStart?(): void;
  /** Where the sheet settles when the finger lifts. */
  settle(snap: SheetSnap): void;
}

/** Drag the bottom sheet by its handle or header: it follows the finger and settles on closed, half or full (a flick
 *  goes one stop further). The pointer is captured only once it moves: a capture on press would send a mouse's click
 *  to the panel instead of the handle, so tapping the handle with a mouse or trackpad would do nothing.
 *  `consumeClick()` is true for the click that ends a drag (it is not a tap on the handle). */
export function installSheetDrag(el: SheetDragEl, o: SheetDragOptions): { consumeClick(): boolean } {
  let drag: { id: number; y0: number; h0: number; lastY: number; lastT: number; v: number; moved: boolean } | null = null;
  let swallow = false;
  let swallowTimer: ReturnType<typeof setTimeout> | undefined;
  el.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0 || !o.canStart(ev.target)) return;
    drag = { id: ev.pointerId, y0: ev.clientY, h0: el.offsetHeight, lastY: ev.clientY, lastT: ev.timeStamp, v: 0, moved: false };
  });
  el.addEventListener('pointermove', (ev) => {
    if (!drag || ev.pointerId !== drag.id) return;
    const dy = ev.clientY - drag.y0;
    if (!drag.moved && Math.abs(dy) < 6) return;
    if (!drag.moved) {
      drag.moved = true;
      try {
        el.setPointerCapture(ev.pointerId);
      } catch {
        /* the pointer is already gone */
      }
      el.classList.add('is-dragging');
      o.onStart?.();
    }
    const dt = Math.max(1, ev.timeStamp - drag.lastT);
    drag.v = 0.7 * ((ev.clientY - drag.lastY) / dt) + 0.3 * drag.v;
    drag.lastY = ev.clientY;
    drag.lastT = ev.timeStamp;
    const full = o.rootH() - 64;
    el.style.height = `${Math.round(Math.max(60, Math.min(full, drag.h0 - dy)))}px`;
  });
  const end = (ev: SheetPointer) => {
    if (!drag || ev.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    if (el.hasPointerCapture(ev.pointerId)) el.releasePointerCapture(ev.pointerId);
    if (!d.moved) return; // a tap: the handle's own click toggles
    swallow = true;
    clearTimeout(swallowTimer);
    swallowTimer = setTimeout(() => (swallow = false), 400);
    const rootH = o.rootH();
    const snap: SheetSnap =
      ev.type === 'pointercancel'
        ? el.classList.contains('is-expanded') ? 'full' : 'half'
        : sheetSnap(el.offsetHeight, d.v, rootH * 0.62, rootH - 64, el.classList.contains('is-expanded') ? 'full' : 'half');
    el.style.height = '';
    el.classList.remove('is-dragging');
    o.settle(snap);
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  return {
    consumeClick() {
      const was = swallow;
      swallow = false;
      return was;
    },
  };
}

/** Keeps --vvh (visible height) and --kb (keyboard inset) on `root` and the `is-kb` class while the on-screen keyboard
 *  is up, so the sheet's composer can sit right on the keyboard (mobile.css). iOS Safari and Chrome on Android both
 *  shrink only the visual viewport for the keyboard; fixed elements stay sized to the layout viewport, so without
 *  this the box would be under the keyboard. */
export function installViewport(root: HTMLElement): () => void {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null;
  let raf = 0;
  let last = '';
  const apply = () => {
    raf = 0;
    const layoutH = root.clientHeight || window.innerHeight;
    const kb = keyboardInset(layoutH, vv);
    const visible = vv && kb > 0 ? Math.round(vv.height) : layoutH;
    const key = `${kb}|${visible}`;
    if (key === last) return;
    last = key;
    root.style.setProperty('--kb', `${kb}px`);
    root.style.setProperty('--vvh', `${visible}px`);
    root.classList.toggle('is-kb', kb >= KEYBOARD_MIN_PX);
  };
  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(apply);
  };
  vv?.addEventListener('resize', schedule);
  vv?.addEventListener('scroll', schedule);
  window.addEventListener('resize', schedule);
  apply();
  return () => {
    vv?.removeEventListener('resize', schedule);
    vv?.removeEventListener('scroll', schedule);
    window.removeEventListener('resize', schedule);
    if (raf) cancelAnimationFrame(raf);
  };
}

/** The 3D scene owns every gesture that starts on it. touch-action: none (index.html, engine) covers the standard
 *  path; Safari's own gesture events (pinch on older iOS) would still zoom the whole page, buttons and all. Page zoom
 *  stays available everywhere else (no maximum-scale in the viewport meta), so text can still be enlarged. */
export function guardScenePinch(scene: HTMLElement | null): void {
  if (!scene) return;
  const stop = (ev: Event) => ev.preventDefault();
  for (const type of ['gesturestart', 'gesturechange']) scene.addEventListener(type, stop, { passive: false });
}
