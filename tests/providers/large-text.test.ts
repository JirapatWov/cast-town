// Models & providers with very large text (200 %) on a phone. Seen in the browser (iPhone 13 and iPhone SE): the
// dialog's header — which doesn't scroll — was squeezed to a word per line and grew taller than the screen, leaving
// the cards a strip a few dozen pixels high, and the cards' buttons ran past the card's edge, where it cut them off.
//   - the header wraps (Refresh goes under the title), and once it still takes much of the screen the whole dialog
//     scrolls instead (isTallHead / watchTallHead: the class `is-tall-head`);
//   - inside a card the grids size to the card, and buttons and the connection pill wrap;
//   - none of that shrinks a touch screen's larger buttons (mobile.css gives them 2.75rem);
//   - an other provider's card with no models says so (it used to say they were "listed under their makers").
// No DOM here: the pure test, and the wiring read from the source.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TALL_HEAD_SHARE, isTallHead } from '../../web/src/ui/provider-catalog';

const read = (rel: string) => readFileSync(resolve(import.meta.dir, '../..', rel), 'utf8');
const css = read('web/src/ui/css/providers-list.css');

/** The declarations of the rule whose selector is exactly `selector` (the last one: the overrides come last). */
function rule(source: string, selector: string): string {
  const at = source.lastIndexOf(`${selector} {`);
  if (at < 0) return '';
  return source.slice(at + selector.length + 2, source.indexOf('}', at));
}

describe('a tall header', () => {
  test('counts as tall past its share of the screen (measured: 834 px of 664 on an iPhone 13 at 200 %)', () => {
    expect(TALL_HEAD_SHARE).toBe(0.4);
    expect(isTallHead(834, 664)).toBe(true);
    expect(isTallHead(374, 664)).toBe(true); // wrapped, still over 40 %
    expect(isTallHead(110, 664)).toBe(false); // the same phone at normal text
    expect(isTallHead(176, 568)).toBe(false); // an iPhone SE at normal text
    expect(isTallHead(149, 900)).toBe(false); // a desktop at 200 %
    expect(isTallHead(100, 0)).toBe(false); // not laid out yet
  });

  test('the dialog watches its header while open and stops when it closes', () => {
    const src = read('web/src/ui/providers.ts');
    expect(src).toMatch(/stopHeadWatch = watchTallHead\(dialog\)/);
    const onClose = src.slice(src.indexOf('onClose: () => {'));
    expect(onClose.slice(0, 600)).toContain('stopHeadWatch?.()');
    const list = read('web/src/ui/providers-list.ts');
    expect(list).toMatch(/classList\.toggle\('is-tall-head', isTallHead\(/);
    expect(list).toMatch(/new ResizeObserver\(check\)/);
  });

  test('a tall header scrolls with the dialog; the header wraps rather than squeezing the title', () => {
    expect(rule(css, '.rlt-ui .modal-providers.is-tall-head')).toMatch(/overflow-y:\s*auto/);
    expect(rule(css, '.rlt-ui .modal-providers.is-tall-head .modal-body')).toMatch(/flex:\s*none/);
    expect(rule(css, '.rlt-ui .modal-providers .modal-head')).toMatch(/flex-wrap:\s*wrap/);
    expect(rule(css, '.rlt-ui .modal-providers .modal-titles')).toMatch(/flex:\s*1 1 \d+(\.\d+)?rem/);
  });
});

describe('the cards and the list fit', () => {
  test('a card’s grids size to the card, its buttons and pill wrap', () => {
    expect(rule(css, '.rlt-ui .vendor-card :is(.vendor-accounts, .vendor-connect, .cmd-manual, .signin, .usage-block)')).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\)/);
    const btn = rule(css, '.rlt-ui .vendor-card .btn');
    expect(btn).toMatch(/white-space:\s*normal/);
    expect(btn).toMatch(/height:\s*auto/);
    expect(btn).toMatch(/min-height:\s*2\.25rem/); // the base .btn height, so nothing moves at normal text
    expect(rule(css, '.rlt-ui .vendor-card .btn-sm')).toMatch(/min-height:\s*1\.875rem/);
    expect(rule(css, '.rlt-ui .vendor-head,\n.rlt-ui .usage-head')).toMatch(/flex-wrap:\s*wrap/);
    // a list row too narrow for its tag, pill and button beside the name puts them under it (rem follows the text)
    expect(rule(css, '.rlt-ui .login-row')).toMatch(/container-type:\s*inline-size/);
    const narrow = css.slice(css.indexOf('@container (max-width:'));
    expect(narrow).toMatch(/^@container \(max-width: \d+rem\) \{/);
    expect(narrow).toMatch(/\.rlt-ui \.login-titles,\s*\.rlt-ui \.login-side \{\s*grid-column: 1 \/ -1;/);
    expect(rule(css, '.rlt-ui .login-side :is(.login-kind, .conn-pill)')).toMatch(/white-space:\s*normal/);
    // a percentage here resolved against the list's auto-sized column and wrapped every row on a desktop
    expect(rule(css, '.rlt-ui .login-connect')).toMatch(/min-width:\s*min\(5\.5rem, \d+vw\)/);
  });

  test('a touch screen keeps its 2.75rem buttons (the rules above set a smaller min-height)', () => {
    const mobile = read('web/src/ui/css/mobile.css');
    expect(mobile).toMatch(/@media \(pointer: coarse\)[\s\S]*\.rlt-ui \.btn-sm \{\s*min-height: 2\.75rem;/);
    const coarse = css.slice(css.lastIndexOf('@media (pointer: coarse)'));
    expect(coarse).toMatch(/\.rlt-ui \.vendor-card \.btn,\s*\.rlt-ui \.login-side \.btn \{\s*min-height: 2\.75rem;/);
    // after the rules it overrides, at the same specificity
    expect(css.lastIndexOf('@media (pointer: coarse)')).toBeGreaterThan(css.indexOf('.rlt-ui .vendor-card .btn-sm {'));
    expect(css.lastIndexOf('@media (pointer: coarse)')).toBeGreaterThan(css.indexOf('.rlt-ui .login-side .btn {'));
  });
});

describe('an other provider’s card without models', () => {
  test('says it has none (every model through it would be on its card)', () => {
    const src = read('web/src/ui/providers.ts');
    expect(src).not.toContain('its models are listed under their makers');
    expect(src).toMatch(/o\.models\.length \? null : ' · no models'/);
  });
});
