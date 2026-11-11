// The run strip after a team run: "Completed" joins the strip and its chips were squeezed under it — first drawn over
// the status ("ReviewCompleted"), then (with the chips box clipping) cut to "D.", "I." and a bare "R", or to nothing
// at 1100 px, where the cost ran off the strip's edge. runstrip.ts now measures and steps down: the cost, a finished
// run's clock and round count go and names get shorter (is-snug), then only the dots stay, as on a phone (is-compact).
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readCss } from '../helpers/css-rules';

const strip = readFileSync(join(import.meta.dir, '../../web/src/ui/runstrip.ts'), 'utf8');
const css = readCss('topbar.css');
const rule = (sel: RegExp) => [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].find((m) => sel.test(m[1]!.trim()))?.[2] ?? '';

describe('run strip fit', () => {
  test('fits after every render and when the room changes', () => {
    expect(strip).toMatch(/watchRoom\(\);\s*fit\(\);/);
    expect(strip).toContain('new ResizeObserver(() => requestAnimationFrame(fit))');
  });
  test('counts squeezed names as not fitting (the chips shrink, they do not overflow)', () => {
    expect(strip).toMatch(/overflows\(el\) \|\| overflows\(el\.querySelector\('\.rs-chips'\)\) \|\| \[\.\.\.el\.querySelectorAll<HTMLElement>\('\.rs-name'\)\]\.some/);
    expect(strip).toMatch(/el\.classList\.add\('is-snug'\);\s*if \(tight\(\)\) el\.classList\.add\('is-compact'\);/);
  });
  test('snug: the cost, a finished run’s clock and round count go; names are capped (ellipsis)', () => {
    expect(rule(/\.runstrip\.is-snug \.rs-cost,\s*\.rlt-ui \.runstrip\.is-snug:is\(\.run-completed, \.run-failed, \.run-aborted\) :is\(\.rs-time, \.rs-loop\)$/)).toMatch(/display:\s*none/);
    expect(rule(/\.runstrip\.is-snug \.rs-name$/)).toMatch(/max-width:\s*[\d.]+rem/);
    expect(rule(/^\.rlt-ui \.rs-name$/)).toMatch(/text-overflow:\s*ellipsis/);
  });
  test('compact: names go, the dots stay', () => {
    expect(rule(/\.runstrip\.is-compact \.rs-name$/)).toMatch(/display:\s*none/);
  });
  // a window about half a screen wide (1000 px) squeezed the compact strip to a 30 px sliver showing "C"
  test('no room even when compact (the strip itself overflows): it gives way, and comes back with the room', () => {
    expect(strip).toMatch(/if \(el\.classList\.contains\('is-compact'\) && overflows\(el\)\) el\.classList\.add\('is-gone'\);/);
    expect(strip).toContain("el.classList.remove('is-snug', 'is-compact', 'is-gone');");
    expect(rule(/\.runstrip\.is-gone$/)).toMatch(/visibility:\s*hidden/);
  });
});
