// CPU-side geometry accumulation. Static town geometry is written into one MeshWriter per material and
// uploaded as a single mesh, so the whole town costs a handful of draw calls. UVs are in meters
// (materials set texture.repeat = 1 / tileMeters), which keeps texel density constant everywhere.
import * as THREE from 'three';

const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _nm = new THREE.Matrix3();
const _corners = Array.from({ length: 8 }, () => new THREE.Vector3());

export type Vec3Like = { x: number; y: number; z: number };

export interface BoxOptions {
  /** Skip faces by name: px nx py ny pz nz (e.g. 'ny' for objects resting on the ground). */
  skip?: string[];
  /** Divide UVs by this (default 1 → UV in meters). */
  uvScale?: number;
}

export class MeshWriter {
  private pos: number[] = [];
  private nor: number[] = [];
  private uv: number[] = [];
  private col: number[] = [];
  private idx: number[] = [];
  private extras = new Map<string, { size: number; data: number[]; value: number[] }>();
  /** Vertex color applied to subsequently written vertices (linear RGB). */
  color: [number, number, number] = [1, 1, 1];

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  /** Declare a custom float attribute; `value` is written for every new vertex until changed with setExtra. */
  defineExtra(name: string, size: number, value: number[]): void {
    this.extras.set(name, { size, data: [], value: value.slice(0, size) });
  }

  setExtra(name: string, value: number[]): void {
    const e = this.extras.get(name);
    if (e) e.value = value.slice(0, e.size);
  }

  setColor(c: THREE.Color | [number, number, number]): this {
    this.color = Array.isArray(c) ? [c[0], c[1], c[2]] : [c.r, c.g, c.b];
    return this;
  }

  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number): number {
    this.pos.push(x, y, z);
    this.nor.push(nx, ny, nz);
    this.uv.push(u, v);
    this.col.push(this.color[0], this.color[1], this.color[2]);
    for (const e of this.extras.values()) e.data.push(...e.value);
    return this.pos.length / 3 - 1;
  }

  /** Raw triangle indices (vertex ids returned by vertex()). */
  indices(...ids: number[]): void {
    this.idx.push(...ids);
  }

  /** Quad a→b→c→d counter-clockwise seen from the front. UVs default to (0,0) (1,0) (1,1) (0,1) scaled by uvW/uvH. */
  quad(a: Vec3Like, b: Vec3Like, c: Vec3Like, d: Vec3Like, uvs?: [number, number][]): void {
    // normal from the winding
    const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
    const vx = d.x - a.x, vy = d.y - a.y, vz = d.z - a.z;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    const t = uvs ?? [[0, 0], [1, 0], [1, 1], [0, 1]];
    const i0 = this.vertex(a.x, a.y, a.z, nx, ny, nz, t[0][0], t[0][1]);
    const i1 = this.vertex(b.x, b.y, b.z, nx, ny, nz, t[1][0], t[1][1]);
    const i2 = this.vertex(c.x, c.y, c.z, nx, ny, nz, t[2][0], t[2][1]);
    const i3 = this.vertex(d.x, d.y, d.z, nx, ny, nz, t[3][0], t[3][1]);
    this.idx.push(i0, i1, i2, i0, i2, i3);
  }

  /** Axis-aligned box (w×h×d, centered at origin) transformed by `m`, UVs in meters per face. */
  box(m: THREE.Matrix4, w: number, h: number, d: number, opts: BoxOptions = {}): void {
    const s = opts.uvScale ?? 1;
    const hx = w / 2, hy = h / 2, hz = d / 2;
    const P = (x: number, y: number, z: number) => _v.set(x, y, z).applyMatrix4(m).clone();
    const faces: [string, THREE.Vector3[], number, number][] = [
      ['pz', [P(-hx, -hy, hz), P(hx, -hy, hz), P(hx, hy, hz), P(-hx, hy, hz)], w, h],
      ['nz', [P(hx, -hy, -hz), P(-hx, -hy, -hz), P(-hx, hy, -hz), P(hx, hy, -hz)], w, h],
      ['px', [P(hx, -hy, hz), P(hx, -hy, -hz), P(hx, hy, -hz), P(hx, hy, hz)], d, h],
      ['nx', [P(-hx, -hy, -hz), P(-hx, -hy, hz), P(-hx, hy, hz), P(-hx, hy, -hz)], d, h],
      ['py', [P(-hx, hy, hz), P(hx, hy, hz), P(hx, hy, -hz), P(-hx, hy, -hz)], w, d],
      ['ny', [P(-hx, -hy, -hz), P(hx, -hy, -hz), P(hx, -hy, hz), P(-hx, -hy, hz)], w, d],
    ];
    for (const [name, c, fw, fh] of faces) {
      if (opts.skip?.includes(name)) continue;
      const u = fw / s, v = fh / s;
      this.quad(c[0], c[1], c[2], c[3], [[0, 0], [u, 0], [u, v], [0, v]]);
    }
  }

  /** Append an existing geometry transformed by `m`. A `color` attribute (if any) is multiplied by the current color. */
  geometry(g: THREE.BufferGeometry, m?: THREE.Matrix4): void {
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    const t = g.getAttribute('uv');
    const c = g.getAttribute('color');
    if (m) _nm.getNormalMatrix(m);
    const base = this.vertexCount;
    const tint = this.color;
    for (let i = 0; i < p.count; i++) {
      _v.fromBufferAttribute(p, i);
      if (m) _v.applyMatrix4(m);
      if (n) {
        _n.fromBufferAttribute(n, i);
        if (m) _n.applyMatrix3(_nm).normalize();
      } else _n.set(0, 1, 0);
      if (c) this.color = [tint[0] * c.getX(i), tint[1] * c.getY(i), tint[2] * c.getZ(i)];
      this.vertex(_v.x, _v.y, _v.z, _n.x, _n.y, _n.z, t ? t.getX(i) : 0, t ? t.getY(i) : 0);
    }
    this.color = tint;
    const index = g.getIndex();
    if (index) for (let i = 0; i < index.count; i++) this.idx.push(base + index.getX(i));
    else for (let i = 0; i < p.count; i++) this.idx.push(base + i);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    for (const [name, e] of this.extras) g.setAttribute(name, new THREE.Float32BufferAttribute(e.data, e.size));
    const big = this.vertexCount > 65535;
    g.setIndex(big ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }

  get empty(): boolean {
    return this.idx.length === 0;
  }

  /** Indices written so far: what was written between two reads is one contiguous range of the built index. */
  get indexCount(): number {
    return this.idx.length;
  }
}

/** Groups MeshWriters by material; build() yields one mesh per material. */
export class Batch {
  private writers = new Map<THREE.Material, { w: MeshWriter; cast: boolean; receive: boolean }>();

  writer(material: THREE.Material, opts: { cast?: boolean; receive?: boolean } = {}): MeshWriter {
    let e = this.writers.get(material);
    if (!e) {
      e = { w: new MeshWriter(), cast: opts.cast ?? true, receive: opts.receive ?? true };
      this.writers.set(material, e);
    }
    return e.w;
  }

  /** Indices written so far per material (see MeshWriter.indexCount). */
  indexCounts(): Map<THREE.Material, number> {
    return new Map([...this.writers].map(([mat, e]) => [mat, e.w.indexCount]));
  }

  build(parent: THREE.Object3D, name = 'batch'): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    for (const [mat, { w, cast, receive }] of this.writers) {
      if (w.empty) continue;
      const mesh = new THREE.Mesh(w.build(), mat);
      mesh.name = `${name}:${mat.name || mat.type}`;
      mesh.castShadow = cast;
      mesh.receiveShadow = receive;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      parent.add(mesh);
      out.push(mesh);
    }
    this.writers.clear();
    return out;
  }
}

/** Corner points of an oriented box; handy for footprints. */
export function boxCorners(m: THREE.Matrix4, w: number, h: number, d: number): THREE.Vector3[] {
  let i = 0;
  for (const x of [-w / 2, w / 2]) for (const y of [-h / 2, h / 2]) for (const z of [-d / 2, d / 2]) _corners[i++].set(x, y, z).applyMatrix4(m);
  return _corners;
}

/** Matrix helper: translate + rotate about Y (+ optional extra rotation). */
export function trs(x: number, y: number, z: number, rotY = 0, rotX = 0, rotZ = 0): THREE.Matrix4 {
  const m = new THREE.Matrix4();
  m.makeRotationFromEuler(new THREE.Euler(rotX, rotY, rotZ, 'YXZ'));
  m.setPosition(x, y, z);
  return m;
}
