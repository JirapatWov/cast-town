// Search a person's chats (finding #44): their titles and what was said — messages, tool steps and their output,
// system notes, helpers' tasks, the advisor's notes. Case-insensitive plain text; pure (ThreadBook hands it the
// items of each chat).
import type { TranscriptItem } from '../../shared/protocol';

/** Characters of context before / after the first match in a snippet. */
const BEFORE = 60;
const AFTER = 100;

/** The searchable text of one transcript item. */
export function itemText(it: TranscriptItem): string {
  switch (it.kind) {
    case 'user':
    case 'assistant':
    case 'system':
      return it.text;
    case 'tool':
      return [it.title, it.result ?? ''].join('\n');
    case 'helper':
      return `${it.name}\n${it.task}`;
    case 'advisor':
      return it.notes.map((n) => n.note).join('\n');
    case 'plan':
      return [it.plan.title, it.plan.why ?? '', it.plan.task].join('\n');
    default:
      return '';
  }
}

const squash = (s: string) => s.replace(/\s+/g, ' ');

/** The text around a match at [idx, idx + len), whitespace folded, with the match's place in it. */
export function snippetAt(text: string, idx: number, len: number): { snippet: string; at: [number, number] } {
  const start = Math.max(0, idx - BEFORE);
  const end = Math.min(text.length, idx + len + AFTER);
  const pre = (start > 0 ? '…' : '') + squash(text.slice(start, idx)).trimStart();
  const mid = squash(text.slice(idx, idx + len));
  const post = squash(text.slice(idx + len, end)).trimEnd() + (end < text.length ? '…' : '');
  return { snippet: pre + mid + post, at: [pre.length, pre.length + mid.length] };
}

export interface ItemsMatch {
  hits: number;
  snippet: string;
  at?: [number, number];
  /** The id of the item with the first match (the chat can scroll to it). */
  itemId?: string;
}

/** Count the matches of `query` in the items; the snippet is from the first one (oldest first, like the chat). */
export function searchItems(items: TranscriptItem[], query: string): ItemsMatch {
  const q = query.trim().toLowerCase();
  const out: ItemsMatch = { hits: 0, snippet: '' };
  if (!q) return out;
  for (const it of items) {
    const text = itemText(it);
    if (!text) continue;
    const low = text.toLowerCase();
    let i = low.indexOf(q);
    if (i < 0) continue;
    if (!out.snippet) {
      // lower-casing can change the length of a few characters: map back conservatively
      const idx = low.length === text.length ? i : Math.min(i, text.length);
      Object.assign(out, snippetAt(text, idx, q.length), { itemId: it.id });
    }
    while (i >= 0 && out.hits < 999) {
      out.hits++;
      i = low.indexOf(q, i + q.length);
    }
  }
  return out;
}
