// Where the static greenery and street furniture goes: street trees + lamps along the avenues, trees scattered
// through the block lawns (keeping lots, buildings and landmarks clear) and a forest belt around the town.
import * as THREE from 'three';
import { LANDMARKS, LOTS } from '../../../shared/city-layout';
import { BLOCKS, type Footprint, HALF_ROAD, isOnRoad, LAWN_Y, lotRect, ROAD_PIECES, SIDEWALK_WIDTH, TOWN, WALK_Y } from './layout';
import type { PropPlacement, StreetPropsPlan } from './street-props';
import type { MeshWriter } from './util/mesh-writer';
import { rng, valueNoise3 } from './util/random';
import type { Vegetation } from './vegetation';

const HERO_ROADS = new Set(['main-ave', 'center-st']);

function inFootprint(f: Footprint, x: number, z: number, pad: number): boolean {
  const c = Math.cos(-f.rotY), s = Math.sin(-f.rotY);
  const dx = x - f.x, dz = z - f.z;
  const lx = dx * c + dz * s, lz = -dx * s + dz * c;
  return Math.abs(lx) <= f.hw + pad && Math.abs(lz) <= f.hd + pad;
}

export function blockedAreas(ambient: Footprint[]): { test(x: number, z: number, pad?: number): boolean } {
  const rects = [
    ...LOTS.map((l) => ({ r: lotRect(l), pad: 1.2 })),
    ...LANDMARKS.map((l) => ({ r: lotRect(l), pad: l.kind === 'park' ? 0.5 : 2 })),
  ];
  return {
    test(x, z, pad = 0) {
      for (const { r, pad: p } of rects) if (x >= r.x0 - p - pad && x <= r.x1 + p + pad && z >= r.z0 - p - pad && z <= r.z1 + p + pad) return true;
      for (const f of ambient) if (inFootprint(f, x, z, 3 + pad)) return true;
      return false;
    },
  };
}

/** Tree pits on the sidewalk under street trees. */
function treePit(w: MeshWriter, x: number, z: number) {
  w.setColor([0.42, 0.36, 0.3]);
  w.box(new THREE.Matrix4().makeTranslation(x, WALK_Y + 0.005, z), 1.3, 0.02, 1.3, { skip: ['ny'] });
}

export function planTown(veg: Vegetation, ambient: Footprint[], pits: MeshWriter): StreetPropsPlan {
  const blocked = blockedAreas(ambient);
  const lamps: PropPlacement[] = [];
  const benches: PropPlacement[] = [];
  const bins: PropPlacement[] = [];
  const boxes: PropPlacement[] = [];
  const r = rng(99);
  const lotFronts = LOTS.map((l) => ({ x: l.x + Math.sin(l.rotY) * 13, z: l.z + Math.cos(l.rotY) * 13 }));
  const nearLotPath = (x: number, z: number) => lotFronts.some((p) => Math.hypot(p.x - x, p.z - z) < 3.6);

  for (const p of ROAD_PIECES) {
    const hero = HERO_ROADS.has(p.road.id);
    const len = p.a1 - p.a0;
    for (const side of [-1, 1]) {
      // ring roads only get trees on the town side and the countryside side, no lamps
      const lampEvery = hero ? 30 : 0;
      const treeEvery = hero ? 15 : 18;
      const at = (a: number, across: number) => (p.axis === 'x' ? { x: a, z: p.c + side * across } : { x: p.c + side * across, z: a });
      const faceRoad = p.axis === 'x' ? (side > 0 ? Math.PI : 0) : side > 0 ? -Math.PI / 2 : Math.PI / 2;
      if (lampEvery) {
        const n = Math.floor((len - 12) / lampEvery);
        const start = p.a0 + (len - n * lampEvery) / 2;
        for (let i = 0; i <= n; i++) {
          const a = start + i * lampEvery + (side > 0 ? lampEvery / 2 : 0);
          if (a > p.a1 - 6) continue;
          const q = at(a, HALF_ROAD + 0.75);
          lamps.push({ ...q, y: WALK_Y, rotY: faceRoad });
          veg.colliders.push({ x: q.x, z: q.z, r: 0.3 });
        }
      }
      const n = Math.floor((len - 14) / treeEvery);
      const start = p.a0 + (len - n * treeEvery) / 2;
      for (let i = 0; i <= n; i++) {
        const a = start + i * treeEvery + treeEvery / 2;
        if (a > p.a1 - 7) continue;
        const q = at(a, HALF_ROAD + 2.05);
        if (nearLotPath(q.x, q.z)) continue;
        if (lamps.some((l) => Math.hypot(l.x - q.x, l.z - q.z) < 4)) continue;
        veg.addTree(r() < 0.18 && !hero ? 'columnar' : 'broadleaf', q.x, q.z, WALK_Y, hero ? 0.85 : 0.95, { autumn: r() < 0.07 });
        treePit(pits, q.x, q.z);
      }
      // benches + bins every so often on the avenues, facing the road
      if (hero) {
        for (let a = p.a0 + 22; a < p.a1 - 20; a += 46) {
          const q = at(a + 7.5, HALF_ROAD + 2.3);
          if (nearLotPath(q.x, q.z)) continue;
          benches.push({ ...q, y: WALK_Y, rotY: faceRoad });
          const b = at(a + 9.2, HALF_ROAD + 2.4);
          bins.push({ ...b, y: WALK_Y, rotY: faceRoad });
        }
        const u = at(p.a0 + 9, HALF_ROAD + 2.6);
        if (side > 0 && !nearLotPath(u.x, u.z)) boxes.push({ ...u, y: WALK_Y, rotY: faceRoad + Math.PI });
      }
    }
  }

  // trees scattered through block lawns (Poisson-ish rejection sampling)
  const placed: { x: number; z: number }[] = [];
  for (const b of BLOCKS) {
    const area = (b.x1 - b.x0) * (b.z1 - b.z0);
    const target = Math.floor(area / 150);
    let tries = 0, count = 0;
    while (count < target && tries < target * 30) {
      tries++;
      const x = b.x0 + r() * (b.x1 - b.x0), z = b.z0 + r() * (b.z1 - b.z0);
      if (isOnRoad(x, z, SIDEWALK_WIDTH + 2.5)) continue;
      if (blocked.test(x, z)) continue;
      if (placed.some((p) => (p.x - x) ** 2 + (p.z - z) ** 2 < 6.5 * 6.5)) continue;
      placed.push({ x, z });
      const roll = r();
      veg.addTree(roll < 0.12 ? 'conifer' : roll < 0.25 ? 'columnar' : 'broadleaf', x, z, LAWN_Y, 0.9 + r() * 0.35, { autumn: r() < 0.08 });
      if (r() < 0.35) veg.addShrub(x + (r() - 0.5) * 5, z + (r() - 0.5) * 5, LAWN_Y, 1 + r() * 0.6);
      count++;
    }
  }

  // countryside: woods in clumps with open meadows between, denser further out
  const edge = { x0: TOWN.x0 - SIDEWALK_WIDTH - 7, x1: TOWN.x1 + SIDEWALK_WIDTH + 7, z0: TOWN.z0 - SIDEWALK_WIDTH - 7, z1: TOWN.z1 + SIDEWALK_WIDTH + 7 };
  let forest = 0;
  for (let i = 0; i < 30000 && forest < 950; i++) {
    const x = (r() - 0.5) * 1000, z = (r() - 0.5) * 860;
    if (x > edge.x0 && x < edge.x1 && z > edge.z0 && z < edge.z1) continue;
    const dEdge = Math.max(edge.x0 - x, x - edge.x1, edge.z0 - z, z - edge.z1);
    const clump = valueNoise3(x / 70, 0.5, z / 70) + valueNoise3(x / 22, 1.5, z / 22) * 0.3;
    if (clump < 0.15 - THREE.MathUtils.smoothstep(dEdge, 20, 200) * 0.25) continue;
    const near = dEdge < 45;
    const kind = r() < 0.4 ? (near ? 'conifer' : 'farConifer') : near ? 'broadleaf' : 'far';
    veg.addTree(kind, x, z, LAWN_Y, 1.0 + r() * 0.5, { collide: false, autumn: r() < 0.06 });
    forest++;
  }
  return { lamps, benches, bins, boxes };
}
