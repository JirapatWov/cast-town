// Real Life Terminal — house floor plan: floors and job rooms. Pure data shared by the server (validation),
// the 3D house (geometry) and the 2D room picker (mini plans). Coordinates are house-local meters, the same
// frame as web/src/house/layout.ts: interior x ∈ [-9, 9], z ∈ [-6, 6], camera looks from +Z/+X.
//
// One job lives in one room (see shared/protocol.ts Job.room). Floor 0 is the shared ground floor (living room,
// kitchen, TV, front door) with ONE job room: the existing open-plan workroom corner. Every upper floor has a
// corridor along x, the stair landing at its east end, and four rooms with a door onto the corridor:
//
//   z=-6 ┌───────────────────┬─────────────────────┐
//        │  slot 0 (A)       │  slot 1 (B)         │
//        │  back-left        │  back-right         │
//   z=-1 ├──door─────────────┴──door───────────────┤
//        │  corridor                     landing ⇅ │
//   z=+1 ├──door─────────────┬──door────────┬──────┤
//        │  slot 2 (C)       │  slot 3 (D)  │stair │
//        │  front-left       │  front-right │ well │
//   z=+6 └───────────────────┴──────────────┴──────┘
//      x=-9                 x=0           x=7.1  x=9
//
// UI naming: floors are numbered from 1 ("Floor 1" = ground), rooms are `${floor + 1}${letter}` e.g. "1A", "2C".

export interface Rect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

export interface RoomSlotDef {
  floor: number;
  slot: number;
  code: string; // "1A", "2B", …
  /** Room extent measured between wall centerlines (builders inset by half a wall). */
  rect: Rect;
  /** Door gap in the wall onto the corridor (upper floors), along that wall's axis. Ground floor: null (open plan). */
  door: { wall: 'z-' | 'z+'; at: number; from: number; to: number } | null;
  /** Where the room's name plate hangs (house-local, y = height above that floor). */
  plate: { x: number; y: number; z: number };
}

export const MAX_FLOORS = 5;
/** Floor-to-floor height (m): ceiling 2.8 + slab. City storeys and the 3D house both use it. */
export const STOREY_H = 3.2;
export const PARTITION_T = 0.14;

/** Stairwell: same footprint on every floor. Ground floor: a straight flight rising from z=5.6 (bottom) to the
 *  landing at z≈0.4. Upper floors: an open well with a railing over z ∈ [1, 5.6] plus the next flight up (if any). */
export const STAIRS: Rect & { bottomZ: number; topZ: number } = { x0: 7.1, z0: 0.4, x1: 8.9, z1: 5.6, bottomZ: 5.6, topZ: 0.4 };

/** Upper floors: corridor between the room rows (runs x ∈ [-9, 9]; its east end is the stair landing). */
export const CORRIDOR: Rect = { x0: -9, z0: -1, x1: 9, z1: 1 };

const LETTERS = 'ABCD';

const UPPER: { rect: Rect; door: NonNullable<RoomSlotDef['door']>; plate: { x: number; z: number } }[] = [
  { rect: { x0: -9, z0: -6, x1: 0, z1: -1 }, door: { wall: 'z-', at: -1, from: -2.6, to: -1.5 }, plate: { x: -3.05, z: -0.9 } },
  { rect: { x0: 0, z0: -6, x1: 9, z1: -1 }, door: { wall: 'z-', at: -1, from: 1.5, to: 2.6 }, plate: { x: 3.05, z: -0.9 } },
  { rect: { x0: -9, z0: 1, x1: 0, z1: 6 }, door: { wall: 'z+', at: 1, from: -2.6, to: -1.5 }, plate: { x: -3.05, z: 0.9 } },
  { rect: { x0: 0, z0: 1, x1: STAIRS.x0, z1: 6 }, door: { wall: 'z+', at: 1, from: 1.5, to: 2.6 }, plate: { x: 3.05, z: 0.9 } },
];

/** Ground floor job room: the open-plan workroom corner (three desks + corkboard on the back wall). */
const GROUND: RoomSlotDef = {
  floor: 0,
  slot: 0,
  code: '1A',
  rect: { x0: 3.3, z0: -6, x1: 9, z1: -0.5 },
  door: null,
  plate: { x: 6.1, y: 2.45, z: -5.85 },
};

export function slotsOnFloor(floor: number): number {
  return floor === 0 ? 1 : floor > 0 && floor < MAX_FLOORS ? UPPER.length : 0;
}

export function roomCode(floor: number, slot: number): string {
  return `${floor + 1}${LETTERS[slot] ?? '?'}`;
}

export function roomSlot(floor: number, slot: number): RoomSlotDef | null {
  if (!Number.isInteger(floor) || !Number.isInteger(slot) || slot < 0 || slot >= slotsOnFloor(floor)) return null;
  if (floor === 0) return GROUND;
  const u = UPPER[slot];
  return { floor, slot, code: roomCode(floor, slot), rect: u.rect, door: u.door, plate: { x: u.plate.x, y: 2.35, z: u.plate.z } };
}

/** Every room of a building with `floors` floors, bottom to top. */
export function roomsOf(floors: number): RoomSlotDef[] {
  const out: RoomSlotDef[] = [];
  for (let f = 0; f < Math.min(floors, MAX_FLOORS); f++) for (let s = 0; s < slotsOnFloor(f); s++) out.push(roomSlot(f, s)!);
  return out;
}

export function sameRoom(a: { floor: number; slot: number }, b: { floor: number; slot: number }): boolean {
  return a.floor === b.floor && a.slot === b.slot;
}
