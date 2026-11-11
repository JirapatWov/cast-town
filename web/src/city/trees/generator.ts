// Procedural tree geometry. The branching algorithm is a TypeScript port of EZ-Tree by Daniel Greenheck
// (@dgreenheck/ez-tree 1.1.0, MIT licence): recursive branches made of tapered ring sections that are perturbed
// (gnarliness), twisted and pulled by a growth force, with leaf-sprig cards (crossed quads) on the last level.
//
// Changes for the city: output is plain arrays (written into InstancedMesh-ready geometries by the caller),
// every vertex carries an ambient-occlusion term and a wind weight, leaf cards get "canopy" normals (bent away
// from the crown centre) so the crown shades as a soft volume, and a level-of-detail pass can keep a fraction of the
// cards (enlarged to keep the coverage) and drop thin twigs.
//
// EZ-Tree licence (applies to the ported branching algorithm and the preset numbers in species.ts):
//   MIT License — Copyright (c) 2024 Daniel Greenheck
//   Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
//   documentation files (the "Software"), to deal in the Software without restriction, including without limitation
//   the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and
//   to permit persons to whom the Software is furnished to do so, subject to the following conditions:
//   The above copyright notice and this permission notice shall be included in all copies or substantial portions of
//   the Software.
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
//   THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
//   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
//   CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
//   IN THE SOFTWARE.
import * as THREE from 'three';

export interface TreeParams {
  seed: number;
  type: 'deciduous' | 'evergreen';
  levels: number;
  /** Per level (index = level). angle in degrees from the parent branch. */
  angle: number[];
  children: number[];
  gnarliness: number[];
  length: number[];
  radius: number[];
  sections: number[];
  segments: number[];
  start: number[];
  taper: number[];
  twist: number[];
  force: { direction: [number, number, number]; strength: number };
  leaves: { count: number; start: number; size: number; sizeVariance: number; angle: number; double: boolean };
}

/** EZ-Tree's generator (same sequence of random numbers for the same seed). */
class EzRng {
  private w: number;
  private z: number;
  constructor(seed: number) {
    this.w = (123456789 + seed) & 0xffffffff;
    this.z = (987654321 - seed) & 0xffffffff;
  }
  random(max = 1, min = 0): number {
    this.z = (36969 * (this.z & 65535) + (this.z >> 16)) & 0xffffffff;
    this.w = (18000 * (this.w & 65535) + (this.w >> 16)) & 0xffffffff;
    const r = (((this.z << 16) + (this.w & 65535)) >>> 0) / 4294967296;
    return (max - min) * r + min;
  }
}

interface Branch {
  origin: THREE.Vector3;
  orientation: THREE.Euler;
  length: number;
  radius: number;
  level: number;
  sectionCount: number;
  segmentCount: number;
}

interface Section {
  origin: THREE.Vector3;
  orientation: THREE.Euler;
  radius: number;
}

export interface RawBranches {
  pos: number[];
  nor: number[];
  uv: number[];
  /** Branch level per vertex (0 = trunk) and height fraction, used for AO and wind. */
  level: number[];
  idx: number[];
  /** Ring layout of each branch (first vertex, rings - 1, segments around, level), for decimated LODs. */
  list: { offset: number; sections: number; segments: number; level: number }[];
}

export interface RawLeaves {
  /** One entry per card quad: 4 corners. */
  cards: { corners: THREE.Vector3[]; normal: THREE.Vector3; origin: THREE.Vector3; size: number }[];
}

export interface RawTree {
  branches: RawBranches;
  leaves: RawLeaves;
  height: number;
  /** Leaf cards come in crossed pairs. */
  double: boolean;
}

const UP = new THREE.Vector3(0, 1, 0);
const AX_X = new THREE.Vector3(1, 0, 0);
const AX_Y = new THREE.Vector3(0, 1, 0);

/** Run the branching algorithm (EZ-Tree semantics, units as in its presets). */
export function growTree(p: TreeParams): RawTree {
  const rng = new EzRng(p.seed);
  const br: RawBranches = { pos: [], nor: [], uv: [], level: [], idx: [], list: [] };
  const leaves: RawLeaves = { cards: [] };
  const queue: Branch[] = [{
    origin: new THREE.Vector3(), orientation: new THREE.Euler(), length: p.length[0], radius: p.radius[0], level: 0,
    sectionCount: p.sections[0], segmentCount: p.segments[0],
  }];
  const qForce = new THREE.Quaternion().setFromUnitVectors(UP, new THREE.Vector3(...p.force.direction).normalize());
  let maxY = 0;

  const leaf = (origin: THREE.Vector3, orientation: THREE.Euler) => {
    const size = p.leaves.size * (1 + rng.random(p.leaves.sizeVariance, -p.leaves.sizeVariance));
    const W = size, L = size;
    const make = (rot: number) => {
      const e = new THREE.Euler(0, rot, 0);
      const corners = [
        new THREE.Vector3(-W / 2, L, 0), new THREE.Vector3(-W / 2, 0, 0), new THREE.Vector3(W / 2, 0, 0), new THREE.Vector3(W / 2, L, 0),
      ].map((v) => v.applyEuler(e).applyEuler(orientation).add(origin));
      const normal = new THREE.Vector3(0, 0, 1).applyEuler(e).applyEuler(orientation);
      for (const c of corners) maxY = Math.max(maxY, c.y);
      leaves.cards.push({ corners, normal, origin: origin.clone(), size });
    };
    make(0);
    if (p.leaves.double) make(Math.PI / 2);
  };

  const interp = (sections: Section[], t: number) => {
    const si = Math.floor(t * (sections.length - 1));
    const a = sections[si];
    const b = si === sections.length - 1 ? a : sections[si + 1];
    const alpha = (t - si / (sections.length - 1)) / (1 / (sections.length - 1));
    const origin = new THREE.Vector3().lerpVectors(a.origin, b.origin, alpha);
    const qa = new THREE.Quaternion().setFromEuler(a.orientation);
    const qb = new THREE.Quaternion().setFromEuler(b.orientation);
    const orient = new THREE.Euler().setFromQuaternion(qb.slerp(qa, alpha));
    return { origin, orient, radius: (1 - alpha) * a.radius + alpha * b.radius };
  };

  while (queue.length) {
    const b = queue.shift()!;
    const offset = br.pos.length / 3;
    let orient = b.orientation.clone();
    const origin = b.origin.clone();
    const sectionLength = b.length / b.sectionCount;
    const sections: Section[] = [];
    for (let i = 0; i <= b.sectionCount; i++) {
      let r = b.radius;
      if (i === b.sectionCount && b.level === p.levels) r = 0.001;
      else if (p.type === 'deciduous') r *= 1 - p.taper[b.level] * (i / b.sectionCount);
      else r *= 1 - i / b.sectionCount;
      let first: [THREE.Vector3, THREE.Vector3] | null = null;
      for (let j = 0; j < b.segmentCount; j++) {
        const a = (2 * Math.PI * j) / b.segmentCount;
        const n = new THREE.Vector3(Math.cos(a), 0, Math.sin(a)).applyEuler(orient).normalize();
        const v = n.clone().multiplyScalar(r).add(origin);
        br.pos.push(v.x, v.y, v.z);
        br.nor.push(n.x, n.y, n.z);
        br.uv.push(j / b.segmentCount, i % 2 === 0 ? 0 : 1);
        br.level.push(b.level);
        if (j === 0) first = [v, n];
      }
      br.pos.push(first![0].x, first![0].y, first![0].z);
      br.nor.push(first![1].x, first![1].y, first![1].z);
      br.uv.push(1, i % 2 === 0 ? 0 : 1);
      br.level.push(b.level);
      maxY = Math.max(maxY, origin.y);
      sections.push({ origin: origin.clone(), orientation: orient.clone(), radius: r });
      origin.add(new THREE.Vector3(0, sectionLength, 0).applyEuler(orient));
      const g = Math.max(1, 1 / Math.sqrt(r)) * p.gnarliness[b.level];
      orient.x += rng.random(g, -g);
      orient.z += rng.random(g, -g);
      const q = new THREE.Quaternion().setFromEuler(orient);
      q.multiply(new THREE.Quaternion().setFromAxisAngle(AX_Y, p.twist[b.level]));
      q.rotateTowards(qForce, p.force.strength / r);
      orient = new THREE.Euler().setFromQuaternion(q);
    }
    const N = b.segmentCount + 1;
    br.list.push({ offset, sections: b.sectionCount, segments: b.segmentCount, level: b.level });
    for (let i = 0; i < b.sectionCount; i++) {
      for (let j = 0; j < b.segmentCount; j++) {
        const v1 = offset + i * N + j, v2 = v1 + 1, v3 = v1 + N, v4 = v2 + N;
        br.idx.push(v1, v3, v2, v2, v3, v4);
      }
    }
    if (p.type === 'deciduous') {
      const last = sections[sections.length - 1];
      if (b.level < p.levels) {
        queue.push({
          origin: last.origin, orientation: last.orientation, length: p.length[b.level + 1], radius: last.radius, level: b.level + 1,
          sectionCount: b.sectionCount, segmentCount: b.segmentCount,
        });
      } else leaf(last.origin, last.orientation);
    }
    if (b.level === p.levels) {
      const radial = rng.random();
      for (let i = 0; i < p.leaves.count; i++) {
        const s = interp(sections, rng.random(1, p.leaves.start));
        const q1 = new THREE.Quaternion().setFromAxisAngle(AX_X, THREE.MathUtils.degToRad(p.leaves.angle));
        const q2 = new THREE.Quaternion().setFromAxisAngle(AX_Y, 2 * Math.PI * (radial + i / p.leaves.count));
        const q3 = new THREE.Quaternion().setFromEuler(s.orient);
        leaf(s.origin, new THREE.Euler().setFromQuaternion(q3.multiply(q2.multiply(q1))));
      }
    } else if (b.level < p.levels) {
      const level = b.level + 1;
      const radial = rng.random();
      const count = p.children[b.level];
      for (let i = 0; i < count; i++) {
        const t = rng.random(1, p.start[level]);
        const s = interp(sections, t);
        const q1 = new THREE.Quaternion().setFromAxisAngle(AX_X, THREE.MathUtils.degToRad(p.angle[level]));
        const q2 = new THREE.Quaternion().setFromAxisAngle(AX_Y, 2 * Math.PI * (radial + i / count));
        const q3 = new THREE.Quaternion().setFromEuler(s.orient);
        queue.push({
          origin: s.origin, orientation: new THREE.Euler().setFromQuaternion(q3.multiply(q2.multiply(q1))),
          length: p.length[level] * (p.type === 'evergreen' ? 1 - t : 1), radius: p.radius[level] * s.radius, level,
          sectionCount: p.sections[level], segmentCount: p.segments[level],
        });
      }
    }
  }
  return { branches: br, leaves, height: maxY, double: p.leaves.double };
}

export interface LodSpec {
  /** Keep this fraction of the leaf cards (each enlarged by 1/sqrt(keep) so the crown stays as dense). */
  keep: number;
  /** Extra card enlargement on top of the coverage compensation. */
  grow?: number;
  /** Drop branches above this level (twigs are invisible from afar). */
  maxLevel: number;
  /** Use only the first card of each crossed pair (single billboards). */
  single?: boolean;
  /** Per branch level: keep every n-th ring along the branch / every n-th vertex around it (default 1). */
  ringStride?: number[];
  sideStride?: number[];
}

/** Indexed geometry with only the vertices the index references (decimated LODs skip rings). */
function compact(attrs: Record<string, [number[], number]>, idx: number[]): THREE.BufferGeometry {
  const remap = new Map<number, number>();
  const out = idx.map((i) => {
    let j = remap.get(i);
    if (j === undefined) remap.set(i, (j = remap.size));
    return j;
  });
  const g = new THREE.BufferGeometry();
  for (const [name, [src, n]] of Object.entries(attrs)) {
    const a = new Float32Array(remap.size * n);
    for (const [from, to] of remap) for (let k = 0; k < n; k++) a[to * n + k] = src[from * n + k];
    g.setAttribute(name, new THREE.BufferAttribute(a, n));
  }
  g.setIndex(out);
  return g;
}

/** Kept indices 0, n, 2n, … with the last one always included. */
function strided(count: number, n: number, minSteps: number): number[] {
  if (n <= 1 || count / n < minSteps) return Array.from({ length: count + 1 }, (_, i) => i);
  const out: number[] = [];
  for (let i = 0; i < count; i += n) out.push(i);
  out.push(count);
  return out;
}

export interface TreeGeometries {
  bark: THREE.BufferGeometry;
  leaves: THREE.BufferGeometry;
  /** Crown centre and radius (metres, tree space), height. */
  crown: { center: THREE.Vector3; radius: number };
  height: number;
}

/**
 * Turn a grown tree into meshes scaled to `height` metres. Bark: positions/normals/uv (u around, v along in metres
 * / barkTile) + color (AO) + aWind (x: sway weight, y: phase). Leaves: positions, canopy normals, uv, color (AO),
 * aWind (x: sway, y: flutter phase).
 */
export function buildTreeGeometries(raw: RawTree, height: number, lod: LodSpec, seed: number, barkTile = 1.4): TreeGeometries {
  const s = height / raw.height;
  const r = new EzRng(seed * 7 + 3);
  // crown: centre and extent of the leaf cards
  const cards = raw.leaves.cards;
  const center = new THREE.Vector3();
  for (const c of cards) center.add(c.origin);
  center.multiplyScalar(cards.length ? 1 / cards.length : 0);
  let crownR = 0.001;
  for (const c of cards) crownR = Math.max(crownR, c.origin.distanceTo(center));
  const crownC = center.clone().multiplyScalar(s);
  const crownRad = crownR * s;

  // ── bark ──
  const b = raw.branches;
  const keepVert: number[] = new Array(b.level.length);
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], col: number[] = [], wind: number[] = [], idx: number[] = [];
  let n = 0;
  for (let i = 0; i < b.level.length; i++) {
    if (b.level[i] > lod.maxLevel) {
      keepVert[i] = -1;
      continue;
    }
    keepVert[i] = n++;
    const x = b.pos[i * 3] * s, y = b.pos[i * 3 + 1] * s, z = b.pos[i * 3 + 2] * s;
    pos.push(x, y, z);
    nor.push(b.nor[i * 3], b.nor[i * 3 + 1], b.nor[i * 3 + 2]);
    // v runs along the branch in metres: use the height for the trunk, a level-based stretch for branches
    uv.push(b.uv[i * 2], (y / barkTile) * (b.level[i] === 0 ? 1 : 1.6));
    const hk = THREE.MathUtils.clamp(y / height, 0, 1);
    const inside = THREE.MathUtils.clamp(1 - Math.hypot(x - crownC.x, y - crownC.y, z - crownC.z) / Math.max(crownRad, 0.01), 0, 1);
    const ao = THREE.MathUtils.clamp(0.55 + 0.45 * hk - 0.35 * inside * (b.level[i] > 0 ? 1 : 0.6), 0.3, 1);
    col.push(ao, ao, ao);
    const sway = Math.pow(hk, 1.6) * (1 + b.level[i] * 0.35);
    wind.push(sway, 0);
  }
  for (const br of b.list) {
    if (br.level > lod.maxLevel) continue;
    const rings = strided(br.sections, lod.ringStride?.[br.level] ?? 1, 1);
    const sides = strided(br.segments, lod.sideStride?.[br.level] ?? 1, 3);
    const N = br.segments + 1;
    for (let a = 0; a < rings.length - 1; a++) {
      for (let k = 0; k < sides.length - 1; k++) {
        const v1 = keepVert[br.offset + rings[a] * N + sides[k]], v2 = keepVert[br.offset + rings[a] * N + sides[k + 1]];
        const v3 = keepVert[br.offset + rings[a + 1] * N + sides[k]], v4 = keepVert[br.offset + rings[a + 1] * N + sides[k + 1]];
        idx.push(v1, v3, v2, v2, v3, v4);
      }
    }
  }
  const bark = compact({ position: [pos, 3], normal: [nor, 3], uv: [uv, 2], color: [col, 3], aWind: [wind, 2] }, idx);
  bark.computeBoundingSphere();

  // ── leaves ──
  const lp: number[] = [], ln: number[] = [], lu: number[] = [], lc: number[] = [], lw: number[] = [], li: number[] = [];
  const grow = (1 / Math.sqrt(Math.max(lod.keep, 0.01))) * (lod.grow ?? 1);
  // crossed pairs (double billboards) are kept or dropped together
  const pair = raw.double ? 2 : 1;
  let v = 0;
  const radial = new THREE.Vector3(), nn = new THREE.Vector3(), q = new THREE.Vector3();
  let keepPair = true;
  for (let ci = 0; ci < cards.length; ci++) {
    if (ci % pair === 0) keepPair = r.random() <= lod.keep;
    if (!keepPair || (lod.single && ci % pair === 1)) continue;
    const c = cards[ci];
    const o = c.origin;
    const phase = r.random() * 6.283;
    for (let k = 0; k < 4; k++) {
      q.copy(c.corners[k]).sub(o).multiplyScalar(grow).add(o).multiplyScalar(s);
      lp.push(q.x, q.y, q.z);
      // canopy normal: mostly away from the crown centre (soft volume), a little of the card's own facing
      radial.copy(q).sub(crownC);
      radial.y *= 0.7;
      radial.normalize();
      nn.copy(c.normal).multiplyScalar(Math.sign(c.normal.dot(radial)) || 1).multiplyScalar(0.3).add(radial).normalize();
      ln.push(nn.x, nn.y, nn.z);
      const d = q.distanceTo(crownC) / crownRad;
      const up = THREE.MathUtils.clamp((q.y - crownC.y) / crownRad, -1, 1);
      const ao = THREE.MathUtils.clamp(0.42 + 0.38 * d + 0.22 * up, 0.32, 1.05);
      lc.push(ao, ao, ao);
      lw.push(Math.pow(THREE.MathUtils.clamp(q.y / height, 0, 1), 1.4) * 1.4 + 0.15, phase);
    }
    lu.push(0, 1, 0, 0, 1, 0, 1, 1);
    li.push(v, v + 1, v + 2, v, v + 2, v + 3);
    v += 4;
  }
  const leaves = new THREE.BufferGeometry();
  leaves.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
  leaves.setAttribute('normal', new THREE.Float32BufferAttribute(ln, 3));
  leaves.setAttribute('uv', new THREE.Float32BufferAttribute(lu, 2));
  leaves.setAttribute('color', new THREE.Float32BufferAttribute(lc, 3));
  leaves.setAttribute('aWind', new THREE.Float32BufferAttribute(lw, 2));
  leaves.setIndex(li);
  leaves.computeBoundingSphere();
  // the bounding sphere must cover the whole tree for frustum culling of instanced meshes
  const bs = new THREE.Sphere(new THREE.Vector3(0, height / 2, 0), Math.max(height / 2, crownRad) * 1.25);
  bark.boundingSphere = bs.clone();
  leaves.boundingSphere = bs.clone();
  return { bark, leaves, crown: { center: crownC, radius: crownRad }, height };
}

/**
 * Far LOD: a handful of "clump" cards (dense multi-sprig images from an atlas tile) spread over the crown by
 * farthest-point sampling of the leaf positions, each a star of two upright quads + one flat quad (the city is mostly
 * seen from above), plus a plain 4-sided trunk (uv.x > 1.5 marks trunk vertices: vertex colour, no texture).
 */
export function buildFarGeometry(raw: RawTree, height: number, tile: number, clusters: number, sizeK: number, seed: number): THREE.BufferGeometry {
  const s = height / raw.height;
  const r = new EzRng(seed * 13 + 5);
  const pts = raw.leaves.cards.map((c) => c.origin.clone().multiplyScalar(s));
  const center = new THREE.Vector3();
  for (const p of pts) center.add(p);
  center.multiplyScalar(pts.length ? 1 / pts.length : 0);
  let crownR = 0.01;
  for (const p of pts) crownR = Math.max(crownR, p.distanceTo(center));
  // farthest-point sampling, starting from the top of the crown
  const chosen: THREE.Vector3[] = [];
  if (pts.length) {
    let top = pts[0];
    for (const p of pts) if (p.y > top.y) top = p;
    chosen.push(top);
    const dmin = pts.map((p) => p.distanceToSquared(top));
    while (chosen.length < Math.min(clusters, pts.length)) {
      let bi = 0;
      for (let i = 1; i < pts.length; i++) if (dmin[i] > dmin[bi]) bi = i;
      const c = pts[bi];
      chosen.push(c);
      for (let i = 0; i < pts.length; i++) dmin[i] = Math.min(dmin[i], pts[i].distanceToSquared(c));
    }
  }
  const u0 = (tile % 2) * 0.5 + 0.004, v0 = (tile < 2 ? 0.5 : 0) + 0.004, du = 0.492;
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], col: number[] = [], wind: number[] = [], idx: number[] = [];
  const nn = new THREE.Vector3();
  const vert = (p: THREE.Vector3, u: number, v: number, n: THREE.Vector3, ao: number, w: number, ph: number) => {
    pos.push(p.x, p.y, p.z);
    nor.push(n.x, n.y, n.z);
    uv.push(u, v);
    col.push(ao, ao, ao);
    wind.push(w, ph);
  };
  let vi = 0;
  const size = crownR * sizeK;
  for (const c of chosen) {
    const yaw = r.random() * Math.PI;
    const S = size * (0.85 + 0.3 * r.random());
    const ph = r.random() * 6.283;
    const quads: [THREE.Vector3, THREE.Vector3][] = [
      [new THREE.Vector3(Math.cos(yaw), 0, Math.sin(yaw)), new THREE.Vector3(0, 1, 0)],
      [new THREE.Vector3(-Math.sin(yaw), 0, Math.cos(yaw)), new THREE.Vector3(0, 1, 0)],
      [new THREE.Vector3(Math.cos(yaw), 0, Math.sin(yaw)), new THREE.Vector3(-Math.sin(yaw), 0, Math.cos(yaw))],
    ];
    const rot = r.random();
    for (const [ax, ay] of quads) {
      const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
      // rotate the image within the card a little so neighbouring clumps differ
      const uvs = corners.map(([a, b]) => {
        const ang = (rot - 0.5) * 0.8;
        const x = a * Math.cos(ang) - b * Math.sin(ang), y = a * Math.sin(ang) + b * Math.cos(ang);
        return [u0 + du * (0.5 + 0.5 * THREE.MathUtils.clamp(x, -1, 1)), v0 + du * (0.5 + 0.5 * THREE.MathUtils.clamp(y, -1, 1))];
      });
      corners.forEach(([a, b], k) => {
        const p = c.clone().addScaledVector(ax, (a * S) / 2).addScaledVector(ay, (b * S) / 2);
        nn.copy(p).sub(center);
        nn.y *= 0.7;
        nn.normalize();
        const d = p.distanceTo(center) / crownR;
        const up = THREE.MathUtils.clamp((p.y - center.y) / crownR, -1, 1);
        const ao = THREE.MathUtils.clamp(0.5 + 0.32 * d + 0.2 * up, 0.35, 1.05);
        vert(p, uvs[k][0], uvs[k][1], nn, ao, Math.pow(THREE.MathUtils.clamp(p.y / height, 0, 1), 1.4) * 1.2, ph);
      });
      idx.push(vi, vi + 1, vi + 2, vi, vi + 2, vi + 3);
      vi += 4;
    }
  }
  // trunk up into the crown
  const top = Math.max(height * 0.25, center.y - crownR * 0.35);
  const tr = Math.max(0.08, height * 0.018);
  for (let k = 0; k < 4; k++) {
    const a0 = (k / 4) * Math.PI * 2 + 0.4, a1 = ((k + 1) / 4) * Math.PI * 2 + 0.4;
    const n0 = new THREE.Vector3(Math.cos((a0 + a1) / 2), 0, Math.sin((a0 + a1) / 2));
    const p0 = new THREE.Vector3(Math.cos(a0) * tr, 0, Math.sin(a0) * tr), p1 = new THREE.Vector3(Math.cos(a1) * tr, 0, Math.sin(a1) * tr);
    const p2 = new THREE.Vector3(Math.cos(a1) * tr * 0.6, top, Math.sin(a1) * tr * 0.6), p3 = new THREE.Vector3(Math.cos(a0) * tr * 0.6, top, Math.sin(a0) * tr * 0.6);
    // uv (2.25, 0.75): flagged as trunk (u > 1.5); wraps to an opaque texel for the shadow pass
    vert(p0, 2.25, 0.75, n0, 0.75, 0, 0);
    vert(p1, 2.25, 0.75, n0, 0.75, 0, 0);
    vert(p2, 2.25, 0.75, n0, 0.55, 0.4, 0);
    vert(p3, 2.25, 0.75, n0, 0.55, 0.4, 0);
    idx.push(vi, vi + 2, vi + 1, vi, vi + 3, vi + 2);
    vi += 4;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('aWind', new THREE.Float32BufferAttribute(wind, 2));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, height / 2, 0), Math.max(height / 2, crownR + size) * 1.25);
  return g;
}
