// Telling screen-reader users what changed where they aren't looking: two live regions (polite for news, assertive
// for errors), and a page title that says where you are — tabs and browser history are told apart by it.
import { h } from './dom';

export type Politeness = 'polite' | 'assertive';

export interface Announcer {
  readonly el: HTMLElement;
  say(text: string, level?: Politeness): void;
}

/** Messages stay in the region a while (some readers re-read a region they come back to), then leave. */
const KEEP_MS = 7000;

export function createAnnouncer(): Announcer {
  // Both regions exist, empty, from the start: a live region added together with its text is often not read.
  const polite = h('div', { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'false' });
  const assertive = h('div', { role: 'alert', 'aria-live': 'assertive', 'aria-atomic': 'false' });
  const el = h('div', { class: 'sr-only cast-announcer' }, polite, assertive);
  let last = '';
  let lastAt = 0;
  return {
    el,
    say(text, level = 'polite') {
      const t = text.trim();
      if (!t) return;
      // the same words twice in a row within a second (two renders of one change) are said once
      const now = Date.now();
      if (t === last && now - lastAt < 1000) return;
      last = t;
      lastAt = now;
      // a new node per message: appending is announced even when the text repeats an earlier one
      const node = h('p', null, t);
      (level === 'assertive' ? assertive : polite).append(node);
      setTimeout(() => node.remove(), KEEP_MS);
    },
  };
}

export interface TitleParts {
  /** Approvals and plans waiting for the user. */
  waiting: number;
  /** The open side panel tab ("Inbox"), if any. */
  tab?: string | null;
  /** Where: the house, "Town board", "Driving"… */
  place?: string | null;
  /** The job, when it isn't the house's main one. */
  job?: string | null;
  app: string;
}

/** "(2) Inbox · todo-api · CAST", "Chat · todo-api · Refactor · CAST", "Town board · CAST". */
export function pageTitle(p: TitleParts): string {
  const parts = [p.tab, p.place, p.job, p.app].filter((x): x is string => !!x && !!x.trim());
  return `${p.waiting > 0 ? `(${p.waiting}) ` : ''}${parts.join(' · ')}`;
}

/** The words for arriving somewhere: "Entered todo-api, job Refactor." */
export function placeAnnouncement(view: 'city' | 'house' | 'drive', opts: { house?: string; job?: string | null; board?: boolean } = {}): string {
  if (view === 'house' && opts.house) return `Entered ${opts.house}${opts.job ? `, job ${opts.job}` : ''}.`;
  if (view === 'drive') return 'Driving. W A S D steer, Space brakes, E enters a house, Esc leaves the car.';
  return opts.board ? 'Back on the town board.' : 'Back in the town.';
}
