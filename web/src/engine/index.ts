// Rendering engine: WebGLRenderer + pmndrs post stack + lighting presets + time of day + interior GI probes
// + CSS2D labels + fade curtain.
//   const engine = await createEngine(container);
//   engine.setView(scene, camera, 'outdoor');   // views own scene + camera, the engine owns sun/IBL/post
import * as THREE from 'three';
import type { Engine, LightingPreset, Quality, TimeOfDay, TimeOfDayPhase } from '../core/types';
import { createAssets } from './assets';
import { giFor, setGIPacing, setGIQuality, setGISky } from './gi';
import { createIndoorRig, createOutdoorRig, type LightingRig } from './lighting';
import { adviseQuality, FrameBudget, FramePacer, lowerQuality } from './frame-pacing';
import { createDissolve, createFadeCurtain, createLabelLayer } from './overlays';
import { createPost } from './post';
import { initialQuality, MEMORY_TIGHT, publishQualitySettings, QUALITY_PRESETS, saveQuality, type QualitySettings } from './quality';
import { publishTimeOfDay, timeOfDayClock, upcomingPhase } from './time-of-day';

/** A phone screen can't show more than a 1k shadow map, and the sun's two-cascade atlas at 2k costs 64 MB. */
const shadowSize = (size: number) => (MEMORY_TIGHT ? Math.min(size, 1024) : size);

export { pbrTileMeters } from './assets';
export { QUALITY_PRESETS } from './quality';
export { attachProbeGI } from './gi';
export { appliedTimeOfDay, onAppliedTimeOfDay } from './time-of-day';
export { createNightLamps, type NightLamps, type NightLampOptions } from './night-lamps';
export { onQualityAdvice } from './frame-pacing';

function createRenderer(): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({
    powerPreference: 'high-performance',
    antialias: false, // SMAA runs in post
    stencil: false,
    alpha: false,
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping; // ACES runs in post, in HDR
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap; // soft since r182 (PCFSoft is gone in r186)
  const c = renderer.domElement;
  c.className = 'rlt-canvas';
  Object.assign(c.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', display: 'block', touchAction: 'none', zIndex: '0' });
  // Focusable by click (the house's arrow-key walking needs focus) but never a Tab stop: a nameless canvas the
  // keyboard can't use. Keyboard users reach the houses from the town's list or the board (ui/main-view.ts).
  c.tabIndex = -1;
  return renderer;
}

/** Debug/test handle (window.__rltEngine): GI status, frame stats. Not part of the Engine contract. */
export interface EngineDebug {
  /** Resolves when no GI bake or time-of-day switch is pending. */
  settled(timeoutMs?: number): Promise<void>;
  gi(): { active: boolean; busy: boolean; bakes: number; lastMs: number; lastProbes: number; callsPerProbe: number } | null;
  /** renderer.info of the last complete frame (all passes incl. shadows). */
  frame(): { calls: number; triangles: number; points: number; lines: number };
  /** The settings in effect (the preset plus any tune() overrides). */
  settings(): QualitySettings;
  /** Override single settings on top of the preset (null clears), e.g. to time each effect on a real GPU. */
  tune(overrides: Partial<QualitySettings> | null): void;
  /** GI bakes pace themselves by the frame time; off bakes by CPU budget only (the old way), to compare. */
  giPacing(on: boolean): void;
  /** Off: draw every animation frame, as before the idle frame cap (to compare, or for frame-time tests). */
  pacing(on: boolean): void;
  /** Slow-frame advice to step quality down. Off by default under automation (navigator.webdriver) and when the
   *  quality came from ?q=, so QA runs keep the preset they asked for. */
  autoQuality(on: boolean): void;
  /** Current frame pacing: the minimum ms between frames (0 = every frame). */
  pace(): { intervalMs: number; fullRate: boolean };
  /** Act as if frames had been too slow for a while (to see the step-down toast without a slow GPU). */
  adviseNow(): void;
}

const urlQuality = () => {
  try {
    return new URLSearchParams(location.search).has('q');
  } catch {
    return false;
  }
};

/** Keys typed into a text box (chat, terminal, search) say nothing about the town. */
const isEditable = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');

/** three's shared loading manager (every GLTF/texture/HDR load reports to it): main.ts hands it to the boot tracker
 *  before the engine asks for its first file. Exported here so the app's first chunk never imports three itself. */
export const loadingManager = THREE.DefaultLoadingManager;

export async function createEngine(container: HTMLElement): Promise<Engine> {
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
  container.style.overflow = 'hidden';
  container.style.isolation = 'isolate';

  const renderer = createRenderer();
  container.appendChild(renderer.domElement);
  const assets = createAssets();
  const labels = createLabelLayer();
  const curtain = createFadeCurtain();
  const dissolve = createDissolve();
  container.append(dissolve.element, labels.element, curtain.element);

  let width = Math.max(1, container.clientWidth);
  let height = Math.max(1, container.clientHeight);
  let quality: Quality = initialQuality(renderer);
  let settings = QUALITY_PRESETS[quality];
  let overrides: Partial<QualitySettings> | null = null;
  let pixelRatio = Math.min(devicePixelRatio || 1, settings.pixelRatioCap);
  renderer.setPixelRatio(pixelRatio);

  const clock = timeOfDayClock();
  let phase: TimeOfDayPhase = clock.phase;
  let tod: TimeOfDay = clock.state;
  const todListeners = new Set<(t: TimeOfDay) => void>();

  const post = createPost(renderer, width * pixelRatio, height * pixelRatio);
  const outdoor = await createOutdoorRig(renderer, phase, () => syncGISky());
  const rigs: Record<LightingPreset, LightingRig> = {
    outdoor,
    indoor: createIndoorRig(renderer, assets, phase),
  };
  function syncGISky() {
    setGISky(outdoor.sky.env, outdoor.sky.def.backgroundIntensity, outdoor.sky.def.rotationY, phase);
  }
  syncGISky();
  post.setPhase(phase);
  publishTimeOfDay(tod);
  // Only the sky on show loads at start, in its quick 1k copy (lighting.ts: the sharp one once the town is on show;
  // each is megabytes, and the first visit should not pay for all three). Auto
  // fetches the next one ten minutes before the clock switches to it; a sky picked by hand loads under the frozen
  // frame of the switch (relight). Phones never prefetch: each sky costs ~60 MB held forever.
  if (!MEMORY_TIGHT) {
    setInterval(() => {
      const next = clock.state.mode === 'auto' ? upcomingPhase(new Date(), 10) : null;
      if (next && next !== phase) outdoor.skies.prefetch(next);
    }, 60_000);
  }

  let scene: THREE.Scene | null = null;
  let camera: THREE.PerspectiveCamera | null = null;
  let rig: LightingRig | null = null;
  let paused = false;
  let frameNo = 0;
  const frameFns = new Set<(dt: number, elapsed: number) => void>();
  const timer = new THREE.Timer();
  timer.connect(document);
  const lastFrame = { calls: 0, triangles: 0, points: 0, lines: 0 };

  // ── frame pacing (#71): full rate while anything moves, 30 fps for idle animations, 15 fps in the background ──
  const pacer = new FramePacer(performance.now());
  const budget = new FrameBudget();
  let pacing = true;
  let advice = !navigator.webdriver && !urlQuality();
  let advised: Quality | null = null; // one suggestion per preset: ignored once, it would only nag
  let prevFull = false; // the frame before this one was drawn back to back too: dt is a true frame time
  const camSeen = new Float64Array(32);
  const input = (e: Event) => {
    if (e.type === 'keydown' && isEditable(e.target)) return;
    pacer.poke(performance.now(), true);
  };
  for (const t of ['pointerdown', 'pointermove', 'wheel', 'touchstart'] as const) container.addEventListener(t, input, { capture: true, passive: true });
  addEventListener('keydown', input, { capture: true, passive: true });
  /** The camera moved since the last drawn frame (controls easing out, a fly-to, a follow camera). */
  function cameraMoved(c: THREE.PerspectiveCamera): boolean {
    const m = c.matrixWorld.elements;
    const p = c.projectionMatrix.elements;
    let moved = false;
    for (let i = 0; i < 16; i++) {
      if (Math.abs(camSeen[i] - m[i]) > 1e-4 || Math.abs(camSeen[16 + i] - p[i]) > 1e-4) moved = true;
      camSeen[i] = m[i];
      camSeen[16 + i] = p[i];
    }
    return moved;
  }

  function resize() {
    pacer.poke(performance.now()); // a resized canvas is blank until the next draw
    width = Math.max(1, container.clientWidth);
    height = Math.max(1, container.clientHeight);
    renderer.setPixelRatio(pixelRatio);
    post.setSize(width, height);
    labels.setSize(width, height);
    if (camera) {
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    }
  }

  function applyQuality() {
    settings = overrides ? { ...QUALITY_PRESETS[quality], ...overrides } : QUALITY_PRESETS[quality];
    pixelRatio = Math.min(devicePixelRatio || 1, settings.pixelRatioCap);
    renderer.shadowMap.enabled = settings.shadows;
    renderer.shadowMap.autoUpdate = settings.shadowEvery <= 1;
    renderer.shadowMap.needsUpdate = true;
    for (const r of Object.values(rigs)) r.setShadowQuality(settings.shadows, shadowSize(settings.shadowMapSize), settings.shadowRadius, settings.shadowDistance);
    assets.setAnisotropy(Math.min(settings.anisotropy, renderer.capabilities.getMaxAnisotropy()));
    post.applyQuality(settings);
    setGIQuality(settings.gi);
    publishQualitySettings(settings);
    resize();
  }

  // ── time of day ────────────────────────────────────────────────────────────────────────────
  // A switch freezes the last old frame on top, re-lights everything underneath (sky load, GI re-bake), then
  // dissolves to the new look. Views hear about it (onTimeOfDay) at the moment of the re-light.
  let pendingPhase: TimeOfDayPhase | null = null;
  let switching = false;
  let switchToken = 0;

  function notifyTod() {
    tod = clock.state;
    publishTimeOfDay(tod);
    for (const fn of todListeners) {
      try {
        fn(tod);
      } catch (e) {
        console.error('[engine] time-of-day listener failed', e);
      }
    }
  }

  async function relight(next: TimeOfDayPhase, withDissolve: boolean) {
    const token = ++switchToken;
    switching = true;
    phase = next;
    try {
      await Promise.all(Object.values(rigs).map((r) => r.setPhase(next)));
      if (token !== switchToken) return;
      post.setPhase(next);
      syncGISky();
      renderer.shadowMap.needsUpdate = true;
      notifyTod();
      if (withDissolve) {
        // let the probes re-bake under the frozen frame (bounded, so the UI never feels stuck)
        await giFor(scene)?.whenIdle(2600);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      }
    } catch (e) {
      console.warn('[engine] time-of-day switch failed', e);
    } finally {
      if (token === switchToken) {
        switching = false;
        dissolve.release(withDissolve ? 1100 : 0);
      }
    }
  }

  clock.subscribe((t) => {
    if (t.phase === phase) {
      pendingPhase = null; // switched back before the frame that would have started it
      notifyTod(); // only the mode label changed (e.g. Auto ↔ the phase it resolves to)
      return;
    }
    if (paused || !scene) void relight(t.phase, false);
    else pendingPhase = t.phase; // the next frame captures the old look first
  });

  // Frame time while no GI bake runs (ms, smoothed): bakes pace themselves against it.
  let steadyMs = 0;

  // Dynamic resolution: if frames stay slow, step the pixel ratio down (never below 1). Quality presets stay as chosen.
  let slowTime = 0;
  function adaptResolution(dt: number) {
    if (dt > 1 / 40 && pixelRatio > 1) slowTime += dt;
    else slowTime = Math.max(0, slowTime - dt * 0.5);
    if (slowTime > 1.5) {
      slowTime = 0;
      pixelRatio = Math.max(1, pixelRatio - 0.25);
      resize();
    }
  }

  // ── focus point for the depth of field: where the view ray meets the floor on show / the ground ──
  const ray = new THREE.Ray();
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const focus = new THREE.Vector3();
  function updateFocus() {
    if (!camera || !rig) return;
    camera.getWorldDirection(ray.direction);
    ray.origin.copy(camera.position);
    const box = rig.preset === 'indoor' ? giFor(scene)?.volumeBox : null;
    plane.constant = -(box ? box.min.y + 0.7 : 0);
    const hit = ray.intersectPlane(plane, focus);
    // looking down at the miniature: full effect; looking along the ground (driving, street level): none
    const down = -ray.direction.y;
    const strength = THREE.MathUtils.smoothstep(down, 0.28, 0.55);
    post.setFocus(hit ? focus : null, strength);
  }

  renderer.info.autoReset = false; // count every pass of a frame, not just the last one

  function tick(timestamp?: number) {
    const now = performance.now();
    const gi0 = giFor(scene);
    // a time-of-day switch or a GI bake runs on frames: never throttle those
    if (pendingPhase || switching || dissolve.holding || (gi0 && gi0.busy)) pacer.poke(now);
    // a skipped frame leaves the canvas as it is; the timer keeps counting, so the next dt covers the gap
    if (pacing && !pacer.shouldRender(now, document.hasFocus())) {
      prevFull = false;
      return;
    }
    const full = !pacing || pacer.fullRate(now);
    const backToBack = full && prevFull; // only then does dt say how fast this device draws
    prevFull = full;
    timer.update(timestamp);
    const dt = Math.min(timer.getDelta(), 0.1);
    const elapsed = timer.getElapsed();
    for (const fn of frameFns) {
      try {
        fn(dt, elapsed);
      } catch (e) {
        console.error('[engine] frame callback failed', e);
      }
    }
    if (!scene || !camera) return;
    // info holds the previous frame's totals while frame callbacks run
    lastFrame.calls = renderer.info.render.calls;
    lastFrame.triangles = renderer.info.render.triangles;
    lastFrame.points = renderer.info.render.points;
    lastFrame.lines = renderer.info.render.lines;
    // GI bakes run before the counters reset, so renderer.info reports the steady-state frame
    const gi = giFor(scene);
    if (backToBack && !(gi && gi.busy) && !dissolve.holding) steadyMs = steadyMs ? steadyMs + (dt * 1000 - steadyMs) * 0.05 : dt * 1000;
    gi?.update(performance.now(), dissolve.holding ? 4 : 1, steadyMs);
    renderer.info.reset();
    rig?.update(camera);
    updateFocus();
    frameNo++;
    if (settings.shadowEvery > 1 && frameNo % settings.shadowEvery === 0) renderer.shadowMap.needsUpdate = true;
    post.render(dt);
    labels.render(scene, camera);
    if (cameraMoved(camera)) pacer.poke(now);
    if (pendingPhase) {
      const next = pendingPhase;
      pendingPhase = null;
      dissolve.capture(renderer.domElement); // the drawing buffer still holds this frame
      void relight(next, true);
    }
    // bake frames are slow on purpose: they must not push the resolution down for good. Capped idle frames are
    // slow on purpose too: only back-to-back frames count.
    if (!backToBack || dissolve.holding || switching || (gi && gi.busy)) return;
    adaptResolution(dt);
    // resolution first (cheap, invisible at a glance); once it is at 1×, consistently slow frames suggest a lower preset
    const lower = lowerQuality(quality);
    if (advice && lower && advised !== quality && pixelRatio <= 1 && budget.sample(dt * 1000, now)) {
      advised = quality;
      adviseQuality(quality, lower);
    }
  }

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  const engine: Engine & { debug: EngineDebug } = {
    renderer,
    canvas: renderer.domElement,
    assets,
    labelLayer: labels.element,
    get quality() {
      return quality;
    },
    get timeOfDay() {
      return tod;
    },
    setTimeOfDay(mode) {
      clock.setMode(mode);
    },
    onTimeOfDay(fn) {
      todListeners.add(fn);
      try {
        fn(tod);
      } catch (e) {
        console.error('[engine] time-of-day listener failed', e);
      }
      return () => todListeners.delete(fn);
    },
    setView(s, c, preset) {
      if (scene && scene !== s) labels.hideScene(scene);
      if (rig && (rig.preset !== preset || scene !== s)) rig.detach();
      scene = s;
      camera = c;
      rig = rigs[preset];
      pacer.poke(performance.now());
      budget.hold(performance.now()); // new shaders compile over the next frames
      rig.apply(s);
      renderer.toneMappingExposure = rig.exposure;
      post.setView(s, c, preset);
      c.aspect = width / height;
      c.updateProjectionMatrix();
      renderer.shadowMap.needsUpdate = true;
    },
    setQuality(q) {
      if (q === quality) return;
      quality = q;
      saveQuality(q);
      applyQuality();
      budget.hold(performance.now());
    },
    onFrame(fn) {
      frameFns.add(fn);
      return () => frameFns.delete(fn);
    },
    pick(ev, cam, objects) {
      const rect = renderer.domElement.getBoundingClientRect();
      ndc.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(ndc, cam);
      const hits = raycaster.intersectObjects(objects, true);
      return hits[0] ?? null;
    },
    fade: (toBlack, ms) => curtain.fade(toBlack, ms),
    setPaused(p) {
      if (p === paused) return;
      paused = p;
      renderer.setAnimationLoop(paused ? null : tick);
      if (!paused) {
        timer.reset();
        pacer.poke(performance.now());
        budget.hold(performance.now());
      }
    },
    debug: {
      async settled(timeoutMs = 600000) {
        const end = performance.now() + timeoutMs;
        while (performance.now() < end) {
          const gi = giFor(scene);
          if (!switching && !pendingPhase && !(gi && gi.busy)) return;
          await new Promise((r) => setTimeout(r, 200));
        }
      },
      gi() {
        const gi = giFor(scene);
        return gi ? { active: gi.active, busy: gi.busy, ...gi.stats } : null;
      },
      frame: () => ({ ...lastFrame }),
      settings: () => ({ ...settings }),
      tune(o) {
        overrides = o && Object.keys(o).length ? { ...o } : null;
        applyQuality();
      },
      giPacing: setGIPacing,
      pacing(on) {
        pacing = on;
        pacer.poke(performance.now());
      },
      autoQuality(on) {
        advice = on;
        advised = null;
        budget.hold(performance.now(), 0);
      },
      adviseNow() {
        const lower = lowerQuality(quality);
        if (lower) adviseQuality(quality, lower);
      },
      pace: () => ({ intervalMs: pacing ? pacer.interval(performance.now(), document.hasFocus()) : 0, fullRate: !pacing || pacer.fullRate(performance.now()) }),
    },
  };
  // keep the exposure in step with the active rig across time-of-day switches
  todListeners.add(() => {
    if (rig) renderer.toneMappingExposure = rig.exposure;
  });

  applyQuality();
  new ResizeObserver(resize).observe(container);
  renderer.setAnimationLoop(tick);
  (window as unknown as { __rltEngine?: unknown }).__rltEngine = engine;
  return engine;
}
