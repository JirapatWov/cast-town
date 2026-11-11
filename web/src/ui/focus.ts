// Keeping keyboard focus somewhere sensible. Panels re-render with setChildren, dialogs and docks close, views
// switch — and each time the focused element leaves the page, the browser drops focus to <body>: a screen reader
// loses its place, the next Tab starts over at the top, and typed letters reach the single-key shortcuts.
//
// - markFocus / restoreFocus: remember where focus was (an opener) and go back there, or to its re-rendered copy.
// - installFocusGuard: when the focused element is removed or hidden by a re-render, focus its copy (same
//   data-focus-key, id, or role + name) in the same region; else the region itself; else the app's landmark.
// - focusOutOf: leave a text box onto the region around it (Esc), instead of blurring to <body>.

/** Regions focus may fall back to (and the limit of where a re-rendered copy is looked for). */
const REGION =
  '[role="dialog"], [role="menu"], [role="listbox"], [role="tabpanel"], [role="radiogroup"], [role="region"], aside, main, nav, header, section, article, form';

export interface FocusMark {
  el: HTMLElement;
  key: string;
  /** The regions around it, nearest first, each with the element's position among the same-key elements in it (the
   *  n-th "Low" radio, the n-th "Copy"). A re-render often replaces the nearest region too (a whole card): the copy
   *  is then looked for in the next one out that is still there. */
  regions: { el: HTMLElement; index: number }[];
}

/** How many regions out a copy is looked for (a card, its list, the pane, the panel). */
const REGION_DEPTH = 4;

export interface KeyParts {
  tag: string;
  focusKey?: string | null;
  id?: string | null;
  role?: string | null;
  name?: string | null;
  label?: string | null;
  text?: string | null;
}

/** What makes two elements "the same control" across a re-render: an explicit data-focus-key, else the id, else the
 *  tag, role, form name and accessible name (aria-label, else the text). */
export function keyFrom(p: KeyParts): string {
  if (p.focusKey) return `k:${p.focusKey}`;
  if (p.id) return `#${p.id}`;
  const name = (p.label ?? p.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return `${p.tag.toLowerCase()}|${p.role ?? ''}|${p.name ?? ''}|${name}`;
}

export function focusKey(el: HTMLElement): string {
  return keyFrom({
    tag: el.tagName,
    focusKey: el.dataset.focusKey,
    id: el.id,
    role: el.getAttribute('role'),
    name: el.getAttribute('name'),
    label: el.getAttribute('aria-label'),
    text: el.textContent,
  });
}

function hiddenByAttr(el: Element): boolean {
  return !!el.closest('[hidden], [inert], [aria-hidden="true"]');
}

/** Connected, shown, enabled: focus would land and stay there. */
export function focusable(el: HTMLElement): boolean {
  if (!el.isConnected || hiddenByAttr(el)) return false;
  if ((el as HTMLButtonElement).disabled) return false;
  return el.getClientRects().length > 0;
}

function sameKey(scope: ParentNode, key: string, tag: string): HTMLElement[] {
  return [...scope.querySelectorAll<HTMLElement>(tag)].filter((n) => focusKey(n) === key);
}

const atBody = () => {
  const a = document.activeElement;
  return !a || a === document.body || a === document.documentElement;
};

/** The last element focused inside the guarded root (kept by installFocusGuard). */
let recent: FocusMark | null = null;

export function markFocus(el: Element | null = document.activeElement): FocusMark | null {
  if (!(el instanceof HTMLElement) || el === document.body || el === document.documentElement) return null;
  const key = focusKey(el);
  const unique = key.startsWith('k:') || key.startsWith('#');
  const regions: FocusMark['regions'] = [];
  for (let r = el.parentElement?.closest<HTMLElement>(REGION); r && regions.length < REGION_DEPTH; r = r.parentElement?.closest<HTMLElement>(REGION)) {
    regions.push({ el: r, index: unique ? 0 : Math.max(0, sameKey(r, key, el.tagName).indexOf(el)) });
  }
  return { el, key, regions };
}

const live = (el: HTMLElement) => el.isConnected && !hiddenByAttr(el);

/** Focus the mark's element, or its re-rendered copy in the nearest of its regions still on the page (only there:
 *  further out, another "Close" or "Enter" would be a different control). False when neither is there. */
function focusCopy(mark: FocusMark): boolean {
  if (focusable(mark.el)) {
    mark.el.focus({ preventScroll: true });
    return true;
  }
  const region = mark.regions.find((r) => live(r.el));
  if (!region) return false;
  const copies = sameKey(region.el, mark.key, mark.el.tagName).filter(focusable);
  const copy = copies[region.index] ?? copies[copies.length - 1];
  if (!copy) return false;
  copy.focus({ preventScroll: true });
  return true;
}

/** Focus a region (made focusable by script only, so Tab never stops on it). */
export function focusRegion(el: HTMLElement): void {
  if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
  el.focus({ preventScroll: true });
}

/** The nearest region of the mark that is still on screen (it may be the mark's own region, emptied). */
function focusNearestRegion(mark: FocusMark): boolean {
  const region = mark.regions.find((r) => live(r.el) && r.el.getClientRects().length > 0);
  if (!region) return false;
  focusRegion(region.el);
  return true;
}

let fallback: () => void = () => {};

/** Where focus goes when nothing closer is left (the UI sets this to its main landmark's heading). */
export function setFocusFallback(fn: () => void): void {
  fallback = fn;
}

/** Focus the app's landmark (the main heading): after something outside the UI that had focus went away. */
export function focusLandmark(): void {
  fallback();
}

/** Where focus is — or, while it has fallen to <body> because the focused control is being re-rendered (pressing
 *  "Enter" on the board re-renders the board), where it just was. For remembering an opener. */
export function markCurrentFocus(): FocusMark | null {
  return markFocus() ?? (atBody() ? recent : null);
}

/** Back to a remembered element (an opener), its re-rendered copy, its region, or the app's landmark. */
export function restoreFocus(mark: FocusMark | null): void {
  if (mark && (focusCopy(mark) || focusNearestRegion(mark))) return;
  fallback();
}

/** Leave a text box (Esc) onto the region around it, so focus stays in place for the next Tab or Esc. */
export function focusOutOf(el: HTMLElement): void {
  const region = el.parentElement?.closest<HTMLElement>('[role="tabpanel"], [role="dialog"], [role="region"], aside, main, section, form');
  if (region && focusable(region)) focusRegion(region);
  else {
    el.blur();
    fallback();
  }
}


/** Watch `root`: when the focused element in it is removed or hidden (a re-render, a closed panel), focus moves to
 *  its copy, its region or the fallback instead of <body>. Returns a cleanup function. */
export function installFocusGuard(root: HTMLElement): () => void {
  let last: FocusMark | null = null;
  let queued = 0;

  const onFocusIn = (ev: FocusEvent) => {
    const t = ev.target;
    last = t instanceof HTMLElement && root.contains(t) ? markFocus(t) : null;
    if (last) recent = last;
  };

  const check = () => {
    queued = 0;
    if (!last || !atBody()) return;
    const mark = last;
    last = null;
    // Still there and shown: focus was dropped on purpose (a click on empty space, a blur) — leave it.
    if (focusable(mark.el)) return;
    restoreFocus(mark);
  };

  const mo = new MutationObserver((records) => {
    if (!last) return;
    if (atBody()) return check();
    // Hiding (the hidden attribute) moves focus to <body> only at the next style update: look again then.
    if (!queued && records.some((r) => r.type === 'attributes')) queued = requestAnimationFrame(check);
  });
  mo.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });

  // Hidden by a class (display: none) or removed in a way the observer can't see: the browser blurs without a
  // new target.
  const onFocusOut = (ev: FocusEvent) => {
    if (!ev.relatedTarget && !queued) queued = requestAnimationFrame(check);
  };

  document.addEventListener('focusin', onFocusIn);
  document.addEventListener('focusout', onFocusOut);
  return () => {
    mo.disconnect();
    document.removeEventListener('focusin', onFocusIn);
    document.removeEventListener('focusout', onFocusOut);
  };
}
