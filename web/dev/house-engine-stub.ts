// Minimal local Engine for the house dev harness (NOT the product engine — that lives in web/src/engine).
// WebGLRenderer + pmndrs postprocessing (N8AO → Bloom → AgX → Vignette → SMAA) + CSS2D label layer,
// close enough to the real engine's "indoor" preset that harness screenshots are representative.
import * as THREE from 'three';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import {
  BloomEffect, EffectComposer, EffectPass, RenderPass, SMAAEffect, SMAAPreset,
  ToneMappingEffect, ToneMappingMode, VignetteEffect, HueSaturationEffect, BrightnessContrastEffect,
} from 'postprocessing';
import { N8AOPostPass } from 'n8ao';
import type { Engine, LightingPreset, Quality } from '../src/core/types';
import { createAssets } from '../src/engine/assets';

export function createStubEngine(container: HTMLElement, opts: { quality?: Quality; ao?: boolean } = {}): Engine {
  const renderer = new THREE.WebGLRenderer({ powerPreference: 'high-performance', antialias: false, stencil: false });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  const canvas = renderer.domElement;
  Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', display: 'block' });
  container.appendChild(canvas);

  const css2d = new CSS2DRenderer();
  const labelLayer = css2d.domElement;
  Object.assign(labelLayer.style, { position: 'absolute', inset: '0', pointerEvents: 'none', overflow: 'hidden' });
  container.appendChild(labelLayer);

  const fadeEl = document.createElement('div');
  Object.assign(fadeEl.style, { position: 'absolute', inset: '0', background: '#000', opacity: '0', pointerEvents: 'none', transition: 'opacity 300ms ease' });
  container.appendChild(fadeEl);

  const assets = createAssets();
  let scene = new THREE.Scene();
  let camera = new THREE.PerspectiveCamera(40, 1, 0.1, 500);
  let composer: EffectComposer | null = null;
  let ao: N8AOPostPass | null = null;

  /** (Re)build the post stack for a scene/camera pair — N8AO binds both at construction. */
  function buildComposer(s: THREE.Scene, c: THREE.PerspectiveCamera) {
    composer?.dispose();
    composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType, multisampling: 0 });
    composer.addPass(new RenderPass(s, c));
    if (opts.ao !== false) {
      ao = new N8AOPostPass(s, c, 1, 1);
      Object.assign(ao.configuration, { aoRadius: 0.6, distanceFalloff: 1.0, intensity: 2.6, halfRes: true, gammaCorrection: false });
      ao.setQualityMode('Medium');
      composer.addPass(ao);
    }
    composer.addPass(new EffectPass(c,
      new BloomEffect({ intensity: 0.35, luminanceThreshold: 1.0, luminanceSmoothing: 0.25, mipmapBlur: true, radius: 0.7 }),
      new ToneMappingEffect({ mode: ToneMappingMode.AGX }),
      new HueSaturationEffect({ saturation: 0.08 }),
      new BrightnessContrastEffect({ contrast: 0.05 }),
      new VignetteEffect({ offset: 0.35, darkness: 0.32 }),
    ));
    composer.addPass(new EffectPass(c, new SMAAEffect({ preset: SMAAPreset.HIGH })));
  }

  function resize() {
    const w = container.clientWidth || innerWidth;
    const h = container.clientHeight || innerHeight;
    renderer.setSize(w, h, false);
    composer?.setSize(w, h);
    css2d.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  addEventListener('resize', resize);

  const frameFns = new Set<(dt: number, elapsed: number) => void>();
  const timer = new THREE.Timer();
  let paused = false;
  let elapsed = 0;
  renderer.setAnimationLoop((t) => {
    timer.update(t);
    const dt = Math.min(timer.getDelta(), 0.1);
    elapsed += dt;
    if (paused) return;
    for (const fn of frameFns) fn(dt, elapsed);
    if (composer) composer.render(dt);
    else renderer.render(scene, camera);
    css2d.render(scene, camera);
  });

  const raycaster = new THREE.Raycaster();
  const engine: Engine = {
    renderer, canvas, assets, labelLayer,
    get quality() { return opts.quality ?? 'high'; },
    setView(s: THREE.Scene, c: THREE.PerspectiveCamera, preset: LightingPreset) {
      scene = s; camera = c;
      buildComposer(s, c);
      if (preset === 'outdoor' && ao) Object.assign(ao.configuration, { aoRadius: 1.2, intensity: 2.2 });
      resize();
    },
    setQuality() { /* stub: fixed quality */ },
    onFrame(fn) { frameFns.add(fn); return () => frameFns.delete(fn); },
    pick(ev, cam, objects) {
      const r = canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
      raycaster.setFromCamera(ndc, cam);
      return raycaster.intersectObjects(objects, true)[0] ?? null;
    },
    fade(toBlack, ms = 300) {
      fadeEl.style.transition = `opacity ${ms}ms ease`;
      fadeEl.style.opacity = toBlack ? '1' : '0';
      return new Promise((res) => setTimeout(res, ms));
    },
    setPaused(p) { paused = p; },
  };
  resize();
  return engine;
}
