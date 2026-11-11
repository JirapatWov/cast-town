// Small fuzzy matcher: subsequence match with bonuses for word starts and consecutive runs.

export interface FuzzyResult {
  score: number;
  indices: number[];
}

const isBoundary = (text: string, i: number) => i === 0 || /[\s\-_/.›·:]/.test(text[i - 1]) || (/[a-z]/.test(text[i - 1]) && /[A-Z]/.test(text[i]));

export function fuzzy(query: string, text: string): FuzzyResult | null {
  const q = query.trim().toLowerCase();
  if (!q) return { score: 0, indices: [] };
  const t = text.toLowerCase();

  // Contiguous substring wins outright.
  const sub = t.indexOf(q);
  if (sub >= 0) {
    const indices = Array.from({ length: q.length }, (_, k) => sub + k);
    return { score: 1000 - sub * 2 + (isBoundary(text, sub) ? 200 : 0) - t.length * 0.5, indices };
  }

  const indices: number[] = [];
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const ch of q) {
    if (ch === ' ') continue;
    const found = t.indexOf(ch, ti);
    if (found < 0) return null;
    indices.push(found);
    score += 10;
    if (found === prev + 1) score += 15;
    if (isBoundary(text, found)) score += 25;
    score -= Math.min(10, found - ti);
    prev = found;
    ti = found + 1;
  }
  return { score: score - t.length * 0.3, indices };
}

/** Wrap matched characters in <mark>. Returns DOM nodes (text is never parsed as HTML). */
export function highlight(text: string, indices: number[]): Node[] {
  if (!indices.length) return [document.createTextNode(text)];
  const set = new Set(indices);
  const out: Node[] = [];
  let buf = '';
  let inMark = false;
  const flush = () => {
    if (!buf) return;
    if (inMark) {
      const m = document.createElement('mark');
      m.textContent = buf;
      out.push(m);
    } else out.push(document.createTextNode(buf));
    buf = '';
  };
  for (let i = 0; i < text.length; i++) {
    const hit = set.has(i);
    if (hit !== inMark) {
      flush();
      inMark = hit;
    }
    buf += text[i];
  }
  flush();
  return out;
}
