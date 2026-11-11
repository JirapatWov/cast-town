// Furnishing toolkit: primitive builders, GLB prop normalization, and the collector that records
// what furniture contributes to the rest of the house (nav obstacles, stations, pick targets, lamps).
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { RoomRef } from '../../../../shared/protocol';
import type { Assets } from '../../core/types';
import type { Slot, StationKind } from '../../people/types';
import type { WallId } from '../layout';
import { lampSpec, type LampOpts, type LampSpec } from '../lighting';
import type { Palette } from '../materials';
import type { Rect } from '../nav-grid';
import type { StationRegistry } from '../stations';
import type { WallMesh } from '../walls';
import { mulberry32 } from '../../people/rng';

/** 'room' = a job room (its door, or the floor of an empty one) → bus 'room:click'. */
export type PickKind = 'tv' | 'board' | 'door' | 'computer' | 'room';
export interface PickTarget {
  kind: PickKind;
  label: string;
  /** Tooltip anchor, floor-local (lifted by `floor` × STOREY_H). */
  anchor: THREE.Vector3;
  /** The job room this target belongs to (room doors and floors, a room's board). */
  room?: RoomRef;
  /** Which part of a room was hit (picking priority: doors before floors). */
  roomPart?: 'door' | 'floor';
  /** Floor index of the anchor (default 0). */
  floor?: number;
}

export interface StationAdder {
  add(kind: StationKind, id: string, pos: THREE.Vector3, yaw: number, extra?: Partial<Slot>): Slot;
}

/** Collects what one furnishing pass contributes: meshes under `root`, nav obstacles, station slots (tagged
 *  with the room slot when furnishing a job room), pick targets, lamps, per-frame updaters and wall attachments. */
export class Kit {
  readonly root = new THREE.Group();
  readonly obstacles: Rect[] = [];
  readonly picks: { obj: THREE.Object3D; target: PickTarget }[] = [];
  readonly updaters: ((dt: number, t: number) => void)[] = [];
  readonly lamps: LampSpec[] = [];
  readonly slots: Slot[] = [];
  readonly stations: StationAdder;
  private wallObjs: { wall: WallMesh; obj: THREE.Object3D }[] = [];
  /** One group per (wall, min height): everything hung on a wall batches into a single island. */
  private wallGroups = new Map<string, THREE.Group>();
  /** Ceiling fixtures (pendants, lanterns): one island the floor hides while the camera looks down through the
   *  cut-away ceiling, where they would float in mid-air. Their light (lamp specs) stays on. */
  readonly ceiling = new THREE.Group();
  /** GPU resources made for this furnishing alone (canvas screens, boards, sketches): freed with it. Everything else
   *  under `root` shares cached materials and textures (palette, batch twins, loaded models) and must outlive it. */
  private owned: { dispose(): void }[] = [];

  constructor(
    readonly pal: Palette,
    readonly assets: Assets,
    registry: StationRegistry,
    private readonly walls: Map<WallId, WallMesh>,
    opts: { room?: number; prefix?: string } = {},
  ) {
    this.root.name = 'furniture';
    this.ceiling.name = 'ceiling-fixtures';
    this.ceiling.userData.giIgnore = true; // toggled with the camera height: must not re-key the GI bake
    this.root.add(this.ceiling);
    const prefix = opts.prefix ?? '';
    this.stations = {
      add: (kind, id, pos, yaw, extra = {}) => {
        const slot = registry.add(kind, prefix + id, pos, yaw, opts.room === undefined ? extra : { room: opts.room, ...extra });
        this.slots.push(slot);
        return slot;
      },
    };
  }

  addLamp(pos: THREE.Vector3, opts: LampOpts = {}) {
    this.lamps.push(lampSpec(pos, opts));
  }

  /** Hand a resource to the kit: disposed with it (see `dispose`). */
  own<T extends { dispose(): void }>(res: T): T {
    this.owned.push(res);
    return res;
  }

  /** Free what this furnishing alone uses: the geometry under `root` and the resources handed over with own(). */
  dispose() {
    this.detachWalls();
    this.root.removeFromParent();
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.geometry?.dispose();
    });
    for (const r of this.owned) r.dispose();
    this.owned = [];
  }

  /** Forget every wall attachment made through this kit (the furnishing is being removed). */
  detachWalls() {
    for (const { wall, obj } of this.wallObjs) wall.detach(obj);
    this.wallObjs = [];
  }

  /** Add to the room at (x, z) facing yaw (object front = local +Z). */
  add<T extends THREE.Object3D>(obj: T, x: number, z: number, yaw = 0, y = 0): T {
    obj.position.set(x, y, z);
    obj.rotation.y = yaw;
    this.root.add(obj);
    return obj;
  }

  /** Move an object placed with add() / RoomFrame.place() (root-local) into the ceiling fixtures. */
  hang<T extends THREE.Object3D>(obj: T): T {
    this.ceiling.add(obj);
    return obj;
  }

  /** Register a w × d footprint (centered at x, z, rotated by yaw) as a nav obstacle. */
  block(x: number, z: number, w: number, d: number, yaw = 0) {
    const c = Math.abs(Math.cos(yaw)), s = Math.abs(Math.sin(yaw));
    const hw = (w * c + d * s) / 2, hd = (w * s + d * c) / 2;
    this.obstacles.push({ x0: x - hw, z0: z - hd, x1: x + hw, z1: z + hd });
  }

  /** Something hung on a wall: hidden while that wall is cut below `minHeight`. Objects on the same wall with the
   *  same threshold share one group, so they batch together (the wall is either cut or up, never in between). */
  onWall(wall: WallId, obj: THREE.Object3D, minHeight: number) {
    const w = this.walls.get(wall);
    if (!w) { this.root.add(obj); return; }
    const key = `${wall}:${minHeight.toFixed(1)}`;
    let g = this.wallGroups.get(key);
    if (!g) {
      g = new THREE.Group();
      g.name = `on-wall:${key}`;
      this.root.add(g);
      w.attach(g, minHeight);
      this.wallObjs.push({ wall: w, obj: g });
      this.wallGroups.set(key, g);
    }
    g.add(obj);
  }

  pickable(obj: THREE.Object3D, target: PickTarget) {
    this.picks.push({ obj, target });
  }

  /** Give every pick target an invisible box over its meshes, so the visible parts can batch with the room while
   *  clicks still land on the target (the picker walks up from the hit to the registered object). */
  proxyPicks() {
    for (const p of this.picks) {
      if (p.obj.userData.noBatch || p.obj.userData.pickProxy) continue;
      attachPickProxy(p.obj);
    }
  }

  /** Load a GLB prop (cloned), optionally scaled to fit a target size, re-based so it stands on y = 0
   *  centered on its footprint. Returns a wrapper group whose origin is the footprint center. */
  async glb(url: string, opts: { height?: number; width?: number; scale?: number; center?: boolean; share?: boolean } = {}): Promise<THREE.Group> {
    const gltf = await this.assets.gltf(optimized(url));
    const src = gltf.scene.clone(true);
    src.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.castShadow = true;
        m.receiveShadow = true;
        // clone materials so per-instance tweaks never leak into the cache — unless the caller promises not to
        // tweak them: shared materials let every instance of a prop batch into the same draw calls
        if (!opts.share) m.material = Array.isArray(m.material) ? m.material.map((x) => x.clone()) : m.material.clone();
      }
      if ((o as THREE.Light).isLight) o.visible = false; // e.g. GlamVelvetSofa ships KHR_lights_punctual
    });
    const box = new THREE.Box3().setFromObject(src);
    const size = box.getSize(new THREE.Vector3());
    let k = opts.scale ?? 1;
    if (opts.height) k = opts.height / size.y;
    else if (opts.width) k = opts.width / size.x;
    src.scale.multiplyScalar(k);
    const b2 = new THREE.Box3().setFromObject(src);
    const c = b2.getCenter(new THREE.Vector3());
    src.position.x -= opts.center === false ? 0 : c.x;
    src.position.z -= opts.center === false ? 0 : c.z;
    src.position.y -= b2.min.y;
    const wrap = new THREE.Group();
    wrap.name = url.split('/').pop() ?? 'prop';
    wrap.add(src);
    wrap.userData.size = b2.getSize(new THREE.Vector3());
    return wrap;
  }
}

/** Props that have a decimated, WebP + meshopt copy under props-interior/opt (the 1k originals run 20–70k
 *  triangles each, and a furnished floor shows dozens of them, shadows included). */
const OPTIMIZED: Record<string, string> = {
  'potted_plant_02_1k.glb': 'potted_plant_02.glb',
  'desk_lamp_arm_01_1k.glb': 'desk_lamp_arm_01.glb',
  'dining_chair_02_1k.glb': 'dining_chair_02.glb',
  'drawer_cabinet_1k.glb': 'drawer_cabinet.glb',
  'SheenChair.glb': 'SheenChair.glb',
  'modern_wooden_cabinet_1k.glb': 'modern_wooden_cabinet.glb',
  'classic_laptop_1k.glb': 'classic_laptop.glb',
};

function optimized(url: string): string {
  const m = /^(.*\/props-interior\/)(?:khronos\/)?([^/]+)$/.exec(url);
  const opt = m && OPTIMIZED[m[2]];
  return opt ? `${m[1]}opt/${opt}` : url;
}

const PICK_MAT = new THREE.MeshBasicMaterial({ visible: false });
const _inv = new THREE.Matrix4(), _mm = new THREE.Matrix4(), _bb = new THREE.Box3();

/** Add an invisible (never drawn, never shadowed, never batched) box over an object's meshes, in its local frame,
 *  so it stays clickable after its visible meshes are merged into a batch. */
export function attachPickProxy(obj: THREE.Object3D): void {
  if (obj.userData.pickProxy) return;
  obj.userData.pickProxy = true;
  const proxy = pickProxy(obj);
  if (proxy) obj.add(proxy);
}

function pickProxy(obj: THREE.Object3D): THREE.Mesh | null {
  obj.updateWorldMatrix(true, true);
  _inv.copy(obj.matrixWorld).invert();
  const box3 = new THREE.Box3();
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.geometry) return;
    if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
    _mm.multiplyMatrices(_inv, m.matrixWorld);
    box3.union(_bb.copy(m.geometry.boundingBox!).applyMatrix4(_mm));
  });
  if (box3.isEmpty()) return null;
  const size = box3.getSize(new THREE.Vector3()).max(new THREE.Vector3(0.05, 0.05, 0.05));
  const proxy = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), PICK_MAT);
  box3.getCenter(proxy.position);
  proxy.name = 'pick-proxy';
  proxy.castShadow = proxy.receiveShadow = false;
  proxy.userData.noBatch = true;
  return proxy;
}

// ── primitives (origin at bottom-center unless noted) ─────────────────────────────────────────

let uvSeed = 1;

/** Replace a geometry's UVs with box-projected meters (textures repeat per meter, so wood grain, weave and stone
 *  keep their real scale on every part). The texture's v axis runs along the longer side of each face (wood grain
 *  follows the board), and each part gets its own offset so neighbouring boards never repeat the same figure. */
export function metricUV(geo: THREE.BufferGeometry, seed = uvSeed++): THREE.BufferGeometry {
  const pos = geo.getAttribute('position');
  const nrm = geo.getAttribute('normal');
  const uv = geo.getAttribute('uv');
  if (!pos || !nrm || !uv) return geo;
  geo.computeBoundingBox();
  const s = geo.boundingBox!.getSize(new THREE.Vector3());
  const r = mulberry32(seed * 7919);
  const ou = r() * 3, ov = r() * 3;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const ax = Math.abs(nrm.getX(i)), ay = Math.abs(nrm.getY(i)), az = Math.abs(nrm.getZ(i));
    let a: number, b: number, la: number, lb: number;
    if (ay >= ax && ay >= az) { a = x; b = z; la = s.x; lb = s.z; }
    else if (ax >= az) { a = z; b = y; la = s.z; lb = s.y; }
    else { a = x; b = y; la = s.x; lb = s.y; }
    if (la > lb) uv.setXY(i, b + ou, a + ov);
    else uv.setXY(i, a + ou, b + ov);
  }
  uv.needsUpdate = true;
  return geo;
}

export function box(w: number, h: number, d: number, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(metricUV(new THREE.BoxGeometry(w, h, d)), mat);
  m.position.set(x, y + h / 2, z);
  m.castShadow = m.receiveShadow = true;
  return m;
}

export function rbox(w: number, h: number, d: number, r: number, mat: THREE.Material, x = 0, y = 0, z = 0, seg = 3): THREE.Mesh {
  const m = new THREE.Mesh(metricUV(new RoundedBoxGeometry(w, h, d, seg, Math.min(r, w / 2, h / 2, d / 2) * 0.999)), mat);
  m.position.set(x, y + h / 2, z);
  m.castShadow = m.receiveShadow = true;
  return m;
}

export function cyl(rTop: number, rBot: number, h: number, mat: THREE.Material, x = 0, y = 0, z = 0, seg = 20): THREE.Mesh {
  const m = new THREE.Mesh(metricUV(new THREE.CylinderGeometry(rTop, rBot, h, seg)), mat);
  m.position.set(x, y + h / 2, z);
  m.castShadow = m.receiveShadow = true;
  return m;
}

export function group(...children: THREE.Object3D[]): THREE.Group {
  const g = new THREE.Group();
  for (const c of children) g.add(c);
  return g;
}

/** World-space point from a local offset of an object placed with (x, z, yaw). */
export function local(x: number, z: number, yaw: number, lx: number, lz: number, y = 0): THREE.Vector3 {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return new THREE.Vector3(x + lx * c + lz * s, y, z - lx * s + lz * c);
}
