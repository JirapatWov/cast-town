// Upper-floor architecture: a floor slab (open over the stair lane), exterior walls with windows, the corridor
// partitions with four room doors (casings + an open oak leaf), the A|B, C|D and stairwell partitions, baseboards,
// full-height shadow casters, a shadow-only ceiling and the stairwell (railing + the flight up, if any).
// Interior paints are per-floor materials named 'corridor' / 'r<slot>:accent' / 'r<slot>:base', so a room is
// repainted for a new job kind by recoloring two materials.
import * as THREE from 'three';
import { STOREY_H } from '../../../shared/house-plan';
import { CORRIDOR_PAINT, CORRIDOR_PANEL, KIND_PAINTS, ROOM, STAIR, upperWalls, type Opening, type WallDef, type WallId } from './layout';
import type { Palette } from './materials';
import type { Rect } from './nav-grid';
import { attachPickProxy } from './furniture/kit';
import { buildWindow, wallFrame } from './openings';
import { SHADOW_ONLY, shadowCeiling, shadowOnly } from './shell';
import { buildFlight, buildWellRailing, flightTopFor, type Flight } from './stairs';
import { WallMesh, buildBaseboards, type WallMaterials } from './walls';

export const SLAB_T = STOREY_H - ROOM.height;
const EXTERIOR: WallId[] = ['back', 'front', 'left', 'right'];

export interface RoomDoor {
  slot: number;
  /** Pick target (the open leaf). */
  leaf: THREE.Object3D;
  anchor: THREE.Vector3;
  /** Nav footprint of the open leaf. */
  obstacle: Rect;
}

export interface UpperShell {
  group: THREE.Group;
  defs: WallDef[];
  walls: Map<WallId, WallMesh>;
  paints: Map<string, THREE.MeshStandardMaterial>;
  doors: RoomDoor[];
  /** Objects that must keep their own transform/visibility when batching (windows, door frames, leaves). */
  islands: THREE.Object3D[];
  /** Parts seen only from inside the storey (see buildUpperShell). */
  interior: THREE.Object3D;
  setHasUpper(on: boolean): void;
  /** The flight up to the next floor (null on the top floor). */
  readonly flight: Flight | null;
  dispose(): void;
}

/** Room slot of a corridor door (corr-n: A west, B east; corr-s: C west, D east). */
function doorSlot(def: WallDef, o: Opening): number {
  const east = (o.from + o.to) / 2 > 0 ? 1 : 0;
  return (def.id === 'corr-n' ? 0 : 2) + east;
}

export function buildUpperShell(pal: Palette, glass: THREE.Material, hasUpper: boolean): UpperShell {
  const group = new THREE.Group();
  group.name = 'upper-shell';
  const defs = upperWalls();
  const islands: THREE.Object3D[] = [];

  // ── slab: oak floor on top, plaster band on the facade, open over the stair lane ──
  const ow = ROOM.halfW + ROOM.wallT, od = ROOM.halfD + ROOM.wallT;
  // shape coordinates are (x, −z): after rotateX(−π/2) the extrusion runs up y and shape-y becomes world z = −y
  const shape = new THREE.Shape([new THREE.Vector2(-ow, -od), new THREE.Vector2(ow, -od), new THREE.Vector2(ow, od), new THREE.Vector2(-ow, od)]);
  const hole = new THREE.Path([
    new THREE.Vector2(STAIR.laneX0, -STAIR.topZ), new THREE.Vector2(STAIR.laneX0, -STAIR.holeZ1),
    new THREE.Vector2(STAIR.laneX1, -STAIR.holeZ1), new THREE.Vector2(STAIR.laneX1, -STAIR.topZ),
  ]);
  shape.holes.push(hole);
  const slabGeo = new THREE.ExtrudeGeometry(shape, { depth: SLAB_T, bevelEnabled: false, curveSegments: 1 });
  slabGeo.rotateX(-Math.PI / 2);
  slabGeo.translate(0, -SLAB_T, 0);
  const slab = new THREE.Mesh(slabGeo, [pal.floors.oak, pal.slabEdge]);
  slab.name = 'slab';
  slab.receiveShadow = true;
  slab.castShadow = true;
  group.add(slab);

  // ── walls ──
  const paints = new Map<string, THREE.MeshStandardMaterial>();
  paints.set('corridor', pal.plaster(CORRIDOR_PAINT));
  paints.set('corridor-panel', pal.panel(CORRIDOR_PANEL));
  for (let s = 0; s < 4; s++) {
    paints.set(`r${s}:feature`, pal.plaster(KIND_PAINTS.empty.feature));
    paints.set(`r${s}:base`, pal.plaster(KIND_PAINTS.empty.base));
    paints.set(`r${s}:panel`, pal.panel(KIND_PAINTS.empty.panel));
  }
  const mats: WallMaterials = {
    outer: pal.wallOuter, cap: pal.wallCap, trim: pal.baseboard,
    paint: (name) => paints.get(name ?? 'corridor') ?? paints.get('corridor')!,
  };
  const shadowMats: WallMaterials = { outer: SHADOW_ONLY, cap: SHADOW_ONLY, paint: () => SHADOW_ONLY };
  const walls = new Map<WallId, WallMesh>();
  const doors: RoomDoor[] = [];
  // What only shows from inside (partitions, door frames, baseboards, stairs): hidden while the floor is below the
  // shown one, where the slab above covers it and the windows glow — dozens of draws saved per storey.
  const interior = new THREE.Group();
  interior.name = 'interior';
  group.add(interior);
  islands.push(interior);
  for (const def of defs) {
    const inside = EXTERIOR.includes(def.id) ? group : interior;
    const wall = new WallMesh(def, mats);
    wall.mesh.castShadow = false;
    walls.set(def.id, wall);
    inside.add(wall.mesh);
    const caster = shadowOnly(new WallMesh(def, shadowMats).mesh);
    caster.name = `wall-shadow:${def.id}`;
    caster.receiveShadow = false;
    caster.userData.noBatch = true;
    inside.add(caster);
    // per wall: all windows in one group, all door frames (with their open leaves) in another — one island each
    const wins = new THREE.Group();
    wins.name = `windows:${def.id}`;
    const frames = new THREE.Group();
    frames.name = `door-frames:${def.id}`;
    for (const o of def.openings) {
      if (o.kind === 'window') {
        const win = buildWindow(def, o, pal);
        win.traverse((m) => { if ((m as THREE.Mesh).material === pal.glass) (m as THREE.Mesh).material = glass; });
        wins.add(win);
      } else {
        const d = buildRoomDoor(def, o, pal, doorSlot(def, o));
        frames.add(d.frame);
        interior.add(d.sill);
        doors.push(d.door);
      }
    }
    for (const [g, h] of [[wins, 1.4], [frames, 1.2]] as const) {
      if (!g.children.length) continue;
      (g === frames ? interior : group).add(g);
      wall.attach(g, h);
      islands.push(g);
    }
  }
  const ext = defs.filter((d) => EXTERIOR.includes(d.id));
  const parts = defs.filter((d) => !EXTERIOR.includes(d.id));
  const bb1 = buildBaseboards(ext, pal.baseboard, { skip: { right: [[STAIR.topZ, STAIR.holeZ1]] } });
  const bb2 = buildBaseboards(parts, pal.baseboard, { bothSides: true });
  for (const b of [bb1, bb2]) if (b) interior.add(b);
  const ceil = shadowCeiling();
  group.add(ceil);

  // ── stairwell ──
  const stairs = new THREE.Group();
  stairs.name = 'stairs';
  interior.add(stairs);
  islands.push(stairs); // railing parts merge locally (the flight is instanced and stays as it is)
  let current: boolean | null = null;
  let flight: Flight | null = null;
  const setHasUpper = (on: boolean) => {
    if (current === on) return;
    current = on;
    for (const c of [...stairs.children]) {
      stairs.remove(c);
      c.traverse((m) => (m as THREE.Mesh).geometry?.dispose());
    }
    stairs.add(buildWellRailing(pal, !on));
    flight = on ? buildFlight(pal) : null;
    if (flight) {
      stairs.add(flight.group);
      const right = walls.get('right');
      if (right) flight.setVisibleTop(flightTopFor(right.height));
    }
  };
  setHasUpper(hasUpper);

  return {
    group, defs, walls, paints, doors, islands, interior, setHasUpper,
    get flight() { return flight; },
    dispose() {
      for (const w of walls.values()) w.dispose();
      group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) m.geometry.dispose();
      });
      for (const p of paints.values()) p.dispose();
    },
  };
}

/** A corridor door: casings on both faces and an oak leaf standing open into the room (hinged at the jamb nearer
 *  the middle of the house), plus a threshold that stays when the wall is cut down. */
function buildRoomDoor(def: WallDef, o: Opening, pal: Palette, slot: number): { frame: THREE.Group; sill: THREE.Group; door: RoomDoor } {
  const T = def.thickness ?? ROOM.wallT;
  const w = o.to - o.from, h = o.top;
  const c = (o.from + o.to) / 2;
  const frame = wallFrame(def, c);
  frame.name = `room-door:${slot}`;
  const trim = pal.baseboard;
  const bx = (bw: number, bh: number, bd: number, mat: THREE.Material, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bd), mat);
    m.position.set(x, y, z);
    m.castShadow = m.receiveShadow = true;
    return m;
  };
  for (const z of [0.01, -T - 0.01]) {
    frame.add(bx(0.07, h + 0.07, 0.02, trim, -w / 2 - 0.035, (h + 0.07) / 2, z));
    frame.add(bx(0.07, h + 0.07, 0.02, trim, w / 2 + 0.035, (h + 0.07) / 2, z));
    frame.add(bx(w + 0.14, 0.07, 0.02, trim, 0, h + 0.035, z));
  }
  // jamb linings
  frame.add(bx(0.02, h, T, trim, -w / 2 + 0.01, h / 2, -T / 2));
  frame.add(bx(0.02, h, T, trim, w / 2 - 0.01, h / 2, -T / 2));
  frame.add(bx(w, 0.02, T, trim, 0, h - 0.01, -T / 2));
  // leaf, hinged at the jamb nearer x = 0, open ~93° into the room (local +Z)
  const hingeX = Math.abs(o.from) < Math.abs(o.to) ? o.from : o.to;
  const toLocal = def.outward[1] > 0 || def.outward[0] < 0 ? -1 : 1; // wallFrame turns local X to world −X then
  const hl = (hingeX - c) * toLocal;
  const s = -Math.sign(hl) || 1;
  const pivot = new THREE.Group();
  pivot.position.set(hl - s * 0.02, 0, 0.03);
  pivot.rotation.y = -s * 1.62;
  const leaf = new THREE.Group();
  leaf.name = 'room-door-leaf';
  const lw = w - 0.04;
  leaf.add(bx(lw, h - 0.015, 0.04, pal.oak, s * lw / 2, (h - 0.015) / 2 + 0.008, 0));
  for (const [py, ph] of [[0.62, 0.8], [1.5, 0.78]] as const) {
    for (const z of [0.022, -0.022]) leaf.add(bx(lw - 0.2, ph, 0.006, pal.oak, s * lw / 2, py, z));
  }
  for (const z of [0.04, -0.04]) {
    leaf.add(bx(0.03, 0.03, 0.03, pal.brass, s * (lw - 0.08), 1.0, z * 0.7));
    leaf.add(bx(0.13, 0.018, 0.022, pal.brass, s * (lw - 0.13), 1.0, z * 1.15));
  }
  pivot.add(leaf);
  frame.add(pivot);
  attachPickProxy(leaf); // the leaf's boards batch with the frames; clicks land on this box
  // threshold (stays when the wall is cut)
  const sill = wallFrame(def, c);
  sill.add(bx(w, 0.012, T + 0.02, pal.oak, 0, 0.006, -T / 2));
  // world-space footprint of the open leaf
  frame.updateMatrixWorld(true);
  const p0 = frame.localToWorld(new THREE.Vector3(hl, 0, 0.03));
  const p1 = frame.localToWorld(new THREE.Vector3(hl, 0, 0.03 + lw));
  const obstacle: Rect = { x0: Math.min(p0.x, p1.x) - 0.04, z0: Math.min(p0.z, p1.z), x1: Math.max(p0.x, p1.x) + 0.04, z1: Math.max(p0.z, p1.z) };
  const anchor = frame.localToWorld(new THREE.Vector3(0, h + 0.35, 0));
  return { frame, sill, door: { slot, leaf, anchor, obstacle } };
}
