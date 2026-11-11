// Review verdicts: the reply of a `review` step ends with ```json {"verdict":"approve"|"revise","notes":"…"} ```.
// Parsing is lenient about the wrapper (fence language, trailing prose) and verdict synonyms.

export interface Verdict {
  verdict: 'approve' | 'revise';
  notes: string;
}

const APPROVE = /^(approve|approved|accept|accepted|lgtm|pass|ok|ship)$/i;
const REVISE = /^(revise|revision|changes[_ -]?requested|request[_ -]?changes|needs[_ -]?changes|reject|rejected|fail)$/i;

function fromObject(o: unknown): Verdict | null {
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  const v = typeof r.verdict === 'string' ? r.verdict.trim() : '';
  const verdict = APPROVE.test(v) ? 'approve' : REVISE.test(v) ? 'revise' : null;
  if (!verdict) return null;
  let notes = [r.notes, r.summary, r.explanation].find((x) => typeof x === 'string' && x.trim()) as string | undefined;
  if (!notes && Array.isArray(r.issues)) {
    notes = r.issues
      .map((i) => (typeof i === 'string' ? i : (i as { message?: string })?.message ?? ''))
      .filter(Boolean)
      .join('\n');
  }
  return { verdict, notes: (notes ?? '').trim() };
}

/** Balanced `{…}` substrings that mention "verdict", last first. */
function bareObjects(text: string): string[] {
  const out: string[] = [];
  let idx = text.lastIndexOf('"verdict"');
  while (idx >= 0) {
    const start = text.lastIndexOf('{', idx);
    if (start < 0) break;
    let depth = 0;
    let inStr = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (c === '\\') i++;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        out.push(text.slice(start, i + 1));
        break;
      }
    }
    idx = text.lastIndexOf('"verdict"', start - 1);
  }
  return out;
}

export function parseVerdict(text: string): Verdict | null {
  const fences = [...text.matchAll(/```[a-zA-Z]*\s*\n([\s\S]*?)```/g)].map((m) => m[1]).reverse();
  for (const body of [...fences, ...bareObjects(text)]) {
    try {
      const v = fromObject(JSON.parse(body.trim()));
      if (v) return v;
    } catch {
      /* not JSON — try the next candidate */
    }
  }
  return null;
}
