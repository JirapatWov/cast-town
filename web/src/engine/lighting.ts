// Lighting rigs. The engine owns one rig per preset (key light + IBL + fog) and attaches it to whichever scene is
// active, so views never create their own sun. Both rigs follow the time of day (sky.ts / time-of-day.ts).
//   outdoor: HDRI sky as background + IBL, SunLight (2 cascades fitted to the camera) aligned with the HDRI's sun
//            or moon, distance fog in the sky's horizon colour.
//   indoor:  interior IBL (lebombo), a DirectionalLight whose ortho shadow frustum is fitted to the floor on show
//            (no camera-fitted cascades, so probe bakes can reuse its shadow map), sun/moon through the windows.
import * as THREE from 'three';
import { SunLight } from 'three/addons/lights/SunLight.js';
import type { LightingPreset, TimeOfDayPhase } from '../core/types';
import { afterTownShown } from '../core/town-shown';
import type { EngineAssets } from './assets';
import { giFor } from './gi';
import { SkyLibrary, type SkyAssets } from './sky';

export interface LightingRig {
  readonly preset: LightingPreset;
  readonly light: THREE.Light;
  /** Attach to a scene and set its background / environment / fog. */
  apply(scene: THREE.Scene): void;
  detach(): void;
  /** Called every frame with the active camera (fits shadow ranges). */
  update(camera: THREE.PerspectiveCamera): void;
  setShadowQuality(enabled: boolean, mapSize: number, radius: number, distance?: number): void;
  /** Re-light for a time of day; resolves when everything it needs is loaded and applied. */
  setPhase(phase: TimeOfDayPhase): Promise<void>;
  /** Tone-mapping exposure this rig wants for the current phase. */
  readonly exposure: number;
}

function resizeShadow(light: THREE.DirectionalLight | SunLight, enabled: boolean, mapSize: number) {
  light.castShadow = enabled;
  if (light.shadow.mapSize.x !== mapSize) {
    light.shadow.mapSize.setScalar(mapSize);
    light.shadow.map?.dispose();
    (light.shadow as { map: THREE.WebGLRenderTarget | null }).map = null;
  }
}

const _ray = new THREE.Ray();
const _hit = new THREE.Vector3();
const _plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

// ───────────────────────────────────────── outdoor ─────────────────────────────────────────

export interface OutdoorRig extends LightingRig {
  readonly sky: SkyAssets;
  readonly skies: SkyLibrary;
}

/** `onSky`: the GI bakes must follow the sky on show now (a quick sky it baked from is about to be freed). */
export async function createOutdoorRig(renderer: THREE.WebGLRenderer, phase: TimeOfDayPhase, onSky: () => void): Promise<OutdoorRig> {
  const skies = new SkyLibrary(renderer);
  // the town's first load takes the quick sky; the sharp one follows once the town is on show (sky.ts)
  let sharp = false;
  let sky = await skies.get(phase, true);
  const sun = new SunLight(0xffffff, 1);
  sun.name = 'engine-sun';
  sun.castShadow = true;
  sun.shadow.mapSize.setScalar(2048);
  sun.shadow.normalBias = 0.035;
  sun.shadow.bias = -0.0002;
  sun.shadow.radius = 2;
  sun.shadow.camera.far = 160;
  const fog = new THREE.Fog(0xffffff, 100, 1000);
  let scene: THREE.Scene | null = null;
  let lastFar = 0;
  let reach = 1;
  let want: TimeOfDayPhase = phase;

  function applySky() {
    const d = sky.def;
    sun.position.copy(sky.lightDirection);
    sun.color.set(d.lightColor);
    sun.intensity = d.lightIntensity;
    sun.shadow.intensity = d.shadowIntensity;
    fog.color.copy(sky.horizon);
    fog.near = d.fog.near;
    fog.far = d.fog.far;
    if (!scene) return;
    scene.background = sky.background;
    scene.backgroundIntensity = d.backgroundIntensity;
    scene.backgroundBlurriness = 0;
    scene.environment = sky.env;
    scene.environmentIntensity = d.envIntensity;
    scene.backgroundRotation.set(0, d.rotationY, 0);
    scene.environmentRotation.set(0, d.rotationY, 0);
    scene.fog = fog;
  }
  applySky();
  /** Put `next` on show; a quick sky it replaces is freed, once the GI no longer bakes from it. */
  function show(next: SkyAssets) {
    const old = sky;
    sky = next;
    applySky();
    if (old === next || !old.quick) return;
    onSky();
    skies.drop(old);
  }
  afterTownShown(async () => {
    sharp = true; // every phase picked from now on loads sharp (setPhase)
    try {
      let p: TimeOfDayPhase;
      let next: SkyAssets;
      do {
        p = want;
        next = await skies.get(p);
      } while (want !== p); // a newer choice came while this one loaded: sharpen that one
      show(next);
    } catch (e) {
      console.warn('[engine] the sharp sky failed to load', e);
    }
  });

  return {
    preset: 'outdoor',
    light: sun,
    skies,
    get sky() {
      return sky;
    },
    get exposure() {
      return sky.def.exposure;
    },
    apply(s) {
      scene = s;
      s.add(sun);
      applySky();
    },
    detach() {
      if (scene) scene.remove(sun);
      scene = null;
    },
    update(camera) {
      // Fit the cascaded shadow range to the visible ground: where the view ray meets y=0, plus margin.
      // Quantized so cascades don't re-fit (and shimmer) on every tiny zoom step.
      camera.getWorldDirection(_ray.direction);
      _ray.origin.copy(camera.position);
      const hit = _ray.intersectPlane(_plane, _hit);
      const d = hit ? camera.position.distanceTo(hit) : 200;
      const wanted = THREE.MathUtils.clamp((d * 1.9 + 70) * reach, 70, 720);
      const far = Math.pow(1.2, Math.ceil(Math.log(wanted) / Math.log(1.2)));
      if (Math.abs(far - lastFar) > 1) {
        sun.shadow.camera.far = far;
        lastFar = far;
      }
    },
    setShadowQuality(enabled, mapSize, radius, distance = 1) {
      resizeShadow(sun, enabled, mapSize);
      sun.shadow.radius = radius;
      reach = distance;
      lastFar = 0;
    },
    async setPhase(p) {
      want = p;
      const next = await skies.get(p, !sharp);
      if (want !== p) return; // a newer choice won while this one loaded
      show(next);
    },
  };
}

// ───────────────────────────────────────── indoor ──────────────────────────────────────────

interface IndoorLook {
  /** Direction toward the sun/moon in house space (windows on the west and south walls catch it). */
  dir: [number, number, number];
  color: number;
  intensity: number;
  shadowIntensity: number;
  /** Interior IBL: with probe GI it mostly provides reflections; without it, it is the ambient. */
  env: number;
  envWithGI: number;
  exposure: number;
}

// The sun patch through a window is the brightest thing in a room (key), the window-lit walls and the bounce are the
// fill, the warm lamps carry the night: with GI the IBL only adds reflections, so the contrast is 3–4 stops, not a
// flat grey wash.
const INDOOR: Record<TimeOfDayPhase, IndoorLook> = {
  day: { dir: [-0.83, 0.42, 0.37], color: 0xffdcb4, intensity: 8.5, shadowIntensity: 1, env: 0.42, envWithGI: 0.06, exposure: 1.15 },
  golden: { dir: [-0.9, 0.24, 0.36], color: 0xffaa66, intensity: 9, shadowIntensity: 1, env: 0.36, envWithGI: 0.05, exposure: 1.15 },
  night: { dir: [-0.45, 0.62, 0.64], color: 0x9fb6ff, intensity: 0.55, shadowIntensity: 0.9, env: 0.07, envWithGI: 0.02, exposure: 1.15 },
};

const INDOOR_HDR = '/assets/hdri/lebombo_1k.hdr';
const INDOOR_BACKGROUND = 0x17140f;
/** Shadow frustum when no interior volume is known yet (house footprint + garden margin). */
const DEFAULT_BOX = new THREE.Box3(new THREE.Vector3(-9.5, -0.3, -6.5), new THREE.Vector3(9.5, 3.2, 6.5));

export function createIndoorRig(renderer: THREE.WebGLRenderer, assets: EngineAssets, phase: TimeOfDayPhase): LightingRig {
  const sun = new THREE.DirectionalLight(0xffffff, 1);
  sun.name = 'engine-sun-indoor';
  sun.castShadow = true;
  sun.shadow.mapSize.setScalar(2048);
  sun.shadow.bias = -0.0003;
  sun.shadow.normalBias = 0.022;
  sun.shadow.radius = 1.5;
  const background = new THREE.Color(INDOOR_BACKGROUND);
  let env: THREE.Texture | null = null;
  let scene: THREE.Scene | null = null;
  let look = INDOOR[phase];
  const fitted = new THREE.Box3();
  const dir = new THREE.Vector3();
  const shadowCam = sun.shadow.camera as THREE.OrthographicCamera;
  const tmp = new THREE.Object3D();
  const corner = new THREE.Vector3();
  const inv = new THREE.Matrix4();

  // The interior IBL loads the first time a house is shown, not with the engine: the city never uses it.
  let envRequested = false;
  function loadEnv() {
    if (envRequested) return;
    envRequested = true;
    assets
      .hdr(INDOOR_HDR)
      .then((tex) => {
        const pmrem = new THREE.PMREMGenerator(renderer);
        env = pmrem.fromEquirectangular(tex).texture;
        pmrem.dispose();
        if (scene) scene.environment = env;
      })
      .catch((e) => {
        envRequested = false; // try again on the next house
        console.warn('[engine] indoor HDR failed', e);
      });
  }

  /** Fit the ortho shadow camera around the floors up to the one on show, seen from the light. */
  function fit(box: THREE.Box3) {
    fitted.copy(box);
    const b = box.clone();
    b.min.y = Math.min(b.min.y, 0) - 0.3; // floors below cast onto the garden too
    b.expandByVector(new THREE.Vector3(1.2, 0, 1.2));
    const center = b.getCenter(new THREE.Vector3());
    dir.set(...look.dir).normalize();
    sun.position.copy(center).addScaledVector(dir, 40);
    sun.target.position.copy(center);
    sun.updateMatrixWorld();
    sun.target.updateMatrixWorld();
    tmp.position.copy(sun.position);
    tmp.lookAt(center);
    tmp.updateMatrixWorld();
    inv.copy(tmp.matrixWorld).invert();
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < 8; i++) {
      corner.set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z).applyMatrix4(inv);
      x0 = Math.min(x0, corner.x);
      x1 = Math.max(x1, corner.x);
      y0 = Math.min(y0, corner.y);
      y1 = Math.max(y1, corner.y);
      z0 = Math.min(z0, corner.z);
      z1 = Math.max(z1, corner.z);
    }
    // Object3D.lookAt points +Z at the target for non-cameras; the shadow camera looks down -Z: mirror x.
    shadowCam.left = -x1;
    shadowCam.right = -x0;
    shadowCam.top = y1;
    shadowCam.bottom = y0;
    shadowCam.near = Math.max(0.1, z0 - 2);
    shadowCam.far = z1 + 2;
    shadowCam.updateProjectionMatrix();
    sun.shadow.needsUpdate = true;
  }

  function applyLook() {
    sun.color.set(look.color);
    sun.intensity = look.intensity;
    sun.shadow.intensity = look.shadowIntensity;
    fit(fitted.isEmpty() ? DEFAULT_BOX : fitted);
    if (!scene) return;
    scene.environmentIntensity = giFor(scene)?.active ? look.envWithGI : look.env;
  }

  return {
    preset: 'indoor',
    light: sun,
    get exposure() {
      return look.exposure;
    },
    apply(s) {
      scene = s;
      loadEnv();
      s.add(sun, sun.target);
      if (!s.userData.keepBackground) s.background = background;
      s.environment = env;
      s.environmentRotation.set(0, 0, 0);
      s.fog = s.userData.keepFog ? s.fog : null;
      fitted.makeEmpty();
      applyLook();
    },
    detach() {
      if (scene) scene.remove(sun, sun.target);
      scene = null;
    },
    update() {
      if (!scene) return;
      const gi = giFor(scene);
      const box = gi?.volumeBox;
      if (box && !box.equals(fitted)) fit(box);
      const e = gi?.active ? look.envWithGI : look.env;
      if (scene.environmentIntensity !== e) scene.environmentIntensity = e;
    },
    setShadowQuality(enabled, mapSize, radius) {
      resizeShadow(sun, enabled, mapSize);
      // crisp window patches (the frustum is fitted to one floor, so texels are small)
      sun.shadow.radius = Math.min(radius, 1);
    },
    async setPhase(p) {
      look = INDOOR[p];
      applyLook();
    },
  };
}
