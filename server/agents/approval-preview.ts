// What a file-changing tool call would change, for its approval card (finding #12): "Ask first" is only worth
// something if the user sees what they approve. omp's own prompt names the file and nothing else, so CAST works the
// change out from the call's arguments and the file on disk — omp's edit tool in each of its modes (hashline, the
// default; replace; patch; apply_patch) and write — and sends it as a unified diff on the card.
// Only files inside the folder this person works in are read (their job's copy or the house), never through a
// symlink that leads out of it, and only text files of a sane size. When an edit can't be placed exactly (a block
// op, a patch whose lines aren't in the file, a file CAST may not read) the card still shows the lines the call
// writes, marked approximate.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { ApprovalChange } from '../../shared/protocol';
import { diffLines, fileDiff, splitLines } from './line-diff';

/** Files bigger than this are not read for a preview. */
const MAX_READ_BYTES = 2_000_000;
/** The diff sent with the card is cut at this many lines / characters (`truncated`). */
export const MAX_DIFF_LINES = 1500;
const MAX_DIFF_CHARS = 150_000;
/** Longer lines (minified code) are cut in the preview. */
const MAX_LINE_CHARS = 2000;

type Old = { kind: 'text'; text: string } | { kind: 'missing' } | { kind: 'unknown' };

/** One file the call touches: where it started, where it ends up. */
interface Doc {
  path: string;
  orig: Old;
  /** The content after the call's ops so far: text, null = deleted, undefined = can't tell (an op couldn't be placed). */
  text: string | null | undefined;
  /** Shown as-is once the text can't be told. */
  loose: { hunks: string[]; added: number; removed: number };
  /** Placed by a guess (a block op's extent): exact lines, maybe not the exact range. */
  guess?: boolean;
  renameTo?: string;
}

interface Hunk {
  /** Text after "@@" (apply_patch: a line to find first; unified diff: "-a,b +c,d @@ …"). */
  anchor: string;
  lines: string[];
}

class Workspace {
  readonly docs = new Map<string, Doc>();
  readonly #realDir: string | undefined;

  constructor(private readonly dir: string | undefined) {
    try {
      this.#realDir = dir ? realpathSync(dir) : undefined;
    } catch {
      this.#realDir = undefined;
    }
  }

  doc(rawPath: string): Doc {
    const path = this.#show(rawPath);
    let d = this.docs.get(path);
    if (!d) {
      const orig = this.#read(rawPath);
      d = { path, orig, text: orig.kind === 'text' ? orig.text : orig.kind === 'missing' ? null : undefined, loose: { hunks: [], added: 0, removed: 0 } };
      this.docs.set(path, d);
    }
    return d;
  }

  /** The path as the card shows it: relative to the work folder when inside it. */
  #show(rawPath: string): string {
    const p = unwrapHeader(rawPath.trim());
    if (this.dir && isAbsolute(p)) {
      const rel = relative(this.dir, p);
      if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel;
    }
    return p.replace(/^\.\//, '');
  }

  #read(rawPath: string): Old {
    const p = unwrapHeader(rawPath.trim());
    if (!this.dir || !this.#realDir || !p || p.startsWith('~') || /^[a-z][\w+.-]*:\/\//i.test(p)) return { kind: 'unknown' };
    const abs = resolve(this.dir, p);
    if (!inside(this.dir, abs)) return { kind: 'unknown' };
    let size: number;
    try {
      const st = statSync(abs);
      if (!st.isFile()) return { kind: 'unknown' };
      size = st.size;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'missing' } : { kind: 'unknown' };
    }
    if (size > MAX_READ_BYTES) return { kind: 'unknown' };
    try {
      const real = realpathSync(abs);
      if (!inside(this.#realDir, real)) return { kind: 'unknown' };
      const text = readFileSync(real, 'utf8');
      if (text.includes('\0')) return { kind: 'unknown' }; // binary
      return { kind: 'text', text: text.replace(/^﻿/, '').replace(/\r\n/g, '\n') };
    } catch {
      return { kind: 'unknown' };
    }
  }
}

function inside(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** omp may name a file as a hashline header, `[path#TAG]`. */
function unwrapHeader(p: string): string {
  const m = /^\[(.+)#[0-9A-Za-z]{1,16}\]$/.exec(p);
  return m ? m[1] : p;
}

const lf = (s: string) => s.replace(/\r\n/g, '\n');

// ---- what the ops do to a Doc --------------------------------------------------------------------------------

function setText(d: Doc, text: string) {
  if (d.text === undefined) return; // already loose: later exact steps can't be shown against an unknown base
  d.text = text;
}

/** The step couldn't be placed: show `oldLines` → `newLines` as they are (from line `at` when known). */
function loosen(d: Doc, oldLines: string[], newLines: string[], at = 1) {
  if (typeof d.text === 'string' && d.orig.kind === 'text' && d.text !== d.orig.text) {
    const so = diffLines(splitLines(d.orig.text), splitLines(d.text));
    d.loose.hunks.push(...so.hunks);
    d.loose.added += so.added;
    d.loose.removed += so.removed;
  }
  d.text = undefined;
  const r = diffLines(oldLines, newLines, 3, Math.max(1, at));
  d.loose.hunks.push(...r.hunks);
  d.loose.added += r.added;
  d.loose.removed += r.removed;
}

function joinLines(lines: string[], trailingNewline: boolean): string {
  if (!lines.length) return '';
  return lines.join('\n') + (trailingNewline ? '\n' : '');
}

/** Apply unified-diff style hunks (' ' / '-' / '+' lines) to `text`; undefined when one can't be found. */
function applyHunks(text: string, hunks: Hunk[]): string | undefined {
  const lines = splitLines(text);
  const nl = text === '' || text.endsWith('\n');
  let cursor = 0;
  for (const h of hunks) {
    const old: string[] = [];
    const neu: string[] = [];
    for (const l of h.lines) {
      if (l.startsWith('\\')) continue; // "\ No newline at end of file"
      const c = l[0];
      const body = l.slice(1);
      if (c === '-') old.push(body);
      else if (c === '+') neu.push(body);
      else {
        // context (' '), or a bare line some writers leave unprefixed
        const ctx = c === ' ' ? body : l;
        old.push(ctx);
        neu.push(ctx);
      }
    }
    const hint = /^-(\d+)/.exec(h.anchor.trim());
    let at: number;
    if (!old.length) {
      if (hint) at = Math.min(lines.length, Number(hint[1]));
      else {
        const a = h.anchor.trim();
        const idx = a ? lines.findIndex((l, i) => i >= cursor && l.trim() === a) : -1;
        if (idx < 0) return undefined;
        at = idx + 1;
      }
    } else {
      const anchor = !hint && h.anchor.trim() ? lines.findIndex((l, i) => i >= cursor && l.trim() === h.anchor.trim()) : -1;
      const from = hint ? Math.max(0, Number(hint[1]) - 1 - 50) : anchor >= 0 ? anchor : cursor;
      at = findSeq(lines, old, from);
      if (at < 0) at = findSeq(lines, old, 0);
      if (at < 0) return undefined;
    }
    lines.splice(at, old.length, ...neu);
    cursor = at + neu.length;
  }
  return joinLines(lines, nl);
}

function findSeq(lines: string[], seq: string[], from: number): number {
  for (const eq of [(a: string, b: string) => a === b, (a: string, b: string) => a.trimEnd() === b.trimEnd()]) {
    for (let i = Math.max(0, from); i + seq.length <= lines.length; i++) {
      let ok = true;
      for (let j = 0; j < seq.length && ok; j++) ok = eq(lines[i + j], seq[j]);
      if (ok) return i;
    }
  }
  return -1;
}

function splitHunks(lines: string[]): Hunk[] {
  const hunks: Hunk[] = [];
  let cur: Hunk | undefined;
  for (const l of lines) {
    if (l.startsWith('@@')) {
      cur = { anchor: l.replace(/^@@\s?/, '').replace(/\s?@@$/, ''), lines: [] };
      hunks.push(cur);
    } else if (l === '*** End of File') continue;
    else {
      if (!cur) {
        cur = { anchor: '', lines: [] };
        hunks.push(cur);
      }
      cur.lines.push(l);
    }
  }
  return hunks.filter((h) => h.lines.length);
}

function hunkSides(h: Hunk): { old: string[]; neu: string[] } {
  const old: string[] = [];
  const neu: string[] = [];
  for (const l of h.lines) {
    if (l.startsWith('\\')) continue;
    if (l[0] === '-') old.push(l.slice(1));
    else if (l[0] === '+') neu.push(l.slice(1));
    else {
      const ctx = l[0] === ' ' ? l.slice(1) : l;
      old.push(ctx);
      neu.push(ctx);
    }
  }
  return { old, neu };
}

function updateWithHunks(d: Doc, hunks: Hunk[]) {
  const base = typeof d.text === 'string' ? d.text : undefined;
  const next = base !== undefined ? applyHunks(base, hunks) : undefined;
  if (next !== undefined) return setText(d, next);
  for (const h of hunks) {
    const { old, neu } = hunkSides(h);
    const hint = /^-(\d+)/.exec(h.anchor.trim());
    loosen(d, old, neu, hint ? Number(hint[1]) : 1);
  }
}

// ---- omp's edit modes ----------------------------------------------------------------------------------------

/** replace mode: { path, old_string, new_string, replace_all? } */
function replaceEdit(ws: Workspace, a: Record<string, unknown>) {
  const d = ws.doc(String(a.path));
  const oldS = lf(String(a.old_string));
  const newS = lf(String(a.new_string));
  const text = d.text;
  if (typeof text === 'string' && oldS) {
    const idx = text.indexOf(oldS);
    if (idx >= 0) {
      setText(d, a.replace_all === true ? text.split(oldS).join(newS) : text.slice(0, idx) + newS + text.slice(idx + oldS.length));
      return;
    }
  }
  if (text === null && !oldS) {
    d.text = newS; // an empty old_string on a missing file creates it
    return;
  }
  // whitespace-fuzzy matches and unreadable files: the snippet itself, place unknown
  let at = 1;
  if (typeof text === 'string') {
    const first = splitLines(oldS)[0]?.trim();
    const i = first ? splitLines(text).findIndex((l) => l.trim() === first) : -1;
    if (i >= 0) at = i + 1;
  }
  loosen(d, splitLines(oldS), splitLines(newS), at);
}

/** patch mode: { path, edits: [{ op?: create|delete|update, rename?, diff? }] } */
function patchEdit(ws: Workspace, a: Record<string, unknown>) {
  const d = ws.doc(String(a.path));
  for (const e of a.edits as unknown[]) {
    if (!e || typeof e !== 'object') continue;
    const { op, rename, diff } = e as { op?: string; rename?: string; diff?: string };
    if (op === 'delete') d.text = d.text === undefined ? undefined : null;
    else if (op === 'create') {
      const lines = splitLines(lf(diff ?? ''));
      const plus = lines.length > 0 && lines.every((l) => l === '' || l.startsWith('+'));
      const content = joinLines(plus ? lines.map((l) => l.slice(1)) : lines, true);
      if (d.text === undefined) loosen(d, [], splitLines(content));
      else d.text = content;
    } else if (diff) updateWithHunks(d, splitHunks(splitLines(lf(diff))));
    if (typeof rename === 'string' && rename.trim()) d.renameTo = ws.doc(rename).path;
  }
}

/** apply_patch: *** Begin Patch / *** Add File: p / *** Update File: p / *** Move to: q / @@ … / *** Delete File: p */
function applyPatch(ws: Workspace, input: string) {
  type Section = { kind: 'add' | 'update' | 'delete'; path: string; moveTo?: string; lines: string[] };
  const sections: Section[] = [];
  let cur: Section | undefined;
  for (const l of splitLines(lf(input))) {
    const m = /^\*\*\* (Add|Update|Delete) File:\s*(.+?)\s*$/.exec(l);
    if (m) {
      cur = { kind: m[1].toLowerCase() as Section['kind'], path: m[2], lines: [] };
      sections.push(cur);
      continue;
    }
    const mv = /^\*\*\* Move to:\s*(.+?)\s*$/.exec(l);
    if (mv && cur) {
      cur.moveTo = mv[1];
      continue;
    }
    if (/^\*\*\* (Begin|End) Patch\s*$/.test(l)) continue;
    cur?.lines.push(l);
  }
  for (const s of sections) {
    const d = ws.doc(s.path);
    if (s.kind === 'delete') d.text = d.text === undefined ? undefined : null;
    else if (s.kind === 'add') {
      const content = joinLines(s.lines.filter((l) => l !== '*** End of File').map((l) => (l.startsWith('+') ? l.slice(1) : l)), true);
      if (d.text === undefined) loosen(d, [], splitLines(content));
      else d.text = content;
    } else updateWithHunks(d, splitHunks(s.lines));
    if (s.moveTo) d.renameTo = ws.doc(s.moveTo).path;
  }
}

/** hashline (omp's default): [PATH#TAG] sections of PUT / CUT / REM / MV ops on the lines as last read. */
function hashline(ws: Workspace, input: string) {
  type Op = { verb: 'PUT' | 'CUT'; side: '' | '<' | '>'; from: number; to: number; end: boolean; block: boolean; reg?: string; body?: string[] };
  type Section = { path: string; ops: Op[]; rem: boolean; mv?: string };
  const sections: Section[] = [];
  let cur: Section | undefined;
  let last: Op | undefined;
  const OP = /^(PUT|CUT)\s+([<>]?)(\$|\d+)(?:\s*(?:\.=|\.\.|,|-)\s*(\d+))?(\*)?\s*(?:@(\S+))?\s*(:)?\s*$/;
  for (const l of splitLines(lf(input))) {
    const head = /^\[(.+)#[0-9A-Za-z]{1,16}\]\s*$/.exec(l);
    if (head) {
      cur = { path: head[1], ops: [], rem: false };
      sections.push(cur);
      last = undefined;
      continue;
    }
    if (!cur || /^\*\*\* (Begin|End) Patch\s*$/.test(l)) continue;
    if (l.startsWith('+') && last?.body) {
      last.body.push(l.slice(1));
      continue;
    }
    const m = OP.exec(l.trim());
    if (m) {
      const end = m[3] === '$';
      const from = end ? 0 : Number(m[3]);
      last = { verb: m[1] as Op['verb'], side: m[2] as Op['side'], from, to: m[4] ? Number(m[4]) : from, end, block: !!m[5], reg: m[6], body: m[7] ? [] : undefined };
      cur.ops.push(last);
    } else if (/^REM\s*$/.test(l.trim())) cur.rem = true;
    else if (/^MV\s+\S/.test(l.trim())) cur.mv = l.trim().slice(2).trim();
  }

  const registers = new Map<string, string[]>();
  for (const s of sections) {
    const d = ws.doc(s.path);
    if (s.ops.length) hashlineOps(d, s.ops, registers);
    if (s.rem) d.text = d.text === undefined ? undefined : null;
    if (s.mv) d.renameTo = ws.doc(s.mv).path;
  }

  function hashlineOps(d: Doc, ops: Op[], regs: Map<string, string[]>) {
    const base = typeof d.text === 'string' ? d.text : null;
    const lines = base !== null ? splitLines(base) : [];
    const n = lines.length;
    const del = new Array<boolean>(n).fill(false);
    const before: string[][] = Array.from({ length: n + 1 }, () => []);
    const repl: string[][] = Array.from({ length: n }, () => []);
    let ok = base !== null || ops.every((o) => o.end); // a missing file can only be appended to
    let guess = false;
    const range = (o: Op): [number, number] | null => {
      if (o.block) {
        if (o.from < 1 || o.from > n) return null;
        guess = true;
        return [o.from, blockEnd(lines, o.from - 1) + 1];
      }
      return o.from >= 1 && o.to >= o.from && o.to <= n ? [o.from, o.to] : null;
    };
    const content = (o: Op): string[] | null => (o.body ? o.body : (regs.get(o.reg ?? '') ?? null));
    for (const o of ok ? ops : []) {
      if (o.verb === 'CUT') {
        const r = range(o);
        if (!r) {
          ok = false;
          break;
        }
        for (let i = r[0] - 1; i < r[1]; i++) del[i] = true;
        regs.set(o.reg ?? '', lines.slice(r[0] - 1, r[1]));
        continue;
      }
      const body = content(o);
      if (!body) {
        ok = false;
        break;
      }
      if (o.side === '<' || o.side === '>') {
        let gap: number; // index in `before`
        if (o.end) gap = n;
        else if (o.side === '<') gap = o.from - 1;
        else gap = o.block ? (range(o)?.[1] ?? -1) : o.from;
        if (gap < 0 || gap > n || (o.side === '<' && o.from < 1)) {
          ok = false;
          break;
        }
        before[gap].push(...body);
      } else {
        const r = range(o);
        if (!r) {
          ok = false;
          break;
        }
        for (let i = r[0] - 1; i < r[1]; i++) {
          if (del[i]) guess = true;
          del[i] = true;
        }
        repl[r[0] - 1].push(...body);
      }
    }
    if (ok) {
      const out: string[] = [];
      for (let i = 0; i < n; i++) {
        out.push(...before[i], ...repl[i]);
        if (!del[i]) out.push(lines[i]);
      }
      out.push(...before[n]);
      if (guess) d.guess = true;
      setText(d, joinLines(out, base === null || base === '' || base.endsWith('\n')));
      return;
    }
    // couldn't place them: what each op writes, at the line it names
    for (const o of ops) {
      const removed = o.verb === 'CUT' || o.side === '' ? Math.max(1, o.to - o.from + 1) : 0;
      const body = o.verb === 'CUT' ? [] : (content(o) ?? []);
      const oldLines = base !== null && o.from >= 1 ? lines.slice(o.from - 1, o.from - 1 + (o.block ? 1 : removed)) : [];
      loosen(d, oldLines, body, o.side === '>' ? o.from + 1 : o.from || 1);
      if (!oldLines.length) d.loose.removed += removed;
    }
  }
}

/** The last line (0-based) of the syntax block that starts at `i`: a markdown section, or an indented / bracketed
 *  block (up to its closing line). A guess — block ops are marked approximate. */
function blockEnd(lines: string[], i: number): number {
  const first = lines[i];
  const heading = /^(#{1,6})\s/.exec(first);
  if (heading) {
    const level = heading[1].length;
    let j = i + 1;
    while (j < lines.length && !(/^(#{1,6})\s/.exec(lines[j]) && /^(#{1,6})\s/.exec(lines[j])![1].length <= level)) j++;
    return j - 1;
  }
  const indent = (l: string) => /^\s*/.exec(l)![0].length;
  const base = indent(first);
  let lastBody = i;
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j];
    if (!l.trim()) continue;
    if (indent(l) > base) {
      lastBody = j;
      continue;
    }
    // back at the opener's depth: a closer belongs to the block, anything else starts the next one
    return /^\s*([}\])]|end\b|<\/|fi\b|done\b|esac\b)/.test(l) ? j : lastBody;
  }
  return lastBody;
}

// ---- the card's diff -----------------------------------------------------------------------------------------

/** What a file-changing tool call would change, or undefined when it isn't one (or CAST can't tell). */
export function approvalChange(tool: string, args: unknown, dir: string | undefined): ApprovalChange | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const a = args as Record<string, unknown>;
  const ws = new Workspace(dir);
  if (tool === 'write') {
    if (typeof a.path !== 'string' || typeof a.content !== 'string') return undefined;
    const d = ws.doc(a.path);
    const content = lf(a.content);
    if (d.orig.kind === 'unknown') loosen(d, [], splitLines(content));
    else d.text = content;
  } else if (tool === 'edit' || tool === 'apply_patch') {
    if (typeof a.path === 'string' && typeof a.old_string === 'string' && typeof a.new_string === 'string') replaceEdit(ws, a);
    else if (typeof a.path === 'string' && Array.isArray(a.edits)) patchEdit(ws, a);
    else if (typeof a.input === 'string') {
      if (/^\*\*\* (Add|Update|Delete) File:/m.test(a.input)) applyPatch(ws, a.input);
      else if (/^\[.+#[0-9A-Za-z]{1,16}\]\s*$/m.test(a.input)) hashline(ws, a.input);
      else return undefined;
    } else return undefined;
  } else return undefined;
  return assemble([...ws.docs.values()]);
}

interface FileChange {
  path: string;
  hunks: string[];
  added: number;
  removed: number;
  isNew?: boolean;
  isDeleted?: boolean;
  renameTo?: string;
  approx: boolean;
}

function changeOf(d: Doc): FileChange | null {
  const base = { path: d.path, renameTo: d.renameTo, approx: !!d.guess };
  if (d.text === undefined) return { ...base, ...d.loose, approx: true };
  const origText = d.orig.kind === 'text' ? d.orig.text : null;
  if (d.text === null) {
    if (d.orig.kind === 'missing') return null; // created and deleted again, or deleting nothing
    const old = splitLines(origText ?? '');
    const r = diffLines(old, []);
    return { ...base, ...r, isDeleted: true, approx: base.approx || origText === null };
  }
  if (d.orig.kind === 'missing') {
    const r = diffLines([], splitLines(d.text));
    return { ...base, ...r, isNew: true };
  }
  if (origText === null) return null; // unknown base never reaches here (loosened)
  if (origText === d.text && !d.renameTo) return { ...base, hunks: [], added: 0, removed: 0 };
  return { ...base, ...diffLines(splitLines(origText), splitLines(d.text)) };
}

function trimHunk(hunk: string, keep: number): string {
  const lines = hunk.split('\n');
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(lines[0]);
  const body = lines.slice(1, 1 + Math.max(0, keep));
  if (!m) return [lines[0], ...body].join('\n');
  const oldCount = body.filter((l) => l[0] !== '+').length;
  const newCount = body.filter((l) => l[0] !== '-').length;
  return [`@@ -${m[1]},${oldCount} +${m[2]},${newCount} @@${m[3]}`, ...body].join('\n');
}

function assemble(docs: Doc[]): ApprovalChange | undefined {
  const changes = docs.map(changeOf).filter((c): c is FileChange => !!c);
  if (!changes.length) return undefined;
  let lineBudget = MAX_DIFF_LINES;
  let charBudget = MAX_DIFF_CHARS;
  let truncated = false;
  const parts: string[] = [];
  for (const c of changes) {
    const kept: string[] = [];
    for (let h of c.hunks) {
      if (lineBudget <= 0 || charBudget <= 0) {
        truncated = true;
        break;
      }
      if (h.split('\n').some((l) => l.length > MAX_LINE_CHARS)) {
        h = h.split('\n').map((l) => (l.length > MAX_LINE_CHARS ? `${l.slice(0, MAX_LINE_CHARS)} …` : l)).join('\n');
        truncated = true;
      }
      const n = h.split('\n').length - 1;
      if (n <= lineBudget && h.length <= charBudget) {
        kept.push(h);
        lineBudget -= n;
        charBudget -= h.length;
        continue;
      }
      // cut inside this hunk: as many lines as both budgets allow
      const lines = h.split('\n');
      let keep = 0;
      let chars = lines[0].length;
      while (keep < Math.min(n, lineBudget) && chars + lines[keep + 1].length + 1 <= charBudget) chars += lines[++keep].length + 1;
      if (keep > 0) kept.push(trimHunk(h, keep));
      truncated = true;
      lineBudget = 0;
      break;
    }
    if ((lineBudget <= 0 || charBudget <= 0) && !kept.length && parts.length) continue; // past the budget: named in `files`, not drawn
    parts.push(fileDiff(c.path, kept, { isNew: c.isNew, isDeleted: c.isDeleted, renameTo: c.renameTo }));
  }
  const approx = changes.some((c) => c.approx);
  return {
    diff: parts.join('\n'),
    files: changes.map((c) => (c.renameTo && c.renameTo !== c.path ? `${c.path} → ${c.renameTo}` : c.path)),
    added: changes.reduce((t, c) => t + c.added, 0),
    removed: changes.reduce((t, c) => t + c.removed, 0),
    ...(truncated ? { truncated: true } : {}),
    ...(approx ? { approx: true } : {}),
  };
}
