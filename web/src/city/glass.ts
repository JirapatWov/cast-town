// Window glass for project buildings: a parallax "interior mapping" shader (every window looks into a real-looking
// room with depth: back wall, side walls, floor, ceiling, furniture, curtains or blinds) under a physically based
// glass surface (sky reflections with Fresnel, a slight per-pane tilt so panes don't mirror as one sheet).
// Room lights are per storey: uFloorGlow[floor] × the window's own lit value, so busy floors light up warm.
//
// Per-vertex data (written by facade.ts / the style builders):
//   aWin  = [tile, lit]          tile 6 = office (strip lights, carpet, blinds), otherwise a home
//   aRoom = [w, h, sill, side]   window size (m), room floor below the window bottom, room width beyond each jamb
//   uv    = 0..1 across the pane
import * as THREE from 'three';
import { MAX_FLOORS, STOREY_H } from '../../../shared/house-plan';

export const FLOOR_SLOTS = MAX_FLOORS + 1;

const VERT_PARS = /* glsl */ `
attribute vec2 aWin;
attribute vec4 aRoom;
uniform float uFloorGlow[${FLOOR_SLOTS}];
uniform vec3 uFloorTint[${FLOOR_SLOTS}];
uniform float uBaseY;
uniform float uStoreyH;
uniform float uFloors;
varying vec3 vRay;
varying vec2 vRoomP;
varying vec4 vRoom;
varying vec3 vSeedPos;
varying float vLamp;
varying float vOffice;
varying vec3 vTint;
`;

const VERT_MAIN = /* glsl */ `
{
  vec3 nObj = normalize(normal);
  vec3 tObj = normalize(vec3(nObj.z, 0.0, -nObj.x));
  vec3 wPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
  vec3 V = wPos - cameraPosition;
  vec3 tW = normalize(mat3(modelMatrix) * tObj);
  vec3 bW = normalize(mat3(modelMatrix) * vec3(0.0, 1.0, 0.0));
  vec3 nW = normalize(mat3(modelMatrix) * nObj);
  vRay = vec3(dot(V, tW), dot(V, bW), dot(V, nW));
  vRoomP = uv * aRoom.xy;
  vRoom = aRoom;
  vSeedPos = position - tObj * vRoomP.x - vec3(0.0, vRoomP.y, 0.0);
  float fi = clamp(floor((position.y - uBaseY) / uStoreyH + 0.02), 0.0, uFloors - 1.0);
  int idx = int(fi);
  vLamp = aWin.y * uFloorGlow[idx];
  vTint = uFloorTint[idx];
  vOffice = step(5.5, aWin.x) * step(aWin.x, 6.5);
}
`;

const FRAG_PARS = /* glsl */ `
uniform float uDay;
uniform float uNight;
uniform float uSeed;
uniform float uReflect;
uniform float uHover;
varying vec3 vRay;
varying vec2 vRoomP;
varying vec4 vRoom;
varying vec3 vSeedPos;
varying float vLamp;
varying float vOffice;
varying vec3 vTint;
float rltHash(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
vec3 rltPick(float s, vec3 a, vec3 b, vec3 c, vec3 d) {
  return s < 0.25 ? a : s < 0.5 ? b : s < 0.75 ? c : d;
}
`;

// Interior radiance through the pane; written into totalEmissiveRadiance (the glass itself is nearly black).
const FRAG_INTERIOR = /* glsl */ `
vec3 rltInterior;
{
  vec3 rd = normalize(vRay);
  rd.z = min(rd.z, -0.06);
  float w = vRoom.x, h = vRoom.y, sill = vRoom.z, mx = vRoom.w;
  float s0 = rltHash(floor(vSeedPos * 2.0 + 0.5) + uSeed);
  float s1 = fract(s0 * 13.37 + 0.11), s2 = fract(s0 * 71.9 + 0.37), s3 = fract(s0 * 151.7 + 0.73), s4 = fract(s0 * 311.3 + 0.19);
  // a quarter of the homes' lamps are cool (LED / daylight bulbs), the rest warm incandescent
  vec3 lampTint = mix(vTint, vec3(0.72, 0.8, 0.95), step(0.75, s4) * (1.0 - vOffice) * step(0.58, vTint.g));
  float depth = mix(3.2, 5.2, s1) + vOffice * 3.0;
  float floorY = -sill;
  float ceilY = floorY + 2.75;
  vec2 p = vRoomP;
  float tx = rd.x > 0.0 ? (w + mx - p.x) / rd.x : (-mx - p.x) / min(rd.x, -1e-4);
  float ty = rd.y > 0.0 ? (ceilY - p.y) / rd.y : (floorY - p.y) / min(rd.y, -1e-4);
  float tz = -depth / rd.z;
  float t = min(tx, min(ty, tz));
  vec3 hit = vec3(p, 0.0) + rd * t;
  float above = hit.y - floorY;

  vec3 wallHome = rltPick(s2, vec3(0.78, 0.72, 0.62), vec3(0.62, 0.68, 0.58), vec3(0.80, 0.62, 0.50), vec3(0.62, 0.66, 0.72));
  vec3 wallCol = mix(wallHome, vec3(0.70, 0.72, 0.74), vOffice);
  vec3 albedo;
  bool isCeil = false;
  if (t == tz) {
    albedo = wallCol;
    // furniture against the back wall: a low sideboard / sofa, a tall shelf, a picture
    float fx0 = mix(-mx * 0.6, w * 0.4, s3), fx1 = fx0 + 1.1 + 1.6 * s4;
    vec3 furn = rltPick(s4, vec3(0.30, 0.20, 0.13), vec3(0.42, 0.44, 0.47), vec3(0.55, 0.36, 0.26), vec3(0.20, 0.27, 0.33));
    if (vOffice > 0.5) {
      // desks + monitors in rows, a glass partition line
      float row = fract(hit.x / 1.6);
      if (above < 0.75 && row > 0.08 && row < 0.92) albedo = vec3(0.30, 0.31, 0.33);
      if (above > 0.78 && above < 1.15 && abs(row - 0.5) < 0.18) albedo = vec3(0.06, 0.07, 0.09);
    } else {
      if (above < 0.82 && hit.x > fx0 && hit.x < fx1) albedo = furn * (above > 0.74 ? 1.25 : 1.0);
      float shelfX = fx1 + 0.5 + 0.8 * s1;
      if (above < 2.05 && hit.x > shelfX && hit.x < shelfX + 0.85) {
        float sh = fract(above / 0.42);
        albedo = sh < 0.12 ? vec3(0.32, 0.22, 0.15) : rltPick(fract(floor(hit.x * 9.0) * 0.37 + s2), vec3(0.55, 0.25, 0.2), vec3(0.2, 0.3, 0.45), vec3(0.75, 0.68, 0.52), vec3(0.25, 0.4, 0.3));
      }
      float picX = (fx0 + fx1) * 0.5;
      if (abs(above - 1.62) < 0.32 && abs(hit.x - picX) < 0.42) {
        albedo = (abs(above - 1.62) > 0.27 || abs(hit.x - picX) > 0.37) ? vec3(0.08) : rltPick(s3, vec3(0.85, 0.55, 0.35), vec3(0.35, 0.55, 0.65), vec3(0.9, 0.85, 0.7), vec3(0.45, 0.6, 0.4));
      }
    }
  } else if (t == ty) {
    if (rd.y < 0.0) {
      // floor: oak planks at home, carpet tiles in offices
      float board = floor(hit.x / 0.19);
      float plank = 0.86 + 0.14 * fract(sin(board * 12.9898 + floor(hit.z / 1.3 + fract(board * 0.37)) * 4.1) * 43758.5);
      albedo = mix(vec3(0.46, 0.32, 0.21) * plank, vec3(0.34, 0.35, 0.37), vOffice);
    } else {
      albedo = vec3(0.86, 0.85, 0.82);
      isCeil = true;
    }
  } else {
    albedo = wallCol * 0.82;
  }

  // daylight falls off away from the window; the ceiling only sees bounce light
  float depthK = clamp(-hit.z / depth, 0.0, 1.0);
  float dayK = uDay * mix(1.0, 0.32, depthK) * (isCeil ? 0.55 : 1.0);
  // ceiling lamp (home: pendant in the middle; office: strip rows)
  vec3 lampPos = vec3(w * 0.5, ceilY - 0.3, -depth * 0.42);
  vec3 dl = hit - lampPos;
  float lampK = vLamp * (1.25 / (1.0 + dot(dl, dl) * 0.32)) + uHover * 0.12;
  rltInterior = albedo * (vec3(dayK) + lampTint * lampK);
  if (isCeil) {
    float fixture = vOffice > 0.5 ? step(abs(fract(hit.z / 1.8) - 0.5), 0.07) * step(abs(fract(hit.x / 1.6) - 0.5), 0.3)
                                  : step(length(hit.xz - lampPos.xz), 0.24);
    rltInterior += lampTint * vLamp * fixture * 3.2;
  }

  // window dressing just behind the glass: side curtains, a sheer, or blinds part-way down
  float tc = -0.1 / rd.z;
  vec2 cp = p + rd.xy * tc;
  float kind = fract(s0 * 5.31 + 0.5);
  if (vOffice > 0.5) {
    float blindTo = h * (1.0 - 0.25 * s3); // raised: at most a quarter of the pane
    if (kind < 0.35 && cp.y > blindTo) {
      float slat = 0.75 + 0.25 * step(0.5, fract(cp.y / 0.06));
      rltInterior = vec3(0.72, 0.73, 0.74) * slat * (uDay * 2.2 + lampTint * vLamp * 0.45);
    }
    rltInterior *= vec3(0.8, 0.92, 0.94);
  } else if (kind < 0.62) {
    float cw = (0.14 + 0.22 * s4) * w;
    if (cp.x < cw || cp.x > w - cw) {
      float fold = 0.72 + 0.28 * sin(cp.x * 31.0 + s1 * 6.0);
      vec3 cc = rltPick(s3, vec3(0.86, 0.80, 0.70), vec3(0.62, 0.68, 0.58), vec3(0.72, 0.50, 0.42), vec3(0.90, 0.88, 0.84));
      rltInterior = cc * fold * (uDay * 2.6 + lampTint * vLamp * 0.85);
    }
  } else if (kind < 0.78) {
    // a sheer drawn across one half only: the room still shows through the other
    if ((s1 < 0.5) == (cp.x < w * 0.5)) rltInterior = mix(rltInterior, vec3(0.92, 0.9, 0.86) * (uDay * 2.4 + lampTint * vLamp * 0.8), 0.5);
  } else if (kind < 0.9) {
    float blindTo = h * (0.75 + 0.25 * s2);
    if (cp.y > blindTo) rltInterior = vec3(0.84, 0.8, 0.72) * (0.85 + 0.15 * step(0.5, fract(cp.y / 0.05))) * (uDay * 2.4 + lampTint * vLamp * 0.6);
  }
  // lamp light scattered by the pane and dressing: lit windows still read when the room is only a few pixels
  // (more so at night, when a lit window is what the eye picks out from afar)
  rltInterior += lampTint * vLamp * (0.05 + 0.22 * uNight);
}
`;

export class ProjectGlassMaterial extends THREE.MeshStandardMaterial {
  readonly floorGlow = { value: new Array<number>(FLOOR_SLOTS).fill(0.35) };
  readonly floorTint = { value: Array.from({ length: FLOOR_SLOTS }, () => new THREE.Color(1.0, 0.72, 0.42)) };
  readonly baseY = { value: 0 };
  readonly storeyH = { value: STOREY_H };
  readonly floors = { value: 1 };
  readonly day = { value: 0.075 };
  /** 0 = day … 1 = night (window scatter; set with daylight()). */
  readonly night = { value: 0 };
  readonly seed = { value: 0 };
  readonly reflect = { value: 2.0 };
  readonly hover = { value: 0 };

  constructor(seed = 0) {
    super({ color: 0xffffff, roughness: 0.04, metalness: 0.0 });
    this.name = 'projectGlass';
    this.seed.value = seed % 1000;
    this.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, {
        uFloorGlow: this.floorGlow, uFloorTint: this.floorTint, uBaseY: this.baseY, uStoreyH: this.storeyH, uFloors: this.floors,
        uDay: this.day, uNight: this.night, uSeed: this.seed, uReflect: this.reflect, uHover: this.hover,
      });
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
        .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>\n${VERT_MAIN}`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
        .replace('#include <map_fragment>', `#include <map_fragment>\n${FRAG_INTERIOR}\ndiffuseColor.rgb = vec3(0.015);`)
        .replace(
          '#include <normal_fragment_maps>',
          // a slight random tilt per pane: neighbouring windows reflect slightly different bits of sky
          `#include <normal_fragment_maps>
          {
            float pa = rltHash(floor(vSeedPos * 2.0 + 0.5) + uSeed + 17.0) - 0.5;
            float pb = rltHash(floor(vSeedPos * 2.0 + 0.5) + uSeed + 41.0) - 0.5;
            normal = normalize(normal + vec3(pa, pb, 0.0) * 0.07);
          }`,
        )
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += rltInterior;')
        .replace('#include <lights_fragment_maps>', '#include <lights_fragment_maps>\nradiance *= uReflect * mix(vec3(1.0), vec3(0.95, 1.2, 1.25), vOffice);')
        // a point light (street lamp, porch) glinting in near-mirror glass can exceed half-float range; inf would
        // turn into NaN blocks in bloom
        .replace('#include <dithering_fragment>', 'gl_FragColor.rgb = min(gl_FragColor.rgb, vec3(2000.0));\n#include <dithering_fragment>');
    };
    this.customProgramCacheKey = () => 'rlt-project-glass';
  }

  /** Time of day: daylight in the rooms fades out and lit windows glow brighter as night falls. */
  daylight(night: number): void {
    this.night.value = night;
    // by day the rooms behind the glass read (darker than outside, with depth), the sky reflects on top
    this.day.value = THREE.MathUtils.lerp(0.075, 0.003, night);
    this.reflect.value = THREE.MathUtils.lerp(1.7, 1.2, night);
  }

  /** Lamp level and colour of one storey's rooms (0 = dark, ~0.35 = lived-in, ~1.5 = busy). */
  setFloor(floor: number, glow: number, tint?: THREE.Color): void {
    const i = Math.max(0, Math.min(FLOOR_SLOTS - 1, floor));
    this.floorGlow.value[i] = glow;
    if (tint) this.floorTint.value[i].copy(tint);
  }
}
