// A phone with the chat sheet half open: an ask's floating card shows only its questions (the answers wait in the
// chat, behind its Answer button). A choice whose options have descriptions draws them as the same .ask-opts rows,
// but it has no Answer button — hiding every .ask-opts there left that card with no way to answer. Checked in
// responsive.css. Run: bun test tests/mobile
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const css = readFileSync(join(import.meta.dir, '../../web/src/ui/css/responsive.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Every selector of the rules whose body hides the element (display: none). */
function hidden(): string[] {
  const out: string[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    if (/display:\s*none/.test(m[2])) out.push(...m[1].split(',').map((s) => s.trim()));
  }
  return out;
}

describe('phone, chat sheet half open: the floating question card', () => {
  test('an ask hides its options there (Answer opens the whole card in the chat)', () => {
    expect(hidden()).toContain('.rlt-ui.has-panel .approval-stack .approval-ask .ask-opts');
  });
  test('a described choice keeps its options: they are its only answers there', () => {
    expect(hidden().filter((s) => s.endsWith('.ask-opts') && !s.includes('.approval-ask'))).toEqual([]);
  });
});
