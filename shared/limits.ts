// Name lengths both sides agree on. The client's inputs stop at them and the server clips to them, so a long folder
// name never comes back as a raw "too long" error (a picked folder's name is set from code, which an input's maxlength
// doesn't stop).

/** A project's (house's) name. */
export const MAX_PROJECT_NAME = 60;

type Segmenter = { segment(s: string): Iterable<{ segment: string }> };
let segmenter: Segmenter | null | undefined;

function graphemes(s: string): string[] {
  if (segmenter === undefined) {
    const Seg = (Intl as unknown as { Segmenter?: new (locale?: string, o?: { granularity: string }) => Segmenter }).Segmenter;
    segmenter = Seg ? new Seg(undefined, { granularity: 'grapheme' }) : null;
  }
  return segmenter ? Array.from(segmenter.segment(s), (x) => x.segment) : Array.from(s);
}

/** `s` trimmed, at most `max` UTF-16 units (what an input's maxlength counts), ending in "…" when it was cut. Never
 *  splits an emoji, a flag or a letter with its accents. */
export function clipName(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  let out = '';
  for (const g of graphemes(t)) {
    if (out.length + g.length > max - 1) break;
    out += g;
  }
  return `${out.trimEnd()}…`;
}
