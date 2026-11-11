// What the user wrote for each person but hasn't sent: one draft per chat target (an agent id), kept in this city's
// browser storage so a draft survives switching people, jobs and houses — and a reload. The composer shows the
// draft of whoever it talks to; nothing typed for one person can ever sit in another person's box.
// Pure (no DOM): the composer passes its storage in, tests pass a map.
import type { ImageRef } from '../../../shared/protocol';

export interface Draft {
  text: string;
  images: ImageRef[];
}

interface Stored extends Draft {
  at: number; // last change (ms)
}

export interface DraftStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export const DRAFTS_KEY = 'rlt.drafts';
/** Drafts kept at most (oldest go first) and how long an untouched one lives. */
export const MAX_DRAFTS = 60;
export const DRAFT_TTL_MS = 30 * 24 * 3600_000;
/** The server takes at most 100 000 characters per message; a longer draft is cut there. */
const MAX_TEXT = 100_000;

export const isEmptyDraft = (d: Draft | undefined): boolean => !d || (!d.text.trim() && !d.images.length);

function cleanImages(v: unknown): ImageRef[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((r): r is ImageRef => !!r && typeof r === 'object' && typeof (r as ImageRef).id === 'string' && typeof (r as ImageRef).mimeType === 'string')
    .map((r) => ({ id: r.id, mimeType: r.mimeType }));
}

/** A message put back (a failed send, Stop, a queue chip's ×) under what the draft holds already. */
export function appendDraft(cur: Draft | undefined, extra: Draft, maxImages: number): { draft: Draft; dropped: number } {
  const base = cur ?? { text: '', images: [] };
  const add = extra.text.trim();
  const head = base.text.replace(/\s+$/, '');
  // Already there (a send that Stop called off keeps its words, and Stop's own answer brings the same ones): not twice.
  const body = head.trim();
  if (add && (body === add || body.endsWith(`\n\n${add}`)) && extra.images.every((r) => base.images.some((x) => x.id === r.id))) {
    return { draft: base, dropped: 0 };
  }
  const text = add ? (head ? `${head}\n\n${add}` : add) : base.text;
  const images = [...base.images];
  let dropped = 0;
  for (const ref of extra.images) {
    if (images.some((r) => r.id === ref.id)) continue;
    if (images.length >= maxImages) dropped++;
    else images.push(ref);
  }
  return { draft: { text, images }, dropped };
}

/** Take a message that did arrive after all back out of a draft: the whole draft when it is just that message, or
 *  the block appendDraft put at its end. null → the draft doesn't hold it (the user changed it meanwhile). */
export function removeFromDraft(cur: Draft | undefined, sent: Draft): Draft | null {
  if (!cur) return null;
  const text = sent.text.trim();
  const ids = new Set(sent.images.map((r) => r.id));
  if (!sent.images.every((r) => cur.images.some((x) => x.id === r.id))) return null;
  const images = cur.images.filter((r) => !ids.has(r.id));
  const body = cur.text.trim();
  if (body === text) return { text: '', images };
  if (text && body.endsWith(`\n\n${text}`)) return { text: body.slice(0, -(text.length + 2)).replace(/\s+$/, ''), images };
  if (!text && sent.images.length) return { text: cur.text, images };
  return null;
}

export function createDraftBook(store: DraftStorage, now: () => number = Date.now) {
  let all: Record<string, Stored> | null = null;

  function load(): Record<string, Stored> {
    if (all) return all;
    all = {};
    try {
      const raw = JSON.parse(store.get(DRAFTS_KEY) ?? '{}') as Record<string, unknown>;
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const cutoff = now() - DRAFT_TTL_MS;
        for (const [id, v] of Object.entries(raw)) {
          const d = v as Partial<Stored> | null;
          if (!d || typeof d.text !== 'string') continue;
          const at = typeof d.at === 'number' ? d.at : 0;
          if (at < cutoff) continue;
          const draft = { text: d.text.slice(0, MAX_TEXT), images: cleanImages(d.images), at };
          if (!isEmptyDraft(draft)) all[id] = draft;
        }
      }
    } catch {
      /* a broken entry: start over */
    }
    return all;
  }

  function save() {
    const map = load();
    const ids = Object.keys(map);
    if (ids.length > MAX_DRAFTS) {
      ids.sort((a, b) => map[a].at - map[b].at);
      for (const id of ids.slice(0, ids.length - MAX_DRAFTS)) delete map[id];
    }
    if (Object.keys(map).length) store.set(DRAFTS_KEY, JSON.stringify(map));
    else store.remove(DRAFTS_KEY);
  }

  return {
    get(id: string): Draft | undefined {
      const d = load()[id];
      return d ? { text: d.text, images: d.images.map((r) => ({ ...r })) } : undefined;
    },
    /** Replace a person's draft (an empty one is dropped). */
    set(id: string, draft: Draft) {
      const map = load();
      const next = { text: draft.text.slice(0, MAX_TEXT), images: cleanImages(draft.images) };
      if (isEmptyDraft(next)) {
        if (!(id in map)) return;
        delete map[id];
      } else {
        const cur = map[id];
        if (cur && cur.text === next.text && JSON.stringify(cur.images) === JSON.stringify(next.images)) return;
        map[id] = { ...next, at: now() };
      }
      save();
    },
    clear(id: string) {
      const map = load();
      if (!(id in map)) return;
      delete map[id];
      save();
    },
    ids(): string[] {
      return Object.keys(load());
    },
  };
}

export type DraftBook = ReturnType<typeof createDraftBook>;
