// #88: in the narrow chat bar (the 420 px desktop panel) the chat's title gets the room and New chat shrinks to its
// icon. New chat carries two labels ("New chat" and the phone's "New"); hiding only the last span left "New chat" in a
// 2 rem button, where it spilled out of the bar ("New ch" cut at the panel edge).
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CSS = join(import.meta.dir, '../../web/src/ui/css');
const read = (f: string) => readFileSync(join(CSS, f), 'utf8');

/** The body of the first block that starts with `head` (balanced braces). */
function block(css: string, head: string): string {
  const at = css.indexOf(head);
  if (at < 0) throw new Error(`no block ${head}`);
  let i = css.indexOf('{', at);
  const start = i + 1;
  for (let depth = 1; depth > 0; ) {
    i++;
    if (css[i] === '{') depth++;
    else if (css[i] === '}') depth--;
  }
  return css.slice(start, i);
}

/** Selectors of the rules in `body` that set display: none. */
function hidden(body: string): string[] {
  return [...body.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => /display:\s*none/.test(m[2])).flatMap((m) => m[1].split(',').map((s) => s.trim()));
}

describe('narrow chat bar (#88)', () => {
  test('the desktop panel bar hides the long "New chat" label, not only the last span', () => {
    const sel = hidden(block(read('jobs.css'), '@container thread-bar (max-width: 560px)'));
    expect(sel.some((s) => s.includes('.thread-new-long'))).toBe(true);
  });
  test('small screens do the same', () => {
    const sel = hidden(block(read('chat.css'), '@media (max-width: 480px)'));
    expect(sel.some((s) => s.includes('.thread-new-long'))).toBe(true);
  });
  test('the thread bar still renders both labels (the phone keeps "New")', () => {
    const src = readFileSync(join(import.meta.dir, '../../web/src/ui/thread-bar.ts'), 'utf8');
    expect(src).toContain("'thread-new-long'");
    expect(src).toContain("'thread-new-short'");
  });
});
