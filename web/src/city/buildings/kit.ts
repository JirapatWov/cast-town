// Building kit: shells with openings, flat roofs with parapets + cornices, gable roofs with eaves, plinths,
// balconies and rooftop clutter. Everything writes into shared MeshWriters (merged per material).
import * as THREE from 'three';
import { rng } from '../util/random';
import { buildWall, type FacadeWriters, type Opening, WallFrame, type WallStyle } from '../facade';
import { ProjectGlassMaterial } from '../glass';
import type { CityMaterials } from '../materials';
import { Batch, type MeshWriter } from '../util/mesh-writer';

export interface KitWriters extends FacadeWriters {
  trim: MeshWriter;
  stone: MeshWriter;
  metal: MeshWriter;
  roofFlat: MeshWriter;
  roofShingle: MeshWriter;
  roofMetal: MeshWriter;
  fabric: MeshWriter;
  wood: MeshWriter;
}

/** Writers for a batch; `wall` picks plaster or brick. */
export function kitWriters(batch: Batch, mats: CityMaterials, wall: 'plaster' | 'brick' | 'wood', glass: THREE.Material = mats.glass): KitWriters {
  const wallW = batch.writer(mats[wall]);
  const glassW = batch.writer(glass); // glass casts shadows: the shells are hollow
  if (glassW.vertexCount === 0) {
    glassW.defineExtra('aWin', 2, [0, 0]);
    if (glass instanceof ProjectGlassMaterial) glassW.defineExtra('aRoom', 4, [1, 1, 0.9, 0.9]);
  }
  return {
    wall: wallW,
    reveal: wallW,
    glass: glassW,
    frame: batch.writer(mats.frame),
    sill: batch.writer(mats.trim),
    door: batch.writer(mats.door),
    trim: batch.writer(mats.trim),
    stone: batch.writer(mats.stone),
    metal: batch.writer(mats.metal),
    roofFlat: batch.writer(mats.roofFlat),
    roofShingle: batch.writer(mats.roofShingle),
    roofMetal: batch.writer(mats.roofMetal),
    fabric: batch.writer(mats.fabric),
    wood: batch.writer(mats.wood),
  };
}

export type Side = 'front' | 'right' | 'back' | 'left';
export const SIDES: Side[] = ['front', 'right', 'back', 'left'];

/** Wall frames for a W×D box centered at the origin of `m` (front = +Z), counter-clockwise from the front-left corner. */
export function sideFrames(m: THREE.Matrix4, W: number, D: number, y0 = 0): Record<Side, { f: WallFrame; L: number; uv: number }> {
  const hw = W / 2, hd = D / 2;
  return {
    front: { f: new WallFrame(m, -hw, hd, hw, hd, y0), L: W, uv: 0 },
    right: { f: new WallFrame(m, hw, hd, hw, -hd, y0), L: D, uv: W },
    back: { f: new WallFrame(m, hw, -hd, -hw, -hd, y0), L: W, uv: W + D },
    left: { f: new WallFrame(m, -hw, -hd, -hw, hd, y0), L: D, uv: 2 * W + D },
  };
}

/** Four walls with openings. */
export function shell(
  wr: FacadeWriters, m: THREE.Matrix4, W: number, D: number, H: number, openings: (side: Side, L: number) => Opening[], style: WallStyle, y0 = 0,
): void {
  const frames = sideFrames(m, W, D, y0);
  for (const s of SIDES) {
    const { f, L, uv } = frames[s];
    buildWall(wr, f, L, H, openings(s, L), style, uv, y0);
  }
}

/** A horizontal band (cornice, string course, plinth) wrapping the box, projecting `out` from the walls. */
export function band(w: MeshWriter, m: THREE.Matrix4, W: number, D: number, y: number, h: number, out: number, skipBottom = false): void {
  const skip = skipBottom ? ['ny'] : [];
  const mk = (x: number, z: number, rot: number) => new THREE.Matrix4().makeRotationY(rot).setPosition(x, y + h / 2, z).premultiply(m);
  // front/back span the full width incl. projections; sides fit between them (no overlapping coplanar faces)
  w.box(mk(0, D / 2 + out / 2, 0), W + 2 * out, h, out, { skip });
  w.box(mk(0, -D / 2 - out / 2, 0), W + 2 * out, h, out, { skip });
  w.box(mk(W / 2 + out / 2, 0, 0), out, h, D, { skip });
  w.box(mk(-W / 2 - out / 2, 0, 0), out, h, D, { skip });
}

/** Flat roof: deck, parapet (wall material), coping cap and an optional projecting cornice. */
export function flatRoof(
  k: KitWriters, m: THREE.Matrix4, W: number, D: number, H: number,
  opts: { parapet?: number; cornice?: boolean; capColor?: [number, number, number] } = {},
): void {
  const ph = opts.parapet ?? 0.7, t = 0.28;
  const deck = new THREE.Matrix4().makeTranslation(0, H + 0.02, 0).premultiply(m);
  k.roofFlat.box(deck, W - 0.02, 0.04, D - 0.02, { skip: ['ny'] });
  // parapet (as four boxes on the wall line, outer face flush)
  const mk = (x: number, z: number) => new THREE.Matrix4().makeTranslation(x, H + ph / 2, z).premultiply(m);
  k.wall.box(mk(0, D / 2 - t / 2), W, ph, t, { skip: ['ny'] });
  k.wall.box(mk(0, -D / 2 + t / 2), W, ph, t, { skip: ['ny'] });
  k.wall.box(mk(W / 2 - t / 2, 0), t, ph, D - 2 * t, { skip: ['ny'] });
  k.wall.box(mk(-W / 2 + t / 2, 0), t, ph, D - 2 * t, { skip: ['ny'] });
  k.trim.setColor(opts.capColor ?? [0.92, 0.9, 0.86]);
  band(k.trim, m, W, D, H + ph, 0.08, 0.05);
  if (opts.cornice !== false) {
    band(k.trim, m, W, D, H - 0.32, 0.32, 0.22);
    band(k.trim, m, W, D, H - 0.42, 0.1, 0.1);
  }
}

/** Gable roof with eaves; ridge along local X. Gable triangles use the wall writer, fascia uses trim. */
export function gableRoof(
  k: KitWriters, roof: MeshWriter, m: THREE.Matrix4, W: number, D: number, H: number, rise: number,
  opts: { overhang?: number; gableOverhang?: number; fasciaColor?: [number, number, number] } = {},
): void {
  const o = opts.overhang ?? 0.5, go = opts.gableOverhang ?? 0.35;
  const hw = W / 2 + go, hd = D / 2 + o;
  const slope = Math.hypot(hd, rise);
  const drop = (o / (D / 2)) * rise; // eave sits lower than the wall top
  const P = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).applyMatrix4(m);
  const yE = H - drop, yR = H + rise;
  const thick = 0.12;
  // two slopes (top surfaces) — UVs in meters along the slope
  roof.quad(P(-hw, yE, hd), P(hw, yE, hd), P(hw, yR, 0), P(-hw, yR, 0), [[0, 0], [2 * hw, 0], [2 * hw, slope], [0, slope]]);
  roof.quad(P(hw, yE, -hd), P(-hw, yE, -hd), P(-hw, yR, 0), P(hw, yR, 0), [[0, 0], [2 * hw, 0], [2 * hw, slope], [0, slope]]);
  // undersides (soffit) slightly below
  k.trim.setColor(opts.fasciaColor ?? [0.95, 0.94, 0.9]);
  k.trim.quad(P(-hw, yR - thick, 0), P(hw, yR - thick, 0), P(hw, yE - thick, hd), P(-hw, yE - thick, hd));
  k.trim.quad(P(hw, yR - thick, 0), P(-hw, yR - thick, 0), P(-hw, yE - thick, -hd), P(hw, yE - thick, -hd));
  // fascia boards along the eaves and the gable rakes
  k.trim.quad(P(-hw, yE - thick, hd), P(hw, yE - thick, hd), P(hw, yE, hd), P(-hw, yE, hd));
  k.trim.quad(P(hw, yE - thick, -hd), P(-hw, yE - thick, -hd), P(-hw, yE, -hd), P(hw, yE, -hd));
  for (const s of [-1, 1]) {
    const x = s * hw;
    const a = P(x, yE - thick, s * hd), b = P(x, yE - thick, -s * hd), c = P(x, yE, -s * hd), d = P(x, yE, s * hd);
    const r1 = P(x, yR - thick, 0), r2 = P(x, yR, 0);
    // rake: two thin quads following the slopes (a sits at z = s*hd, so one winding serves both ends)
    k.trim.quad(a, r1, r2, d);
    k.trim.quad(r1, b, c, r2);
  }
  // gable end triangles in the wall material (front of the wall plane)
  for (const s of [-1, 1]) {
    const x = s * (W / 2);
    const a = P(x, H, s * (D / 2)), b = P(x, H, -s * (D / 2)), apex = P(x, H + rise, 0);
    const g = new THREE.BufferGeometry().setFromPoints([a, b, apex]);
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, H, D, H, D / 2, H + rise], 2));
    g.computeVertexNormals();
    k.wall.geometry(g);
    g.dispose();
  }
  // ridge cap
  k.roofMetal.setColor([0.35, 0.35, 0.36]);
  k.roofMetal.box(new THREE.Matrix4().makeTranslation(0, yR + 0.03, 0).premultiply(m), 2 * hw, 0.08, 0.28);
}

/** Simple balcony: slab + solid parapet + top rail. */
export function balcony(k: KitWriters, f: WallFrame, u: number, v: number, w: number, depth = 1.1): void {
  k.trim.setColor([0.93, 0.92, 0.9]);
  k.trim.box(f.matrix(u, v - 0.07, depth / 2), w, 0.14, depth);
  k.frame.setColor([0.16, 0.17, 0.18]);
  k.frame.box(f.matrix(u, v + 0.5, depth - 0.03), w, 0.06, 0.05);
  for (let x = -w / 2 + 0.12; x <= w / 2 - 0.1; x += 0.14) k.frame.box(f.matrix(u + x, v + 0.24, depth - 0.03), 0.025, 0.48, 0.025);
  for (const s of [-1, 1]) {
    k.frame.box(f.matrix(u + (s * w) / 2, v + 0.27, depth / 2), 0.05, 0.06, depth);
    for (let z = 0.15; z < depth - 0.05; z += 0.14) k.frame.box(f.matrix(u + (s * w) / 2, v + 0.24, z), 0.025, 0.48, 0.025);
  }
}

/** Rooftop clutter for flat roofs: HVAC units, a stair housing, vents and (on about half the roofs) a solar array. */
export function rooftop(k: KitWriters, m: THREE.Matrix4, W: number, D: number, H: number, rnd: () => number, wallTint: [number, number, number]): void {
  const at = (x: number, y: number, z: number) => new THREE.Matrix4().makeTranslation(x, y, z).premultiply(m);
  // the array has its own random stream (keyed on the roof's position), so the town's other random choices stay put
  const own = rng(Math.floor(Math.abs(m.elements[12] * 31 + m.elements[14] * 17 + W * 7 + D * 3)) + 11);
  // stair / lift housing
  let hz = 0;
  const housing = W > 12;
  if (housing) {
    const sw = 3.2, sd = 3.6, sh = 2.6;
    const x = (rnd() - 0.5) * (W - sw - 3), z = (rnd() - 0.5) * (D - sd - 3);
    hz = z;
    k.wall.setColor(wallTint);
    k.wall.box(at(x, H + sh / 2, z), sw, sh, sd, { skip: ['ny'] });
    k.roofFlat.box(at(x, H + sh + 0.05, z), sw + 0.2, 0.1, sd + 0.2);
  }
  // solar rows along the edge away from the housing, tilted on low frames; HVAC units keep to the other side
  let zMin = -(D - 3) / 2, zMax = (D - 3) / 2;
  if (own() < 0.55 && W > 9 && D > 9 && !(housing && D < 12)) {
    const side = housing && hz < 0 ? 1 : -1;
    const rows = !housing && D > 14 ? 3 : 2, cols = Math.max(2, Math.floor((W - 4) / 1.15));
    const x0 = -(cols - 1) * 0.56;
    const tilt = new THREE.Matrix4().makeRotationX(side * 0.32);
    for (let j = 0; j < rows; j++) {
      const z = side * (D / 2 - 1.5 - j * 1.9);
      k.frame.setColor([0.05, 0.08, 0.15]);
      for (let i = 0; i < cols; i++) k.frame.box(at(x0 + i * 1.12, H + 0.42, z).multiply(tilt), 1.04, 0.04, 1.6);
      k.metal.box(at(0, H + 0.2, z - side * 0.55), cols * 1.12, 0.34, 0.05);
    }
    const inner = D / 2 - 1.5 - (rows - 1) * 1.9 - 1.6;
    if (side < 0) zMin = -inner;
    else zMax = inner;
  }
  const units = 2 + Math.floor(rnd() * 3);
  for (let i = 0; i < units; i++) {
    const uw = 1.2 + rnd() * 0.8, ud = 0.9 + rnd() * 0.5;
    const x = (rnd() - 0.5) * (W - 3), z = zMin + rnd() * Math.max(0, zMax - zMin);
    k.stone.setColor([0.85, 0.86, 0.87]);
    k.stone.box(at(x, H + 0.55, z), uw, 1.0, ud, { skip: ['ny'] });
    k.metal.box(at(x, H + 1.07, z), uw * 0.6, 0.06, ud * 0.6);
  }
}
