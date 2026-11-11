// #8: CAST must start with no internet at all — no font CDN in any page it serves, and every self-hosted font the
// CSS names is really there.
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { renderPage } from '../../server/pages';

const ROOT = join(import.meta.dir, '../..');
const FONTS = join(ROOT, 'web/public/fonts');
const CDN = /fonts\.(googleapis|gstatic)\.com/;

describe('self-hosted fonts', () => {
  test('the app shell and the UI never reference a font CDN', () => {
    expect(readFileSync(join(ROOT, 'web/index.html'), 'utf8')).not.toMatch(CDN);
    expect(readFileSync(join(ROOT, 'web/src/ui/index.ts'), 'utf8')).not.toMatch(CDN);
  });

  test("the server's own pages (403, placeholder) do not either", () => {
    expect(renderPage({ title: 't', heading: 'h', lead: 'l' })).not.toMatch(CDN);
  });

  test('every @font-face file exists, uses swap, and is a woff2', () => {
    const css = readFileSync(join(FONTS, 'fonts.css'), 'utf8');
    const faces = css.match(/@font-face\s*{[^}]*}/g) ?? [];
    expect(faces.length).toBeGreaterThanOrEqual(3);
    for (const f of faces) {
      expect(f).toContain('font-display: swap');
      const url = /url\('\/fonts\/([^']+)'\)/.exec(f)?.[1];
      expect(url).toBeTruthy();
      expect(existsSync(join(FONTS, url!))).toBe(true);
      expect(readFileSync(join(FONTS, url!)).subarray(0, 4).toString('latin1')).toBe('wOF2');
    }
    for (const family of ['Inter', 'JetBrains Mono', 'IBM Plex Sans Thai']) expect(css).toContain(`'${family}'`);
  });

  test('the licence travels with the files', () => {
    const files = readdirSync(FONTS);
    expect(files).toContain('OFL.txt');
    expect(readFileSync(join(FONTS, 'OFL.txt'), 'utf8')).toContain('SIL OPEN FONT LICENSE Version 1.1');
  });

  test('the preloaded font is one the CSS declares', () => {
    const html = readFileSync(join(ROOT, 'web/index.html'), 'utf8');
    const pre = /<link rel="preload" href="\/fonts\/([^"]+)" as="font"/.exec(html)?.[1];
    expect(pre).toBeTruthy();
    expect(readFileSync(join(FONTS, 'fonts.css'), 'utf8')).toContain(`/fonts/${pre}`);
  });
});

describe('fonts in the built page (base ./, cities under /city/<id>/)', () => {
  test('the stylesheet is inlined and the preload stays root-relative, like the @font-face urls', async () => {
    const { inlineFontsHtml } = await import('../../web/inline-fonts.ts');
    // what Vite hands over for base './': public URLs made relative
    const built = [
      '<link rel="preload" href="./fonts/inter-latin-var.woff2" as="font" type="font/woff2" crossorigin />',
      '<link rel="stylesheet" href="./fonts/fonts.css" data-rlt-fonts />',
      '<link rel="icon" href="./favicon.svg" />',
    ].join('\n');
    const css = readFileSync(join(FONTS, 'fonts.css'), 'utf8');
    const out = inlineFontsHtml(built, css);
    expect(out).toContain('<style data-rlt-fonts>');
    expect(out).not.toContain('fonts.css');
    expect(out).toContain('<link rel="preload" href="/fonts/inter-latin-var.woff2"');
    expect(out).toContain('href="./favicon.svg"'); // the rest stays as Vite made it
    expect(css).toContain("url('/fonts/inter-latin-var.woff2')"); // the file the preload fetches is the one used
    // dev serves the source page as is: the root-relative link is inlined too
    expect(inlineFontsHtml('<link rel="stylesheet" href="/fonts/fonts.css" data-rlt-fonts />', css)).toContain('<style data-rlt-fonts>');
  });
});
