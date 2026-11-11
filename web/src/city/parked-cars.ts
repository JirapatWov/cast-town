// Parked cars along the kerbs: the streets read as lived-in instead of empty asphalt. Kenney's car kit (CC0, see
// assets/MANIFEST.json): each model's parts are merged into one geometry and instanced, so the whole town's parked
// cars cost one draw call per model (plus shadows). Each car is also a footprint, so the player's car bumps into them.
import * as THREE from 'three';
import type { Assets, Quality } from '../core/types';
import { LOTS, frontOf } from '../../../shared/city-layout';
import { HALF_ROAD, ROAD_PIECES, type Footprint } from './layout';
import { rng } from './util/random';

const KIT = '/assets/vehicles/kenney-car-kit';
/** Model, real length (m) and how often it turns up. */
const MODELS: [string, number, number][] = [
  ['sedan', 4.5, 0.32],
  ['hatchback-sports', 4.2, 0.18],
  ['suv', 4.7, 0.24],
  ['van', 5.1, 0.12],
  ['taxi', 4.5, 0.07],
  ['delivery', 5.4, 0.07],
];

/** Body tints (multiplied over the kit's colour atlas): mostly greys and muted colours, like a real street. */
const TINTS = [0xffffff, 0xf0f0f0, 0xd9dde2, 0xb8bec6, 0x8f969e, 0xe6ddd0, 0xc9d3dc, 0xffffff];

function mergedModel(scene: THREE.Object3D): { geo: THREE.BufferGeometry; mat: THREE.MeshStandardMaterial } | null {
  scene.updateMatrixWorld(true);
  const parts: THREE.BufferGeometry[] = [];
  let mat: THREE.MeshStandardMaterial | null = null;
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const g = m.geometry.clone();
    g.applyMatrix4(m.matrixWorld);
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
    parts.push(g.index ? g.toNonIndexed() : g);
    mat ??= m.material as THREE.MeshStandardMaterial;
  });
  if (!parts.length || !mat) return null;
  let n = 0;
  for (const p of parts) n += p.getAttribute('position').count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = new Float32Array(n * 2);
  let o = 0;
  for (const p of parts) {
    const c = p.getAttribute('position').count;
    pos.set(p.getAttribute('position').array as Float32Array, o * 3);
    nor.set(p.getAttribute('normal').array as Float32Array, o * 3);
    const t = p.getAttribute('uv');
    if (t) uv.set(t.array as Float32Array, o * 2);
    o += c;
    p.dispose();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  // sit on y = 0, centred, nose toward +Z
  geo.computeBoundingBox();
  const b = geo.boundingBox!;
  geo.translate(-(b.min.x + b.max.x) / 2, -b.min.y, -(b.min.z + b.max.z) / 2);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  const m = (mat as THREE.MeshStandardMaterial).clone();
  m.roughness = 0.38; // painted metal and glass, not matte plastic
  m.metalness = 0.15;
  m.envMapIntensity = 1.2;
  return { geo, mat: m };
}

export interface ParkedCars {
  group: THREE.Group;
  footprints: Footprint[];
  /** Low hides them (its triangle budget goes to the town); Medium parks every other car and drops their shadows (one
   *  instanced mesh spans the whole town, so every cascade would draw all of them). The footprints follow. */
  setQuality(q: Quality): void;
}

export async function buildParkedCars(assets: Assets): Promise<ParkedCars> {
  const group = new THREE.Group();
  group.name = 'parked-cars';
  const loaded = await Promise.all(MODELS.map(([id]) => assets.gltf(`${KIT}/${id}.glb`).then((g) => mergedModel(g.scene)).catch(() => null)));
  const avail = MODELS.map((m, i) => ({ id: m[0], len: m[1], w: m[2], model: loaded[i] })).filter((m) => m.model);
  const footprints: Footprint[] = [];
  const meshes: { im: THREE.InstancedMesh; fps: Footprint[] }[] = [];
  const setQuality = (q: Quality) => {
    group.visible = q !== 'low';
    footprints.length = 0;
    for (const { im, fps } of meshes) {
      im.castShadow = q === 'high' || q === 'ultra';
      // instances are stored evens first, so the Medium half is spread evenly along the kerbs
      im.count = q === 'medium' ? Math.ceil(fps.length / 2) : fps.length;
      if (q !== 'low') footprints.push(...fps.slice(0, im.count));
    }
  };
  if (!avail.length) return { group, footprints, setQuality };
  const total = avail.reduce((s, m) => s + m.w, 0);
  const r = rng(6061);
  const pick = () => {
    let x = r() * total;
    for (const m of avail) if ((x -= m.w) <= 0) return m;
    return avail[avail.length - 1];
  };
  // keep the kerb clear in front of every lot (driveway / where the player's car stops)
  const fronts = LOTS.map((l) => frontOf(l, 3));
  const placed = new Map<string, { m: THREE.Matrix4; c: THREE.Color; fp: Footprint }[]>();
  const off = HALF_ROAD - 1.4;
  for (const p of ROAD_PIECES) {
    for (const side of [-1, 1]) {
      let a = p.a0 + 9 + r() * 6;
      while (a < p.a1 - 9) {
        const car = pick();
        const len = car.len;
        if (r() < 0.22) {
          const x = p.axis === 'x' ? a : p.c + side * off;
          const z = p.axis === 'x' ? p.c + side * off : a;
          if (!fronts.some((f) => Math.hypot(f.x - x, f.z - z) < 7.5)) {
            // parked with the traffic on its side of the road, a little off-straight
            const heading = p.axis === 'x' ? (side > 0 ? Math.PI / 2 : -Math.PI / 2) : side > 0 ? Math.PI : 0;
            const yaw = heading + (r() - 0.5) * 0.05;
            const s = len / 2.55;
            const m = new THREE.Matrix4().compose(
              new THREE.Vector3(x, 0, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0)), new THREE.Vector3(s, s, s),
            );
            const c = new THREE.Color(TINTS[Math.floor(r() * TINTS.length)]);
            const list = placed.get(car.id) ?? [];
            list.push({ m, c, fp: { x, z, hw: (1.5 * s) / 2, hd: len / 2, rotY: yaw, id: `car:${car.id}:${list.length}` } });
            placed.set(car.id, list);
          }
        }
        a += len + 2.2 + r() * 4;
      }
    }
  }
  for (const car of avail) {
    const placedList = placed.get(car.id);
    if (!placedList?.length) continue;
    const list = [...placedList.filter((_, i) => i % 2 === 0), ...placedList.filter((_, i) => i % 2 === 1)];
    const im = new THREE.InstancedMesh(car.model!.geo, car.model!.mat, list.length);
    im.name = `parked:${car.id}`;
    list.forEach((e, i) => {
      im.setMatrixAt(i, e.m);
      im.setColorAt(i, e.c);
    });
    im.castShadow = true;
    im.receiveShadow = true;
    im.computeBoundingSphere();
    group.add(im);
    meshes.push({ im, fps: list.map((e) => e.fp) });
  }
  setQuality('high');
  return { group, footprints, setQuality };
}
