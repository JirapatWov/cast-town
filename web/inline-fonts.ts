// Build step for index.html (vite.config.ts → inlineFonts): the self-hosted @font-face rules go inline, so the boot
// screen's first paint never waits on a second request, and every /fonts URL stays root-relative.
//
// It runs after Vite has rewritten the page for `base: './'`, which turns /fonts/… into ./fonts/…. For the stylesheet
// that is moot (its rules move inline), but the preload must stay /fonts/…: fonts.css asks for /fonts/… (one shared
// browser cache for every city of a hub, contract C3), and under /city/<id>/ a ./fonts/ preload would fetch a second
// copy that nothing uses.

const STYLESHEET = /<link rel="stylesheet" href="\.?\/fonts\/fonts\.css" data-rlt-fonts \/?>/;
const PRELOAD = /(<link rel="preload" href=")\.\/fonts\//g;

export function inlineFontsHtml(html: string, css: string): string {
  const out = html.replace(PRELOAD, '$1/fonts/');
  if (!STYLESHEET.test(out)) return out;
  return out.replace(STYLESHEET, () => `<style data-rlt-fonts>\n${css.trim()}\n</style>`);
}
