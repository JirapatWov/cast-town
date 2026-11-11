// Geometry derived from shared/city-layout.ts: blocks between roads, road segments, intersection kinds,
// surface heights, and footprints used for collisions and placement.
import { INTERSECTIONS, LANDMARKS, LOTS, ROADS, ROAD_WIDTH, SIDEWALK_WIDTH, type RoadSegment } from '../../../shared/city-layout';
import type { Lot } from '../../../shared/protocol';

export const LAWN_Y = 0.12;
export const WALK_Y = 0.15;
export const CURB_W = 0.3;
export const HALF_ROAD = ROAD_WIDTH / 2;

export interface Rect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

/** Oriented rectangle on the ground (center, half extents along local X/Z, rotation about Y). */
export interface Footprint {
  x: number;
  z: number;
  hw: number;
  hd: number;
  rotY: number;
  id?: string;
}

const xs = [...new Set(ROADS.filter((r) => r.from[0] === r.to[0]).map((r) => r.from[0]))].sort((a, b) => a - b);
const zs = [...new Set(ROADS.filter((r) => r.from[1] === r.to[1]).map((r) => r.from[1]))].sort((a, b) => a - b);

/** Asphalt extent: outer edges of the outer roads. */
export const TOWN: Rect = { x0: xs[0] - HALF_ROAD, z0: zs[0] - HALF_ROAD, x1: xs[xs.length - 1] + HALF_ROAD, z1: zs[zs.length - 1] + HALF_ROAD };

/** City blocks: the land between road edges (sidewalk ring + lawn + lots live inside). */
export const BLOCKS: Rect[] = [];
for (let i = 0; i < xs.length - 1; i++) {
  for (let j = 0; j < zs.length - 1; j++) {
    BLOCKS.push({ x0: xs[i] + HALF_ROAD, z0: zs[j] + HALF_ROAD, x1: xs[i + 1] - HALF_ROAD, z1: zs[j + 1] - HALF_ROAD });
  }
}

export type Axis = 'x' | 'z';

export interface RoadPiece {
  road: RoadSegment;
  axis: Axis; // direction of travel
  /** Fixed coordinate of the centerline (z for x-roads, x for z-roads). */
  c: number;
  /** Start/end along the axis, between intersection squares. */
  a0: number;
  a1: number;
}

function roadAxis(r: RoadSegment): Axis {
  return r.from[1] === r.to[1] ? 'x' : 'z';
}

/** Road pieces between intersection squares. */
export const ROAD_PIECES: RoadPiece[] = ROADS.flatMap((road) => {
  const axis = roadAxis(road);
  const c = axis === 'x' ? road.from[1] : road.from[0];
  const lo = Math.min(axis === 'x' ? road.from[0] : road.from[1], axis === 'x' ? road.to[0] : road.to[1]);
  const hi = Math.max(axis === 'x' ? road.from[0] : road.from[1], axis === 'x' ? road.to[0] : road.to[1]);
  const stops = INTERSECTIONS.filter(([x, z]) => (axis === 'x' ? z === c && x >= lo && x <= hi : x === c && z >= lo && z <= hi))
    .map(([x, z]) => (axis === 'x' ? x : z))
    .sort((a, b) => a - b);
  const pieces: RoadPiece[] = [];
  for (let i = 0; i < stops.length - 1; i++) pieces.push({ road, axis, c, a0: stops[i] + HALF_ROAD, a1: stops[i + 1] - HALF_ROAD });
  return pieces;
});

/** Number of road arms meeting at an intersection (2 = corner, 3 = T, 4 = cross). */
export function armsAt(x: number, z: number): { dx: number; dz: number }[] {
  const arms: { dx: number; dz: number }[] = [];
  for (const p of ROAD_PIECES) {
    if (p.axis === 'x' && p.c === z) {
      if (Math.abs(p.a0 - HALF_ROAD - x) < 0.01) arms.push({ dx: 1, dz: 0 });
      if (Math.abs(p.a1 + HALF_ROAD - x) < 0.01) arms.push({ dx: -1, dz: 0 });
    }
    if (p.axis === 'z' && p.c === x) {
      if (Math.abs(p.a0 - HALF_ROAD - z) < 0.01) arms.push({ dx: 0, dz: 1 });
      if (Math.abs(p.a1 + HALF_ROAD - z) < 0.01) arms.push({ dx: 0, dz: -1 });
    }
  }
  return arms;
}

export function isOnRoad(x: number, z: number, margin = 0): boolean {
  for (const r of ROADS) {
    const axis = roadAxis(r);
    const c = axis === 'x' ? r.from[1] : r.from[0];
    const lo = Math.min(axis === 'x' ? r.from[0] : r.from[1], axis === 'x' ? r.to[0] : r.to[1]) - HALF_ROAD;
    const hi = Math.max(axis === 'x' ? r.from[0] : r.from[1], axis === 'x' ? r.to[0] : r.to[1]) + HALF_ROAD;
    const along = axis === 'x' ? x : z;
    const across = axis === 'x' ? z : x;
    if (along >= lo && along <= hi && Math.abs(across - c) <= HALF_ROAD + margin) return true;
  }
  return false;
}

/** Height of the walkable/drivable surface (roads at 0, everything else on the lawn/sidewalk plinth). */
export function surfaceHeight(x: number, z: number): number {
  return isOnRoad(x, z) ? 0 : LAWN_Y + 0.02;
}

export function inRect(r: Rect, x: number, z: number, pad = 0): boolean {
  return x >= r.x0 - pad && x <= r.x1 + pad && z >= r.z0 - pad && z <= r.z1 + pad;
}

/** Lot rectangle in world space (lots are axis-aligned in this layout: rotY is a multiple of 90°). */
export function lotRect(l: { x: number; z: number; rotY: number; width: number; depth: number }): Rect {
  const sideways = Math.abs(Math.sin(l.rotY)) > 0.5;
  const hw = (sideways ? l.depth : l.width) / 2;
  const hd = (sideways ? l.width : l.depth) / 2;
  return { x0: l.x - hw, z0: l.z - hd, x1: l.x + hw, z1: l.z + hd };
}

export function lotById(id: string): Lot | undefined {
  return LOTS.find((l) => l.id === id);
}

export function landmarkById(id: string) {
  return LANDMARKS.find((l) => l.id === id);
}

/** Point `dist` meters in front of a lot-like placement (front = local +Z). */
export function frontPoint(p: { x: number; z: number; rotY: number }, dist: number): { x: number; z: number } {
  return { x: p.x + Math.sin(p.rotY) * dist, z: p.z + Math.cos(p.rotY) * dist };
}

/** Local (lot space) → world. */
export function lotToWorld(p: { x: number; z: number; rotY: number }, lx: number, lz: number): { x: number; z: number } {
  const c = Math.cos(p.rotY), s = Math.sin(p.rotY);
  return { x: p.x + lx * c + lz * s, z: p.z - lx * s + lz * c };
}

export { ROAD_WIDTH, SIDEWALK_WIDTH };
