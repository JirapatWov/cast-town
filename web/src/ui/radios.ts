// Option groups — role=radiogroup (Effort, Kind of work, styles, rooms…) and role=tablist (people, terminals) — get
// one Tab stop and arrow keys, as the ARIA radio and tab patterns ask. Without it every option was its own Tab stop
// and the arrows did nothing.
//
// One delegated listener serves every group, including ones rendered later: groups re-render with setChildren, so
// per-element wiring would be lost on each render. Moving with an arrow also picks the option (clicks it), like
// native radios; when that click re-renders the group, the focus guard (focus.ts) puts focus on the new copy.

const GROUP = '[role="radiogroup"], [role="tablist"]';
const ITEM = '[role="radio"], [role="tab"]';

/** The option an arrow key moves to: next/previous with wrap-around, Home/End first/last. null: not a move key. */
export function nextIndex(current: number, count: number, key: string): number | null {
  if (count <= 0) return null;
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return current < 0 ? 0 : (current + 1) % count;
    case 'ArrowLeft':
    case 'ArrowUp':
      return current < 0 ? count - 1 : (current - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

function itemsOf(group: Element): HTMLElement[] {
  return [...group.querySelectorAll<HTMLElement>(ITEM)].filter(
    (el) => el.closest(GROUP) === group && !(el as HTMLButtonElement).disabled && el.getAttribute('aria-disabled') !== 'true' && !el.closest('[hidden]'),
  );
}

const isOn = (el: Element) => el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-selected') === 'true';

/** The option Tab lands on: the picked one, else the first. */
function current(items: HTMLElement[]): HTMLElement | undefined {
  return items.find(isOn) ?? items[0];
}

/** One Tab stop per group: the picked option (or the first) gets tabindex 0, the others -1. Call after a render. */
export function syncGroup(group: Element): void {
  const items = itemsOf(group);
  const stop = current(items);
  for (const el of items) el.tabIndex = el === stop ? 0 : -1;
}

let installed = false;

export function installOptionGroups(): void {
  if (installed) return;
  installed = true;
  let pointerAt = 0;
  document.addEventListener('pointerdown', () => (pointerAt = performance.now()), true);

  document.addEventListener('keydown', (ev) => {
    if (ev.defaultPrevented || ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey) return;
    const item = ev.target instanceof HTMLElement ? ev.target.closest<HTMLElement>(ITEM) : null;
    const group = item?.closest(GROUP);
    if (!item || !group) return;
    const items = itemsOf(group);
    const i = nextIndex(items.indexOf(item), items.length, ev.key);
    if (i === null) return;
    ev.preventDefault();
    const next = items[i];
    if (!next || next === item) return;
    for (const el of items) el.tabIndex = el === next ? 0 : -1;
    next.focus();
    next.click();
  });

  // Groups rendered without syncGroup: put them right the first time focus comes in. Coming in by keyboard lands on
  // the picked option, as Tab would with a synced group (a click keeps the option clicked).
  document.addEventListener('focusin', (ev) => {
    const item = ev.target instanceof HTMLElement ? ev.target.closest<HTMLElement>(ITEM) : null;
    const group = item?.closest(GROUP);
    if (!item || !group) return;
    const from = ev.relatedTarget instanceof Node ? ev.relatedTarget : null;
    const entering = !from || !group.contains(from);
    syncGroup(group);
    if (!entering || performance.now() - pointerAt < 600) return;
    const stop = current(itemsOf(group));
    if (stop && stop !== item) stop.focus();
  });
}
