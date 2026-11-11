// #49 follow-up: on a phone the viewer's bar fits. With the 44 px touch targets the full row (view switch, A−/A+,
// Reload, Open in new tab, Download, Copy path) was 446 px wide — wider than an iPhone 13's 376 px bar, so Copy path
// sat half off the screen, and a 320 px phone hid three actions behind a sideways scroll nobody could see. On a phone
// those four move into a More menu; a desktop keeps them in the bar.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const css = readFileSync(join(import.meta.dir, '../../web/src/ui/css/viewer.css'), 'utf8');
const src = readFileSync(join(import.meta.dir, '../../web/src/ui/file-viewer.ts'), 'utf8');

/** The body of the first block that starts with `head` (balanced braces). */
function block(text: string, head: string): string {
  const at = text.indexOf(head);
  if (at < 0) throw new Error(`no block ${head}`);
  let i = text.indexOf('{', at);
  const start = i + 1;
  for (let depth = 1; depth > 0; ) {
    i++;
    if (text[i] === '{') depth++;
    else if (text[i] === '}') depth--;
  }
  return text.slice(start, i);
}

/** Selector → display for the plain rules in `body` (comments dropped). */
function displays(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of body.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const d = /display:\s*([\w-]+)/.exec(m[2])?.[1];
    if (d) for (const s of m[1].split(',')) out.set(s.trim(), d);
  }
  return out;
}

const topLevel = css.slice(0, css.indexOf('@media')); // the bar's own rules come before the media blocks
const phone = displays(block(css, '@media (max-width: 820px)'));

describe('viewer bar on a phone (#49)', () => {
  test('a desktop hides More', () => {
    expect(displays(topLevel).get('.rlt-ui .vw-actions .vw-more')).toBe('none');
  });
  test('a phone hides the four extras and shows More', () => {
    expect(phone.get('.rlt-ui .vw-actions .vw-extra')).toBe('none');
    expect(phone.get('.rlt-ui .vw-actions .vw-more')).not.toBe('none');
  });
  test('Reload, Open in new tab, Download and Copy path are the extras, and More offers each of them', () => {
    for (const name of ['reloadBtn', 'newTab', 'download', 'copyBtn']) {
      const decl = new RegExp(`const ${name} = [^\\n]*vw-extra`);
      expect(decl.test(src)).toBe(true);
      expect(src).toContain(`if (!${name}.hidden) items.push(`);
    }
    expect(src).toMatch(/class: 'icon-btn vw-more'/);
  });
});
