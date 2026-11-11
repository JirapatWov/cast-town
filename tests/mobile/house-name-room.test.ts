// Phone top bar inside a house: with a "needs you" pill the house name shrank to "t…" (iPhone SE) or vanished
// (iPhone 13, beside the 3D / Board switch). Other items give way first, each still in the More menu: the town view
// switch inside a house on phones up to 430 px, and on a 320 px phone the spend pill while a "needs you" pill shows.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mediaRules, readCss, specificity } from '../helpers/css-rules';

const mobile = readCss('mobile.css');
const hides = (rules: [string, string][], sel: RegExp) => rules.some(([s, body]) => sel.test(s) && /display:\s*none/.test(body));

describe('the house name keeps its room on a phone', () => {
  test('≤ 430 px: inside a house the town view switch gives way', () => {
    const rules = mediaRules(mobile, '26.875em');
    expect(hides(rules, /^\.rlt-ui\[data-view='house'\] \.tb-right \.tb-focus$/)).toBe(true);
    // it beats a11y.css's phone rule that shows the switch (.rlt-ui .tb-focus { display: inline-flex })
    expect(specificity(".rlt-ui[data-view='house'] .tb-right .tb-focus")).toBeGreaterThan(specificity('.rlt-ui .tb-focus'));
  });
  test('≤ 359 px: inside a house a "needs you" pill takes the spend pill’s place', () => {
    const rules = mediaRules(mobile, '22.4375em');
    expect(hides(rules, /^\.rlt-ui\[data-view='house'\] \.tb-right:has\(\.tb-bell\.is-alert\) \.tb-cost$/)).toBe(true);
  });
  test('the More menu offers what gave way (Town board always, Spend whenever the pill is hidden)', () => {
    const src = readFileSync(join(import.meta.dir, '../../web/src/ui/topbar.ts'), 'utf8');
    expect(src).toMatch(/!shown\(cost\) \? \{ label: 'Spend'/);
  });
});
