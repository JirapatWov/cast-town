// City material palette. All geometry UVs are in meters, so textured materials use repeat = 1 / tileMeters.
// Walls/roofs use vertex colors as tint multipliers, which lets every building share one material (one draw call).
import * as THREE from 'three';
import type { Assets, PbrSet } from '../core/types';
import { pbrTileMeters } from '../engine/assets';
import { FLOOR_SLOTS, ProjectGlassMaterial } from './glass';
import { GROUND_GLSL, GROUND_UNIFORMS } from './ground';
import { LAWN_Y } from './layout';
import { macroNoiseTexture, membraneTexture, seamNormalTexture, shingleTextures } from './textures';
import { flowerMaterial } from './trees/flowers';
import { barkMaterial, hedgeMaterial, leafMaterial } from './trees/materials';

export interface CityMaterials {
  ground: THREE.MeshStandardMaterial;
  lawn: THREE.MeshStandardMaterial;
  asphalt: THREE.MeshStandardMaterial;
  marking: THREE.MeshStandardMaterial;
  sidewalk: THREE.MeshStandardMaterial;
  curb: THREE.MeshStandardMaterial;
  paving: THREE.MeshStandardMaterial;
  plaster: THREE.MeshStandardMaterial;
  brick: THREE.MeshStandardMaterial;
  stone: THREE.MeshStandardMaterial;
  trim: THREE.MeshStandardMaterial;
  frame: THREE.MeshStandardMaterial;
  metal: THREE.MeshStandardMaterial;
  wood: THREE.MeshStandardMaterial;
  door: THREE.MeshStandardMaterial;
  roofShingle: THREE.MeshStandardMaterial;
  roofMetal: THREE.MeshStandardMaterial;
  roofFlat: THREE.MeshStandardMaterial;
  fabric: THREE.MeshStandardMaterial;
  /** Static sprig cards (merged planters, balcony shrubs, roof-terrace trees). */
  foliage: THREE.MeshStandardMaterial;
  bark: THREE.MeshStandardMaterial;
  /** Clipped hedge core (world-mapped leafy texture) and the sprig cards poking out of it. */
  hedge: THREE.MeshStandardMaterial;
  hedgeFuzz: THREE.MeshStandardMaterial;
  flower: THREE.MeshStandardMaterial;
  water: THREE.MeshStandardMaterial;
  bulb: THREE.MeshStandardMaterial;
  /** Shared interior-mapped window glass for the town's buildings (per-vertex aWin = [tile, lit], aRoom). */
  glass: ProjectGlassMaterial;
  macroNoise: THREE.Texture;
}

/** sRGB hex → linear multiplier relative to a texture's mean albedo (so vertex colors read as "paint colors"). */
export function tint(hex: number, textureMeanSrgb = 1): [number, number, number] {
  const c = new THREE.Color(hex);
  const mean = new THREE.Color().setRGB(textureMeanSrgb, textureMeanSrgb, textureMeanSrgb, THREE.SRGBColorSpace);
  return [c.r / mean.r, c.g / mean.g, c.b / mean.b];
}

/** Mean albedo (sRGB, 0..1) of our photo textures, used by tint(). */
export const TEX_MEAN = { plaster: 0.6, brick: 0.42, shingle: 0.55, concrete: 0.5, wood: 0.5 };

function worldPbr(assets: Assets, set: PbrSet, tintHex?: number, tileOverride?: number): THREE.MeshStandardMaterial {
  const r = 1 / (tileOverride ?? pbrTileMeters(set));
  return assets.pbr(set, [r, r], tintHex);
}

/** Linear colour multiplier (components may exceed 1) — used to re-balance photo textures toward a target albedo. */
const mul = (r: number, g: number, b: number) => new THREE.Color(r, g, b);

/**
 * Two-scale macro variation keyed on world XZ: breaks up tiling on big ground surfaces.
 * `low`/`high` are colour multipliers blended by the noise. Grass (`grass` set) also gets clumps, dry patches,
 * optional mowing stripes, and ambient occlusion from the ground map (darker next to walls, hedges, under trees).
 */
function addMacroVariation(
  mat: THREE.MeshStandardMaterial, noise: THREE.Texture, key: string, scale: number, low: THREE.Color, high: THREE.Color,
  grass?: { stripes: boolean },
) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uMacro = { value: noise };
    shader.uniforms.uMacroLow = { value: low };
    shader.uniforms.uMacroHigh = { value: high };
    if (grass) Object.assign(shader.uniforms, GROUND_UNIFORMS);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vMacroXZ;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvMacroXZ = (modelMatrix * vec4(transformed, 1.0)).xz;');
    const grassCode = grass
      ? `
        {
          vec2 guv = rltGroundUv(vMacroXZ);
          float occ = textureLod(uGroundMap, guv, 2.5).g * 0.55 + textureLod(uGroundMap, guv, 4.5).g * 0.45;
          float clump = texture2D(uMacro, vMacroXZ * 0.41).r;
          float patchN = texture2D(uMacro, vMacroXZ * 0.071 + 0.53).r;
          diffuseColor.rgb *= (0.88 + 0.24 * clump) * mix(0.52, 1.0, occ);
          diffuseColor.rgb *= mix(vec3(1.0), vec3(1.16, 1.05, 0.68), smoothstep(0.56, 0.86, patchN) * 0.7 * occ);
          ${grass.stripes ? 'diffuseColor.rgb *= 0.965 + 0.07 * step(0.5, fract(vMacroXZ.x / 3.4 + 0.04 * patchN));' : ''}
        }`
      : '';
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform sampler2D uMacro;\nuniform vec3 uMacroLow;\nuniform vec3 uMacroHigh;\nvarying vec2 vMacroXZ;\n${grass ? GROUND_GLSL : ''}`)
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        float macroA = texture2D(uMacro, vMacroXZ * ${scale.toFixed(5)}).r;
        float macroB = texture2D(uMacro, vMacroXZ * ${(scale * 4.3).toFixed(5)} + 0.37).r;
        float macro = smoothstep(0.2, 0.8, macroA * 0.7 + macroB * 0.3);
        diffuseColor.rgb *= mix(uMacroLow, uMacroHigh, macro);${grassCode}`,
      );
  };
  mat.customProgramCacheKey = () => `macro:${key}`;
}

/**
 * Weathering on walls, keyed on world position: a darker, slightly earthy band of splash grime along the base and
 * faint vertical rain streaks, so big plaster and brick walls don't read as freshly printed.
 */
function addWeathering(mat: THREE.MeshStandardMaterial, noise: THREE.Texture, key: string) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uWeatherNoise = { value: noise };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWeatherW;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWeatherW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D uWeatherNoise;\nvarying vec3 vWeatherW;')
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        {
          float h = vWeatherW.y - ${LAWN_Y.toFixed(2)};
          float edge = texture2D(uWeatherNoise, vec2(vWeatherW.x + vWeatherW.z, h) * 0.35).r;
          float grime = 1.0 - smoothstep(0.15, 0.75 + 0.35 * edge, h);
          diffuseColor.rgb *= mix(vec3(1.0), vec3(0.8, 0.78, 0.72), grime);
          float streak = texture2D(uWeatherNoise, vec2((vWeatherW.x + vWeatherW.z) * 0.55, h * 0.035 + 0.3)).r;
          diffuseColor.rgb *= 1.0 - smoothstep(0.6, 0.92, streak) * 0.085;
        }`,
      );
  };
  mat.customProgramCacheKey = () => `weather:${key}`;
}

export function createCityMaterials(assets: Assets): CityMaterials {
  const macroNoise = macroNoiseTexture();
  const shingles = shingleTextures();
  const seam = seamNormalTexture();

  // Grass: no roughness map (it reads glossy at grazing sun), albedo pushed toward a fresh green.
  const ground = worldPbr(assets, 'grass', undefined, 3);
  ground.roughnessMap = null;
  ground.roughness = 0.95;
  ground.color = mul(1.15, 1.5, 0.95);
  addMacroVariation(ground, macroNoise, 'ground', 1 / 90, new THREE.Color(1.12, 1.0, 0.7), new THREE.Color(0.8, 1.0, 0.85), { stripes: false });
  ground.name = 'ground';

  const lawn = worldPbr(assets, 'grass', undefined, 2.5);
  lawn.roughnessMap = null;
  lawn.roughness = 0.92;
  lawn.color = mul(1.0, 1.6, 1.1);
  addMacroVariation(lawn, macroNoise, 'lawn', 1 / 34, new THREE.Color(1.1, 1.0, 0.74), new THREE.Color(0.84, 1.03, 0.9), { stripes: true });
  lawn.name = 'lawn';

  const asphalt = worldPbr(assets, 'asphalt', 0x9c9a98);
  addMacroVariation(asphalt, macroNoise, 'asphalt', 1 / 60, new THREE.Color(0.86, 0.86, 0.86), new THREE.Color(1.08, 1.06, 1.04));
  asphalt.name = 'asphalt';
  asphalt.normalScale.set(0.8, 0.8);

  const marking = new THREE.MeshStandardMaterial({
    name: 'marking', color: 0xe9e6dc, roughness: 0.62, metalness: 0,
    normalMap: asphalt.normalMap, normalScale: new THREE.Vector2(0.6, 0.6),
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
  });

  const sidewalk = worldPbr(assets, 'concrete');
  sidewalk.color = mul(1.45, 1.62, 1.9);
  sidewalk.name = 'sidewalk';
  const curb = worldPbr(assets, 'concrete', undefined, 3);
  curb.color = mul(1.9, 2.05, 2.35);
  curb.name = 'curb';
  const paving = worldPbr(assets, 'paving');
  paving.color = mul(1.25, 1.22, 1.2);
  paving.name = 'paving';

  const plaster = worldPbr(assets, 'plaster');
  plaster.vertexColors = true;
  plaster.name = 'plaster';
  addWeathering(plaster, macroNoise, 'plaster');
  const brick = worldPbr(assets, 'brick');
  brick.vertexColors = true;
  brick.name = 'brick';
  addWeathering(brick, macroNoise, 'brick');
  const stone = worldPbr(assets, 'concrete', 0xd8d2c8, 1.2);
  stone.vertexColors = true;
  stone.name = 'stone';

  const trim = new THREE.MeshStandardMaterial({ name: 'trim', color: 0xffffff, roughness: 0.55, vertexColors: true });
  const frame = new THREE.MeshStandardMaterial({ name: 'frame', color: 0xffffff, roughness: 0.45, metalness: 0.15, vertexColors: true });
  const metal = new THREE.MeshStandardMaterial({ name: 'metal', color: 0x3a3c3f, roughness: 0.38, metalness: 0.85 });
  const wood = worldPbr(assets, 'woodfloor', 0xe0c3a0, 2.2);
  wood.vertexColors = true;
  wood.name = 'wood';
  const door = worldPbr(assets, 'woodfloor', 0x9a6a48, 1.2);
  door.vertexColors = true;
  door.name = 'door';

  const roofShingle = new THREE.MeshStandardMaterial({
    name: 'roofShingle', map: shingles.map, normalMap: shingles.normal, roughness: 0.82, vertexColors: true,
  });
  roofShingle.map!.repeat.set(0.5, 0.5);
  roofShingle.normalMap!.repeat.set(0.5, 0.5);
  const roofMetal = new THREE.MeshStandardMaterial({
    name: 'roofMetal', color: 0xffffff, normalMap: seam, roughness: 0.42, metalness: 0.55, vertexColors: true,
  });
  // darker, cooler membrane (a pale roof was the brightest thing in every wide shot); the map averages ~0.78
  const roofFlat = new THREE.MeshStandardMaterial({ name: 'roofFlat', color: 0x9aa2a9, map: membraneTexture(), roughness: 0.9 });
  roofFlat.normalMap = sidewalk.normalMap;
  roofFlat.normalScale.set(0.6, 0.6);

  const fabric = new THREE.MeshStandardMaterial({ name: 'fabric', color: 0xffffff, roughness: 0.85, vertexColors: true, side: THREE.DoubleSide });
  const T = '/assets/textures/trees';
  const oakLeaves = assets.texture(`${T}/leaves_oak.webp`, { srgb: true });
  oakLeaves.wrapS = oakLeaves.wrapT = THREE.ClampToEdgeWrapping;
  const foliage = leafMaterial({ name: 'foliage', map: oakLeaves, wind: false, translucency: 0.25 });
  const hedgeFuzz = leafMaterial({ name: 'hedgeFuzz', map: oakLeaves, wind: false, translucency: 0.2, alphaTest: 0.5 });
  const bark = barkMaterial('bark', assets.texture(`${T}/bark_oak_color.webp`, { srgb: true }), assets.texture(`${T}/bark_oak_normal.webp`));
  bark.onBeforeCompile = () => {};
  bark.customProgramCacheKey = () => 'rlt-bark-static';
  const hedge = hedgeMaterial(assets.texture(`${T}/hedge_color.webp`, { srgb: true }), assets.texture(`${T}/hedge_normal.webp`));
  hedge.color = mul(0.78, 0.86, 0.72);
  const flower = flowerMaterial();
  const water = new THREE.MeshStandardMaterial({ name: 'water', color: 0x2d4c58, roughness: 0.04, metalness: 0.0, envMapIntensity: 1.6 });
  const bulb = new THREE.MeshStandardMaterial({ name: 'bulb', color: 0x221a10, emissive: 0xffc27a, emissiveIntensity: 4 });

  // town windows: the lit ones (aWin.y) show a warm lamp, the rest dim interiors behind reflections
  const glass = new ProjectGlassMaterial(7);
  glass.name = 'glass';
  glass.floors.value = FLOOR_SLOTS;
  for (let f = 0; f < FLOOR_SLOTS; f++) glass.setFloor(f, 0.95);

  return {
    ground, lawn, asphalt, marking, sidewalk, curb, paving, plaster, brick, stone, trim, frame, metal, wood, door,
    roofShingle, roofMetal, roofFlat, fabric, foliage, bark, hedge, hedgeFuzz, flower, water, bulb, glass, macroNoise,
  };
}
