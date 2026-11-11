// Real Life Terminal — deterministic town layout shared by server (lot registry) and web (3D city).
// World units: meters. Y is up. Ground plane y=0. The town is ~300 x 220 m.
//
//   z=+90  ┌──────────────────────────────────────────────┐  outer loop road
//          │  ambient     ambient   │   ambient    ambient  │
//          │  [lot]  [lot]  [lot]  ┃  [lot]  [lot]  [lot]  │  ← lots facing the avenue
//   z=0    ├━━━━━━━━━━━━━━━━━━━━━━━╋━━━━━━━━━━━━━━━━━━━━━━┤  Main Avenue
//          │  [lot]  [lot]  [lot]  ┃  [lot]  [lot]  [lot]  │
//          │  park / ambient       │   agency    ambient   │
//   z=-90  └──────────────────────────────────────────────┘
//        x=-130                   x=0                    x=+130
//
// Rotation convention: a building is modelled with its front door facing local +Z.
// three.js rotation.y = rotY maps local +Z to world (sin rotY, 0, cos rotY).

import type { Lot } from './protocol';

export const ROAD_WIDTH = 12; // asphalt, 2 lanes + shoulders
export const SIDEWALK_WIDTH = 3;
export const LOT_W = 20;
export const LOT_D = 24;

export interface RoadSegment {
  id: string;
  name: string;
  from: [number, number]; // [x, z] centerline start
  to: [number, number]; // [x, z] centerline end
  width: number;
}

export const ROADS: RoadSegment[] = [
  { id: 'main-ave', name: 'Main Avenue', from: [-130, 0], to: [130, 0], width: ROAD_WIDTH },
  { id: 'center-st', name: 'Center Street', from: [0, -90], to: [0, 90], width: ROAD_WIDTH },
  { id: 'north-rd', name: 'North Road', from: [-130, 90], to: [130, 90], width: ROAD_WIDTH },
  { id: 'south-rd', name: 'South Road', from: [-130, -90], to: [130, -90], width: ROAD_WIDTH },
  { id: 'west-rd', name: 'West Road', from: [-130, -90], to: [-130, 90], width: ROAD_WIDTH },
  { id: 'east-rd', name: 'East Road', from: [130, -90], to: [130, 90], width: ROAD_WIDTH },
];

/** Intersections (centerline crossings) — useful for road markings, traffic lights and car navigation graph. */
export const INTERSECTIONS: [number, number][] = [
  [-130, 90], [0, 90], [130, 90],
  [-130, 0], [0, 0], [130, 0],
  [-130, -90], [0, -90], [130, -90],
];

const PI = Math.PI;
// distance from a road centerline to the center of a lot fronting it
const SETBACK = ROAD_WIDTH / 2 + SIDEWALK_WIDTH + LOT_D / 2; // 6 + 3 + 12 = 21

function lot(id: string, x: number, z: number, rotY: number, district: string): Lot {
  return { id, x, z, rotY, width: LOT_W, depth: LOT_D, district };
}

/** Buildable lots (project folders become buildings here). 20 lots. */
export const LOTS: Lot[] = [
  // Main Avenue, north side (front faces -Z → rotY = PI)
  lot('A-N1', -105, SETBACK, PI, 'Main Ave'),
  lot('A-N2', -75, SETBACK, PI, 'Main Ave'),
  lot('A-N3', -45, SETBACK, PI, 'Main Ave'),
  lot('A-N4', 45, SETBACK, PI, 'Main Ave'),
  lot('A-N5', 75, SETBACK, PI, 'Main Ave'),
  lot('A-N6', 105, SETBACK, PI, 'Main Ave'),
  // Main Avenue, south side (front faces +Z → rotY = 0)
  lot('A-S1', -105, -SETBACK, 0, 'Main Ave'),
  lot('A-S2', -75, -SETBACK, 0, 'Main Ave'),
  lot('A-S3', -45, -SETBACK, 0, 'Main Ave'),
  lot('A-S4', 45, -SETBACK, 0, 'Main Ave'),
  lot('A-S5', 75, -SETBACK, 0, 'Main Ave'),
  lot('A-S6', 105, -SETBACK, 0, 'Main Ave'),
  // Center Street (east side faces -X → rotY = -PI/2; west side faces +X → rotY = PI/2)
  lot('C-E1', SETBACK, 45, -PI / 2, 'Center St'),
  lot('C-E2', SETBACK, -45, -PI / 2, 'Center St'),
  lot('C-W1', -SETBACK, 45, PI / 2, 'Center St'),
  lot('C-W2', -SETBACK, -45, PI / 2, 'Center St'),
  // Outer loop — far lots (a nice drive away). North road lots face +Z (rotY 0); south road lots face -Z (rotY PI)
  lot('N-1', -105, 90 - SETBACK, 0, 'North Rd'),
  lot('N-2', 105, 90 - SETBACK, 0, 'North Rd'),
  lot('S-1', -105, -90 + SETBACK, PI, 'South Rd'),
  lot('S-2', 105, -90 + SETBACK, PI, 'South Rd'),
];

export interface Landmark {
  id: string;
  name: string;
  kind: 'agency' | 'park';
  x: number;
  z: number;
  rotY: number;
  width: number;
  depth: number;
}

/** Non-project places. The Talent Agency opens the Models & Providers panel. The park is decoration. */
export const LANDMARKS: Landmark[] = [
  { id: 'agency', name: 'Talent Agency', kind: 'agency', x: 60, z: -90 + SETBACK, rotY: PI, width: 26, depth: 24 },
  { id: 'park', name: 'Central Park', kind: 'park', x: -63, z: -55, rotY: 0, width: 58, depth: 40 },
];

export interface AmbientBuilding {
  x: number;
  z: number;
  rotY: number;
  width: number;
  depth: number;
  floors: number;
  kind: 'apartment' | 'shop' | 'townhouse';
}

/** Decorative, non-interactive buildings that make the town feel inhabited. Deterministic. */
export const AMBIENT: AmbientBuilding[] = [
  // north outer frontage (between the far lots)
  { x: -60, z: 69, rotY: 0, width: 22, depth: 20, floors: 5, kind: 'apartment' },
  { x: -24, z: 69, rotY: 0, width: 18, depth: 18, floors: 3, kind: 'townhouse' },
  { x: 24, z: 69, rotY: 0, width: 18, depth: 18, floors: 4, kind: 'shop' },
  { x: 60, z: 69, rotY: 0, width: 24, depth: 20, floors: 7, kind: 'apartment' },
  // south outer frontage
  { x: 20, z: -69, rotY: PI, width: 16, depth: 18, floors: 3, kind: 'shop' },
  { x: 100, z: -45, rotY: -PI / 2, width: 20, depth: 18, floors: 6, kind: 'apartment' },
  // west & east outer frontage
  { x: -109, z: 45, rotY: PI / 2, width: 18, depth: 18, floors: 4, kind: 'townhouse' },
  { x: -109, z: -48, rotY: PI / 2, width: 18, depth: 18, floors: 3, kind: 'townhouse' },
  { x: 109, z: 45, rotY: -PI / 2, width: 20, depth: 18, floors: 8, kind: 'apartment' },
  // behind the Center Street lots
  { x: 45, z: 50, rotY: PI, width: 18, depth: 16, floors: 2, kind: 'shop' },
  { x: -45, z: 50, rotY: PI, width: 18, depth: 16, floors: 3, kind: 'townhouse' },
];

/** Where the player's car spawns (on Center Street just north of the main intersection, heading south). */
export const CAR_SPAWN = { x: 3, z: 30, rotY: PI };

/** The point on the road in front of a lot/landmark (used for fast-travel / auto-drive targets). */
export function frontOf(p: { x: number; z: number; rotY: number; depth: number }, extra = 3): { x: number; z: number } {
  const d = p.depth / 2 + SIDEWALK_WIDTH + extra;
  return { x: p.x + Math.sin(p.rotY) * d, z: p.z + Math.cos(p.rotY) * d };
}
