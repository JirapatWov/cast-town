// Asset loading + caching: glTF (meshopt), textures, PBR texture sets, equirect HDRs. Files are sized for the
// first visit (tools/assets/slim.mjs): WebP photo textures with 512 px phone copies, WebP inside the GLBs.
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import type { Assets, PbrSet } from '../core/types';
import { TEXTURE_CAP } from './quality';

const BASE = '/assets';

interface PbrSetDef {
  /** File prefix under /assets/textures. */
  prefix: string;
  /** 'ph' = Poly Haven (diff / nor_gl / arm), 'acg' = ambientCG (Color / NormalGL / Roughness / AmbientOcclusion). */
  kind: 'ph' | 'acg';
  /** Physical size of one texture tile in meters (for world-UV geometry). */
  tileMeters: number;
}

const PBR_SETS: Record<PbrSet, PbrSetDef> = {
  asphalt: { prefix: 'asphalt_02/asphalt_02', kind: 'ph', tileMeters: 4 },
  concrete: { prefix: 'concrete_pavement/concrete_pavement', kind: 'ph', tileMeters: 1.8 },
  paving: { prefix: 'acg_PavingStones150/PavingStones150_1K-JPG', kind: 'acg', tileMeters: 2 },
  grass: { prefix: 'acg_Grass004/Grass004_1K-JPG', kind: 'acg', tileMeters: 2.5 },
  brick: { prefix: 'red_brick_03/red_brick_03', kind: 'ph', tileMeters: 1.05 },
  plaster: { prefix: 'painted_plaster_wall/painted_plaster_wall', kind: 'ph', tileMeters: 3 },
  woodfloor: { prefix: 'acg_WoodFloor051/WoodFloor051_1K-JPG', kind: 'acg', tileMeters: 1.6 },
  laminate: { prefix: 'laminate_floor_02/laminate_floor_02', kind: 'ph', tileMeters: 1.6 },
  marble: { prefix: 'marble_01/marble_01', kind: 'ph', tileMeters: 1.5 },
};

/** Meters covered by one tile of a PBR set — use `1 / pbrTileMeters(set)` as repeat on world-UV geometry. */
export function pbrTileMeters(set: PbrSet): number {
  return PBR_SETS[set].tileMeters;
}

/** File names of a PBR set's maps (WebP, see tools/assets/slim.mjs), relative to /assets/textures. */
export function pbrFiles(set: PbrSet): { map: string; normal: string; arm?: string; roughness?: string; ao?: string } {
  const { prefix, kind } = PBR_SETS[set];
  return kind === 'ph'
    ? { map: `${prefix}_diff_1k.webp`, normal: `${prefix}_nor_gl_1k.webp`, arm: `${prefix}_arm_1k.webp` }
    : { map: `${prefix}_Color.webp`, normal: `${prefix}_NormalGL.webp`, roughness: `${prefix}_Roughness.webp`, ao: `${prefix}_AmbientOcclusion.webp` };
}

/** Photo textures with a 512 px copy in a `512/` folder beside them (every folder under textures/ but the tree
 *  sprites). Devices that cap textures at 512 load that copy instead of downloading 1k art and shrinking it. */
const SIZED = /^(.*\/assets\/textures\/(?!trees\/)(?:.+\/)?)([^/]+\.webp)$/;
export function sizedUrl(url: string, cap: number): string {
  if (cap > 512) return url;
  const m = SIZED.exec(url);
  return m && !m[1].endsWith('/512/') ? `${m[1]}512/${m[2]}` : url;
}

type Decoded = ImageBitmap | HTMLImageElement | HTMLCanvasElement;

/** A copy of `image` whose longer side is at most `cap`, or null when it already fits. */
async function shrunk(image: Decoded, cap: number): Promise<ImageBitmap | null> {
  const w = image.width, h = image.height;
  if (!w || !h || Math.max(w, h) <= cap) return null;
  const s = cap / Math.max(w, h);
  const nw = Math.max(1, Math.round(w * s)), nh = Math.max(1, Math.round(h * s));
  const opts: ImageBitmapOptions = { premultiplyAlpha: 'none', colorSpaceConversion: 'none' };
  try {
    const out = await createImageBitmap(image, { ...opts, resizeWidth: nw, resizeHeight: nh, resizeQuality: 'high' });
    if (out.width === nw && out.height === nh) return out;
    out.close(); // a browser that ignores the resize options
  } catch {
    /* fall back to a canvas */
  }
  const c = document.createElement('canvas');
  c.width = nw;
  c.height = nh;
  const g = c.getContext('2d');
  if (!g) return null;
  g.imageSmoothingQuality = 'high';
  g.drawImage(image, 0, 0, nw, nh);
  const out = await createImageBitmap(c, opts);
  c.width = c.height = 0; // iOS counts live canvas memory against a small budget
  return out;
}

/** Shrink every texture image of a loaded glTF to TEXTURE_CAP (once per shared image) and free the originals. */
async function capGltfTextures(gltf: GLTF): Promise<void> {
  const sources = new Map<THREE.Texture['source'], THREE.Texture[]>();
  gltf.scene.traverse((o) => {
    const mats = (o as THREE.Mesh).material;
    if (!mats) return;
    for (const m of Array.isArray(mats) ? mats : [mats]) {
      for (const v of Object.values(m)) {
        if (!(v as THREE.Texture | null)?.isTexture || !(v as THREE.Texture).source) continue;
        const t = v as THREE.Texture;
        if (!sources.has(t.source)) sources.set(t.source, []);
        sources.get(t.source)!.push(t);
      }
    }
  });
  await Promise.all(
    [...sources].map(async ([source, textures]) => {
      const image = source.data as Decoded | null;
      if (!image) return;
      const small = await shrunk(image, TEXTURE_CAP).catch(() => null);
      if (!small) return;
      source.data = small;
      for (const t of new Set(textures)) t.needsUpdate = true;
      if ('close' in image) image.close();
    }),
  );
}

export interface EngineAssets extends Assets {
  /** Anisotropy applied to newly created textures (follows quality). */
  setAnisotropy(n: number): void;
}

export function createAssets(): EngineAssets {
  const gltfLoader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const texLoader = new THREE.TextureLoader();
  const hdrLoader = new HDRLoader().setDataType(THREE.FloatType);

  const gltfCache = new Map<string, Promise<GLTF>>();
  const baseTextures = new Map<string, THREE.Texture>();
  const textureCache = new Map<string, THREE.Texture>();
  const hdrCache = new Map<string, Promise<THREE.Texture>>();
  let anisotropy = 4;

  const resolve = (url: string) => (url.startsWith('/') || /^[a-z]+:/i.test(url) ? url : `${BASE}/${url}`);

  /** Clones (one per repeat/colorspace) of each file, so they can be flagged for upload once the image arrives. */
  const clonesOf = new Map<string, THREE.Texture[]>();
  /** Files whose image is decoded and (on phones) already shrunk — clones made earlier wait for this. */
  const ready = new Set<string>();

  function baseTexture(url: string): THREE.Texture {
    let t = baseTextures.get(url);
    if (!t) {
      t = texLoader.load(
        url,
        async (base) => {
          const small = await shrunk(base.image as Decoded, TEXTURE_CAP).catch(() => null);
          if (small) (base as THREE.Texture).image = small;
          ready.add(url);
          clonesOf.get(url)?.forEach((c) => (c.needsUpdate = true));
        },
        undefined,
        () => console.warn('[assets] texture failed', url),
      );
      baseTextures.set(url, t);
    }
    return t;
  }

  function texture(url: string, opts: { srgb?: boolean; repeat?: [number, number] } = {}): THREE.Texture {
    const full = sizedUrl(resolve(url), TEXTURE_CAP);
    const repeat = opts.repeat ?? [1, 1];
    const key = `${full}|${opts.srgb ? 1 : 0}|${repeat[0]}|${repeat[1]}`;
    let t = textureCache.get(key);
    if (!t) {
      // Clones share the image Source, so the GPU upload happens once per file.
      const base = baseTexture(full);
      t = base.clone();
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(repeat[0], repeat[1]);
      t.anisotropy = anisotropy;
      t.colorSpace = opts.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      // clone() flags the copy for upload; until the shared image arrives that only triggers "no image data" warnings
      if (ready.has(full)) t.needsUpdate = true;
      else t.version = 0;
      if (!clonesOf.has(full)) clonesOf.set(full, []);
      clonesOf.get(full)!.push(t);
      textureCache.set(key, t);
    }
    return t;
  }

  function pbr(set: PbrSet, repeat: [number, number] = [1, 1], tint?: THREE.ColorRepresentation): THREE.MeshStandardMaterial {
    const f = pbrFiles(set);
    const p = (file: string) => `${BASE}/textures/${file}`;
    const mat = new THREE.MeshStandardMaterial({ color: tint ?? 0xffffff });
    if (f.arm) {
      const arm = texture(p(f.arm), { repeat });
      mat.map = texture(p(f.map), { srgb: true, repeat });
      mat.normalMap = texture(p(f.normal), { repeat });
      // ARM packs AO (R), roughness (G), metalness (B) — exactly three's channel convention.
      mat.aoMap = arm;
      mat.roughnessMap = arm;
      mat.metalnessMap = arm;
      mat.metalness = 1;
      mat.roughness = 1;
    } else {
      mat.map = texture(p(f.map), { srgb: true, repeat });
      mat.normalMap = texture(p(f.normal), { repeat });
      mat.roughnessMap = texture(p(f.roughness!), { repeat });
      mat.aoMap = texture(p(f.ao!), { repeat });
      mat.metalness = 0;
      mat.roughness = 1;
    }
    mat.name = `pbr:${set}`;
    return mat;
  }

  function gltf(url: string): Promise<GLTF> {
    const full = resolve(url);
    let p = gltfCache.get(full);
    if (!p) {
      p = gltfLoader.loadAsync(full).then(async (g) => {
        if (TEXTURE_CAP < Infinity) await capGltfTextures(g);
        return g;
      });
      p.catch(() => gltfCache.delete(full));
      gltfCache.set(full, p);
    }
    return p;
  }

  function hdr(url: string): Promise<THREE.Texture> {
    const full = resolve(url);
    let p = hdrCache.get(full);
    if (!p) {
      p = hdrLoader.loadAsync(full).then((t) => {
        t.mapping = THREE.EquirectangularReflectionMapping;
        return t as THREE.Texture;
      });
      p.catch(() => hdrCache.delete(full));
      hdrCache.set(full, p);
    }
    return p;
  }

  function setAnisotropy(n: number) {
    anisotropy = n;
    for (const t of textureCache.values()) {
      if (t.anisotropy !== n) {
        t.anisotropy = n;
        if (t.image) t.needsUpdate = true;
      }
    }
  }

  return { gltf, texture, pbr, hdr, setAnisotropy };
}
