// Procedural canvas textures for things we have no photo texture for: roof shingles,
// standing-seam metal, and a tileable macro-noise used to break up texture repetition.
import * as THREE from 'three';
import { rng } from './util/random';

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

function finish(t: THREE.Texture, srgb: boolean, repeat = true): THREE.Texture {
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

/** Tileable fBm value noise, values in [0,1]. */
function tileableNoise(size: number, octaves: number, seed: number, baseFreq = 4): Float32Array {
  const out = new Float32Array(size * size);
  const r = rng(seed);
  let amp = 1, total = 0;
  for (let o = 0; o < octaves; o++) {
    const f = baseFreq << o;
    const lattice = new Float32Array(f * f).map(() => r());
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const gx = (x / size) * f, gy = (y / size) * f;
        const x0 = Math.floor(gx), y0 = Math.floor(gy);
        const tx = gx - x0, ty = gy - y0;
        const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
        const L = (i: number, j: number) => lattice[((j % f) * f + (i % f))];
        const a = L(x0, y0) + (L(x0 + 1, y0) - L(x0, y0)) * sx;
        const b = L(x0, y0 + 1) + (L(x0 + 1, y0 + 1) - L(x0, y0 + 1)) * sx;
        out[y * size + x] += (a + (b - a) * sy) * amp;
      }
    }
    total += amp;
    amp *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

/** Normal map (OpenGL convention) from a height field via central differences. */
function normalFromHeight(h: Float32Array, w: number, hgt: number, strength: number): THREE.DataTexture {
  const data = new Uint8Array(w * hgt * 4);
  const H = (x: number, y: number) => h[((y + hgt) % hgt) * w + ((x + w) % w)];
  for (let y = 0; y < hgt; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (H(x + 1, y) - H(x - 1, y)) * strength;
      const dy = (H(x, y + 1) - H(x, y - 1)) * strength;
      // canvas rows go down, texture v goes up → flip dy for OpenGL-style green
      let nx = -dx, ny = dy, nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l; ny /= l; nz /= l;
      const i = ((hgt - 1 - y) * w + x) * 4;
      data[i] = (nx * 0.5 + 0.5) * 255;
      data[i + 1] = (ny * 0.5 + 0.5) * 255;
      data[i + 2] = (nz * 0.5 + 0.5) * 255;
      data[i + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(data, w, hgt, THREE.RGBAFormat);
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  return finish(t, false) as THREE.DataTexture;
}

export function macroNoiseTexture(): THREE.Texture {
  const size = 256;
  const n = tileableNoise(size, 5, 7, 3);
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < n.length; i++) {
    const v = Math.max(0, Math.min(255, n[i] * 255));
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  return finish(t, false);
}

/** Overlapping roof shingles: albedo (grayscale, tinted by vertex color) + normal. Texture spans 2 m × 2 m. */
export function shingleTextures(): { map: THREE.Texture; normal: THREE.Texture } {
  const W = 512, H = 512, rows = 10, cols = 7;
  const [c, g] = canvas(W, H);
  const height = new Float32Array(W * H);
  const r = rng(11);
  const rowH = H / rows, colW = W / cols;
  g.fillStyle = '#5a5a5a';
  g.fillRect(0, 0, W, H);
  for (let row = 0; row < rows; row++) {
    const off = (row % 2) * colW * 0.5;
    for (let col = -1; col <= cols; col++) {
      const x0 = col * colW + off + (r() - 0.5) * 4;
      const y0 = row * rowH;
      const shade = 150 + Math.floor((r() - 0.5) * 50);
      g.fillStyle = `rgb(${shade},${shade},${shade})`;
      g.fillRect(x0 + 1.5, y0, colW - 3, rowH - 1);
      // height: each shingle thickest at its lower edge (canvas y grows down = down the roof)
      for (let y = Math.max(0, Math.floor(y0)); y < Math.min(H, y0 + rowH - 1); y++) {
        const t = (y - y0) / rowH;
        for (let x = Math.max(0, Math.floor(x0 + 1.5)); x < Math.min(W, x0 + colW - 1.5); x++) height[y * W + x] = 0.3 + t * 0.7;
      }
    }
  }
  // subtle grain
  const img = g.getImageData(0, 0, W, H);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (r() - 0.5) * 18;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
  return { map: finish(new THREE.CanvasTexture(c), true), normal: normalFromHeight(height, W, H, 6) };
}

/**
 * Flat-roof membrane (albedo, tinted by the material colour): 1 m welded sheets with lighter lap seams, darker
 * ponding stains and drain streaks, so big flat roofs read as a real roof instead of a pale slab. Spans 8 m × 8 m.
 */
export function membraneTexture(): THREE.Texture {
  const S = 512, px = S / 8;
  const [c, g] = canvas(S, S);
  const n = tileableNoise(128, 4, 23, 3);
  const img = g.createImageData(S, S);
  const r = rng(31);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const nv = n[((y >> 2) % 128) * 128 + ((x >> 2) % 128)];
      // ponding: low spots hold water and dirt
      let v = 196 - Math.max(0, nv - 0.56) * 110 + (nv - 0.5) * 14 + (r() - 0.5) * 10;
      // seams every metre (laps sit slightly proud and catch light), a fainter seam halfway along the sheet run
      const sx = x % px;
      if (sx < 2) v += 26;
      else if (sx < 4) v -= 14;
      if ((y + 37) % (px * 4) < 2) v += 14;
      const i = (y * S + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.max(0, Math.min(255, v));
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  // drain stains: soft dark ovals
  for (let i = 0; i < 6; i++) {
    const x = r() * S, y = r() * S, rad = 18 + r() * 40;
    const grad = g.createRadialGradient(x, y, 0, x, y, rad);
    grad.addColorStop(0, 'rgba(40,44,48,0.16)');
    grad.addColorStop(1, 'rgba(40,44,48,0)');
    g.fillStyle = grad;
    g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  const t = finish(new THREE.CanvasTexture(c), true);
  t.repeat.set(1 / 8, 1 / 8);
  return t;
}

/** Standing-seam metal roof normal map: one raised seam every 0.5 m (texture spans 1 m). */
export function seamNormalTexture(): THREE.Texture {
  const W = 256, H = 16;
  const h = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = (x / W) * 2 % 1; // two seams per tile
    const d = Math.abs(u - 0.5);
    h[y * W + x] = d < 0.025 ? 1 : d < 0.04 ? 1 - (d - 0.025) / 0.015 : 0.05 * Math.cos(u * 6.283);
  }
  return normalFromHeight(h, W, H, 3);
}

/** Generic sign face (name boards, for-sale signs, shop fascia). */
export function signTexture(draw: (g: CanvasRenderingContext2D, w: number, h: number) => void, w = 512, h = 256): THREE.CanvasTexture {
  const [c, g] = canvas(w, h);
  draw(g, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
