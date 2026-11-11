// Seam between the house (stations, navigation, camera) and the people (characters, controllers).
import type * as THREE from 'three';

export type StationKind =
  | 'desk' // writing (sit + type)
  | 'sofa' // idle sit / searching
  | 'armchair' // searching / idle sit
  | 'bookshelf' // reading
  | 'counter' // running (kitchen counter, lean)
  | 'workbench' // running / chore fixing
  | 'window' // idle / searching (phone)
  | 'coffee' // idle / done (drink)
  | 'corkboard' // delegating
  | 'pace' // thinking (pace between two points near the board)
  | 'center' // listening / waiting_approval (face the camera)
  | 'sink' // chore: dishes
  | 'plants' // chore: watering
  | 'washer' // chore: laundry
  | 'vacuum' // chore: vacuum path
  | 'dining'; // idle sit

export interface SitSpec {
  /** Seat surface height (m); the body is lowered so the hips land on it. */
  seatY: number;
  /** Chair that is pulled out before sitting and pushed back in after (desk chairs). */
  chair?: THREE.Object3D;
  /** How far the chair is pulled out along −facing (m); the person scoots back in by the same amount. */
  slide?: number;
}

export interface Slot {
  id: string;
  kind: StationKind;
  /** Where the person's hips are while using the slot, on the floor (house-local, y = 0). For sit slots:
   *  the seat centre with the chair tucked in. */
  pos: THREE.Vector3;
  /** Facing yaw (radians, 0 = +Z). */
  yaw: number;
  sit?: SitSpec;
  /** Extra waypoints for moving activities (pacing, vacuuming). */
  route?: THREE.Vector3[];
  /** Monitor/screen that animates while someone works here. */
  screen?: { setActive(on: boolean, tint?: string): void };
  /** Job room slot (shared/house-plan.ts) the station belongs to; undefined = shared (kitchen, corridor…). */
  room?: number;
  occupant: string | null;
  /** Desks only: the agent whose own desk this is (sticky while they step away; `claim` never hands it to anyone
   *  else, `ownDesk` gives it to another worker only when the room has more workers than desks). */
  owner?: string | null;
  /** performance.now() of the last release (oldest-absent owner loses their desk first). */
  releasedAt?: number;
}

export interface Stations {
  /** Claim the best free slot among `kinds` (in preference order), nearest to `near` when given. Never another
   *  agent's own desk. */
  claim(kinds: StationKind[], agentId: string, near?: THREE.Vector3): Slot | null;
  /** Release the slot (its owner, if any, keeps it). */
  release(slot: Slot | null | undefined): void;
  /** The agent's own desk in this room, claimed (owner and occupant): the one it owns; else a free unowned desk
   *  (screen desks first, then a stable per-agent favourite); else the desk of an owner who stepped away
   *  (longest away first). Null when every desk is in use. */
  ownDesk(agentId: string): Slot | null;
  /** Forget the agent's desk ownership (leaving, moved rooms, gone). */
  disown(agentId: string): void;
  all(): Slot[];
}

/** Where a person lives: one floor of the house, scoped to their job's room. Coordinates are floor-local
 *  (y = 0 on the floor; the floor's root carries the storey height). */
export interface PeopleWorld {
  /** Parent for people on this floor. */
  root: THREE.Object3D;
  /** Floor index (0 = ground). */
  floor: number;
  /** Stations, claimed in the job's room first. */
  stations: Stations;
  /** Walkable path (floor-local), including `to` as the last point; [] when unreachable. */
  findPath(from: THREE.Vector3, to: THREE.Vector3): THREE.Vector3[];
  /** Nearest walkable point (floor-local). */
  snap(p: THREE.Vector3): THREE.Vector3;
  /** Where helpers come in and leave: the front door on the ground floor, the stairs upstairs (`outside` is the
   *  foot of the flight one storey down; `heightAt` lifts people along it). */
  door: { inside: THREE.Vector3; outside: THREE.Vector3; open(on: boolean): void };
  /** Height of the walking surface at (x, z) relative to this floor (non-zero only on the stairs). */
  heightAt(x: number, z: number): number;
  /** A sensible spot to place someone who just appeared (their room's open floor). */
  spawnPoint(): THREE.Vector3;
  /** Camera position in floor-local space (people face it when listening / calling). */
  cameraPosition(out: THREE.Vector3): THREE.Vector3;
}
