// Street furniture from Poly Haven GLBs, instanced. The Victorian lamp is 30k triangles, so the lamps themselves
// don't cast shadows; a cheap invisible pole+lantern proxy renders into the shadow map instead.
import * as THREE from 'three';
import type { Assets, Quality } from '../core/types';
import { lightPoolMaterial } from './fx';

export interface PropPlacement {
  x: number;
  z: number;
  y: number;
  rotY: number;
}

/** InstancedMeshes (one per GLB primitive) for a prop at many placements. */
function instanceGlb(root: THREE.Object3D, placements: PropPlacement[], opts: { scale?: number; cast?: boolean; filter?: (m: THREE.Mesh) => boolean; recenter?: boolean }): THREE.Group {
  const group = new THREE.Group();
  root.updateMatrixWorld(true);
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && (!opts.filter || opts.filter(o as THREE.Mesh))) meshes.push(o as THREE.Mesh);
  });
  // optional recentring on the XZ centre of the kept meshes (some GLBs ship two variants side by side)
  const offset = new THREE.Matrix4();
  if (opts.recenter) {
    const box = new THREE.Box3();
    meshes.forEach((m) => box.expandByObject(m));
    const c = box.getCenter(new THREE.Vector3());
    offset.makeTranslation(-c.x, -box.min.y, -c.z);
  }
  const s = opts.scale ?? 1;
  const place = placements.map((p) =>
    new THREE.Matrix4().compose(new THREE.Vector3(p.x, p.y, p.z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, p.rotY, 0)), new THREE.Vector3(s, s, s)),
  );
  for (const mesh of meshes) {
    const local = offset.clone().multiply(mesh.matrixWorld);
    const im = new THREE.InstancedMesh(mesh.geometry, mesh.material, placements.length);
    place.forEach((m, i) => im.setMatrixAt(i, m.clone().multiply(local)));
    im.castShadow = opts.cast ?? true;
    im.receiveShadow = true;
    im.computeBoundingSphere();
    group.add(im);
  }
  return group;
}

/** Invisible geometry that only shows up in the shadow map. */
function shadowProxy(placements: PropPlacement[]): THREE.InstancedMesh {
  const pole = new THREE.CylinderGeometry(0.06, 0.09, 3.2, 6).translate(0, 1.6, 0);
  const head = new THREE.BoxGeometry(0.34, 0.45, 0.34).translate(0, 3.35, 0);
  const geo = mergeSimple([pole, head]);
  const mat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
  const im = new THREE.InstancedMesh(geo, mat, placements.length);
  placements.forEach((p, i) => im.setMatrixAt(i, new THREE.Matrix4().makeTranslation(p.x, p.y, p.z)));
  im.castShadow = true;
  im.receiveShadow = false;
  im.computeBoundingSphere();
  return im;
}

function mergeSimple(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const pos: number[] = [];
  for (const g of geos) {
    const ng = g.index ? g.toNonIndexed() : g;
    pos.push(...(ng.getAttribute('position').array as Float32Array));
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return out;
}

export interface StreetPropsPlan {
  lamps: PropPlacement[];
  benches: PropPlacement[];
  bins: PropPlacement[];
  boxes: PropPlacement[];
}

export interface StreetProps {
  group: THREE.Group;
  /** Distance LOD for the lamps (the GLB lamp is 30k triangles; far ones swap to a 150-triangle stand-in). */
  update(camera: THREE.Camera, quality: Quality): void;
  /** Time of day (0 day … 1 night): lanterns light up and throw pools of light on the pavement. */
  setNight(night: number): void;
  /** Lamps that currently have a real light (engine night-lamp pool): their painted pool steps aside. */
  setLit(lights: THREE.Vector3Like[]): void;
}

const POOL_SIZE = 10;
const poolMatrix = (p: PropPlacement, on: number) => new THREE.Matrix4().compose(
  new THREE.Vector3(p.x, p.y + 0.04, p.z), new THREE.Quaternion(), new THREE.Vector3(POOL_SIZE * on, 1, POOL_SIZE * on),
);

/** Pools of lamp light on the ground (see lightPoolMaterial), one instance per lamp. */
function lightPools(placements: PropPlacement[]): THREE.InstancedMesh {
  const g = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const mat = lightPoolMaterial();
  const im = new THREE.InstancedMesh(g, mat, placements.length);
  placements.forEach((p, i) => im.setMatrixAt(i, poolMatrix(p, 1)));
  im.renderOrder = 2;
  im.castShadow = false;
  im.receiveShadow = false;
  im.raycast = () => {};
  im.visible = false;
  im.computeBoundingSphere();
  return im;
}

/** Detailed lamps within this distance (m); beyond, the stand-in is only a few pixels tall. */
const LAMP_NEAR: Record<Quality, number> = { low: 15, medium: 28, high: 40, ultra: 65 };

/** Low-poly lamp: pole, base, lantern box and cap (metal) + a glowing lantern core. */
function simpleLamp(): { body: THREE.BufferGeometry; glow: THREE.BufferGeometry } {
  const pole = new THREE.CylinderGeometry(0.05, 0.07, 3.2, 6).translate(0, 1.6, 0);
  const base = new THREE.CylinderGeometry(0.13, 0.16, 0.5, 6).translate(0, 0.25, 0);
  const frame = new THREE.CylinderGeometry(0.2, 0.13, 0.08, 4, 1).rotateY(Math.PI / 4).translate(0, 3.17, 0);
  const cap = new THREE.ConeGeometry(0.25, 0.26, 4).rotateY(Math.PI / 4).translate(0, 3.72, 0);
  const glow = new THREE.CylinderGeometry(0.2, 0.15, 0.42, 4, 1).rotateY(Math.PI / 4).translate(0, 3.42, 0);
  return { body: mergeSimple([pole, base, frame, cap]), glow: mergeSimple([glow]) };
}

export async function buildStreetProps(assets: Assets, plan: StreetPropsPlan): Promise<StreetProps> {
  const group = new THREE.Group();
  group.name = 'street-props';
  const [lamp, bench, bin, box] = await Promise.all([
    assets.gltf('/assets/props-city/street_lamp_01_1k.glb'),
    assets.gltf('/assets/props-city/painted_wooden_bench_1k.glb'),
    assets.gltf('/assets/props-city/metal_trash_can_1k.glb'),
    assets.gltf('/assets/props-city/utility_box_01_1k.glb'),
  ]);
  // warm lantern glow (blooms softly); intensities follow the time of day in setNight
  const bulbs: THREE.MeshStandardMaterial[] = [], panes: THREE.MeshStandardMaterial[] = [];
  lamp.scene.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
    if (!m) return;
    // at night a point light sits inside the lantern: glossy speculars a few cm from it overflow the half-float
    // frame buffer (inf → NaN blocks after bloom), so the lamp's own surfaces stay fairly rough
    m.roughnessMap = null;
    m.roughness = Math.max(m.roughness, 0.6);
    if (/bulb/i.test(m.name)) {
      m.emissive = new THREE.Color(0xffc27a);
      bulbs.push(m);
    } else if (/glass/i.test(m.name)) {
      m.emissive = new THREE.Color(0xffb866);
      panes.push(m);
    }
  });
  const near = instanceGlb(lamp.scene, plan.lamps, { cast: false });
  group.add(near);
  const lo = simpleLamp();
  const far = [
    new THREE.InstancedMesh(lo.body, new THREE.MeshStandardMaterial({ name: 'lamp-lo', color: 0x1c1d1f, roughness: 0.6, metalness: 0.6 }), plan.lamps.length),
    new THREE.InstancedMesh(lo.glow, new THREE.MeshStandardMaterial({ name: 'lamp-lo-glow', color: 0x3a2a18, emissive: 0xffb866, emissiveIntensity: 2.2 }), plan.lamps.length),
  ];
  far.forEach((m) => {
    m.castShadow = false;
    m.receiveShadow = true;
    group.add(m);
  });
  group.add(shadowProxy(plan.lamps));
  const pools = lightPools(plan.lamps);
  group.add(pools);
  const farGlow = far[1].material as THREE.MeshStandardMaterial;
  // benches, bins and boxes: small shadows that Low skips (their shadow pass costs more than it shows)
  const small = [
    instanceGlb(bench.scene, plan.benches, {}),
    instanceGlb(bin.scene, plan.bins, { filter: (m) => /^metal_trash_can$|handle_(left|right)$/.test(m.name) && !/rust/.test(m.name), recenter: true, scale: 0.9 }),
    instanceGlb(box.scene, plan.boxes, {}),
  ];
  small.forEach((g) => group.add(g));
  const smallCasters = small.flatMap((g) => g.children as THREE.InstancedMesh[]).filter((m) => m.castShadow);

  // per-instance matrices: detailed meshes carry their GLB-local offset, the stand-in is placed directly
  const nearMeshes = near.children as THREE.InstancedMesh[];
  const nearBase = nearMeshes.map((im) => Array.from({ length: plan.lamps.length }, (_, i) => {
    const m = new THREE.Matrix4();
    im.getMatrixAt(i, m);
    return m;
  }));
  const farBase = plan.lamps.map((p) => new THREE.Matrix4().compose(new THREE.Vector3(p.x, p.y, p.z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, p.rotY, 0)), new THREE.Vector3(1, 1, 1)));
  const last = new THREE.Vector3(Infinity, 0, 0);
  let lastQ: Quality | null = null;
  const setNight = (night: number) => {
    // lanterns are on (dimly) by day already; full brightness once it's dark
    const on = THREE.MathUtils.smoothstep(night, 0.1, 1);
    for (const m of bulbs) m.emissiveIntensity = THREE.MathUtils.lerp(1.2, 9, on);
    for (const m of panes) m.emissiveIntensity = THREE.MathUtils.lerp(0.25, 1.8, on);
    farGlow.emissiveIntensity = THREE.MathUtils.lerp(0.6, 4.5, on);
    const pool = THREE.MathUtils.smoothstep(night, 0.3, 1);
    pools.visible = pool > 0;
    // moonlit ground is a few dozen times darker than ground under a street lamp
    (pools.material as THREE.MeshBasicMaterial).color.setRGB(1.0, 0.55, 0.22).multiplyScalar(36 * pool);
  };
  let litKey = '';
  setNight(0);
  return {
    group,
    setNight,
    setLit(lights) {
      const lit = plan.lamps.map((p) => (lights.some((l) => Math.abs(l.x - p.x) < 0.5 && Math.abs(l.z - p.z) < 0.5) ? 1 : 0));
      const key = lit.join('');
      if (key === litKey) return;
      litKey = key;
      plan.lamps.forEach((p, i) => pools.setMatrixAt(i, poolMatrix(p, 1 - lit[i])));
      pools.instanceMatrix.needsUpdate = true;
    },
    update(camera, quality) {
      if (camera.position.distanceToSquared(last) < 4 && quality === lastQ) return;
      last.copy(camera.position);
      if (quality !== lastQ) for (const m of smallCasters) m.castShadow = quality !== 'low';
      lastQ = quality;
      const NEAR2 = LAMP_NEAR[quality] ** 2;
      let n = 0, f = 0;
      plan.lamps.forEach((p, i) => {
        const dx = p.x - last.x, dy = p.y - last.y, dz = p.z - last.z;
        if (dx * dx + dy * dy + dz * dz < NEAR2) {
          nearMeshes.forEach((im, k) => im.setMatrixAt(n, nearBase[k][i]));
          n++;
        } else {
          far.forEach((im) => im.setMatrixAt(f, farBase[i]));
          f++;
        }
      });
      for (const im of nearMeshes) {
        im.count = n;
        im.instanceMatrix.needsUpdate = true;
        im.computeBoundingSphere();
      }
      for (const im of far) {
        im.count = f;
        im.instanceMatrix.needsUpdate = true;
        im.computeBoundingSphere();
      }
    },
  };
}
