// Adapter from the house view to what the player needs: one walkable ground per floor (nav grid, stairs-aware
// height), the residents on a floor, desks with computers, what a click would hit, and the stair geometry.
// It reads the house through its dev handle so the house contract stays untouched; if the house internals change,
// this file is the one to adapt.
import * as THREE from 'three';
import { STOREY_H, roomSlot } from '../../../shared/house-plan';
import type { HouseView } from '../core/types';
import type { HouseDev } from '../house';
import type { Floor } from '../house/floors';
import { STAIR } from '../house/layout';
import { flightHeight } from '../house/stairs';
import type { PeopleManager } from '../people/manager';
import type { Person } from '../people/person';
import type { Slot } from '../people/types';
import type { Ground, Neighbour } from './avatar';

export type HouseHit = { kind: 'person'; agentId: string } | { kind: 'prop'; prop: string } | null;

export interface HouseHost {
  readonly view: HouseView;
  floorCount(): number;
  shownFloor(): number;
  ground(floor: number): Ground | null;
  /** Floor root (raycast target for clicks on the floor / furniture). */
  root(floor: number): THREE.Object3D | null;
  /** What the house's own picker would do with a click here. */
  pickAt(x: number, y: number): HouseHit;
  /** Residents on a floor, ground-local, with a velocity estimate (call once per frame). */
  neighbours(floor: number, dt: number): Neighbour[];
  /** Ground-local position of a resident if they are on `floor`. */
  personAt(agentId: string, floor: number): THREE.Vector3 | null;
  /** Desks with a computer on a floor. */
  computers(floor: number): Slot[];
  /** Where the room's people gather (ground-local), for walking into a job's room. */
  roomSpot(floor: number, slot: number): THREE.Vector3 | null;
  /** The ground floor's front door (ground-local), for walking in from the street. */
  frontDoor(): { inside: THREE.Vector3; outside: THREE.Vector3; open(on: boolean): void } | null;
}

/** Stair geometry (floor-local): the flight up from each floor runs along the lane, foot near the front wall. */
export const STAIRS = {
  laneX: (STAIR.laneX0 + STAIR.laneX1) / 2,
  footZ: STAIR.bottomZ + 0.22,
  topZ: STAIR.topZ,
  /** The landing just off the top of a flight, on the floor it arrives at. */
  landing: new THREE.Vector3((STAIR.laneX0 + STAIR.laneX1) / 2, 0, STAIR.topZ - 0.62),
  inLane: (x: number) => x > STAIR.laneX0 - 0.05 && x < STAIR.laneX1 + 0.1,
  /** Height on the flight that rises from this floor (0 at the foot, STOREY_H at the top). */
  up: (z: number) => flightHeight(z),
  storey: STOREY_H,
};

export function createHouseHost(house: HouseView & { dev: HouseDev }): HouseHost {
  const grounds = new WeakMap<Floor, Ground>();
  const track = new Map<string, { pos: THREE.Vector3; vel: THREE.Vector3 }>();

  const floors = () => house.dev.floors();
  const people = () => house.dev.people() as PeopleManager | undefined;

  function groundOf(f: Floor): Ground {
    let g = grounds.get(f);
    if (g) return g;
    const w = f.world();
    g = {
      get root() {
        return w.root;
      },
      findPath: (a, b) => w.findPath(a, b),
      snap: (p) => w.snap(p),
      isFree: (x, z) => f.nav.isFree(x, z),
      heightAt: (x, z) => w.heightAt(x, z),
      cameraPosition: (out) => w.cameraPosition(out),
      hasSlot: (s) => w.stations.all().includes(s),
    };
    grounds.set(f, g);
    return g;
  }

  const residentsOn = (floor: number): Person[] => (people()?.all() ?? []).filter((p) => p.world.floor === floor);

  return {
    view: house,
    floorCount: () => floors().length,
    shownFloor: () => house.floor,
    ground(floor) {
      const f = floors()[floor];
      return f ? groundOf(f) : null;
    },
    root(floor) {
      return floors()[floor]?.root ?? null;
    },
    pickAt(x, y) {
      const h = house.dev.pickAt(x, y) as { kind?: string; agentId?: string } | null;
      if (!h) return null;
      if (h.kind === 'person' && h.agentId) return { kind: 'person', agentId: h.agentId };
      return { kind: 'prop', prop: String(h.kind) };
    },
    neighbours(floor, dt) {
      const out: Neighbour[] = [];
      const seen = new Set<string>();
      for (const p of residentsOn(floor)) {
        seen.add(p.id);
        let t = track.get(p.id);
        if (!t) {
          t = { pos: p.position.clone(), vel: new THREE.Vector3() };
          track.set(p.id, t);
        }
        if (dt > 0) {
          const v = p.position.clone().sub(t.pos).divideScalar(dt).setY(0);
          if (v.lengthSq() > 25) v.set(0, 0, 0); // teleported (relocated / placed)
          t.vel.lerp(v, Math.min(1, dt * 6));
        }
        t.pos.copy(p.position);
        out.push({ id: p.id, pos: p.position, vel: t.vel, target: p.slot ? p.slot.pos : null });
      }
      for (const id of track.keys()) if (!seen.has(id)) track.delete(id);
      return out;
    },
    personAt(agentId, floor) {
      const p = people()?.people.get(agentId);
      return p && p.world.floor === floor ? p.position : null;
    },
    computers(floor) {
      const f = floors()[floor];
      if (!f) return [];
      return f.world().stations.all().filter((s) => s.kind === 'desk' && !!s.sit && !!s.screen);
    },
    roomSpot(floor, slot) {
      const f = floors()[floor];
      if (!f || !roomSlot(floor, slot)) return null;
      return f.world(slot).spawnPoint().clone();
    },
    frontDoor() {
      const f = floors()[0];
      return f ? f.world().door : null;
    },
  };
}
