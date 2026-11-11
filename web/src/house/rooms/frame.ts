// Canonical frame for an upper-floor job room, so one layout per job kind fits all four rooms.
//   u: along the room from its OUTER end (exterior / stairwell side) to its INNER end (the x = 0 partition)
//   v: from the DISPLAY wall (the low-z wall the dollhouse camera looks at) toward the camera (the near wall)
//   yaw 0 faces +v; rooms B and D are mirrored in x, so world yaw = −canonical yaw there.
// Back rooms (A, B) have their door on the near wall (the corridor) and windows on the display wall; front rooms
// (C, D) have their door on the display wall and windows on the near wall. Room D is narrower (6.96 m).
import * as THREE from 'three';
import { PARTITION_T, type RoomSlotDef } from '../../../../shared/house-plan';
import type { StationKind, Slot } from '../../people/types';
import type { Kit } from '../furniture/kit';
import { ROOM, type WallDef, type WallId } from '../layout';

export type RoomWall = 'display' | 'near' | 'outer' | 'inner';

export interface FrameOpening {
  wall: RoomWall;
  /** Canonical range along that wall (u for display/near walls, v for outer/inner walls). */
  from: number;
  to: number;
  sill: number;
  top: number;
  kind: 'window' | 'door';
}

export class RoomFrame {
  readonly slot: number;
  readonly code: string;
  readonly mirror: boolean;
  readonly front: boolean;
  readonly small: boolean;
  /** Clear interior (between wall faces), floor-local. */
  readonly x0: number;
  readonly x1: number;
  readonly z0: number;
  readonly z1: number;
  readonly W: number;
  readonly D: number;
  readonly openings: FrameOpening[] = [];
  readonly door: FrameOpening;
  /** Centre of the corkboard (run board) on the display wall. */
  readonly boardU: number;

  constructor(def: RoomSlotDef, walls: WallDef[]) {
    this.slot = def.slot;
    this.code = def.code;
    const r = def.rect;
    const h = PARTITION_T / 2;
    const ext = (v: number, lim: number) => Math.abs(Math.abs(v) - lim) < 1e-6;
    this.x0 = ext(r.x0, ROOM.halfW) ? r.x0 : r.x0 + h;
    this.x1 = ext(r.x1, ROOM.halfW) ? r.x1 : r.x1 - h;
    this.z0 = ext(r.z0, ROOM.halfD) ? r.z0 : r.z0 + h;
    this.z1 = ext(r.z1, ROOM.halfD) ? r.z1 : r.z1 - h;
    this.mirror = r.x0 >= 0;
    this.front = r.z0 >= 0;
    this.W = this.x1 - this.x0;
    this.D = this.z1 - this.z0;
    this.small = this.W < 8;
    for (const w of walls) this.collectOpenings(w);
    const door = this.openings.find((o) => o.kind === 'door');
    this.door = door ?? { wall: 'near', from: this.W - 2.6, to: this.W - 1.5, sill: 0, top: 2.1, kind: 'door' };
    this.boardU = this.small ? 2.5 : 4.2;
  }

  /** Floor-local x/z of a canonical point. */
  xz(u: number, v: number): { x: number; z: number } {
    return { x: this.mirror ? this.x1 - u : this.x0 + u, z: this.z0 + v };
  }

  vec(u: number, v: number, y = 0): THREE.Vector3 {
    const p = this.xz(u, v);
    return new THREE.Vector3(p.x, y, p.z);
  }

  yaw(cyaw: number): number {
    return this.mirror ? -cyaw : cyaw;
  }

  /** Inverse of xz (for points known in floor space). */
  uv(x: number, z: number): { u: number; v: number } {
    return { u: this.mirror ? this.x1 - x : x - this.x0, v: z - this.z0 };
  }

  wallId(w: RoomWall): WallId {
    if (w === 'display') return this.front ? 'corr-s' : 'back';
    if (w === 'near') return this.front ? 'front' : 'corr-n';
    if (w === 'inner') return this.front ? 'mid-s' : 'mid-n';
    if (this.slot === 3) return 'stair';
    return this.mirror ? 'right' : 'left';
  }

  /** Canonical yaw of something standing against a wall, facing into the room. */
  faceFrom(w: RoomWall): number {
    return w === 'display' ? 0 : w === 'near' ? Math.PI : w === 'outer' ? Math.PI / 2 : -Math.PI / 2;
  }

  // ── placement helpers ──────────────────────────────────────────────────────────────────────────
  place<T extends THREE.Object3D>(kit: Kit, obj: T, u: number, v: number, cyaw = 0, y = 0): T {
    const p = this.xz(u, v);
    return kit.add(obj, p.x, p.z, this.yaw(cyaw), y);
  }

  /** Nav obstacle: w along the object's local x, d along its local z, rotated by the canonical yaw. */
  block(kit: Kit, u: number, v: number, w: number, d: number, cyaw = 0) {
    const p = this.xz(u, v);
    kit.block(p.x, p.z, w, d, this.yaw(cyaw));
  }

  station(kit: Kit, kind: StationKind, id: string, u: number, v: number, cyaw: number, extra: Partial<Slot> = {}): Slot {
    const route = extra.route?.map((p) => this.vec(p.x, p.z));
    return kit.stations.add(kind, id, this.vec(u, v), this.yaw(cyaw), route ? { ...extra, route } : extra);
  }

  /** Route through canonical (u, v) points (for station routes, pass these through `station`). */
  pts(...uv: [number, number][]): THREE.Vector3[] {
    return uv.map(([u, v]) => new THREE.Vector3(u, 0, v));
  }

  /** Hang something on one of the room's walls (hidden while that wall is cut down). */
  onWall(kit: Kit, w: RoomWall, obj: THREE.Object3D, u: number, v: number, y: number, minHeight: number, cyaw = this.faceFrom(w)) {
    const p = this.xz(u, v);
    obj.position.set(p.x, y, p.z);
    obj.rotation.y = this.yaw(cyaw);
    kit.onWall(this.wallId(w), obj, minHeight);
  }

  windows(w?: RoomWall): FrameOpening[] {
    return this.openings.filter((o) => o.kind === 'window' && (!w || o.wall === w));
  }

  /** Is the canonical interval [a, b] on a wall clear of its openings (with a margin)? */
  clear(w: RoomWall, a: number, b: number, margin = 0.08): boolean {
    return !this.openings.some((o) => o.wall === w && o.from - margin < b && o.to + margin > a);
  }

  private collectOpenings(def: WallDef) {
    const which = this.wallOfDef(def);
    if (!which) return;
    for (const o of def.openings) {
      let a: number, b: number;
      if (def.axis === 'x') {
        if (o.to <= this.x0 + 1e-3 || o.from >= this.x1 - 1e-3) continue;
        const ua = this.uv(o.from, 0).u, ub = this.uv(o.to, 0).u;
        a = Math.min(ua, ub); b = Math.max(ua, ub);
      } else {
        if (o.to <= this.z0 + 1e-3 || o.from >= this.z1 - 1e-3) continue;
        a = o.from - this.z0; b = o.to - this.z0;
      }
      this.openings.push({ wall: which, from: a, to: b, sill: o.sill, top: o.top, kind: o.kind });
    }
  }

  private wallOfDef(def: WallDef): RoomWall | null {
    const ids: RoomWall[] = ['display', 'near', 'outer', 'inner'];
    for (const w of ids) if (this.wallId(w) === def.id) return w;
    return null;
  }
}
