// Character factory. Rocketbox avatars: clone the avatar scene (SkeletonUtils), keep the LOD the quality asks
// for, and give the hair/lash cards a soft-edge pass (alpha-blended, no depth write, drawn after the 0.5 cut-out
// so edges are smooth without sorting artefacts). Fallback (avatar failed to load): the UBC base body dressed by
// the clothing shader with a UBC hairstyle bound to the same skeleton. Both expose the bones controllers need
// (hands for props, arms for typing IK, head for the tag) and hand sockets in the mannequin's hand frame.
import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import type { Look } from './appearance';
import { applyClothing } from './clothing';
import { findBodyMesh, type BodyEntry, type CharacterLibrary, type HairStyle } from './library';

export interface Character {
  /** Cloned GLB scene (Y up, faces +Z). Scale = look.height. Position is driven by the animator. */
  model: THREE.Object3D;
  body: THREE.SkinnedMesh;
  entry: BodyEntry;
  bone(name: string): THREE.Bone;
  /** Attachment point on a bone whose frame matches the UAL mannequin's (hand_l, hand_r, Head). */
  socket(name: string): THREE.Object3D;
  /** Triangles drawn per frame for this character (one pass). */
  triangles: number;
  dispose(): void;
}

/** Build a character for `look`. Its body must be loaded (`await lib.load(look)`, or use `loadCharacter`). */
export function createCharacter(lib: CharacterLibrary, look: Look): Character {
  const entry = lib.peek(look);
  if (!entry) throw new Error(`[people] body for avatar ${look.avatar ?? look.gender} is not loaded yet: await lib.load(look) or use loadCharacter()`);
  return entry.kind === 'rocketbox' ? rocketbox(lib, entry, look) : ubc(lib, entry, look);
}

/** Load the look's body (once) and build the character. */
export async function loadCharacter(lib: CharacterLibrary, look: Look): Promise<Character> {
  await lib.load(look);
  return createCharacter(lib, look);
}

function rocketbox(lib: CharacterLibrary, entry: BodyEntry, look: Look): Character {
  const model = SkeletonUtils.clone(entry.scene);
  model.scale.setScalar(look.height);
  const q = lib.quality();
  const lowLod = q === 'low';
  const softHair = q !== 'low';
  // node 'body' = LOD0 skin + hair cards (a Group of SkinnedMeshes, one per primitive); 'body_lod1' = the
  // simplified skin only. Low keeps LOD1's skin with LOD0's hair.
  const lod0 = model.getObjectByName('body');
  const lod1 = model.getObjectByName('body_lod1');
  if (lod0 && lod1) {
    if (!lowLod) lod1.removeFromParent();
    else {
      const skins: THREE.Object3D[] = [];
      lod0.traverse((o) => {
        const m = o as THREE.SkinnedMesh;
        if (m.isSkinnedMesh && !(m.material as THREE.Material).userData.hair) skins.push(m);
      });
      for (const s of skins) s.removeFromParent();
    }
  }
  const owned: THREE.Object3D[] = [];
  let triangles = 0;
  let body: THREE.SkinnedMesh | null = null;
  const meshes: THREE.SkinnedMesh[] = [];
  model.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (m.isSkinnedMesh) meshes.push(m);
  });
  for (const m of meshes) {
    m.castShadow = true;
    m.receiveShadow = true;
    m.frustumCulled = false; // root motion + seated offsets move skinned verts far from the bind bounds
    const idx = m.geometry.index;
    triangles += (idx ? idx.count : m.geometry.getAttribute('position').count) / 3;
    const mat = m.material as THREE.MeshStandardMaterial;
    if (mat.userData.hair) {
      if (softHair) {
        const edge = new THREE.SkinnedMesh(m.geometry, hairEdgeMaterial(mat));
        edge.name = 'hair-edge';
        edge.bind(m.skeleton, m.bindMatrix);
        edge.castShadow = false;
        edge.receiveShadow = true;
        edge.frustumCulled = false;
        edge.renderOrder = 1;
        m.parent!.add(edge);
        owned.push(edge);
      }
    } else if (!body || m.geometry.getAttribute('position').count > body.geometry.getAttribute('position').count) {
      body = m;
    }
  }
  if (!body) throw new Error(`[people] avatar ${entry.id} has no body mesh`);
  return finish(model, body, entry, triangles, () => {
    for (const o of owned) o.removeFromParent();
  });
}

const edgeMats = new WeakMap<THREE.Material, THREE.MeshStandardMaterial>();
/** Shared per avatar: the hair material blended (soft fringes below the cut-out threshold). */
function hairEdgeMaterial(src: THREE.MeshStandardMaterial): THREE.MeshStandardMaterial {
  let m = edgeMats.get(src);
  if (!m) {
    m = src.clone();
    m.name = `${src.name}:edge`;
    m.alphaTest = 0.02;
    m.transparent = true;
    m.depthWrite = false;
    m.userData = { hairEdge: true };
    edgeMats.set(src, m);
  }
  return m;
}

function ubc(lib: CharacterLibrary, entry: BodyEntry, look: Look): Character {
  const model = SkeletonUtils.clone(entry.scene);
  model.scale.setScalar(look.height);
  const body = findBodyMesh(model);
  const owned: THREE.Material[] = [];

  // body: per-person material (skin texture variant + clothing uniforms)
  const src = body.material as THREE.MeshStandardMaterial;
  const mat = src.clone();
  mat.name = 'rlt-body';
  if (look.skin.light && entry.skinTextures) mat.map = entry.skinTextures.light;
  mat.roughness = 1;
  mat.metalness = 0;
  mat.envMapIntensity = 0.8;
  applyClothing(mat, look, entry.metrics);
  body.material = mat;
  owned.push(mat);

  const hairDark = look.hair.color.clone().multiplyScalar(0.8);
  let triangles = 0;
  model.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.castShadow = true;
    m.receiveShadow = true;
    m.frustumCulled = false;
    const idx = m.geometry.index;
    triangles += (idx ? idx.count : m.geometry.getAttribute('position').count) / 3;
    if (m !== body && /eyebrow/i.test(m.name)) {
      const em = (m.material as THREE.MeshStandardMaterial).clone();
      em.color.copy(hairDark);
      m.material = em;
      owned.push(em);
      m.castShadow = false;
    }
  });

  const attach = (style: HairStyle) => {
    const srcHair = lib.hair.get(style);
    if (!srcHair) return;
    const hair = bindToSkeleton(srcHair, body);
    if (!hair) return;
    const hm = (srcHair.material as THREE.MeshStandardMaterial).clone();
    hm.color.copy(look.hair.color).multiplyScalar(1.15);
    hm.roughness = 0.62;
    hm.metalness = 0;
    hm.envMapIntensity = 0.9;
    hair.material = hm;
    owned.push(hm);
    body.parent!.add(hair);
    const idx = hair.geometry.index;
    triangles += (idx ? idx.count : hair.geometry.getAttribute('position').count) / 3;
  };
  attach(look.hair.style);
  if (look.hair.beard) attach('Hair_Beard');
  return finish(model, body, entry, triangles, () => {
    for (const m of owned) m.dispose();
  });
}

function finish(model: THREE.Object3D, body: THREE.SkinnedMesh, entry: BodyEntry, triangles: number, cleanup: () => void): Character {
  const bones = new Map<string, THREE.Bone>();
  for (const b of body.skeleton.bones) bones.set(b.name, b);
  const sockets = new Map<string, THREE.Object3D>();
  const bone = (name: string) => {
    const b = bones.get(name);
    if (!b) throw new Error(`no bone ${name}`);
    return b;
  };
  return {
    model,
    body,
    entry,
    triangles,
    bone,
    socket(name) {
      let s = sockets.get(name);
      if (!s) {
        s = new THREE.Object3D();
        s.name = `socket:${name}`;
        const q = entry.sockets.get(name);
        if (q) s.quaternion.copy(q);
        bone(name).add(s);
        sockets.set(name, s);
      }
      return s;
    },
    dispose() {
      cleanup();
      model.removeFromParent();
      // every skinned mesh of the clone got its own skeleton (SkeletonUtils.clone, bindToSkeleton), and each one the
      // renderer has drawn holds a bone-matrix texture on the GPU until disposed
      const skeletons = new Set<THREE.Skeleton>();
      model.traverse((o) => {
        const m = o as THREE.SkinnedMesh;
        if (m.isSkinnedMesh) skeletons.add(m.skeleton);
      });
      for (const s of skeletons) s.dispose();
    },
  };
}

/** A new SkinnedMesh sharing `src` geometry, driven by `body`'s bones (matched by name). */
function bindToSkeleton(src: THREE.SkinnedMesh, body: THREE.SkinnedMesh): THREE.SkinnedMesh | null {
  const byName = new Map(body.skeleton.bones.map((b) => [b.name, b] as const));
  const bones: THREE.Bone[] = [];
  for (const b of src.skeleton.bones) {
    // later scenes in the hair GLB get de-duplicated joint names ("spine_01_2"): strip one suffix
    const target = byName.get(b.name) ?? byName.get(b.name.replace(/_\d+$/, ''));
    if (!target) return null;
    bones.push(target);
  }
  const skeleton = new THREE.Skeleton(bones, src.skeleton.boneInverses.map((m) => m.clone()));
  const mesh = new THREE.SkinnedMesh(src.geometry, src.material);
  mesh.name = src.name;
  mesh.bind(skeleton, src.bindMatrix.clone());
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  return mesh;
}
