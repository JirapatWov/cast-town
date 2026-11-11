// Text helpers of the built-in viewer (pure, no DOM): CSV/TSV parsing and splitting highlighted code into lines.
import { escapeHtml } from './dom';

export interface Table {
  rows: string[][]; // the first row is the header
  /** More rows followed (not parsed). */
  more: boolean;
}

/** RFC 4180-ish: quoted fields ("" inside quotes is one quote, quotes may hold the delimiter and newlines), CRLF or
 *  LF. Stops after maxRows rows (header included). */
export function parseDelimited(text: string, delimiter = ',', maxRows = 1001): Table {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const n = text.length;
  const endRow = () => {
    row.push(field);
    field = '';
    rows.push(row);
    row = [];
  };
  if (text.charCodeAt(0) === 0xfeff) i = 1; // BOM
  while (i < n) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"' && field === '') {
      quoted = true;
      i++;
      continue;
    }
    if (c === delimiter) {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (c === '\r' || c === '\n') {
      endRow();
      if (c === '\r' && text[i + 1] === '\n') i++;
      i++;
      if (rows.length >= maxRows) return { rows, more: i < n };
      continue;
    }
    field += c;
    i++;
  }
  if (field !== '' || row.length) endRow();
  return { rows, more: false };
}

/** Guess a delimited file's delimiter from its first line (comma, tab, semicolon or pipe). */
export function sniffDelimiter(text: string, fallback = ','): string {
  const first = text.slice(0, text.search(/\r?\n/) === -1 ? 4096 : text.search(/\r?\n/));
  let best = fallback;
  let most = 0;
  for (const d of [',', '\t', ';', '|']) {
    const count = first.split(d).length - 1;
    if (count > most) {
      most = count;
      best = d;
    }
  }
  return best;
}

/** Split highlight.js HTML into one HTML string per line: a span left open at a newline (a multi-line comment or
 *  string) is closed at the end of the line and opened again on the next, so each line is well-formed on its own. */
export function splitHighlightedLines(html: string): string[] {
  const lines: string[] = [];
  const open: string[] = []; // opening tags still open
  let cur = '';
  const re = /<span[^>]*>|<\/span>|\n|[^<\n]+|</g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const tok = m[0];
    if (tok === '\n') {
      cur += '</span>'.repeat(open.length);
      lines.push(cur);
      cur = open.join('');
    } else if (tok.startsWith('<span')) {
      open.push(tok);
      cur += tok;
    } else if (tok === '</span>') {
      open.pop();
      cur += tok;
    } else cur += tok;
  }
  lines.push(cur + '</span>'.repeat(open.length));
  return lines;
}

/** Plain text as escaped HTML lines. */
export function plainLines(text: string): string[] {
  return text.split(/\r?\n/).map(escapeHtml);
}

/** The text a viewer shows: drop one trailing newline (so a file ending in "\n" has no empty last line). */
export function trimFinalNewline(text: string): string {
  return text.endsWith('\r\n') ? text.slice(0, -2) : text.endsWith('\n') ? text.slice(0, -1) : text;
}

/** Whether bytes decoded as UTF-8 look like text (no NUL in the first 8 KB, few replacement characters). */
export function looksLikeText(text: string): boolean {
  const head = text.slice(0, 8192);
  if (head.includes('\0')) return false;
  const bad = head.split('�').length - 1;
  return bad <= Math.max(2, head.length / 200);
}
