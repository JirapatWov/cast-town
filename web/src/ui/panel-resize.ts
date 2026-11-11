// Desktop: drag the side panel's left edge to make it wider or narrower (long chat lines, code, diffs). The width is a
// per-device convenience (deviceStorage, like the fold) set as --panel-user-w on .rlt-ui; base.css clamps it the same
// way as here, so the town always keeps part of the window, and the phone layouts (sheet, sideways dock) never read it.
// Everything placed beside the panel follows through --panel-w; the scene's framing follows the panel's size.
import { deviceStorage, h } from './dom';

export const PANEL_WIDTH_KEY = 'rlt.panel.width';
/** The narrowest the panel gets (a chat line and the composer's buttons still fit). Keep in step with base.css. */
export const PANEL_MIN_W = 320;
/** The widest the panel gets, as a share of the window (the town keeps the rest). Keep in step with base.css. */
export const PANEL_MAX_SHARE = 0.65;
const STEP = 16;
const BIG_STEP = 64;

/** The widest the panel may be in a window this wide. */
export const panelMaxWidth = (viewport: number): number => Math.max(PANEL_MIN_W, Math.floor(viewport * PANEL_MAX_SHARE));

/** A width the panel can take in a window this wide, in whole pixels. */
export const clampPanelWidth = (px: number, viewport: number): number =>
  Math.round(Math.min(panelMaxWidth(viewport), Math.max(PANEL_MIN_W, px)));

/** The width saved on this device, or null for none (or anything that isn't a width). */
export function savedPanelWidth(raw: string | null): number | null {
  if (!raw || !/^\d{2,5}$/.test(raw.trim())) return null;
  const n = Number(raw);
  return n >= PANEL_MIN_W ? n : null;
}

/** The width a key on the grip asks for: the panel sits at the right, so ← widens it and → narrows it (Shift: bigger
 *  steps); Home = narrowest, End = widest. 'reset' = Enter (the usual width). null = not a resize key. */
export function keyWidth(key: string, shift: boolean, now: number, viewport: number): number | 'reset' | null {
  const step = shift ? BIG_STEP : STEP;
  switch (key) {
    case 'ArrowLeft':
      return clampPanelWidth(now + step, viewport);
    case 'ArrowRight':
      return clampPanelWidth(now - step, viewport);
    case 'Home':
      return PANEL_MIN_W;
    case 'End':
      return panelMaxWidth(viewport);
    case 'Enter':
      return 'reset';
    default:
      return null;
  }
}

/** The width a drag asks for: the grip started at startX on a panel startW wide and is now at x. */
export const dragWidth = (startW: number, startX: number, x: number, viewport: number): number => clampPanelWidth(startW + (startX - x), viewport);

/** The grip on the panel's left edge (a vertical separator: drag, arrow keys, double-click or Enter for the usual
 *  width). `root` carries the width; `panel` is measured. */
export function createPanelResizer(root: HTMLElement, panel: HTMLElement): HTMLElement {
  let width = savedPanelWidth(deviceStorage.get(PANEL_WIDTH_KEY));
  const grip = h('div', {
    class: 'panel-resize',
    role: 'separator',
    'aria-orientation': 'vertical',
    'aria-label': 'Panel width',
    tabindex: '0',
    title: 'Drag to change the width · double-click for the usual width',
  });

  const sync = () => {
    const now = Math.round(panel.getBoundingClientRect().width);
    if (!now) return; // closed (hidden): nothing to say yet
    grip.setAttribute('aria-valuemin', String(PANEL_MIN_W));
    grip.setAttribute('aria-valuemax', String(panelMaxWidth(innerWidth)));
    grip.setAttribute('aria-valuenow', String(now));
    grip.setAttribute('aria-valuetext', `${now} pixels${width === null ? ' (the usual width)' : ''}`);
  };
  const apply = () => {
    if (width === null) root.style.removeProperty('--panel-user-w');
    else root.style.setProperty('--panel-user-w', `${width}px`);
  };
  const save = () => {
    if (width === null) deviceStorage.remove(PANEL_WIDTH_KEY);
    else deviceStorage.set(PANEL_WIDTH_KEY, String(width));
  };
  const reset = () => {
    width = null;
    apply();
    save();
    sync();
  };
  apply();

  // ── drag (mouse, pen or touch on a touchscreen laptop); Esc while dragging puts the width back ──
  let drag: { id: number; startX: number; startW: number; before: number | null; frame: number; x: number } | null = null;
  const end = (keep: boolean) => {
    if (!drag) return;
    cancelAnimationFrame(drag.frame);
    if (grip.hasPointerCapture(drag.id)) grip.releasePointerCapture(drag.id);
    if (keep) {
      width = dragWidth(drag.startW, drag.startX, drag.x, innerWidth);
      save();
    } else width = drag.before;
    drag = null;
    apply();
    root.classList.remove('is-panel-resizing');
    removeEventListener('keydown', onEscape, true);
    sync();
  };
  const onEscape = (ev: KeyboardEvent) => {
    if (ev.key !== 'Escape' || !drag) return;
    ev.preventDefault();
    ev.stopPropagation(); // not also "close the panel"
    end(false);
  };
  grip.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0 || drag) return;
    ev.preventDefault(); // no text selection; focus stays where it was (a mouse drag leaves no focus ring behind)
    grip.setPointerCapture(ev.pointerId);
    drag = { id: ev.pointerId, startX: ev.clientX, startW: panel.getBoundingClientRect().width, before: width, frame: 0, x: ev.clientX };
    root.classList.add('is-panel-resizing');
    addEventListener('keydown', onEscape, true);
  });
  grip.addEventListener('pointermove', (ev) => {
    if (!drag || ev.pointerId !== drag.id) return;
    drag.x = ev.clientX;
    if (drag.frame) return;
    drag.frame = requestAnimationFrame(() => {
      if (!drag) return;
      drag.frame = 0;
      width = dragWidth(drag.startW, drag.startX, drag.x, innerWidth);
      apply();
    });
  });
  grip.addEventListener('pointerup', (ev) => {
    if (drag && ev.pointerId === drag.id) end(true);
  });
  grip.addEventListener('pointercancel', () => end(false));
  grip.addEventListener('lostpointercapture', () => end(true)); // the capture went away mid-drag: keep what was shown
  grip.addEventListener('dblclick', (ev) => {
    ev.preventDefault();
    reset();
  });

  // ── keys ──
  grip.addEventListener('keydown', (ev) => {
    const want = keyWidth(ev.key, ev.shiftKey, panel.getBoundingClientRect().width, innerWidth);
    if (want === null || ev.altKey || ev.ctrlKey || ev.metaKey) return;
    ev.preventDefault();
    if (want === 'reset') return reset();
    width = want;
    apply();
    save();
    sync();
  });
  grip.addEventListener('focus', sync);
  grip.addEventListener('pointerenter', sync);
  return grip;
}
