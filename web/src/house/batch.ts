// Static batching: the procedural interior is built from hundreds of small boxes and cylinders that
// share a few dozen materials. Merging them per material (transforms baked) cuts ~2000 draw calls to
// a couple of hundred, for the main pass and every shadow pass.
// Plain materials that differ only in colour (painted parts, books, mugs, cushions, fabric tints of one weave)
// merge too: the colour moves into a vertex attribute of the merged mesh, drawn with one shared twin material.
//
// Small instanced meshes flagged `userData.batchable` (rows of books) are expanded into the same buckets: one
// instance = one baked copy, its instance colour becomes the vertex colour.
//
// "Islands" are subtrees that must keep their own transform or visibility (sliding desk chairs, objects
// attached to cutaway walls, click targets): each is merged locally into its own root. Subtrees marked
// `userData.noBatch` (animated parts: clock hands, the door leaf) are left untouched.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const _inv = new THREE.Matrix4(), _m = new THREE.Matrix4();

/** Vertex-coloured twins of mergeable materials, one per signature (shared by every batch). */
const twins = new Map<string, THREE.MeshStandardMaterial>();

/** Everything about a material except its colour, or null when it must keep its identity (textured specials,
 *  transparency, emissive glow that may animate, materials flagged `userData.noMerge`, non-standard types). */
function signature(mat: THREE.Material): string | null {
  if (mat.type !== 'MeshStandardMaterial' || mat.userData.noMerge) return null;
  const m = mat as THREE.MeshStandardMaterial;
  if (m.vertexColors || m.transparent || m.opacity < 1 || m.alphaTest > 0 || !m.visible) return null;
  if (m.emissiveMap || m.lightMap || m.alphaMap || m.bumpMap || m.displacementMap || m.envMap) return null;
  if (m.emissive.r + m.emissive.g + m.emissive.b > 0) return null;
  const t = (x: THREE.Texture | null) => (x ? x.uuid : '-');
  const [rough, metal] = finish(m);
  return [
    t(m.map), t(m.normalMap), t(m.roughnessMap), t(m.metalnessMap), t(m.aoMap),
    rough.toFixed(3), metal.toFixed(3), m.envMapIntensity.toFixed(3), m.aoMapIntensity.toFixed(3),
    m.normalScale.x.toFixed(3), m.normalScale.y.toFixed(3), m.side, m.flatShading ? 1 : 0, m.depthWrite ? 1 : 0,
    m.polygonOffset ? `${m.polygonOffsetFactor},${m.polygonOffsetUnits}` : 0, m.toneMapped ? 1 : 0, m.fog ? 1 : 0,
    m.customProgramCacheKey(),
  ].join('|');
}

/** Roughness / metalness a merge bucket uses. Untextured paints snap to a few finish classes (matte, satin,
 *  semi-gloss, gloss; dielectric / half / full metal): mugs, keyboards, books and paper then share one draw per
 *  class instead of one per slightly different roughness, and nobody can tell 0.5 from 0.6 on a mug. */
function finish(m: THREE.MeshStandardMaterial): [number, number] {
  if (m.map || m.roughnessMap || m.normalMap) return [m.roughness, m.metalness];
  return [Math.max(0.2, Math.round(m.roughness * 4) / 4), Math.round(m.metalness * 2) / 2];
}

function twinOf(sig: string, mat: THREE.MeshStandardMaterial): THREE.MeshStandardMaterial {
  let t = twins.get(sig);
  if (!t) {
    t = mat.clone();
    t.onBeforeCompile = mat.onBeforeCompile; // not copied by clone()
    t.customProgramCacheKey = mat.customProgramCacheKey;
    [t.roughness, t.metalness] = finish(mat);
    t.color.set(0xffffff);
    t.vertexColors = true;
    t.name = `merged:${mat.name || 'plain'}`;
    twins.set(sig, t);
  }
  return t;
}

export function batchStatic(root: THREE.Object3D, islands: Iterable<THREE.Object3D>): { before: number; after: number } {
  root.updateWorldMatrix(true, true);
  // only islands inside this root (others belong to another batch call)
  const isl = new Set([...islands].filter((o) => o !== root && isInside(o, root)));
  let before = 0, after = 0;
  const count = (o: THREE.Object3D) => {
    let n = 0;
    o.traverse((c) => { if ((c as THREE.Mesh).isMesh) n++; });
    return n;
  };
  before = count(root);
  for (const island of isl) if (!island.userData.noBatch) mergeInto(island, isl);
  mergeInto(root, isl);
  after = count(root);
  return { before, after };
}

const MAX_EXPANDED_INSTANCES = 2048;

/** Merge every static mesh under `group` (skipping other islands / noBatch subtrees) into `group`. */
function mergeInto(group: THREE.Object3D, skip: Set<THREE.Object3D>) {
  _inv.copy(group.matrixWorld).invert();
  const buckets = new Map<string, { mat: THREE.Material; sig: string | null; cast: boolean; recv: boolean; items: THREE.Mesh[] }>();
  // stand-ins for the instances of expanded InstancedMeshes: their colour (material × instance colour) and source
  const tintOf = new Map<THREE.Mesh, THREE.Color>();
  const sourceOf = new Map<THREE.Mesh, THREE.InstancedMesh>();
  const add = (m: THREE.Mesh, mat: THREE.Material, sig: string | null) => {
    const key = `${sig ?? mat.uuid}|${m.castShadow ? 1 : 0}${m.receiveShadow ? 1 : 0}|${m.renderOrder}`;
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { mat, sig, cast: m.castShadow, recv: m.receiveShadow, items: [] }));
    b.items.push(m);
  };
  const visit = (o: THREE.Object3D) => {
    for (const c of o.children) {
      if (skip.has(c) || c.userData.noBatch || !c.visible) continue;
      const m = c as THREE.Mesh;
      const im = c as THREE.InstancedMesh;
      if (im.isInstancedMesh) {
        const mat = im.material as THREE.Material;
        const sig = Array.isArray(im.material) ? null : signature(mat);
        // only plain-paint instances (their colours become vertex colours of a twin) and only when asked for
        if (im.userData.batchable && sig !== null && im.count > 1 && im.count <= MAX_EXPANDED_INSTANCES && im.geometry.getAttribute('position')) {
          const base = (mat as THREE.MeshStandardMaterial).color;
          for (let i = 0; i < im.count; i++) {
            const stand = new THREE.Mesh(im.geometry, mat);
            im.getMatrixAt(i, _m);
            stand.matrixWorld.multiplyMatrices(im.matrixWorld, _m);
            stand.castShadow = im.castShadow;
            stand.receiveShadow = im.receiveShadow;
            stand.renderOrder = im.renderOrder;
            const col = new THREE.Color(1, 1, 1);
            if (im.instanceColor) im.getColorAt(i, col);
            tintOf.set(stand, col.multiply(base));
            sourceOf.set(stand, im);
            add(stand, mat, sig);
          }
        }
        continue;
      }
      if (m.isMesh && !(m as THREE.SkinnedMesh).isSkinnedMesh &&
          !Array.isArray(m.material) && m.geometry.getAttribute('position') && m.children.length === 0) {
        const mat = m.material as THREE.Material;
        add(m, mat, signature(mat));
      }
      visit(c);
    }
  };
  visit(group);
  const expanded = new Set<THREE.InstancedMesh>();
  for (const b of buckets.values()) {
    if (b.items.length < 2) {
      const m = b.items[0];
      if (sourceOf.has(m)) continue; // a lone stand-in: its instanced mesh stays as it is
      if (m.castShadow) {
        m.geometry.computeBoundingBox();
        _m.multiplyMatrices(_inv, m.matrixWorld);
        m.castShadow = castsVisibly(_box.copy(m.geometry.boundingBox!).applyMatrix4(_m));
      }
      continue;
    }
    // one material object for every item: keep it; several (same signature, other colours): vertex-coloured twin
    const tinted = b.sig !== null && b.items.some((x) => x.material !== b.mat || tintOf.has(x));
    const mat = tinted ? twinOf(b.sig!, b.mat as THREE.MeshStandardMaterial) : b.mat;
    const own = !!(b.mat as THREE.MeshStandardMaterial).vertexColors;
    const geos: THREE.BufferGeometry[] = [];
    const uv1 = usesUV1(b.mat);
    for (const mesh of b.items) geos.push(bake(mesh, tinted ? tintOf.get(mesh) ?? (mesh.material as THREE.MeshStandardMaterial).color : own ? 'own' : null, uv1));
    // a bucket of nothing but small or flat things (desk dressing, books, frames and art on walls, rugs) stays out
    // of the shadow passes: ambient occlusion grounds them, and every caster draw is repeated per shadow cascade
    const cast = b.cast && geos.some(castsVisibly);
    const merged = mergeGeometries(geos, false);
    for (const g of geos) g.dispose();
    if (!merged) continue;
    const out = new THREE.Mesh(merged, mat);
    out.name = `batch:${mat.name || mat.type}`;
    out.castShadow = cast;
    out.receiveShadow = b.recv;
    out.renderOrder = b.items[0].renderOrder;
    for (const mesh of b.items) {
      const src = sourceOf.get(mesh);
      if (src) expanded.add(src);
      else mesh.removeFromParent();
    }
    group.add(out);
  }
  for (const im of expanded) {
    im.removeFromParent();
    im.geometry.dispose(); // a box of its own (bookRow): nothing else uses it
    im.dispose();
  }
  pruneEmpty(group, skip);
}

/** Geometry with the mesh transform (relative to the batch root) baked in, normalized attributes. `colors`: a
 *  colour to bake into every vertex, 'own' to keep the mesh's colour attribute, null for none. */
function bake(mesh: THREE.Mesh, colors: THREE.Color | 'own' | null, uv1 = false): THREE.BufferGeometry {
  _m.multiplyMatrices(_inv, mesh.matrixWorld);
  const src = mesh.geometry;
  const g = new THREE.BufferGeometry();
  const n = src.getAttribute('position').count;
  g.setAttribute('position', toFloat(src.getAttribute('position'), 3));
  const normal = src.getAttribute('normal');
  g.setAttribute('uv', src.getAttribute('uv') ? toFloat(src.getAttribute('uv'), 2) : new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2));
  if (uv1) {
    const a = src.getAttribute('uv1') ?? src.getAttribute('uv');
    g.setAttribute('uv1', a ? toFloat(a, 2) : new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2));
  }
  if (colors === 'own') g.setAttribute('color', src.getAttribute('color') ? toFloat(src.getAttribute('color'), 3) : new THREE.Float32BufferAttribute(new Float32Array(n * 3).fill(1), 3));
  else if (colors) {
    const c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { c[i * 3] = colors.r; c[i * 3 + 1] = colors.g; c[i * 3 + 2] = colors.b; }
    g.setAttribute('color', new THREE.Float32BufferAttribute(c, 3));
  }
  // uniform index type for mergeGeometries
  const idx = src.index ? Array.from(src.index.array) : Array.from({ length: n }, (_, i) => i);
  if (_m.determinant() < 0) for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
  g.setIndex(idx);
  if (normal) g.setAttribute('normal', toFloat(normal, 3));
  else g.computeVertexNormals();
  g.applyMatrix4(_m);
  return g;
}

const _box = new THREE.Box3(), _size = new THREE.Vector3();

/** Would this (baked) part throw a shadow anyone notices? Not if it is small, a thin panel standing upright (art,
 *  boards, screens on walls) or lies on the floor (rugs, mats). Table tops are thin too, but horizontal and high. */
function castsVisibly(g: THREE.BufferGeometry | THREE.Box3): boolean {
  if (g instanceof THREE.Box3) _box.copy(g);
  else _box.setFromBufferAttribute(g.getAttribute('position') as THREE.BufferAttribute);
  _box.getSize(_size);
  if (Math.max(_size.x, _size.y, _size.z) < 0.35) return false;
  if (Math.min(_size.x, _size.z) < 0.03 && _size.y > 0.05) return false;
  return _box.max.y > 0.05;
}

/** Does any texture of the material read the second UV set (detail maps of patterned rugs)? */
function usesUV1(mat: THREE.Material): boolean {
  const m = mat as THREE.MeshStandardMaterial;
  return [m.map, m.normalMap, m.roughnessMap, m.aoMap, m.metalnessMap].some((t) => t?.channel === 1);
}

/** De-quantized, de-interleaved Float32 copy (GLB attributes may be normalized ints / interleaved). */
function toFloat(a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, size: number): THREE.BufferAttribute {
  // plain float attributes (most of them) are copied in one go; the per-vertex path below is slow on big props
  if (!(a as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute && a.array instanceof Float32Array &&
      !a.normalized && a.itemSize === size) {
    return new THREE.BufferAttribute(a.array.slice(0, a.count * size), size);
  }
  const out = new Float32Array(a.count * size);
  for (let i = 0; i < a.count; i++) {
    out[i * size] = a.getX(i);
    if (size > 1) out[i * size + 1] = a.getY(i);
    if (size > 2) out[i * size + 2] = a.getZ(i);
  }
  return new THREE.BufferAttribute(out, size); // (Float32BufferAttribute would copy the array once more)
}

function pruneEmpty(o: THREE.Object3D, keep: Set<THREE.Object3D>) {
  for (const c of [...o.children]) {
    if (keep.has(c) || c.userData.noBatch) continue;
    pruneEmpty(c, keep);
    if (c.children.length === 0 && (c.type === 'Group' || c.type === 'Object3D')) c.removeFromParent();
  }
}

function isInside(o: THREE.Object3D, root: THREE.Object3D): boolean {
  for (let x = o.parent; x; x = x.parent) if (x === root) return true;
  return false;
}
