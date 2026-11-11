// #26 on phones: up to 430 px (and at 320 px) the providers button gives way — Models and providers is in the More
// menu — except while no AI account is connected: then its "Connect AI" stays in the top bar, since nobody can work
// until one is, and the spend gives way to it instead. The spend button is a plain amount, never a "demo" word.
// Stylesheet and source checks (no DOM).
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mediaRules, readCss } from '../helpers/css-rules';

const PHONE = '26.875em';
const SE = '22.4375em';
const topbarTs = () => readFileSync(resolve(import.meta.dir, '../../web/src/ui/topbar.ts'), 'utf8');

describe('"Connect AI" on a phone top bar', () => {
  for (const bp of [PHONE, SE]) {
    test(`at ${bp} the providers button hides only when it isn't asking to connect`, () => {
      const hides = mediaRules(readCss('mobile.css'), bp).filter(([, body]) => /display:\s*none/.test(body));
      // the rules that hide the providers button itself (not the ones that only ask whether it shows: :has(…))
      const sels = hides.flatMap(([sel]) => sel.split(',').map((x) => x.trim())).filter((x) => /\.tb-providers\b/.test(x) && !x.includes(':has('));
      expect(sels.length).toBeGreaterThan(0);
      for (const sel of sels) expect(sel).toContain('.tb-providers:not(.is-none)');
    });
  }

  test('up to 430 px the spend gives way to "Connect AI" (More → Spend), so the city switcher keeps its name and dot', () => {
    const hides = mediaRules(readCss('mobile.css'), PHONE).filter(([, body]) => /display:\s*none/.test(body));
    const sels = hides.flatMap(([sel]) => sel.split(',').map((x) => x.trim()));
    expect(sels).toContain('.rlt-ui .tb-right:has(.tb-providers.is-none) .tb-cost');
    expect(topbarTs()).toContain("!shown(cost) ? { label: 'Spend'");
  });

  test('the top bar gives the providers button its tone as a class (is-none while nothing is connected)', () => {
    const src = topbarTs();
    expect(src).toContain("providers.className = ['tb-btn', 'tb-providers', `is-${tone}`].join(' ')");
    expect(src).toContain("tone === 'none' ? 'No AI account connected yet — connect one so people can work'");
  });

  test('"Connect AI" is amber like a warning, not green', () => {
    const css = readCss('topbar.css');
    expect(css).toMatch(/\.tb-providers\.is-none\s*\{[^}]*color:\s*var\(--sun-text\)/);
    expect(css).toMatch(/\.tb-providers\.is-none \.prov-dot\s*\{[^}]*background:\s*var\(--sun\)/);
  });
});

describe('the spend button is a plain amount', () => {
  test('no demo class, word or $0-demo copy in the top bar', () => {
    const src = topbarTs();
    expect(src).not.toMatch(/is-demo|tb-cost-demo|\bdemo\b/i);
    expect(src).toContain('cost.title = `Spent this session: ${fmtUsd(total)}`');
    expect(src).toContain("h('span', null, 'Spend this session')");
    const css = readCss('topbar.css') + readCss('mobile.css');
    expect(css).not.toMatch(/is-demo|tb-cost-demo|cost-note/);
  });
});
