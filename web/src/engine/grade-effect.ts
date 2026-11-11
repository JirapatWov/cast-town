// Colour grade for the pmndrs stack, after ACES tone mapping, in a perceptual (gamma 2.2) space:
// white balance, lift/gain, split toning (shadows / highlights), contrast around mid-grey, saturation with a
// separate amount for greens (keeps lawns and foliage natural instead of neon), and a fine luminance-aware grain
// that hides banding in dark skies.
import * as THREE from 'three';
import { Effect } from 'postprocessing';

const fragment = /* glsl */ `
uniform vec3 whiteBalance;
uniform vec3 lift;
uniform vec3 gain;
uniform vec3 shadowTint;
uniform vec3 highlightTint;
uniform float saturation;
uniform float greenSaturation;
uniform float contrast;
uniform float grain;
uniform float grainSeed;

float gradeHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = pow(max(inputColor.rgb * whiteBalance, 0.0), vec3(1.0 / 2.2));
  c = c * gain + lift * (1.0 - c);
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c *= mix(shadowTint, highlightTint, smoothstep(0.1, 0.8, l));
  c = (c - 0.46) * contrast + 0.46;
  // saturation, with greens (hue ~ 70°–170°) on their own dial
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float greenness = clamp((c.g - max(c.r, c.b)) / max(mx - mn, 1e-4), 0.0, 1.0) * step(1e-4, mx - mn);
  float sat = mix(saturation, saturation * greenSaturation, greenness);
  float l2 = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l2), c, sat);
  if (grain > 0.0) {
    float n = gradeHash(gl_FragCoord.xy + grainSeed * 113.0) + gradeHash(gl_FragCoord.yx * 1.37 + grainSeed * 71.0) - 1.0;
    c += n * grain * (1.0 - 0.7 * l2);
  }
  outputColor = vec4(pow(max(c, 0.0), vec3(2.2)), inputColor.a);
}
`;

export type Vec3 = [number, number, number];

export interface GradeOptions {
  /** Linear multipliers before everything else (e.g. [1.03, 1, 0.96] warms). */
  whiteBalance?: Vec3;
  /** Perceptual-space lift of the blacks (0 = none). */
  lift?: Vec3;
  gain?: Vec3;
  /** Perceptual-space multipliers, e.g. [0.97, 1.0, 1.04] for slightly cool shadows. */
  shadowTint?: Vec3;
  highlightTint?: Vec3;
  saturation?: number;
  /** Multiplies `saturation` for green hues. */
  greenSaturation?: number;
  contrast?: number;
  grain?: number;
}

export class GradeEffect extends Effect {
  private target: Required<GradeOptions> = {
    whiteBalance: [1, 1, 1], lift: [0, 0, 0], gain: [1, 1, 1], shadowTint: [1, 1, 1], highlightTint: [1, 1, 1],
    saturation: 1, greenSaturation: 1, contrast: 1, grain: 0,
  };

  constructor(opts: GradeOptions = {}) {
    super('GradeEffect', fragment, {
      uniforms: new Map<string, THREE.Uniform>([
        ['whiteBalance', new THREE.Uniform(new THREE.Vector3(1, 1, 1))],
        ['lift', new THREE.Uniform(new THREE.Vector3(0, 0, 0))],
        ['gain', new THREE.Uniform(new THREE.Vector3(1, 1, 1))],
        ['shadowTint', new THREE.Uniform(new THREE.Vector3(1, 1, 1))],
        ['highlightTint', new THREE.Uniform(new THREE.Vector3(1, 1, 1))],
        ['saturation', new THREE.Uniform(1)],
        ['greenSaturation', new THREE.Uniform(1)],
        ['contrast', new THREE.Uniform(1)],
        ['grain', new THREE.Uniform(0)],
        ['grainSeed', new THREE.Uniform(0)],
      ]),
    });
    this.set(opts);
  }

  set(opts: GradeOptions): void {
    const u = this.uniforms;
    const v3 = (name: string, c: Vec3 | undefined) => {
      if (c) (u.get(name)!.value as THREE.Vector3).set(c[0], c[1], c[2]);
    };
    v3('whiteBalance', opts.whiteBalance);
    v3('lift', opts.lift);
    v3('gain', opts.gain);
    v3('shadowTint', opts.shadowTint);
    v3('highlightTint', opts.highlightTint);
    for (const k of ['saturation', 'greenSaturation', 'contrast', 'grain'] as const) {
      if (opts[k] !== undefined) u.get(k)!.value = opts[k];
    }
    Object.assign(this.target, opts);
  }

  update(): void {
    // animated grain (a static pattern reads as dirt on the lens)
    if (this.target.grain > 0) this.uniforms.get('grainSeed')!.value = Math.random() * 10;
  }
}
