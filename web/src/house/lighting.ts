// Interior lighting. The engine's indoor rig brings the key light (sun or moon through the windows) and the IBL;
// this module adds what belongs to the house:
//   - probe GI (engine/gi.ts) for the floor on show: soft bounce instead of a flat ambient,
//   - the backdrop and fog per time of day (seen through the cut walls and baked as the sky through windows),
//   - practical lamps: furniture records lamp specs per floor and a fixed pool of point lights is re-aimed at the
//     shown floor's lamps, so switching floors never changes the light count (which would recompile every shader),
//   - a faint hemisphere fill (strong only when GI is off).
import * as THREE from 'three';
import type { Assets, TimeOfDay, TimeOfDayPhase } from '../core/types';
import { attachProbeGI, type ProbeGI } from '../engine/gi';
import { activeQualitySettings, onQualitySettings } from '../engine/quality';
import { onAppliedTimeOfDay } from '../engine/time-of-day';
import { setWindowView } from './window-view';

export interface Lighting {
  /** Fallback sun. The real engine attaches its own indoor rig (sun + IBL) on setView; then this one
   *  is switched off by `adoptEngineRig` so the room is never lit twice. */
  sun: THREE.DirectionalLight;
  adoptEngineRig(scene: THREE.Scene): void;
  readonly lamps: LampPool;
  readonly gi: ProbeGI;
}

/** A practical light recorded by furniture, in floor-local coordinates. */
export interface LampSpec {
  pos: THREE.Vector3;
  color: THREE.ColorRepresentation;
  intensity: number;
  distance: number;
  /** At most one lamp per floor casts (point-light) shadows. */
  shadow?: boolean;
}

export type LampOpts = { color?: THREE.ColorRepresentation; intensity?: number; distance?: number; shadow?: boolean };

export function lampSpec(pos: THREE.Vector3, opts: LampOpts = {}): LampSpec {
  return { pos: pos.clone(), color: opts.color ?? LAMP_2700K, intensity: opts.intensity ?? 3, distance: opts.distance ?? 5.5, shadow: opts.shadow };
}

const MAX_LAMPS = 14;

/** Incandescent warmth (2700 K): warm lamp colours are pulled halfway toward it, so the lamps read as one warm key
 *  against the 6500 K window light. */
const LAMP_2700K = '#ffb46b';
/** Lamp specs are authored in "room" units; the pool scales them so a lamp lights a pool on the floor and the wall
 *  behind it (×2.6 ≈ 8 cd for a typical floor lamp) and reaches across a room. */
const LAMP_GAIN = 2.6;
const LAMP_REACH = 1.27;

/** Practical lamps per time of day: soft by day (the sun is the key), warmer at golden hour, the key light at night. */
const LAMP_LEVEL: Record<TimeOfDayPhase, { intensity: number; reach: number }> = {
  day: { intensity: 0.42, reach: 1 },
  golden: { intensity: 0.95, reach: 1.05 },
  night: { intensity: 2.2, reach: 1.2 },
};

const _warm = new THREE.Color(LAMP_2700K);
function lampColor(out: THREE.Color, c: THREE.ColorRepresentation): THREE.Color {
  out.set(c);
  return out.r > out.b ? out.lerp(_warm, 0.5) : out;
}

/** Interior footprint (house-local, between exterior wall centrelines) and storey height for the GI volume. */
const FOOTPRINT = { x: 9.1, z: 6.1 };
const CEILING = 2.8;

export class LampPool {
  private lights: THREE.PointLight[] = [];
  private shadowLight: THREE.PointLight;
  private specs: LampSpec[] = [];
  private baseY = 0;
  private level = LAMP_LEVEL.day;
  private shadowsAllowed = true;
  /** The lamp shadow map must be redrawn on the next frame. */
  private shadowDirty = true;
  private undoShadowStaging: (() => void)[] | null = null;
  /** People cast sun shadows (quality). */
  characterShadows = true;
  /** Furniture casts sun shadows (quality; off on Low). */
  furnitureShadows = true;
  /** Called after every assign (the house shows a floor or rebuilt the shown floor's rooms). */
  onAssign: ((baseY: number) => void) | null = null;

  constructor(private scene: THREE.Scene, shadows: boolean) {
    const l = new THREE.PointLight('#ffbe78', 0, 5, 2);
    l.castShadow = shadows;
    l.shadow.mapSize.set(512, 512);
    l.shadow.bias = -0.002;
    l.shadow.radius = 4;
    l.shadow.autoUpdate = false;
    l.name = 'lamp-shadow';
    scene.add(l);
    this.shadowLight = l;
    this.shadowsAllowed = shadows;
    // The lamp's cube shadow map is drawn only when the lamp or its floor changes, never per frame: it costs six
    // passes over the casters around the lamp. People are left out of it (they move on; a shadow left behind would
    // be worse than none) and the sun's map is held for that one frame, so people keep their sun shadow.
    // (Scene.onBeforeRender receives the render target as 4th argument; GI bakes render into cube targets.)
    type SceneHook = (renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, target: unknown) => void;
    const prev = scene.onBeforeRender as unknown as SceneHook;
    // On Low, people cast no shadows at all (characterShadows): they are taken out around every render the same way.
    const hook: SceneHook = (renderer, sc, camera, target) => {
      prev.call(scene, renderer, sc, camera, target);
      if (!renderer.shadowMap.enabled) return;
      const s = this.shadowLight;
      if ((target as { isWebGLCubeRenderTarget?: boolean } | null)?.isWebGLCubeRenderTarget) {
        // a GI bake before the first frame: the map must exist (an undrawn shadow map fails every lit draw call);
        // the next frame redraws it properly
        if (s.castShadow && !s.shadow.map) {
          s.shadow.needsUpdate = true;
          renderer.shadowMap.needsUpdate = true;
        }
        return;
      }
      const redrawLamp = this.shadowDirty && s.castShadow;
      if (!redrawLamp && this.characterShadows && this.furnitureShadows) return;
      if (redrawLamp) {
        this.shadowDirty = false;
        s.shadow.needsUpdate = true;
        renderer.shadowMap.needsUpdate = true; // the engine may draw shadows only every other frame
      }
      const undo: (() => void)[] = [];
      const dropShadows = (root: THREE.Object3D) =>
        root.traverse((m) => {
          if (!m.castShadow) return;
          m.castShadow = false;
          undo.push(() => (m.castShadow = true));
        });
      sc.traverse((o) => {
        // Low: neither the furniture nor the lot around the house (hedges, trees, neighbours) casts sun shadows
        if (!this.furnitureShadows && (o.name === 'lot' || (o.name === 'furniture' && o.parent?.name.startsWith('floor-')))) {
          dropShadows(o);
          return;
        }
        if (o.name.startsWith('person:') || o.name.startsWith('player')) {
          o.traverse((m) => {
            if (!m.castShadow) return;
            m.castShadow = false;
            undo.push(() => (m.castShadow = true));
          });
        } else if (redrawLamp && o !== s && (o as THREE.Light).isLight && (o as THREE.DirectionalLight).castShadow) {
          const sh = (o as THREE.DirectionalLight).shadow;
          if (!sh?.map) return;
          const au = sh.autoUpdate, nu = sh.needsUpdate;
          sh.autoUpdate = false;
          sh.needsUpdate = false;
          undo.push(() => {
            sh.autoUpdate = au;
            sh.needsUpdate = nu;
          });
        }
      });
      this.undoShadowStaging = undo;
    };
    scene.onBeforeRender = hook as unknown as typeof scene.onBeforeRender;
    const prevAfter = scene.onAfterRender as unknown as SceneHook;
    const after: SceneHook = (renderer, sc, camera, target) => {
      prevAfter.call(scene, renderer, sc, camera, target);
      const undo = this.undoShadowStaging;
      if (!undo) return;
      this.undoShadowStaging = null;
      for (let i = undo.length - 1; i >= 0; i--) undo[i]();
    };
    scene.onAfterRender = after as unknown as typeof scene.onAfterRender;
  }

  /** Point the pool at these lamps (floor-local, lifted by baseY). The pool only ever grows. */
  assign(specs: LampSpec[], baseY: number) {
    this.specs = specs;
    this.baseY = baseY;
    this.apply();
    this.onAssign?.(baseY);
  }

  setLevel(level: { intensity: number; reach: number }) {
    this.level = level;
    this.apply();
  }

  /** Quality: whether the one shadow-casting lamp may cast (changing it recompiles lit materials once). */
  setShadows(on: boolean, mapSize = 512) {
    const l = this.shadowLight;
    if (l.shadow.mapSize.x !== mapSize) {
      l.shadow.mapSize.set(mapSize, mapSize);
      l.shadow.map?.dispose();
      (l.shadow as { map: THREE.WebGLRenderTarget | null }).map = null;
      this.shadowDirty = true;
    }
    if (on === this.shadowsAllowed) return;
    this.shadowsAllowed = on;
    this.shadowLight.castShadow = on;
    this.apply();
  }

  private apply() {
    const { specs, baseY, level } = this;
    const shadowSpec = this.shadowsAllowed ? specs.find((s) => s.shadow) ?? null : null;
    const rest = specs.filter((s) => s !== shadowSpec).sort((a, b) => b.intensity * b.distance - a.intensity * a.distance).slice(0, MAX_LAMPS);
    while (this.lights.length < rest.length) {
      const l = new THREE.PointLight('#ffbf80', 0, 5, 2);
      l.name = `lamp-${this.lights.length}`;
      this.scene.add(l);
      this.lights.push(l);
    }
    this.lights.forEach((l, i) => {
      const s = rest[i];
      if (!s) {
        l.intensity = 0;
        return;
      }
      l.position.set(s.pos.x, s.pos.y + baseY, s.pos.z);
      lampColor(l.color, s.color);
      l.intensity = s.intensity * level.intensity * LAMP_GAIN;
      l.distance = s.distance * level.reach * LAMP_REACH;
    });
    const sl = this.shadowLight;
    if (shadowSpec) {
      sl.position.set(shadowSpec.pos.x, shadowSpec.pos.y + baseY, shadowSpec.pos.z);
      lampColor(sl.color, shadowSpec.color);
      sl.intensity = shadowSpec.intensity * level.intensity * LAMP_GAIN;
      sl.distance = shadowSpec.distance * level.reach * LAMP_REACH;
    } else {
      sl.intensity = 0;
      // the (dark) cube map is still drawn once: a shadow light whose map was never drawn binds a texture of the
      // wrong sampler type, and every lit draw call fails
    }
    this.shadowDirty = true;
  }
}

// ── practicals: the glowing parts of lamps (shades, bulbs, lanterns) follow the time of day ──────────
// A shade that glows white at noon while its lamp lights nothing reads as a white blob; by day they are almost
// off, at golden hour half on, at night on (kept below the bloom's white-out).
const PRACTICAL_GLOW: Record<TimeOfDayPhase, number> = { day: 0.1, golden: 0.55, night: 0.8 };
const practicals = new Set<THREE.MeshStandardMaterial>();
let practicalGlow = PRACTICAL_GLOW.day;

/** Register a lamp's emissive material: its authored emissiveIntensity is the night level. */
export function practical<T extends THREE.MeshStandardMaterial>(m: T): T {
  if (m.userData.practicalBase === undefined) m.userData.practicalBase = m.emissiveIntensity;
  m.emissiveIntensity = m.userData.practicalBase * practicalGlow;
  practicals.add(m);
  return m;
}

/** Every emissive material under a loaded lamp model (e.g. a pendant's globe). */
export function practicalGlobes(root: THREE.Object3D) {
  root.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
    if (m?.isMeshStandardMaterial && m.emissive.r + m.emissive.g + m.emissive.b > 0) practical(m);
  });
}

function setPracticalGlow(phase: TimeOfDayPhase) {
  practicalGlow = PRACTICAL_GLOW[phase];
  for (const m of practicals) m.emissiveIntensity = m.userData.practicalBase * practicalGlow;
}

/** Outdoor lights on the lot (street lamps, the neighbours' lit windows, light pools): off by day, on at dusk. */
const NIGHT_GLOW: Record<TimeOfDayPhase, number> = { day: 0, golden: 0.45, night: 1 };
type GlowMaterial = THREE.MeshStandardMaterial | THREE.MeshBasicMaterial;
const nightGlows = new Set<GlowMaterial>();
let nightLevel = NIGHT_GLOW.day;

function applyNightGlow(m: GlowMaterial) {
  const v = (m.userData.glowBase as number) * nightLevel;
  if ((m as THREE.MeshStandardMaterial).isMeshStandardMaterial) (m as THREE.MeshStandardMaterial).emissiveIntensity = v;
  else {
    m.opacity = v;
    m.visible = v > 0; // no draw at all by day
  }
}

/** Register an outdoor light material: its authored emissiveIntensity (standard) or opacity (basic) is the night level. */
export function nightGlow<T extends GlowMaterial>(m: T): T {
  if (m.userData.glowBase === undefined) {
    m.userData.glowBase = (m as THREE.MeshStandardMaterial).isMeshStandardMaterial ? (m as THREE.MeshStandardMaterial).emissiveIntensity : m.opacity;
  }
  applyNightGlow(m);
  nightGlows.add(m);
  return m;
}

function setNightGlow(phase: TimeOfDayPhase) {
  nightLevel = NIGHT_GLOW[phase];
  for (const m of nightGlows) applyNightGlow(m);
}

/** Fallback sun direction (only used when no engine rig is attached, e.g. in stub harnesses). */
export const SUN_DIR = new THREE.Vector3(-0.58, 0.6, -0.55).normalize();

interface HouseLook {
  backdrop: [string, string, string];
  fog: { color: string; near: number; far: number };
  /** Hemisphere fill [sky, ground, intensity] without GI / with GI. */
  hemi: [string, string, number, number];
}

const LOOK: Record<TimeOfDayPhase, HouseLook> = {
  day: { backdrop: ['#dbe4ea', '#ebe6dd', '#d6cdbd'], fog: { color: '#e4dfd6', near: 34, far: 85 }, hemi: ['#efe9e0', '#b8977a', 1.05, 0.03] },
  golden: { backdrop: ['#e3d6cb', '#efd5b6', '#d4b591'], fog: { color: '#e6cfb2', near: 30, far: 80 }, hemi: ['#f4dcc0', '#a8805e', 0.95, 0.025] },
  night: { backdrop: ['#0b1222', '#121a2e', '#191c26'], fog: { color: '#101828', near: 26, far: 75 }, hemi: ['#6d7fa8', '#2a2420', 0.35, 0.012] },
};

const backdrops = new Map<TimeOfDayPhase, THREE.CanvasTexture>();
function backdropFor(phase: TimeOfDayPhase): THREE.Texture {
  let t = backdrops.get(phase);
  if (!t) {
    const c = document.createElement('canvas');
    c.width = 4;
    c.height = 256;
    const g = c.getContext('2d')!;
    const [top, mid, bottom] = LOOK[phase].backdrop;
    const grd = g.createLinearGradient(0, 0, 0, 256);
    grd.addColorStop(0, top);
    grd.addColorStop(0.55, mid);
    grd.addColorStop(1, bottom);
    g.fillStyle = grd;
    g.fillRect(0, 0, 4, 256);
    t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    backdrops.set(phase, t);
  }
  return t;
}

export async function buildLighting(scene: THREE.Scene, renderer: THREE.WebGLRenderer, assets: Assets): Promise<Lighting> {
  // the GI grids must be in the scene before its first render, so every material compiles with probe support
  const gi = attachProbeGI(scene, renderer);
  scene.userData.keepFog = true; // the engine's indoor rig leaves our fog alone
  const fog = new THREE.Fog('#e4dfd6', 34, 85);
  scene.fog = fog;

  try {
    const hdr = await assets.hdr('/assets/hdri/lebombo_1k.hdr');
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromEquirectangular(hdr).texture;
    pmrem.dispose();
  } catch (e) {
    console.warn('[house] HDRI failed, using hemisphere only', e);
  }
  scene.environmentIntensity = 0.7;

  const hemi = new THREE.HemisphereLight('#efe9e0', '#b8977a', 0.75);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight('#ffd9ae', 4.2);
  sun.position.copy(SUN_DIR).multiplyScalar(30);
  sun.target.position.set(0, 0, 0);
  sun.castShadow = true;
  const s = sun.shadow;
  s.mapSize.set(2048, 2048);
  const cam = s.camera as THREE.OrthographicCamera;
  cam.left = -15; cam.right = 15; cam.top = 13; cam.bottom = -13; cam.near = 5; cam.far = 60;
  s.bias = -0.0004;
  s.normalBias = 0.025;
  s.radius = 3;
  scene.add(sun, sun.target);

  const lamps = new LampPool(scene, activeQualitySettings().lampShadows > 0);
  lamps.setShadows(activeQualitySettings().lampShadows > 0, activeQualitySettings().lampShadowSize);
  lamps.characterShadows = activeQualitySettings().characterShadows;
  lamps.furnitureShadows = activeQualitySettings().furnitureShadows;
  let engineRig = false;
  let phase: TimeOfDayPhase = 'day';
  const unQ = onQualitySettings((q) => {
    lamps.setShadows(q.lampShadows > 0, q.lampShadowSize); // Ultra: a crisper lamp shadow
    lamps.characterShadows = q.characterShadows;
    lamps.furnitureShadows = q.furnitureShadows;
    scene.traverse((o) => {
      if (o.userData.lotDetail) o.visible = q.lotDetail; // the lot's neighbours and hedge sprigs (lot.ts)
    });
    updateHemi();
  });

  function updateHemi() {
    const h = LOOK[phase].hemi;
    hemi.color.set(h[0]);
    hemi.groundColor.set(h[1]);
    // the engine's indoor IBL is dimmer than ours: without GI, lift the fill to match (as before probes existed)
    hemi.intensity = gi.active ? h[3] : engineRig ? h[2] : h[2] * 0.72;
  }

  function applyTod(t: TimeOfDay) {
    phase = t.phase;
    const look = LOOK[phase];
    scene.background = backdropFor(phase);
    fog.color.set(look.fog.color);
    fog.near = look.fog.near;
    fog.far = look.fog.far;
    lamps.setLevel(LAMP_LEVEL[phase]);
    setPracticalGlow(phase);
    setNightGlow(phase);
    setWindowView(phase);
    updateHemi();
  }
  const unTod = onAppliedTimeOfDay(applyTod);

  // The floor on show is the GI volume (and fits the indoor sun's shadow frustum).
  lamps.onAssign = (baseY) => {
    gi.setVolume({
      key: `floor:${Math.round(baseY * 100)}`,
      box: new THREE.Box3(new THREE.Vector3(-FOOTPRINT.x, baseY - 0.05, -FOOTPRINT.z), new THREE.Vector3(FOOTPRINT.x, baseY + CEILING + 0.15, FOOTPRINT.z)),
    });
    updateHemi();
  };

  // nothing to tear down while the house view lives for the whole session; keep the handles reachable
  scene.userData.lightingDispose = () => {
    unQ();
    unTod();
  };

  return {
    sun,
    lamps,
    gi,
    adoptEngineRig(sc) {
      const engineSun = sc.children.find((o) => o !== sun && ((o as THREE.DirectionalLight).isDirectionalLight || (o as { isSunLight?: boolean }).isSunLight));
      engineRig = !!engineSun;
      sun.visible = !engineSun;
      sun.castShadow = !engineSun;
      updateHemi();
    },
  };
}
