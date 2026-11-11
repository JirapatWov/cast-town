// "2m ago" that keeps itself up to date. Cards that show a relative time (approval cards in the floating stack, the
// inbox, chats) are rebuilt only when their data changes, so a waiting request kept saying "50s ago" for minutes.
// Re-rendering them on a timer would throw away focus inside the card; this updates just the text, in place.
import { h } from './dom';
import { timeAgo } from './format';

const TICK_MS = 10_000;
let timer: ReturnType<typeof setInterval> | null = null;

function tick(): void {
  const spans = document.querySelectorAll<HTMLElement>('[data-ago]');
  if (!spans.length) {
    if (timer) clearInterval(timer);
    timer = null;
    return;
  }
  const now = Date.now();
  for (const el of spans) {
    const text = timeAgo(Number(el.dataset.ago), now);
    if (el.textContent !== text) el.textContent = text;
  }
}

/** A span with timeAgo(ts) that every element of its kind on the page refreshes together (one timer for all). */
export function liveAgo(ts: number, className = 'muted'): HTMLElement {
  timer ??= setInterval(tick, TICK_MS);
  return h('span', { class: className, 'data-ago': String(ts), title: new Date(ts).toLocaleString() }, timeAgo(ts));
}
