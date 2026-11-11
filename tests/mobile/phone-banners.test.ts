// #90 on a phone: the reconnect pill (and the omp banner in the same spot) must not cover the chat sheet's header,
// and the composer must say it is offline (its key hints are hidden on touch screens). Checked in health.css, which
// loads after responsive.css / mobile.css and wins on equal selectors. Run: bun test tests/mobile
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const css = readFileSync(join(import.meta.dir, '../../web/src/ui/css/health.css'), 'utf8');

/** The body of the first rule whose selector list contains `selector` (inside any @media). */
function rule(selector: string): string | null {
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    if (m[1].split(',').some((s) => s.trim() === selector)) return m[2];
  }
  return null;
}

/** The @media query a selector's rule sits in. */
function mediaOf(selector: string): string | null {
  const i = css.indexOf(selector);
  const at = css.lastIndexOf('@media', i);
  if (at < 0) return null;
  const open = css.indexOf('{', at);
  return css.slice(at + 6, open).trim();
}

describe('#90 phone: banners and the chat sheet', () => {
  test('offline, an expanded sheet starts below the reconnect pill (not under it)', () => {
    const sel = '.rlt-ui.is-offline:not(.is-kb) .sidepanel.is-expanded';
    expect(rule(sel)).toContain('height: calc(100% - var(--panel-top) - 5.5rem)');
    expect(mediaOf(sel)).toContain('max-width: 820px');
  });
  test('the omp banner gets the same room, by its measured height (--omp-banner-h)', () => {
    expect(rule('.rlt-ui.has-omp-banner:not(.is-offline):not(.is-kb) .sidepanel.is-expanded')).toContain('var(--omp-banner-h');
    expect(rule('.rlt-ui.has-omp-banner:not(.is-offline):not(.is-kb) .sidepanel')).toContain('min(var(--sheet-h)');
  });
  test('a phone held sideways (the panel docks at the side) and the keyboard up are left alone', () => {
    const q = mediaOf('.rlt-ui.is-offline:not(.is-kb) .sidepanel.is-expanded') ?? '';
    expect(q).toContain('min-height: 521px');
    expect(q).toContain('orientation: portrait');
  });
  test('offline, the composer says so on a touch screen too', () => {
    expect(rule('.rlt-ui .composer.is-offline .composer-hint')).toContain('display: block');
    expect(mediaOf('.rlt-ui .composer.is-offline .composer-hint')).toBe('(hover: none)');
  });
});
