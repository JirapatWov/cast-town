// Project building styles, modelled in lot-local space (lot centre at origin, street side = +Z, lot 20 × 24 m).
// Every style stacks `floors` storeys of STOREY_H (shared/house-plan.ts) between a ground-level site (garden,
// paths, fence) and a roof. Storey i is written into ctx.storey(i) and the roof into ctx.roof, so the project
// building can split off the newest storeys and the roof and animate them when a floor is added or removed.
//   house   — modern family house: white render + a timber-clad volume, balconies, metal gable roof, solar panels
//   cottage — brick cottage: shutters, flower boxes, string courses, steep shingle roof with dormers and a chimney
//   office  — glass office: curtain wall with aluminium fins and spandrels, lobby canopy, roof terrace and plant
//   studio  — brick loft: steel-grid windows, a fire escape, saw-tooth north lights and a timber water tank
import * as THREE from 'three';
import { STOREY_H } from '../../../../shared/house-plan';
import type { BuildingStyle } from '../../../../shared/protocol';
import { buildWall, DEFAULT_WALL_STYLE, type Opening, WallFrame, type WallStyle } from '../facade';
import type { ProjectGlassMaterial } from '../glass';
import { LAWN_Y } from '../layout';
import { type CityMaterials, TEX_MEAN, tint } from '../materials';
import type { Batch, MeshWriter } from '../util/mesh-writer';
import { type PlantPlacement, Vegetation } from '../vegetation';
import { balcony, band, flatRoof, gableRoof, type KitWriters, kitWriters, type Side, SIDES, sideFrames } from './kit';

export interface StyleResult {
  /** Roof top (local y, above the lawn). */
  height: number;
  /** Top of the storeys (local y, above the lawn); the roof sits on it. */
  wallTop: number;
  /** Door centre at ground level and outward facing (local). */
  door: THREE.Vector3;
  porchLight: THREE.Vector3;
  beacon: THREE.Vector3;
  /** Building footprint (local, axis-aligned): centre z offset + half extents. */
  footprint: { cx: number; cz: number; hw: number; hd: number };
  /** Where the name sign stands (local, facing the street). */
  sign: { x: number; z: number };
}

export interface StyleCtx {
  mats: CityMaterials;
  glass: ProjectGlassMaterial;
  rnd: () => number;
  /** Storeys, 1..MAX_FLOORS. */
  floors: number;
  /** Ground-level things that never move: garden, paths, fence, mailbox. */
  site: Batch;
  /** The batch storey i is written into. */
  storey(i: number): Batch;
  roof: Batch;
  /** Garden trees and shrubs (lot-local): the city instances them with wind and LODs. */
  plants: PlantPlacement[];
}

const S = STOREY_H;
const G = LAWN_Y;
const at = (x: number, y: number, z: number) => new THREE.Matrix4().makeTranslation(x, y, z);
const rotY = (a: number) => new THREE.Matrix4().makeRotationY(a);
const lin = (hex: number): [number, number, number] => {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
};

/** Lit windows: most rooms have a lamp so a busy floor glows across its whole width. */
const tileFor = (r: () => number) => () => [0, 2, 5, 0, 2, 4, 7][Math.floor(r() * 7)];
const litFor = (r: () => number) => () => (r() < 0.85 ? 0.75 + r() * 0.25 : 0.2);

/** One set of kit writers per batch (writers keep their colour state between calls). */
function kitCache(c: StyleCtx, wall: 'plaster' | 'brick') {
  const cache = new Map<Batch, KitWriters>();
  return (b: Batch): KitWriters => {
    let k = cache.get(b);
    if (!k) cache.set(b, (k = kitWriters(b, c.mats, wall, c.glass)));
    return k;
  };
}

function path(w: MeshWriter, x0: number, z0: number, x1: number, z1: number, y = G + 0.022) {
  w.quad({ x: x0, y, z: z1 }, { x: x1, y, z: z1 }, { x: x1, y, z: z0 }, { x: x0, y, z: z0 }, [[x0, z1], [x1, z1], [x1, z0], [x0, z0]]);
}

function cyl(w: MeshWriter, rTop: number, rBottom: number, h: number, m: THREE.Matrix4, seg = 12, open = false) {
  const g = new THREE.CylinderGeometry(rTop, rBottom, h, seg, 1, open);
  w.geometry(g, m);
  g.dispose();
}

/** A box tilted in the wall plane (stringers, braces): from (u0,v0) to (u1,v1) at depth w. */
function strut(wr: MeshWriter, f: WallFrame, u0: number, v0: number, u1: number, v1: number, w: number, t: number, d = t) {
  const len = Math.hypot(u1 - u0, v1 - v0);
  const m = f.matrix((u0 + u1) / 2, (v0 + v1) / 2, w).multiply(new THREE.Matrix4().makeRotationZ(Math.atan2(v1 - v0, u1 - u0)));
  wr.box(m, len, t, d);
}

/** A box between two points (tie rods, braces), `t`×`d` in section. */
function rod(w: MeshWriter, a: THREE.Vector3, b: THREE.Vector3, t: number, d = t) {
  const dir = b.clone().sub(a);
  const up = Math.abs(dir.normalize().y) > 0.99 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  w.box(new THREE.Matrix4().lookAt(a, b, up).setPosition(a.clone().add(b).multiplyScalar(0.5)), t, d, a.distanceTo(b));
}

/** Lantern by the door: a small box housing + the emissive bulb (bulb mesh is created by the caller). */
function wallLantern(k: KitWriters, f: WallFrame, u: number, v: number) {
  k.metal.box(f.matrix(u, v, 0.12), 0.2, 0.32, 0.2);
  k.metal.box(f.matrix(u, v + 0.2, 0.12), 0.26, 0.05, 0.26);
}

function mailbox(k: KitWriters, x: number, z: number) {
  k.wood.setColor([0.8, 0.75, 0.7]);
  k.wood.box(at(x, G + 0.55, z), 0.1, 1.1, 0.1);
  k.metal.box(at(x, G + 1.2, z), 0.3, 0.26, 0.48);
}

/** Rain-water downpipe segment for one storey, with a bracket. */
function downpipe(k: KitWriters, m: THREE.Matrix4, x: number, z: number, y0: number, h = S) {
  cyl(k.metal, 0.05, 0.05, h, at(x, y0 + h / 2, z).premultiply(m), 8, true);
  k.metal.box(at(x, y0 + h * 0.55, z).premultiply(m), 0.14, 0.05, 0.14);
}

// ───────────────────────────── house ─────────────────────────────
function house(c: StyleCtx): StyleResult {
  const { mats, rnd, floors: N } = c;
  const kit = kitCache(c, 'plaster');
  const W = 11.5, D = 8.4, cx = -1.2, cz = -1.6, hw = W / 2, hd = D / 2, H = N * S, rise = 2.5;
  const m = at(cx, G, cz);
  const P = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).applyMatrix4(m);
  const tiles = tileFor(rnd), lit = litFor(rnd);
  const render = tint(0xf4efe6, TEX_MEAN.plaster);
  const style: WallStyle = { ...DEFAULT_WALL_STYLE, frameColor: [0.1, 0.11, 0.12], sillColor: [0.2, 0.21, 0.22], recess: 0.18, frameW: 0.06 };
  const win = (u: number, v: number, w: number, h: number, sill?: number): Opening => ({ u, v, w, h, kind: 'window', tile: tiles(), lit: lit(), sill });
  const doorU = 2.4, timberW = 5.1;

  for (let i = 0; i < N; i++) {
    const k = kit(c.storey(i));
    const y0 = i * S;
    const fr = sideFrames(m, W, D, y0);
    k.wall.setColor(render);
    if (i === 0) {
      buildWall(k, fr.front.f, W, S, [
        { u: doorU, v: 0, w: 1.1, h: 2.4, kind: 'door', doorColor: [0.55, 0.42, 0.32] },
        win(doorU + 1.25, 0.05, 0.5, 2.3, 0.05),
        win(5.4, 0.45, 3.6, 2.1),
      ], style, fr.front.uv, y0);
    } else {
      // upper floors: a timber-clad volume on the left (6 cm proud of the render, flush under the eaves),
      // render + balcony on the right
      const proud = i < N - 1 ? 0.06 : 0;
      const ft = new WallFrame(m, -hw, hd + proud, -hw + timberW, hd + proud, y0);
      k.wood.setColor([1.22, 1.08, 0.9]);
      buildWall({ ...k, wall: k.wood, reveal: k.wood }, ft, timberW, S, [win(0.8, 0.3, 0.62, 2.35), win(2.15, 0.8, 2.25, 1.45)], style, 0, y0);
      const xr = -hw + timberW;
      if (proud) {
        k.wood.quad(P(-hw, y0, hd), P(-hw, y0, hd + proud), P(-hw, y0 + S, hd + proud), P(-hw, y0 + S, hd));
        k.wood.quad(P(xr, y0, hd + proud), P(xr, y0, hd), P(xr, y0 + S, hd), P(xr, y0 + S, hd + proud));
      }
      const fs = new WallFrame(m, xr, hd, hw, hd, y0);
      k.wall.setColor(render);
      buildWall(k, fs, W - timberW, S, [win(0.75, 0.1, 1.6, 2.4, 0.1), win(3.75, 0.8, 1.6, 1.45)], style, timberW, y0);
      balcony(k, fs, 1.55, 0.08, 2.6, 1.15);
      // a couple of potted plants on each balcony
      const veg = new Vegetation();
      for (const du of [0.55, 2.45]) {
        const q = fs.at(du, 0.08, 0.75);
        k.trim.setColor([0.62, 0.34, 0.24]);
        k.trim.box(at(q.x, q.y + 0.18, q.z), 0.34, 0.36, 0.34);
        veg.addShrub(q.x, q.z, q.y + 0.34, 0.36 + 0.08 * rnd());
      }
      veg.mergeInto(c.storey(i), mats);
    }
    k.wall.setColor(render);
    buildWall(k, fr.back.f, W, S, i === 0 ? [win(1.2, 0.05, 4.2, 2.4, 0.05), win(7.0, 0.8, 1.6, 1.4)] : [win(1.6, 0.8, 1.5, 1.45), win(5.0, 0.8, 1.5, 1.45), win(8.4, 0.8, 1.5, 1.45)], style, fr.back.uv, y0);
    for (const side of ['right', 'left'] as const) {
      const { f, L, uv } = fr[side];
      k.wall.setColor(render);
      buildWall(k, f, L, S, i === 0 ? [win(L / 2 - 0.7, 0.8, 1.4, 1.4)] : [win(1.3, 0.85, 1.2, 1.3), win(L - 2.5, 0.85, 1.2, 1.3)], style, uv, y0);
    }
    if (i === 0) {
      k.stone.setColor([0.55, 0.55, 0.56]);
      band(k.stone, m, W, D, 0, 0.35, 0.03);
    }
    if (i < N - 1) {
      k.trim.setColor([0.13, 0.13, 0.14]);
      band(k.trim, m, W, D, y0 + S - 0.07, 0.14, 0.09);
    }
    for (const sx of [-1, 1]) downpipe(k, m, sx * (hw + 0.08), hd - 0.25, y0);
  }

  // porch canopy on slim posts + lantern
  const k0 = kit(c.storey(0));
  const fr0 = sideFrames(m, W, D);
  const fz = cz + hd;
  k0.trim.setColor([0.95, 0.94, 0.92]);
  k0.trim.box(at(cx - hw + doorU + 0.85, G + 2.7, fz + 0.85), 2.9, 0.16, 1.7);
  k0.metal.box(at(cx - hw + doorU + 0.85 - 1.35, G + 1.35, fz + 1.6), 0.08, 2.7, 0.08);
  k0.metal.box(at(cx - hw + doorU + 0.85 + 1.35, G + 1.35, fz + 1.6), 0.08, 2.7, 0.08);
  wallLantern(k0, fr0.front.f, doorU - 0.35, 1.95);

  // roof: standing-seam metal gable, gutters, solar panels on the street slope, a flue
  const kr = kit(c.roof);
  kr.wall.setColor(render);
  kr.roofMetal.setColor([0.22, 0.23, 0.25]);
  const o = 0.55, go = 0.35;
  gableRoof(kr, kr.roofMetal, m, W, D, H, rise, { overhang: o, gableOverhang: go, fasciaColor: [0.16, 0.16, 0.17] });
  const drop = (o / hd) * rise;
  for (const s of [-1, 1]) cyl(kr.metal, 0.07, 0.07, W + 2 * go, at(0, H - drop - 0.06, s * (hd + o - 0.02)).premultiply(m).multiply(new THREE.Matrix4().makeRotationZ(Math.PI / 2)), 8, true);
  const hdo = hd + o;
  const slopeAngle = Math.atan2(rise + drop, hdo);
  kr.frame.setColor([0.05, 0.08, 0.16]);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 2; j++) {
      const t = 0.32 + j * 0.3;
      const z = cz + hdo * (1 - t), y = G + H - drop + (rise + drop) * t + 0.08;
      kr.frame.box(at(cx + 1.4 + i * 1.12, y, z).multiply(new THREE.Matrix4().makeRotationX(-slopeAngle)), 1.04, 0.05, 1.27);
    }
  }
  cyl(kr.metal, 0.09, 0.09, 1.3, at(cx - 3.4, G + H + rise * 0.55 + 0.45, cz - 1.5), 10);
  cyl(kr.metal, 0.16, 0.12, 0.12, at(cx - 3.4, G + H + rise * 0.55 + 1.15, cz - 1.5), 10);

  // site: step, path, driveway, hedges, trees, shrubs, flower strip, mailbox
  const ks = kit(c.site);
  ks.stone.setColor([0.9, 0.88, 0.85]);
  ks.stone.box(at(cx - hw + doorU + 0.55, G + 0.08, fz + 0.5), 1.8, 0.16, 1.0);
  const paving = c.site.writer(mats.paving, { cast: false });
  const doorX = cx - hw + doorU + 0.55;
  path(paving, doorX - 0.65, fz + 1.0, doorX + 0.65, 12);
  path(c.site.writer(mats.sidewalk, { cast: false }), 5.6, -4, 8.6, 12, G + 0.02);
  const veg = new Vegetation();
  veg.addHedge(-7.3, 11.4, G, 4.2, 0, 0.9, 0.7);
  veg.addHedge(1.2, 11.4, G, 8.0, 0, 0.9, 0.7);
  veg.addHedge(-9.5, 0, G, 22, Math.PI / 2, 1.1, 0.7);
  veg.addHedge(9.5, -1.5, G, 19, Math.PI / 2, 1.1, 0.7);
  veg.addTree('broadleaf', -6.5, -8.5, G, 1.05 + 0.06 * N);
  veg.addTree('columnar', 7.5, -9, G, 0.9 + 0.05 * N);
  veg.addTree('broadleaf', -7.6, 7.5, G, 0.7);
  for (let i = 0; i < 5; i++) veg.addShrub(cx + 2.4 + i * 1.05, fz + 0.9, G, 0.55);
  for (let i = 0; i < 40; i++) veg.addFlower(-6.5 + rnd() * 4.5, fz + 0.4 + rnd() * 1.1, G, [0xf2c14e, 0xf7f3e8, 0xd97757][i % 3]);
  veg.mergeInto(c.site, mats, c.plants);
  mailbox(ks, doorX - 0.95, 11.6);
  return {
    sign: { x: -7.3, z: 10.3 },
    height: H + rise,
    wallTop: H,
    door: new THREE.Vector3(doorX, 0, fz),
    porchLight: fr0.front.f.at(doorU - 0.35, 1.95, 0.23),
    beacon: new THREE.Vector3(cx + 3.6, G + H + rise + 0.12, cz),
    footprint: { cx, cz, hw: hw + 0.4, hd: hd + 0.4 },
  };
}

// ───────────────────────────── cottage ─────────────────────────────
function cottage(c: StyleCtx): StyleResult {
  const { mats, rnd, floors: N } = c;
  const kit = kitCache(c, 'brick');
  const W = 9.6, D = 7.4, cx = 0, cz = -1.2, hw = W / 2, hd = D / 2, H = N * S, rise = 3.7;
  const m = at(cx, G, cz);
  const tiles = tileFor(rnd), lit = litFor(rnd);
  const brick: [number, number, number] = [1.08, 0.96, 0.9];
  const white: [number, number, number] = [0.96, 0.95, 0.92];
  const sage = lin(0x5f7a64);
  const style: WallStyle = { ...DEFAULT_WALL_STYLE, frameColor: white, sillColor: [0.95, 0.93, 0.88], lintels: true, transom: 0.68 };
  const win = (u: number, v: number, w: number, h: number): Opening => ({ u, v, w, h, kind: 'window', tile: tiles(), lit: lit() });
  const flowers = [0xd97757, 0xf2c14e, 0xc45a7a, 0xf7f3e8, 0x8e75f0];
  const sideU = [1.3, W - 2.55];

  for (let i = 0; i < N; i++) {
    const b = c.storey(i);
    const k = kit(b);
    const y0 = i * S;
    const wv = i === 0 ? 0.9 : 0.85;
    k.wall.setColor(brick);
    const openings = (side: Side, L: number): Opening[] => {
      if (side === 'front') {
        return i === 0
          ? [win(sideU[0], wv, 1.25, 1.45), { u: L / 2 - 0.5, v: 0, w: 1.0, h: 2.25, kind: 'door', doorColor: lin(0x3e5a46) }, win(sideU[1], wv, 1.25, 1.45)]
          : [win(sideU[0], wv, 1.25, 1.45), win(L / 2 - 0.45, 1.0, 0.9, 1.2), win(sideU[1], wv, 1.25, 1.45)];
      }
      if (side === 'back') return [win(1.6, 0.9, 1.2, 1.4), win(L - 2.8, 0.9, 1.2, 1.4)];
      return [win(L / 2 - 0.6, 0.9, 1.2, 1.4)];
    };
    const fr = sideFrames(m, W, D, y0);
    for (const s of SIDES) {
      k.wall.setColor(brick);
      // painted doors use the plain trim material
      buildWall({ ...k, door: k.trim }, fr[s].f, fr[s].L, S, openings(s, fr[s].L), style, fr[s].uv, y0);
    }
    // shutters beside the front windows, flower boxes upstairs
    const veg = new Vegetation();
    for (const u of sideU) {
      k.trim.setColor(sage);
      k.trim.box(fr.front.f.matrix(u - 0.33, wv + 0.72, 0.05), 0.55, 1.5, 0.05);
      k.trim.box(fr.front.f.matrix(u + 1.25 + 0.33, wv + 0.72, 0.05), 0.55, 1.5, 0.05);
      // louvres on the shutters
      k.frame.setColor([sage[0] * 0.8, sage[1] * 0.8, sage[2] * 0.8]);
      for (let l = 0; l < 7; l++) {
        k.frame.box(fr.front.f.matrix(u - 0.33, wv + 0.18 + l * 0.18, 0.08), 0.46, 0.025, 0.02);
        k.frame.box(fr.front.f.matrix(u + 1.58, wv + 0.18 + l * 0.18, 0.08), 0.46, 0.025, 0.02);
      }
      if (i > 0) {
        k.wood.setColor([0.55, 0.42, 0.32]);
        k.wood.box(fr.front.f.matrix(u + 0.625, wv - 0.2, 0.17), 1.35, 0.22, 0.26);
        const p = fr.front.f;
        for (let n = 0; n < 14; n++) {
          const q = p.at(u + 0.05 + (n / 13) * 1.15, wv - 0.08, 0.1 + rnd() * 0.12);
          veg.addFlower(q.x, q.z, q.y - 0.02, flowers[Math.floor(rnd() * flowers.length)]);
        }
      }
    }
    veg.mergeInto(b, mats);
    if (i === 0) {
      k.stone.setColor([0.75, 0.72, 0.68]);
      band(k.stone, m, W, D, 0, 0.4, 0.04);
    }
    if (i < N - 1) {
      k.stone.setColor([0.86, 0.83, 0.78]);
      band(k.stone, m, W, D, y0 + S - 0.09, 0.18, 0.05);
    }
    downpipe(k, m, -hw - 0.07, hd - 0.2, y0);
  }

  // little gabled porch roof on brackets + lantern
  const k0 = kit(c.storey(0));
  const fr0 = sideFrames(m, W, D);
  const fz = cz + hd;
  k0.wall.setColor(brick);
  k0.roofShingle.setColor(tint(0x9a5a42, TEX_MEAN.shingle));
  gableRoof(k0, k0.roofShingle, at(cx, G + 2.55, fz + 0.55).multiply(rotY(Math.PI / 2)), 1.1, 1.8, 0, 0.55, { overhang: 0.12, gableOverhang: 0.05, fasciaColor: white });
  k0.trim.setColor(white);
  for (const s of [-1, 1]) strut(k0.trim, fr0.front.f, hw + s * 0.85, 2.0, hw + s * 0.85, 2.5, 0.5, 0.08, 0.9);
  wallLantern(k0, fr0.front.f, hw + 0.85, 1.9);

  // roof: steep shingles, chimney with pots, gable attic windows, two dormers on the street slope
  const kr = kit(c.roof);
  kr.wall.setColor(brick);
  kr.roofShingle.setColor(tint(0x9a5a42, TEX_MEAN.shingle));
  gableRoof(kr, kr.roofShingle, m, W, D, H, rise, { overhang: 0.45, gableOverhang: 0.3, fasciaColor: [0.94, 0.93, 0.9] });
  kr.wall.setColor([1.0, 0.88, 0.82]);
  kr.wall.box(at(cx + 2.9, G + H + 2.2, cz - 1.1), 0.9, 4.4, 0.75, { skip: ['ny'] });
  kr.stone.setColor([0.7, 0.68, 0.65]);
  kr.stone.box(at(cx + 2.9, G + H + 4.45, cz - 1.1), 1.05, 0.12, 0.9);
  kr.trim.setColor([0.62, 0.32, 0.22]);
  for (const dx of [-0.2, 0.2]) cyl(kr.trim, 0.09, 0.11, 0.42, at(cx + 2.9 + dx, G + H + 4.72, cz - 1.1), 10);
  const frR = sideFrames(m, W, D);
  for (const f of [frR.right.f, frR.left.f]) {
    const u0 = hd - 0.45, v0 = H + 0.9;
    kr.glass.setExtra('aWin', [0, 0.8]);
    kr.glass.setExtra('aRoom', [0.9, 1.0, 0.7, 0.4]);
    kr.glass.quad(f.at(u0, v0, 0.04), f.at(u0 + 0.9, v0, 0.04), f.at(u0 + 0.9, v0 + 1.0, 0.04), f.at(u0, v0 + 1.0, 0.04));
    kr.frame.setColor(white);
    kr.frame.box(f.matrix(u0 + 0.45, v0 - 0.04, 0.07), 1.08, 0.08, 0.08);
    kr.frame.box(f.matrix(u0 + 0.45, v0 + 1.04, 0.07), 1.08, 0.08, 0.08);
    kr.frame.box(f.matrix(u0 - 0.04, v0 + 0.5, 0.07), 0.08, 1.0, 0.08);
    kr.frame.box(f.matrix(u0 + 0.94, v0 + 0.5, 0.07), 0.08, 1.0, 0.08);
    kr.frame.box(f.matrix(u0 + 0.45, v0 + 0.5, 0.07), 0.05, 1.0, 0.06);
  }
  const roofAt = (z: number) => H + rise * (1 - z / hd);
  for (const dx of [-2.3, 2.3]) {
    const dw = 1.5, zf = hd - 1.05;
    const yb = roofAt(zf) - 0.1, yt = yb + 1.3;
    const zb = hd * (1 - (yt - H) / rise);
    const f = new WallFrame(m, dx - dw / 2, zf, dx + dw / 2, zf, yb);
    kr.trim.setColor(white);
    buildWall({ ...kr, wall: kr.trim, reveal: kr.trim }, f, dw, yt - yb, [{ u: 0.3, v: 0.18, w: 0.9, h: 0.95, kind: 'window', tile: tiles(), lit: lit(), sill: 0.9, side: 0.5 }], style, 0, 0);
    // shingle-clad cheeks back to the main slope
    const Pm = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).applyMatrix4(m);
    const xl = dx - dw / 2, xr = dx + dw / 2;
    kr.roofShingle.quad(Pm(xl, yb, zb), Pm(xl, yb, zf), Pm(xl, yt, zf), Pm(xl, yt, zb), [[0, 0], [zf - zb, 0], [zf - zb, yt - yb], [0, yt - yb]]);
    kr.roofShingle.quad(Pm(xr, yb, zf), Pm(xr, yb, zb), Pm(xr, yt, zb), Pm(xr, yt, zf), [[0, 0], [zf - zb, 0], [zf - zb, yt - yb], [0, yt - yb]]);
    const len = zf - zb + 0.65;
    kr.wall.setColor(brick);
    gableRoof(kr, kr.roofShingle, at(cx + dx, G + yt, cz + zf - len / 2).multiply(rotY(Math.PI / 2)), len, dw, 0, 0.6, { overhang: 0.14, gableOverhang: 0.06, fasciaColor: white });
  }

  // site: stepping stones, picket fence with a gate gap, flowers, trees
  const ks = kit(c.site);
  const paving = c.site.writer(mats.paving, { cast: false });
  for (let z = fz + 0.8; z < 11.6; z += 1.0) path(paving, -0.55, z, 0.55, z + 0.7);
  ks.trim.setColor([0.97, 0.96, 0.93]);
  for (let x = -9.6; x <= 9.6; x += 0.16) {
    if (Math.abs(x) < 0.85) continue;
    ks.trim.box(at(x, G + 0.45, 11.5), 0.07, 0.9, 0.03);
  }
  for (const y of [0.62, 0.25]) for (const x of [-5.2, 5.2]) ks.trim.box(at(x, G + y, 11.48), 8.8, 0.06, 0.04);
  const veg = new Vegetation();
  for (let i = 0; i < 160; i++) {
    const side = i % 2 ? 1 : -1;
    veg.addFlower(side * (1.1 + rnd() * 3.5), fz + 0.35 + rnd() * 1.2, G, flowers[Math.floor(rnd() * flowers.length)]);
  }
  for (let i = 0; i < 70; i++) veg.addFlower(-9 + rnd() * 18, 10.6 + rnd() * 0.6, G, flowers[Math.floor(rnd() * flowers.length)]);
  for (const x of [-4.2, -2.2, 2.2, 4.2]) veg.addShrub(x, fz + 0.45, G, 0.6);
  veg.addTree('broadleaf', -6.5, -7.5, G, 1.0 + 0.05 * N, { autumn: rnd() < 0.5 });
  veg.addTree('broadleaf', 6.8, -8, G, 0.85 + 0.05 * N);
  veg.addTree('conifer', 7.5, 4, G, 0.6);
  veg.addHedge(-9.6, -1, G, 21, Math.PI / 2, 1.0, 0.6);
  veg.addHedge(9.6, -1, G, 21, Math.PI / 2, 1.0, 0.6);
  veg.mergeInto(c.site, mats, c.plants);
  mailbox(ks, 1.4, 11.0);
  return {
    sign: { x: -2.6, z: 10.6 },
    height: H + rise,
    wallTop: H,
    door: new THREE.Vector3(cx, 0, fz),
    porchLight: fr0.front.f.at(hw + 0.85, 1.9, 0.23),
    beacon: new THREE.Vector3(cx - 2.5, G + H + rise + 0.12, cz),
    footprint: { cx, cz, hw: hw + 0.4, hd: hd + 0.4 },
  };
}

// ───────────────────────────── office ─────────────────────────────
function office(c: StyleCtx): StyleResult {
  const { mats, rnd, floors: N } = c;
  const kit = kitCache(c, 'plaster');
  const W = 13, D = 12, cx = 0, cz = -2.5, hw = W / 2, hd = D / 2, H = N * S;
  const m = at(cx, G, cz);
  const mullion: [number, number, number] = [0.13, 0.14, 0.15];
  const fin: [number, number, number] = [0.3, 0.25, 0.2];
  const spandrel: [number, number, number] = [0.84, 0.81, 0.76];
  for (let i = 0; i < N; i++) {
    const k = kit(c.storey(i));
    const y0 = i * S;
    const fr = sideFrames(m, W, D, y0);
    const g0 = i === 0 ? 0.3 : 0.05, g1 = i === 0 ? S - 0.42 : S - 0.6;
    for (const side of SIDES) {
      const { f, L } = fr[side];
      const cols = Math.round(L / 1.6), cw = L / cols;
      const entrance = i === 0 && side === 'front';
      for (let col = 0; col < cols; col++) {
        const u0 = col * cw, u1 = u0 + cw;
        const isDoor = entrance && (col === cols / 2 - 1 || col === cols / 2);
        k.glass.setExtra('aWin', [6, isDoor ? 0.6 : rnd() < 0.82 ? 0.85 : 0.12]);
        k.glass.setExtra('aRoom', [cw, g1 - g0, g0, i === 0 ? 3.0 : 5.0]);
        k.glass.quad(f.at(u0, g0, -0.06), f.at(u1, g0, -0.06), f.at(u1, g1, -0.06), f.at(u0, g1, -0.06));
        if (isDoor) {
          // glass doors: frame, transom bar, push bars
          k.frame.setColor(mullion);
          k.frame.box(f.matrix((u0 + u1) / 2, 2.35, -0.02), cw, 0.08, 0.1);
          k.frame.box(f.matrix((u0 + u1) / 2, g0 + 0.04, -0.02), cw, 0.08, 0.1);
          k.frame.setColor([0.75, 0.76, 0.78]);
          k.frame.box(f.matrix(col === cols / 2 - 1 ? u1 - 0.18 : u0 + 0.18, 1.1, 0.02), 0.04, 0.9, 0.06);
        }
      }
      // spandrel band (slab edge) and its shadow line, mullions, fins on the long faces
      k.trim.setColor(spandrel);
      k.trim.box(f.matrix(L / 2, (g1 + S) / 2 + 0.02, 0.03), L + 0.08, S - g1 - 0.04, 0.18);
      k.frame.setColor([0.05, 0.05, 0.06]);
      k.frame.box(f.matrix(L / 2, g1 + 0.02, -0.02), L, 0.05, 0.08);
      k.frame.setColor(mullion);
      for (let col = 1; col < cols; col++) k.frame.box(f.matrix(col * cw, (g0 + g1) / 2, -0.01), 0.07, g1 - g0, 0.12);
      if (side === 'front' || side === 'back') {
        k.frame.setColor(fin);
        for (let col = 1; col < cols; col++) {
          if (entrance && Math.abs(col - cols / 2) <= 1) continue;
          k.frame.box(f.matrix(col * cw, S / 2, 0.2), 0.06, S, 0.34);
        }
      }
    }
    // corner piers
    k.trim.setColor([0.8, 0.77, 0.72]);
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) k.trim.box(at(sx * (hw - 0.08), y0 + S / 2, sz * (hd - 0.08)).premultiply(m), 0.36, S, 0.36);
    if (i === 0) {
      k.stone.setColor([0.38, 0.38, 0.4]);
      band(k.stone, m, W, D, 0, 0.3, 0.04);
    }
  }
  // lobby canopy on two steel columns, with a soffit light strip
  const k0 = kit(c.storey(0));
  const fr0 = sideFrames(m, W, D);
  k0.trim.setColor([0.95, 0.95, 0.94]);
  k0.trim.box(fr0.front.f.matrix(hw, S - 0.3, 1.95), 6.4, 0.24, 3.9);
  k0.frame.setColor([0.18, 0.19, 0.2]);
  k0.frame.box(fr0.front.f.matrix(hw, S - 0.16, 3.9), 6.4, 0.06, 0.04);
  for (const s of [-1, 1]) cyl(k0.metal, 0.08, 0.08, S - 0.42, fr0.front.f.matrix(hw + s * 2.7, (S - 0.42) / 2, 3.5), 12);

  // roof: parapet in metal panels with a coping, plant penthouse with louvres, HVAC with fans, solar rows,
  // a timber-decked roof terrace with planters
  const kr = kit(c.roof);
  const ph = 1.0, t = 0.25;
  kr.roofFlat.box(at(0, H + 0.02, 0).premultiply(m), W - 0.02, 0.04, D - 0.02, { skip: ['ny'] });
  kr.trim.setColor([0.24, 0.25, 0.27]);
  kr.trim.box(at(0, H + ph / 2, hd - t / 2).premultiply(m), W, ph, t, { skip: ['ny'] });
  kr.trim.box(at(0, H + ph / 2, -hd + t / 2).premultiply(m), W, ph, t, { skip: ['ny'] });
  kr.trim.box(at(hw - t / 2, H + ph / 2, 0).premultiply(m), t, ph, D - 2 * t, { skip: ['ny'] });
  kr.trim.box(at(-hw + t / 2, H + ph / 2, 0).premultiply(m), t, ph, D - 2 * t, { skip: ['ny'] });
  kr.trim.setColor([0.8, 0.81, 0.83]);
  band(kr.trim, m, W, D, H + ph, 0.07, 0.04);
  const R = (x: number, y: number, z: number) => at(x, H + y, z).premultiply(m);
  // plant penthouse (back left), louvred; a single-storey pavilion gets a low plant screen instead
  const px = -3.2, pz = -3.4, pw = 4.0, pd = 2.8, pH = N > 1 ? 2.5 : 1.2;
  kr.trim.setColor([0.36, 0.37, 0.39]);
  kr.trim.box(R(px, pH / 2, pz), pw, pH, pd, { skip: ['ny'] });
  kr.roofFlat.box(R(px, pH + 0.06, pz), pw + 0.3, 0.12, pd + 0.3);
  kr.frame.setColor([0.5, 0.51, 0.53]);
  for (let y = 0.35; y < pH - 0.2; y += 0.18) {
    kr.frame.box(R(px, y, pz + pd / 2 + 0.04), pw - 0.3, 0.05, 0.08);
    kr.frame.box(R(px + pw / 2 + 0.04, y, pz), 0.08, 0.05, pd - 0.3);
  }
  if (N > 1) {
    kr.door.setColor([0.5, 0.52, 0.55]);
    kr.door.box(R(px - pw / 2 - 0.02, 1.05, pz + 0.6), 0.06, 2.1, 0.95);
  }
  // HVAC units with fans
  for (const [ux, uz] of [[2.6, -3.4], [4.4, -3.4], [2.6, -1.6]]) {
    kr.stone.setColor([0.86, 0.87, 0.88]);
    kr.stone.box(R(ux, 0.55, uz), 1.5, 1.0, 1.3, { skip: ['ny'] });
    kr.metal.box(R(ux, 0.04, uz), 1.6, 0.08, 1.4);
    for (const fx of [-0.36, 0.36]) {
      cyl(kr.metal, 0.3, 0.3, 0.08, R(ux + fx, 1.08, uz), 16);
      cyl(kr.frame, 0.26, 0.26, 0.02, R(ux + fx, 1.13, uz), 16);
    }
  }
  // solar rows (back right) on low frames
  kr.frame.setColor([0.05, 0.08, 0.16]);
  for (let r = 0; r < 2; r++) {
    for (let p = 0; p < 3; p++) {
      kr.frame.box(R(-5.0 + p * 1.15, 0.45, 0.35 - r * 1.5).multiply(new THREE.Matrix4().makeRotationX(-0.45)), 1.05, 0.05, 1.3);
      kr.metal.box(R(-5.0 + p * 1.15, 0.22, 0.75 - r * 1.5), 0.05, 0.44, 0.05);
    }
  }
  // roof terrace toward the street: decking, planters with grasses and two small trees, a slim balustrade
  kr.wood.setColor([0.9, 0.78, 0.62]);
  kr.wood.box(R(0.4, 0.07, 3.2), 10.8, 0.1, 4.2);
  const veg = new Vegetation();
  for (const [x, z, w, d] of [[-4.4, 3.2, 1.4, 3.6], [5.2, 3.2, 1.4, 3.6], [0.4, 5.0, 6.0, 0.8]] as const) {
    kr.stone.setColor([0.55, 0.55, 0.56]);
    kr.stone.box(R(x, 0.32, z), w, 0.55, d, { skip: ['ny'] });
    const n = Math.max(2, Math.round((w * d) / 1.1));
    for (let j = 0; j < n; j++) veg.addShrub(cx + x + (rnd() - 0.5) * (w - 0.4), cz + z + (rnd() - 0.5) * (d - 0.4), G + H + 0.6, 0.42 + rnd() * 0.15);
  }
  veg.addTree('columnar', cx - 4.4, cz + 2.2, G + H + 0.6, 0.42);
  veg.addTree('columnar', cx + 5.2, cz + 4.2, G + H + 0.6, 0.38);
  veg.mergeInto(c.roof, mats);
  kr.wood.setColor([0.75, 0.6, 0.45]);
  for (const x of [-1.6, 1.6]) kr.wood.box(R(x, 0.45, 2.6), 1.6, 0.08, 0.5);

  // site: plaza, planters with trees, bollards, hedges
  const ks = kit(c.site);
  path(c.site.writer(mats.paving, { cast: false }), -8.5, cz + hd, 8.5, 12);
  const sveg = new Vegetation();
  for (const x of [-6.5, 6.5]) {
    ks.stone.setColor([0.8, 0.79, 0.77]);
    ks.stone.box(at(x, G + 0.3, 7.5), 2.4, 0.6, 2.4);
    sveg.addTree('columnar', x, 7.5, G + 0.6, 0.75 + 0.04 * N);
  }
  ks.metal.setColor([1, 1, 1]);
  for (let x = -3; x <= 3; x += 1.5) cyl(ks.metal, 0.09, 0.1, 0.8, at(x, G + 0.4, 10.2), 10);
  sveg.addHedge(-9.6, -2, G, 18, Math.PI / 2, 1.0, 0.7);
  sveg.addHedge(9.6, -2, G, 18, Math.PI / 2, 1.0, 0.7);
  sveg.mergeInto(c.site, mats, c.plants);
  return {
    sign: { x: 3.6, z: 10.6 },
    height: H + ph,
    wallTop: H,
    door: new THREE.Vector3(cx, 0, cz + hd),
    porchLight: new THREE.Vector3(cx, S - 0.45 + G, cz + hd + 1.8),
    beacon: new THREE.Vector3(cx + 4.6, G + H + ph + 0.6, cz - 0.6),
    footprint: { cx, cz, hw: hw + 0.4, hd: hd + 0.4 },
  };
}

// ───────────────────────────── studio ─────────────────────────────
function studio(c: StyleCtx): StyleResult {
  const { mats, rnd, floors: N } = c;
  const kit = kitCache(c, 'brick');
  const W = 14, D = 10, cx = 0, cz = -2, hw = W / 2, hd = D / 2, H = N * S;
  const m = at(cx, G, cz);
  const brick: [number, number, number] = [1.25, 0.9, 0.76];
  const steel: [number, number, number] = [0.07, 0.075, 0.08];
  const style: WallStyle = {
    ...DEFAULT_WALL_STYLE, frameColor: [0.08, 0.09, 0.1], sillColor: [0.62, 0.6, 0.58], lintels: true, recess: 0.22, frameW: 0.07, paneGrid: [4, 3],
  };
  const lit = litFor(rnd);
  for (let i = 0; i < N; i++) {
    const k = kit(c.storey(i));
    const y0 = i * S;
    const fr = sideFrames(m, W, D, y0);
    for (const side of SIDES) {
      const { f, L, uv } = fr[side];
      const long = side === 'front' || side === 'back';
      const n = long ? 3 : 2, ww = long ? 3.1 : 2.6;
      const gap = (L - n * ww) / (n + 1);
      const out: Opening[] = [];
      for (let j = 0; j < n; j++) {
        const u = gap + j * (ww + gap);
        if (side === 'front' && i === 0 && j === 1) {
          out.push({ u: u + 0.55, v: 0, w: ww - 1.1, h: 2.85, kind: 'door', doorColor: [0.4, 0.4, 0.42] });
          continue;
        }
        const v = i === 0 ? 0.6 : 0.55;
        out.push({ u, v, w: ww, h: i === 0 ? 2.25 : 2.3, kind: 'window', tile: [2, 5, 0][j % 3], lit: lit(), sill: v });
      }
      k.wall.setColor(brick);
      buildWall({ ...k, door: k.metal as MeshWriter }, f, L, S, out, style, uv, y0);
    }
    if (i === 0) {
      k.stone.setColor([0.5, 0.5, 0.52]);
      band(k.stone, m, W, D, 0, 0.45, 0.04);
    }
    if (i < N - 1) {
      k.trim.setColor([0.58, 0.56, 0.53]);
      band(k.trim, m, W, D, y0 + S - 0.13, 0.26, 0.06);
    }
    downpipe(k, m, -hw - 0.07, hd - 0.3, y0);

    // fire escape on the right wall: a landing per upper storey, a stair from the one below, a drop ladder at the first
    if (i >= 1) {
      const f = fr.right.f;
      const u0 = 1.0, u1 = D - 1.0, dep = 1.2;
      k.frame.setColor(steel);
      k.frame.box(f.matrix((u0 + u1) / 2, -0.03, dep / 2), u1 - u0, 0.06, dep);
      for (const v of [0.95, 0.5]) k.frame.box(f.matrix((u0 + u1) / 2, v, dep - 0.02), u1 - u0, 0.04, 0.04);
      for (const u of [u0, u1]) for (const v of [0.95, 0.5]) k.frame.box(f.matrix(u, v, dep / 2), 0.04, 0.04, dep);
      for (let u = u0; u <= u1 + 1e-3; u += (u1 - u0) / 12) k.frame.box(f.matrix(u, 0.48, dep - 0.02), 0.03, 0.96, 0.03);
      for (const u of [u0 + 0.3, (u0 + u1) / 2, u1 - 0.3]) rod(k.frame, f.at(u, -0.85, 0.03), f.at(u, -0.06, dep - 0.08), 0.05);
      if (i >= 2) {
        const uTop = u0 + 0.35, uBot = uTop + 3.7, ws = dep - 0.45;
        for (const dw of [-0.33, 0.33]) strut(k.frame, f, uBot, -S + 0.02, uTop, 0.0, ws + dw, 0.16, 0.04);
        for (let s = 0; s < 11; s++) {
          const t = (s + 0.5) / 11;
          k.frame.box(f.matrix(uBot + (uTop - uBot) * t, -S + S * t, ws), 0.24, 0.03, 0.66);
        }
        for (const dw of [-0.36, 0.36]) strut(k.frame, f, uBot, -S + 0.95, uTop, 0.95, ws + dw, 0.035);
      } else {
        const ul = u1 - 0.75;
        for (const du of [-0.22, 0.22]) k.frame.box(f.matrix(ul + du, -S / 2 + 1.1, dep - 0.25), 0.04, S - 2.2, 0.04);
        for (let v = -S + 2.4; v < 0; v += 0.3) k.frame.box(f.matrix(ul, v, dep - 0.25), 0.44, 0.025, 0.025);
      }
    }
  }
  // awning over the door + lantern
  const k0 = kit(c.storey(0));
  const fr0 = sideFrames(m, W, D);
  k0.metal.box(fr0.front.f.matrix(hw, 3.0, 0.9), 3.4, 0.1, 1.8);
  k0.frame.setColor(steel);
  for (const s of [-1, 1]) rod(k0.frame, fr0.front.f.at(hw + s * 1.55, 2.35, 0.02), fr0.front.f.at(hw + s * 1.55, 3.0, 1.75), 0.03);
  wallLantern(k0, fr0.front.f, hw + 1.25, 2.4);

  // roof: parapet with a concrete cornice, saw-tooth north lights, timber water tank on a steel stand
  const kr = kit(c.roof);
  kr.wall.setColor(brick);
  flatRoof(kr, m, W, D, H, { parapet: 0.6, cornice: false, capColor: [0.45, 0.45, 0.47] });
  kr.trim.setColor([0.6, 0.58, 0.55]);
  band(kr.trim, m, W, D, H - 0.32, 0.2, 0.07);
  const teeth = 3, tw = (D - 1.2) / teeth, th = 1.8;
  const x0 = cx - hw + 0.6, x1 = cx + hw - 4.2;
  for (let i = 0; i < teeth; i++) {
    const z0 = cz + hd - 0.6 - i * tw, z1 = z0 - tw;
    const ya = G + H + 0.05, yb = ya + th;
    kr.roofMetal.setColor([0.42, 0.43, 0.45]);
    kr.roofMetal.quad({ x: x0, y: ya, z: z0 }, { x: x1, y: ya, z: z0 }, { x: x1, y: yb, z: z1 }, { x: x0, y: yb, z: z1 }, [[0, 0], [x1 - x0, 0], [x1 - x0, tw], [0, tw]]);
    kr.glass.setExtra('aWin', [6, 0.9]);
    kr.glass.setExtra('aRoom', [x1 - x0, th, 0.05 + S * 0.6, 0.5]);
    kr.glass.quad({ x: x1, y: ya, z: z1 }, { x: x0, y: ya, z: z1 }, { x: x0, y: yb, z: z1 }, { x: x1, y: yb, z: z1 });
    for (const x of [x0, x1]) {
      const tri = new THREE.BufferGeometry().setFromPoints(
        x === x0 ? [new THREE.Vector3(x, ya, z0), new THREE.Vector3(x, yb, z1), new THREE.Vector3(x, ya, z1)] : [new THREE.Vector3(x, ya, z0), new THREE.Vector3(x, ya, z1), new THREE.Vector3(x, yb, z1)],
      );
      tri.computeVertexNormals();
      kr.roofMetal.geometry(tri);
      tri.dispose();
    }
    kr.frame.setColor([0.1, 0.1, 0.11]);
    for (let x = x0; x <= x1 + 0.01; x += (x1 - x0) / 8) kr.frame.box(at(x, (ya + yb) / 2, z1 - 0.03), 0.06, th, 0.06);
    kr.frame.box(at((x0 + x1) / 2, yb, z1 - 0.03), x1 - x0, 0.07, 0.07);
  }
  // water tank
  const tx = cx + hw - 2.1, tz = cz - hd + 2.3, legH = 1.9, tr = 1.15, tH = 2.3;
  const T = (x: number, y: number, z: number) => at(tx + x, G + H + y, tz + z);
  kr.frame.setColor(steel);
  for (const [lx, lz] of [[-0.85, -0.85], [0.85, -0.85], [0.85, 0.85], [-0.85, 0.85]]) kr.frame.box(T(lx, legH / 2, lz), 0.12, legH, 0.12);
  for (const s of [-1, 1]) {
    const fx = new WallFrame(at(tx, G + H, tz), -0.85, s * 0.85, 0.85, s * 0.85);
    strut(kr.frame, fx, 0, 0.2, 1.7, legH - 0.1, 0, 0.05);
    strut(kr.frame, fx, 1.7, 0.2, 0, legH - 0.1, 0, 0.05);
    const fz2 = new WallFrame(at(tx, G + H, tz), s * 0.85, 0.85, s * 0.85, -0.85);
    strut(kr.frame, fz2, 0, 0.2, 1.7, legH - 0.1, 0, 0.05);
  }
  kr.wood.setColor([0.62, 0.5, 0.4]);
  kr.wood.box(T(0, legH + 0.06, 0), 2.5, 0.12, 2.5);
  kr.wood.setColor([0.72, 0.58, 0.46]);
  cyl(kr.wood, tr, tr * 1.04, tH, T(0, legH + 0.12 + tH / 2, 0), 24);
  kr.frame.setColor([0.12, 0.12, 0.13]);
  for (const y of [0.35, 1.1, 1.85]) cyl(kr.frame, tr * 1.03 + 0.012, tr * 1.03 + 0.012, 0.06, T(0, legH + 0.12 + y, 0), 24, true);
  kr.roofMetal.setColor([0.3, 0.3, 0.32]);
  const cone = new THREE.ConeGeometry(tr + 0.12, 0.85, 24, 1, true);
  kr.roofMetal.geometry(cone, T(0, legH + 0.12 + tH + 0.42, 0));
  cone.dispose();
  kr.metal.box(T(0, legH + 0.12 + tH + 0.9, 0), 0.1, 0.12, 0.1);

  // site: path, trees, shrubs, hedges, a bench
  const ks = kit(c.site);
  path(c.site.writer(mats.sidewalk, { cast: false }), -2.2, cz + hd, 2.2, 12, G + 0.02);
  const veg = new Vegetation();
  veg.addTree('broadleaf', -7, 7, G, 0.9 + 0.05 * N);
  veg.addTree('broadleaf', 7.2, 6.5, G, 0.8 + 0.05 * N, { autumn: true });
  for (let i = 0; i < 6; i++) veg.addShrub(-6 + i * 0.9, cz + hd + 0.7, G, 0.5);
  veg.addHedge(-9.6, -2, G, 18, Math.PI / 2, 1.0, 0.7);
  veg.addHedge(9.6, -2, G, 18, Math.PI / 2, 1.0, 0.7);
  veg.mergeInto(c.site, mats, c.plants);
  ks.wood.setColor([0.75, 0.58, 0.42]);
  ks.wood.box(at(4.2, G + 0.45, cz + hd + 1.2), 1.8, 0.06, 0.45);
  ks.metal.box(at(3.5, G + 0.22, cz + hd + 1.2), 0.06, 0.44, 0.4);
  ks.metal.box(at(4.9, G + 0.22, cz + hd + 1.2), 0.06, 0.44, 0.4);
  return {
    sign: { x: -4.6, z: 10.8 },
    height: H + 2.4,
    wallTop: H,
    door: new THREE.Vector3(cx, 0, cz + hd),
    porchLight: fr0.front.f.at(hw + 1.25, 2.4, 0.23),
    beacon: new THREE.Vector3(cx + hw - 1.2, G + H + 0.5 + 0.6, cz + hd - 1.2),
    footprint: { cx, cz, hw: hw + 0.4, hd: hd + 0.4 },
  };
}

export const STYLE_BUILDERS: Record<BuildingStyle, (c: StyleCtx) => StyleResult> = { house, cottage, office, studio };
