// #12 on phones: a card with a change is taller than the chat, and the chat scrolls to its buttons. The card's head
// (who asks, for what) stays at the top of the chat while the diff scrolls under it, so it has to be sticky there
// and opaque: --attn-head is a slightly see-through gradient, which let the diff show through as a faint ghost.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mediaRules, readCss } from '../helpers/css-rules';

describe('approval head in a phone chat', () => {
  const rule = mediaRules(readCss('mobile.css'), '820px').find(([sel]) => /\.chat-inline-approvals .*\.approval\.has-change .*\.approval-head/.test(sel));

  test('is sticky', () => {
    expect(rule).toBeDefined();
    expect(rule![1]).toMatch(/position:\s*sticky/);
  });

  test('paints the head gradient over an opaque colour', () => {
    const bg = rule![1].match(/background:\s*([^;]+);/)?.[1] ?? '';
    // the last layer is the base colour: a plain rgb() of an opaque token, never rgba() or a lone gradient
    expect(bg).toMatch(/var\(--attn-head\),\s*rgb\(var\(--surface-rgb\)\)$/);
  });
});

// While the card scrolled under its sticky head, the change's file row ("README.md +4 −0") went under the head too, so
// the diff showed without its file name. The row now sticks right under the head (the head's height comes from
// approvals.ts as --apv-head), and the change box clips instead of hiding overflow (overflow: hidden made it a scroll
// box of its own, where position: sticky does nothing).
describe('the change’s file row under the sticky head', () => {
  const rules = mediaRules(readCss('mobile.css'), '820px');
  const fileRow = rules.find(([sel]) => /\.chat-inline-approvals .*\.approval\.has-change .*\.approval-change-head$/.test(sel));
  const box = rules.find(([sel]) => /\.chat-inline-approvals .*\.approval\.has-change .*\.approval-change$/.test(sel));

  test('sticks below the head, offset by the head’s measured height', () => {
    expect(fileRow).toBeDefined();
    expect(fileRow![1]).toMatch(/position:\s*sticky/);
    expect(fileRow![1]).toMatch(/top:\s*calc\(var\(--apv-head, [\d.]+rem\) - 1rem\)/); // the head's own top is -1rem
    expect(fileRow![1]).toMatch(/background:\s*var\(--attn-head\),\s*rgb\(var\(--surface-rgb\)\)/);
  });

  test('its box clips rather than becoming a scroll box', () => {
    expect(box?.[1]).toMatch(/overflow:\s*clip/);
  });

  test('approvals.ts gives a card with a change its head’s height', () => {
    const src = readFileSync(join(import.meta.dir, '../../web/src/ui/approvals.ts'), 'utf8');
    expect(src).toMatch(/new ResizeObserver\(\(\) => card\.style\.setProperty\('--apv-head', `\$\{head\.offsetHeight\}px`\)\)\.observe\(head\)/);
  });
});

// A phone held sideways shows a few lines of chat (iPhone 13: 138 px). There the stuck head covered Approve, Allow and
// Deny where the chat rests (scrolled to its end), so the head and the file row scroll with the card.
describe('a phone held sideways', () => {
  const css = readCss('mobile.css');
  const query = '@media (max-width: 820px) and (max-height: 520px) and (orientation: landscape) {';
  const at = css.indexOf(query);
  let depth = 1;
  let i = at + query.length;
  while (depth && i < css.length) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') depth--;
    i++;
  }
  const rules = [...css.slice(at + query.length, i - 1).matchAll(/([^{}]+)\{([^}]*)\}/g)].map((r) => [r[1]!.trim(), r[2]!] as const);
  test('unsticks the approval head and the change’s file row', () => {
    expect(at).toBeGreaterThan(css.indexOf('.chat-inline-approvals .approval.has-change .approval-head')); // later: it wins
    for (const part of ['.approval-head', '.approval-change-head']) {
      const rule = rules.find(([sel]) => sel.split(',').some((s) => s.trim() === `.rlt-ui .chat-inline-approvals .approval.has-change ${part}`));
      expect(rule?.[1]).toMatch(/position:\s*static/);
    }
  });
});
