// Walls built from axis-aligned pieces (piers, sills, lintels) around window/door openings.
// Each wall is ONE mesh whose geometry is rewritten in place when its cut height changes, so the
// dollhouse cutaway never stretches textures (UVs are world-space meters) and needs no clipping planes.
// Exterior walls and interior partitions share the class: a partition is just a thinner wall whose
// outer face is painted for the room (or corridor) on its other side.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ROOM, type PaintBand, type WallDef } from './layout';

/** Height of the chair rail that tops a wainscot band. */
export const DADO_H = 0.92;
const CROWN_H = 0.11;

interface Piece {
  u0: number; u1: number; y0: number; y1: number; inner: number; outer: number;
  /** Lower half of a wainscoted segment: a chair rail runs along its top on these faces. */
  rail?: { inner: boolean; outer: boolean };
}

/** Paints for one wall: the outer face default, the section-cut cap, and paint-name → material for bands. */
export interface WallMaterials {
  outer: THREE.Material;
  cap: THREE.Material;
  /** Material for a paint band name (undefined → the default interior paint). */
  paint: (name: string | undefined) => THREE.Material;
  /** Painted trim: crown moulding along the ceiling and chair rails (absent → no mouldings, e.g. shadow casters). */
  trim?: THREE.Material;
}

const MAX_QUADS_PER_PIECE = 24;

export class WallMesh {
  readonly mesh: THREE.Mesh;
  readonly def: WallDef;
  readonly thickness: number;
  /** Current and target visible height (m). */
  height = ROOM.height;
  target = ROOM.height;
  private pieces: Piece[];
  private attachments: { obj: THREE.Object3D; minHeight: number }[] = [];
  private listeners: ((h: number) => void)[] = [];
  private pos: Float32Array;
  private nrm: Float32Array;
  private uv: Float32Array;
  private geom: THREE.BufferGeometry;
  private matCount: number;
  private trim: number;

  constructor(def: WallDef, mats: WallMaterials) {
    this.def = def;
    this.thickness = def.thickness ?? ROOM.wallT;
    const list: THREE.Material[] = [mats.outer, mats.cap];
    const indexOf = (m: THREE.Material) => {
      let i = list.indexOf(m);
      if (i < 0) { list.push(m); i = list.length - 1; }
      return i;
    };
    this.pieces = buildPieces(def, (band) => indexOf(mats.paint(band?.paint)), (band) => (band ? indexOf(mats.paint(band.paint)) : 0),
      (name) => indexOf(mats.paint(name)));
    this.trim = mats.trim ? indexOf(mats.trim) : -1;
    this.matCount = list.length;
    const maxQuads = this.pieces.length * MAX_QUADS_PER_PIECE;
    this.pos = new Float32Array(maxQuads * 12);
    this.nrm = new Float32Array(maxQuads * 12);
    this.uv = new Float32Array(maxQuads * 8);
    const index = new Uint16Array(maxQuads * 6);
    for (let q = 0; q < maxQuads; q++) index.set([4 * q, 4 * q + 1, 4 * q + 2, 4 * q, 4 * q + 2, 4 * q + 3], q * 6);
    this.geom = new THREE.BufferGeometry();
    this.geom.setIndex(new THREE.BufferAttribute(index, 1));
    this.geom.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geom.setAttribute('normal', new THREE.BufferAttribute(this.nrm, 3).setUsage(THREE.DynamicDrawUsage));
    this.geom.setAttribute('uv', new THREE.BufferAttribute(this.uv, 2).setUsage(THREE.DynamicDrawUsage));
    this.mesh = new THREE.Mesh(this.geom, list);
    this.mesh.name = `wall:${def.id}`;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.rebuild();
  }

  /** Objects hidden when this wall is cut below their height (batched as separate islands). */
  get attached(): THREE.Object3D[] {
    return this.attachments.map((a) => a.obj);
  }

  /** Show `obj` only while the wall is at least `minHeight` tall (windows, TV, frames…). */
  attach(obj: THREE.Object3D, minHeight: number) {
    this.attachments.push({ obj, minHeight });
    obj.visible = this.height >= minHeight;
  }

  detach(obj: THREE.Object3D) {
    this.attachments = this.attachments.filter((a) => a.obj !== obj);
  }

  /** Called with the visible height whenever it changes (room name plates ride the wall top). */
  onHeight(fn: (h: number) => void): () => void {
    this.listeners.push(fn);
    fn(this.height);
    return () => { this.listeners = this.listeners.filter((f) => f !== fn); };
  }

  /** Smoothly approach the target height; returns true while animating. */
  update(dt: number): boolean {
    if (Math.abs(this.height - this.target) < 1e-3) return false;
    const k = 1 - Math.exp(-dt * 9);
    this.height += (this.target - this.height) * k;
    if (Math.abs(this.height - this.target) < 0.004) this.height = this.target;
    this.rebuild();
    return true;
  }

  setHeightImmediate(h: number) {
    if (this.height === h && this.target === h) return;
    this.height = this.target = h;
    this.rebuild();
  }

  dispose() {
    this.geom.dispose();
    this.listeners = [];
    this.attachments = [];
  }

  private rebuild() {
    const h = this.height;
    const buckets: number[][][] = Array.from({ length: this.matCount }, () => []);
    for (const p of this.pieces) emitPiece(this.def, this.thickness, p, h, buckets, this.trim);
    let q = 0;
    this.geom.clearGroups();
    for (let m = 0; m < buckets.length; m++) {
      const start = q;
      for (const quad of buckets[m]) {
        this.pos.set(quad.slice(0, 12), q * 12);
        this.nrm.set(quad.slice(12, 24), q * 12);
        this.uv.set(quad.slice(24, 32), q * 8);
        q++;
      }
      if (q > start) this.geom.addGroup(start * 6, (q - start) * 6, m);
    }
    this.geom.setDrawRange(0, q * 6);
    for (const k of ['position', 'normal', 'uv'] as const) this.geom.getAttribute(k).needsUpdate = true;
    this.geom.computeBoundingSphere();
    this.geom.computeBoundingBox();
    for (const a of this.attachments) a.obj.visible = h >= a.minHeight - 1e-3;
    for (const fn of this.listeners) fn(h);
  }
}

function buildPieces(def: WallDef, innerOf: (b: PaintBand | undefined) => number, outerOf: (b: PaintBand | undefined) => number,
  dadoOf: (name: string) => number): Piece[] {
  const H = ROOM.height;
  // Split the u range at openings and paint band edges (both faces), then emit piers/sills/lintels. Wainscoted
  // bands split again at the chair rail: below it the face uses the band's panelling.
  const cuts = new Set<number>([def.span[0], def.span[1]]);
  for (const o of def.openings) { cuts.add(o.from); cuts.add(o.to); }
  for (const b of [...(def.bands ?? []), ...(def.outerBands ?? [])]) {
    cuts.add(THREE.MathUtils.clamp(b.from, def.span[0], def.span[1]));
    cuts.add(THREE.MathUtils.clamp(b.to, def.span[0], def.span[1]));
  }
  const xs = [...cuts].sort((a, b) => a - b);
  const pieces: Piece[] = [];
  for (let i = 0; i < xs.length - 1; i++) {
    const u0 = xs[i], u1 = xs[i + 1];
    if (u1 - u0 < 1e-4) continue;
    const mid = (u0 + u1) / 2;
    const bandIn = (def.bands ?? []).find((b) => mid > b.from && mid < b.to);
    const bandOut = (def.outerBands ?? []).find((b) => mid > b.from && mid < b.to);
    const inner = innerOf(bandIn);
    const outer = outerOf(bandOut);
    const innerLo = bandIn?.dado ? dadoOf(bandIn.dado) : inner;
    const outerLo = bandOut?.dado ? dadoOf(bandOut.dado) : outer;
    const push = (y0: number, y1: number) => {
      if (innerLo === inner && outerLo === outer) { pieces.push({ u0, u1, y0, y1, inner, outer }); return; }
      if (y1 <= DADO_H + 1e-4) { pieces.push({ u0, u1, y0, y1, inner: innerLo, outer: outerLo }); return; }
      if (y0 >= DADO_H - 1e-4) { pieces.push({ u0, u1, y0, y1, inner, outer }); return; }
      pieces.push({ u0, u1, y0, y1: DADO_H, inner: innerLo, outer: outerLo, rail: { inner: !!bandIn?.dado, outer: !!bandOut?.dado } });
      pieces.push({ u0, u1, y0: DADO_H, y1, inner, outer });
    };
    const opening = def.openings.find((o) => mid > o.from && mid < o.to);
    if (!opening) { push(0, H); continue; }
    if (opening.sill > 0) push(0, opening.sill);
    if (opening.top < H) push(opening.top, H);
  }
  return pieces;
}

// ── geometry emission ──────────────────────────────────────────────────────────────────────────
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _n = new THREE.Vector3();

function world(def: WallDef, u: number, y: number, w: number, out: THREE.Vector3): THREE.Vector3 {
  // w = depth from the inner face outward (0..thickness)
  if (def.axis === 'x') return out.set(u, y, def.at + def.outward[1] * w);
  return out.set(def.at + def.outward[0] * w, y, u);
}

function emitPiece(def: WallDef, T: number, p: Piece, h: number, buckets: number[][][], trim: number) {
  const y1 = Math.min(p.y1, h);
  if (y1 - p.y0 < 1e-3) return;
  const uAxis = def.axis === 'x' ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
  const out = new THREE.Vector3(def.outward[0], 0, def.outward[1]);
  const C = (u: number, y: number, w: number) => world(def, u, y, w, new THREE.Vector3());
  // inner face (faces into the room)
  quad(buckets[p.inner], [C(p.u0, p.y0, 0), C(p.u1, p.y0, 0), C(p.u1, y1, 0), C(p.u0, y1, 0)], out.clone().negate(),
    [[p.u0, p.y0], [p.u1, p.y0], [p.u1, y1], [p.u0, y1]]);
  // outer face
  quad(buckets[p.outer], [C(p.u0, p.y0, T), C(p.u1, p.y0, T), C(p.u1, y1, T), C(p.u0, y1, T)], out,
    [[p.u0, p.y0], [p.u1, p.y0], [p.u1, y1], [p.u0, y1]]);
  // top cap — dark "section cut" color whether it is the real wall top or a cutaway top
  const capMat = y1 >= p.y1 - 1e-3 && p.y1 < ROOM.height - 1e-3 ? p.inner : 1; // sill tops are painted
  quad(buckets[capMat], [C(p.u0, y1, 0), C(p.u1, y1, 0), C(p.u1, y1, T), C(p.u0, y1, T)], new THREE.Vector3(0, 1, 0),
    [[p.u0, 0], [p.u1, 0], [p.u1, T], [p.u0, T]]);
  // soffit under lintels
  if (p.y0 > 0) quad(buckets[p.inner], [C(p.u0, p.y0, 0), C(p.u1, p.y0, 0), C(p.u1, p.y0, T), C(p.u0, p.y0, T)],
    new THREE.Vector3(0, -1, 0), [[p.u0, 0], [p.u1, 0], [p.u1, T], [p.u0, T]]);
  // end faces (window/door reveals and wall ends)
  for (const [u, s] of [[p.u0, -1], [p.u1, 1]] as const) {
    quad(buckets[p.inner], [C(u, p.y0, 0), C(u, p.y0, T), C(u, y1, T), C(u, y1, 0)], uAxis.clone().multiplyScalar(s),
      [[0, p.y0], [T, p.y0], [T, y1], [0, y1]]);
  }
  if (trim < 0) return;
  const partition = def.thickness !== undefined;
  // chair rail on top of a wainscot (shown once the wall stands above it)
  if (p.rail && h >= DADO_H + 0.03) {
    for (const face of [0, 1] as const) {
      if (!(face ? p.rail.outer : p.rail.inner)) continue;
      const w0 = face ? T : 0, dir = face ? 1 : -1; // depth grows away from the wall into the room
      const n = face ? out : out.clone().negate();
      const ya = DADO_H - 0.022, yb = DADO_H + 0.026, d = 0.02;
      const P = (u: number, y: number, k: number) => C(u, y, w0 + dir * k);
      quad(buckets[trim], [P(p.u0, ya, d), P(p.u1, ya, d), P(p.u1, yb, d), P(p.u0, yb, d)], n, [[p.u0, ya], [p.u1, ya], [p.u1, yb], [p.u0, yb]]);
      quad(buckets[trim], [P(p.u0, yb, 0), P(p.u1, yb, 0), P(p.u1, yb, d), P(p.u0, yb, d)], new THREE.Vector3(0, 1, 0), [[p.u0, 0], [p.u1, 0], [p.u1, d], [p.u0, d]]);
      quad(buckets[trim], [P(p.u0, ya, 0), P(p.u1, ya, 0), P(p.u1, ya, d), P(p.u0, ya, d)], new THREE.Vector3(0, -1, 0), [[p.u0, 0], [p.u1, 0], [p.u1, d], [p.u0, d]]);
      for (const [u, s] of [[p.u0, -1], [p.u1, 1]] as const) {
        quad(buckets[trim], [P(u, ya, 0), P(u, ya, d), P(u, yb, d), P(u, yb, 0)], uAxis.clone().multiplyScalar(s), [[0, ya], [d, ya], [d, yb], [0, yb]]);
      }
    }
  }
  // crown moulding along the ceiling (interior faces only, while the wall is up)
  if (p.y1 >= ROOM.height - 1e-3 && h >= ROOM.height - 0.005) {
    const lo = Math.max(p.u0, def.baseSpan?.[0] ?? def.span[0]), hi = Math.min(p.u1, def.baseSpan?.[1] ?? def.span[1]);
    if (hi - lo < 1e-3) return;
    const H = ROOM.height;
    for (const face of partition ? [0, 1] as const : [0] as const) {
      const w0 = face ? T : 0, dir = face ? 1 : -1;
      const nOut = face ? out : out.clone().negate();
      const P = (u: number, y: number, k: number) => C(u, y, w0 + dir * k);
      // profile (depth, height): under-fillet, a cove sloping out to the top band, the band against the ceiling
      const prof: [number, number][] = [[0, H - CROWN_H], [0.014, H - CROWN_H], [0.014, H - CROWN_H + 0.016], [0.062, H - 0.024], [0.07, H - 0.024], [0.07, H]];
      for (let k = 0; k < prof.length - 1; k++) {
        const [d0, y0] = prof[k], [d1, yy1] = prof[k + 1];
        // normal of the segment in the (depth, y) plane, pointing out of the moulding
        const nd = yy1 - y0, ny = -(d1 - d0);
        const len = Math.hypot(nd, ny) || 1;
        const n = nOut.clone().multiplyScalar(nd / len).add(new THREE.Vector3(0, ny / len, 0));
        quad(buckets[trim], [P(lo, y0, d0), P(hi, y0, d0), P(hi, yy1, d1), P(lo, yy1, d1)], n, [[lo, y0 + d0], [hi, y0 + d0], [hi, yy1 + d1], [lo, yy1 + d1]]);
      }
    }
  }
}

function quad(bucket: number[][], v: THREE.Vector3[], n: THREE.Vector3, uv: number[][]) {
  // Ensure counter-clockwise winding as seen from the normal side.
  _a.subVectors(v[1], v[0]); _b.subVectors(v[2], v[0]); _c.crossVectors(_a, _b);
  if (_c.dot(n) < 0) { v = [v[0], v[3], v[2], v[1]]; uv = [uv[0], uv[3], uv[2], uv[1]]; }
  _n.copy(n).normalize();
  const arr: number[] = [];
  for (const p of v) arr.push(p.x, p.y, p.z);
  for (let i = 0; i < 4; i++) arr.push(_n.x, _n.y, _n.z);
  for (const t of uv) arr.push(t[0], t[1]);
  bucket.push(arr);
}

/** Baseboards along the inner faces (skipping doors and `skip` ranges); for walls marked `bothSides`
 *  (partitions) along the outer face too. Static — they sit below the cut height. */
export function buildBaseboards(defs: WallDef[], material: THREE.Material, opts: { bothSides?: boolean; skip?: Record<string, [number, number][]> } = {}): THREE.Mesh | null {
  const geoms: THREE.BufferGeometry[] = [];
  const H = 0.12, Dp = 0.016, BEAD = 0.012, BD = 0.022;
  for (const def of defs) {
    const T = def.thickness ?? ROOM.wallT;
    const gaps = [...def.openings.filter((o) => o.kind === 'door').map((d) => [d.from, d.to] as [number, number]), ...(opts.skip?.[def.id] ?? [])]
      .sort((a, b) => a[0] - b[0]);
    // inner extent only (exterior corners are covered by the back/front walls' extra length)
    const lo = def.baseSpan?.[0] ?? def.span[0];
    const hi = def.baseSpan?.[1] ?? def.span[1];
    const edges = [lo, ...gaps.flat(), hi];
    const sides = opts.bothSides ? [0, 1] : [0];
    for (const side of sides) {
      for (let i = 0; i < edges.length; i += 2) {
        const u0 = Math.max(lo, edges[i]), u1 = Math.min(hi, edges[i + 1]);
        if (u1 - u0 < 0.02) continue;
        const c = (u0 + u1) / 2;
        const o = def.axis === 'x' ? def.outward[1] : def.outward[0];
        // inner face sits at `at`; the outer face at `at + outward * T`; a slim bead runs along the top edge
        for (const [bh, bd, y] of [[H - BEAD, Dp, (H - BEAD) / 2], [BEAD, BD, H - BEAD / 2]] as const) {
          const g = new THREE.BoxGeometry(def.axis === 'x' ? u1 - u0 : bd, bh, def.axis === 'x' ? bd : u1 - u0);
          const off = side === 0 ? def.at - o * bd / 2 : def.at + o * (T + bd / 2);
          if (def.axis === 'x') g.translate(c, y, off); else g.translate(off, y, c);
          geoms.push(g);
        }
      }
    }
  }
  if (!geoms.length) return null;
  const merged = mergeGeometries(geoms);
  for (const g of geoms) g.dispose();
  const mesh = new THREE.Mesh(merged, material);
  mesh.name = 'baseboards';
  mesh.receiveShadow = true;
  return mesh;
}
