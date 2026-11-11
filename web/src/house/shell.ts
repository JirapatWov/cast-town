// Architecture: plinth + floor, walls with openings (cutaway-capable), baseboards, windows, door,
// an invisible ceiling that only casts shadows (so daylight enters through the windows), and the
// garden the house sits in.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { DOOR, ROOM, WALLS, PAINTS, PANELS, type WallId } from './layout';
import type { Palette } from './materials';
import { WallMesh, buildBaseboards, type WallMaterials } from './walls';
import { buildDoor, buildWindow, type DoorHandle } from './openings';
import { mulberry32 } from '../people/rng';

export interface Shell {
  group: THREE.Group;
  walls: Map<WallId, WallMesh>;
  door: DoorHandle;
}

export function buildShell(pal: Palette): Shell {
  const group = new THREE.Group();
  group.name = 'shell';
  const { halfW: W, halfD: D, wallT: T, plinth: P } = ROOM;

  // Floor (world-meter UVs) and plinth slab.
  const floorGeo = new THREE.PlaneGeometry(2 * W, 2 * D).rotateX(-Math.PI / 2);
  worldUV(floorGeo, 'xz');
  const floor = new THREE.Mesh(floorGeo, pal.floor);
  floor.receiveShadow = true;
  floor.name = 'floor';
  group.add(floor);
  // The slab's top sits just under the floor; at house-camera distances the two used to depth-fight in long dark
  // stripes across the far half of the room, so the slab is also pushed back in depth.
  const slabMat = pal.plinth.clone();
  slabMat.polygonOffset = true;
  slabMat.polygonOffsetFactor = 2;
  slabMat.polygonOffsetUnits = 4;
  const slab = new THREE.Mesh(new THREE.BoxGeometry(2 * (W + T) + 0.3, P, 2 * (D + T) + 0.3), slabMat);
  worldUV(slab.geometry, 'box');
  slab.position.y = -P / 2 - 0.004;
  slab.receiveShadow = true;
  group.add(slab);

  // Walls
  const panels = new Map<string, THREE.Material>();
  const mats: WallMaterials = {
    outer: pal.wallOuter,
    cap: pal.wallCap,
    trim: pal.baseboard,
    paint: (name) => {
      if (name?.startsWith('panel:')) {
        const key = name.slice(6) as keyof typeof PAINTS;
        let m = panels.get(key);
        if (!m) panels.set(key, (m = pal.panel(PANELS[key] ?? PANELS.warmWhite)));
        return m;
      }
      return pal.paints[(name ?? 'warmWhite') as keyof typeof PAINTS] ?? pal.paints.warmWhite;
    },
  };
  const walls = new Map<WallId, WallMesh>();
  let door: DoorHandle | null = null;
  // Full-height, invisible shadow casters: the visible walls drop to 0.4 m in the cutaway, but daylight
  // must still only enter through the windows, whichever side the sun is on.
  const shadowMats: WallMaterials = { outer: SHADOW_ONLY, cap: SHADOW_ONLY, paint: () => SHADOW_ONLY };
  for (const def of WALLS) {
    const wall = new WallMesh(def, mats);
    wall.mesh.castShadow = false;
    walls.set(def.id, wall);
    group.add(wall.mesh);
    const caster = shadowOnly(new WallMesh(def, shadowMats).mesh);
    caster.name = `wall-shadow:${def.id}`;
    caster.receiveShadow = false;
    caster.userData.noBatch = true;
    group.add(caster);
    // every window of a wall in one group: they hide together with the wall and batch into one island
    const wins = new THREE.Group();
    wins.name = `windows:${def.id}`;
    for (const o of def.openings) {
      if (o.kind === 'window') {
        wins.add(buildWindow(def, o, pal));
      } else {
        door = buildDoor(def, o, pal);
        group.add(door.group);
        // keep the threshold + mat; hide the leaf when the wall is cut down
        const leafRoot = door.leaf.parent!;
        wall.attach(leafRoot, 1.2);
      }
    }
    if (wins.children.length) {
      group.add(wins);
      wall.attach(wins, 1.4);
    }
  }
  group.add(buildBaseboards(WALLS, pal.baseboard)!);
  group.add(shadowCeiling());

  group.add(buildGarden(pal));
  return { group, walls, door: door! };
}

/** Writes no color or depth: only casts shadows (full-height wall casters, ceilings). */
export const SHADOW_ONLY = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });

/** Make a SHADOW_ONLY mesh skip every non-shadow pass (main view, AO normals/depth, GI probe bakes) instead of
 *  costing an invisible draw call in each: three.js calls onBeforeShadow before every shadow draw and onBeforeRender
 *  before every other draw, and skips a draw whose range is negative. */
export function shadowOnly<T extends THREE.Mesh>(mesh: T): T {
  const range = mesh.geometry.drawRange;
  const full = range.count; // casters are built once (never cut), so their range is final here
  mesh.onBeforeShadow = () => { range.count = full; };
  mesh.onBeforeRender = () => { range.count = -1; };
  return mesh;
}

const isShadowOnly = (m: THREE.Mesh) =>
  Array.isArray(m.material) ? m.material.every((x) => x === SHADOW_ONLY) : m.material === SHADOW_ONLY;
const opaque = (m: THREE.Material) => !m.transparent && m.opacity >= 1 && !(m.alphaTest > 0) && m.visible &&
  !(m as THREE.MeshStandardMaterial).alphaMap;

/** One shadow-only mesh for a shell group's static casters: the full-height wall casters (a draw per material group
 *  each), the ceiling and the window frames (a draw per material per wall). The sun's pass drops from
 *  dozens of draws per storey to one. Run after batching. Window parts keep drawing as before and only hand their
 *  shadow over, so mullions keep casting while the cutaway has their wall down (like the wall casters always did). */
export function mergeShadowCasters(parent: THREE.Object3D): void {
  parent.updateWorldMatrix(true, true);
  const inv = new THREE.Matrix4().copy(parent.matrixWorld).invert();
  const m4 = new THREE.Matrix4();
  const parts: THREE.BufferGeometry[] = [];
  const casters: THREE.Mesh[] = [];
  const remove: THREE.Mesh[] = [];
  const take = (mesh: THREE.Mesh): boolean => {
    const src = mesh.geometry;
    const pos = src.getAttribute('position');
    if (!pos || (mesh as THREE.SkinnedMesh).isSkinnedMesh || (mesh as THREE.InstancedMesh).isInstancedMesh) return false;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    // alpha cut-outs and two-sided sheets (curtains: a single-sided caster would lose them) keep their own shadow
    if (!isShadowOnly(mesh) && !mats.every((m) => opaque(m) && m.side !== THREE.DoubleSide)) return false;
    const total = src.index ? src.index.count : pos.count;
    const end = Math.min(total, src.drawRange.start + (src.drawRange.count >= 0 ? src.drawRange.count : total));
    const idx: number[] = [];
    const ranges = src.groups.length ? src.groups : [{ start: 0, count: total }];
    for (const r of ranges) {
      for (let i = Math.max(r.start, src.drawRange.start); i < Math.min(r.start + r.count, end); i++) idx.push(src.index ? src.index.getX(i) : i);
    }
    if (!idx.length) return false;
    const p = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) { p[i * 3] = pos.getX(i); p[i * 3 + 1] = pos.getY(i); p[i * 3 + 2] = pos.getZ(i); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    g.setIndex(idx);
    g.applyMatrix4(m4.multiplyMatrices(inv, mesh.matrixWorld));
    parts.push(g);
    return true;
  };
  for (const c of parent.children) {
    const m = c as THREE.Mesh;
    if (m.isMesh && m.castShadow && isShadowOnly(m)) {
      if (take(m)) remove.push(m);
    } else if (c.name.startsWith('windows:')) {
      c.traverse((o) => {
        const w = o as THREE.Mesh;
        if (w.isMesh && w.castShadow && take(w)) casters.push(w);
      });
    }
  }
  if (parts.length < 2) {
    for (const g of parts) g.dispose();
    return;
  }
  const geo = mergeGeometries(parts, false);
  for (const g of parts) g.dispose();
  if (!geo) return;
  for (const m of casters) m.castShadow = false;
  for (const m of remove) {
    m.removeFromParent();
    m.geometry.dispose();
  }
  const out = shadowOnly(new THREE.Mesh(geo, SHADOW_ONLY));
  out.name = 'shadow-casters';
  out.castShadow = true;
  out.receiveShadow = false;
  out.userData.noBatch = true;
  parent.add(out);
}

/** Shadow-only ceiling: faces down, so the dollhouse camera above never sees it. */
export function shadowCeiling(): THREE.Mesh {
  const { halfW: W, halfD: D, wallT: T } = ROOM;
  const ceiling = shadowOnly(new THREE.Mesh(new THREE.PlaneGeometry(2 * W + 2 * T, 2 * D + 2 * T).rotateX(Math.PI / 2), SHADOW_ONLY));
  ceiling.position.y = ROOM.height;
  ceiling.castShadow = true;
  ceiling.receiveShadow = false;
  ceiling.name = 'ceiling-shadow';
  ceiling.userData.noBatch = true;
  return ceiling;
}

function buildGarden(pal: Palette): THREE.Group {
  const g = new THREE.Group();
  g.name = 'garden';
  const P = ROOM.plinth;
  // big enough that its edge is always lost in the fog, even at eye level
  const lawnGeo = new THREE.PlaneGeometry(220, 220).rotateX(-Math.PI / 2);
  worldUV(lawnGeo, 'xz');
  const lawn = new THREE.Mesh(lawnGeo, pal.lawn);
  lawn.position.y = -P;
  lawn.receiveShadow = true;
  g.add(lawn);

  // A porch step under the door (the paved path to the street is part of the lot, lot.ts).
  const stoneMat = pal.plinth;
  const r = mulberry32(42);
  const step = new THREE.Mesh(new THREE.BoxGeometry(0.7, P, 1.5), stoneMat);
  step.position.set(DOOR.center.x - ROOM.wallT - 0.35, -P / 2, DOOR.center.z);
  step.receiveShadow = true;
  step.castShadow = true;
  g.add(step);

  // Clipped shrubs hugging the plinth: lumpy icospheres in the town's hedge leaf texture (mapped from world
  // position, so every size keeps the same leaf scale), each a slightly different green through vertex colours.
  const shrubGeo = new THREE.IcosahedronGeometry(1, 3);
  const pos = shrubGeo.getAttribute('position');
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n = 1 + 0.12 * Math.sin(v.x * 7.1 + v.y * 3.3) * Math.cos(v.z * 6.7 - v.y * 4.1);
    v.multiplyScalar(n);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  shrubGeo.computeVertexNormals();
  const spots: [number, number, number][] = [
    [-11.2, -5.0, 0.9], [-11.0, -1.0, 0.7], [-11.1, 5.2, 0.85], [11.0, -5.2, 0.95], [11.1, 0.6, 0.75],
    [11.0, 5.0, 0.8], [-7.4, -8.3, 0.95], [4.0, -8.6, 0.7], [7.4, -8.2, 0.9], [-4.0, 8.4, 0.7], [5.0, 8.3, 0.8],
  ];
  const tint = (k: number) => {
    const c = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      // a touch darker toward the ground (self-shade), each shrub its own green
      const y = pos.getY(i);
      const shade = 0.72 + 0.28 * THREE.MathUtils.smoothstep(y, -0.8, 0.6);
      c[i * 3] = (0.92 + 0.1 * k) * shade;
      c[i * 3 + 1] = (0.96 + 0.04 * k) * shade;
      c[i * 3 + 2] = (0.86 - 0.06 * k) * shade;
    }
    return new THREE.Float32BufferAttribute(c, 3);
  };
  spots.forEach(([x, z, s]) => {
    const geo = shrubGeo.clone();
    geo.setAttribute('color', tint(r()));
    const m = new THREE.Mesh(geo, pal.shrub);
    m.position.set(x, -P + s * 0.45, z);
    m.scale.set(s, s * 0.75, s);
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
  });
  shrubGeo.dispose();
  return g;
}

/** Replace UVs with world-space meters (planar xz, or per-face for boxes). */
export function worldUV(geo: THREE.BufferGeometry, mode: 'xz' | 'box') {
  const pos = geo.getAttribute('position');
  const nrm = geo.getAttribute('normal');
  const uv = geo.getAttribute('uv');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    if (mode === 'xz') { uv.setXY(i, x, -z); continue; }
    const ax = Math.abs(nrm.getX(i)), ay = Math.abs(nrm.getY(i));
    if (ay > 0.5) uv.setXY(i, x, z);
    else if (ax > 0.5) uv.setXY(i, z, y);
    else uv.setXY(i, x, y);
  }
  uv.needsUpdate = true;
}
