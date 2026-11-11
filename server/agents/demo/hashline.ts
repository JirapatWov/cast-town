// Build omp `edit` tool inputs (hashline patches) from content-anchored operations.
//
// omp's edit format: a `[path#TAG]` header (TAG = 4-hex snapshot id from the latest read/edit result of that
// file), then ops that use ORIGINAL line numbers: `PUT N.=M:` (replace), `PUT >N:` / `PUT <N:` (insert
// after/before), each followed by `+line` body rows. Anchoring by content keeps patches correct even if
// the file shifted a little; if an anchor is missing the patch is reported as not applicable.
import type { ToolCallRecord } from './conversation';
import { findLastIndex } from '../util';

export interface AnchorOp {
  anchor: string | RegExp; // first line containing / matching it
  from?: string | RegExp; // only search at or after the first line matching this
  op: 'replace' | 'after' | 'before';
  lines: string[];
  span?: number; // replace: how many lines starting at the anchor (default 1)
  last?: boolean; // use the last matching line instead of the first
}

export interface PlannedEdit {
  newContent: string;
  /** Hashline edit input for a given snapshot tag. */
  input(tag: string): string;
  /** The same change as one string replacement (for models whose `edit` tool takes old_string/new_string). */
  replace: { old_string: string; new_string: string };
}

const matches = (line: string, p: string | RegExp) => (typeof p === 'string' ? line.includes(p) : p.test(line));

export function planEdit(path: string, content: string, ops: AnchorOp[]): PlannedEdit | null {
  const lines = content.split('\n');
  const resolved: { idx: number; op: AnchorOp }[] = [];
  for (const op of ops) {
    const start = op.from ? lines.findIndex((l) => matches(l, op.from!)) : 0;
    if (start < 0) return null;
    const tail = lines.slice(start);
    const rel = op.last ? findLastIndex(tail, (l) => matches(l, op.anchor)) : tail.findIndex((l) => matches(l, op.anchor));
    if (rel < 0) return null;
    resolved.push({ idx: start + rel, op });
  }
  resolved.sort((a, b) => a.idx - b.idx);
  for (let i = 1; i < resolved.length; i++) {
    const prev = resolved[i - 1];
    const prevEnd = prev.idx + (prev.op.op === 'replace' ? (prev.op.span ?? 1) - 1 : 0);
    if (resolved[i].idx <= prevEnd && !(prev.op.op === 'before' && resolved[i].idx === prev.idx)) return null; // overlapping ops
  }

  const next = [...lines];
  for (const { idx, op } of [...resolved].reverse()) {
    if (op.op === 'replace') next.splice(idx, op.span ?? 1, ...op.lines);
    else if (op.op === 'after') next.splice(idx + 1, 0, ...op.lines);
    else next.splice(idx, 0, ...op.lines);
  }

  // One contiguous old → new region covering every op, widened until the old text is unique in the file.
  let lo = resolved[0].idx;
  let hi = Math.max(...resolved.map(({ idx, op }) => idx + (op.op === 'replace' ? (op.span ?? 1) - 1 : 0)));
  const grow = next.length - lines.length;
  const region = () => lines.slice(lo, hi + 1).join('\n');
  while ((lo > 0 || hi < lines.length - 1) && occurrences(content, region()) > 1) {
    if (lo > 0) lo--;
    if (hi < lines.length - 1) hi++;
  }
  const replace = { old_string: region(), new_string: next.slice(lo, hi + 1 + grow).join('\n') };

  const body = resolved
    .map(({ idx, op }) => {
      const n = idx + 1;
      const head = op.op === 'replace' ? `PUT ${n}.=${n + (op.span ?? 1) - 1}:` : op.op === 'after' ? `PUT >${n}:` : `PUT <${n}:`;
      return [head, ...op.lines.map((l) => `+${l}`)].join('\n');
    })
    .join('\n');
  return { newContent: next.join('\n'), input: (tag) => `[${path}#${tag}]\n${body}\n`, replace };
}

function occurrences(haystack: string, needle: string): number {
  if (!needle) return Infinity;
  let n = 0;
  for (let i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + 1)) n++;
  return n;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Most recent snapshot tag for `path` seen in this turn's tool results (read/edit/grep output headers). */
export function latestTag(turn: ToolCallRecord[], path: string): string | null {
  const re = new RegExp(`(?:\\[|^#\\s*)${escape(path)}#([0-9A-Fa-f]{4})\\]?`, 'm');
  const current = /needs this file's current tag, #([0-9A-Fa-f]{4})/;
  for (const c of [...turn].reverse()) {
    const r = c.result ?? '';
    const hit = r.match(current) && r.includes(path) ? r.match(current) : r.match(re);
    if (hit) return hit[1].toUpperCase();
  }
  return null;
}
