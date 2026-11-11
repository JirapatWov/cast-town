// A small line diff for approval previews: old text → new text as unified-diff hunks (git style), so the approval
// card can show exactly what an edit or write would change before the user approves it.
// Common lines at both ends are trimmed first (an edit touches a few lines of a long file); the middle is diffed
// with an LCS table when it is small enough, else shown as removed-then-added (still exact, just less tidy).

export interface DiffResult {
  /** The hunks (each starting with "@@ -a,b +c,d @@"), no file headers. */
  hunks: string[];
  added: number;
  removed: number;
}

type Op = { t: '=' | '-' | '+'; line: string };

/** Above this many cells (old × new middle lines) the middle is not aligned line by line. */
const MAX_CELLS = 2_500_000;

export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop(); // a final newline ends the last line, it doesn't start a new one
  return lines;
}

function middleOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  if (!n) return b.map((line) => ({ t: '+', line }));
  if (!m) return a.map((line) => ({ t: '-', line }));
  if (n * m > MAX_CELLS) return [...a.map((line) => ({ t: '-' as const, line })), ...b.map((line) => ({ t: '+' as const, line }))];
  // lcs[i][j] = LCS length of a[i..] and b[j..], one flat array
  const w = m + 1;
  const lcs = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] = a[i] === b[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: '=', line: a[i] });
      i++;
      j++;
    } else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) ops.push({ t: '-', line: a[i++] });
    else ops.push({ t: '+', line: b[j++] });
  }
  while (i < n) ops.push({ t: '-', line: a[i++] });
  while (j < m) ops.push({ t: '+', line: b[j++] });
  return ops;
}

/** Diff two line lists. `firstLine`: the 1-based line number of a[0] in its file (a snippet's place, when known). */
export function diffLines(a: string[], b: string[], context = 3, firstLine = 1): DiffResult {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const ops: Op[] = [
    ...a.slice(0, pre).map((line) => ({ t: '=' as const, line })),
    ...middleOps(a.slice(pre, a.length - suf), b.slice(pre, b.length - suf)),
    ...a.slice(a.length - suf).map((line) => ({ t: '=' as const, line })),
  ];

  const hunks: string[] = [];
  let added = 0;
  let removed = 0;
  // positions (0-based) of each op in old / new
  const pos: { o: number; n: number }[] = [];
  let o = 0;
  let nn = 0;
  for (const op of ops) {
    pos.push({ o, n: nn });
    if (op.t !== '+') o++;
    if (op.t !== '-') nn++;
    if (op.t === '+') added++;
    if (op.t === '-') removed++;
  }
  let k = 0;
  while (k < ops.length) {
    if (ops[k].t === '=') {
      k++;
      continue;
    }
    // a hunk: from `context` lines before the first change to `context` lines after the last change that is no
    // more than 2 × context unchanged lines away from the previous one
    const start = Math.max(0, k - context);
    let end = k;
    let gap = 0;
    for (let x = k; x < ops.length; x++) {
      if (ops[x].t === '=') {
        gap++;
        if (gap > context * 2) break;
      } else {
        gap = 0;
        end = x;
      }
    }
    const stop = Math.min(ops.length, end + 1 + context);
    const body = ops.slice(start, stop);
    const oldCount = body.filter((x) => x.t !== '+').length;
    const newCount = body.filter((x) => x.t !== '-').length;
    const oldStart = oldCount ? pos[start].o + firstLine : pos[start].o + firstLine - 1;
    const newStart = newCount ? pos[start].n + firstLine : pos[start].n + firstLine - 1;
    hunks.push([`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, ...body.map((x) => `${x.t === '=' ? ' ' : x.t}${x.line}`)].join('\n'));
    k = stop;
  }
  return { hunks, added, removed };
}

/** A unified diff of one file (git style headers), for diff2html. */
export function fileDiff(path: string, hunks: string[], opts: { isNew?: boolean; isDeleted?: boolean; renameTo?: string } = {}): string {
  const to = opts.renameTo ?? path;
  const head = [`diff --git a/${path} b/${to}`];
  if (opts.isNew) head.push('new file mode 100644');
  if (opts.isDeleted) head.push('deleted file mode 100644');
  if (opts.renameTo && opts.renameTo !== path) head.push(`rename from ${path}`, `rename to ${to}`);
  head.push(`--- ${opts.isNew ? '/dev/null' : `a/${path}`}`, `+++ ${opts.isDeleted ? '/dev/null' : `b/${to}`}`);
  return [...head, ...hunks].join('\n');
}
