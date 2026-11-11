// House interior template — pure data. One open-plan floor, 18 × 12 m, centered on the origin.
// Interior spans x ∈ [-9, 9], z ∈ [-6, 6]; floor at y = 0. Walls are built OUTSIDE these bounds.
// Default camera looks from the front-right (+Z, +X), so the back (−Z) and left (−X) walls are the
// "display" walls (kitchen, TV, corkboard, bookshelves, door) and stay up in the dollhouse cutaway.
//
//   z=-6 ┌──────────── back wall ─────────────────────────────────────┐
//        │ fridge│ kitchen counter │  TV wall  │ corkboard │  window   │
//        │       dining table      │ sofa, rug │ 3 desks (face −Z)     │
//   left │ bookshelves                                       workbench │ right
//        │ DOOR                                              (under    │
//        │ washer/dryer                                       stairs) ⇅│
//   z=+6 └──────────── front wall ────────────────────────────────────┘
//      x=-9                                                        x=9

export const ROOM = {
  halfW: 9,
  halfD: 6,
  height: 2.8,
  cutHeight: 0.4, // dollhouse: walls facing the camera drop to this
  wallT: 0.2,
  plinth: 0.22, // floor slab height above the lawn
};

/** Exterior walls (every floor) + upper-floor partitions: corridor north/south, the A|B and C|D walls, and the
 *  wall between room D and the stairwell. */
export type WallId = 'back' | 'front' | 'left' | 'right' | 'corr-n' | 'corr-s' | 'mid-n' | 'mid-s' | 'stair';

export interface Opening {
  kind: 'window' | 'door';
  from: number; // along the wall's u axis (world x for back/front, world z for left/right)
  to: number;
  sill: number; // bottom of the opening (0 for doors)
  top: number;
  curtains?: boolean;
}

/** An interior paint band on a wall: inner face between u ∈ [from, to] uses paint `paint`. */
export interface PaintBand {
  from: number;
  to: number;
  /** Paint name: a key of PAINTS on the ground floor, 'corridor' / 'r<slot>:feature' / 'r<slot>:base' upstairs. */
  paint: string;
  /** Wainscot: below the chair rail (walls.ts DADO_H) the face is panelled in this paint instead. */
  dado?: string;
}

export interface WallDef {
  id: WallId;
  axis: 'x' | 'z'; // which world axis the wall runs along
  at: number; // the fixed coordinate of the inner face (z for back/front, x for left/right)
  outward: [number, number]; // outward normal (x, z)
  span: [number, number]; // u range (corners are covered by the back/front walls)
  openings: Opening[];
  bands?: PaintBand[];
  /** Paint bands on the outer face (partitions: the room or corridor on the other side). */
  outerBands?: PaintBand[];
  /** Default ROOM.wallT (exterior); partitions use PARTITION_T. */
  thickness?: number;
  /** u range that gets baseboards (default: span). */
  baseSpan?: [number, number];
}

/** Warm whites carry the room (bright walls bounce the light around: GI), one accent per zone: sage behind the TV,
 *  terracotta behind the bookshelves. */
export const PAINTS = {
  warmWhite: '#efe7da',
  sage: '#a9b8a0',
  clay: '#c9826b',
  mist: '#e9e1d3',
};

const { halfW: W, halfD: D, wallT: T } = ROOM;

export const WALLS: WallDef[] = [
  {
    id: 'back', axis: 'x', at: -D, outward: [0, -1], span: [-W - T, W + T], baseSpan: [-W, W],
    openings: [
      { kind: 'window', from: -7.45, to: -5.85, sill: 1.12, top: 2.3 },
      { kind: 'window', from: -3.35, to: -1.95, sill: 0.42, top: 2.45, curtains: true },
      { kind: 'window', from: 1.95, to: 3.35, sill: 0.42, top: 2.45, curtains: true },
      { kind: 'window', from: 7.45, to: 8.65, sill: 0.85, top: 2.35 },
    ],
    // the kitchen run (x < −3.95) stays plain behind the cabinets; the rest of the room is wainscoted
    bands: [
      { from: -3.95, to: -1.95, paint: 'warmWhite', dado: 'panel:warmWhite' },
      { from: -1.95, to: 1.95, paint: 'sage', dado: 'panel:sage' },
      { from: 1.95, to: 3.6, paint: 'warmWhite', dado: 'panel:warmWhite' },
      { from: 3.6, to: 9.2, paint: 'mist', dado: 'panel:mist' },
    ],
  },
  {
    id: 'front', axis: 'x', at: D, outward: [0, 1], span: [-W - T, W + T], baseSpan: [-W, W],
    openings: [
      { kind: 'window', from: -6.2, to: -4.6, sill: 0.6, top: 2.35 },
      { kind: 'window', from: -1.0, to: 1.0, sill: 0.6, top: 2.35 },
      { kind: 'window', from: 4.6, to: 6.2, sill: 0.6, top: 2.35 },
    ],
    bands: [{ from: -W - T, to: W + T, paint: 'warmWhite', dado: 'panel:warmWhite' }],
  },
  {
    id: 'left', axis: 'z', at: -W, outward: [-1, 0], span: [-D, D],
    openings: [
      { kind: 'window', from: -3.75, to: -2.15, sill: 0.8, top: 2.3, curtains: true },
      { kind: 'door', from: 2.35, to: 3.35, sill: 0, top: 2.1 },
    ],
    bands: [
      { from: -D, to: -4.6, paint: 'warmWhite' },
      { from: -4.6, to: -1.2, paint: 'warmWhite', dado: 'panel:warmWhite' },
      { from: -1.2, to: 1.8, paint: 'clay', dado: 'panel:clay' },
      { from: 1.8, to: D, paint: 'warmWhite', dado: 'panel:warmWhite' },
    ],
  },
  {
    id: 'right', axis: 'z', at: W, outward: [1, 0], span: [-D, D],
    openings: [
      { kind: 'window', from: -4.7, to: -3.1, sill: 0.85, top: 2.35 },
      // a high stair window: the flight climbs along this wall
      { kind: 'window', from: 3.4, to: 4.8, sill: 1.75, top: 2.5 },
    ],
    bands: [{ from: -D, to: D, paint: 'warmWhite', dado: 'panel:warmWhite' }],
  },
];

/** Wainscot tones of the ground-floor paints (a shade deeper than the wall above). */
export const PANELS: Record<keyof typeof PAINTS, string> = {
  warmWhite: '#e6dccb',
  sage: '#93a38a',
  clay: '#e3d6c3',
  mist: '#ddd3c2',
};

/** Front door (left wall). Inside/outside points used for subagents entering and leaving. */
export const DOOR = {
  wall: 'left' as WallId,
  center: { x: -W, z: 2.85 },
  inside: { x: -W + 0.75, z: 2.85 },
  outside: { x: -W - 1.6, z: 2.85 },
};

/** Default camera framing (orbit target + spherical): close enough that the rooms read as lived-in spaces and the
 *  people as people (not a parquet sea with ants at 24 m), still showing the floor from the kitchen to the desks. */
export const CAMERA_HOME = {
  target: { x: -0.4, y: 0.4, z: 0.5 },
  azimuthDeg: 26, // rotation from +Z toward +X
  elevationDeg: 44, // above the horizon
  distance: 17,
  minDistance: 5,
  maxDistance: 30,
  minElevationDeg: 22,
  maxElevationDeg: 72,
};

/** The elevator's framing of a whole storey (floor switcher): every room, the stairs and the front walls, between
 *  the floor switcher on the left and the side panel on the right (1600×900 with the panel open). The entry pose
 *  above is closer and crops the outer rooms of an upper floor. */
export const FLOOR_OVERVIEW = {
  target: { x: -0.05, y: 0.4, z: 1.55 },
  azimuthDeg: 26,
  elevationDeg: 50,
  distance: 24,
};

// ───────────── Upper floors (shared/house-plan.ts: corridor + four rooms + stairwell) ─────────────

/** The straight flight runs in a 1 m lane along the right wall (bottom at z = 5.6, top at the landing z = 0.4);
 *  beside it a narrow gallery connects the landing with the foot of the next flight up. Flights of successive
 *  floors are stacked exactly, so the head-room under each one is a full storey. */
export const STAIR = {
  laneX0: 7.9,
  laneX1: 8.9,
  bottomZ: 5.6,
  topZ: 0.4,
  risers: 16,
  /** Upper floors: the slab is open over the lane from the landing to here (the foot of the next flight is solid). */
  holeZ1: 5.0,
};

/** Interior paints upstairs, per job kind: the wainscot below the chair rail (`panel`), the walls above it (`base`)
 *  and the room's display wall above the rail (`feature`). */
export const KIND_PAINTS: Record<'empty' | 'general' | 'code' | 'write' | 'research', { panel: string; base: string; feature: string }> = {
  empty: { panel: '#efe6d8', base: '#f6efe4', feature: '#f4ebde' },
  // warm white walls, one accent wall per room (the display wall above the rail)
  general: { panel: '#e2d5c1', base: '#efe7da', feature: '#c9826b' },
  code: { panel: '#e3dccf', base: '#efe7da', feature: '#3e5165' },
  write: { panel: '#cfd6c5', base: '#efe7da', feature: '#a9b8a0' },
  research: { panel: '#e2d6c2', base: '#e9e1d3', feature: '#c9a46a' },
};
export const CORRIDOR_PAINT = '#efe7da';
export const CORRIDOR_PANEL = '#e0d4c1';

const PT = 0.14; // = PARTITION_T in shared/house-plan.ts
const win = (from: number, to: number, sill = 0.55, top = 2.4, curtains = false): Opening => ({ kind: 'window', from, to, sill, top, curtains });
const door = (from: number, to: number): Opening => ({ kind: 'door', from, to, sill: 0, top: 2.1 });

/** Walls of an upper floor. Paint names resolve per room (r0..r3 = slots A..D) so a room can be repainted for
 *  a new job kind by recoloring its two materials, without rebuilding any geometry. */
export function upperWalls(): WallDef[] {
  const room = (slot: number, from: number, to: number, which: 'base' | 'feature' = 'base'): PaintBand =>
    ({ from, to, paint: `r${slot}:${which}`, dado: `r${slot}:panel` });
  const corr = (from: number, to: number): PaintBand => ({ from, to, paint: 'corridor', dado: 'corridor-panel' });
  return [
    // exterior — back rooms get a wide window on their back (display) wall, every outer end gets one too
    {
      id: 'back', axis: 'x', at: -D, outward: [0, -1], span: [-W - T, W + T], baseSpan: [-W, W],
      openings: [win(-8.2, -6.4, 0.55, 2.4, true), win(6.4, 8.2, 0.55, 2.4, true)],
      bands: [room(0, -W - T, 0, 'feature'), room(1, 0, W + T, 'feature')],
    },
    {
      id: 'front', axis: 'x', at: D, outward: [0, 1], span: [-W - T, W + T], baseSpan: [-W, W],
      openings: [win(-8.1, -6.6), win(-4.4, -3.0), win(2.3, 3.7), win(4.8, 6.2), win(7.45, 8.55, 0.9, 2.35)],
      bands: [room(2, -W - T, 0), room(3, 0, 7.1), corr(7.1, W + T)],
    },
    {
      id: 'left', axis: 'z', at: -W, outward: [-1, 0], span: [-D, D],
      openings: [win(-4.8, -3.4, 0.8, 2.35, true), win(-0.55, 0.55, 0.85, 2.35), win(2.3, 3.7, 0.8, 2.35, true)],
      bands: [room(0, -D, -1), corr(-1, 1), room(2, 1, D)],
    },
    {
      id: 'right', axis: 'z', at: W, outward: [1, 0], span: [-D, D],
      openings: [win(-4.8, -3.4, 0.8, 2.35), win(-0.55, 0.55, 0.85, 2.35), win(2.4, 4.0, 1.6, 2.5)],
      bands: [room(1, -D, -1), corr(-1, D)],
    },
    // partitions (inner face toward the rooms, outer toward the corridor / the neighbour room)
    {
      id: 'corr-n', axis: 'x', at: -1 - PT / 2, outward: [0, 1], span: [-W, W], thickness: PT,
      openings: [door(-2.6, -1.5), door(1.5, 2.6)],
      bands: [room(0, -W, 0), room(1, 0, W)],
      outerBands: [corr(-W, W)],
    },
    {
      id: 'corr-s', axis: 'x', at: 1 + PT / 2, outward: [0, -1], span: [-W, 7.1 + PT / 2], thickness: PT,
      openings: [door(-2.6, -1.5), door(1.5, 2.6)],
      bands: [room(2, -W, 0, 'feature'), room(3, 0, 7.1 + PT / 2, 'feature')],
      outerBands: [corr(-W, 7.1 + PT / 2)],
    },
    {
      id: 'mid-n', axis: 'z', at: -PT / 2, outward: [1, 0], span: [-D, -1 - PT / 2], thickness: PT, openings: [],
      bands: [room(0, -D, 0)], outerBands: [room(1, -D, 0)],
    },
    {
      id: 'mid-s', axis: 'z', at: -PT / 2, outward: [1, 0], span: [1 + PT / 2, D], thickness: PT, openings: [],
      bands: [room(2, 0, D)], outerBands: [room(3, 0, D)],
    },
    {
      id: 'stair', axis: 'z', at: 7.1 - PT / 2, outward: [1, 0], span: [1 + PT / 2, D], thickness: PT, openings: [],
      bands: [room(3, 0, D)], outerBands: [corr(0, D)],
    },
  ];
}
