// Small procedural canvas textures (wood grain, linen, tiles, rug, soft blob) — generated once, cached.
import * as THREE from 'three';
import { mulberry32 } from '../people/rng';

const cache = new Map<string, THREE.Texture>();

function canvasTexture(key: string, size: number, draw: (g: CanvasRenderingContext2D, s: number) => void,
  opts: { srgb?: boolean; repeat?: boolean } = {}): THREE.Texture {
  const hit = cache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  draw(g, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = opts.srgb === false ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  if (opts.repeat !== false) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  cache.set(key, t);
  return t;
}

/** Fine straight wood grain (no planks) for furniture; tint via material color. Tile ≈ 0.6 m. */
export function woodGrainTexture(): THREE.Texture {
  return canvasTexture('wood', 512, (g, s) => {
    const r = mulberry32(7);
    g.fillStyle = '#c9a27a';
    g.fillRect(0, 0, s, s);
    for (let i = 0; i < 220; i++) {
      const y = r() * s;
      const w = 0.5 + r() * 2.5;
      const dark = r() < 0.6;
      g.strokeStyle = dark ? `rgba(110,70,40,${0.05 + r() * 0.12})` : `rgba(240,210,170,${0.04 + r() * 0.08})`;
      g.lineWidth = w;
      g.beginPath();
      const amp = 1 + r() * 4, freq = 0.004 + r() * 0.01, ph = r() * 6;
      for (let x = -4; x <= s + 4; x += 8) g.lineTo(x, y + Math.sin(x * freq + ph) * amp);
      g.stroke();
    }
    // a few knots
    for (let i = 0; i < 3; i++) {
      const x = r() * s, y = r() * s;
      const grd = g.createRadialGradient(x, y, 1, x, y, 10 + r() * 10);
      grd.addColorStop(0, 'rgba(90,55,30,0.35)');
      grd.addColorStop(1, 'rgba(90,55,30,0)');
      g.fillStyle = grd;
      g.fillRect(x - 30, y - 30, 60, 60);
    }
  });
}

/** Woven linen / fabric weave (grayscale-ish, tint via color). */
export function linenTexture(): THREE.Texture {
  return canvasTexture('linen', 256, (g, s) => {
    const r = mulberry32(11);
    g.fillStyle = '#dcd6cc';
    g.fillRect(0, 0, s, s);
    for (let y = 0; y < s; y += 2) {
      g.fillStyle = `rgba(0,0,0,${0.03 + r() * 0.05})`;
      g.fillRect(0, y, s, 1);
    }
    for (let x = 0; x < s; x += 2) {
      g.fillStyle = `rgba(255,255,255,${0.03 + r() * 0.05})`;
      g.fillRect(x, 0, 1, s);
    }
    for (let i = 0; i < 400; i++) {
      g.fillStyle = `rgba(0,0,0,${r() * 0.06})`;
      g.fillRect(r() * s, r() * s, 1 + r() * 6, 1);
    }
  });
}

/** Glossy subway tiles with grout, 4 × 8 tiles per texture (tile 0.075 × 0.15 m → texture ≈ 0.6 m). */
export function subwayTileTexture(): THREE.Texture {
  return canvasTexture('subway', 512, (g, s) => {
    const r = mulberry32(3);
    g.fillStyle = '#d9d4cc';
    g.fillRect(0, 0, s, s);
    const rows = 8, cols = 4, th = s / rows, tw = s / cols, grout = 3;
    for (let j = 0; j < rows; j++) {
      const off = j % 2 ? tw / 2 : 0;
      for (let i = -1; i <= cols; i++) {
        const x = i * tw + off, y = j * th;
        const l = 238 - r() * 10;
        g.fillStyle = `rgb(${l},${l - 3},${l - 8})`;
        g.fillRect(x + grout / 2, y + grout / 2, tw - grout, th - grout);
        const grd = g.createLinearGradient(x, y, x, y + th);
        grd.addColorStop(0, 'rgba(255,255,255,0.25)');
        grd.addColorStop(1, 'rgba(0,0,0,0.05)');
        g.fillStyle = grd;
        g.fillRect(x + grout / 2, y + grout / 2, tw - grout, th - grout);
      }
    }
  });
}

/** Wool rug with a border and a soft geometric field. */
export function rugTexture(key: string, base: string, accent: string, border: string): THREE.Texture {
  // A hand-woven flat-weave: abrash (row-to-row shade drift), weft lines, a stepped central medallion and rows of
  // small lozenges in the field, a border of bands and chevrons. Was a diamond lattice in a frame (read as tiles).
  return canvasTexture(`rug:${key}`, 1024, (g, s) => {
    const r = mulberry32(key.length * 31 + key.charCodeAt(0) * 7 + 5);
    g.fillStyle = base;
    g.fillRect(0, 0, s, s);
    // abrash: soft horizontal bands of slightly different dye lots
    for (let y = 0; y < s; y += 6 + Math.floor(r() * 18)) {
      const h = 4 + r() * 22;
      g.fillStyle = r() < 0.5 ? `rgba(0,0,0,${0.025 + 0.03 * r()})` : `rgba(255,248,236,${0.03 + 0.04 * r()})`;
      g.fillRect(0, y, s, h);
    }
    const lozenge = (cx: number, cy: number, rx: number, ry: number, steps: number, color: string, alpha: number) => {
      g.fillStyle = color;
      g.globalAlpha = alpha;
      // stepped (woven) diamond: horizontal bars that widen to the middle
      for (let k = -steps; k <= steps; k++) {
        const w = rx * (1 - Math.abs(k) / (steps + 1));
        g.fillRect(cx - w, cy + (k * ry) / steps - ry / steps / 2, 2 * w, ry / steps + 0.5);
      }
      g.globalAlpha = 1;
    };
    // field: staggered rows of small lozenges, a large medallion in the middle
    const inner = 150;
    const cols = 5, rows = 7;
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const x = inner + ((i + (j % 2 ? 0.5 : 0) + 0.25) / cols) * (s - 2 * inner);
        const y = inner + ((j + 0.5) / rows) * (s - 2 * inner);
        if (Math.abs(x - s / 2) < 170 && Math.abs(y - s / 2) < 230) continue;
        lozenge(x, y, 26, 34, 6, accent, 0.55);
        lozenge(x, y, 10, 13, 3, border, 0.6);
      }
    }
    lozenge(s / 2, s / 2, 150, 210, 14, border, 0.85);
    lozenge(s / 2, s / 2, 112, 158, 11, base, 1);
    lozenge(s / 2, s / 2, 78, 110, 9, accent, 0.8);
    lozenge(s / 2, s / 2, 30, 42, 5, border, 0.9);
    // border: outer band, chevron band, inner line
    g.fillStyle = border;
    for (const [o, w] of [[24, 46], [118, 10]] as const) {
      g.fillRect(o, o, s - 2 * o, w);
      g.fillRect(o, s - o - w, s - 2 * o, w);
      g.fillRect(o, o, w, s - 2 * o);
      g.fillRect(s - o - w, o, w, s - 2 * o);
    }
    g.strokeStyle = accent;
    g.lineWidth = 7;
    g.globalAlpha = 0.85;
    const zig = (x0: number, y0: number, x1: number, y1: number) => {
      const n = Math.round(Math.hypot(x1 - x0, y1 - y0) / 26);
      const nx = -(y1 - y0) / Math.hypot(x1 - x0, y1 - y0), ny = (x1 - x0) / Math.hypot(x1 - x0, y1 - y0);
      g.beginPath();
      for (let k = 0; k <= n; k++) {
        const t = k / n, a = (k % 2 ? 1 : -1) * 11;
        const x = x0 + (x1 - x0) * t + nx * a, y = y0 + (y1 - y0) * t + ny * a;
        if (k) g.lineTo(x, y); else g.moveTo(x, y);
      }
      g.stroke();
    };
    const zc = 94;
    zig(zc, zc, s - zc, zc); zig(zc, s - zc, s - zc, s - zc); zig(zc, zc, zc, s - zc); zig(s - zc, zc, s - zc, s - zc);
    g.globalAlpha = 1;
    // weft: fine horizontal lines, and wool fuzz
    for (let y = 0; y < s; y += 3) {
      g.fillStyle = `rgba(0,0,0,${0.035 + 0.02 * r()})`;
      g.fillRect(0, y, s, 1);
    }
    g.drawImage(woolFuzz(s), 0, 0);
  }, { repeat: false });
}

let fuzz: HTMLCanvasElement | null = null;
/** Wool fuzz shared by every rug: 26k soft 2 px specks, written as pixels (as 26k fillRects with parsed colour
 *  strings it took ~80 ms per rug, a stall each time a room with a new rug was furnished). */
function woolFuzz(s: number): HTMLCanvasElement {
  if (fuzz?.width === s) return fuzz;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const img = new ImageData(s, s);
  const d = img.data;
  const r = mulberry32(4242);
  for (let i = 0; i < 26000; i++) {
    const dark = r() < 0.5;
    const a = Math.round(255 * (dark ? 0.05 : 0.06) * r());
    const x = Math.floor(r() * (s - 1)), y = Math.floor(r() * (s - 1));
    const v = dark ? 0 : 255;
    for (const o of [(y * s + x) * 4, (y * s + x + 1) * 4, ((y + 1) * s + x) * 4, ((y + 1) * s + x + 1) * 4]) {
      d[o] = d[o + 1] = d[o + 2] = v;
      d[o + 3] = a;
    }
  }
  c.getContext('2d')!.putImageData(img, 0, 0);
  return (fuzz = c);
}

/** Rug fringe: loose cotton strands (alpha-tested), tinted by the material colour. */
export function fringeTexture(): THREE.Texture {
  return canvasTexture('rug-fringe', 256, (g, s) => {
    g.clearRect(0, 0, s, s);
    const r = mulberry32(99);
    for (let x = 1; x < s; x += 3) {
      const len = s * (0.75 + 0.25 * r());
      const shade = 215 + Math.floor(r() * 40);
      g.strokeStyle = `rgb(${shade},${shade - 6},${shade - 16})`;
      g.lineWidth = 1.6;
      g.beginPath();
      g.moveTo(x, 0);
      g.quadraticCurveTo(x + (r() - 0.5) * 6, len * 0.5, x + (r() - 0.5) * 10, len);
      g.stroke();
    }
  }, { repeat: false });
}

/** Radial soft blob, used for contact shadows and light pools (white on transparent). */
export function softBlobTexture(): THREE.Texture {
  return canvasTexture('blob', 128, (g, s) => {
    const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.45, 'rgba(255,255,255,0.55)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, s, s);
  }, { repeat: false, srgb: false });
}

/** Vertical sky gradient used as the scene background behind the dollhouse. */
export function backdropTexture(): THREE.Texture {
  return canvasTexture('backdrop', 256, (g, s) => {
    const grd = g.createLinearGradient(0, 0, 0, s);
    grd.addColorStop(0, '#dfe6e9');
    grd.addColorStop(0.55, '#ece6dc');
    grd.addColorStop(1, '#d9cfbf');
    g.fillStyle = grd;
    g.fillRect(0, 0, s, s);
  }, { repeat: false });
}

/** Simple abstract art print for framed pictures. */
export function artTexture(seed: number, palette: string[]): THREE.Texture {
  return canvasTexture(`art:${seed}`, 512, (g, s) => {
    const r = mulberry32(seed);
    g.fillStyle = '#f3ede3';
    g.fillRect(0, 0, s, s);
    for (let i = 0; i < 5; i++) {
      g.fillStyle = palette[i % palette.length];
      g.globalAlpha = 0.85;
      const kind = r();
      const x = s * (0.15 + r() * 0.7), y = s * (0.15 + r() * 0.7), rad = s * (0.12 + r() * 0.22);
      g.beginPath();
      if (kind < 0.5) g.arc(x, y, rad, r() * Math.PI, r() * Math.PI + Math.PI * (1 + r()));
      else g.ellipse(x, y, rad, rad * (0.4 + r() * 0.5), r() * Math.PI, 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;
    g.strokeStyle = '#2b2622';
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(s * 0.1, s * (0.3 + r() * 0.4));
    for (let x = 0.1; x <= 0.9; x += 0.05) g.lineTo(s * x, s * (0.3 + r() * 0.4));
    g.stroke();
  }, { repeat: false });
}

/** Raised-panel wainscot, one panel per tile: a tint-able albedo (grooves slightly darker) and its normal map.
 *  Tile = 0.6 m × DADO_H (walls use world-meter UVs, v = height above the floor). */
export function wainscotTextures(): { map: THREE.Texture; normalMap: THREE.Texture } {
  const W = 192, H = 288;
  const hit = cache.get('wainscot:n');
  if (hit) return { map: cache.get('wainscot:a')!, normalMap: hit };
  // height field: stiles/rails (1.0) → a narrow groove (0.15) → a bevel rising to the raised field (0.7)
  const hgt = new Float32Array(W * H);
  const frameX = 22, frameTop = 22, frameBot = 40, groove = 5, bevel = 12;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = Math.min(x - frameX, W - 1 - frameX - x);
      const dy = Math.min(y - frameTop, H - 1 - frameBot - y);
      const d = Math.min(dx, dy); // distance inside the panel opening (negative on the frame)
      let v: number;
      if (d < 0) v = 1;
      else if (d < groove) v = 0.15;
      else if (d < groove + bevel) v = 0.15 + 0.55 * ((d - groove) / bevel);
      else v = 0.7;
      hgt[y * W + x] = v;
    }
  }
  const mk = (key: string, fill: (img: ImageData) => void, srgb: boolean) => canvasTexture(key, W, (g) => {
    g.canvas.height = H;
    const img = g.createImageData(W, H);
    fill(img);
    g.putImageData(img, 0, 0);
  }, { srgb });
  const at = (x: number, y: number) => hgt[Math.min(H - 1, Math.max(0, y)) * W + ((x + W) % W)];
  const normalMap = mk('wainscot:n', (img) => {
    const k = 2.2;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const nx = (at(x - 1, y) - at(x + 1, y)) * k, ny = (at(x, y + 1) - at(x, y - 1)) * k;
      const l = Math.hypot(nx, ny, 1);
      const i = (y * W + x) * 4;
      img.data[i] = (nx / l * 0.5 + 0.5) * 255;
      img.data[i + 1] = (ny / l * 0.5 + 0.5) * 255;
      img.data[i + 2] = (1 / l * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }, false);
  const map = mk('wainscot:a', (img) => {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const h = at(x, y);
      const v = h < 0.2 ? 0.8 : h < 0.65 ? 0.93 : 1;
      const i = (y * W + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v * 255;
      img.data[i + 3] = 255;
    }
  }, true);
  return { map, normalMap };
}
