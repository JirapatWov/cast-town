// One storey of the house: its shell, furniture, stations, nav grid, people root, room plates and job rooms.
// Floor 0 is the shared ground floor (kitchen, living room, TV, front door; job room 1A = the workroom corner).
// Upper floors have a corridor, four job rooms (furnished by job kind, or bare and lit when available) and the
// stairwell. A floor is 'shown' (cutaway, furniture, people, plates), 'below' the shown one (walls up, interior
// hidden, windows glowing) or 'hidden' (above the shown one). People keep simulating whatever the state.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { STOREY_H, roomSlot, slotsOnFloor, type RoomSlotDef } from '../../../shared/house-plan';
import type { Job, JobKind, RoomRef } from '../../../shared/protocol';
import type { Assets } from '../core/types';
import type { PeopleWorld } from '../people/types';
import { batchStatic } from './batch';
import { instanceChairs } from './chairs';
import type { Corkboard } from './corkboard';
import { furnishCorridor } from './corridor';
import { Cutaway } from './cutaway';
import { buildUpperShell, type UpperShell } from './floor-upper';
import { furnish, type Furnished } from './furniture';
import { Kit, type PickTarget } from './furniture/kit';
import { DOOR, KIND_PAINTS, ROOM, STAIR, type WallId } from './layout';
import type { LampSpec } from './lighting';
import type { Palette } from './materials';
import { NavGrid, type Rect } from './nav-grid';
import type { DoorHandle } from './openings';
import type { PickEntry } from './picking';
import { RoomPlate } from './plates';
import { RoomFrame } from './rooms/frame';
import { furnishEmptyRoom, furnishJobRoom } from './rooms/kinds';
import { buildShell, mergeShadowCasters, type Shell } from './shell';
import { buildLot } from './lot';
import { buildFlight, flightHeight, flightTopFor, inStairLane, type Flight } from './stairs';
import { viewGlass, type ViewGlass } from './window-view';
import { StationRegistry } from './stations';
import type { WallMesh } from './walls';

const BODY_RADIUS = 0.24;

export type FloorState = 'shown' | 'below' | 'hidden';

export interface FloorHost {
  pal: Palette;
  assets: Assets;
  /** World-space camera position. */
  cameraPosition(out: THREE.Vector3): THREE.Vector3;
  roomClick(room: RoomRef): void;
  /** A room (or, with room = null, the corridor) finished furnishing; `evicted` were using stations that are gone. */
  roomBuilt(floor: Floor, room: RoomState | null, evicted: string[]): void;
}

export interface RoomState {
  floor: number;
  slot: number;
  def: RoomSlotDef;
  /** Upper floors only (the ground room is the fixed workroom corner). */
  frame: RoomFrame | null;
  /** What is built: 'ground', 'empty' or a job kind; null while nothing is. */
  built: string | null;
  building: string | null;
  job: Job | null;
  gen: number;
  kit: Kit | null;
  board: Corkboard | null;
  plate: RoomPlate;
  doorTarget: PickTarget;
  floorTarget: PickTarget;
  hover: THREE.MeshBasicMaterial | null;
}

export class Floor {
  readonly root = new THREE.Group();
  readonly furn = new THREE.Group();
  readonly people = new THREE.Group();
  readonly plates = new THREE.Group();
  readonly stations = new StationRegistry();
  readonly rooms: RoomState[] = [];
  readonly glass: ViewGlass;
  walls = new Map<WallId, WallMesh>();
  cutaway!: Cutaway;
  nav!: NavGrid;
  state: FloorState = 'shown';
  ground: { shell: Shell; kit: Kit; furnished: Furnished; flight: Flight } | null = null;
  upper: { shell: UpperShell; corridor: Kit | null } | null = null;
  private worlds = new Map<number, PeopleWorld>();
  private hasUpper = false;
  private doorUsers = 0;
  private doorPick: PickEntry | null = null;
  private glassBase: { color: THREE.Color; opacity: number };
  private disposed = false;
  /** Upper floors: the rooms' and corridor's per-material batches merged across the floor (see remerge). */
  private merged = new THREE.Group();
  private mergedFrom: THREE.Mesh[] = [];
  private mergeGen = 0;
  /** Every window of the storey merged per material, drawn instead of the per-wall islands while 'below'. */
  private belowWindows: { group: THREE.Group; from: Set<THREE.Mesh> } | null = null;
  private mergeTimer: ReturnType<typeof setTimeout> | null = null;
  private ceilingShown = true;

  private constructor(readonly index: number, private host: FloorHost) {
    this.root.name = `floor-${index}`;
    this.root.position.y = index * STOREY_H;
    this.furn.name = 'furniture';
    this.people.name = 'people';
    this.plates.name = 'plates';
    this.root.add(this.furn, this.people, this.plates);
    this.merged.name = 'merged';
    this.furn.add(this.merged);
    this.glass = viewGlass(host.pal.glass);
    this.glass.side = THREE.DoubleSide; // seen from outside too: the storeys below show lit windows
    this.glassBase = { color: this.glass.color.clone(), opacity: this.glass.opacity };
  }

  get base(): number {
    return this.index * STOREY_H;
  }

  // ── construction ──────────────────────────────────────────────────────────────────────────────

  /** The ground floor: the original open-plan interior (async: props load). */
  static async ground(host: FloorHost): Promise<Floor> {
    const f = new Floor(0, host);
    const { pal } = host;
    const shell = buildShell(pal);
    swapMaterial(shell.group, pal.glass, f.glass);
    f.root.add(shell.group);
    f.walls = shell.walls;
    const kit = new Kit(pal, host.assets, f.stations, shell.walls);
    const furnished = await furnish(kit);
    // stations in the workroom corner belong to job room 1A
    const r = roomSlot(0, 0)!.rect;
    for (const s of kit.slots) if (s.pos.x > r.x0 && s.pos.x < r.x1 && s.pos.z > r.z0 && s.pos.z < r.z1) s.room = 0;
    f.furn.add(kit.root);
    const flight = buildFlight(pal);
    flight.group.visible = false;
    flight.group.userData.noBatch = true;
    shell.group.add(flight.group);
    const walls = [...shell.walls.values()];
    kit.proxyPicks();
    const islands = [
      ...f.stations.all().flatMap((s) => (s.sit?.chair ? [s.sit.chair] : [])),
      ...walls.flatMap((w) => w.attached),
      kit.ceiling,
    ];
    const kb = batchStatic(kit.root, islands);
    instanceChairs(kit, f.stations.all().flatMap((s) => (s.sit?.chair ? [s.sit.chair] : [])));
    for (const w of walls) w.mesh.userData.noBatch = true; // geometry is rewritten by the cutaway
    const sb = batchStatic(shell.group, islands);
    mergeShadowCasters(shell.group);
    // the street, garden and neighbours around the house (already merged per material)
    shell.group.add(await buildLot(pal, host.assets));
    console.info(`[house] batched meshes: furniture ${kb.before}→${kb.after}, shell ${sb.before}→${sb.after}`);
    f.ground = { shell, kit, furnished, flight };
    f.cutaway = new Cutaway(shell.walls);
    f.doorPick = {
      obj: shell.door.leaf,
      target: { kind: 'door', label: 'Front door · back to the city', anchor: new THREE.Vector3(DOOR.inside.x - 0.5, 2.4, DOOR.inside.z) },
    };
    // job room 1A: the workroom corner (its corkboard is the job's board)
    const def = roomSlot(0, 0)!;
    const room = f.makeRoom(def, null);
    room.built = 'ground';
    room.board = furnished.board;
    const boardPick = kit.picks.find((p) => p.target.kind === 'board');
    if (boardPick) boardPick.target.room = { floor: 0, slot: 0 };
    room.plate.obj.position.set(def.plate.x, def.plate.y, def.plate.z);
    shell.walls.get('back')?.onHeight((h) => { room.plate.obj.position.y = Math.min(def.plate.y, h + 0.12); });
    f.rebuildNav();
    return f;
  }

  /** An upper floor: shell now (cheap, synchronous), corridor furniture as soon as its props load. */
  static upper(index: number, host: FloorHost, hasUpper: boolean): Floor {
    const f = new Floor(index, host);
    const shell = buildUpperShell(host.pal, f.glass, hasUpper);
    f.hasUpper = hasUpper;
    f.root.add(shell.group);
    f.walls = shell.walls;
    for (const w of shell.walls.values()) w.mesh.userData.noBatch = true;
    batchStatic(shell.group, shell.islands);
    mergeShadowCasters(shell.group);
    mergeShadowCasters(shell.interior);
    f.upper = { shell, corridor: null };
    f.cutaway = new Cutaway(shell.walls);
    for (let s = 0; s < slotsOnFloor(index); s++) {
      const def = roomSlot(index, s)!;
      const frame = new RoomFrame(def, shell.defs);
      const room = f.makeRoom(def, frame);
      // plate: on the floor just inside the room's front edge (the side the house camera looks from). Hung on a
      // wall at head height it would project onto the room behind it — a front room's plate landed on the back
      // room — or float above the back wall; down here it always reads as this room's label.
      const r = def.rect;
      room.plate.obj.position.set((r.x0 + r.x1) / 2, 0.04, r.z1 - 0.62);
    }
    f.rebuildNav();
    const kit = new Kit(host.pal, host.assets, new StationRegistry(), shell.walls, { prefix: 'corr:' });
    void furnishCorridor(kit).then(() => {
      if (f.disposed) return;
      f.stations.adopt(kit.slots);
      kit.proxyPicks();
      batchStatic(kit.root, [...[...f.walls.values()].flatMap((w) => w.attached), kit.ceiling]);
      kit.ceiling.visible = f.ceilingShown;
      f.furn.add(kit.root);
      f.upper!.corridor = kit;
      f.remerge();
      f.rebuildNav();
      host.roomBuilt(f, null, []);
    }).catch((e) => console.warn('[house] corridor furnishing failed', e));
    return f;
  }

  private makeRoom(def: RoomSlotDef, frame: RoomFrame | null): RoomState {
    const ref: RoomRef = { floor: def.floor, slot: def.slot };
    const plate = new RoomPlate(() => this.host.roomClick(ref));
    plate.set({ code: def.code, name: null });
    this.plates.add(plate.obj);
    const door = this.upper?.shell.doors.find((d) => d.slot === def.slot);
    const center = frame ? frame.vec(frame.W / 2, frame.D / 2, 1.2) : new THREE.Vector3((def.rect.x0 + def.rect.x1) / 2, 1.2, (def.rect.z0 + def.rect.z1) / 2);
    const room: RoomState = {
      floor: def.floor, slot: def.slot, def, frame, built: null, building: null, job: null, gen: 0, kit: null, board: null, plate,
      doorTarget: { kind: 'room', roomPart: 'door', label: `Room ${def.code}`, anchor: door?.anchor ?? center, room: ref, floor: def.floor },
      floorTarget: { kind: 'room', roomPart: 'floor', label: `Room ${def.code} · available — click to start a job`, anchor: center, room: ref, floor: def.floor },
      hover: null,
    };
    this.rooms[def.slot] = room;
    return room;
  }

  // ── rooms ─────────────────────────────────────────────────────────────────────────────────────

  /** Assign a job (or none) to a room; rebuilds its furniture only when the kind changes. */
  setRoom(slot: number, job: Job | null, plate: { color?: string; status?: 'idle' | 'busy' | 'wait'; current?: boolean }, tint: string) {
    const room = this.rooms[slot];
    if (!room) return;
    room.job = job;
    room.plate.set({ code: room.def.code, name: job?.name ?? null, ...(job ? plate : {}) });
    room.doorTarget.label = job ? `${job.name} · room ${room.def.code}` : `Room ${room.def.code} · available — click to start a job`;
    if (!room.frame) return; // the ground room is the fixed workroom
    const want = job ? job.kind : 'empty';
    this.paint(slot, want);
    if (room.building === want) return;
    if (room.built === want) {
      if (room.building) { room.gen++; room.building = null; } // changed back before the other build finished
      return;
    }
    void this.buildRoom(room, want, tint);
  }

  private paint(slot: number, want: string) {
    const paints = this.upper?.shell.paints;
    if (!paints) return;
    const p = KIND_PAINTS[want as keyof typeof KIND_PAINTS] ?? KIND_PAINTS.empty;
    paints.get(`r${slot}:feature`)?.color.set(p.feature);
    paints.get(`r${slot}:base`)?.color.set(p.base);
    paints.get(`r${slot}:panel`)?.color.set(p.panel);
  }

  private async buildRoom(room: RoomState, want: string, tint: string) {
    const frame = room.frame!;
    const gen = ++room.gen;
    room.building = want;
    // one room per task: entering a house builds all its job rooms, and with the assets cached each build (furniture,
    // textures, batching) would otherwise run on in the same task as the next one
    await new Promise<void>((r) => setTimeout(r, 0));
    if (gen !== room.gen || this.disposed) return;
    const kit = new Kit(this.host.pal, this.host.assets, new StationRegistry(), this.walls, { room: room.slot, prefix: `r${room.slot}:` });
    kit.root.name = `room-${room.def.code}`;
    let board: Corkboard | null = null;
    let hover: THREE.MeshBasicMaterial | null = null;
    try {
      if (want === 'empty') {
        await furnishEmptyRoom(kit, frame);
        hover = kit.own(new THREE.MeshBasicMaterial({ color: '#ffd8a0', transparent: true, opacity: 0.16, depthWrite: false, visible: false }));
        const plane = new THREE.Mesh(new THREE.PlaneGeometry(frame.x1 - frame.x0, frame.z1 - frame.z0).rotateX(-Math.PI / 2), hover);
        plane.position.set((frame.x0 + frame.x1) / 2, 0.015, (frame.z0 + frame.z1) / 2);
        plane.renderOrder = 1;
        plane.name = 'room-pick';
        plane.userData.noBatch = true;
        kit.root.add(plane);
        kit.pickable(plane, room.floorTarget);
      } else {
        const res = await furnishJobRoom(kit, frame, want as JobKind, tint);
        board = res.board;
      }
    } catch (e) {
      console.warn(`[house] furnishing room ${room.def.code} failed`, e);
      kit.dispose();
      if (gen === room.gen) room.building = null;
      return;
    }
    if (gen !== room.gen || this.disposed) {
      kit.dispose();
      return;
    }
    // swap the new furniture in
    const evicted = this.stations.remove((s) => s.room === room.slot);
    room.kit?.dispose();
    this.stations.adopt(kit.slots);
    kit.proxyPicks();
    const islands = [
      ...kit.slots.flatMap((s) => (s.sit?.chair ? [s.sit.chair] : [])),
      ...[...this.walls.values()].flatMap((w) => w.attached),
      kit.ceiling,
    ];
    batchStatic(kit.root, islands);
    instanceChairs(kit, kit.slots.flatMap((s) => (s.sit?.chair ? [s.sit.chair] : [])));
    kit.ceiling.visible = this.ceilingShown;
    this.furn.add(kit.root);
    room.kit = kit;
    room.board = board;
    room.hover = hover;
    room.built = want;
    room.building = null;
    this.remerge();
    this.rebuildNav();
    this.host.roomBuilt(this, room, evicted);
  }

  /** Each room (and the corridor) is batched on its own, so a material shared by four rooms still costs four draws
   *  (and four per shadow pass). Upstairs, the rooms' top-level batches are merged once more across the floor, one
   *  mesh per material; the per-room batches stay (hidden) so a room can be refurnished and the floor re-merged.
   *  Islands (chairs, things on walls) and one-off meshes are left alone.
   *  A change drops the floor-wide merge at once (it may hold a room that just went away; the rooms draw on their own
   *  meanwhile) and merges again once the builds settle, one material per frame so no frame stalls. */
  private remerge() {
    if (!this.upper || this.disposed) return;
    this.mergeGen++;
    for (const m of this.merged.children) (m as THREE.Mesh).geometry.dispose();
    this.merged.clear();
    for (const m of this.mergedFrom) m.visible = true;
    this.mergedFrom = [];
    if (this.mergeTimer) clearTimeout(this.mergeTimer);
    const gen = this.mergeGen;
    this.mergeTimer = setTimeout(() => {
      this.mergeTimer = null;
      void this.mergeFloor(gen);
    }, 250);
  }

  private async mergeFloor(gen: number) {
    const buckets = new Map<string, THREE.Mesh[]>();
    for (const kit of this.kits()) {
      kit.root.updateMatrix();
      for (const c of kit.root.children) {
        const m = c as THREE.Mesh;
        if (!m.isMesh || !m.name.startsWith('batch:') || Array.isArray(m.material) || !m.visible) continue;
        const attrs = Object.keys(m.geometry.attributes).sort().join(',') + (m.geometry.index ? '|i' : '|n');
        const key = `${(m.material as THREE.Material).uuid}|${m.castShadow ? 1 : 0}${m.receiveShadow ? 1 : 0}|${m.renderOrder}|${attrs}`;
        let list = buckets.get(key);
        if (!list) buckets.set(key, (list = []));
        list.push(m);
      }
    }
    const xf = new THREE.Matrix4();
    for (const list of buckets.values()) {
      if (list.length < 2) continue;
      if (gen !== this.mergeGen || this.disposed) return;
      const geos = list.map((m) => {
        // batch meshes sit at their kit root's origin; the kit root sits in the floor's furniture group (both
        // identity today: then the geometry is merged as it is, without a transformed copy)
        xf.multiplyMatrices(m.parent!.matrix, m.matrix);
        if (xf.equals(IDENTITY)) return m.geometry;
        const g = m.geometry.clone();
        g.applyMatrix4(xf);
        return g;
      });
      const geo = mergeGeometries(geos, false);
      geos.forEach((g, i) => { if (g !== list[i].geometry) g.dispose(); });
      if (!geo) continue;
      const first = list[0];
      const out = new THREE.Mesh(geo, first.material);
      out.name = `floor-${first.name}`;
      out.castShadow = first.castShadow;
      out.receiveShadow = first.receiveShadow;
      out.renderOrder = first.renderOrder;
      this.merged.add(out);
      for (const m of list) {
        m.visible = false;
        m.geometry.dispose(); // frees only the GPU copy; the CPU data stays for the next re-merge
        this.mergedFrom.push(m);
      }
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
    }
  }

  /** Hide the room plates that a standing wall hides from the camera (see RoomPlate.setOccluded). Each wall is a
   *  vertical slab at its current (cutaway) height; the sight line runs to a point just above the plate's anchor. */
  occludePlates(camWorld: THREE.Vector3) {
    const c = _cam.copy(camWorld);
    c.y -= this.base;
    for (const r of this.rooms) {
      if (!r) continue;
      const p = _target.copy(r.plate.obj.position);
      p.y += 0.15;
      let hidden = false;
      for (const w of this.walls.values()) {
        const def = w.def;
        const n = def.axis === 'x' ? def.outward[1] : def.outward[0];
        const mid = def.at + (n * (def.thickness ?? ROOM.wallT)) / 2;
        const cf = def.axis === 'x' ? c.z : c.x, pf = def.axis === 'x' ? p.z : p.x;
        if ((cf - mid) * (pf - mid) >= 0) continue; // camera and plate on the same side
        const u = (mid - pf) / (cf - pf); // 0 at the plate, 1 at the camera
        const along = def.axis === 'x' ? p.x + (c.x - p.x) * u : p.z + (c.z - p.z) * u;
        if (along < Math.min(def.span[0], def.span[1]) || along > Math.max(def.span[0], def.span[1])) continue;
        if (p.y + (c.y - p.y) * u < w.height - 0.05) {
          hidden = true;
          break;
        }
      }
      r.plate.setOccluded(hidden);
    }
  }

  /** Highlight the floor of an empty room under the pointer. */
  hoverRoom(slot: number | null) {
    for (const r of this.rooms) if (r?.hover) r.hover.visible = r.slot === slot;
  }

  // ── stairs ────────────────────────────────────────────────────────────────────────────────────

  /** Is there a floor above (flight up from here)? */
  setHasUpper(on: boolean) {
    if (this.ground) {
      if (this.hasUpper === on) return;
      this.hasUpper = on;
      this.ground.flight.group.visible = on && this.state === 'shown';
      this.rebuildNav();
    } else if (this.upper) {
      this.hasUpper = on;
      this.upper.shell.setHasUpper(on);
    }
  }

  // ── navigation & people ───────────────────────────────────────────────────────────────────────

  private obstacles(): Rect[] {
    const out: Rect[] = [];
    if (this.ground) out.push(...this.ground.kit.obstacles);
    if (this.upper) {
      if (this.upper.corridor) out.push(...this.upper.corridor.obstacles);
      for (const d of this.upper.shell.doors) out.push(d.obstacle);
    }
    for (const r of this.rooms) if (r?.kit) out.push(...r.kit.obstacles);
    return out;
  }

  rebuildNav() {
    const { halfW: W, halfD: D } = ROOM;
    const r = BODY_RADIUS;
    let nav: NavGrid;
    if (this.ground) {
      // furniture footprints + walls (doorway open) + a porch corridor outside
      nav = new NavGrid({ x0: -W - 2.6, z0: -D, x1: W, z1: D }, 0.2);
      for (const o of this.obstacles()) nav.block(o, r);
      nav.block({ x0: -W - 2.6, z0: -D, x1: -W + r, z1: D });
      nav.block({ x0: W - r, z0: -D, x1: W, z1: D });
      nav.block({ x0: -W, z0: -D, x1: W, z1: -D + r });
      nav.block({ x0: -W, z0: D - r, x1: W, z1: D });
      nav.clear({ x0: -W - 2.6, z0: DOOR.center.z - 0.3, x1: -W + r + 0.01, z1: DOOR.center.z + 0.3 });
      // under the low end of the flight up
      if (this.hasUpper) nav.block({ x0: STAIR.laneX0, z0: STAIR.bottomZ - 3.3, x1: W, z1: D }, r);
    } else {
      nav = new NavGrid({ x0: -W, z0: -D, x1: W, z1: D }, 0.2);
      nav.block({ x0: -W, z0: -D, x1: -W + r, z1: D });
      nav.block({ x0: W - r, z0: -D, x1: W, z1: D });
      nav.block({ x0: -W, z0: -D, x1: W, z1: -D + r });
      nav.block({ x0: -W, z0: D - r, x1: W, z1: D });
      for (const def of this.upper!.shell.defs) {
        if (def.thickness === undefined) continue; // exterior (handled above)
        const T = def.thickness;
        const doors = def.openings.filter((o) => o.kind === 'door').sort((a, b) => a.from - b.from);
        const edges = [def.span[0], ...doors.flatMap((d) => [d.from, d.to]), def.span[1]];
        const o = def.axis === 'x' ? def.outward[1] : def.outward[0];
        const a = def.at, b = def.at + o * T;
        for (let i = 0; i < edges.length; i += 2) {
          const u0 = edges[i], u1 = edges[i + 1];
          if (u1 - u0 < 0.01) continue;
          if (def.axis === 'x') nav.block({ x0: u0, z0: Math.min(a, b), x1: u1, z1: Math.max(a, b) }, r);
          else nav.block({ x0: Math.min(a, b), z0: u0, x1: Math.max(a, b), z1: u1 }, r);
        }
      }
      // stairwell + gallery (stair travellers walk straight lines and ignore the grid)
      nav.block({ x0: 7.1, z0: STAIR.topZ + 0.05, x1: W, z1: D }, r);
      for (const ob of this.obstacles()) nav.block(ob, r);
    }
    this.nav = nav;
  }

  /** The people world of a room on this floor (undefined = no room preference). Stable per slot. */
  world(slot?: number): PeopleWorld {
    const key = slot ?? -1;
    let w = this.worlds.get(key);
    if (w) return w;
    const f = this;
    const ground = !!this.ground;
    const room = slot === undefined ? undefined : this.rooms[slot];
    const upperDoor = { inside: new THREE.Vector3(8.4, 0, -0.25), outside: new THREE.Vector3(8.4, 0, STAIR.bottomZ + 0.25), open() {} };
    w = {
      root: this.people,
      floor: this.index,
      stations: this.stations.forRoom(slot),
      findPath: (a, b) => f.nav.findPath(a, b),
      snap: (p) => f.nav.nearestFree(p),
      door: ground
        ? {
            inside: new THREE.Vector3(DOOR.inside.x, 0, DOOR.inside.z),
            outside: new THREE.Vector3(DOOR.outside.x, 0, DOOR.outside.z),
            open(on) {
              f.doorUsers = Math.max(0, f.doorUsers + (on ? 1 : -1));
              f.ground?.shell.door.setOpen(f.doorUsers > 0);
            },
          }
        : upperDoor,
      heightAt: ground ? () => 0 : (x, z) => (inStairLane(x) && z > STAIR.topZ ? flightHeight(z) - STOREY_H : 0),
      spawnPoint: () => {
        if (room?.frame) return room.frame.vec(room.frame.W * 0.62, room.frame.D * 0.62);
        if (ground) return slot === 0 ? new THREE.Vector3(5.6, 0, -2.4) : new THREE.Vector3(0.5, 0, 1.5);
        return new THREE.Vector3(0, 0, 0);
      },
      cameraPosition: (out) => {
        f.host.cameraPosition(out);
        out.y -= f.base;
        return out;
      },
    };
    this.worlds.set(key, w);
    return w;
  }

  /** Close the front door (house exit). */
  resetDoor() {
    this.doorUsers = 0;
    this.ground?.shell.door.setOpen(false);
  }

  // ── show / hide ───────────────────────────────────────────────────────────────────────────────

  setState(s: FloorState) {
    this.state = s;
    this.root.visible = s !== 'hidden';
    const live = s === 'shown';
    this.furn.visible = live;
    this.people.visible = live;
    this.plates.visible = live;
    if (this.upper) this.upper.shell.interior.visible = live;
    if (this.ground) this.ground.flight.group.visible = live && this.hasUpper;
    this.cutaway.mode = live ? 'cutaway' : 'up';
    // below the shown storey the walls stand full height under the slab above and the windows glow: only their outer
    // face can be seen, so the inside paints, cap and trim (a draw call each) are switched off. Not on the right wall:
    // its inside shows through the stair opening of the slab above.
    for (const w of this.walls.values()) {
      const full = (w.mesh.userData.faces ??= w.mesh.material) as THREE.Material | THREE.Material[];
      if (!Array.isArray(full) || w.def.id === 'right') continue;
      w.mesh.material = s === 'below' ? full.map((m, i) => (i === 0 ? m : HIDDEN_FACE)) : full;
    }
    this.showBelowWindows(s === 'below');
    // windows of the storeys below glow warm, so the empty interiors never show through
    const lit = s === 'below';
    this.glass.color.copy(lit ? new THREE.Color('#f6dcae') : this.glassBase.color);
    this.glass.opacity = lit ? 0.86 : this.glassBase.opacity;
    this.glass.emissive.set(lit ? '#ffc277' : '#000000');
    this.glass.emissiveIntensity = lit ? 0.75 : 0;
    this.glass.viewOn.value = lit ? 0 : 1;
    if (!live) this.hoverRoom(null);
  }

  /** Below the shown storey no wall is cut, so the windows of all four walls can draw together: a mesh per material
   *  instead of a few per wall (built on first use). The per-wall islands, which the cutaway hides with their wall,
   *  are switched off meanwhile by material, so the walls' own visibility updates never fight this. */
  private showBelowWindows(on: boolean) {
    const shell = this.ground?.shell.group ?? this.upper?.shell.group;
    if (!shell) return;
    const islands = shell.children.filter((c) => c.name.startsWith('windows:'));
    // the inside sill boards and curtains are left out: behind the glowing glass nobody sees them (nor their shadows)
    const inside = (m: THREE.Mesh) => m.material === this.host.pal.baseboard ||
      (m.material !== this.glass && (m.material as THREE.Material).side === THREE.DoubleSide);
    if (on && !this.belowWindows) this.belowWindows = mergeWindows(shell, islands, inside);
    const bw = this.belowWindows;
    if (!bw) return;
    bw.group.visible = on;
    for (const m of bw.from) {
      const own = (m.userData.ownMaterial ??= m.material) as THREE.Material;
      m.material = on ? HIDDEN_FACE : own;
    }
  }

  update(dt: number, time: number, camWorld: THREE.Vector3, targetWorld?: THREE.Vector3) {
    if (this.state === 'hidden') return;
    _cam.copy(camWorld);
    _cam.y -= this.base;
    this.cutaway.update(_cam, dt, false, this.localTarget(targetWorld));
    this.cutStairs();
    this.ground?.shell.door.update(dt);
    if (this.state !== 'shown') return;
    this.showCeilingFixtures(_cam.y);
    for (const kit of this.kits()) for (const u of kit.updaters) u(dt, time);
  }

  /** Pendants hang from a ceiling the dollhouse never draws: from above it they would float, so they show only
   *  while the camera is below the ceiling (zoomed in at eye level). Hysteresis keeps a slow orbit from flickering. */
  private showCeilingFixtures(camY: number) {
    const on = camY < ROOM.height + (this.ceilingShown ? 0.6 : 0.3);
    if (on === this.ceilingShown) return;
    this.ceilingShown = on;
    for (const kit of this.kits()) kit.ceiling.visible = on;
  }

  /** Snap walls to the current mode at once (entering the house, switching floors instantly). */
  settleWalls(camWorld: THREE.Vector3, targetWorld?: THREE.Vector3) {
    _cam.copy(camWorld);
    _cam.y -= this.base;
    this.cutaway.update(_cam, 0, true, this.localTarget(targetWorld));
    this.cutStairs();
    if (this.state === 'shown') this.showCeilingFixtures(_cam.y);
  }

  /** The flight up climbs along the right wall: show it only as high as that wall stands (see stairs.ts). */
  private cutStairs() {
    const flight = this.ground?.flight ?? this.upper?.shell.flight;
    const wall = this.walls.get('right');
    if (flight && wall) flight.setVisibleTop(flightTopFor(wall.height));
  }

  private localTarget(t?: THREE.Vector3): THREE.Vector3 | undefined {
    if (!t) return undefined;
    return _target.copy(t).setY(t.y - this.base);
  }

  private kits(): Kit[] {
    const out: Kit[] = [];
    if (this.ground) out.push(this.ground.kit);
    if (this.upper?.corridor) out.push(this.upper.corridor);
    for (const r of this.rooms) if (r?.kit) out.push(r.kit);
    return out;
  }

  lamps(): LampSpec[] {
    return this.kits().flatMap((k) => k.lamps);
  }

  picks(): PickEntry[] {
    const out: PickEntry[] = [];
    for (const k of this.kits()) for (const p of k.picks) out.push({ obj: p.obj, target: p.target.floor === undefined ? Object.assign(p.target, { floor: this.index }) : p.target });
    if (this.doorPick) out.push(this.doorPick);
    if (this.upper) for (const d of this.upper.shell.doors) {
      const room = this.rooms[d.slot];
      if (room) out.push({ obj: d.leaf, target: room.doorTarget });
    }
    return out;
  }

  /** Every room-scoped station tagged for `slot`, for debugging. */
  roomOf(slot: number): RoomState | undefined {
    return this.rooms[slot];
  }

  dispose() {
    this.disposed = true;
    if (this.mergeTimer) clearTimeout(this.mergeTimer);
    for (const r of this.rooms) {
      if (!r) continue;
      r.gen++;
      r.plate.dispose();
      r.kit?.dispose();
    }
    this.upper?.corridor?.dispose();
    this.stations.remove(() => true);
    this.root.remove(this.people); // residents are re-homed by the view, never disposed with the floor
    this.upper?.shell.dispose();
    disposeTree(this.root);
    this.glass.dispose();
    this.root.removeFromParent();
  }
}

const _cam = new THREE.Vector3(), _target = new THREE.Vector3();
const IDENTITY = new THREE.Matrix4();
const HIDDEN_FACE = new THREE.MeshBasicMaterial({ visible: false });

function mergeWindows(shell: THREE.Object3D, islands: THREE.Object3D[], drop: (m: THREE.Mesh) => boolean): { group: THREE.Group; from: Set<THREE.Mesh> } | null {
  shell.updateWorldMatrix(true, true);
  const inv = new THREE.Matrix4().copy(shell.matrixWorld).invert();
  const xf = new THREE.Matrix4();
  const buckets = new Map<string, THREE.Mesh[]>();
  const from = new Set<THREE.Mesh>();
  for (const isl of islands) {
    isl.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || Array.isArray(m.material) || (m as THREE.InstancedMesh).isInstancedMesh || (m as THREE.SkinnedMesh).isSkinnedMesh) return;
      if (drop(m)) {
        from.add(m);
        return;
      }
      const attrs = Object.keys(m.geometry.attributes).sort().join(',') + (m.geometry.index ? '|i' : '|n');
      const key = `${m.material.uuid}|${m.castShadow ? 1 : 0}${m.receiveShadow ? 1 : 0}|${m.renderOrder}|${attrs}`;
      let list = buckets.get(key);
      if (!list) buckets.set(key, (list = []));
      list.push(m);
    });
  }
  const group = new THREE.Group();
  group.name = 'below-windows'; // not 'windows:…': that prefix marks the per-wall islands
  group.userData.noBatch = true;
  for (const list of buckets.values()) {
    const geos = list.map((m) => {
      const g = m.geometry.clone();
      g.applyMatrix4(xf.multiplyMatrices(inv, m.matrixWorld));
      return g;
    });
    const geo = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
    if (geos.length > 1) for (const g of geos) g.dispose();
    if (!geo) continue;
    const first = list[0];
    const out = new THREE.Mesh(geo, first.material);
    out.castShadow = first.castShadow;
    out.receiveShadow = first.receiveShadow;
    out.renderOrder = first.renderOrder;
    group.add(out);
    for (const m of list) from.add(m);
  }
  if (!from.size) return null;
  shell.add(group);
  return { group, from };
}

function swapMaterial(root: THREE.Object3D, from: THREE.Material, to: THREE.Material) {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && m.material === from) m.material = to;
  });
}

/** Geometry only: the materials and textures under a floor are shared (palette, batch twins, cached models and
 *  textures) and stay alive for the next floor or house; what one furnishing owns alone goes with Kit.dispose(). */
function disposeTree(root: THREE.Object3D) {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) m.geometry?.dispose();
  });
}
