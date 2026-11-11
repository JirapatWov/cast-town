// Station slots with occupancy, one registry per floor. Slots are created by the furniture builders (tagged with
// the job room they belong to, or untagged for shared spots: kitchen, living room, corridor); people claim and
// release them. A person claims in their own room first, then shared spots — never in another job's room.
// Working agents own a desk in their room (`ownDesk`): it stays theirs while they step away between tasks.
import * as THREE from 'three';
import type { Slot, StationKind, Stations } from '../people/types';

export class StationRegistry {
  private slots: Slot[] = [];

  add(kind: StationKind, id: string, pos: THREE.Vector3, yaw: number, extra: Partial<Slot> = {}): Slot {
    const slot: Slot = { id, kind, pos: pos.clone(), yaw, occupant: null, ...extra };
    this.slots.push(slot);
    return slot;
  }

  /** Take over slots built elsewhere (a room furnished off to the side, swapped in when complete). */
  adopt(slots: Slot[]) {
    for (const s of slots) if (!this.slots.includes(s)) this.slots.push(s);
  }

  /** Remove slots (a room's furniture is going away). Returns the agents that were using them. */
  remove(pred: (s: Slot) => boolean): string[] {
    const gone = this.slots.filter(pred);
    this.slots = this.slots.filter((s) => !pred(s));
    const evicted: string[] = [];
    for (const s of gone) {
      if (s.occupant) evicted.push(s.occupant);
      s.screen?.setActive(false);
      s.occupant = null;
    }
    return evicted;
  }

  /** Claim view for one job room (undefined room → no preference, e.g. a house without job data yet). */
  forRoom(room: number | undefined): Stations {
    return {
      claim: (kinds, agentId, near) => this.claim(kinds, agentId, near, room),
      release: (slot) => this.release(slot),
      ownDesk: (agentId) => this.ownDesk(agentId, room),
      disown: (agentId) => this.disown(agentId),
      all: () => this.slots,
    };
  }

  claim(kinds: StationKind[], agentId: string, near?: THREE.Vector3, room?: number): Slot | null {
    // Already holding one of these kinds here? Keep it (no musical chairs on repeated events). (A seat in a room the
    // agent moved away from stays theirs until they are off it: it is not one to keep.)
    const held = this.slots.find((s) => s.occupant === agentId && kinds.includes(s.kind) && (room === undefined || s.room === undefined || s.room === room));
    if (held) return held;
    // Never another job's room: a person with no free spot stands in their own room instead (Person.roomSpot).
    const scopes: ((s: Slot) => boolean)[] = room === undefined
      ? [() => true]
      : [(s) => s.room === room, (s) => s.room === undefined];
    for (const inScope of scopes) {
      for (const kind of kinds) {
        // someone else's own desk stays theirs while they step away (idle wanderers, helpers, other workers)
        const free = this.slots.filter((s) => s.kind === kind && !s.occupant && (!s.owner || s.owner === agentId) && inScope(s));
        if (!free.length) continue;
        let best = free[0];
        if (near) {
          let bestD = Infinity;
          for (const s of free) {
            const d = s.pos.distanceToSquared(near) * (0.85 + 0.3 * pseudo(s.id, agentId));
            if (d < bestD) { bestD = d; best = s; }
          }
        } else {
          best = free[Math.floor(pseudo(kind, agentId) * free.length) % free.length];
        }
        best.occupant = agentId;
        return best;
      }
    }
    return null;
  }

  release(slot: Slot | null | undefined) {
    if (!slot) return;
    slot.occupant = null;
    slot.releasedAt = performance.now();
    slot.screen?.setActive(false);
  }

  /** Every working agent sits at its own desk for the whole task (see Stations.ownDesk). Desks are only taken in
   *  the agent's room (any desk when `room` is undefined); a desk someone else sits at is never taken. */
  ownDesk(agentId: string, room?: number): Slot | null {
    const desks = this.slots.filter((s) => s.kind === 'desk' && (room === undefined || s.room === room));
    const mine = desks.find((s) => s.owner === agentId && (!s.occupant || s.occupant === agentId));
    if (mine) {
      mine.occupant = agentId;
      return mine;
    }
    this.disown(agentId);
    const free = desks.filter((s) => !s.owner && !s.occupant);
    let best: Slot | undefined;
    if (free.length) {
      const pool = free.some((s) => s.screen) ? free.filter((s) => s.screen) : free;
      best = pool.reduce((a, b) => (pseudo(b.id, agentId) < pseudo(a.id, agentId) ? b : a));
    } else {
      // more workers than desks: the desk whose owner has been away longest goes to whoever is working
      const away = desks.filter((s) => s.owner && !s.occupant);
      if (away.length) best = away.reduce((a, b) => ((b.releasedAt ?? 0) < (a.releasedAt ?? 0) ? b : a));
    }
    if (!best) return null;
    best.owner = agentId;
    best.occupant = agentId;
    return best;
  }

  disown(agentId: string) {
    for (const s of this.slots) if (s.owner === agentId) s.owner = null;
  }

  releaseAll(agentId: string) {
    for (const s of this.slots) if (s.occupant === agentId) this.release(s);
  }

  all(): Slot[] {
    return this.slots;
  }
}

// Stable per-(slot, agent) jitter so people spread out but do not reshuffle every call.
function pseudo(a: string, b: string): number {
  let h = 2166136261;
  for (const ch of a + '|' + b) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 1000) / 1000;
}
