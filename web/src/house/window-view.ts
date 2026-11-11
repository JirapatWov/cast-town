// What the dollhouse windows show. Seen from inside, a clear pane looked straight through to the dark lawn behind
// the house, so every window read as a dull grey-green slab. The panes now carry a soft "view card" painted in the
// shader (bright sky over a band of distant trees and a sunlit garden, by height above the floor), several times
// brighter than the walls by day, so windows read as the light sources they are; golden hour warms it, night turns
// it to a deep blue. Curtains get a faint daylight glow on the same clock (light through linen) instead of real
// transmission, which would cost a second scene pass.
import * as THREE from 'three';
import type { TimeOfDayPhase } from '../core/types';

interface ViewLook {
  /** Radiance multiplier of the view card. */
  level: number;
  sky: THREE.Color;
  trees: THREE.Color;
  ground: THREE.Color;
  /** Curtain backlight (emissive intensity of the linen). */
  curtain: number;
}

const LOOKS: Record<TimeOfDayPhase, ViewLook> = {
  day: { level: 1.55, sky: new THREE.Color(0.78, 0.88, 1.0), trees: new THREE.Color(0.3, 0.42, 0.26), ground: new THREE.Color(0.58, 0.66, 0.44), curtain: 0.22 },
  golden: { level: 1.35, sky: new THREE.Color(1.0, 0.8, 0.58), trees: new THREE.Color(0.36, 0.34, 0.2), ground: new THREE.Color(0.66, 0.56, 0.36), curtain: 0.16 },
  night: { level: 0.09, sky: new THREE.Color(0.22, 0.3, 0.55), trees: new THREE.Color(0.05, 0.07, 0.1), ground: new THREE.Color(0.08, 0.1, 0.14), curtain: 0 },
};

const uniforms = {
  uViewLevel: { value: LOOKS.day.level },
  uViewSky: { value: LOOKS.day.sky.clone() },
  uViewTrees: { value: LOOKS.day.trees.clone() },
  uViewGround: { value: LOOKS.day.ground.clone() },
};
const curtains = new Set<THREE.MeshStandardMaterial>();
let curtainGlow = LOOKS.day.curtain;

export function setWindowView(phase: TimeOfDayPhase) {
  const l = LOOKS[phase];
  uniforms.uViewLevel.value = l.level;
  uniforms.uViewSky.value.copy(l.sky);
  uniforms.uViewTrees.value.copy(l.trees);
  uniforms.uViewGround.value.copy(l.ground);
  curtainGlow = l.curtain;
  for (const m of curtains) m.emissiveIntensity = curtainGlow;
}

/** Linen curtains glow faintly by day, as if lit from behind. */
export function curtainLinen<T extends THREE.MeshStandardMaterial>(m: T): T {
  m.emissive.set('#fff1dc');
  m.emissiveIntensity = curtainGlow;
  curtains.add(m);
  return m;
}

export interface ViewGlass extends THREE.MeshPhysicalMaterial {
  /** 1 = the view card shows (floor on show), 0 = plain glass (lit windows of the storeys below). */
  readonly viewOn: { value: number };
}

/** A floor's window glass with the view card (a clone of the palette glass). */
export function viewGlass(base: THREE.MeshPhysicalMaterial): ViewGlass {
  const m = base.clone() as ViewGlass;
  const viewOn = { value: 1 };
  Object.defineProperty(m, 'viewOn', { value: viewOn });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, { uViewOn: viewOn });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vViewPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvViewPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vViewPos;
uniform float uViewLevel;
uniform float uViewOn;
uniform vec3 uViewSky;
uniform vec3 uViewTrees;
uniform vec3 uViewGround;
float rltViewNoise(float x) { return fract(sin(x * 12.9898) * 43758.5453); }`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
if (uViewOn > 0.5) {
  // height above this storey's floor (storeys are 3.2 m apart; the panes sit between 0.4 and 2.5 m)
  float hy = mod(vViewPos.y + 0.2, 3.2) - 0.2;
  float u = vViewPos.x + vViewPos.z;
  float n = rltViewNoise(floor(u * 1.7)) * 0.5 + rltViewNoise(floor(u * 4.3) + 7.0) * 0.3;
  float treeTop = 1.25 + n * 0.45;
  vec3 col = uViewGround * (0.9 + 0.2 * smoothstep(0.4, 1.0, hy));
  col = mix(col, uViewTrees * (0.85 + 0.3 * n), smoothstep(0.95, 1.02, hy));
  col = mix(col, uViewSky * mix(0.9, 1.15, smoothstep(1.4, 2.5, hy)), smoothstep(treeTop - 0.04, treeTop + 0.04, hy));
  totalEmissiveRadiance += col * uViewLevel;
  // the card makes the pane nearly opaque: keep its own diffuse dark (glass scatters little), or at night the room's
  // lamps light it up as a pale slab instead of a dark window with reflections
  diffuseColor.rgb *= 0.12;
  diffuseColor.a = max(diffuseColor.a, 0.9);
}`);
  };
  m.customProgramCacheKey = () => 'rlt-view-glass';
  return m;
}
