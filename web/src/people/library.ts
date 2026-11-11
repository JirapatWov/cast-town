// Character library: Microsoft Rocketbox clothed avatars (built by tools/characters, bones renamed to the
// UE-mannequin names), the Quaternius UAL1/UAL2 clips retargeted onto each of them, and the old UBC base
// bodies as a fallback when an avatar fails to load.
//
// Retarget (once per body, at load): per keyframe the mannequin is posed by FK, and every body bone gets the
// mannequin bone's WORLD rotation, corrected by its rest pose AND by a swing that lines the body's rest bone
// direction up with the mannequin's (W_dst = W_src · R_src⁻¹ · S · R_dst). The swing is what makes a rig bound
// in an A-pose (Rocketbox) or with a curvier spine follow a T-pose source exactly: limb directions match, twist
// is carried over from the rest pose. Only the hips translate; their path is scaled by the leg-length ratio so
// feet stay planted, and re-expressed in the body's own hips parent frame.
import * as THREE from 'three';
import type { Assets, Quality } from '../core/types';
import type { Look } from './appearance';
import { AVATARS, type AvatarInfo } from './avatars';

export type Gender = 'm' | 'f';
export type HairStyle = 'Hair_Long' | 'Hair_Buns' | 'Hair_SimpleParted' | 'Hair_Buzzed' | 'Hair_BuzzedFemale' | 'Hair_Beard';

/** Bind-pose landmarks (meters, model space: Y up, +Z front). */
export interface BodyMetrics {
  ankleY: number;
  kneeY: number;
  hipY: number;
  waistY: number;
  chestY: number;
  neckY: number;
  headY: number;
  shoulderX: number;
  thighX: number;
  elbowX: number;
  wristX: number;
  pelvisY: number;
}

export interface ClipInfo {
  clip: THREE.AnimationClip;
  /** Pelvis ground offset (model space x, z) at start / end / averaged over the clip. */
  offStart: THREE.Vector2;
  offEnd: THREE.Vector2;
  offMean: THREE.Vector2;
  /** Pelvis height at the start (model space). */
  pelvisYStart: number;
  /** Locomotion clips: ground speed (m/s, model space, timeScale 1) measured from the planted foot. */
  speed?: number;
  /** Locomotion clips: ankle positions per key (model space x, y, z per foot) and their lowest height, so a walk
   *  can start at the phase whose feet are nearest where the feet stand. */
  feet?: { times: number[]; l: Float32Array; r: Float32Array; minY: number };
}

export interface BodyEntry {
  /** Avatar id ('f03'…) or 'ubc-m' / 'ubc-f' for the fallback bodies. */
  id: string;
  kind: 'rocketbox' | 'ubc';
  scene: THREE.Object3D;
  metrics: BodyMetrics;
  clips: Map<string, ClipInfo>;
  /** Per bone: the rotation that turns this rig's bone frame into the mannequin's (prop offsets are authored
   *  for the mannequin hand). */
  sockets: Map<string, THREE.Quaternion>;
  /** UBC only: alternative light-skin texture. */
  skinTextures?: { base: THREE.Texture | null; light: THREE.Texture };
  avatar?: AvatarInfo;
}

export interface CharacterLibrary {
  /** Bodies loaded so far, by entry id. */
  readonly bodies: Map<string, BodyEntry>;
  /** UBC hairstyles (fallback bodies only; empty until a fallback was needed). */
  readonly hair: Map<HairStyle, THREE.SkinnedMesh>;
  /** Current render quality (LOD, hair edge pass). */
  quality(): Quality;
  /** The body a look needs, if it is loaded already. */
  peek(look: Look): BodyEntry | null;
  /** Load (once) the body a look needs. Never rejects: a failed avatar resolves to the fallback body. */
  load(look: Look): Promise<BodyEntry>;
}

export const CLIPS = [
  'Idle_Loop', 'Idle_Talking_Loop', 'Walk_Loop', 'Walk_Formal_Loop', 'Sitting_Enter', 'Sitting_Exit', 'Sitting_Idle_Loop',
  'Sitting_Talking_Loop', 'Interact', 'Fixing_Kneeling', 'Crouch_Idle_Loop',
  'Idle_TalkingPhone_Loop', 'Idle_FoldArms_Loop', 'Idle_No_Loop', 'Idle_Rail_Loop',
  'Yes', 'Consume', 'Farm_Watering',
] as const;
export type ClipName = (typeof CLIPS)[number];
const LOCOMOTION = new Set(['Walk_Loop', 'Walk_Formal_Loop']);

/** Child that defines each bone's direction (for the rest-pose swing). */
const DIR_CHILD: Record<string, string> = {
  pelvis: 'spine_01', spine_01: 'spine_02', spine_02: 'spine_03', spine_03: 'neck_01', neck_01: 'Head',
};
for (const s of ['l', 'r']) {
  Object.assign(DIR_CHILD, {
    [`clavicle_${s}`]: `upperarm_${s}`, [`upperarm_${s}`]: `lowerarm_${s}`, [`lowerarm_${s}`]: `hand_${s}`, [`hand_${s}`]: `middle_01_${s}`,
    [`thigh_${s}`]: `calf_${s}`, [`calf_${s}`]: `foot_${s}`, [`foot_${s}`]: `ball_${s}`,
  });
  for (const f of ['thumb', 'index', 'middle', 'ring', 'pinky']) {
    DIR_CHILD[`${f}_01_${s}`] = `${f}_02_${s}`;
    DIR_CHILD[`${f}_02_${s}`] = `${f}_03_${s}`;
  }
}

const A = '/assets';
let shared: Promise<CharacterLibrary> | null = null;
let qualityOf: () => Quality = () => 'high';

/** Shared library (clips + catalog; avatars load on demand through `lib.load(look)`). `quality` is read when a
 *  character is created (LOD and hair edge pass); later calls may update it. */
export function loadCharacterLibrary(assets: Assets, quality?: () => Quality): Promise<CharacterLibrary> {
  if (quality) qualityOf = quality;
  shared ??= load(assets);
  return shared;
}

async function load(assets: Assets): Promise<CharacterLibrary> {
  const [ual1, ual2] = await Promise.all([assets.gltf(`${A}/animations/UAL1_resampled.glb`), assets.gltf(`${A}/animations/UAL2_resampled.glb`)]);
  const wanted = new Set<string>(CLIPS);
  const rawClips = [...ual1.animations, ...ual2.animations].filter((c) => wanted.has(c.name));
  const src = restRig(ual1.scene);
  const bodies = new Map<string, BodyEntry>();
  const hair = new Map<HairStyle, THREE.SkinnedMesh>();
  const pending = new Map<string, Promise<BodyEntry>>();

  /** Avatars whose GLB failed: their looks resolve to the fallback body from then on (no refetch loops). */
  const failed = new Set<string>();
  const entryId = (look: Look) =>
    look.avatar && !failed.has(look.avatar) && AVATARS.some((a) => a.id === look.avatar) ? look.avatar : `ubc-${look.gender}`;

  const loadUbc = (g: Gender): Promise<BodyEntry> => {
    const id = `ubc-${g}`;
    let p = pending.get(id);
    if (!p) {
      p = (async () => {
        const [scene, hairs] = await Promise.all([
          assets.gltf(`${A}/characters/${g === 'm' ? 'Superhero_Male_FullBody' : 'Superhero_Female_FullBody'}.glb`),
          assets.gltf(`${A}/characters/UBC_Hairstyles.glb`),
        ]);
        if (!hair.size) {
          for (const s of hairs.scenes) {
            const mesh = s.getObjectByProperty('isSkinnedMesh', true) as THREE.SkinnedMesh | undefined;
            // GLTFLoader de-duplicates names (scene "Hair_Buns" vs node "Hair_Buns" → "Hair_Buns_1"): strip the suffix
            if (mesh) hair.set((mesh.name || s.name).replace(/_\d+$/, '') as HairStyle, mesh);
          }
        }
        const light = assets.texture(g === 'm' ? `${A}/characters/T_Superhero_Male_Ligh_1k.webp` : `${A}/characters/T_Superhero_Female_Light_BaseColor_1k.webp`, { srgb: true });
        light.flipY = false; // glTF UV convention
        const entry = await makeEntry(id, 'ubc', scene.scene, src, rawClips);
        entry.skinTextures = { base: (findBodyMesh(scene.scene).material as THREE.MeshStandardMaterial).map, light };
        bodies.set(id, entry);
        return entry;
      })();
      pending.set(id, p);
    }
    return p;
  };

  const loadAvatar = (info: AvatarInfo): Promise<BodyEntry> => {
    let p = pending.get(info.id);
    if (!p) {
      p = (async () => {
        const gltf = await assets.gltf(info.file);
        prepareAvatarMaterials(gltf.scene, info);
        const entry = await makeEntry(info.id, 'rocketbox', gltf.scene, src, rawClips);
        entry.avatar = info;
        bodies.set(info.id, entry);
        return entry;
      })().catch((err) => {
        console.warn(`[people] avatar ${info.id} failed, using the fallback body`, err);
        failed.add(info.id);
        return loadUbc(info.gender);
      });
      pending.set(info.id, p);
    }
    return p;
  };

  return {
    bodies,
    hair,
    quality: () => qualityOf(),
    peek(look) {
      return bodies.get(entryId(look)) ?? null;
    },
    load(look) {
      const info = AVATARS.find((a) => a.id === look.avatar);
      return info ? loadAvatar(info) : loadUbc(look.gender);
    },
  };
}

/** Rocketbox materials, once per avatar (instances share them): hair cards cut out at 0.5 (+ a soft edge pass
 *  added per character on Medium+), sensible env response for skin and cloth. */
function prepareAvatarMaterials(scene: THREE.Object3D, info: AvatarInfo) {
  scene.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (!m.isSkinnedMesh) return;
    const mat = m.material as THREE.MeshStandardMaterial;
    if (mat.userData.rlt) return;
    mat.userData.rlt = true;
    if (mat.name === 'rb-hair') {
      mat.alphaTest = 0.5;
      mat.transparent = false;
      mat.side = THREE.DoubleSide;
      // cards seen edge-on catch Fresnel env reflections as pale stripes: keep hair rough and dim in the env
      mat.roughness = 0.8;
      mat.envMapIntensity = 0.35;
      mat.userData.hair = true;
    } else {
      mat.envMapIntensity = 0.85;
      if (mat.normalMap) mat.normalScale.set(1, 1);
    }
    mat.name = `${mat.name}:${info.id}`;
  });
}

export function findBodyMesh(root: THREE.Object3D): THREE.SkinnedMesh {
  let best: THREE.SkinnedMesh | null = null;
  root.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (m.isSkinnedMesh && (!best || m.geometry.getAttribute('position').count > best.geometry.getAttribute('position').count)) best = m;
  });
  if (!best) throw new Error('no skinned body mesh');
  return best;
}

// ── rigs ──────────────────────────────────────────────────────────────────────────────────────────
/** Rest pose of a skeleton in model space (the glTF scene's frame), bones parent-first. */
interface RestRig {
  names: string[];
  index: Map<string, number>;
  parent: number[];
  localQ: THREE.Quaternion[];
  localP: THREE.Vector3[];
  worldQ: THREE.Quaternion[];
  worldP: THREE.Vector3[];
  /** Model-space transform of the top bone's parent (Armature / Bip01 / …). */
  baseM: THREE.Matrix4;
  baseQ: THREE.Quaternion;
  hips: number;
}

function restRig(scene: THREE.Object3D): RestRig {
  scene.updateMatrixWorld(true);
  const sceneInv = scene.matrixWorld.clone().invert();
  const skin = findBodyMesh(scene);
  const boneSet = new Set<THREE.Object3D>(skin.skeleton.bones);
  // the UAL rig has a ground 'root' joint above the pelvis; Rocketbox's top joint is the pelvis itself
  const top = skin.skeleton.bones.find((b) => !boneSet.has(b.parent!))!;
  const names: string[] = [], parent: number[] = [], localQ: THREE.Quaternion[] = [], localP: THREE.Vector3[] = [];
  const worldQ: THREE.Quaternion[] = [], worldP: THREE.Vector3[] = [];
  const m = new THREE.Matrix4(), s = new THREE.Vector3();
  const visit = (o: THREE.Object3D, p: number) => {
    const i = names.length;
    names.push(o.name);
    parent.push(p);
    localQ.push(o.quaternion.clone());
    localP.push(o.position.clone());
    m.multiplyMatrices(sceneInv, o.matrixWorld);
    const wp = new THREE.Vector3(), wq = new THREE.Quaternion();
    m.decompose(wp, wq, s);
    worldQ.push(wq);
    worldP.push(wp);
    for (const c of o.children) if (boneSet.has(c)) visit(c, i);
  };
  visit(top, -1);
  const baseM = new THREE.Matrix4().multiplyMatrices(sceneInv, top.parent!.matrixWorld);
  const baseQ = new THREE.Quaternion();
  baseM.decompose(new THREE.Vector3(), baseQ, s);
  const index = new Map(names.map((n, i) => [n, i] as const));
  const hips = index.get('pelvis');
  if (hips === undefined) throw new Error('rig without pelvis');
  return { names, index, parent, localQ, localP, worldQ, worldP, baseM, baseQ, hips };
}

function measure(r: RestRig): BodyMetrics {
  const p = (n: string) => r.worldP[r.index.get(n) ?? r.hips];
  return {
    ankleY: p('foot_l').y,
    kneeY: p('calf_l').y,
    hipY: p('thigh_l').y,
    waistY: p('pelvis').y + 0.105,
    chestY: p('spine_03').y,
    neckY: p('neck_01').y,
    headY: p('Head').y,
    shoulderX: Math.abs(p('upperarm_l').x),
    thighX: Math.abs(p('thigh_l').x),
    elbowX: Math.abs(p('lowerarm_l').x),
    wristX: Math.abs(p('hand_l').x),
    pelvisY: p('pelvis').y,
  };
}

/** Hand the main thread back (a message-channel task: unlike timers it is not throttled in background tabs). */
function yieldTask(): Promise<void> {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => resolve();
    ch.port2.postMessage(0);
  });
}

/** Time slices for long loops: `if (s.over()) await s.next()` hands the main thread back every `ms`. */
class Slicer {
  private t = performance.now();
  constructor(private ms: number) {}
  over(): boolean {
    return performance.now() - this.t > this.ms;
  }
  async next() {
    await yieldTask();
    this.t = performance.now();
  }
}

/** Retargeting all clips onto a body takes a few hundred ms (one long clip alone 50+ ms): done in slices of ~12 ms,
 *  between keys, so entering a house with new people never freezes the page (they appear once their body is ready). */
async function makeEntry(id: string, kind: BodyEntry['kind'], scene: THREE.Object3D, src: RestRig, rawClips: THREE.AnimationClip[]): Promise<BodyEntry> {
  const dst = restRig(scene);
  const corr = corrections(src, dst);
  const clips = new Map<string, ClipInfo>();
  const slice = new Slicer(12);
  for (const raw of rawClips) {
    clips.set(raw.name, await retargetClip(raw, src, dst, corr, slice));
    if (slice.over()) await slice.next();
  }
  const sockets = new Map<string, THREE.Quaternion>();
  for (const name of ['hand_l', 'hand_r', 'Head']) {
    const i = dst.index.get(name);
    if (i !== undefined && corr.c[i]) sockets.set(name, corr.c[i]!.clone().invert());
  }
  return { id, kind, scene, metrics: measure(dst), clips, sockets };
}

interface Corrections {
  /** dst bone → src bone index (undefined: not driven). */
  map: (number | undefined)[];
  /** C = R_src⁻¹ · S · R_dst per driven dst bone. */
  c: (THREE.Quaternion | undefined)[];
  /** Hips path scale (leg length ratio) and vertical lift so rest ankles coincide. */
  ratio: number;
  lift: number;
}

function corrections(src: RestRig, dst: RestRig): Corrections {
  const map = dst.names.map((n) => src.index.get(n));
  const a = new THREE.Vector3(), b = new THREE.Vector3(), sw = new THREE.Quaternion();
  const c = dst.names.map((name, i) => {
    const si = map[i];
    if (si === undefined) return undefined;
    sw.identity();
    const child = DIR_CHILD[name];
    const dc = child !== undefined ? dst.index.get(child) : undefined;
    const sc = child !== undefined ? src.index.get(child) : undefined;
    if (dc !== undefined && sc !== undefined) {
      a.subVectors(dst.worldP[dc], dst.worldP[i]).normalize();
      b.subVectors(src.worldP[sc], src.worldP[si]).normalize();
      if (a.lengthSq() > 0.5 && b.lengthSq() > 0.5) sw.setFromUnitVectors(a, b);
    }
    return src.worldQ[si].clone().invert().multiply(sw).multiply(dst.worldQ[i]);
  });
  const foot = (r: RestRig) => r.worldP[r.index.get('foot_l')!].y;
  const ratio = (dst.worldP[dst.hips].y - foot(dst)) / (src.worldP[src.hips].y - foot(src));
  return { map, c, ratio, lift: foot(dst) - foot(src) * ratio };
}

/**
 * UAL's idles are game "ready" stances (wide feet, bent knees, fists, boxer arms). For a life-sim they are
 * relaxed at retarget time: `fingers` keeps that share of the finger curl, `arms` blends the arms toward
 * hanging at the sides, `legs` narrows the stance and lifts the hips (constant per clip, so breathing stays)
 * with two-bone leg IK that keeps the feet flat where they were authored.
 */
const RELAX: Record<string, { fingers?: number; arms?: number; legs?: boolean }> = {
  Idle_Loop: { fingers: 0.3, arms: 0.75, legs: true },
  Idle_No_Loop: { fingers: 0.35, arms: 0.35, legs: true },
  Idle_Talking_Loop: { fingers: 0.55, legs: true },
  Idle_FoldArms_Loop: { legs: true },
  Idle_TalkingPhone_Loop: { legs: true },
  Consume: { legs: true },
  Yes: { fingers: 0.5, legs: true },
  Interact: { fingers: 0.6, legs: true },
  Walk_Loop: { fingers: 0.35 },
  Walk_Formal_Loop: { fingers: 0.45 },
  Sitting_Idle_Loop: { fingers: 0.45 },
  Sitting_Talking_Loop: { fingers: 0.7 },
  Sitting_Enter: { fingers: 0.5 },
  Sitting_Exit: { fingers: 0.5 },
};
const FINGER = /^(thumb|index|middle|ring|pinky)_0\d_[lr]$/;

/**
 * UAL's walks are a stylised game gait: the stance knee never straightens (≈27° on average, hips at 0.95 of the
 * leg), the swing knee folds to ≈88° and the swing foot hangs toes-down, so on realistic bodies they read as a
 * crouched tiptoe. At retarget time the hips are lifted per key (smoothed around the loop) until the stance knee
 * is at most `knee[0]° + knee[1]·authored`, the legs are IK'd back onto the authored ankle path (feet keep their
 * plants), the swing ankle's height above its plant is scaled by `swing`, and `toe` of the swing foot's extra
 * toe-down pitch is taken out. Weights are 0 while the ball touches the floor, so heel-off / toe-off are kept.
 */
const GAIT: Record<string, { knee: [number, number]; swing: number; toe: number }> = {
  Walk_Loop: { knee: [6, 0.25], swing: 0.65, toe: 0.6 },
  Walk_Formal_Loop: { knee: [6, 0.25], swing: 0.65, toe: 0.6 },
};
/** Longest hip→ankle distance the gait lift may ask of either leg (fraction of thigh + shin). */
const GAIT_REACH = 0.995;

const _u = new THREE.Vector3(), _w = new THREE.Vector3(), _x = new THREE.Vector3(), _sw = new THREE.Quaternion(), _sw2 = new THREE.Quaternion();
const _id = new THREE.Quaternion();

async function retargetClip(raw: THREE.AnimationClip, src: RestRig, dst: RestRig, corr: Corrections, slice: Slicer): Promise<ClipInfo> {
  const qTrack = new Map<number, THREE.Interpolant>();
  const pTrack = new Map<number, THREE.Interpolant>();
  const timeSet = new Set<number>();
  for (const t of raw.tracks) {
    const dot = t.name.lastIndexOf('.');
    const i = src.index.get(t.name.slice(0, dot));
    if (i === undefined) continue;
    const prop = t.name.slice(dot + 1);
    if (prop === 'quaternion') qTrack.set(i, (t as THREE.QuaternionKeyframeTrack).InterpolantFactoryMethodLinear(new Float32Array(4)));
    else if (prop === 'position') pTrack.set(i, (t as THREE.VectorKeyframeTrack).InterpolantFactoryMethodLinear(new Float32Array(3)));
    else continue;
    for (const x of t.times) timeSet.add(Math.round(x * 1e4) / 1e4);
  }
  const times = [...timeSet].sort((x, y) => x - y);
  if (!times.length) times.push(0);
  const nk = times.length, nd = dst.names.length, ns = src.names.length;
  const relax = RELAX[raw.name] ?? {};
  const fingerKeep = src.names.map((n) => (relax.fingers !== undefined && FINGER.test(n) ? relax.fingers : 1));
  const outQ = dst.names.map(() => new Float32Array(nk * 4));
  const outHips = new Float32Array(nk * 3);
  const hipsModel: THREE.Vector3[] = [];
  const sQ = src.names.map(() => new THREE.Quaternion()), sP = src.names.map(() => new THREE.Vector3());
  const dQ = dst.names.map(() => new THREE.Quaternion()), dP = dst.names.map(() => new THREE.Vector3());
  const lq = new THREE.Quaternion(), lp = new THREE.Vector3(), inv = new THREE.Quaternion();
  const baseSP = new THREE.Vector3().setFromMatrixPosition(src.baseM), baseDP = new THREE.Vector3().setFromMatrixPosition(dst.baseM);
  const loco = LOCOMOTION.has(raw.name);
  const ball = dst.index.get('ball_l');
  const footTrack: { y: number; z: number }[] = [];
  const ankleL = dst.index.get('foot_l'), ankleR = dst.index.get('foot_r');
  const feetL = new Float32Array(nk * 3), feetR = new Float32Array(nk * 3);
  const ix = (n: string) => dst.index.get(n);
  const legs = relax.legs ? (['l', 'r'] as const).map((s) => ({ t: ix(`thigh_${s}`), c: ix(`calf_${s}`), f: ix(`foot_${s}`) })) : [];
  const arms = relax.arms ? (['l', 'r'] as const).map((s) => ({ side: s === 'l' ? 1 : -1, u: ix(`upperarm_${s}`), l: ix(`lowerarm_${s}`), h: ix(`hand_${s}`) })) : [];
  const desc = (i: number | undefined) => {
    const out: number[] = [];
    if (i === undefined) return out;
    for (let j = i + 1; j < nd; j++) {
      let p = dst.parent[j];
      while (p > i) p = dst.parent[p];
      if (p === i) out.push(j);
    }
    return out;
  };
  const handKids = arms.map((a) => [a.h!, ...desc(a.h)].filter((x) => x !== undefined));

  /** Pose key k: source FK, then destination world rotations and FK positions (hips at the scaled path). */
  const evaluate = (k: number, lift: number): THREE.Vector3 => {
    const t = times[k];
    for (let i = 0; i < ns; i++) {
      const qi = qTrack.get(i), pi = pTrack.get(i);
      lq.copy(qi ? lq.fromArray(qi.evaluate(t)).normalize() : src.localQ[i]);
      if (fingerKeep[i] < 1) lq.copy(_sw.copy(src.localQ[i]).slerp(lq, fingerKeep[i]));
      lp.copy(pi ? lp.fromArray(pi.evaluate(t)) : src.localP[i]);
      const p = src.parent[i];
      const pq = p < 0 ? src.baseQ : sQ[p];
      sP[i].copy(lp).applyQuaternion(pq).add(p < 0 ? baseSP : sP[p]);
      sQ[i].copy(pq).multiply(lq);
    }
    // hips target in model space: scaled path, lifted so the rest ankles coincide
    const hips = sP[src.hips].clone().multiplyScalar(corr.ratio);
    hips.y += corr.lift + lift;
    for (let i = 0; i < nd; i++) {
      const p = dst.parent[i];
      const pq = p < 0 ? dst.baseQ : dQ[p];
      const si = corr.map[i];
      if (si === undefined) dQ[i].copy(pq).multiply(dst.localQ[i]);
      else dQ[i].copy(sQ[si]).multiply(corr.c[i]!);
      if (i === dst.hips) dP[i].copy(hips);
      else dP[i].copy(dst.localP[i]).applyQuaternion(pq).add(p < 0 ? baseDP : dP[p]);
    }
    return hips;
  };

  // legs: one hip lift for the whole clip, as much as the straightest key allows
  let lift = 0;
  const narrowed = (foot: THREE.Vector3, hips: THREE.Vector3, out: THREE.Vector3) => {
    const dx = foot.x - hips.x;
    return out.set(hips.x + Math.sign(dx) * Math.max(0.075, Math.abs(dx) * 0.6), foot.y, foot.z);
  };
  if (legs.length && legs.every((l) => l.t !== undefined && l.c !== undefined && l.f !== undefined)) {
    lift = 0.07;
    for (let k = 0; k < nk; k++) {
      if (slice.over()) await slice.next(); // (no scratch value lives across a key: safe to interleave clips)
      const hips = evaluate(k, 0);
      for (const l of legs) {
        const L = dP[l.c!].distanceTo(dP[l.t!]) + dP[l.f!].distanceTo(dP[l.c!]);
        const a = narrowed(dP[l.f!], hips, _x);
        const dx = a.x - dP[l.t!].x, dz = a.z - dP[l.t!].z, reach = (0.985 * L) ** 2 - dx * dx - dz * dz;
        lift = Math.min(lift, reach > 0 ? Math.sqrt(reach) - (dP[l.t!].y - a.y) : 0);
      }
    }
    lift = Math.max(0, lift);
  }

  // walks: per-key lift that straightens the stance knee (GAIT)
  const gait = GAIT[raw.name];
  const gaitLegs = gait
    ? (['l', 'r'] as const).map((s) => ({ t: ix(`thigh_${s}`), c: ix(`calf_${s}`), f: ix(`foot_${s}`), b: ix(`ball_${s}`) }))
      .filter((l): l is { t: number; c: number; f: number; b: number } => l.t !== undefined && l.c !== undefined && l.f !== undefined && l.b !== undefined)
    : [];
  const gLift = new Float32Array(nk);
  const ankMin: number[] = [], ballMin: number[] = [], toeKids: number[][] = [];
  let restPitch = 0;
  if (gait && gaitLegs.length === 2 && nk > 2) {
    const caps = new Float32Array(nk), want = new Float32Array(nk);
    gaitLegs.forEach((l, i) => { ankMin[i] = Infinity; ballMin[i] = Infinity; toeKids[i] = desc(l.f); });
    const rf = dst.worldP[gaitLegs[0].f], rb = dst.worldP[gaitLegs[0].b];
    restPitch = Math.atan2(-(rb.y - rf.y), rb.z - rf.z);
    for (let k = 0; k < nk; k++) {
      if (slice.over()) await slice.next();
      evaluate(k, 0);
      let cap = Infinity, stance = -1, stanceY = Infinity;
      const legInfo = gaitLegs.map((l, i) => {
        const T = dP[l.t], K = dP[l.c], A = dP[l.f];
        ankMin[i] = Math.min(ankMin[i], A.y);
        ballMin[i] = Math.min(ballMin[i], dP[l.b].y);
        const l1 = K.distanceTo(T), l2 = A.distanceTo(K);
        const h2 = (A.x - T.x) ** 2 + (A.z - T.z) ** 2, dy = T.y - A.y;
        const dmax = GAIT_REACH * (l1 + l2);
        cap = Math.min(cap, dmax * dmax > h2 ? Math.sqrt(dmax * dmax - h2) - dy : 0);
        if (A.y < stanceY) { stanceY = A.y; stance = i; }
        return { knee: _u.subVectors(K, T).angleTo(_w.subVectors(A, K)), l1, l2, h2, dy };
      });
      const st = legInfo[stance];
      const kt = Math.min(st.knee, THREE.MathUtils.degToRad(gait.knee[0]) + gait.knee[1] * st.knee);
      const d2 = st.l1 * st.l1 + st.l2 * st.l2 + 2 * st.l1 * st.l2 * Math.cos(kt);
      want[k] = d2 > st.h2 ? Math.sqrt(d2 - st.h2) - st.dy : 0;
      caps[k] = Math.max(0, cap);
    }
    // smooth around the loop (the last key repeats the first), then keep every key within reach
    const n = nk - 1;
    for (let k = 0; k < n; k++) {
      let s = 0, ws = 0;
      for (let j = -2; j <= 2; j++) {
        const m = (k + j + n) % n, wj = Math.exp(-(j * j) / 2);
        s += Math.max(0, Math.min(want[m], caps[m])) * wj;
        ws += wj;
      }
      gLift[k] = Math.max(0, Math.min(s / ws, caps[k]));
    }
    gLift[n] = Math.min(gLift[0], caps[n]);
  }

  for (let k = 0; k < nk; k++) {
    if (slice.over()) await slice.next();
    const hips = evaluate(k, lift + gLift[k]);
    hipsModel.push(hips);
    if (gLift[k] > 0) {
      gaitLegs.forEach((l, i) => {
        // the authored ankle (before the lift); fresh vector: legIK reuses the scratch vectors
        const target = new THREE.Vector3(dP[l.f].x, dP[l.f].y - gLift[k], dP[l.f].z);
        const w = THREE.MathUtils.smoothstep(dP[l.b].y - gLift[k] - ballMin[i], 0.02, 0.08);
        if (w > 0) {
          // swing: a lower foot, and toes less pointed (signed sagittal pitch; the body faces +Z)
          target.y -= w * (1 - gait!.swing) * Math.max(0, target.y - ankMin[i]);
          const rel = Math.atan2(-(dP[l.b].y - dP[l.f].y), dP[l.b].z - dP[l.f].z) - restPitch;
          if (rel > 0) {
            _sw.setFromAxisAngle(_x.set(1, 0, 0), -rel * gait!.toe * w);
            dQ[l.f].premultiply(_sw);
            for (const j of toeKids[i]) dQ[j].premultiply(_sw);
          }
        }
        legIK(dQ, dP, l.t, l.c, l.f, target);
        // the toes follow the moved foot (footTrack / plantSpeed read the ball)
        for (const j of toeKids[i]) dP[j].copy(dst.localP[j]).applyQuaternion(dQ[dst.parent[j]]).add(dP[dst.parent[j]]);
      });
    }
    if (lift > 0 || legs.length) {
      for (const l of legs) {
        if (l.t === undefined || l.c === undefined || l.f === undefined) continue;
        // the ankle before the lift, pulled toward the midline
        const target = narrowed(_x.copy(dP[l.f]).setY(dP[l.f].y - lift), hips, new THREE.Vector3());
        legIK(dQ, dP, l.t, l.c, l.f, target);
      }
    }
    arms.forEach((a, n) => {
      if (a.u === undefined || a.l === undefined || a.h === undefined) return;
      hangArm(dQ, dP, a.u, a.l, a.h, a.side, relax.arms!, handKids[n]);
    });
    for (let i = 0; i < nd; i++) {
      const p = dst.parent[i];
      const pq = p < 0 ? dst.baseQ : dQ[p];
      inv.copy(pq).invert();
      lq.copy(inv).multiply(dQ[i]);
      lq.toArray(outQ[i], k * 4);
      if (i === dst.hips) {
        // local position that puts the hips at `hips` under the (possibly animated) parent
        const pp = p < 0 ? baseDP : dP[p];
        lp.subVectors(hips, pp).applyQuaternion(inv);
        lp.toArray(outHips, k * 3);
      }
    }
    if (loco && ball !== undefined) footTrack.push({ y: dP[ball].y, z: dP[ball].z });
    if (loco && ankleL !== undefined && ankleR !== undefined) {
      dP[ankleL].toArray(feetL, k * 3);
      dP[ankleR].toArray(feetR, k * 3);
    }
  }

  const tracks: THREE.KeyframeTrack[] = [];
  for (let i = 0; i < nd; i++) {
    if (corr.map[i] === undefined) continue;
    tracks.push(new THREE.QuaternionKeyframeTrack(`${dst.names[i]}.quaternion`, times, outQ[i]));
  }
  tracks.push(new THREE.VectorKeyframeTrack(`${dst.names[dst.hips]}.position`, times, outHips));
  const clip = new THREE.AnimationClip(raw.name, raw.duration, tracks);
  const off = (v: THREE.Vector3) => new THREE.Vector2(v.x, v.z);
  const mean = new THREE.Vector2();
  for (const h of hipsModel) mean.add(off(h));
  mean.divideScalar(hipsModel.length);
  const info: ClipInfo = { clip, offStart: off(hipsModel[0]), offEnd: off(hipsModel[nk - 1]), offMean: mean, pelvisYStart: hipsModel[0].y };
  if (loco && footTrack.length > 4) info.speed = plantSpeed(footTrack, times);
  if (loco && ankleL !== undefined && ankleR !== undefined) {
    let minY = Infinity;
    for (let k = 0; k < nk; k++) minY = Math.min(minY, feetL[k * 3 + 1], feetR[k * 3 + 1]);
    info.feet = { times, l: feetL, r: feetR, minY };
  }
  return info;
}

/** Two-bone IK on world rotations: thigh/calf re-aimed so the ankle reaches `target`, knee kept in its plane,
 *  foot world rotation untouched (stays flat). Updates dP for the calf and foot. */
function legIK(dQ: THREE.Quaternion[], dP: THREE.Vector3[], t: number, c: number, f: number, target: THREE.Vector3) {
  const T = dP[t], K = dP[c], A = dP[f];
  const l1 = K.distanceTo(T), l2 = A.distanceTo(K);
  const dir = _u.subVectors(target, T);
  const d = THREE.MathUtils.clamp(dir.length(), Math.abs(l1 - l2) + 1e-3, (l1 + l2) * 0.999);
  dir.normalize();
  // pole: where the knee points now, perpendicular to the hip→ankle line
  const pole = _w.subVectors(K, T);
  pole.addScaledVector(dir, -pole.dot(dir));
  if (pole.lengthSq() < 1e-8) pole.set(0, 0, 1);
  pole.normalize();
  const cosA = (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d);
  const knee = new THREE.Vector3().copy(T).addScaledVector(dir, l1 * cosA).addScaledVector(pole, l1 * Math.sqrt(Math.max(0, 1 - cosA * cosA)));
  _sw.setFromUnitVectors(_x.subVectors(K, T).normalize(), _u.subVectors(knee, T).normalize());
  dQ[t].premultiply(_sw);
  const shin = _x.subVectors(A, K).applyQuaternion(_sw).normalize();
  const end = new THREE.Vector3().copy(knee).addScaledVector(_u.subVectors(target, knee).normalize(), l2);
  _sw2.setFromUnitVectors(shin, _u.subVectors(end, knee).normalize()).multiply(_sw);
  dQ[c].premultiply(_sw2);
  K.copy(knee);
  A.copy(end);
}

/** Blend an arm toward hanging relaxed at the side (upper arm down and a touch out, elbow slightly bent);
 *  the hand and fingers follow the forearm rigidly. */
function hangArm(dQ: THREE.Quaternion[], dP: THREE.Vector3[], u: number, l: number, h: number, side: number, w: number, kids: number[]) {
  const S = dP[u], E = dP[l], W = dP[h];
  _u.subVectors(E, S).normalize();
  _sw.setFromUnitVectors(_u, _w.set(side * 0.13, -1, 0.04).normalize());
  _sw.copy(_id).slerp(_sw, w);
  dQ[u].premultiply(_sw);
  const elbow = new THREE.Vector3().subVectors(E, S).applyQuaternion(_sw).add(S);
  const fore = new THREE.Vector3().subVectors(W, E);
  const lower = fore.length();
  _x.copy(fore).applyQuaternion(_sw).normalize();
  _sw2.setFromUnitVectors(_x, _w.set(side * 0.05, -1, 0.3).normalize());
  _sw2.copy(_id).slerp(_sw2, w).multiply(_sw);
  dQ[l].premultiply(_sw2);
  for (const k of kids) dQ[k].premultiply(_sw2);
  E.copy(elbow);
  W.copy(elbow).addScaledVector(fore.applyQuaternion(_sw2).normalize(), lower);
}

/** In-place locomotion: how fast the planted foot slides backward (= ground speed the clip was authored for).
 *  The median over planted keys: the toe-off skid at the end of each plant would drag a plain average down
 *  (the clip then plays too fast for the ground speed and the planted foot skates). */
function plantSpeed(foot: { y: number; z: number }[], times: number[]): number {
  const minY = Math.min(...foot.map((f) => f.y));
  const v: number[] = [];
  for (let k = 1; k < foot.length; k++) {
    const dt = times[k] - times[k - 1];
    if (dt > 0 && foot[k].y < minY + 0.025 && foot[k - 1].y < minY + 0.025) v.push((foot[k - 1].z - foot[k].z) / dt);
  }
  if (!v.length) return 0;
  v.sort((a, b) => a - b);
  const m = v.length >> 1;
  return Math.max(0.2, v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2);
}
