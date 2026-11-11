// The lot around the dollhouse. The house used to float on an endless flat lawn; it now sits on a real plot: a paved
// path from the front door to the sidewalk, a quiet street with lamp posts, a back patio with a table under a parasol,
// clipped hedges on the lot lines, flower beds along the walls, garden trees, and two neighbours' houses (and a ring
// of trees) fading into the haze. Built once with the ground floor, in a few steps with yields (growing the tree
// geometry takes tens of milliseconds). Everything is merged per material (a dozen draws for the whole lot); the
// lamp posts and the neighbours' lit windows glow on the house's time-of-day clock (lighting.ts nightGlow).
import * as THREE from 'three';
import type { Assets } from '../core/types';
import { pbrTileMeters } from '../engine/assets';
import { activeQualitySettings } from '../engine/quality';
import type { CityMaterials } from '../city/materials';
import { flowerMaterial } from '../city/trees/flowers';
import { barkMaterial, leafMaterial } from '../city/trees/materials';
import { staticPlant } from '../city/trees/static';
import { Batch, type MeshWriter } from '../city/util/mesh-writer';
import { Vegetation } from '../city/vegetation';
import { poolTexture } from '../city/fx';
import { mulberry32 } from '../people/rng';
import { DOOR, ROOM } from './layout';
import { nightGlow } from './lighting';
import type { Palette } from './materials';

const yieldTask = () => new Promise<void>((r) => setTimeout(r, 0));

/** Lot geometry (house-local metres; the lawn is at y = -plinth). */
export const LOT = {
  /** Lot lines (hedges) left/right/back/front. */
  x0: -14.4, x1: 14.6, z0: -14.6, z1: 12.6,
  /** Sidewalk and street along the left (door) side. */
  walk: [-17.2, -14.8] as const,
  road: [-24.6, -17.4] as const,
};

const at = (x: number, y: number, z: number) => new THREE.Matrix4().makeTranslation(x, y, z);

function cylinder(w: MeshWriter, r0: number, r1: number, h: number, m: THREE.Matrix4, seg = 10) {
  const g = new THREE.CylinderGeometry(r0, r1, h, seg);
  w.geometry(g, m);
  g.dispose();
}

/** A simple two-storey house with a gable roof; windows on every side, some lit at night. */
function neighbour(
  w: { wall: MeshWriter; roof: MeshWriter; trim: MeshWriter; dark: MeshWriter; lit: MeshWriter },
  x: number, z: number, rotY: number, W: number, D: number, wallTint: [number, number, number], rnd: () => number,
) {
  const m = new THREE.Matrix4().makeRotationY(rotY).setPosition(x, 0, z);
  const y0 = -ROOM.plinth, H = 5.8, rise = 2.3, hw = W / 2, hd = D / 2, o = 0.45;
  const P = (px: number, py: number, pz: number) => new THREE.Vector3(px, py, pz).applyMatrix4(m);
  w.wall.setColor(wallTint);
  w.wall.box(at(0, y0 + H / 2, 0).premultiply(m), W, H, D, { skip: ['ny', 'py'] });
  // gable ends
  for (const s of [-1, 1]) {
    const a = P(s * hw, y0 + H, s * hd), b = P(s * hw, y0 + H, -s * hd), c = P(s * hw, y0 + H + rise, 0);
    const g = new THREE.BufferGeometry().setFromPoints([a, b, c]);
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, H, D, H, D / 2, H + rise], 2));
    g.computeVertexNormals();
    w.wall.geometry(g);
    g.dispose();
  }
  // roof slopes (ridge along local x) and a fascia edge
  const yE = y0 + H - 0.3, yR = y0 + H + rise;
  w.roof.setColor([1, 1, 1]);
  w.roof.quad(P(-hw - o, yE, hd + o), P(hw + o, yE, hd + o), P(hw + o, yR, 0), P(-hw - o, yR, 0));
  w.roof.quad(P(hw + o, yE, -hd - o), P(-hw - o, yE, -hd - o), P(-hw - o, yR, 0), P(hw + o, yR, 0));
  w.trim.setColor([0.92, 0.9, 0.86]);
  for (const s of [-1, 1]) w.trim.box(at(0, yE - 0.08, s * (hd + o - 0.04)).premultiply(m), W + 2 * o, 0.16, 0.08);
  // a plinth band and windows (two rows) on every face
  w.trim.setColor([0.55, 0.54, 0.52]);
  w.trim.box(at(0, y0 + 0.2, 0).premultiply(m), W + 0.08, 0.4, D + 0.08, { skip: ['ny', 'py'] });
  const faces: [number, number, number, number][] = [[0, hd, 0, W], [0, -hd, Math.PI, W], [hw, 0, Math.PI / 2, D], [-hw, 0, -Math.PI / 2, D]];
  for (const [fx, fz, fr, len] of faces) {
    const n = Math.max(1, Math.floor((len - 1.2) / 2.6));
    for (let row = 0; row < 2; row++) {
      for (let i = 0; i < n; i++) {
        const u = -len / 2 + (len / n) * (i + 0.5);
        const fm = new THREE.Matrix4().makeRotationY(fr).setPosition(fx, 0, fz).premultiply(m);
        const wm = at(u, y0 + 1.5 + row * 2.9, 0.03).premultiply(fm);
        w.trim.setColor([0.95, 0.94, 0.9]);
        w.trim.box(at(u, y0 + 1.5 + row * 2.9, 0.02).premultiply(fm), 1.3, 1.6, 0.04);
        (rnd() < 0.45 ? w.lit : w.dark).box(wm, 1.1, 1.4, 0.04);
      }
    }
  }
}

/** Street lamp: a slim post, an arm over the kerb and a lantern head (its bulb glows at dusk and night). */
function streetLamp(w: { metal: MeshWriter; bulb: MeshWriter }, x: number, z: number, armDir: number) {
  const y0 = -ROOM.plinth + 0.12;
  w.metal.setColor([1, 1, 1]);
  cylinder(w.metal, 0.11, 0.13, 0.4, at(x, y0 + 0.2, z), 10);
  cylinder(w.metal, 0.05, 0.065, 4.4, at(x, y0 + 2.4, z), 8);
  w.metal.box(at(x + armDir * 0.45, y0 + 4.55, z), 0.95, 0.06, 0.07);
  w.metal.box(at(x + armDir * 0.9, y0 + 4.5, z), 0.5, 0.12, 0.3);
  w.bulb.box(at(x + armDir * 0.9, y0 + 4.42, z), 0.36, 0.04, 0.2);
}

export async function buildLot(pal: Palette, assets: Assets): Promise<THREE.Group> {
  const g = new THREE.Group();
  g.name = 'lot';
  const G = -ROOM.plinth;
  const rnd = mulberry32(7);
  // build in steps with yields in between; the longest step is logged (the tree growth is the heavy part)
  const t0 = performance.now();
  let tLap = t0, longest = 0, longestStep = '';
  const lap = async (step: string) => {
    const ms = performance.now() - tLap;
    if (ms > longest) [longest, longestStep] = [ms, step];
    await yieldTask();
    tLap = performance.now();
  };

  // ── materials ────────────────────────────────────────────────────────────────────────────────
  const tile = (set: 'asphalt' | 'paving' | 'concrete' | 'plaster') => 1 / pbrTileMeters(set);
  const asphalt = assets.pbr('asphalt', [tile('asphalt'), tile('asphalt')]);
  const paving = assets.pbr('paving', [tile('paving'), tile('paving')], '#d9d2c6');
  const concrete = assets.pbr('concrete', [tile('concrete'), tile('concrete')], '#cfcac2');
  const plaster = assets.pbr('plaster', [tile('plaster'), tile('plaster')]).clone();
  plaster.vertexColors = true;
  plaster.name = 'lot-plaster';
  const roof = new THREE.MeshStandardMaterial({ name: 'lot-roof', color: '#4b4f55', roughness: 0.72, metalness: 0.15, vertexColors: true });
  const trim = new THREE.MeshStandardMaterial({ name: 'lot-trim', color: '#ffffff', roughness: 0.6, vertexColors: true });
  const marking = new THREE.MeshStandardMaterial({ name: 'lot-marking', color: '#e9e5dc', roughness: 0.75 });
  const darkGlass = new THREE.MeshStandardMaterial({ name: 'lot-window', color: '#25303a', roughness: 0.12, metalness: 0.2, envMapIntensity: 1.3 });
  const litGlass = nightGlow(new THREE.MeshStandardMaterial({
    name: 'lot-window-lit', color: '#25303a', roughness: 0.12, metalness: 0.2, envMapIntensity: 1.3, emissive: '#ffb46b', emissiveIntensity: 1.6,
  }));
  const bulb = nightGlow(new THREE.MeshStandardMaterial({ name: 'lot-bulb', color: '#fff6e8', emissive: '#ffcf8f', emissiveIntensity: 7 }));
  const soil = new THREE.MeshStandardMaterial({ name: 'lot-soil', color: '#4a3a2c', roughness: 0.95 });
  const T = '/assets/textures/trees';
  const oakLeaves = assets.texture(`${T}/leaves_oak.webp`, { srgb: true });
  oakLeaves.wrapS = oakLeaves.wrapT = THREE.ClampToEdgeWrapping;
  const bark = barkMaterial('lot-bark', assets.texture(`${T}/bark_oak_color.webp`, { srgb: true }), assets.texture(`${T}/bark_oak_normal.webp`));
  bark.onBeforeCompile = () => {};
  bark.customProgramCacheKey = () => 'rlt-bark-static';
  // the town's garden materials: only the ones a Vegetation merge touches
  const veg = {
    hedge: pal.shrub,
    hedgeFuzz: leafMaterial({ name: 'lot-hedgeFuzz', map: oakLeaves, wind: false, translucency: 0.2, alphaTest: 0.5 }),
    flower: flowerMaterial(),
    foliage: leafMaterial({ name: 'lot-foliage', map: oakLeaves, wind: false, translucency: 0.25 }),
    bark,
  } as unknown as CityMaterials;

  const batch = new Batch();
  const w = {
    asphalt: batch.writer(asphalt, { cast: false }),
    paving: batch.writer(paving, { cast: false }),
    concrete: batch.writer(concrete),
    wall: batch.writer(plaster),
    roof: batch.writer(roof),
    trim: batch.writer(trim),
    dark: batch.writer(darkGlass, { cast: false }),
    lit: batch.writer(litGlass, { cast: false }),
    marking: batch.writer(marking, { cast: false }),
    metal: batch.writer(pal.blackMetal),
    bulb: batch.writer(bulb, { cast: false }),
    wood: batch.writer(pal.walnut),
    soil: batch.writer(soil, { cast: false }),
    linen: batch.writer(pal.fabric('#a9b8a0', 0.9), { cast: true }),
    clay: batch.writer(pal.fabric('#b8694f', 0.8)),
  };

  // ── street, sidewalks, path ─────────────────────────────────────────────────────────────────
  const zLen = 170;
  const [r0, r1] = LOT.road, [s0, s1] = LOT.walk;
  w.asphalt.box(at((r0 + r1) / 2, G + 0.015, 0), r1 - r0, 0.03, zLen, { skip: ['ny'] });
  // kerbs and sidewalks on both sides of the road
  for (const [a, b, kerb] of [[s0, s1, s0 - 0.1], [r0 - 2.4, r0, r0 + 0.1]] as const) {
    w.concrete.box(at((a + b) / 2, G + 0.06, 0), b - a, 0.12, zLen, { skip: ['ny'] });
    w.concrete.box(at(kerb, G + 0.07, 0), 0.2, 0.14, zLen, { skip: ['ny'] });
  }
  // dashed centre line
  const mid = (r0 + r1) / 2;
  for (let z = -zLen / 2 + 2; z < zLen / 2; z += 6) w.marking.box(at(mid, G + 0.033, z), 0.14, 0.006, 3);
  // paved path from the porch step to the sidewalk, and a back patio
  const doorZ = DOOR.center.z;
  const pathX0 = s1, pathX1 = -ROOM.halfW - ROOM.wallT - 0.7;
  w.paving.box(at((pathX0 + pathX1) / 2, G + 0.02, doorZ), pathX1 - pathX0, 0.04, 1.5, { skip: ['ny'] });
  const patio = { x0: -5.6, x1: 2.6, z0: -10.2, z1: -ROOM.halfD - ROOM.wallT };
  w.paving.box(at((patio.x0 + patio.x1) / 2, G + 0.03, (patio.z0 + patio.z1) / 2), patio.x1 - patio.x0, 0.06, patio.z1 - patio.z0, { skip: ['ny'] });
  w.concrete.box(at((patio.x0 + patio.x1) / 2, G + 0.04, patio.z0 - 0.06), patio.x1 - patio.x0 + 0.12, 0.08, 0.12, { skip: ['ny'] });

  // ── patio furniture: a table with two benches under a parasol, terracotta planters ─────────
  const tx = -1.6, tz = -8.4;
  w.wood.setColor([1, 1, 1]);
  w.wood.box(at(tx, G + 0.77, tz), 1.8, 0.05, 0.9);
  for (const sx of [-0.78, 0.78]) for (const sz of [-0.36, 0.36]) w.wood.box(at(tx + sx, G + 0.4, tz + sz), 0.06, 0.74, 0.06);
  for (const sz of [-0.85, 0.85]) {
    w.wood.box(at(tx, G + 0.46, tz + sz), 1.7, 0.05, 0.36);
    for (const sx of [-0.72, 0.72]) w.wood.box(at(tx + sx, G + 0.24, tz + sz), 0.06, 0.44, 0.3);
  }
  w.metal.setColor([1, 1, 1]);
  cylinder(w.metal, 0.025, 0.025, 2.5, at(tx, G + 1.25, tz), 6);
  const cone = new THREE.ConeGeometry(1.4, 0.5, 16, 1, true);
  w.linen.setColor([1, 1, 1]);
  w.linen.geometry(cone, at(tx, G + 2.45, tz));
  cone.dispose();
  const planters: [number, number][] = [[patio.x0 + 0.4, patio.z0 + 0.4], [patio.x1 - 0.4, patio.z0 + 0.4], [pathX1 + 0.1, doorZ - 1.3], [pathX1 + 0.1, doorZ + 1.3]];
  w.clay.setColor([1, 1, 1]);
  for (const [px, pz] of planters) cylinder(w.clay, 0.32, 0.25, 0.55, at(px, G + 0.275, pz), 14);

  // ── flower beds along the front and back walls ─────────────────────────────────────────────
  const beds: [number, number, number, number][] = [
    [-8.6, 8.6, ROOM.halfD + ROOM.wallT + 0.2, ROOM.halfD + ROOM.wallT + 1.0],
    [3.2, 8.6, -ROOM.halfD - ROOM.wallT - 1.0, -ROOM.halfD - ROOM.wallT - 0.2],
  ];
  const plants = new Vegetation();
  const blooms = [0xf2c14e, 0xf7f3e8, 0xd97757, 0xc45a7a, 0xb7a6e8];
  for (const [x0, x1, z0, z1] of beds) {
    w.soil.box(at((x0 + x1) / 2, G + 0.025, (z0 + z1) / 2), x1 - x0, 0.05, z1 - z0, { skip: ['ny'] });
    const n = Math.round((x1 - x0) * 7);
    for (let i = 0; i < n; i++) plants.addFlower(x0 + 0.15 + rnd() * (x1 - x0 - 0.3), z0 + 0.12 + rnd() * (z1 - z0 - 0.24), G + 0.04, blooms[i % blooms.length]);
    for (let x = x0 + 0.7; x < x1 - 0.4; x += 2.2 + rnd()) plants.addShrub(x, (z0 + z1) / 2, G, 0.42 + rnd() * 0.12);
  }
  for (const [px, pz] of planters) plants.addShrub(px, pz, G + 0.55, 0.38);

  // ── hedges on the lot lines (a gap where the path meets the sidewalk) ──────────────────────
  plants.addHedge((LOT.x0 + LOT.x1) / 2, LOT.z0, G, LOT.x1 - LOT.x0, 0, 1.35, 0.8);
  plants.addHedge(LOT.x1, (LOT.z0 + LOT.z1) / 2, G, LOT.z1 - LOT.z0 - 0.8, Math.PI / 2, 1.2, 0.75);
  plants.addHedge((LOT.x0 + LOT.x1) / 2 + 0.2, LOT.z1, G, LOT.x1 - LOT.x0 - 0.4, 0, 0.75, 0.55);
  const gap0 = doorZ - 0.95, gap1 = doorZ + 0.95;
  plants.addHedge(LOT.x0, (LOT.z0 + gap0) / 2 + 0.4, G, gap0 - LOT.z0 - 0.8, Math.PI / 2, 0.85, 0.6);
  plants.addHedge(LOT.x0, (gap1 + LOT.z1) / 2 - 0.2, G, LOT.z1 - gap1 - 0.4, Math.PI / 2, 0.85, 0.6);

  await lap('ground, patio, beds, hedges');
  staticPlant('shrub');
  await lap('shrub');
  plants.mergeInto(batch, veg); // hedges, flowers and shrubs
  await lap('hedges, flowers, shrubs');
  staticPlant('oak');
  await lap('oak');
  staticPlant('ash');
  await lap('ash');
  staticPlant('pine');
  await lap('pine');
  // ── trees: a couple in the garden, more on the neighbours' lots and a ring fading into the haze ────
  // (kept clear of the camera's usual side, +z, so they never stand between the viewer and the rooms)
  const trees = new Vegetation();
  trees.addTree('broadleaf', -12.2, -11.8, G, 0.85);
  trees.addTree('broadleaf', 11.6, -11.6, G, 0.8);
  trees.addTree('broadleaf', 21, -3, G, 1.1);
  trees.addTree('broadleaf', 19, 9, G, 0.95);
  trees.addTree('broadleaf', -1.5, -20.5, G, 1.15);
  trees.addTree('broadleaf', -9, -23, G, 1.0);
  trees.addTree('broadleaf', -29, -18, G, 1.1);
  trees.addTree('broadleaf', -29.5, 8, G, 1.0);
  for (let i = 0; i < 22; i++) {
    const a = (i / 22) * Math.PI * 2 + rnd() * 0.2;
    const r = 46 + rnd() * 18;
    const x = Math.cos(a) * r, z = Math.sin(a) * r * 0.85;
    trees.addTree(rnd() < 0.3 ? 'farConifer' : 'far', x, z, G, 1.0 + rnd() * 0.4);
  }
  trees.mergeInto(batch, veg);
  await lap('trees');

  // ── the neighbours: one behind the back hedge, two across the street ────────────────────────
  const houses = { wall: w.wall, roof: w.roof, trim: w.trim, dark: w.dark, lit: w.lit };
  neighbour(houses, 9, -27, 0, 11, 8.5, [1.02, 0.97, 0.9], rnd);
  neighbour(houses, -35, -6, Math.PI / 2, 12, 9, [0.92, 0.95, 0.98], rnd);
  neighbour(houses, -35, 17, Math.PI / 2, 10.5, 8.5, [1.05, 0.93, 0.84], rnd);

  // ── street lamps along the near sidewalk ────────────────────────────────────────────────────
  for (const z of [-11, 9.5]) streetLamp({ metal: w.metal, bulb: w.bulb }, s0 + 0.35, z, -1);

  // a lantern beside the front door
  const lx = -ROOM.halfW - ROOM.wallT;
  w.metal.box(at(lx - 0.02, G + 2.32, doorZ - 0.95), 0.04, 0.4, 0.16);
  w.metal.box(at(lx - 0.13, G + 2.47, doorZ - 0.95), 0.22, 0.04, 0.2);
  w.bulb.box(at(lx - 0.13, G + 2.3, doorZ - 0.95), 0.13, 0.26, 0.13);

  await lap('neighbours');
  const meshes = batch.build(g, 'lot');
  for (const m of g.children) m.userData.noBatch = true;
  // Low leaves out the neighbours (their walls, roofs, trim and windows use materials nothing else on the lot does)
  // and the sprig cards on the hedges, as the city does
  const detail = new Set<THREE.Material>([plaster, roof, trim, darkGlass, litGlass, veg.hedgeFuzz as THREE.Material]);
  const lotDetail = activeQualitySettings().lotDetail;
  for (const m of meshes) {
    if (!detail.has(m.material as THREE.Material)) continue;
    m.userData.lotDetail = true;
    m.visible = lotDetail;
  }

  // warm light pools under the lamps (additive, only at dusk and night)
  const poolMat = nightGlow(new THREE.MeshBasicMaterial({
    map: poolTexture(), color: '#ffc98a', transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  }));
  const pools: THREE.BufferGeometry[] = [];
  for (const z of [-11, 9.5]) pools.push(new THREE.PlaneGeometry(7, 7).rotateX(-Math.PI / 2).translate(s0 - 0.6, G + 0.14, z));
  const porch = new THREE.PlaneGeometry(4, 4).rotateX(-Math.PI / 2).translate(pathX1 - 0.6, G + 0.05, doorZ);
  pools.push(porch);
  const merged = new THREE.Mesh(mergePlanes(pools), poolMat);
  merged.name = 'lot:pools';
  merged.renderOrder = 2;
  merged.raycast = () => {};
  merged.userData.noBatch = true;
  g.add(merged);
  const ms = performance.now() - tLap;
  if (ms > longest) [longest, longestStep] = [ms, 'merge'];
  console.info(`[house] lot built in ${Math.round(performance.now() - t0)} ms (longest step: ${longestStep}, ${Math.round(longest)} ms)`);
  return g;
}

function mergePlanes(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  for (const geo of list) {
    const base = pos.length / 3;
    const p = geo.getAttribute('position'), t = geo.getAttribute('uv');
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i));
      uv.push(t.getX(i), t.getY(i));
    }
    const ix = geo.getIndex()!;
    for (let i = 0; i < ix.count; i++) idx.push(base + ix.getX(i));
    geo.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  out.setIndex(idx);
  return out;
}
