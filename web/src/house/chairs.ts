// Chairs that slide (desk and table chairs) cannot be merged into the static batches: each one keeps its own
// transform, so a room with six dining chairs paid six draw calls (twelve for two-material office chairs), and as
// many again in every shadow pass. Identical chairs of one furnishing are drawn as one InstancedMesh per part
// instead; the chair objects stay in place (invisible) as the handles the people slide, and the instances follow
// them.
import * as THREE from 'three';
import type { Kit } from './furniture/kit';

interface Part {
  mesh: THREE.Mesh;
  /** Transform relative to the chair root. */
  rel: THREE.Matrix4;
}

const _inv = new THREE.Matrix4(), _m = new THREE.Matrix4();

/** Draw the identical `chairs` of `kit` instanced (after batching). Chairs without a twin are left as they are. */
export function instanceChairs(kit: Kit, chairs: THREE.Object3D[]) {
  const root = kit.root;
  root.updateWorldMatrix(true, true);
  const groups = new Map<string, { chairs: THREE.Object3D[]; parts: Part[][] }>();
  for (const chair of new Set(chairs)) {
    if (!isInside(chair, root)) continue;
    const parts = partsOf(chair);
    if (!parts) continue;
    const key = parts.map(partKey).join('#');
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { chairs: [], parts: [] }));
    g.chairs.push(chair);
    g.parts.push(parts);
  }
  const sets: { chairs: THREE.Object3D[]; rel: THREE.Matrix4[]; meshes: THREE.InstancedMesh[]; last: THREE.Vector3[] }[] = [];
  for (const g of groups.values()) {
    if (g.chairs.length < 2) continue;
    const proto = g.parts[0];
    const meshes = proto.map((p) => {
      const im = new THREE.InstancedMesh(p.mesh.geometry, p.mesh.material, g.chairs.length);
      im.name = `chairs:${(p.mesh.material as THREE.Material).name || 'part'}`;
      im.castShadow = p.mesh.castShadow;
      im.receiveShadow = p.mesh.receiveShadow;
      im.renderOrder = p.mesh.renderOrder;
      im.userData.noBatch = true;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      root.add(im);
      return kit.own(im);
    });
    for (const parts of g.parts) for (const p of parts) p.mesh.visible = false;
    sets.push({ chairs: g.chairs, rel: proto.map((p) => p.rel), meshes, last: g.chairs.map(() => new THREE.Vector3(NaN, 0, 0)) });
  }
  if (!sets.length) return;
  const sync = (force: boolean) => {
    for (const s of sets) {
      let dirty = false;
      s.chairs.forEach((chair, i) => {
        if (!force && chair.position.equals(s.last[i])) return;
        s.last[i].copy(chair.position);
        chair.updateWorldMatrix(true, false); // (the kit root's too: it may have moved into its floor since)
        _inv.copy(root.matrixWorld).invert();
        s.meshes.forEach((im, k) => im.setMatrixAt(i, _m.multiplyMatrices(_inv, chair.matrixWorld).multiply(s.rel[k])));
        dirty = true;
      });
      if (!dirty) continue;
      for (const im of s.meshes) {
        im.instanceMatrix.needsUpdate = true;
        if (force) im.computeBoundingSphere();
      }
    }
  };
  sync(true);
  // the bounds are computed once with every chair tucked in: a slid-out chair (≤ 0.3 m) must not be culled
  for (const s of sets) for (const im of s.meshes) if (im.boundingSphere) im.boundingSphere.radius += 0.5;
  kit.updaters.push(() => sync(false));
}

/** The visible meshes a chair is drawn with (null: something it cannot be instanced with, e.g. a skinned part). */
function partsOf(chair: THREE.Object3D): Part[] | null {
  chair.updateWorldMatrix(true, true);
  _inv.copy(chair.matrixWorld).invert();
  const out: Part[] = [];
  let ok = true;
  chair.traverseVisible((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    if ((m as THREE.SkinnedMesh).isSkinnedMesh || (m as THREE.InstancedMesh).isInstancedMesh || Array.isArray(m.material) || m.userData.noBatch) {
      ok = false;
      return;
    }
    if ((m.material as THREE.Material).visible === false) return; // pick proxies
    out.push({ mesh: m, rel: new THREE.Matrix4().multiplyMatrices(_inv, m.matrixWorld) });
  });
  return ok && out.length ? out : null;
}

/** Same material, same placement in the chair and the same geometry (the very object, or an identical copy: the
 *  batcher bakes each chair's parts into geometry of its own). */
function partKey(p: Part): string {
  const g = p.mesh.geometry;
  const pos = g.getAttribute('position');
  let sum = 0;
  const step = Math.max(1, Math.floor(pos.count / 64));
  for (let i = 0; i < pos.count; i += step) sum += pos.getX(i) * 1.3 + pos.getY(i) * 2.7 + pos.getZ(i) * 3.1;
  const rel = p.rel.elements.map((e) => e.toFixed(4)).join(',');
  const m = p.mesh;
  return `${(m.material as THREE.Material).uuid}|${pos.count}|${g.index?.count ?? 0}|${sum.toFixed(3)}|${rel}|${m.castShadow ? 1 : 0}${m.receiveShadow ? 1 : 0}|${m.renderOrder}`;
}

function isInside(o: THREE.Object3D, root: THREE.Object3D): boolean {
  for (let x = o.parent; x; x = x.parent) if (x === root) return true;
  return false;
}
