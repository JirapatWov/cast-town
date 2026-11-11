// CAST brand: the app's name and its "Open House" mark, in one place. The server's own pages (server/pages.ts) and the
// web app (top bar, onboarding, tab title) import them. Static files can't import, so web/index.html (boot screen,
// favicon links) and web/public/ (favicon.svg, the PNG icons, manifest.webmanifest) hold copies — change them together.
//
// The mark is a house with its front wall taken away: roof, back wall and floor read as a C, and it is the cut-away
// view the app shows every house in. The warm dot inside is someone at home with the lights on. In the wordmark the A
// is a roof with the same dot under it.
//
// The app was called Real Life Terminal (RLT). Internal ids keep that prefix — RLT_* env vars, the rlt_token cookie,
// rlt.* storage keys, .rlt/ folders, refs/rlt/*, window.__rlt, [rlt-role:…], "[RLT team update]": renaming them would
// log paired browsers out, reset preferences and orphan runs. Only what a person reads says CAST.

export const APP_NAME = 'CAST';
export const TAGLINE = 'A little town where your AI cast lives and works.';

/** Ink and the "lights on" dot, for dark surfaces (the app) and light ones; the dark tile of the app icon. */
export const BRAND_COLORS = {
  ink: '#F4F1EC',
  sun: '#F5C26B',
  inkOnLight: '#1B1A18',
  sunOnLight: '#E0932A',
  tile: '#17140F',
} as const;

const NS = 'xmlns="http://www.w3.org/2000/svg"';
const LINE = 'fill="none" stroke-linecap="round" stroke-linejoin="round"';

/** The house outline (64-unit box, stroke 9) and its lit window. */
const HOUSE_PATH = 'M51.5 25 31 9 11.5 24.5v21a9 9 0 0 0 9 9H52';
function house(ink: string, sun: string): string {
  return `<path d="${HOUSE_PATH}" ${LINE} stroke="${ink}" stroke-width="9"/><circle cx="37.5" cy="40.5" r="6.75" fill="${sun}"/>`;
}

// Wordmark letters: monoline geometric caps on a 146×48 box (stroke 7, ink y 4…44).
const C = 'M33.67 12.33A16.5 16.5 0 1 0 33.67 35.67';
const A_ROOF = 'M41 40.5 54 7.5 67 40.5';
const S = 'M100.6 11.02A10.5 8.25 0 1 0 92 24 10.5 8.25 0 1 1 83.4 36.98';
const T = 'M113.5 7.5h26M126.5 7.5v33';

export interface MarkOptions {
  ink?: string;
  sun?: string;
  /** width and height in px (the wordmark: its height); left out, CSS sizes it */
  size?: number;
  /** class on the <svg> */
  cls?: string;
}

function attrs(o: MarkOptions, w: number, h: number): string {
  const size = o.size ? ` width="${round((o.size * w) / h)}" height="${o.size}"` : '';
  return `${o.cls ? ` class="${o.cls}"` : ''}${size} aria-hidden="true" focusable="false"`;
}
const round = (n: number) => Math.round(n * 100) / 100;

/** The mark alone (decorative: label its button or heading instead). Defaults suit dark surfaces. */
export function markSvg(o: MarkOptions = {}): string {
  return `<svg ${NS} viewBox="0 0 64 64"${attrs(o, 64, 64)}>${house(o.ink ?? BRAND_COLORS.ink, o.sun ?? BRAND_COLORS.sun)}</svg>`;
}

/** "CAST" in the brand's letters (decorative: put the name in text beside it for screen readers). */
export function wordmarkSvg(o: MarkOptions = {}): string {
  const ink = o.ink ?? BRAND_COLORS.ink;
  const sun = o.sun ?? BRAND_COLORS.sun;
  return (
    `<svg ${NS} viewBox="0 0 146 48"${attrs(o, 146, 48)}><g ${LINE} stroke="${ink}" stroke-width="7">` +
    `<path d="${C}"/><path d="${A_ROOF}"/><path d="${S}"/><path d="${T}"/></g>` +
    `<circle cx="54" cy="30.5" r="4.7" fill="${sun}"/></svg>`
  );
}

/** The favicon / app-icon form: the mark on the dark town tile, fixed colours, so it reads on light and dark tab bars.
 *  Same picture as web/public/favicon.svg. */
export const FAVICON_SVG =
  `<svg ${NS} viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${BRAND_COLORS.tile}"/>` +
  `<rect x=".5" y=".5" width="63" height="63" rx="13.5" fill="none" stroke="rgba(255,255,255,.10)"/>` +
  `<g transform="translate(5.76 5.76) scale(.82)">${house(BRAND_COLORS.ink, BRAND_COLORS.sun)}</g></svg>`;

/** The mark full-bleed on the tile colour (no rounded corners: iOS and Android round them themselves), the mark
 *  `scale` of the square — for the PNG app icons in web/public. */
export function fullBleedIconSvg(scale: number): string {
  const off = round(32 - 32 * scale);
  return `<svg ${NS} viewBox="0 0 64 64"><rect width="64" height="64" fill="${BRAND_COLORS.tile}"/><g transform="translate(${off} ${off}) scale(${scale})">${house(BRAND_COLORS.ink, BRAND_COLORS.sun)}</g></svg>`;
}
