// Occupancy grid + A* for walking around furniture. Obstacles are inflated by the body radius at
// build time, so paths are plain cell walks; a line-of-sight pass then pulls them into straight runs.
import * as THREE from 'three';

export interface Rect { x0: number; z0: number; x1: number; z1: number }

export class NavGrid {
  readonly cell: number;
  readonly nx: number;
  readonly nz: number;
  private readonly x0: number;
  private readonly z0: number;
  private readonly blocked: Uint8Array;

  constructor(bounds: Rect, cell = 0.2) {
    this.cell = cell;
    this.x0 = bounds.x0;
    this.z0 = bounds.z0;
    this.nx = Math.ceil((bounds.x1 - bounds.x0) / cell);
    this.nz = Math.ceil((bounds.z1 - bounds.z0) / cell);
    this.blocked = new Uint8Array(this.nx * this.nz);
  }

  /** Mark a rectangle (house-local meters) as blocked, grown by `inflate`. */
  block(r: Rect, inflate = 0) {
    const i0 = this.ix(r.x0 - inflate), i1 = this.ix(r.x1 + inflate);
    const j0 = this.iz(r.z0 - inflate), j1 = this.iz(r.z1 + inflate);
    for (let j = Math.max(0, j0); j <= Math.min(this.nz - 1, j1); j++)
      for (let i = Math.max(0, i0); i <= Math.min(this.nx - 1, i1); i++) this.blocked[j * this.nx + i] = 1;
  }

  /** Clear a rectangle (e.g. a doorway through a wall). */
  clear(r: Rect) {
    for (let j = Math.max(0, this.iz(r.z0)); j <= Math.min(this.nz - 1, this.iz(r.z1)); j++)
      for (let i = Math.max(0, this.ix(r.x0)); i <= Math.min(this.nx - 1, this.ix(r.x1)); i++) this.blocked[j * this.nx + i] = 0;
  }

  isFree(x: number, z: number): boolean {
    const i = this.ix(x), j = this.iz(z);
    return i >= 0 && j >= 0 && i < this.nx && j < this.nz && !this.blocked[j * this.nx + i];
  }

  nearestFree(p: THREE.Vector3): THREE.Vector3 {
    if (this.isFree(p.x, p.z)) return p.clone();
    const ci = this.ix(p.x), cj = this.iz(p.z);
    for (let rad = 1; rad < 40; rad++) {
      let best: THREE.Vector3 | null = null, bestD = Infinity;
      for (let dj = -rad; dj <= rad; dj++) for (let di = -rad; di <= rad; di++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== rad) continue;
        const i = ci + di, j = cj + dj;
        if (i < 0 || j < 0 || i >= this.nx || j >= this.nz || this.blocked[j * this.nx + i]) continue;
        const c = this.center(i, j);
        const d = c.distanceToSquared(p);
        if (d < bestD) { bestD = d; best = c; }
      }
      if (best) return best;
    }
    return p.clone();
  }

  /** A* path from → to (house-local). Endpoints inside obstacles are allowed (snapped for search). */
  findPath(from: THREE.Vector3, to: THREE.Vector3): THREE.Vector3[] {
    const s = this.nearestFree(from), g = this.nearestFree(to);
    const si = this.ix(s.x), sj = this.iz(s.z), gi = this.ix(g.x), gj = this.iz(g.z);
    const N = this.nx * this.nz;
    const start = sj * this.nx + si, goal = gj * this.nx + gi;
    if (start === goal) return [to.clone()];
    const gScore = new Float32Array(N).fill(Infinity);
    const came = new Int32Array(N).fill(-1);
    const closed = new Uint8Array(N);
    const heap = new MinHeap();
    gScore[start] = 0;
    heap.push(start, this.h(si, sj, gi, gj));
    const DIRS = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];
    let found = false;
    while (heap.size) {
      const cur = heap.pop();
      if (cur === goal) { found = true; break; }
      if (closed[cur]) continue;
      closed[cur] = 1;
      const ci = cur % this.nx, cj = (cur - ci) / this.nx;
      for (const [di, dj, cost] of DIRS) {
        const i = ci + di, j = cj + dj;
        if (i < 0 || j < 0 || i >= this.nx || j >= this.nz) continue;
        const n = j * this.nx + i;
        if (this.blocked[n] || closed[n]) continue;
        // no corner cutting
        if (di && dj && (this.blocked[cj * this.nx + i] || this.blocked[j * this.nx + ci])) continue;
        const t = gScore[cur] + cost;
        if (t < gScore[n]) {
          gScore[n] = t;
          came[n] = cur;
          heap.push(n, t + this.h(i, j, gi, gj));
        }
      }
    }
    if (!found) return [];
    const cells: number[] = [];
    for (let c = goal; c !== -1; c = came[c]) cells.push(c);
    cells.reverse();
    // Smooth the pure grid walk (both ends free), then attach the exact endpoints, which may sit
    // inside an inflated footprint (a chair, a counter front) — the last/first legs are short.
    const pts = cells.map((c) => this.center(c % this.nx, Math.floor(c / this.nx)));
    pts[0] = s;
    pts[pts.length - 1] = g;
    const out = this.smooth(pts).slice(1);
    if (out.length && out[out.length - 1].distanceTo(to) < 0.05) out.pop();
    out.push(to.clone());
    if (out.length > 1 && this.lineFree(from, out[1]) && from.distanceTo(s) < 0.05) out.shift();
    return out;
  }

  /** String-pulling: keep a point only if the straight segment to the next kept one is blocked. */
  private smooth(pts: THREE.Vector3[]): THREE.Vector3[] {
    if (pts.length <= 2) return pts;
    const out = [pts[0]];
    let anchor = 0;
    for (let i = 2; i < pts.length; i++) {
      if (!this.lineFree(pts[anchor], pts[i])) {
        out.push(pts[i - 1]);
        anchor = i - 1;
      }
    }
    out.push(pts[pts.length - 1]);
    return out;
  }

  lineFree(a: THREE.Vector3, b: THREE.Vector3): boolean {
    const d = Math.hypot(b.x - a.x, b.z - a.z);
    const steps = Math.max(1, Math.ceil(d / (this.cell * 0.4)));
    for (let k = 1; k < steps; k++) {
      const t = k / steps;
      if (!this.isFree(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t)) return false;
    }
    return true;
  }

  private h(i: number, j: number, gi: number, gj: number) {
    const dx = Math.abs(i - gi), dz = Math.abs(j - gj);
    return dx + dz + (Math.SQRT2 - 2) * Math.min(dx, dz);
  }
  private ix(x: number) { return Math.floor((x - this.x0) / this.cell); }
  private iz(z: number) { return Math.floor((z - this.z0) / this.cell); }
  private center(i: number, j: number) { return new THREE.Vector3(this.x0 + (i + 0.5) * this.cell, 0, this.z0 + (j + 0.5) * this.cell); }

  /** Debug overlay of blocked cells. */
  debugMesh(): THREE.Object3D {
    const g = new THREE.PlaneGeometry(this.cell * 0.9, this.cell * 0.9).rotateX(-Math.PI / 2);
    let n = 0;
    for (let k = 0; k < this.blocked.length; k++) n += this.blocked[k];
    const m = new THREE.InstancedMesh(g, new THREE.MeshBasicMaterial({ color: 0xff3355, transparent: true, opacity: 0.35, depthWrite: false }), n);
    const mat = new THREE.Matrix4();
    let c = 0;
    for (let j = 0; j < this.nz; j++) for (let i = 0; i < this.nx; i++) {
      if (!this.blocked[j * this.nx + i]) continue;
      const p = this.center(i, j);
      mat.makeTranslation(p.x, 0.02, p.z);
      m.setMatrixAt(c++, mat);
    }
    return m;
  }
}

class MinHeap {
  private ids: number[] = [];
  private keys: number[] = [];
  get size() { return this.ids.length; }
  push(id: number, key: number) {
    this.ids.push(id); this.keys.push(key);
    let i = this.ids.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= this.keys[i]) break;
      this.swap(i, p); i = p;
    }
  }
  pop(): number {
    const top = this.ids[0];
    const lastId = this.ids.pop()!, lastKey = this.keys.pop()!;
    if (this.ids.length) {
      this.ids[0] = lastId; this.keys[0] = lastKey;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < this.ids.length && this.keys[l] < this.keys[m]) m = l;
        if (r < this.ids.length && this.keys[r] < this.keys[m]) m = r;
        if (m === i) break;
        this.swap(i, m); i = m;
      }
    }
    return top;
  }
  private swap(a: number, b: number) {
    [this.ids[a], this.ids[b]] = [this.ids[b], this.ids[a]];
    [this.keys[a], this.keys[b]] = [this.keys[b], this.keys[a]];
  }
}
