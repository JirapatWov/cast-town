// iOS launch images (apple-touch-startup-image). Without them the Home Screen app shows a blank screen from the tap
// on its icon until the page first paints; with them iOS shows the splash's first frame instead — the CAST mark alone,
// its lamp dim, centred on the screen, on the splash background — so the launch flows into the boot screen
// (web/index.html #boot) with no flash and no jump. One PNG per screen size, and the <link> tags for web/index.html's
// <head>. The committed set is ONE dark set for every appearance: the installed app's splash starts at night for
// everyone (data-launch="night"; on the light theme the morning comes after), so a light launch image would flash
// light → night → light.
//
//   bun tools/splash/launch-images.ts --dark-only           (what made the committed set: web/public/splash/*.png and
//                                                            the <head> block)
//   bun tools/splash/launch-images.ts --mark 96 --lamp 0.32 --dark-bg '#0e0d0c' --light-bg '#f1ece4'
//
//   --dark-only        one dark image per screen, its media query without (prefers-color-scheme: …); without it, a
//                      dark and a light image per screen, picked by the device's appearance
//   --mark N           the mark's box (the 64-unit viewBox of shared/brand.ts markSvg) in CSS px; default 96
//   --lamp A           the lamp's opacity, 0 (unlit, not drawn) … 1 (lit); default 0.32 (dim: .boot-ember in index.html)
//   --dark-bg, --light-bg    the background of each theme; default: the --boot-bg tokens of web/index.html
//   --dark-ink, --dark-sun, --light-ink, --light-sun   the mark's colours; default: shared/brand.ts BRAND_COLORS
//
// Rerun it whenever the splash's first frame changes (its background, the mark's size, the lamp) and commit the PNGs
// with web/index.html: the old files are removed, the block between <!-- launch-images --> and <!-- /launch-images -->
// is rewritten. tests/repo/launch-images.test.ts checks that the two agree.
//
// No dependencies, so anyone can rerun it: the mark's geometry is read from markSvg() and rasterised from its distance
// field (the house outline is a round-capped, round-joined stroke = every point within half the stroke width of its
// path; the lamp is a disc), with a one-pixel anti-aliased edge — what a browser draws. PNGs are 8-bit palette images
// (the background, the background→ink and background→lamp ramps) deflated by node:zlib: a few KB each.
//
// iOS picks the image whose media query matches the screen exactly (CSS size, pixel ratio, orientation), so every
// screen size needs its own file; a screen with no match (an iPad window in Split View, a future size) shows the blank
// screen as before. iPhones launch in portrait, iPads in either. Dark or light is the media query's last term,
// (prefers-color-scheme: …): the device's appearance, not CAST's Settings → Theme. Apple documents none of this; by
// every report iOS reads the links when the app is added to the Home Screen and keeps what it picked then, so a new
// image (or a changed appearance) may show only once the app is removed and added again.
// Screen sizes (points × scale): https://screen-size-checker.pages.dev/devices/iphone-viewport-sizes and
// …/ipad-viewport-sizes (data of 2026-09-24), and Apple's iPhone 17e specs (the 16e's 1170×2532 panel). They cover
// every iPhone and iPad that runs iOS / iPadOS 18 or later, and a few older ones.
import { deflateSync } from 'node:zlib';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BRAND_COLORS, markSvg } from '../../shared/brand';
import { launchImages, linkTags, SCREENS, type LaunchImage, type Scheme } from '../../shared/launch-images';

// the list of screens and images lives in shared/ (the server serves the committed set before sign-in and links it
// from the 403 page); the tool and its test use it from here as before
export * from '../../shared/launch-images';

const ROOT = resolve(import.meta.dir, '../..');
export const INDEX_HTML = join(ROOT, 'web/index.html');
export const OUT_DIR = join(ROOT, 'web/public/splash');
// ── colours ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type RGB = [number, number, number];

export function hex(c: string): RGB {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c.trim());
  if (!m) throw new Error(`not a #rgb / #rrggbb colour: ${c}`);
  const h = m[1].length === 3 ? [...m[1]].map((x) => x + x).join('') : m[1];
  return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16)) as RGB;
}

/** a → b by t, per 8-bit sRGB channel (as browsers blend). */
function mix(a: RGB, b: RGB, t: number): RGB {
  return [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t)) as RGB;
}

/** The splash's dim lamp in its first frame: the opacity of web/index.html's `.boot-mark .boot-ember` rule. */
export function splashLamp(html: string): number | undefined {
  const m = /\.boot-ember\s*\{[^}]*?opacity:\s*([\d.]+)/.exec(html);
  return m ? Number(m[1]) : undefined;
}

/** The splash background of each theme: the --boot-bg tokens of web/index.html (`:root` and the light theme's rule). */
export function splashBackgrounds(html: string): Record<Scheme, string> {
  const block = (sel: RegExp) => {
    const m = sel.exec(html);
    const bg = m ? /--boot-bg:\s*(#[0-9a-f]{3,6})\b/i.exec(m[1])?.[1] : undefined;
    return bg?.toLowerCase();
  };
  const dark = block(/:root\s*\{([^}]*)\}/);
  const light = block(/:root\[data-theme='light'\]\s*\{([^}]*)\}/);
  if (!dark || !light) throw new Error('web/index.html: no --boot-bg in :root and :root[data-theme=\'light\'] — pass --dark-bg and --light-bg');
  return { dark, light };
}

// ── the mark ─────────────────────────────────────────────────────────────────────────────────────────────────────

type Pt = [number, number];

/** The mark in its 64-unit box: the house outline as line segments, its stroke width, and the lamp. */
export interface MarkGeometry {
  segments: [Pt, Pt][];
  stroke: number;
  lamp: { cx: number; cy: number; r: number };
}

/** Reads the mark from markSvg(): one round-capped path and one circle. */
export function markGeometry(svg = markSvg()): MarkGeometry {
  const path = /<path d="([^"]+)"([^>]*)>/.exec(svg);
  const circle = /<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/.exec(svg);
  const stroke = path && /stroke-width="([\d.]+)"/.exec(path[2]);
  if (!path || !circle || !stroke || !/stroke-linecap="round"/.test(path[2]) || !/stroke-linejoin="round"/.test(path[2])) {
    throw new Error('shared/brand.ts markSvg() is no longer one round path and one circle: update markGeometry()');
  }
  return {
    segments: flatten(path[1]),
    stroke: Number(stroke[1]),
    lamp: { cx: Number(circle[1]), cy: Number(circle[2]), r: Number(circle[3]) },
  };
}

/** An SVG path (M L H V A Z, absolute or relative) as line segments; arcs become 64 chords each. */
export function flatten(d: string): [Pt, Pt][] {
  const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) ?? [];
  const segs: [Pt, Pt][] = [];
  let i = 0;
  let cmd = '';
  let cur: Pt = [0, 0];
  let start: Pt = [0, 0];
  const num = () => {
    const t = tokens[i++];
    if (t === undefined || /[a-z]/i.test(t)) throw new Error(`path: a number expected in ${d}`);
    return Number(t);
  };
  const line = (to: Pt) => {
    segs.push([cur, to]);
    cur = to;
  };
  while (i < tokens.length) {
    if (/[a-z]/i.test(tokens[i])) cmd = tokens[i++];
    const rel = cmd === cmd.toLowerCase();
    const [ox, oy] = rel ? cur : [0, 0];
    switch (cmd.toUpperCase()) {
      case 'M':
        cur = start = [ox + num(), oy + num()];
        cmd = rel ? 'l' : 'L'; // more pairs after a moveto are linetos
        break;
      case 'L':
        line([ox + num(), oy + num()]);
        break;
      case 'H':
        line([(rel ? cur[0] : 0) + num(), cur[1]]);
        break;
      case 'V':
        line([cur[0], (rel ? cur[1] : 0) + num()]);
        break;
      case 'A': {
        const rx = num(), ry = num(), rot = num(), large = num(), sweep = num();
        const to: Pt = [ox + num(), oy + num()];
        for (const p of arcPoints(cur, to, rx, ry, rot, !!large, !!sweep, 64)) line(p);
        break;
      }
      case 'Z':
        line(start);
        break;
      default:
        throw new Error(`path: command ${cmd} is not supported`);
    }
  }
  return segs;
}

/** Points along an SVG elliptical arc (endpoint form, SVG 1.1 F.6.5), the start point excluded. */
function arcPoints(p0: Pt, p1: Pt, rx: number, ry: number, rotDeg: number, large: boolean, sweep: boolean, n: number): Pt[] {
  if (!rx || !ry) return [p1];
  const phi = (rotDeg * Math.PI) / 180;
  const cos = Math.cos(phi), sin = Math.sin(phi);
  const dx = (p0[0] - p1[0]) / 2, dy = (p0[1] - p1[1]) / 2;
  const x1 = cos * dx + sin * dy, y1 = -sin * dx + cos * dy;
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const k = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / (rx * rx * y1 * y1 + ry * ry * x1 * x1)));
  const cxp = (k * rx * y1) / ry, cyp = (-k * ry * x1) / rx;
  const cx = cos * cxp - sin * cyp + (p0[0] + p1[0]) / 2;
  const cy = sin * cxp + cos * cyp + (p0[1] + p1[1]) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t0 = ang(1, 0, (x1 - cxp) / rx, (y1 - cyp) / ry);
  let dt = ang((x1 - cxp) / rx, (y1 - cyp) / ry, (-x1 - cxp) / rx, (-y1 - cyp) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  if (sweep && dt < 0) dt += 2 * Math.PI;
  const pts: Pt[] = [];
  for (let s = 1; s <= n; s++) {
    const t = t0 + (dt * s) / n;
    const ex = rx * Math.cos(t), ey = ry * Math.sin(t);
    pts.push(s === n ? p1 : [cos * ex - sin * ey + cx, sin * ex + cos * ey + cy]);
  }
  return pts;
}

function segDist(px: number, py: number, [[ax, ay], [bx, by]]: [Pt, Pt]): number {
  const vx = bx - ax, vy = by - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 ? Math.min(1, Math.max(0, ((px - ax) * vx + (py - ay) * vy) / len2)) : 0;
  return Math.hypot(px - ax - t * vx, py - ay - t * vy);
}

// ── rendering ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface Look {
  bg: string;
  ink: string;
  sun: string;
  /** the lamp's opacity: 0 = unlit (not drawn) … 1 = lit */
  lamp: number;
  /** the mark's 64-unit box in CSS px */
  markPx: number;
}

const INK_STEPS = 127; // palette 1…127: background → ink
const SUN_STEPS = 63; // palette 128…190: background → lamp

/** The first frame as palette indices (row-major), and its palette: the mark's box centred on the screen's centre. */
export function renderFrame(width: number, height: number, dpr: number, look: Look, mark = markGeometry()): { pixels: Uint8Array; palette: RGB[] } {
  const bg = hex(look.bg), ink = hex(look.ink), sun = mix(bg, hex(look.sun), Math.min(1, Math.max(0, look.lamp)));
  const palette: RGB[] = [bg];
  for (let k = 1; k <= INK_STEPS; k++) palette.push(mix(bg, ink, k / INK_STEPS));
  for (let k = 1; k <= SUN_STEPS; k++) palette.push(mix(bg, sun, k / SUN_STEPS));
  const pixels = new Uint8Array(width * height); // all 0: the background
  const scale = (look.markPx * dpr) / 64; // device px per unit
  const cx = width / 2, cy = height / 2;
  const half = mark.stroke / 2;
  const lit = look.lamp > 0;
  // only the mark's bounding box is drawn: the rest is background
  const xs = mark.segments.flatMap(([a, b]) => [a[0], b[0]]).concat(lit ? [mark.lamp.cx - mark.lamp.r, mark.lamp.cx + mark.lamp.r] : []);
  const ys = mark.segments.flatMap(([a, b]) => [a[1], b[1]]).concat(lit ? [mark.lamp.cy - mark.lamp.r, mark.lamp.cy + mark.lamp.r] : []);
  const toPx = (u: number, c: number) => c + (u - 32) * scale;
  const x0 = Math.max(0, Math.floor(toPx(Math.min(...xs) - half, cx)) - 2), x1 = Math.min(width, Math.ceil(toPx(Math.max(...xs) + half, cx)) + 2);
  const y0 = Math.max(0, Math.floor(toPx(Math.min(...ys) - half, cy)) - 2), y1 = Math.min(height, Math.ceil(toPx(Math.max(...ys) + half, cy)) + 2);
  for (let y = y0; y < y1; y++) {
    const v = (y + 0.5 - cy) / scale + 32;
    for (let x = x0; x < x1; x++) {
      const u = (x + 0.5 - cx) / scale + 32;
      let d = Infinity;
      for (const s of mark.segments) d = Math.min(d, segDist(u, v, s));
      const inkCover = Math.min(1, Math.max(0, 0.5 - (d - half) * scale)); // signed distance in device px → coverage
      const sunCover = lit ? Math.min(1, Math.max(0, 0.5 - (Math.hypot(u - mark.lamp.cx, v - mark.lamp.cy) - mark.lamp.r) * scale)) : 0;
      // the lamp sits inside the house, clear of the outline: a pixel is one or the other
      const s = Math.round(sunCover * SUN_STEPS), k = Math.round(inkCover * INK_STEPS);
      if (s > 0 && sunCover >= inkCover) pixels[y * width + x] = INK_STEPS + s;
      else if (k > 0) pixels[y * width + x] = k;
    }
  }
  return { pixels, palette };
}

// ── PNG ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf: Uint8Array): number {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** An 8-bit palette PNG (with an sRGB chunk: the colours are the page's CSS colours). */
export function encodePng(width: number, height: number, pixels: Uint8Array, palette: RGB[]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 3, 0, 0, 0], 8); // bit depth 8, colour type 3 (palette), deflate, adaptive filtering, no interlace
  const raw = Buffer.alloc((width + 1) * height); // filter byte 0 (none) per row
  for (let y = 0; y < height; y++) raw.set(pixels.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('sRGB', Uint8Array.of(0)),
    chunk('PLTE', Uint8Array.from(palette.flat())),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

// ── web/index.html ───────────────────────────────────────────────────────────────────────────────────────────────

export const BLOCK_START = '<!-- launch-images -->';
export const BLOCK_END = '<!-- /launch-images -->';

/** index.html with the block between the markers replaced by these images' links. */
export function withLinks(html: string, images: LaunchImage[]): string {
  const a = html.indexOf(BLOCK_START), b = html.indexOf(BLOCK_END);
  if (a < 0 || b < a) throw new Error(`web/index.html: no ${BLOCK_START} … ${BLOCK_END} block in <head>`);
  const indent = /([ \t]*)$/.exec(html.slice(0, a))?.[1] ?? '';
  return `${html.slice(0, a + BLOCK_START.length)}\n${linkTags(images, indent)}\n${indent}${html.slice(b)}`;
}

// ── the command ──────────────────────────────────────────────────────────────────────────────────────────────────

const flag = (name: string) => process.argv.includes(`--${name}`);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith('--')) throw new Error(`--${name} needs a value`);
  return v;
}

function main(): void {
  const html = readFileSync(INDEX_HTML, 'utf8');
  const tokens = splashBackgrounds(html);
  const markPx = Number(arg('mark') ?? 96);
  const lamp = Number(arg('lamp') ?? 0.32);
  const darkOnly = flag('dark-only');
  if (splashLamp(html) !== undefined && splashLamp(html) !== lamp) console.warn(`note: the splash's dim lamp is ${splashLamp(html)} (.boot-ember), not --lamp ${lamp}`);
  if (!(markPx > 0) || !(lamp >= 0 && lamp <= 1)) throw new Error('--mark must be > 0 and --lamp 0…1');
  const looks: Record<Scheme, Look> = {
    dark: { bg: arg('dark-bg') ?? tokens.dark, ink: arg('dark-ink') ?? BRAND_COLORS.ink, sun: arg('dark-sun') ?? BRAND_COLORS.sun, lamp, markPx },
    light: { bg: arg('light-bg') ?? tokens.light, ink: arg('light-ink') ?? BRAND_COLORS.inkOnLight, sun: arg('light-sun') ?? BRAND_COLORS.sunOnLight, lamp, markPx },
  };
  for (const l of Object.values(looks)) for (const c of [l.bg, l.ink, l.sun]) hex(c);
  const manifestBg = JSON.parse(readFileSync(join(ROOT, 'web/public/manifest.webmanifest'), 'utf8')).background_color as string;
  if (manifestBg.toLowerCase() !== looks.dark.bg.toLowerCase()) {
    console.warn(`note: the dark background ${looks.dark.bg} is not the manifest's background_color ${manifestBg} (Android's launch screen)`);
  }

  const mark = markGeometry();
  const images = launchImages(SCREENS, { darkOnly });
  mkdirSync(OUT_DIR, { recursive: true });
  const keep = new Set(images.map((im) => im.file));
  for (const f of readdirSync(OUT_DIR)) if (!keep.has(f) && /^launch-.*\.png$/.test(f)) rmSync(join(OUT_DIR, f));
  let total = 0;
  for (const im of images) {
    const { pixels, palette } = renderFrame(im.width, im.height, im.screen.dpr, looks[im.scheme], mark);
    const png = encodePng(im.width, im.height, pixels, palette);
    writeFileSync(join(OUT_DIR, im.file), png);
    total += png.length;
  }
  writeFileSync(INDEX_HTML, withLinks(html, images));
  console.log(
    `${images.length} launch images (${(total / 1024).toFixed(0)} KB) in web/public/splash; the <head> block of web/index.html rewritten\n` +
      `  mark ${markPx} CSS px, lamp ${lamp}; dark ${looks.dark.bg} ${looks.dark.ink} ${looks.dark.sun}` +
      (darkOnly ? ' (for every appearance)' : `; light ${looks.light.bg} ${looks.light.ink} ${looks.light.sun}`),
  );
}

if (import.meta.main) main();
