// Stack of dismissible layers (menus, dialogs, overlays) so Esc always closes the top-most one; modal ones also close
// with the browser's Back (finding #50, see nav-history.ts).

export interface Layer {
  id: string;
  close(): void;
  /** Layers with modal=true block global single-key shortcuts while open. */
  modal?: boolean;
}

export interface LayerStack {
  push(layer: Layer): () => void;
  top(): Layer | undefined;
  closeTop(): boolean;
  has(id: string): boolean;
  readonly hasModal: boolean;
}

export interface LayerStackOptions {
  /** A modal layer opened: register it with the browser's Back (nav-history's overlay) — `close` closes it — and
   *  return the function to call when it closes some other way. */
  onModal?: (close: () => void) => () => void;
}

export function createLayerStack(opts: LayerStackOptions = {}): LayerStack {
  const stack: Layer[] = [];
  /** Modal layers' Back registrations; the holder points at the layer Back closes (a re-opened one takes over). */
  const back = new Map<Layer, { release: () => void; holder: { layer: Layer } }>();
  const remove = (layer: Layer) => {
    const i = stack.indexOf(layer);
    if (i >= 0) stack.splice(i, 1);
    const reg = back.get(layer);
    if (reg) {
      back.delete(layer);
      reg.release();
    }
  };
  return {
    push(layer) {
      // Re-opening a layer with the same id replaces it (and keeps its place in the browser's Back).
      const existing = stack.findIndex((l) => l.id === layer.id);
      let reg: { release: () => void; holder: { layer: Layer } } | undefined;
      if (existing >= 0) {
        const old = stack[existing];
        stack.splice(existing, 1);
        reg = back.get(old);
        back.delete(old);
        if (reg && !layer.modal) {
          reg.release();
          reg = undefined;
        }
      }
      stack.push(layer);
      if (reg) reg.holder.layer = layer;
      else if (layer.modal && opts.onModal) {
        const holder = { layer };
        reg = {
          holder,
          release: opts.onModal(() => {
            const l = holder.layer;
            back.delete(l); // Back already took its step
            const i = stack.indexOf(l);
            if (i >= 0) stack.splice(i, 1);
            l.close();
          }),
        };
      }
      if (reg) back.set(layer, reg);
      return () => remove(layer);
    },
    top: () => stack[stack.length - 1],
    closeTop() {
      const top = stack[stack.length - 1];
      if (!top) return false;
      remove(top);
      top.close();
      return true;
    },
    has: (id) => stack.some((l) => l.id === id),
    get hasModal() {
      return stack.some((l) => l.modal);
    },
  };
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** What Tab can land on: links, form controls, <summary> ("Or set it up by hand" in Models & providers), anything with
 *  a tabindex. Roving options (tabindex -1), disabled, hidden and inert ones are filtered out by tabbable(). */
const TABBABLE = 'a[href], area[href], button, input:not([type="hidden"]), select, textarea, summary, iframe, [tabindex], [contenteditable]:not([contenteditable="false"])';

interface TabCandidate {
  tabIndex: number;
  closest(selector: string): unknown;
  getClientRects(): { length: number };
  checkVisibility?(opts?: { visibilityProperty?: boolean; checkVisibilityCSS?: boolean }): boolean;
}

/** Tab stops only: tabindex ≥ 0, enabled, not under [hidden]/[inert], not in the body of a closed <details> (Chrome
 *  still gives those a box — the copy buttons under "Or set it up by hand" — but Tab skips them), visible. */
export function tabbable(el: TabCandidate): boolean {
  if (el.tabIndex < 0 || (el as { disabled?: boolean }).disabled) return false;
  if (el.closest('[hidden], [inert], details:not([open]) > :not(summary)')) return false;
  if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true })) return false;
  return el.getClientRects().length > 0;
}

/** Where Tab goes from `active` in a trapped dialog: past the last stop (or from outside it) → the first, Shift+Tab
 *  before the first → the last; null leaves it to the browser (a move inside the dialog). */
export function trapTarget<T>(stops: T[], active: T | null, inside: boolean, shift: boolean): T | null {
  if (!stops.length) return null;
  const first = stops[0];
  const last = stops[stops.length - 1];
  if (!inside) return shift ? last : first;
  if (shift && active === first) return last;
  if (!shift && active === last) return first;
  return null;
}

/** Keep Tab focus inside el. Returns a cleanup function. */
export function trapFocus(el: HTMLElement): () => void {
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key !== 'Tab') return;
    const stops = [...el.querySelectorAll<HTMLElement>(TABBABLE)].filter(tabbable);
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // focus on a region inside focused by script (tabindex -1, not a stop) is inside too: the browser moves on from it
    const target = trapTarget(stops, active && stops.includes(active) ? active : null, !!active && el.contains(active), ev.shiftKey);
    if (!target) return;
    ev.preventDefault();
    target.focus();
  };
  el.addEventListener('keydown', onKey);
  return () => el.removeEventListener('keydown', onKey);
}

export function focusFirst(el: HTMLElement) {
  const target =
    el.querySelector<HTMLElement>('[autofocus]') ??
    el.querySelector<HTMLElement>('input:not([type=hidden]), textarea') ??
    el.querySelector<HTMLElement>(FOCUSABLE);
  target?.focus({ preventScroll: true });
}
