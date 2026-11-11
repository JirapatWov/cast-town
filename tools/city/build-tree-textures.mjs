// Offline texture pipeline for the city's trees, hedges and far-tree clumps.
//
// Source: @dgreenheck/ez-tree 1.1.0 (MIT, Daniel Greenheck) — leaf sprig PNGs and bark sets (the bark sets themselves
// are Poly Haven CC0 / TextureCan CC0, see the package's assets/bark/README.md). Download and unpack the npm tarball
// into its own empty directory, then:
//   node tools/city/build-tree-textures.mjs <unpacked>/package/src/lib/assets web/public/assets/textures/trees
// Needs `sharp` (resolved from SHARP or a scratch node_modules; it is not an app dependency).
//
// Output (all WebP):
//   leaves_{oak,ash,aspen,pine}.webp  1024² sprig cards, colours bled under the transparent areas (no dark fringes
//                                     when mip-mapped), alpha kept crisp
//   far_atlas.webp                    1024² atlas of four 512² dense leaf clumps (oak, ash | pine, aspen) for far-LOD
//                                     cards: many sprigs composited, the inner ones darker (self-shadowed crown)
//   bark_{oak,birch,pine}_{color,normal}.webp   512² bark
//   hedge_{color,normal}.webp         512² tileable clipped-hedge foliage (sprigs scattered with wrap-around)
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const sharp = require(process.env.SHARP ?? 'sharp');
const [src, out] = process.argv.slice(2);
if (!src || !out) throw new Error('usage: build-tree-textures.mjs <ez-tree assets dir> <out dir>');
fs.mkdirSync(out, { recursive: true });

/** Push-pull colour bleed: fill RGB under transparent pixels with the nearest opaque colours (alpha untouched). */
function bleed(data, w, h) {
  const levels = [];
  let cur = { w, h, c: new Float32Array(w * h * 4) };
  for (let i = 0; i < w * h; i++) {
    const a = data[i * 4 + 3] / 255 > 0.02 ? 1 : 0;
    cur.c[i * 4] = data[i * 4] * a; cur.c[i * 4 + 1] = data[i * 4 + 1] * a; cur.c[i * 4 + 2] = data[i * 4 + 2] * a; cur.c[i * 4 + 3] = a;
  }
  levels.push(cur);
  while (cur.w > 1 && cur.h > 1) {
    const nw = cur.w >> 1, nh = cur.h >> 1, n = new Float32Array(nw * nh * 4);
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
      for (let k = 0; k < 4; k++) {
        let s = 0;
        for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) s += cur.c[((y * 2 + dy) * cur.w + x * 2 + dx) * 4 + k];
        n[(y * nw + x) * 4 + k] = s;
      }
    }
    cur = { w: nw, h: nh, c: n };
    levels.push(cur);
  }
  for (let l = levels.length - 2; l >= 0; l--) {
    const L = levels[l], P = levels[l + 1];
    for (let y = 0; y < L.h; y++) for (let x = 0; x < L.w; x++) {
      const i = (y * L.w + x) * 4;
      if (L.c[i + 3] > 0) continue;
      const j = (Math.min(P.h - 1, y >> 1) * P.w + Math.min(P.w - 1, x >> 1)) * 4;
      const a = P.c[j + 3];
      if (a > 0) { L.c[i] = P.c[j] / a; L.c[i + 1] = P.c[j + 1] / a; L.c[i + 2] = P.c[j + 2] / a; L.c[i + 3] = 1; }
    }
    // normalise accumulated sums at this level so the next finer level reads averages
    for (let i = 0; i < L.w * L.h; i++) {
      const a = L.c[i * 4 + 3];
      if (a > 1) { L.c[i * 4] /= a; L.c[i * 4 + 1] /= a; L.c[i * 4 + 2] /= a; L.c[i * 4 + 3] = 1; }
    }
  }
  const base = levels[0].c;
  for (let i = 0; i < w * h; i++) {
    if (data[i * 4 + 3] / 255 > 0.02) continue;
    data[i * 4] = base[i * 4]; data[i * 4 + 1] = base[i * 4 + 1]; data[i * 4 + 2] = base[i * 4 + 2];
  }
  return data;
}

async function rgba(file, size) {
  const { data, info } = await sharp(file).resize(size, size).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), w: info.width, h: info.height };
}

async function writeRgba(img, file, q = 88) {
  await sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length), { raw: { width: img.w, height: img.h, channels: 4 } })
    .webp({ quality: q, alphaQuality: 100, effort: 6 }).toFile(file);
}

/** Composite rotated sprigs into a canvas (optionally wrapping for tiling); `shade(i, n)` darkens early (inner) ones. */
async function scatter(spriteFile, W, H, items, bg, wrap) {
  const comps = [];
  for (const it of items) {
    const s = Math.round(it.size);
    let img = sharp(spriteFile).resize(s, s).rotate(it.rot, { background: { r: 0, g: 0, b: 0, alpha: 0 } });
    if (it.shade !== 1) img = img.modulate({ brightness: it.shade });
    if (it.tint) img = img.tint(it.tint);
    const buf = await img.png().toBuffer();
    const meta = await sharp(buf).metadata();
    const offs = wrap ? [[0, 0], [W, 0], [-W, 0], [0, H], [0, -H], [W, H], [-W, -H], [W, -H], [-W, H]] : [[0, 0]];
    for (const [ox, oy] of offs) {
      const left = Math.round(it.x - meta.width / 2 + ox), top = Math.round(it.y - meta.height / 2 + oy);
      if (left >= W || top >= H || left + meta.width <= 0 || top + meta.height <= 0) continue;
      // sharp needs the overlay inside the canvas: crop it
      const cx = Math.max(0, -left), cy = Math.max(0, -top);
      const cw = Math.min(meta.width - cx, W - Math.max(0, left)), ch = Math.min(meta.height - cy, H - Math.max(0, top));
      if (cw <= 0 || ch <= 0) continue;
      const part = await sharp(buf).extract({ left: cx, top: cy, width: cw, height: ch }).toBuffer();
      comps.push({ input: part, left: Math.max(0, left), top: Math.max(0, top) });
    }
  }
  return sharp({ create: { width: W, height: H, channels: 4, background: bg } }).composite(comps).raw().toBuffer({ resolveWithObject: true });
}

let seed = 12345;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

// ── leaves ──
for (const name of ['oak', 'ash', 'aspen', 'pine']) {
  const img = await rgba(path.join(src, 'leaves', `${name}_color.png`), 1024);
  bleed(img.data, img.w, img.h);
  await writeRgba(img, path.join(out, `leaves_${name}.webp`));
  console.log('leaves', name);
}

// ── far-LOD clumps: many sprigs around a centre, inner ones darker (self-shadowed canopy interior) ──
const clumps = {};
for (const name of ['oak', 'ash', 'pine', 'aspen']) {
  const file = path.join(out, `leaves_${name}.webp`);
  const W = 512, items = [];
  const n = 46;
  for (let i = 0; i < n; i++) {
    const t = i / n, r = Math.sqrt(rnd()) * 150 * (0.45 + 0.55 * t), a = rnd() * Math.PI * 2;
    items.push({ x: W / 2 + Math.cos(a) * r, y: W / 2 + Math.sin(a) * r * 0.9, size: 230 + rnd() * 90, rot: Math.round(rnd() * 360), shade: 0.62 + 0.42 * t });
  }
  const { data, info } = await scatter(file, W, W, items, { r: 0, g: 0, b: 0, alpha: 0 }, false);
  const img = { data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), w: info.width, h: info.height };
  bleed(img.data, img.w, img.h);
  clumps[name] = await sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length), { raw: { width: img.w, height: img.h, channels: 4 } }).png().toBuffer();
  console.log('clump', name);
}
{
  const atlas = await sharp({ create: { width: 1024, height: 1024, channels: 4, background: { r: 60, g: 80, b: 40, alpha: 0 } } })
    .composite([
      { input: clumps.oak, left: 0, top: 0 }, { input: clumps.ash, left: 512, top: 0 },
      { input: clumps.pine, left: 0, top: 512 }, { input: clumps.aspen, left: 512, top: 512 },
    ]).raw().toBuffer({ resolveWithObject: true });
  const img = { data: new Uint8ClampedArray(atlas.data.buffer, atlas.data.byteOffset, atlas.data.length), w: 1024, h: 1024 };
  await writeRgba(img, path.join(out, 'far_atlas.webp'));
}

// ── bark ──
for (const name of ['oak', 'birch', 'pine']) {
  await sharp(path.join(src, 'bark', `${name}_color_1k.jpg`)).resize(512, 512).webp({ quality: 84 }).toFile(path.join(out, `bark_${name}_color.webp`));
  await sharp(path.join(src, 'bark', `${name}_normal_1k.jpg`)).resize(512, 512).webp({ quality: 90 }).toFile(path.join(out, `bark_${name}_normal.webp`));
  console.log('bark', name);
}

// ── hedge: tileable dense foliage from oak + ash sprigs on a dark leafy base ──
{
  const W = 512, items = [];
  for (let layer = 0; layer < 3; layer++) {
    for (let i = 0; i < 70; i++) {
      items.push({ x: rnd() * W, y: rnd() * W, size: 150 + rnd() * 80, rot: Math.round(rnd() * 360), shade: 0.55 + layer * 0.22 + rnd() * 0.08 });
    }
  }
  const oak = path.join(out, 'leaves_oak.webp');
  const { data, info } = await scatter(oak, W, W, items, { r: 34, g: 52, b: 26, alpha: 1 }, true);
  const col = Buffer.from(data);
  await sharp(col, { raw: { width: info.width, height: info.height, channels: 4 } }).removeAlpha().webp({ quality: 86 }).toFile(path.join(out, 'hedge_color.webp'));
  // normal from luminance (bright = sticking out)
  const h = new Float32Array(W * W);
  for (let i = 0; i < W * W; i++) h[i] = (0.3 * col[i * 4] + 0.59 * col[i * 4 + 1] + 0.11 * col[i * 4 + 2]) / 255;
  const nrm = Buffer.alloc(W * W * 3);
  const H = (x, y) => h[((y + W) % W) * W + ((x + W) % W)];
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const dx = (H(x + 1, y) - H(x - 1, y)) * 3.0, dy = (H(x, y + 1) - H(x, y - 1)) * 3.0;
    let nx = -dx, ny = dy, nz = 1; const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
    const i = (y * W + x) * 3;
    nrm[i] = (nx * 0.5 + 0.5) * 255; nrm[i + 1] = (ny * 0.5 + 0.5) * 255; nrm[i + 2] = (nz * 0.5 + 0.5) * 255;
  }
  await sharp(nrm, { raw: { width: W, height: W, channels: 3 } }).webp({ quality: 90 }).toFile(path.join(out, 'hedge_normal.webp'));
  console.log('hedge');
}
