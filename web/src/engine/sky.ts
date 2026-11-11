// Skies per time of day: Poly Haven CC0 HDRIs, the sun/moon direction measured from each file (luminance centroid
// of its brightest pixels, see research/threejs-realism.md §2.2), a clamped copy for background + IBL (the unclipped
// sun would double-count the SunLight), and the horizon colour sampled from the file so distance fog melts into
// the sky. Loaded lazily per phase and cached (a 2k float sky is ~32 MB, so only phases actually shown are kept).
// A computer's first sky is the 1k copy (a third of the bytes, on the town's critical path); its 2k sky replaces it
// once the town is on show (lighting.ts).
import * as THREE from 'three';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import type { TimeOfDayPhase } from '../core/types';
import { MEMORY_TIGHT } from './quality';

export interface SkyDef {
  hdr: string;
  /** Measured direction of the sun (or moon) in the unrotated HDRI. */
  lightDir: [number, number, number];
  /** Spins sky + light together (Object3D.rotation.y convention). */
  rotationY: number;
  lightColor: number;
  lightIntensity: number;
  /** Shadow darkness of the key light (1 = fully dark under casters). */
  shadowIntensity: number;
  envIntensity: number;
  backgroundIntensity: number;
  clamp: number;
  /** Distance fog; colour comes from the sky's horizon band. */
  fog: { near: number; far: number; tint: [number, number, number] };
  exposure: number;
}

export const SKY_DEFS: Record<TimeOfDayPhase, SkyDef> = {
  day: {
    hdr: '/assets/hdri/kloofendal_48d_partly_cloudy_puresky_2k.hdr',
    lightDir: [0.5543, 0.7417, 0.3776],
    rotationY: Math.PI, // the afternoon sun rakes across the fronts of the Main Avenue lots
    lightColor: 0xffe4c4,
    lightIntensity: 3.2,
    shadowIntensity: 1,
    envIntensity: 0.68,
    backgroundIntensity: 1,
    clamp: 48,
    fog: { near: 300, far: 2600, tint: [0.92, 0.97, 1.04] }, // aerial perspective: only the far fields fade to sky blue
    exposure: 1,
  },
  golden: {
    hdr: '/assets/hdri/kloppenheim_06_puresky_2k.hdr',
    lightDir: [0.827, 0.327, 0.458],
    rotationY: Math.PI,
    lightColor: 0xffae66,
    lightIntensity: 3.4,
    shadowIntensity: 1,
    envIntensity: 0.48,
    backgroundIntensity: 1,
    clamp: 40,
    fog: { near: 280, far: 2400, tint: [1.0, 0.82, 0.68] }, // a peach haze toward the low sun (not an olive veil)
    exposure: 1.05,
  },
  night: {
    hdr: '/assets/hdri/qwantani_moonrise_puresky_2k.hdr',
    lightDir: [0.785, 0.2387, 0.5716],
    rotationY: 1.0, // moonlight from the side of the default city view: readable silhouettes, long soft shadows
    lightColor: 0xa9bfff,
    lightIntensity: 0.32,
    shadowIntensity: 0.85,
    envIntensity: 0.1,
    backgroundIntensity: 0.11,
    clamp: 60, // keeps a small bright moon disc that blooms softly
    fog: { near: 200, far: 900, tint: [0.5, 0.62, 1.0] }, // deep navy: lit windows and lamps stay crisp
    exposure: 1.25,
  },
};

export interface SkyAssets {
  phase: TimeOfDayPhase;
  def: SkyDef;
  /** The 1k stand-in for a 2k sky (lighting.ts swaps in the sharp one once the town is on show). */
  quick: boolean;
  /** Clamped equirect sky (background). */
  background: THREE.DataTexture;
  /** PMREM of the clamped sky (IBL): `envTarget.texture`, freed with its target (SkyLibrary.drop). */
  env: THREE.Texture;
  envTarget: THREE.WebGLRenderTarget;
  /** Linear horizon radiance × backgroundIntensity × fog tint (fog colour). */
  horizon: THREE.Color;
  /** World-space direction toward the sun/moon (rotation applied). */
  lightDirection: THREE.Vector3;
}

/** Rotate a direction about +Y (same convention as Object3D.rotation.y / scene.environmentRotation.y). */
export function rotateY([x, y, z]: [number, number, number], a: number): THREE.Vector3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return new THREE.Vector3(x * c + z * s, y, -x * s + z * c).normalize();
}

interface RawHdr {
  data: Float32Array;
  width: number;
  height: number;
}

/** The file a device loads for a sky: phones get the 1k copy beside each 2k file (tools/assets/slim.mjs, the same
 *  2×2 box filter the browser used to run after downloading 2k) — a quarter of the bytes, the memory for the sky, its
 *  cube and its PMREM. */
export function skyUrl(def: SkyDef, memoryTight = MEMORY_TIGHT): string {
  return memoryTight ? def.hdr.replace(/_2k\.hdr$/, '_1k.hdr') : def.hdr;
}

/** Clamped copy (keeps the IBL from double-counting the sun) + the mean horizon colour (elevation 0.5°…5°). */
function prepare(tex: THREE.Texture, clamp: number): { background: THREE.DataTexture; horizon: THREE.Color } {
  const img = tex.image as RawHdr;
  const { width: W, height: H } = img;
  const src = img.data;
  const ch = src.length / (W * H); // 4 (RGBA) from HDRLoader
  const data = new Float32Array(src.length);
  for (let i = 0; i < src.length; i++) data[i] = src[i] < clamp ? src[i] : clamp;
  let r = 0, g = 0, b = 0, n = 0;
  const y0 = Math.floor(H * (0.5 - 5 / 180)), y1 = Math.ceil(H * (0.5 - 0.5 / 180));
  for (let y = y0; y <= y1; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * ch;
      const l = 0.2126 * src[o] + 0.7152 * src[o + 1] + 0.0722 * src[o + 2];
      if (l > 8) continue; // skip the sun/moon and their halo
      r += src[o];
      g += src[o + 1];
      b += src[o + 2];
      n++;
    }
  }
  const out = new THREE.DataTexture(data, W, H, tex.format as THREE.PixelFormat, THREE.FloatType);
  out.mapping = THREE.EquirectangularReflectionMapping;
  out.colorSpace = THREE.LinearSRGBColorSpace;
  out.minFilter = out.magFilter = THREE.LinearFilter;
  out.generateMipmaps = false;
  out.needsUpdate = true;
  return { background: out, horizon: n ? new THREE.Color(r / n, g / n, b / n) : new THREE.Color(0.5, 0.55, 0.65) };
}

export class SkyLibrary {
  private loader = new HDRLoader().setDataType(THREE.FloatType);
  private cache = new Map<string, Promise<SkyAssets>>();

  constructor(private renderer: THREE.WebGLRenderer) {}

  /** The sky at the device's size; `quick`: the 1k copy where that is 2k. */
  get(phase: TimeOfDayPhase, quick = false): Promise<SkyAssets> {
    const def = SKY_DEFS[phase];
    const url = skyUrl(def, MEMORY_TIGHT || quick);
    let p = this.cache.get(url);
    if (!p) {
      p = this.load(phase, url, url !== skyUrl(def));
      p.catch(() => this.cache.delete(url));
      this.cache.set(url, p);
    }
    return p;
  }

  /** Warm the cache in the background (idle time) so a later switch is instant. */
  prefetch(phase: TimeOfDayPhase) {
    const run = () => void this.get(phase).catch(() => {});
    const ric = (globalThis as { requestIdleCallback?: (fn: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
    if (ric) ric(run, { timeout: 8000 });
    else setTimeout(run, 2000);
  }

  /** A quick sky its sharp one (or another phase) replaced: free it on the GPU — the background and the PMREM
   *  target (three frees a render target's framebuffer and texture only through the target's own dispose). */
  drop(sky: SkyAssets) {
    if (!sky.quick) return;
    this.cache.delete(skyUrl(sky.def, true));
    sky.background.dispose();
    sky.envTarget.dispose();
  }

  private async load(phase: TimeOfDayPhase, url: string, quick: boolean): Promise<SkyAssets> {
    const def = SKY_DEFS[phase];
    // three turns an equirect background into a cube as tall as the image (2k sky → 1024² × 6 float = 96 MB)
    const raw = await this.loader.loadAsync(url);
    const { background, horizon } = prepare(raw, def.clamp);
    raw.dispose(); // the unclamped float copy is not needed after this (~32 MB)
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    let envTarget: THREE.WebGLRenderTarget;
    if (quick) {
      // The PMREM's size is part of every lit material's shader: made at the 2k sky's size (a cube of a quarter of
      // its width) the sharp sky later swaps in without recompiling the town's shaders.
      const cube = new THREE.WebGLCubeRenderTarget(background.image.width / 2);
      cube.fromEquirectangularTexture(this.renderer, background);
      envTarget = pmrem.fromCubemap(cube.texture);
      cube.dispose();
    } else envTarget = pmrem.fromEquirectangular(background);
    pmrem.dispose();
    horizon.multiplyScalar(def.backgroundIntensity);
    horizon.r *= def.fog.tint[0];
    horizon.g *= def.fog.tint[1];
    horizon.b *= def.fog.tint[2];
    return { phase, def, quick, background, envTarget, env: envTarget.texture, horizon, lightDirection: rotateY(def.lightDir, def.rotationY) };
  }
}
