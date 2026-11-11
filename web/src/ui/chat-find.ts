// Find in this chat (finding #44): a bar over the conversation — type, then Enter / Shift+Enter (or the arrows) to
// step through the matches, Esc to close. Ctrl/⌘+F inside the chat opens it, and so does the chat menu (phones have
// no Ctrl+F). Matches inside folded tool cards (their input and output) and in a reply's thinking open those up,
// so every match can be shown. Matches are painted with the CSS Custom Highlight API (no DOM rewriting of messages
// that are still streaming); where a browser lacks it the match is still scrolled to and counted.
import type { TranscriptItem } from '../../../shared/protocol';
import { h } from './dom';
import { foldedMatches } from './find-text';
import { icon } from './icons';
import type { Shell } from './shell';
import type { ItemView } from './transcript';

interface HighlightRegistry {
  set(name: string, h: unknown): void;
  delete(name: string): void;
}
const registry = (): { reg: HighlightRegistry; Ctor: new (...r: Range[]) => unknown } | null => {
  const reg = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS?.highlights;
  const Ctor = (globalThis as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
  return reg && Ctor ? { reg, Ctor } : null;
};

export interface ChatFind {
  readonly el: HTMLElement;
  readonly isOpen: boolean;
  /** Open (with a query to look for, e.g. from the chat search) and focus the box. */
  open(query?: string): void;
  close(): void;
  /** The conversation changed (another chat, new items): find again, keeping the place when possible. */
  refresh(): void;
}

export function createChatFind(deps: {
  shell: Shell;
  scroller: HTMLElement;
  list: HTMLElement;
  items(): TranscriptItem[];
  view(id: string): ItemView | undefined;
}): ChatFind {
  const { shell, scroller, list } = deps;
  let ranges: Range[] = [];
  let cur = -1;
  let removeLayer: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;

  const input = h('input', { type: 'search', class: 'find-input', placeholder: 'Find in this chat', 'aria-label': 'Find in this chat', enterkeyhint: 'search' }) as HTMLInputElement;
  const count = h('span', { class: 'find-count num', 'aria-live': 'polite' });
  const btn = (ic: 'chevronUp' | 'chevronDown' | 'x', label: string, onclick: () => void) =>
    h('button', { type: 'button', class: 'icon-btn find-btn', title: label, 'aria-label': label, onclick }, icon(ic, 15));
  const prevBtn = btn('chevronUp', 'Previous match (Shift+Enter)', () => step(-1));
  const nextBtn = btn('chevronDown', 'Next match (Enter)', () => step(1));
  const el = h('div', { class: 'chat-find', role: 'search', hidden: true }, icon('search', 14, 'find-ic'), input, count, prevBtn, nextBtn, btn('x', 'Close (Esc)', () => api.close()));

  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => run(true), 140);
  });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
        run(true);
      } else step(ev.shiftKey ? -1 : 1);
    }
  });

  /** Unfold what hides a match (tool cards, thinking), then collect the matches in what the chat shows. */
  function run(fromStart: boolean) {
    timer = undefined;
    const q = input.value.trim().toLowerCase();
    const keep = !fromStart && cur >= 0 ? ranges[cur] : null;
    ranges = [];
    if (q) {
      const folded = foldedMatches(deps.items(), q);
      for (const id of folded.tools) {
        const v = deps.view(id);
        if (v?.el.querySelector('.tool-body')?.hasAttribute('hidden')) v.el.querySelector<HTMLElement>('.tool-head')?.click();
      }
      for (const id of folded.thinking) {
        const d = deps.view(id)?.el.querySelector<HTMLDetailsElement>('details.thinking');
        if (d) d.open = true;
      }
      const walker = document.createTreeWalker(list, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => {
          const p = n.parentElement;
          if (!p || p.closest('[hidden], details:not([open]) > :not(summary), .tool-shots')) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const text = (n.nodeValue ?? '').toLowerCase();
        for (let i = text.indexOf(q); i >= 0; i = text.indexOf(q, i + q.length)) {
          const r = document.createRange();
          r.setStart(n, i);
          r.setEnd(n, Math.min(n.nodeValue!.length, i + q.length));
          ranges.push(r);
        }
      }
    }
    // the same match as before when it is still there (new items arrived), else the first one — shown, since the
    // one on screen is gone (another chat opened from the search) or there was none
    cur = ranges.length ? 0 : -1;
    let kept = false;
    if (keep) {
      const i = ranges.findIndex((r) => r.startContainer === keep.startContainer && r.startOffset === keep.startOffset);
      if (i >= 0) {
        cur = i;
        kept = true;
      }
    }
    paint(fromStart || (!kept && cur >= 0));
  }

  function step(d: number) {
    if (!ranges.length) return;
    cur = (cur + d + ranges.length) % ranges.length;
    paint(true);
  }

  function paint(scroll: boolean) {
    const q = input.value.trim();
    count.textContent = !q ? '' : ranges.length ? `${cur + 1} of ${ranges.length}` : 'No matches';
    el.classList.toggle('is-none', !!q && !ranges.length);
    prevBtn.toggleAttribute('disabled', ranges.length < 2);
    nextBtn.toggleAttribute('disabled', ranges.length < 2);
    const hl = registry();
    if (hl) {
      if (ranges.length) {
        hl.reg.set('cast-find', new hl.Ctor(...ranges));
        hl.reg.set('cast-find-now', new hl.Ctor(ranges[cur]));
      } else {
        hl.reg.delete('cast-find');
        hl.reg.delete('cast-find-now');
      }
    }
    if (scroll && cur >= 0) {
      const r = ranges[cur].getBoundingClientRect();
      const s = scroller.getBoundingClientRect();
      if (r.top < s.top + 24 || r.bottom > s.bottom - 24) scroller.scrollTo({ top: scroller.scrollTop + (r.top - s.top) - s.height / 3 });
    }
  }

  function clearPaint() {
    const hl = registry();
    hl?.reg.delete('cast-find');
    hl?.reg.delete('cast-find-now');
  }

  const api: ChatFind = {
    el,
    get isOpen() {
      return !el.hidden;
    },
    open(query) {
      const wasOpen = !el.hidden;
      el.hidden = false;
      if (!wasOpen) removeLayer = shell.layers.push({ id: 'chat-find', close: () => api.close() });
      if (query !== undefined) input.value = query;
      input.focus();
      input.select();
      run(true);
    },
    close() {
      if (el.hidden) return;
      el.hidden = true;
      removeLayer?.();
      removeLayer = null;
      clearTimeout(timer);
      timer = undefined;
      ranges = [];
      cur = -1;
      clearPaint();
      if (el.contains(document.activeElement)) scroller.focus({ preventScroll: true });
    },
    refresh() {
      if (el.hidden || !input.value.trim()) return;
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        if (!el.hidden) run(false);
      }, 250);
    },
  };
  return api;
}
