// Reusable "read → edit → repair" steps for scripts that change files.
// Targets are recomputed from disk on every request (the files only change when our own edit lands), the
// edit uses the snapshot tag from this turn's read results, and a rejected edit falls back to a full write.
import { latestTag, planEdit, type AnchorOp, type PlannedEdit } from './hashline';
import { readText } from './project-scan';
import { edit, isFailure, read, write, type Ctx, type Step, type ToolCall } from './script';
import { findLastIndex } from '../util';

export interface EditTarget {
  path: string;
  what: string; // one-line summary ("`TodoStore.markDone(id)`")
  edit: PlannedEdit | null; // null → create the file with `content`
  content?: string;
}

const SEP = ' — ';
const intentFor = (t: EditTarget) => `${t.path}${SEP}${t.what}`;

export interface EditStepsOptions {
  targets(ctx: Ctx): EditTarget[];
  /** Extra reads to batch with the first read (e.g. the plan file). */
  extraReads?(ctx: Ctx): ToolCall[];
  readThinking?(ctx: Ctx, paths: string[]): string | undefined;
  editThinking?(ctx: Ctx, targets: EditTarget[]): string | undefined;
}

export function editSteps(o: EditStepsOptions): Step[] {
  return [
    {
      name: 'read',
      plan(ctx) {
        const existing = o.targets(ctx).filter((t) => t.edit);
        const calls = [...(o.extraReads?.(ctx) ?? []), ...existing.map((t) => read(t.path))];
        if (!calls.length) return null;
        return { thinking: o.readThinking?.(ctx, existing.map((t) => t.path)), calls };
      },
    },
    {
      name: 'edit',
      plan(ctx) {
        const targets = o.targets(ctx);
        if (!targets.length) return null;
        const calls = targets.map((t) => editCall(ctx, t));
        return { thinking: o.editThinking?.(ctx, targets), calls };
      },
    },
    {
      name: 'repair',
      plan(ctx) {
        const failedPaths = ctx
          .calls('edit')
          .filter((c) => isFailure(c.result))
          .map((c) => String(c.args.i ?? '').split(SEP)[0]);
        if (!failedPaths.length) return null;
        const targets = o.targets(ctx).filter((t) => failedPaths.includes(t.path));
        if (!targets.length) return null;
        return {
          thinking: `The edit to ${failedPaths.map((p) => `\`${p}\``).join(', ')} didn't apply — the file must have shifted. Writing the full updated file instead.`,
          calls: targets.map((t) => write(t.path, t.edit ? t.edit.newContent : (t.content ?? ''), intentFor(t))),
        };
      },
    },
  ];
}

/** The right tool call for this model: hashline `edit`, old/new `edit`, or a full `write` as the fallback. */
export function editCall(ctx: Ctx, t: EditTarget): ToolCall {
  const mode = ctx.conv.editMode;
  if (t.edit && mode === 'hashline') {
    const tag = latestTag(ctx.conv.turn, t.path);
    if (tag) return edit(t.edit.input(tag), intentFor(t));
  }
  if (t.edit && mode === 'replace') return { name: 'edit', args: { i: intentFor(t), path: t.path, ...t.edit.replace } };
  return write(t.path, t.edit ? t.edit.newContent : (t.content ?? ''), intentFor(t));
}


/** What the edit steps actually changed this turn: "path — what" for each successful call. */
export function changedThisTurn(ctx: Ctx): { path: string; what: string }[] {
  const out = new Map<string, string>();
  for (const c of [...ctx.calls('edit'), ...ctx.calls('repair')]) {
    if (isFailure(c.result) || c.result === null) continue;
    const [path, ...rest] = String(c.args.i ?? '').split(SEP);
    if (path) out.set(path, rest.join(SEP));
  }
  return [...out].map(([path, what]) => ({ path, what }));
}

/** Append a markdown section (or create the file) — the honest generic "change" of the demo model. */
export function appendSection(cwd: string, path: string, lines: string[], what: string): EditTarget {
  const content = readText(cwd, path);
  if (content === null) return { path, what, edit: null, content: `${lines.join('\n')}\n` };
  const all = content.split('\n');
  const lastNonEmpty = findLastIndex(all, (l) => l.trim() !== '');
  if (lastNonEmpty < 0) return { path, what, edit: null, content: `${lines.join('\n')}\n` };
  const op: AnchorOp = { anchor: all[lastNonEmpty], last: true, op: 'after', lines: ['', ...lines] };
  return { path, what, edit: planEdit(path, content, [op]) };
}
