// iOS launch images (tools/splash/launch-images.ts): web/index.html's apple-touch-startup-image links and the PNGs in
// web/public/splash agree — one dark image per screen for every appearance (the installed app's splash starts at night
// for everyone), each file the exact size its media query asks for, its background the splash's night and its lamp the
// splash's dim lamp — the server serves that same set before sign-in and links it from the 403 page, and the renderer
// puts the mark's box on the screen's centre at the asked size.
// Out of step? Rerun `bun tools/splash/launch-images.ts --dark-only` and commit web/public/splash with web/index.html.
import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import {
  BLOCK_END, BLOCK_START, encodePng, flatten, hex, launchImages, markGeometry, renderFrame, SCREENS, splashBackgrounds, splashLamp, URL_DIR, withLinks,
} from '../../tools/splash/launch-images';
import { BRAND_COLORS } from '../../shared/brand';
import { LAUNCH_IMAGES, launchImagePaths } from '../../shared/launch-images';
import { PUBLIC_PWA_PATHS } from '../../server/pwa';
import { forbiddenPage } from '../../server/pages';

const ROOT = resolve(import.meta.dir, '../..');
const PUB = join(ROOT, 'web/public');
const html = readFileSync(join(ROOT, 'web/index.html'), 'utf8');
const links = [...html.matchAll(/<link rel="apple-touch-startup-image" media="([^"]+)" href="([^"]+)" \/>/g)].map((m) => ({ media: m[1], href: m[2] }));

/** A PNG's size, palette and pixel indices (8-bit palette, filter 0: what the tool writes). */
function readPng(b: Buffer): { w: number; h: number; at: (x: number, y: number) => string } {
  expect(b.subarray(1, 4).toString()).toBe('PNG');
  let p = 8;
  let plte = Buffer.alloc(0);
  const idat: Buffer[] = [];
  const w = b.readUInt32BE(16), h = b.readUInt32BE(20);
  expect([b[24], b[25]]).toEqual([8, 3]);
  while (p < b.length) {
    const len = b.readUInt32BE(p), type = b.toString('latin1', p + 4, p + 8);
    if (type === 'PLTE') plte = b.subarray(p + 8, p + 8 + len);
    if (type === 'IDAT') idat.push(b.subarray(p + 8, p + 8 + len));
    p += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  expect(raw.length).toBe((w + 1) * h);
  const at = (x: number, y: number) => {
    const k = raw[y * (w + 1) + 1 + x];
    return `#${[0, 1, 2].map((c) => plte[k * 3 + c].toString(16).padStart(2, '0')).join('')}`;
  };
  return { w, h, at };
}

describe('the launch images in web/index.html', () => {
  const images = launchImages(SCREENS, { darkOnly: true });

  test('the <head> block is the generated one (--dark-only), inside <head>', () => {
    expect(withLinks(html, images)).toBe(html);
    expect(html.indexOf(BLOCK_END)).toBeLessThan(html.indexOf('</head>'));
    expect(links.length).toBe(images.length);
  });

  test('one image per screen for every appearance (the installed app starts at night), iPads in both orientations', () => {
    expect(images.length).toBe(SCREENS.reduce((n, s) => n + (s.ipad ? 2 : 1), 0));
    for (const s of SCREENS) {
      const of = links.filter((l) => l.media.includes(`(device-width: ${s.w}px) and (device-height: ${s.h}px) and (-webkit-device-pixel-ratio: ${s.dpr})`));
      expect(of.map((l) => /orientation: (\w+)/.exec(l.media)?.[1]).sort()).toEqual(s.ipad ? ['landscape', 'portrait'] : ['portrait']);
    }
    // a light-appearance device gets the night too: no media term picks by appearance
    expect(links.filter((l) => l.media.includes('prefers-color-scheme'))).toEqual([]);
    expect(new Set(links.map((l) => l.media)).size).toBe(links.length);
    // the theme script starts the installed app's splash at night
    expect(html).toContain("var night = installed && !day;");
    expect(html).toContain("if (night) d.setAttribute('data-launch', 'night');");
  });

  test('each file exists, is the size its media query asks for, on the splash’s night, its lamp the splash’s dim lamp, and small', () => {
    const bg = splashBackgrounds(html).dark;
    const lamp = splashLamp(html)!;
    expect(lamp).toBe(0.32);
    // the dim lamp as the splash paints it: the lamp colour at that opacity over the night
    const dim = `#${hex(BRAND_COLORS.sun).map((c, i) => Math.round(hex(bg)[i] + (c - hex(bg)[i]) * lamp).toString(16).padStart(2, '0')).join('')}`;
    for (const l of links) {
      expect(l.href.startsWith(`${URL_DIR}/launch-dark-`)).toBe(true);
      const file = join(PUB, l.href);
      expect(existsSync(file)).toBe(true);
      const m = /device-width: (\d+)px\) and \(device-height: (\d+)px\) and \(-webkit-device-pixel-ratio: (\d)\) and \(orientation: (\w+)\)$/.exec(l.media)!;
      const [w, h, dpr] = [Number(m[1]), Number(m[2]), Number(m[3])];
      const png = readPng(readFileSync(file));
      expect(`${l.href} ${png.w}x${png.h}`).toBe(`${l.href} ${(m[4] === 'portrait' ? [w * dpr, h * dpr] : [h * dpr, w * dpr]).join('x')}`);
      for (const [x, y] of [[0, 0], [png.w - 1, png.h - 1], [png.w >> 1, 0]]) expect(`${l.href} ${png.at(x, y)}`).toBe(`${l.href} ${bg}`);
      // the lamp's centre: (37.5, 40.5) of the 64-unit box, 96 CSS px on the screen's centre
      const s = (96 * dpr) / 64;
      expect(`${l.href} ${png.at(Math.floor(png.w / 2 + 5.5 * s), Math.floor(png.h / 2 + 8.5 * s))}`).toBe(`${l.href} ${dim}`);
      expect(readFileSync(file).length).toBeLessThan(16 * 1024);
    }
  });

  test('no file in web/public/splash that no link names', () => {
    const named = new Set(links.map((l) => l.href.slice(URL_DIR.length + 1)));
    expect(readdirSync(join(PUB, 'splash')).filter((f) => !named.has(f))).toEqual([]);
  });

  test('the tool still makes a dark and a light set without --dark-only', () => {
    const both = launchImages();
    expect(both.length).toBe(images.length * 2);
    expect(both.filter((im) => im.scheme === 'light').every((im) => im.media.endsWith('(prefers-color-scheme: light)'))).toBe(true);
  });

  test('the server has the same set: public before sign-in, and linked from the 403 page (Add to Home Screen there)', () => {
    expect(LAUNCH_IMAGES).toEqual(images);
    const paths = launchImagePaths();
    expect(paths).toEqual(links.map((l) => l.href));
    for (const p of paths) expect(PUBLIC_PWA_PATHS.has(p)).toBe(true);
    // nothing else under /splash is public
    expect([...PUBLIC_PWA_PATHS].filter((p) => p.startsWith(`${URL_DIR}/`)).sort()).toEqual([...paths].sort());
    const page = forbiddenPage('no-token');
    const pageLinks = [...page.matchAll(/<link rel="apple-touch-startup-image" media="([^"]+)" href="([^"]+)" \/>/g)].map((m) => ({ media: m[1], href: m[2] }));
    expect(pageLinks).toEqual(links);
    expect(page.indexOf('apple-touch-startup-image')).toBeLessThan(page.indexOf('</head>'));
  });

  test('the dark background is the manifest’s background_color (Android’s launch screen)', () => {
    const manifest = JSON.parse(readFileSync(join(PUB, 'manifest.webmanifest'), 'utf8')) as { background_color: string };
    expect(splashBackgrounds(html).dark).toBe(manifest.background_color.toLowerCase());
  });
});

describe('the renderer', () => {
  test('reads the mark from shared/brand.ts: the house outline and its lamp', () => {
    const m = markGeometry();
    expect(m.stroke).toBe(9);
    expect(m.lamp).toEqual({ cx: 37.5, cy: 40.5, r: 6.75 });
    expect(m.segments[0]).toEqual([[51.5, 25], [31, 9]]);
    expect(m.segments.at(-1)![1]).toEqual([52, 54.5]);
    // the arc a9 9 0 0 0 9 9 from (11.5, 45.5) bends round (20.5, 45.5)
    const arc = flatten('M11.5 45.5a9 9 0 0 0 9 9');
    for (const [, p] of arc) expect(Math.hypot(p[0] - 20.5, p[1] - 45.5)).toBeCloseTo(9, 6);
  });

  test('the mark’s box is centred on the screen at its size in CSS px × the pixel ratio', () => {
    const look = { bg: '#000000', ink: '#ffffff', sun: '#ff0000', lamp: 1, markPx: 96 };
    const [w, h, dpr] = [400, 600, 2];
    const { pixels, palette } = renderFrame(w, h, dpr, look);
    let [x0, y0, x1, y1] = [w, h, -1, -1];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (pixels[y * w + x] === 0) continue;
        [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
      }
    }
    // the outline's ink spans 7…56.5 × 4.5…59 of the 64-unit box (stroke 9, round caps); 1 unit = 96 × 2 / 64 = 3 px
    const s = 3, cx = w / 2, cy = h / 2;
    expect(Math.abs(x0 - (cx + (7 - 32) * s))).toBeLessThanOrEqual(1);
    expect(Math.abs(x1 + 1 - (cx + (56.5 - 32) * s))).toBeLessThanOrEqual(1);
    expect(Math.abs(y1 + 1 - (cy + (59 - 32) * s))).toBeLessThanOrEqual(1);
    expect(Math.abs(y0 - (cy + (4.5 - 32) * s))).toBeLessThanOrEqual(1);
    // full ink on the outline, the lit lamp at its centre
    expect(palette[pixels[Math.round(cy + (54.5 - 32) * s) * w + cx]]).toEqual([255, 255, 255]);
    expect(palette[pixels[Math.round(cy + (40.5 - 32) * s) * w + Math.round(cx + (37.5 - 32) * s)]]).toEqual([255, 0, 0]);
    // unlit: no lamp at all
    const off = renderFrame(w, h, dpr, { ...look, lamp: 0 });
    expect(off.pixels[Math.round(cy + (40.5 - 32) * s) * w + Math.round(cx + (37.5 - 32) * s)]).toBe(0);
  });

  test('writes a valid PNG: 8-bit palette, sRGB, the background in the corners and the ink on the floor', () => {
    const { pixels, palette } = renderFrame(60, 80, 1, { bg: '#0e0d0c', ink: '#f4f1ec', sun: '#f5c26b', lamp: 0.3, markPx: 48 });
    const png = encodePng(60, 80, pixels, palette);
    expect(png.indexOf('sRGB')).toBeGreaterThan(0);
    const img = readPng(png);
    expect([img.w, img.h, img.at(0, 0), img.at(59, 79)]).toEqual([60, 80, '#0e0d0c', '#0e0d0c']);
    expect(img.at(30, 40 + Math.round((54.5 - 32) * 0.75))).toBe('#f4f1ec'); // 48 px / 64 units: the floor line
    expect(BLOCK_START).toBe('<!-- launch-images -->');
  });
});
