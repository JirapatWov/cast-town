// Post-processing pipeline (pmndrs postprocessing + N8AO):
//   RenderPass → N8AOPostPass → EffectPass(DOF, Bloom, ACES, Grade, Vignette) → EffectPass(SMAA, on LDR, last)
// One look per lighting preset × time of day (AO, bloom, grade, vignette). Bloom thresholds sit above sunlit
// surfaces, so only emissives (lamps, lit windows, screens) and sun glints glow. The depth of field focuses on the
// orbit target for a gentle miniature feel and fades out when the camera looks along the ground (driving).
import * as THREE from 'three';
import {
  BloomEffect, DepthOfFieldEffect, EffectComposer, EffectPass, RenderPass, SMAAEffect, SMAAPreset,
  ToneMappingEffect, ToneMappingMode, VignetteEffect,
} from 'postprocessing';
import { N8AOPostPass } from 'n8ao';
import type { LightingPreset, TimeOfDayPhase } from '../core/types';
import { GradeEffect, type GradeOptions } from './grade-effect';
import type { QualitySettings } from './quality';

interface PresetLook {
  ao: { radius: number; intensity: number; falloff: number };
  bloom: { intensity: number; threshold: number; smoothing: number };
  grade: GradeOptions;
  vignette: { offset: number; darkness: number };
  /** Depth of field: focus range as a fraction of the focus distance (smaller = shallower). */
  dofRange: number;
}

const LOOKS: Record<LightingPreset, Record<TimeOfDayPhase, PresetLook>> = {
  outdoor: {
    day: {
      ao: { radius: 1.8, intensity: 2.4, falloff: 1.0 },
      bloom: { intensity: 0.28, threshold: 2.4, smoothing: 0.6 },
      grade: {
        whiteBalance: [1.0, 1.0, 0.99], lift: [0.012, 0.014, 0.022], gain: [1, 1, 1],
        shadowTint: [0.95, 0.99, 1.06], highlightTint: [1.03, 1.0, 0.97], saturation: 1.0, greenSaturation: 0.68, contrast: 1.06,
      },
      vignette: { offset: 0.38, darkness: 0.32 },
      dofRange: 0.6,
    },
    golden: {
      ao: { radius: 1.8, intensity: 2.2, falloff: 1.0 },
      bloom: { intensity: 0.34, threshold: 2.0, smoothing: 0.6 },
      grade: {
        whiteBalance: [1.02, 1.0, 0.97], lift: [0.014, 0.014, 0.028], gain: [1.01, 1, 0.98],
        shadowTint: [0.88, 1.0, 1.07], highlightTint: [1.08, 1.0, 0.88], saturation: 1.04, greenSaturation: 0.76, contrast: 1.08,
      },
      vignette: { offset: 0.34, darkness: 0.4 },
      dofRange: 0.6,
    },
    night: {
      ao: { radius: 1.6, intensity: 1.8, falloff: 1.0 },
      bloom: { intensity: 0.55, threshold: 0.75, smoothing: 0.5 },
      grade: {
        whiteBalance: [0.98, 1.0, 1.03], lift: [0.014, 0.02, 0.04], gain: [1, 1, 1],
        shadowTint: [0.9, 0.97, 1.14], highlightTint: [1.08, 1.0, 0.88], saturation: 1.04, greenSaturation: 0.72, contrast: 1.06,
      },
      vignette: { offset: 0.3, darkness: 0.5 },
      dofRange: 0.55,
    },
  },
  indoor: {
    day: {
      ao: { radius: 0.9, intensity: 4.2, falloff: 1.0 },
      bloom: { intensity: 0.24, threshold: 2.6, smoothing: 0.7 },
      grade: {
        whiteBalance: [1.03, 1.0, 0.96], lift: [0.012, 0.012, 0.018], gain: [1, 1, 1],
        shadowTint: [0.95, 0.99, 1.05], highlightTint: [1.04, 1.0, 0.95], saturation: 1.04, greenSaturation: 0.72, contrast: 1.06,
      },
      vignette: { offset: 0.32, darkness: 0.38 },
      dofRange: 0.55,
    },
    golden: {
      ao: { radius: 0.9, intensity: 4.0, falloff: 1.0 },
      bloom: { intensity: 0.3, threshold: 2.2, smoothing: 0.7 },
      grade: {
        whiteBalance: [1.01, 1.0, 0.98], lift: [0.012, 0.012, 0.022], gain: [1.01, 1, 0.98],
        shadowTint: [0.9, 0.99, 1.07], highlightTint: [1.07, 1.0, 0.9], saturation: 1.02, greenSaturation: 0.76, contrast: 1.06,
      },
      vignette: { offset: 0.3, darkness: 0.44 },
      dofRange: 0.55,
    },
    night: {
      ao: { radius: 0.8, intensity: 3.4, falloff: 1.0 },
      bloom: { intensity: 0.42, threshold: 1.1, smoothing: 0.6 },
      grade: {
        whiteBalance: [1.0, 1.0, 1.0], lift: [0.012, 0.016, 0.034], gain: [1, 1, 1],
        shadowTint: [0.9, 0.96, 1.14], highlightTint: [1.07, 1.0, 0.9], saturation: 1.02, greenSaturation: 0.72, contrast: 1.05,
      },
      vignette: { offset: 0.28, darkness: 0.5 },
      dofRange: 0.5,
    },
  },
};

const SMAA_PRESETS = { low: SMAAPreset.LOW, medium: SMAAPreset.MEDIUM, high: SMAAPreset.HIGH } as const;

/** ACES Filmic by default: deeper darks and richer warm tones than AgX, which washed the town out (the grades
 *  above hold greens back, ACES pushes them). `?tm=agx|neutral` compares. */
function toneMode(): ToneMappingMode {
  try {
    const p = new URLSearchParams(location.search).get('tm');
    if (p === 'agx') return ToneMappingMode.AGX;
    if (p === 'neutral') return ToneMappingMode.NEUTRAL;
  } catch {
    /* no location */
  }
  return ToneMappingMode.ACES_FILMIC;
}

export interface PostPipeline {
  readonly composer: EffectComposer;
  setView(scene: THREE.Scene, camera: THREE.PerspectiveCamera, preset: LightingPreset): void;
  setPhase(phase: TimeOfDayPhase): void;
  applyQuality(q: QualitySettings): void;
  /** World point the depth of field focuses on (null: the DOF eases out). `strength` 0..1 scales the blur. */
  setFocus(point: THREE.Vector3 | null, strength: number): void;
  setSize(width: number, height: number): void;
  render(dt: number): void;
}

export function createPost(renderer: THREE.WebGLRenderer, width: number, height: number): PostPipeline {
  const composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType, multisampling: 0 });
  let scene = new THREE.Scene();
  let camera = new THREE.PerspectiveCamera();
  let preset: LightingPreset = 'outdoor';
  let phase: TimeOfDayPhase = 'day';
  let quality: QualitySettings | null = null;

  const renderPass = new RenderPass(scene, camera);
  const n8ao = new N8AOPostPass(scene, camera, width, height);
  n8ao.configuration.gammaCorrection = false; // tone mapping happens later, in HDR
  // Transparency-aware AO re-renders every transparent object (window glass, people's rings and hair edges, light
  // pools) in two extra scene passes and walks the whole scene five times per frame — about 60 draw calls on a
  // furnished floor. Those surfaces barely change under AO (glass writes no depth, so the AO behind it is the
  // garden's), so it stays off; turning auto-detection off keeps it off when a transparent object appears.
  n8ao.autoDetectTransparency = false;
  n8ao.configuration.transparencyAware = false;

  const tone = new ToneMappingEffect({ mode: toneMode() });
  const grade = new GradeEffect();
  const vignette = new VignetteEffect({ offset: 0.34, darkness: 0.36 });
  let bloom: BloomEffect | null = null;
  let dof: DepthOfFieldEffect | null = null;
  let mainPass: EffectPass | null = null;
  let smaaPass: EffectPass | null = null;
  const focusTarget = new THREE.Vector3();
  let focusStrength = 0;
  let focusWanted = 0;

  composer.addPass(renderPass);
  composer.addPass(n8ao);

  const look = () => LOOKS[preset][phase];

  /** Effect passes are rebuilt when bloom/DOF/SMAA settings change (effects can't be toggled inside a merged pass). */
  function rebuildEffectPasses() {
    for (const p of [mainPass, smaaPass]) {
      if (!p) continue;
      composer.removePass(p);
      p.dispose();
    }
    const l = look();
    bloom = quality?.bloom
      ? new BloomEffect({
          intensity: l.bloom.intensity,
          luminanceThreshold: l.bloom.threshold,
          luminanceSmoothing: l.bloom.smoothing,
          mipmapBlur: true,
          radius: 0.78,
          levels: quality.bloomLevels,
        })
      : null;
    dof = quality && quality.dof > 0
      ? new DepthOfFieldEffect(camera, { focusDistance: 20, focusRange: 10, bokehScale: 0, resolutionScale: 0.5 })
      : null;
    if (dof) dof.target = focusTarget;
    const effects = [dof, bloom, tone, grade, vignette].filter((e): e is NonNullable<typeof e> => e !== null);
    mainPass = new EffectPass(camera, ...effects);
    smaaPass = new EffectPass(camera, new SMAAEffect({ preset: SMAA_PRESETS[quality?.smaa ?? 'high'] }));
    composer.addPass(mainPass);
    composer.addPass(smaaPass);
  }

  function applyLook() {
    const l = look();
    // Ultra widens the AO (deeper contact shading in corners, under furniture and between buildings)
    const aoScale = quality?.aoScale ?? 1;
    n8ao.configuration.aoRadius = l.ao.radius * aoScale;
    n8ao.configuration.intensity = l.ao.intensity * (1 + (aoScale - 1) * 0.35);
    n8ao.configuration.distanceFalloff = l.ao.falloff;
    if (bloom) {
      bloom.intensity = l.bloom.intensity;
      bloom.luminanceMaterial.threshold = l.bloom.threshold;
      bloom.luminanceMaterial.smoothing = l.bloom.smoothing;
    }
    grade.set({ ...l.grade, grain: quality?.grain ?? 0 });
    vignette.offset = l.vignette.offset;
    vignette.darkness = l.vignette.darkness;
  }

  function updateDof(dt: number) {
    if (!dof || !quality) return;
    // ease the blur in/out so camera flights and view switches never pop
    focusStrength += (focusWanted - focusStrength) * (1 - Math.exp(-dt * 4));
    const d = camera.position.distanceTo(focusTarget);
    dof.cocMaterial.focusRange = Math.max(2.5, d * look().dofRange);
    dof.bokehScale = quality.dof * focusStrength;
  }

  return {
    composer,
    setView(s, c, p) {
      scene = s;
      const cameraChanged = c !== camera;
      camera = c;
      const presetChanged = p !== preset;
      preset = p;
      composer.setMainScene(s);
      composer.setMainCamera(c);
      n8ao.scene = s;
      n8ao.camera = c;
      n8ao.firstFrame();
      if ((presetChanged || cameraChanged) && quality) rebuildEffectPasses();
      applyLook();
    },
    setPhase(p) {
      if (p === phase) return;
      phase = p;
      applyLook();
    },
    applyQuality(q) {
      const rebuild = !quality || quality.bloom !== q.bloom || quality.smaa !== q.smaa || quality.bloomLevels !== q.bloomLevels || (quality.dof > 0) !== (q.dof > 0);
      quality = q;
      n8ao.enabled = q.ao !== 'off';
      if (q.ao !== 'off') {
        n8ao.configuration.halfRes = q.ao === 'half';
        n8ao.setQualityMode(q.aoQuality);
      }
      if (rebuild) rebuildEffectPasses();
      applyLook();
    },
    setFocus(point, strength) {
      if (point) focusTarget.copy(point);
      focusWanted = point ? THREE.MathUtils.clamp(strength, 0, 1) : 0;
    },
    setSize(w, h) {
      composer.setSize(w, h, false);
    },
    render(dt) {
      updateDof(dt);
      composer.render(dt);
    },
  };
}
