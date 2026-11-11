// Procedural furniture for the upstairs job rooms (origin at bottom-centre, front = local +Z unless noted).
// Materials come from the house palette or a per-palette cache, so identical pieces in a room batch together.
import * as THREE from 'three';
import { mulberry32 } from '../../people/rng';
import { Kit, box, cyl, group, metricUV, rbox } from '../furniture/kit';
import { practical } from '../lighting';
import type { Palette, Surface } from '../materials';
import { artTexture, fringeTexture, rugTexture } from '../textures';

// ── material cache (pal.paint() makes a new material per call) ─────────────────────────────────
const caches = new WeakMap<Palette, Map<string, THREE.Material>>();
function cached<T extends THREE.Material>(pal: Palette, key: string, make: () => T): T {
  let m = caches.get(pal);
  if (!m) caches.set(pal, (m = new Map()));
  let mat = m.get(key) as T | undefined;
  if (!mat) m.set(key, (mat = make()));
  return mat;
}
export const paint = (pal: Palette, color: string, rough = 0.6) => cached(pal, `p:${color}:${rough}`, () => pal.paint(color, rough));
export const glow = (pal: Palette, color: string, intensity: number) => cached(pal, `e:${color}:${intensity}`, () => pal.emissive(color, intensity));
export const fabric = (pal: Palette, color: string, rough = 0.95) => pal.fabric(color, rough); // already cached
export const lampShade = (pal: Palette, color: string, intensity: number) => cached(pal, `shade:${color}:${intensity}`, () => {
  const m = pal.emissive('#ffd9a8', intensity);
  m.color.set(color);
  m.side = THREE.DoubleSide;
  return practical(m);
});
/** A lamp's bulb or diffuser: glows with the time of day (unlike glow(), which is for screens and LEDs). */
export const bulbGlow = (pal: Palette, color: string, intensity: number) => cached(pal, `bulb:${color}:${intensity}`, () => practical(pal.emissive(color, intensity)));

const BOOK_COLORS = ['#8b3a2f', '#2f4b3e', '#3b4a6b', '#c9a063', '#e2d6c2', '#6d5a4b', '#a8604a', '#56636e', '#d9c8a9', '#3e3a36', '#7d8a72', '#b88a5a'];

/** A row of books standing on a surface, as one instanced mesh (x from 0 to `len`). */
export function bookRow(pal: Palette, len: number, seed: number, depth = 0.2, maxH = 0.3): THREE.InstancedMesh {
  const r = mulberry32(seed);
  const mats: THREE.Matrix4[] = [];
  const cols: THREE.Color[] = [];
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  let x = 0;
  while (x < len - 0.03) {
    const bw = 0.022 + r() * 0.03, bh = (0.62 + r() * 0.38) * maxH, bd = depth * (0.75 + r() * 0.25);
    s.set(bw, bh, bd);
    p.set(x + bw / 2, bh / 2, 0);
    q.identity();
    mats.push(m.compose(p, q, s).clone());
    cols.push(new THREE.Color(BOOK_COLORS[Math.floor(r() * BOOK_COLORS.length)]).multiplyScalar(0.85 + r() * 0.25));
    x += bw + 0.002;
    if (r() < 0.05) x += 0.06;
  }
  const books = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), paint(pal, '#ffffff', 0.85), mats.length);
  mats.forEach((mm, i) => { books.setMatrixAt(i, mm); books.setColorAt(i, cols[i]); });
  books.castShadow = false; // shelf-sized rows: their shadow is lost in the shelf's own
  books.userData.batchable = true; // merged into the room batch (batch.ts), one draw for every row in the room
  books.receiveShadow = true;
  return books;
}

/** A small stack of lying books. */
export function bookStack(pal: Palette, seed: number, n = 3): THREE.Group {
  const r = mulberry32(seed);
  const g = new THREE.Group();
  let y = 0;
  for (let i = 0; i < n; i++) {
    const h = 0.03 + r() * 0.025;
    const b = box(0.2 + r() * 0.05, h, 0.15 + r() * 0.04, paint(pal, BOOK_COLORS[Math.floor(r() * BOOK_COLORS.length)], 0.8), 0, y, 0);
    b.rotation.y = (r() - 0.5) * 0.3;
    g.add(b);
    y += h;
  }
  return g;
}

export function paperStack(pal: Palette, n = 6): THREE.Group {
  const g = new THREE.Group();
  for (let i = 0; i < n; i++) {
    const s = box(0.21, 0.004, 0.297, paint(pal, i % 3 ? '#f7f3ea' : '#efe8da', 0.9), (i % 2) * 0.006, i * 0.0045, (i % 3) * 0.004);
    s.rotation.y = (i % 2 ? 1 : -1) * 0.03;
    g.add(s);
  }
  return g;
}

export function mug(pal: Palette, color: string): THREE.Mesh {
  return cyl(0.04, 0.036, 0.095, paint(pal, color, 0.35), 0, 0, 0, 18);
}

// ── desks & tables ─────────────────────────────────────────────────────────────────────────────

/** Walnut writer's desk with a drawer pedestal, brass pulls and a leather blotter. W × 0.75 × 0.72. */
export function writingDesk(kit: Kit, w = 1.5): THREE.Group {
  const { pal } = kit;
  const d = 0.72, h = 0.76;
  const g = new THREE.Group();
  g.add(rbox(w, 0.045, d, 0.008, pal.walnut, 0, h - 0.045, 0));
  // pedestal (right) with three drawers; slab leg (left); modesty panel
  const pw = 0.42;
  g.add(box(pw, h - 0.05, d - 0.06, pal.walnut, w / 2 - pw / 2 - 0.02, 0.0, 0));
  for (let k = 0; k < 3; k++) {
    const y = 0.06 + k * 0.215;
    g.add(rbox(pw - 0.04, 0.19, 0.02, 0.004, pal.walnut, w / 2 - pw / 2 - 0.02, y, d / 2 - 0.02));
    g.add(box(0.12, 0.012, 0.016, pal.brass, w / 2 - pw / 2 - 0.02, y + 0.13, d / 2 + 0.0));
  }
  g.add(box(0.04, h - 0.05, d - 0.06, pal.walnut, -w / 2 + 0.04, 0, 0));
  g.add(box(w - pw - 0.08, 0.36, 0.02, pal.walnut, -pw / 2 + 0.0, h - 0.42, -d / 2 + 0.05));
  // leather blotter where the hands rest
  g.add(rbox(0.6, 0.006, 0.38, 0.004, paint(pal, '#3b2c24', 0.55), -0.1, h, 0.08));
  return g;
}

/** Chunky oak library table on trestle legs. len × 0.76 × 1.0. */
export function libraryTable(kit: Kit, len: number, depth = 1.0): THREE.Group {
  const { pal } = kit;
  const h = 0.76;
  const g = new THREE.Group();
  g.add(rbox(len, 0.06, depth, 0.012, pal.oak, 0, h - 0.06, 0));
  for (const s of [-1, 1]) {
    const x = s * (len / 2 - 0.25);
    g.add(box(0.09, h - 0.06, 0.09, pal.oak, x, 0, depth / 2 - 0.16));
    g.add(box(0.09, h - 0.06, 0.09, pal.oak, x, 0, -depth / 2 + 0.16));
    g.add(box(0.07, 0.07, depth - 0.3, pal.oak, x, 0.12, 0));
  }
  g.add(box(len - 0.5, 0.05, 0.05, pal.oak, 0, 0.14, 0));
  return g;
}

/** Height-adjustable standing desk (raised), black T-legs, oak top. w × 1.05 × 0.7. */
export function standingDesk(kit: Kit, w = 1.2): THREE.Group {
  const { pal } = kit;
  const h = 1.05, d = 0.68;
  const g = new THREE.Group();
  g.add(rbox(w, 0.03, d, 0.008, pal.oak, 0, h - 0.03, 0));
  for (const s of [-1, 1]) {
    const x = s * (w / 2 - 0.12);
    g.add(box(0.06, h - 0.03, 0.05, pal.blackMetal, x, 0, 0));
    g.add(box(0.07, 0.03, d - 0.06, pal.blackMetal, x, 0, 0));
  }
  g.add(box(w - 0.3, 0.04, 0.06, pal.blackMetal, 0, h - 0.09, 0));
  return g;
}

/** Low credenza / sideboard. w × 0.62 × 0.44, sliding doors, slim legs. */
export function credenza(kit: Kit, w = 1.3, mat?: THREE.Material): THREE.Group {
  const { pal } = kit;
  const wood = mat ?? pal.walnut;
  const g = new THREE.Group();
  g.add(rbox(w, 0.5, 0.44, 0.01, wood, 0, 0.12, 0));
  for (let k = 0; k < 2; k++) g.add(box(w / 2 - 0.03, 0.44, 0.01, wood, (k ? 1 : -1) * (w / 4), 0.15, 0.222 + k * 0.004));
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) g.add(box(0.025, 0.12, 0.025, pal.blackMetal, sx * (w / 2 - 0.06), 0, sz * 0.16));
  return g;
}

export function sideTable(kit: Kit, r = 0.24, h = 0.52): THREE.Group {
  const { pal } = kit;
  return group(cyl(r, r, 0.03, pal.walnut, 0, h - 0.03, 0, 26), cyl(0.018, 0.022, h - 0.03, pal.blackMetal, 0, 0, 0, 10), cyl(r * 0.7, r * 0.75, 0.015, pal.blackMetal, 0, 0, 0, 22));
}

// ── seating ────────────────────────────────────────────────────────────────────────────────────

/** Squashy bean bag (displaced sphere), sits ~0.36 m high. */
export function beanBag(pal: Palette, color: string): THREE.Mesh {
  const geo = new THREE.IcosahedronGeometry(0.42, 4);
  const pos = geo.getAttribute('position');
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const sag = v.y > 0 ? 0.62 : 0.78;
    v.y *= sag;
    const dent = v.y > 0.12 ? -0.06 * Math.max(0, 1 - Math.hypot(v.x, v.z + 0.06) / 0.26) : 0;
    v.y += dent + 0.012 * Math.sin(v.x * 23 + v.z * 17);
    v.x *= 1 + 0.08 * Math.max(0, -v.y);
    v.z *= 1 + 0.08 * Math.max(0, -v.y);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  geo.translate(0, 0.42 * 0.78 - 0.02, 0);
  const m = new THREE.Mesh(geo, fabric(pal, color, 0.9));
  m.castShadow = m.receiveShadow = true;
  return m;
}

// ── storage & tech ─────────────────────────────────────────────────────────────────────────────

/** Open oak wall shelf (floating) with books. */
export function wallShelf(pal: Palette, len: number, seed: number): THREE.Group {
  const g = new THREE.Group();
  g.add(box(len, 0.03, 0.24, pal.oak, 0, 0, 0.12));
  const books = bookRow(pal, len * 0.7, seed, 0.18, 0.24);
  books.position.set(-len / 2 + 0.05, 0.03, 0.12);
  g.add(books);
  return g;
}

/** 42U server rack: black cabinet, smoked glass door, rows of servers with blinking status LEDs. */
export function serverRack(kit: Kit, seed: number): { group: THREE.Group; update(t: number): void } {
  const { pal } = kit;
  const w = 0.6, d = 0.8, h = 1.95;
  const g = new THREE.Group();
  g.add(rbox(w, h, d, 0.01, pal.plastic, 0, 0, 0));
  const r = mulberry32(seed);
  const leds: THREE.MeshStandardMaterial[] = ['#3FB37F', '#4D9BFE', '#F5A524'].map((c) => {
    const m = new THREE.MeshStandardMaterial({ color: '#000000', emissive: c, emissiveIntensity: 2.2, roughness: 1 });
    return m;
  });
  const front = d / 2 + 0.002;
  let y = 0.12;
  let k = 0;
  while (y < h - 0.2) {
    const u = r() < 0.3 ? 0.088 : 0.044;
    g.add(box(w - 0.08, u - 0.006, 0.01, paint(pal, k % 3 ? '#26282b' : '#2e3135', 0.45), 0, y, front - 0.02));
    for (let i = 0; i < 3; i++) g.add(box(0.012, 0.008, 0.004, leds[(k + i) % 3], -w / 2 + 0.08 + i * 0.022 + r() * 0.01, y + u / 2 - 0.004, front - 0.012));
    g.add(box(0.18, 0.006, 0.004, paint(pal, '#111214', 0.4), w / 2 - 0.16, y + u / 2 - 0.003, front - 0.012));
    y += u;
    k++;
  }
  // smoked glass door + handle
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(w - 0.04, h - 0.08), new THREE.MeshPhysicalMaterial({
    color: '#1a1d21', roughness: 0.08, metalness: 0, transparent: true, opacity: 0.35, envMapIntensity: 1.2, depthWrite: false,
  }));
  glass.position.set(0, h / 2, front + 0.008);
  glass.renderOrder = 2;
  g.add(glass);
  g.add(box(0.015, 0.3, 0.02, pal.steel, w / 2 - 0.05, h / 2 - 0.15, front + 0.02));
  g.add(box(w, 0.03, d, pal.blackMetal, 0, h, 0));
  return {
    group: g,
    update(t) {
      leds.forEach((m, i) => { m.emissiveIntensity = 1.2 + 1.4 * (0.5 + 0.5 * Math.sin(t * (3.1 + i * 1.7) + i * 2.1)) * (Math.sin(t * 13 + i) > -0.6 ? 1 : 0.15); });
    },
  };
}

let boardSeed = 0;
/** Whiteboard with a hand-drawn architecture sketch (boxes, arrows, a checklist). */
export function whiteboard(kit: Kit, w: number, h: number, accent: string): THREE.Group {
  const { pal } = kit;
  const c = document.createElement('canvas');
  c.width = 1024; c.height = Math.round(1024 * h / w);
  const g2 = c.getContext('2d')!;
  const r = mulberry32(1000 + boardSeed++);
  g2.fillStyle = '#f7f8f6';
  g2.fillRect(0, 0, c.width, c.height);
  const pen = (col: string, lw: number) => { g2.strokeStyle = col; g2.fillStyle = col; g2.lineWidth = lw; g2.lineCap = 'round'; g2.lineJoin = 'round'; };
  const jitter = (x: number) => x + (r() - 0.5) * 3;
  const boxAt = (x: number, y: number, bw: number, bh: number, label: string) => {
    g2.beginPath();
    g2.moveTo(jitter(x), jitter(y)); g2.lineTo(jitter(x + bw), jitter(y)); g2.lineTo(jitter(x + bw), jitter(y + bh)); g2.lineTo(jitter(x), jitter(y + bh)); g2.closePath();
    g2.stroke();
    g2.font = '600 30px "Comic Sans MS", "Segoe Print", cursive';
    g2.textAlign = 'center';
    g2.fillText(label, x + bw / 2, y + bh / 2 + 10);
  };
  const arrow = (x0: number, y0: number, x1: number, y1: number) => {
    g2.beginPath(); g2.moveTo(x0, y0); g2.quadraticCurveTo((x0 + x1) / 2 + (r() - 0.5) * 30, (y0 + y1) / 2 - 18, x1, y1); g2.stroke();
    const a = Math.atan2(y1 - y0, x1 - x0);
    g2.beginPath(); g2.moveTo(x1, y1); g2.lineTo(x1 - 16 * Math.cos(a - 0.45), y1 - 16 * Math.sin(a - 0.45));
    g2.moveTo(x1, y1); g2.lineTo(x1 - 16 * Math.cos(a + 0.45), y1 - 16 * Math.sin(a + 0.45)); g2.stroke();
  };
  const H = c.height;
  pen('#24384f', 5);
  boxAt(60, H * 0.18, 200, 110, 'client');
  boxAt(380, H * 0.18, 220, 110, 'api');
  boxAt(380, H * 0.62, 220, 110, 'db');
  boxAt(720, H * 0.18, 230, 110, 'worker');
  arrow(262, H * 0.18 + 55, 375, H * 0.18 + 55);
  arrow(490, H * 0.18 + 115, 490, H * 0.62 - 6);
  pen(accent, 5);
  arrow(605, H * 0.18 + 55, 715, H * 0.18 + 55);
  g2.font = '600 26px "Comic Sans MS", "Segoe Print", cursive';
  g2.textAlign = 'left';
  ['✓ routes', '✓ tests', '☐ deploy'].forEach((t, i) => g2.fillText(t, 720, H * 0.62 + 20 + i * 38));
  pen('#c0392b', 4);
  g2.beginPath(); g2.ellipse(490, H * 0.62 + 55, 140, 80, 0, 0, Math.PI * 2); g2.stroke();
  const tex = kit.own(new THREE.CanvasTexture(c));
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const grp = new THREE.Group();
  grp.add(box(w + 0.05, h + 0.05, 0.025, pal.steel, 0, -(h + 0.05) / 2, 0));
  const face = new THREE.Mesh(new THREE.PlaneGeometry(w, h), kit.own(new THREE.MeshStandardMaterial({ map: tex, roughness: 0.25, metalness: 0 })));
  face.position.set(0, 0, 0.0135);
  face.receiveShadow = true;
  grp.add(face);
  grp.add(box(w * 0.6, 0.02, 0.05, pal.steel, 0, -(h + 0.05) / 2 - 0.02, 0.02));
  for (const [i, col] of ['#24384f', '#c0392b', accent].entries()) grp.add(box(0.11, 0.015, 0.015, paint(pal, col, 0.5), -0.18 + i * 0.14, -(h + 0.05) / 2 - 0.005, 0.03));
  return grp;
}

/** Framed art print (hung by its top edge: origin at the frame's top centre). */
export function framedArt(kit: Kit, w: number, h: number, seed: number, palette: string[], frame?: THREE.Material): THREE.Group {
  const g = group(box(w + 0.05, h + 0.05, 0.03, frame ?? kit.pal.walnut, 0, -(h + 0.05), 0));
  const art = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: artTexture(seed, palette), roughness: 0.9 }));
  art.position.set(0, -(h + 0.05) / 2, 0.016);
  g.add(art);
  return g;
}

/** Flat rug (receives shadows only): the woven pattern spans the rug (uv0), the weave's relief and roughness repeat
 *  at real scale on uv1. */
export function rug(pal: Palette, w: number, d: number, key: string, base: string, accent: string, border: string, weave: Surface = 'wool'): THREE.Mesh {
  const mat = cached(pal, `rug:${key}:${weave}`, () => {
    const m = pal.surface(weave, '#ffffff', { channel: 1, normalScale: 0.9 }).clone();
    m.map = rugTexture(key, base, accent, border);
    return m;
  });
  const m = new THREE.Mesh(withDetailUV(new THREE.BoxGeometry(w, 0.012, d)), mat);
  m.position.y = 0.006;
  m.receiveShadow = true;
  m.name = 'rug';
  // cotton fringe on the two short ends
  const fringe = cached(pal, 'rug-fringe', () => new THREE.MeshStandardMaterial({
    name: 'rug-fringe', map: fringeTexture(), color: '#efe6d6', alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.95,
  }));
  const alongX = w >= d;
  const across = alongX ? d : w, len = 0.08;
  for (const s of [-1, 1]) {
    const g = new THREE.PlaneGeometry(across - 0.04, len).rotateX(-Math.PI / 2);
    // strands start at the rug's edge (v = 1 at the edge in the texture's top row) and run outward
    if (alongX) g.rotateY(s > 0 ? Math.PI / 2 : -Math.PI / 2);
    else if (s < 0) g.rotateY(Math.PI);
    const f = new THREE.Mesh(g, fringe);
    if (alongX) f.position.set(s * (w / 2 + len / 2), -0.004, 0);
    else f.position.set(0, -0.004, s * (d / 2 + len / 2));
    f.receiveShadow = true;
    f.name = 'rug-fringe';
    m.add(f);
  }
  return m;
}

/** Copy of the geometry's metric UVs (furniture/kit.ts metricUV) into uv1, keeping uv0 for a pattern. */
export function withDetailUV(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const tmp = metricUV(geo.clone());
  geo.setAttribute('uv1', tmp.getAttribute('uv'));
  return geo;
}

/** Desk globe on a brass meridian. */
export function globe(pal: Palette): THREE.Group {
  const sea = cached(pal, 'globe', () => {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 128;
    const g = c.getContext('2d')!;
    g.fillStyle = '#4f7c8a';
    g.fillRect(0, 0, 256, 128);
    const r = mulberry32(77);
    g.fillStyle = '#d8c79c';
    for (let i = 0; i < 9; i++) { g.beginPath(); g.ellipse(r() * 256, 20 + r() * 88, 10 + r() * 30, 6 + r() * 18, r() * 3, 0, Math.PI * 2); g.fill(); }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return new THREE.MeshStandardMaterial({ map: t, roughness: 0.4 });
  });
  const g = new THREE.Group();
  g.add(cyl(0.11, 0.13, 0.03, pal.walnut, 0, 0, 0, 20));
  g.add(cyl(0.012, 0.012, 0.12, pal.brass, 0, 0.03, 0, 8));
  const s = new THREE.Mesh(new THREE.SphereGeometry(0.15, 28, 18), sea);
  s.position.y = 0.3;
  s.rotation.z = 0.41;
  s.castShadow = true;
  g.add(s);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.165, 0.006, 6, 40, Math.PI * 1.2), pal.brass);
  ring.position.y = 0.3;
  ring.rotation.set(0, Math.PI / 2, 0.41 - 0.6);
  g.add(ring);
  return g;
}

// ── lights (visible fixtures; the light itself is a kit lamp spec) ─────────────────────────────

/** Tripod/arc-free classic floor lamp with a linen drum shade; returns the group and the bulb height. */
export function floorLamp(kit: Kit, shade = '#efe2cc'): { group: THREE.Group; bulbY: number } {
  const { pal } = kit;
  const g = group(cyl(0.14, 0.15, 0.025, pal.blackMetal, 0, 0, 0, 24), cyl(0.012, 0.012, 1.42, pal.brass, 0, 0.02, 0, 10));
  g.add(cyl(0.17, 0.21, 0.3, lampShade(pal, shade, 1.2), 0, 1.36, 0, 28));
  return { group: g, bulbY: 1.48 };
}

/** Banker's lamp: brass base and stem, a horizontal half-cylinder of glowing green glass. */
export function bankerLamp(pal: Palette): THREE.Group {
  const g = group(rbox(0.17, 0.025, 0.12, 0.01, pal.brass, 0, 0, 0), cyl(0.008, 0.008, 0.25, pal.brass, 0, 0.02, 0, 8));
  const glass = cached(pal, 'banker', () => {
    const m = pal.emissive('#2e9a62', 0.55);
    m.color.set('#1d5c3c');
    m.roughness = 0.2;
    m.side = THREE.DoubleSide;
    return practical(m);
  });
  // theta ∈ [0, π] is the +x half; rotating the axis onto x turns it into the top half (open side down)
  const shade = new THREE.Mesh(new THREE.CylinderGeometry(0.048, 0.048, 0.27, 18, 1, true, 0, Math.PI), glass);
  shade.rotation.z = Math.PI / 2;
  shade.position.y = 0.29;
  shade.castShadow = true;
  g.add(shade);
  const bulb = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.22, 8).rotateZ(Math.PI / 2), bulbGlow(pal, '#fff1cf', 2.5));
  bulb.position.y = 0.285;
  g.add(bulb);
  return g;
}

/** Bare bulb on a black cord (empty rooms). */
export function bareBulb(pal: Palette, ceiling: number, drop = 0.9): THREE.Group {
  const g = new THREE.Group();
  const cord = cyl(0.004, 0.004, drop - 0.06, pal.blackMetal, 0, ceiling - drop + 0.06, 0, 5);
  cord.castShadow = false;
  g.add(cord);
  g.add(cyl(0.018, 0.018, 0.05, pal.blackMetal, 0, ceiling - drop + 0.02, 0, 10));
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.045, 18, 12), bulbGlow(pal, '#ffe3b0', 4));
  bulb.position.y = ceiling - drop - 0.02;
  g.add(bulb);
  return g;
}

/** Fabric drum pendant. */
export function drumPendant(pal: Palette, ceiling: number, color = '#e9dcc4', r = 0.32, drop = 0.85): THREE.Group {
  const g = new THREE.Group();
  const y = ceiling - drop;
  g.add(cyl(r, r, 0.26, lampShade(pal, color, 0.9), 0, y, 0, 36));
  g.add(cyl(0.004, 0.004, drop - 0.26, pal.blackMetal, 0, y + 0.26, 0, 5));
  const disc = new THREE.Mesh(new THREE.CircleGeometry(r * 0.96, 32).rotateX(Math.PI / 2), bulbGlow(pal, '#fff0d6', 1.8));
  disc.position.y = y + 0.02;
  g.add(disc);
  return g;
}

// ── kitchenette bits ───────────────────────────────────────────────────────────────────────────

export function coffeeMachine(pal: Palette): THREE.Group {
  return group(
    rbox(0.28, 0.32, 0.3, 0.03, pal.steel, 0, 0, 0),
    rbox(0.26, 0.07, 0.26, 0.02, pal.blackMetal, 0, 0.32, 0),
    box(0.2, 0.012, 0.11, pal.blackMetal, 0, 0.05, 0.13),
    cyl(0.03, 0.03, 0.05, pal.blackMetal, 0, 0.2, 0.16, 14),
    cyl(0.035, 0.03, 0.07, pal.ceramic, -0.05, 0.062, 0.13, 14),
  );
}

export function miniFridge(pal: Palette, color = '#d9d4ca'): THREE.Group {
  const body = paint(pal, color, 0.35);
  return group(
    rbox(0.5, 0.85, 0.52, 0.03, body, 0, 0, 0),
    box(0.46, 0.006, 0.01, paint(pal, '#b8b2a8', 0.4), 0, 0.6, 0.262),
    box(0.02, 0.22, 0.03, pal.steel, 0.19, 0.3, 0.27),
  );
}

export function waterCooler(pal: Palette): THREE.Group {
  const g = group(rbox(0.32, 0.95, 0.32, 0.02, paint(pal, '#eeebe5', 0.4), 0, 0, 0));
  const bottle = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.38, 24), new THREE.MeshPhysicalMaterial({
    color: '#a9d3e6', roughness: 0.05, transparent: true, opacity: 0.45, depthWrite: false, envMapIntensity: 1.2,
  }));
  bottle.position.y = 0.95 + 0.19;
  bottle.renderOrder = 2;
  g.add(bottle);
  g.add(box(0.04, 0.03, 0.03, paint(pal, '#2f6fb0', 0.4), -0.06, 0.62, 0.17), box(0.04, 0.03, 0.03, paint(pal, '#c0392b', 0.4), 0.06, 0.62, 0.17));
  return g;
}
