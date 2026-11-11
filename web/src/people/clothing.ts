// Procedural clothing for the underwear base bodies. Zones come from the bind-pose vertex position
// (the `position` attribute before skinning), with thresholds measured from each body's skeleton:
// shoes (sole, laces), trousers / skirt (+ denim twill and fades, fly seam), belt, and a top in one of
// six styles (tee, shirt, cardigan, hoodie, jacket, sweater) with sleeves, collars, plackets, pockets.
// The garment is also inflated a few millimeters along the bind normal so it reads as cloth, the skin
// normal map is flattened under cloth, and a soft sheen rim is added. Skin keeps its texture.
import * as THREE from 'three';
import type { Look, TopStyle } from './appearance';
import type { BodyMetrics } from './library';

const STYLE_ID: Record<TopStyle, number> = { tee: 0, shirt: 1, cardigan: 2, hoodie: 3, jacket: 4, sweater: 5 };

export function applyClothing(mat: THREE.MeshStandardMaterial, look: Look, m: BodyMetrics) {
  const style = STYLE_ID[look.top.style];
  const shortSleeve = m.shoulderX + 0.42 * (m.elbowX - m.shoulderX);
  const longSleeve = m.wristX - 0.028;
  const sleeveEnd = look.top.longSleeves ? longSleeve : shortSleeve;
  const shoeTop = m.ankleY + (look.shoes.sneaker ? 0.042 : 0.032);
  const untuckDrop = style === 4 ? 0.11 : style === 1 && look.top.tucked ? 0 : 0.075;
  const topHem = m.waistY - untuckDrop;
  const uniforms = {
    uZ0: { value: new THREE.Vector4(shoeTop, m.kneeY, m.waistY, m.neckY) },
    uZ1: { value: new THREE.Vector4(m.shoulderX, sleeveEnd, topHem, m.kneeY + 0.06) },
    uZ2: { value: new THREE.Vector4(m.thighX, m.elbowX, m.chestY, m.hipY) },
    uStyle: { value: new THREE.Vector4(style, look.top.tucked && style === 1 ? 1 : 0, look.bottom.denim ? 1 : 0, look.bottom.skirt ? 1 : 0) },
    uSneaker: { value: look.shoes.sneaker ? 1 : 0 },
    uTopCol: { value: look.top.color.clone() },
    uInnerCol: { value: look.top.inner.clone() },
    uBotCol: { value: look.bottom.color.clone() },
    uShoeCol: { value: look.shoes.color.clone() },
    uSoleCol: { value: look.shoes.sole.clone() },
    uSkinTint: { value: look.skin.tint.clone() },
  };
  mat.userData.cloth = uniforms;
  mat.customProgramCacheKey = () => 'rlt-cloth-v4';
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERT_MAIN}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
      .replace('#include <map_fragment>', `#include <map_fragment>\n${FRAG_COLOR}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${FRAG_ROUGH}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${FRAG_NORMAL}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${FRAG_SHEEN}`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>\n${FRAG_SKIN}`);
  };
  mat.needsUpdate = true;
}

// ── GLSL ──────────────────────────────────────────────────────────────────────────────────────
const SHARED = /* glsl */ `
uniform vec4 uZ0; // shoeTop, kneeY, waistY, neckY
uniform vec4 uZ1; // shoulderX, sleeveEnd, topHem, skirtHem
uniform vec4 uZ2; // footX, elbowX, chestY, hipY
uniform vec4 uStyle; // topStyle, tucked, denim, skirt
varying vec3 vBind;
`;

const VERT_PARS = SHARED;

const VERT_MAIN = /* glsl */ `
vBind = position;
{
  float y = position.y, ax = abs(position.x), zf = position.z;
  float neckL = uZ0.w - 0.02;
  float nearNeck = 1.0 - smoothstep(0.10, 0.15, ax);
  float topV = smoothstep(uZ1.z - 0.015, uZ1.z + 0.01, y) * (1.0 - smoothstep(uZ1.y - 0.015, uZ1.y + 0.005, ax))
             * (1.0 - nearNeck * smoothstep(neckL - 0.03, neckL, y));
  float armV = smoothstep(uZ1.x - 0.02, uZ1.x + 0.04, ax) * smoothstep(uZ2.z - 0.2, uZ2.z - 0.12, y);
  float shoeV = 1.0 - smoothstep(uZ0.x - 0.01, uZ0.x + 0.015, y);
  float botV = (1.0 - shoeV) * (1.0 - smoothstep(uZ0.z - 0.02, uZ0.z + 0.005, y)) * (1.0 - armV);
  int st = int(uStyle.x + 0.5);
  float loose = (st == 3 || st == 4 || st == 5) ? 1.6 : (st == 2 ? 1.3 : 1.0);
  float inflate = topV * mix((0.006 + 0.007 * (1.0 - smoothstep(uZ0.z, uZ0.z + 0.28, y))) * loose, 0.005 * loose, armV)
                + botV * (0.005 + 0.011 * (1.0 - smoothstep(uZ0.x, uZ0.y, y))) * (uStyle.w > 0.5 && y > uZ1.w ? 1.4 : 1.0)
                + shoeV * 0.012 * smoothstep(0.0, 0.02, y);
  // hoodie: the hood bunches up behind the neck
  if (st == 3) {
    float hood = (1.0 - smoothstep(-0.02, 0.03, zf)) * nearNeck * smoothstep(neckL - 0.06, neckL - 0.01, y) * (1.0 - smoothstep(neckL + 0.04, neckL + 0.1, y));
    inflate += hood * 0.03;
  }
  transformed += normal * inflate;
}
`;

const FRAG_PARS = /* glsl */ `
${SHARED}
uniform float uSneaker;
uniform vec3 uTopCol, uInnerCol, uBotCol, uShoeCol, uSoleCol, uSkinTint;
float rltHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float rltNoise(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(rltHash(i), rltHash(i + vec3(1,0,0)), f.x), mix(rltHash(i + vec3(0,1,0)), rltHash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(rltHash(i + vec3(0,0,1)), rltHash(i + vec3(1,0,1)), f.x), mix(rltHash(i + vec3(0,1,1)), rltHash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
// anti-aliased step: 0 below edge, 1 above
float aaStep(float edge, float v) { float w = max(fwidth(v), 1e-4) * 0.9; return smoothstep(edge - w, edge + w, v); }
float aaBand(float a, float b, float v) { return aaStep(a, v) * (1.0 - aaStep(b, v)); }
// fade high-frequency patterns out when they would alias
float detailFade(float freqCoord) { return clamp(1.0 - fwidth(freqCoord) * 0.9, 0.0, 1.0); }
`;

const FRAG_COLOR = /* glsl */ `
float clothM = 0.0, shoeLeather = 0.0, beltM = 0.0, metalM = 0.0, foldH = 0.0;
{
  vec3 skin = diffuseColor.rgb * uSkinTint;
  float y = vBind.y, ax = abs(vBind.x), zf = vBind.z;
  float shoeTop = uZ0.x, knee = uZ0.y, waist = uZ0.z, neck = uZ0.w;
  float sleeveEnd = uZ1.y, topHem = uZ1.z, skirtHem = uZ1.w;
  float footX = uZ2.x, elbowX = uZ2.y, chest = uZ2.z, hip = uZ2.w;
  int st = int(uStyle.x + 0.5);
  bool tucked = uStyle.y > 0.5, denim = uStyle.z > 0.5, skirt = uStyle.w > 0.5;
  float armM = aaStep(uZ1.x + 0.02, ax) * aaStep(chest - 0.16, y); // arms (T-pose) — never the hips
  float frontM = smoothstep(-0.005, 0.045, zf);
  float nearNeck = 1.0 - smoothstep(0.10, 0.15, ax);

  // ── neckline (front dips; arms/shoulders are not limited by it) ──
  float centerFront = frontM * (1.0 - smoothstep(0.015, 0.085, ax));
  float dip = st == 1 ? 0.06 : (st == 2 || st == 4) ? 0.02 : 0.028;
  float neckLine = neck - 0.02 - dip * centerFront;
  float neckLimit = mix(neckLine, 9.0, 1.0 - nearNeck);

  float n1 = rltNoise(vBind * 60.0), n2 = rltNoise(vBind * 8.0);
  float fabric = 0.95 + 0.07 * n1 * detailFade(vBind.y * 60.0) + 0.08 * (n2 - 0.5);

  // ── shoes ──
  float shoeM = 1.0 - aaStep(shoeTop, y);
  float soleTop = mix(0.018, 0.03, uSneaker);
  float soleM = 1.0 - aaStep(soleTop, y);
  float legX = abs(ax - footX);
  float toe = smoothstep(0.06, 0.13, zf);                    // front of the foot
  float heel = 1.0 - smoothstep(-0.06, -0.03, zf);           // back of the foot
  vec3 shoe = uShoeCol;
  // sneakers: toe cap + heel tab in the sole colour, a side panel, laces over the instep
  float panel = uSneaker * aaBand(soleTop + 0.008, soleTop + 0.03, y) * smoothstep(0.02, 0.05, ax - footX + 0.06) * (1.0 - toe);
  shoe = mix(shoe, mix(uShoeCol, uSoleCol, 0.55), panel * 0.6);
  shoe = mix(shoe, uSoleCol, uSneaker * max(toe * (1.0 - aaStep(soleTop + 0.022, y)), heel * aaBand(soleTop, soleTop + 0.05, y)) * 0.85);
  float laces = uSneaker * aaStep(0.05, y) * (1.0 - aaStep(0.016, legX)) * aaStep(0.02, zf) * (1.0 - toe) * step(0.5, fract(y * 80.0));
  shoe = mix(shoe, mix(uSoleCol, vec3(1.0), 0.4), laces * 0.75);
  // leather: polished toe highlight + welt line
  shoe *= mix(1.0, 1.0 + 0.25 * toe, 1.0 - uSneaker);
  shoe = mix(shoe, uSoleCol * 1.6, (1.0 - uSneaker) * aaBand(soleTop, soleTop + 0.005, y));
  shoe = mix(shoe, uSoleCol, soleM);
  shoe = mix(shoe, shoe * 0.78, (1.0 - aaStep(0.006, abs(y - shoeTop + 0.005))) * 0.6); // collar

  // ── bottoms ──
  float botM = (1.0 - shoeM) * (1.0 - aaStep(waist, y)) * (1.0 - armM);
  vec3 bot = uBotCol * fabric;
  if (denim) {
    float tw = sin((vBind.y * 0.8 + ax * (vBind.x > 0.0 ? 1.0 : -1.0)) * 1300.0) * 0.5 + 0.5;
    bot *= 0.93 + 0.1 * tw * detailFade(vBind.y * 1300.0 * 0.15);
    float fade = frontM * smoothstep(knee - 0.25, knee + 0.05, y) * (1.0 - smoothstep(knee + 0.12, hip - 0.05, y));
    fade = fade * (0.55 + 0.45 * n2) + 0.25 * frontM * smoothstep(hip - 0.25, hip, y) * (1.0 - smoothstep(hip, waist, y));
    bot = mix(bot, bot * vec3(1.5, 1.55, 1.6) + 0.05, clamp(fade, 0.0, 1.0) * 0.45);
  }
  // fly seam + hem shadow + pocket curves
  bot *= 1.0 - 0.35 * (1.0 - aaStep(0.004, ax)) * frontM * aaBand(hip - 0.14, waist, y);
  bot *= 1.0 - 0.25 * aaBand(shoeTop, shoeTop + 0.012, y);
  float pocket = abs(length(vec2(ax - 0.06, y - waist)) - 0.075);
  bot *= 1.0 - 0.3 * (1.0 - aaStep(0.003, pocket)) * frontM * aaStep(0.06, ax) * step(y, waist);
  if (skirt) {
    float tights = 1.0 - aaStep(skirtHem, y);
    bot = mix(bot, mix(skin, vec3(0.085, 0.08, 0.09), 0.9), tights);
    bot *= 1.0 - 0.3 * aaBand(skirtHem, skirtHem + 0.012, y);
  }
  // belt (tucked shirts)
  beltM = tucked ? aaBand(waist - 0.036, waist, y) * (1.0 - armM) : 0.0;
  float buckle = beltM * frontM * (1.0 - aaStep(0.024, ax));
  metalM = buckle;
  bot = mix(bot, mix(vec3(0.11, 0.075, 0.05), vec3(0.75, 0.62, 0.38), buckle), beltM);

  // ── top ──
  float topM = aaStep(topHem, y) * (1.0 - aaStep(sleeveEnd, ax)) * (1.0 - aaStep(neckLimit, y));
  vec3 top = uTopCol * fabric;
  vec3 inner = uInnerCol * (0.97 + 0.04 * n1);
  float ribbed = (st == 2 || st == 5 || st == 3) ? 1.0 : 0.0;
  top *= 1.0 - ribbed * 0.05 * (sin(vBind.x * 900.0) * 0.5 + 0.5) * detailFade(vBind.x * 900.0 * 0.15);
  // hem band, cuffs, collar rib
  float hemBand = aaBand(topHem, topHem + (ribbed > 0.5 ? 0.05 : 0.014), y) * (1.0 - armM);
  float cuff = aaBand(sleeveEnd - (ribbed > 0.5 || st == 1 ? 0.045 : 0.014), sleeveEnd, ax);
  float collarRib = nearNeck * aaBand(neckLine - 0.016, neckLine, y);
  top *= 1.0 - 0.12 * max(max(hemBand, cuff), collarRib * (st == 1 ? 0.0 : 1.0));
  // under-hem shadow on the trousers (garments overlap)
  bot *= 1.0 - 0.35 * (1.0 - topM) * aaBand(topHem - 0.018, topHem, y) * (1.0 - armM);
  // skin just past a sleeve gets a soft shadow
  skin *= 1.0 - 0.3 * aaBand(sleeveEnd, sleeveEnd + 0.02, ax) * aaStep(1.2, y);
  vec3 collarCol = top;
  float collar = 0.0;
  if (st == 1 || st == 4) {
    // shirt / jacket collar standing around the neck, open at the front
    collar = nearNeck * aaBand(neckLine, neckLine + 0.045, y) * (1.0 - centerFront * (1.0 - aaStep(0.02, ax)));
    collar *= (1.0 - aaStep(0.09, ax));
    collarCol = (st == 4 ? uTopCol * 0.92 : uTopCol * 1.04);
  }
  if (st == 1) {
    // placket + buttons
    float plk = frontM * (1.0 - aaStep(0.009, ax)) * aaBand(topHem, neckLine, y);
    top *= 1.0 - 0.12 * plk;
    float btn = frontM * (1.0 - aaStep(0.0055, length(vec2(ax, (fract((y - topHem) / 0.08) - 0.5) * 0.08)))) * aaBand(topHem + 0.03, neckLine - 0.02, y);
    top = mix(top, vec3(0.93, 0.91, 0.87), btn);
  }
  if (st == 2 || st == 4) {
    // open front: the inner tee shows in a V that widens toward the collar
    float t = smoothstep(topHem, neck, y);
    float openW = st == 2 ? 0.014 + 0.05 * t * t : 0.026 + 0.04 * t;
    float open = frontM * (1.0 - aaStep(openW, ax)) * aaStep(topHem + (st == 2 ? 0.04 : 0.0), y);
    float edge = frontM * aaBand(openW, openW + 0.014, ax);
    top *= 1.0 - 0.12 * edge;
    if (st == 2) {
      float btn = edge * (1.0 - aaStep(0.006, length(vec2(ax - openW - 0.007, (fract((y - topHem) / 0.07) - 0.5) * 0.07))));
      top = mix(top, vec3(0.86, 0.8, 0.7), btn);
    } else {
      // chest pockets on the work jacket
      float px = abs(ax - 0.085), py = abs(y - (chest + 0.02));
      float pk = frontM * max(aaBand(0.044, 0.05, px) * step(py, 0.05), aaBand(0.044, 0.05, py) * step(px, 0.05));
      top *= 1.0 - 0.25 * pk;
    }
    top = mix(top, inner, open);
  }
  if (st == 3) {
    // hood folds at the back, kangaroo pocket, drawstrings
    float hood = (1.0 - smoothstep(-0.02, 0.03, zf)) * nearNeck * aaBand(neckLine - 0.07, neckLine + 0.06, y);
    top *= 1.0 - 0.18 * hood * (0.6 + 0.4 * sin(y * 160.0));
    float pr = max(abs(ax) / 0.1, abs(y - (waist + 0.06)) / 0.08);
    top *= 1.0 - 0.3 * frontM * aaBand(0.97, 1.0, pr) * step(waist - 0.03, y);
    float str = frontM * aaBand(0.024, 0.031, ax) * aaBand(neckLine - 0.15, neckLine, y);
    top = mix(top, uInnerCol, str);
  }
  top = mix(top, collarCol, collar);
  topM = max(topM, collar);

  // elbow / waist folds for the bump pass
  foldH = topM * (sin(ax * 260.0 + n2 * 4.0) * armM * (1.0 - smoothstep(0.03, 0.1, abs(ax - elbowX))) + sin(y * 180.0 + n1 * 3.0) * 0.6 * (1.0 - armM) * (1.0 - smoothstep(0.0, 0.12, y - topHem)))
        + botM * (sin(y * 150.0 + n2 * 5.0) * (1.0 - smoothstep(0.02, 0.1, abs(y - knee))) + sin(ax * 120.0) * 0.3);

  vec3 col = skin;
  col = mix(col, bot, botM);
  col = mix(col, top, topM);
  col = mix(col, shoe, shoeM);
  diffuseColor.rgb = col;
  clothM = max(max(botM, topM), shoeM);
  shoeLeather = shoeM * (1.0 - uSneaker);
}
`;

const FRAG_ROUGH = /* glsl */ `
// skin: a soft satin sheen (was fully matte, so faces read as painted plastic in close-ups)
roughnessFactor = min(roughnessFactor, 0.56);
roughnessFactor = mix(roughnessFactor, 0.9, clothM);
roughnessFactor = mix(roughnessFactor, 0.42, max(shoeLeather, beltM * 0.8));
roughnessFactor = mix(roughnessFactor, 0.28, metalM);
`;

const FRAG_NORMAL = /* glsl */ `
normal = normalize(mix(normal, nonPerturbedNormal, clothM * 0.82));
{
  // tiny fabric folds via screen-space derivatives of a procedural height
  vec3 p = -vViewPosition;
  vec3 dpdx = dFdx(p), dpdy = dFdy(p);
  float h = foldH * 0.0016;
  float dhdx = dFdx(h), dhdy = dFdy(h);
  vec3 r1 = cross(dpdy, normal), r2 = cross(normal, dpdx);
  float det = dot(dpdx, r1);
  vec3 grad = sign(det) * (dhdx * r1 + dhdy * r2);
  normal = normalize(abs(det) * normal - grad * clothM);
}
`;

const FRAG_SHEEN = /* glsl */ `
{
  float fres = pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), 3.0);
  totalEmissiveRadiance += clothM * (1.0 - metalM) * diffuseColor.rgb * fres * 0.22;
}
`;

/** Cheap subsurface look for skin: light that enters skin comes back out warmer (red scatters furthest), so lit and
 *  bounce-lit skin is tinted toward red/orange instead of shading to grey. */
const FRAG_SKIN = /* glsl */ `
{
  float skinM = (1.0 - clothM) * (1.0 - shoeLeather) * (1.0 - beltM) * (1.0 - metalM);
  reflectedLight.directDiffuse *= mix(vec3(1.0), vec3(1.16, 1.0, 0.93), skinM);
  reflectedLight.indirectDiffuse *= mix(vec3(1.0), vec3(1.12, 1.0, 0.94), skinM);
}
`;
