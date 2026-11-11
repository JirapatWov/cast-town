// Anchored floating surface: positioning, outside-click + Esc dismissal via the layer stack.
import type { LayerStack } from './layers';

export interface PopoverOptions {
  id: string;
  placement?: 'below' | 'above';
  align?: 'start' | 'end' | 'center';
  onClose?: () => void;
}

export function openPopover(root: HTMLElement, layers: LayerStack, anchor: HTMLElement, el: HTMLElement, opts: PopoverOptions): () => void {
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    removeLayer();
    document.removeEventListener('pointerdown', onOutside, true);
    window.removeEventListener('resize', close);
    anchor.setAttribute('aria-expanded', 'false');
    // Focus inside the popover would fall to <body> (Tab then lands on the 3D canvas): hand it back to the anchor.
    // An outside click still moves focus to whatever was clicked right after this.
    const hadFocus = el.contains(document.activeElement);
    el.remove();
    if (hadFocus && anchor.isConnected) anchor.focus({ preventScroll: true });
    opts.onClose?.();
  };
  const onOutside = (ev: PointerEvent) => {
    const t = ev.target as Node;
    if (!el.contains(t) && !anchor.contains(t)) close();
  };

  el.classList.add('popover');
  root.appendChild(el);
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth;
  const hgt = el.offsetHeight;
  let left = opts.align === 'end' ? r.right - w : opts.align === 'center' ? r.left + r.width / 2 - w / 2 : r.left;
  left = Math.max(8, Math.min(window.innerWidth - w - 8, left));
  const above = opts.placement === 'above' || (opts.placement !== 'below' && r.bottom + hgt + 8 > window.innerHeight);
  el.style.left = `${left}px`;
  el.style.top = `${Math.max(8, above ? r.top - hgt - 8 : r.bottom + 8)}px`;
  el.classList.add(above ? 'from-below' : 'from-above');

  anchor.setAttribute('aria-expanded', 'true');
  document.addEventListener('pointerdown', onOutside, true);
  window.addEventListener('resize', close);
  const removeLayer = layers.push({ id: opts.id, close });
  return close;
}

/** Pick the side of the anchor with room for a tall list and the height that fits there: below when at least
 *  `min` px are free (or more than above), else above. Set the returned maxHeight on a popover that scrolls. */
export function fitPlacement(anchor: HTMLElement, min = 220, cap = 560): { placement: 'below' | 'above'; maxHeight: number } {
  const r = anchor.getBoundingClientRect();
  const below = window.innerHeight - r.bottom - 16;
  const above = r.top - 16;
  const placement = below >= min || below >= above ? 'below' : 'above';
  return { placement, maxHeight: Math.max(120, Math.min(cap, placement === 'below' ? below : above)) };
}
