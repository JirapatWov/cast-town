// Façade construction with real depth: walls are generated around their openings (no flat textures), every
// opening gets reveals (jambs, head, sill) and recessed glass, plus frames, mullions and projecting sills.
import * as THREE from 'three';
import type { MeshWriter } from './util/mesh-writer';

/** An opening in wall space: u along the wall (left→right seen from outside), v up from the wall base. */
export interface Opening {
  u: number;
  v: number;
  w: number;
  h: number;
  kind: 'window' | 'door' | 'shop';
  /** Atlas tile for the interior look (0..7) and how lit it is (0..1). */
  tile?: number;
  lit?: number;
  /** Door leaf color multiplier (linear). */
  doorColor?: [number, number, number];
  /** Interior-mapped glass only: height of the room floor below the opening (default v) and room width beyond each jamb. */
  sill?: number;
  side?: number;
}

export interface FacadeWriters {
  wall: MeshWriter;
  reveal: MeshWriter; // usually the wall material
  glass: MeshWriter; // window material (needs aWin)
  frame: MeshWriter;
  sill: MeshWriter;
  door: MeshWriter;
}

export interface WallStyle {
  recess: number;
  frameColor: [number, number, number];
  sillColor: [number, number, number];
  /** Add a vertical mullion when the window is wider than this. */
  mullionAbove: number;
  /** Horizontal transom at this fraction of the height (0 = none). */
  transom: number;
  sills: boolean;
  /** Masonry header above windows (brick buildings). */
  lintels: boolean;
  frameW: number;
  /** Steel-grid glazing: [columns, rows] of small panes (replaces mullion/transom logic). */
  paneGrid?: [number, number];
}

export const DEFAULT_WALL_STYLE: WallStyle = {
  recess: 0.16,
  frameColor: [0.95, 0.94, 0.92],
  sillColor: [1.0, 0.98, 0.95],
  mullionAbove: 1.1,
  transom: 0,
  sills: true,
  lintels: false,
  frameW: 0.065,
};

const _p = new THREE.Vector3();

/** Maps wall coordinates (u along, v up, w outward) to world space. */
export class WallFrame {
  readonly origin: THREE.Vector3;
  readonly dir: THREE.Vector3;
  readonly normal: THREE.Vector3;

  /** Wall from a→b (building-local XZ at height y0) transformed by `m`. Outward normal is to the right of a→b. */
  constructor(m: THREE.Matrix4, ax: number, az: number, bx: number, bz: number, y0 = 0) {
    const a = new THREE.Vector3(ax, y0, az).applyMatrix4(m);
    const b = new THREE.Vector3(bx, y0, bz).applyMatrix4(m);
    this.origin = a;
    this.dir = b.clone().sub(a).normalize();
    this.normal = new THREE.Vector3(-this.dir.z, 0, this.dir.x);
  }

  at(u: number, v: number, w = 0): THREE.Vector3 {
    return _p.copy(this.origin).addScaledVector(this.dir, u).addScaledVector(this.normal, w).setY(this.origin.y + v).clone();
  }

  /** Matrix for an object centered at wall coords (u,v,w), axes: X along wall, Y up, Z outward. */
  matrix(u: number, v: number, w: number): THREE.Matrix4 {
    const m = new THREE.Matrix4().makeBasis(this.dir, new THREE.Vector3(0, 1, 0), this.normal);
    m.setPosition(this.at(u, v, w));
    return m;
  }
}

/** Quad in wall space (u0..u1, v0..v1) at depth w, facing outward. UVs in meters from (uvU0, 0). */
function wallQuad(wr: MeshWriter, f: WallFrame, u0: number, v0: number, u1: number, v1: number, w: number, uvU0: number, uvV0 = 0) {
  wr.quad(f.at(u0, v0, w), f.at(u1, v0, w), f.at(u1, v1, w), f.at(u0, v1, w), [
    [uvU0 + u0, uvV0 + v0], [uvU0 + u1, uvV0 + v0], [uvU0 + u1, uvV0 + v1], [uvU0 + u0, uvV0 + v1],
  ]);
}

/**
 * Emit a wall of length L and height H with openings. `uvOffset` continues the texture around corners.
 * `vBase` offsets texture v (so stacked wall bands line up).
 */
export function buildWall(
  wr: FacadeWriters, f: WallFrame, L: number, H: number, openings: Opening[], style: WallStyle, uvOffset = 0, vBase = 0,
): void {
  const us = new Set([0, L]);
  const vs = new Set([0, H]);
  for (const o of openings) {
    us.add(o.u); us.add(o.u + o.w);
    vs.add(o.v); vs.add(o.v + o.h);
  }
  const U = [...us].filter((u) => u >= 0 && u <= L).sort((a, b) => a - b);
  const V = [...vs].filter((v) => v >= 0 && v <= H).sort((a, b) => a - b);
  const inside = (u: number, v: number) => openings.some((o) => u > o.u && u < o.u + o.w && v > o.v && v < o.v + o.h);
  // Merge horizontally adjacent solid cells into runs to keep the triangle count low.
  for (let j = 0; j < V.length - 1; j++) {
    const v0 = V[j], v1 = V[j + 1], vc = (v0 + v1) / 2;
    let runStart: number | null = null;
    for (let i = 0; i < U.length - 1; i++) {
      const solid = !inside((U[i] + U[i + 1]) / 2, vc);
      if (solid && runStart === null) runStart = U[i];
      if (!solid && runStart !== null) {
        wallQuad(wr.wall, f, runStart, v0, U[i], v1, 0, uvOffset, vBase);
        runStart = null;
      }
    }
    if (runStart !== null) wallQuad(wr.wall, f, runStart, v0, U[U.length - 1], v1, 0, uvOffset, vBase);
  }
  for (const o of openings) buildOpening(wr, f, o, style, uvOffset, vBase);
}

function buildOpening(wr: FacadeWriters, f: WallFrame, o: Opening, style: WallStyle, uvOffset: number, vBase: number) {
  const r = o.kind === 'shop' ? 0.12 : style.recess;
  const { u, v, w, h } = o;
  const R = wr.reveal;
  const uv = (a: number, b: number): [number, number] => [uvOffset + a, vBase + b];
  // reveals: head (faces down), sill (faces up), jambs
  R.quad(f.at(u, v + h, -r), f.at(u + w, v + h, -r), f.at(u + w, v + h, 0), f.at(u, v + h, 0), [uv(u, 0), uv(u + w, 0), uv(u + w, r), uv(u, r)]);
  R.quad(f.at(u, v, 0), f.at(u + w, v, 0), f.at(u + w, v, -r), f.at(u, v, -r), [uv(u, 0), uv(u + w, 0), uv(u + w, r), uv(u, r)]);
  R.quad(f.at(u, v, 0), f.at(u, v, -r), f.at(u, v + h, -r), f.at(u, v + h, 0), [uv(0, v), uv(r, v), uv(r, v + h), uv(0, v + h)]);
  R.quad(f.at(u + w, v, -r), f.at(u + w, v, 0), f.at(u + w, v + h, 0), f.at(u + w, v + h, -r), [uv(0, v), uv(r, v), uv(r, v + h), uv(0, v + h)]);

  if (o.kind === 'door') {
    buildDoor(wr, f, o, r, style);
    return;
  }

  // glass pane, recessed (aRoom is only defined on interior-mapped glass writers; elsewhere it is ignored)
  wr.glass.setExtra('aWin', [o.tile ?? 0, o.lit ?? 0]);
  wr.glass.setExtra('aRoom', [w, h, o.sill ?? o.v, o.side ?? (o.kind === 'shop' ? 2.5 : 0.9)]);
  const gw = -r + 0.02;
  wr.glass.quad(f.at(u, v, gw), f.at(u + w, v, gw), f.at(u + w, v + h, gw), f.at(u, v + h, gw), [[0, 0], [1, 0], [1, 1], [0, 1]]);

  // frame: border bars + mullions/transom
  const fw = o.kind === 'shop' ? 0.09 : style.frameW;
  const fd = 0.07;
  const fz = gw + fd / 2 - 0.005;
  const F = wr.frame;
  F.setColor(style.frameColor);
  const bar = (cu: number, cv: number, bw: number, bh: number) => F.box(f.matrix(cu, cv, fz), bw, bh, fd, { skip: ['nz'] });
  bar(u + w / 2, v + fw / 2, w, fw);
  bar(u + w / 2, v + h - fw / 2, w, fw);
  bar(u + fw / 2, v + h / 2, fw, h - 2 * fw);
  bar(u + w - fw / 2, v + h / 2, fw, h - 2 * fw);
  if (style.paneGrid && o.kind === 'window') {
    const [cols, rows] = style.paneGrid;
    for (let k = 1; k < cols; k++) bar(u + (w * k) / cols, v + h / 2, fw * 0.55, h - 2 * fw);
    for (let k = 1; k < rows; k++) bar(u + w / 2, v + (h * k) / rows, w - 2 * fw, fw * 0.55);
  } else {
    const mullions = o.kind === 'shop' ? Math.max(1, Math.round(w / 1.6)) : w > style.mullionAbove ? 2 : 1;
    for (let k = 1; k < mullions; k++) bar(u + (w * k) / mullions, v + h / 2, fw * 0.8, h - 2 * fw);
    const transom = o.kind === 'shop' ? 0.78 : style.transom;
    if (transom > 0) bar(u + w / 2, v + h * transom, w - 2 * fw, fw * 0.8);
  }

  if (style.sills && o.kind === 'window') {
    wr.sill.setColor(style.sillColor);
    wr.sill.box(f.matrix(u + w / 2, v - 0.035, (0.07 - r) / 2), w + 0.14, 0.07, r + 0.07);
  }
  if (style.lintels && o.kind === 'window') {
    wr.sill.setColor(style.sillColor);
    wr.sill.box(f.matrix(u + w / 2, v + h + 0.09, 0.02), w + 0.24, 0.18, 0.04, { skip: ['nz'] });
  }
}

function buildDoor(wr: FacadeWriters, f: WallFrame, o: Opening, r: number, style: WallStyle) {
  const { u, v, w, h } = o;
  const D = wr.door;
  D.setColor(o.doorColor ?? [1, 1, 1]);
  const leafH = h > 2.6 ? h - 0.55 : h;
  const dz = -r + 0.03;
  // door leaf with two raised panels
  D.box(f.matrix(u + w / 2, v + leafH / 2, dz), w, leafH, 0.06, { skip: ['nz'] });
  const panelW = w * 0.32;
  for (const s of [-1, 1]) {
    D.box(f.matrix(u + w / 2 + s * w * 0.22, v + leafH * 0.3, dz + 0.035), panelW, leafH * 0.36, 0.02, { skip: ['nz'] });
    D.box(f.matrix(u + w / 2 + s * w * 0.22, v + leafH * 0.72, dz + 0.035), panelW, leafH * 0.34, 0.02, { skip: ['nz'] });
  }
  // transom light above tall doors
  if (leafH < h) {
    wr.glass.setExtra('aWin', [2, 0.6]);
    wr.glass.setExtra('aRoom', [w, (h - leafH) / 0.4, leafH, 0.8]);
    const gw = -r + 0.02;
    wr.glass.quad(f.at(u, v + leafH, gw), f.at(u + w, v + leafH, gw), f.at(u + w, v + h, gw), f.at(u, v + h, gw), [[0, 0], [1, 0], [1, 0.4], [0, 0.4]]);
  }
  // frame + handle
  const F = wr.frame;
  F.setColor(style.frameColor);
  const fw = 0.08;
  F.box(f.matrix(u + fw / 2, v + h / 2, dz + 0.02), fw, h, 0.09, { skip: ['nz'] });
  F.box(f.matrix(u + w - fw / 2, v + h / 2, dz + 0.02), fw, h, 0.09, { skip: ['nz'] });
  F.box(f.matrix(u + w / 2, v + h - fw / 2, dz + 0.02), w, fw, 0.09, { skip: ['nz'] });
  if (leafH < h) F.box(f.matrix(u + w / 2, v + leafH, dz + 0.02), w, fw * 0.8, 0.09, { skip: ['nz'] });
  F.setColor([0.75, 0.62, 0.35]);
  F.box(f.matrix(u + w * 0.82, v + 1.02, dz + 0.08), 0.04, 0.18, 0.05);
}

/** Evenly spaced window openings for a band of floors. */
export function windowGrid(
  L: number, opts: { floors: number; floorH: number; baseV: number; winW: number; winH: number; sillH: number; margin: number; spacing: number },
  pickTile: () => number, pickLit: () => number,
): Opening[] {
  const usable = L - 2 * opts.margin;
  const n = Math.max(1, Math.floor((usable - opts.winW) / opts.spacing) + 1);
  const span = (n - 1) * opts.spacing + opts.winW;
  const start = (L - span) / 2;
  const out: Opening[] = [];
  for (let f = 0; f < opts.floors; f++) {
    for (let i = 0; i < n; i++) {
      out.push({ u: start + i * opts.spacing, v: opts.baseV + f * opts.floorH + opts.sillH, w: opts.winW, h: opts.winH, kind: 'window', tile: pickTile(), lit: pickLit(), sill: opts.sillH });
    }
  }
  return out;
}
