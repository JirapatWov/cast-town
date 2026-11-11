// Every tree and shrub in town, instanced per (species variant × level of detail). Instances are re-binned by
// distance to the camera when it moves: LOD0 (full branches + every sprig card) close up, LOD1 (main branches,
// a sixth of the cards, enlarged) in the middle distance, and a far LOD of a few dense "clump" cards from an atlas.
// Town trees cast shadows at every LOD (alpha-tested, so the shade is dappled); the countryside forest only casts
// from LOD0/LOD1. Wind sways crowns and flutters cards (the shadow passes sway with them).
import * as THREE from 'three';
import type { Assets, Quality } from '../../core/types';
import type { TreeDisc } from '../ground';
import { buildFarGeometry, buildTreeGeometries, growTree } from './generator';
import { barkDepthMaterial, barkMaterial, type BarkType, leafDepthMaterial, leafMaterial, type LeafType, WIND } from './materials';
import { SPECIES, type SpeciesDef, type SpeciesId } from './species';

const TEX = '/assets/textures/trees';

/** LOD switch distances (m) per quality: [LOD0→LOD1, LOD1→far]. Shrubs use half. */
const LOD_DIST: Record<Quality, [number, number]> = {
  low: [0, 40],
  medium: [24, 85],
  high: [38, 130],
  ultra: [65, 220],
};

interface Variant {
  def: SpeciesDef;
  lod0: { bark: THREE.BufferGeometry; leaves: THREE.BufferGeometry };
  lod1: { bark: THREE.BufferGeometry; leaves: THREE.BufferGeometry };
  far: THREE.BufferGeometry;
}

interface Inst {
  variant: number;
  matrix: THREE.Matrix4;
  tint: THREE.Color;
  bark: THREE.Color;
  cast: boolean;
  owner: string | null;
  x: number;
  y: number;
  z: number;
  /** Visual size (m), for LOD distance scaling. */
  size: number;
  lod: number;
}

type Slot = 'b0' | 'l0' | 'b1' | 'l1' | 'f' | 'fn';

const yieldTask = () => new Promise<void>((r) => setTimeout(r, 0));

export interface AddTreeOpts {
  /** Tint multiplier on the leaves (autumn, health variation). */
  tint?: THREE.Color;
  cast?: boolean;
  /** Group key so a building's garden can be removed with it. */
  owner?: string;
  rotY?: number;
}

export class TreeSystem {
  readonly group = new THREE.Group();
  private variants: Variant[] = [];
  private bySpecies = new Map<SpeciesId, number[]>();
  /** Variant index → the first variant of its species. */
  private first: number[] = [];
  private insts: Inst[] = [];
  private meshes = new Map<string, THREE.InstancedMesh>();
  private leafMats = new Map<LeafType, THREE.MeshStandardMaterial>();
  private leafDepth = new Map<LeafType, THREE.MeshDepthMaterial>();
  private barkMats = new Map<BarkType, THREE.MeshStandardMaterial>();
  private barkDepth = barkDepthMaterial();
  private farMat: THREE.MeshStandardMaterial;
  private farDepth: THREE.MeshDepthMaterial;
  private tex: (name: string, srgb: boolean) => THREE.Texture;
  private frustum = new THREE.Frustum();
  private projView = new THREE.Matrix4();
  private lastDir = new THREE.Vector3();
  private dir = new THREE.Vector3();
  private lastCam = new THREE.Vector3(Infinity, 0, 0);
  private lastQuality: Quality | null = null;
  private dirty = true;
  private sinceBin = 0;

  private constructor(assets: Assets, private quality: () => Quality) {
    this.group.name = 'trees';
    this.tex = (name: string, srgb: boolean) => {
      const t = assets.texture(`${TEX}/${name}`, { srgb });
      t.anisotropy = 4;
      return t;
    };
    const atlas = this.tex('far_atlas.webp', true);
    atlas.wrapS = atlas.wrapT = THREE.RepeatWrapping;
    this.farMat = leafMaterial({ name: 'trees-far', map: atlas, trunkFlag: true, translucency: 0.22, alphaTest: 0.4, roughness: 0.85 });
    this.farDepth = leafDepthMaterial(atlas, 0.4);
  }

  /** Grows every species variant, yielding between steps (a variant takes 20–90 ms; all at once would stall). */
  static async create(assets: Assets, quality: () => Quality): Promise<TreeSystem> {
    const ts = new TreeSystem(assets, quality);
    for (const [id, def] of Object.entries(SPECIES) as [SpeciesId, SpeciesDef][]) {
      const list: number[] = [];
      for (let i = 0; i < def.variants.length; i++) {
        const p = def.variants[i];
        await yieldTask();
        const raw = growTree(p);
        const seed = p.seed + i * 101;
        await yieldTask();
        const l0 = buildTreeGeometries(raw, def.height, def.lod0, seed);
        await yieldTask();
        const l1 = buildTreeGeometries(raw, def.height, def.lod1, seed);
        ts.first.push(list.length ? list[0] : ts.variants.length);
        list.push(ts.variants.length);
        ts.variants.push({
          def,
          lod0: { bark: l0.bark, leaves: l0.leaves },
          lod1: { bark: l1.bark, leaves: l1.leaves },
          far: buildFarGeometry(raw, def.height, def.far.tile, def.far.clusters, def.far.size, seed),
        });
      }
      ts.bySpecies.set(id, list);
      if (!ts.leafMats.has(def.leaf)) {
        const map = ts.tex(`leaves_${def.leaf}.webp`, true);
        map.wrapS = map.wrapT = THREE.ClampToEdgeWrapping;
        ts.leafMats.set(def.leaf, leafMaterial({ name: `leaves-${def.leaf}`, map, translucency: def.translucency }));
        ts.leafDepth.set(def.leaf, leafDepthMaterial(map));
      }
      if (!ts.barkMats.has(def.bark)) {
        ts.barkMats.set(def.bark, barkMaterial(`bark-${def.bark}`, ts.tex(`bark_${def.bark}_color.webp`, true), ts.tex(`bark_${def.bark}_normal.webp`, false)));
      }
    }
    return ts;
  }

  /** Leaf colour per species is applied per instance; this is the species' base multiplier. */
  private baseTint(def: SpeciesDef): THREE.Color {
    return new THREE.Color(...def.leafColor);
  }

  add(species: SpeciesId, x: number, y: number, z: number, scale: number, rnd: () => number, opts: AddTreeOpts = {}): void {
    const list = this.bySpecies.get(species)!;
    const variant = list[Math.floor(rnd() * list.length) % list.length];
    const def = this.variants[variant].def;
    const rot = opts.rotY ?? rnd() * Math.PI * 2;
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(x, y, z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler((rnd() - 0.5) * 0.05, rot, (rnd() - 0.5) * 0.05)),
      new THREE.Vector3(scale, scale * (0.92 + rnd() * 0.16), scale),
    );
    const tint = this.baseTint(def);
    tint.offsetHSL((rnd() - 0.5) * 0.03, (rnd() - 0.5) * 0.12, (rnd() - 0.5) * 0.06);
    if (opts.tint) tint.multiply(opts.tint);
    const bark = new THREE.Color(1, 1, 1).multiplyScalar(0.85 + rnd() * 0.25);
    this.insts.push({
      variant, matrix: m, tint, bark, cast: opts.cast ?? true, owner: opts.owner ?? null, x, y: y + def.height * scale * 0.5, z,
      size: def.height * scale, lod: -1,
    });
    this.dirty = true;
  }

  removeOwner(owner: string): void {
    this.insts = this.insts.filter((it) => it.owner !== owner);
    this.dirty = true;
  }

  private mesh(slot: Slot, variant: number, need: number): THREE.InstancedMesh {
    const key = `${variant}:${slot}`;
    let im = this.meshes.get(key);
    if (im && im.instanceMatrix.count >= need) return im;
    const v = this.variants[variant];
    const cap = Math.max(16, Math.ceil(need * 1.5));
    const geo = slot === 'b0' ? v.lod0.bark : slot === 'l0' ? v.lod0.leaves : slot === 'b1' ? v.lod1.bark : slot === 'l1' ? v.lod1.leaves : v.far;
    const leafy = slot === 'l0' || slot === 'l1';
    const barky = slot === 'b0' || slot === 'b1';
    const mat = leafy ? this.leafMats.get(v.def.leaf)! : barky ? this.barkMats.get(v.def.bark)! : this.farMat;
    const next = new THREE.InstancedMesh(geo, mat, cap);
    next.name = `trees:${v.def.id}${variant}:${slot}`;
    next.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    next.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    next.instanceColor.setUsage(THREE.DynamicDrawUsage);
    next.castShadow = slot !== 'fn';
    next.receiveShadow = true;
    next.customDepthMaterial = leafy ? this.leafDepth.get(v.def.leaf)! : barky ? this.barkDepth : this.farDepth;
    next.count = 0;
    next.frustumCulled = false;
    if (im) {
      this.group.remove(im);
      im.dispose();
    }
    this.meshes.set(key, next);
    this.group.add(next);
    return next;
  }

  /**
   * Re-bin instances by camera distance (only when the camera moved or turned, the quality changed or trees were
   * added). Trees outside the view use the far LOD: they still cast their shadow into it, at ~70 triangles.
   */
  update(camera: THREE.Camera, dt: number, t: number): void {
    WIND.uTime.value = t;
    this.sinceBin += dt;
    const q = this.quality();
    camera.getWorldDirection(this.dir);
    const moved = camera.position.distanceToSquared(this.lastCam);
    const turned = this.dir.dot(this.lastDir) < 0.995;
    if (!this.dirty && q === this.lastQuality && !turned && (moved < 2.25 || (moved < 36 && this.sinceBin < 0.25))) return;
    this.dirty = false;
    this.lastQuality = q;
    this.sinceBin = 0;
    this.lastCam.copy(camera.position);
    this.lastDir.copy(this.dir);
    camera.updateMatrixWorld();
    this.frustum.setFromProjectionMatrix(this.projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const sphere = new THREE.Sphere();
    const [d0, d1] = LOD_DIST[q];
    const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;

    // Low draws every species with its first variant (fewer instanced meshes, so fewer draw calls), and far trees
    // skip the shadow pass (Low's shadow range barely reaches them)
    const low = q === 'low';
    // count per (variant, slot) first so meshes can be sized once
    const counts = new Map<string, number>();
    const bump = (k: string) => counts.set(k, (counts.get(k) ?? 0) + 1);
    for (const it of this.insts) {
      const k = THREE.MathUtils.clamp(it.size / 9, 0.35, 1.6);
      const dist = Math.hypot(it.x - cx, it.y - cy, it.z - cz) / k;
      // hysteresis: stay in the current LOD until 6 % past the boundary
      const h0 = it.lod === 0 ? d0 * 1.06 : d0 * 0.94, h1 = it.lod <= 1 ? d1 * 1.06 : d1 * 0.94;
      it.lod = dist < h0 ? 0 : dist < h1 ? 1 : 2;
      if (it.lod < 2) {
        sphere.center.set(it.x, it.y, it.z);
        sphere.radius = it.size * 0.75 + 2;
        if (!this.frustum.intersectsSphere(sphere)) it.lod = 2;
      }
      const v = low ? this.first[it.variant] : it.variant;
      if (it.lod === 0) { bump(`${v}:b0`); bump(`${v}:l0`); }
      else if (it.lod === 1) { bump(`${v}:b1`); bump(`${v}:l1`); }
      else bump(`${v}:${it.cast && !low ? 'f' : 'fn'}`);
    }
    for (const im of this.meshes.values()) im.count = 0;
    const fill = new Map<string, THREE.InstancedMesh>();
    for (const [key, n] of counts) {
      const [vs, slot] = key.split(':');
      fill.set(key, this.mesh(slot as Slot, +vs, n));
    }
    const put = (key: string, it: Inst, color: THREE.Color) => {
      const im = fill.get(key)!;
      const i = im.count++;
      it.matrix.toArray(im.instanceMatrix.array as Float32Array, i * 16);
      color.toArray(im.instanceColor!.array as Float32Array, i * 3);
    };
    for (const it of this.insts) {
      const v = low ? this.first[it.variant] : it.variant;
      if (it.lod === 0) { put(`${v}:b0`, it, it.bark); put(`${v}:l0`, it, it.tint); }
      else if (it.lod === 1) { put(`${v}:b1`, it, it.bark); put(`${v}:l1`, it, it.tint); }
      else put(`${v}:${it.cast && !low ? 'f' : 'fn'}`, it, it.tint);
    }
    for (const im of this.meshes.values()) {
      im.visible = im.count > 0;
      if (!im.count) continue;
      im.instanceMatrix.clearUpdateRanges();
      im.instanceMatrix.addUpdateRange(0, im.count * 16);
      im.instanceMatrix.needsUpdate = true;
      im.instanceColor!.clearUpdateRanges();
      im.instanceColor!.addUpdateRange(0, im.count * 3);
      im.instanceColor!.needsUpdate = true;
    }
  }

  /** Crown footprints (ground occlusion map). */
  discs(): TreeDisc[] {
    const out: TreeDisc[] = [];
    for (const it of this.insts) out.push({ x: it.x, z: it.z, r: it.size * 0.46 });
    return out;
  }

  /** Triangles per LOD of each variant (dev stats). */
  stats(): Record<string, number[]> {
    const tri = (g: THREE.BufferGeometry) => (g.index ? g.index.count : g.getAttribute('position').count) / 3;
    const out: Record<string, number[]> = {};
    this.variants.forEach((v, i) => {
      out[`${v.def.id}${i}`] = [tri(v.lod0.bark) + tri(v.lod0.leaves), tri(v.lod1.bark) + tri(v.lod1.leaves), tri(v.far)];
    });
    return out;
  }
}

export { WIND } from './materials';
export type { SpeciesId } from './species';
