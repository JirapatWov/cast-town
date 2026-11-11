// Interior material palette. Calm, warm, slightly desaturated so vendor colors and status rings pop.
// Wood, fabric and the parquet are photographed CC0 surfaces (Poly Haven, /assets/textures/interior, WebP) used
// at real-world scale: primitives carry metric UVs (furniture/kit.ts metricUV), so `repeat = 1 / tile meters`.
// Fabrics ship with a neutral albedo; the material colour tints them, so one weave serves every cushion colour
// and those parts still batch together (batch.ts moves the colour into vertex colours).
import * as THREE from 'three';
import type { Assets } from '../core/types';
import { hedgeMaterial } from '../city/trees/materials';
import { PAINTS, ROOM } from './layout';
import { macroNoiseTexture } from '../city/textures';
import { subwayTileTexture, wainscotTextures } from './textures';
import { DADO_H } from './walls';

/** Photographed surface sets under /assets/textures/interior (id → real tile size in meters). */
export const SURFACES = {
  oak: { id: 'oak_veneer_01', tile: 1.4 },
  walnut: { id: 'kitchen_wood', tile: 0.75 },
  parquet: { id: 'herringbone_parquet', tile: 2.6 },
  linen: { id: 'rough_linen', tile: 0.42 },
  wool: { id: 'poly_wool_herringbone', tile: 0.4 },
  boucle: { id: 'curly_teddy_natural', tile: 0.45 },
  jute: { id: 'hessian_230', tile: 0.5 },
  felt: { id: 'caban', tile: 0.42 },
} as const;
export type Surface = keyof typeof SURFACES;

export interface Palette {
  floor: THREE.MeshStandardMaterial;
  wallOuter: THREE.MeshStandardMaterial;
  wallCap: THREE.MeshStandardMaterial;
  paints: Record<keyof typeof PAINTS, THREE.MeshStandardMaterial>;
  baseboard: THREE.MeshStandardMaterial;
  plinth: THREE.MeshStandardMaterial;
  lawn: THREE.Material;
  /** Garden shrubs: the town's clipped-hedge leaf texture, mapped from world position (needs a colour attribute). */
  shrub: THREE.MeshStandardMaterial;
  oak: THREE.MeshStandardMaterial;
  walnut: THREE.MeshStandardMaterial;
  lacquer: THREE.MeshStandardMaterial; // kitchen cabinet fronts
  blackMetal: THREE.MeshStandardMaterial;
  steel: THREE.MeshStandardMaterial;
  brass: THREE.MeshStandardMaterial;
  glass: THREE.MeshPhysicalMaterial;
  marble: THREE.MeshStandardMaterial;
  tiles: THREE.MeshStandardMaterial;
  ceramic: THREE.MeshStandardMaterial;
  plastic: THREE.MeshStandardMaterial;
  rubber: THREE.MeshStandardMaterial;
  screenOff: THREE.MeshStandardMaterial;
  /** Floor finishes for upper-floor rooms (world-meter UVs). */
  floors: { oak: THREE.MeshStandardMaterial; walnut: THREE.MeshStandardMaterial; concrete: THREE.MeshStandardMaterial; ash: THREE.MeshStandardMaterial; parquet: THREE.MeshStandardMaterial };
  /** Exterior band where a floor slab meets the facade. */
  slabEdge: THREE.MeshStandardMaterial;
  /** A new painted-plaster material (world-meter UVs) — rooms own theirs so they can be recolored. */
  plaster(tint: THREE.ColorRepresentation): THREE.MeshStandardMaterial;
  /** A new painted raised-panel wainscot material (below the chair rail; world-meter UVs). */
  panel(tint: THREE.ColorRepresentation): THREE.MeshStandardMaterial;
  /** Woven linen (curtains, cushions, rugs' backing); cached per colour. */
  fabric(color: THREE.ColorRepresentation, roughness?: number): THREE.MeshStandardMaterial;
  /** Herringbone wool upholstery (sofas, office chairs). */
  upholstery(color: THREE.ColorRepresentation): THREE.MeshStandardMaterial;
  /** Curly bouclé (armchairs, bean bags, throws). */
  boucle(color: THREE.ColorRepresentation): THREE.MeshStandardMaterial;
  /** Wool felt (pin boards, desk mats). */
  felt(color: THREE.ColorRepresentation): THREE.MeshStandardMaterial;
  /** Natural jute / hessian (runners, baskets, door mats). */
  jute: THREE.MeshStandardMaterial;
  /** A photographed surface as a material (repeat per meter, optional second UV channel for the detail maps). */
  surface(name: Surface, tint?: THREE.ColorRepresentation, opts?: { roughness?: number; normalScale?: number; channel?: number }): THREE.MeshStandardMaterial;
  paint(color: THREE.ColorRepresentation, roughness?: number): THREE.MeshStandardMaterial;
  emissive(color: THREE.ColorRepresentation, intensity: number): THREE.MeshStandardMaterial;
}

/**
 * The lawn around the house: two scales of colour variation (clumps, drier patches), mowing stripes inside the lot,
 * a darker band where the grass meets the plinth, and a meadow tone past the hedges, all keyed on world XZ.
 */
function lawnDetail(m: THREE.MeshLambertMaterial) {
  const noise = macroNoiseTexture();
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uLawnNoise = { value: noise };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vLawnXZ;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLawnXZ = (modelMatrix * vec4(transformed, 1.0)).xz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D uLawnNoise;\nvarying vec2 vLawnXZ;')
      .replace('#include <map_fragment>', `#include <map_fragment>
      {
        vec2 p = vLawnXZ;
        float a = texture2D(uLawnNoise, p * 0.031).r;
        float b = texture2D(uLawnNoise, p * 0.13 + 0.37).r;
        float clump = texture2D(uLawnNoise, p * 0.47 + 0.71).r;
        diffuseColor.rgb *= mix(vec3(1.08, 1.0, 0.78), vec3(0.86, 1.03, 0.92), smoothstep(0.25, 0.75, a * 0.7 + b * 0.3));
        diffuseColor.rgb *= 0.9 + 0.2 * clump;
        // inside the lot: mown stripes; outside: longer, drier meadow grass
        vec2 lot = step(vec2(-14.4, -14.6), p) * step(p, vec2(14.6, 12.6));
        float inLot = lot.x * lot.y;
        diffuseColor.rgb *= mix(vec3(1.06, 1.02, 0.84), vec3(0.97 + 0.06 * step(0.5, fract(p.x / 2.2))), inLot);
        // contact shade along the plinth
        vec2 d = max(abs(p) - vec2(${(ROOM.halfW + ROOM.wallT).toFixed(2)}, ${(ROOM.halfD + ROOM.wallT).toFixed(2)}), 0.0);
        diffuseColor.rgb *= mix(0.62, 1.0, smoothstep(0.0, 1.4, length(d)));
      }`);
  };
  m.customProgramCacheKey = () => 'rlt-house-lawn';
}

/** Floors: a roughness floor of ~0.38. The ARM maps have near-mirror texels that turned every lamp's specular peak
 *  into a sparkle (glitter dots on the parquet, worse after SMAA); the broad window reflections survive. */
export function minRoughness<T extends THREE.MeshStandardMaterial>(m: T, min = 0.38): T {
  m.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <roughnessmap_fragment>',
      `#include <roughnessmap_fragment>\n\troughnessFactor = max(roughnessFactor, ${min.toFixed(3)});`,
    );
  };
  m.customProgramCacheKey = () => `minRough:${min.toFixed(3)}`;
  return m;
}

export function createPalette(assets: Assets): Palette {
  const std = (p: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial(p);

  const surfaceCache = new Map<string, THREE.MeshStandardMaterial>();
  const surface = (name: Surface, tint: THREE.ColorRepresentation = '#ffffff', opts: { roughness?: number; normalScale?: number; channel?: number } = {}) => {
    const key = `${name}:${new THREE.Color(tint).getHexString()}:${opts.roughness ?? 1}:${opts.normalScale ?? 1}:${opts.channel ?? 0}`;
    let m = surfaceCache.get(key);
    if (m) return m;
    const { id, tile } = SURFACES[name];
    const base = `/assets/textures/interior/${id}/${id}`;
    const rep: [number, number] = [1 / tile, 1 / tile];
    const t = (suffix: string, srgb: boolean) => {
      const tex = assets.texture(`${base}_${suffix}_1k.webp`, { srgb, repeat: rep });
      if (opts.channel) {
        const c = tex.clone();
        c.channel = opts.channel;
        return c;
      }
      return tex;
    };
    const arm = t('arm', false);
    m = std({ color: tint, roughness: opts.roughness ?? 1, metalness: 0 });
    if (!opts.channel) m.map = t('diff', true);
    m.normalMap = t('nor_gl', false);
    m.normalScale.setScalar(opts.normalScale ?? 1);
    m.roughnessMap = arm;
    m.aoMap = arm;
    m.aoMapIntensity = 0.5;
    m.name = `surface:${name}`;
    surfaceCache.set(key, m);
    return m;
  };

  // World-meter UVs everywhere on architecture → repeat = 1 / tile size.
  const plaster = (tint: string) => {
    const m = assets.pbr('plaster', [1 / 2.5, 1 / 2.5], tint);
    m.normalScale.set(0.35, 0.35);
    m.aoMapIntensity = 0.4;
    return m;
  };
  // ground floor: white-oiled oak herringbone
  const floor = minRoughness(surface('parquet', '#ffe9d2', { roughness: 0.9, normalScale: 0.8 }).clone());
  floor.aoMapIntensity = 0.7;
  floor.envMapIntensity = 0.9;

  // Lambert (no specular) so the grass never glitters at grazing angles toward the sun.
  const grass = assets.pbr('grass', [1 / 3, 1 / 3]);
  const lawn = new THREE.MeshLambertMaterial({ map: grass.map, color: '#93a77a' });
  lawnDetail(lawn);

  const plinth = assets.pbr('concrete', [1 / 1.8, 1 / 1.8], '#cfc8bd');
  const shrub = hedgeMaterial(
    assets.texture('/assets/textures/trees/hedge_color.webp', { srgb: true }),
    assets.texture('/assets/textures/trees/hedge_normal.webp'),
  );
  shrub.color.setRGB(0.74, 0.84, 0.66);
  shrub.name = 'shrub';

  const wains = wainscotTextures();
  for (const t of [wains.map, wains.normalMap]) t.repeat.set(1 / 0.6, 1 / DADO_H);
  const panel = (tint: THREE.ColorRepresentation) => std({ color: tint, map: wains.map, normalMap: wains.normalMap, roughness: 0.5, metalness: 0, envMapIntensity: 0.8 });

  // fabric roughness is the weave's (the ARM map); the argument only nudges it, in coarse steps so tints batch
  const fabric = (color: THREE.ColorRepresentation, roughness = 0.95) => surface('linen', color, { roughness: roughness < 0.8 ? 0.85 : 1, normalScale: 0.7 });

  const tilesMap = subwayTileTexture();
  const tiles = std({ map: tilesMap, roughness: 0.18, metalness: 0, color: '#f3efe8' });
  tilesMap.repeat.set(1 / 0.6, 1 / 0.6);

  const woodfloor = (tint: string, rough: number) => {
    const m = assets.pbr('woodfloor', [1 / 1.6, 1 / 1.6], tint);
    m.normalScale.set(0.55, 0.55);
    m.roughness = rough;
    m.aoMapIntensity = 0.5;
    return m;
  };
  const concreteFloor = assets.pbr('concrete', [1 / 2.4, 1 / 2.4], '#d8d4cc');
  concreteFloor.metalness = 0;
  concreteFloor.metalnessMap = null;
  concreteFloor.roughness = 0.62;
  concreteFloor.normalScale.set(0.25, 0.25);
  concreteFloor.envMapIntensity = 1.1;
  const ashFloor = assets.pbr('laminate', [1 / 1.7, 1 / 1.7], '#fbf1e4');
  ashFloor.normalScale.set(0.6, 0.6);
  ashFloor.roughness = 0.85;
  ashFloor.aoMapIntensity = 0.6;

  const marble = assets.pbr('marble', [1 / 1.2, 1 / 1.2], '#f2efe9');
  marble.roughness = 0.25;
  marble.metalness = 0;
  marble.metalnessMap = null;

  return {
    floor,
    wallOuter: plaster('#f1e8da'),
    wallCap: std({ color: '#3b3530', roughness: 0.9 }),
    paints: {
      warmWhite: plaster(PAINTS.warmWhite),
      sage: plaster(PAINTS.sage),
      clay: plaster(PAINTS.clay),
      mist: plaster(PAINTS.mist),
    },
    baseboard: std({ color: '#f4f0e8', roughness: 0.45 }),
    plinth,
    lawn,
    shrub,
    oak: surface('oak', '#f3e2cb', { roughness: 0.82, normalScale: 0.6 }),
    walnut: surface('walnut', '#b88663', { roughness: 0.78, normalScale: 0.6 }),
    lacquer: std({ color: '#e9e4da', roughness: 0.35 }),
    blackMetal: std({ color: '#1d1c1b', roughness: 0.42, metalness: 0.6 }),
    steel: std({ color: '#c9ccce', roughness: 0.28, metalness: 1 }),
    brass: std({ color: '#c9a063', roughness: 0.3, metalness: 1 }),
    glass: new THREE.MeshPhysicalMaterial({
      color: '#dfeef2', roughness: 0.04, metalness: 0, transparent: true, opacity: 0.16,
      envMapIntensity: 1.4, depthWrite: false,
    }),
    marble,
    tiles,
    ceramic: std({ color: '#f5f2ec', roughness: 0.25 }),
    plastic: std({ color: '#2a2a2c', roughness: 0.5 }),
    rubber: std({ color: '#1b1a19', roughness: 0.9 }),
    screenOff: std({ color: '#0c0d0f', roughness: 0.15, metalness: 0.2 }),
    floors: {
      oak: minRoughness(woodfloor('#f2dcc0', 0.8)), walnut: minRoughness(woodfloor('#b08868', 0.7)), concrete: minRoughness(concreteFloor),
      ash: minRoughness(ashFloor), parquet: minRoughness(surface('parquet', '#fff0e0', { roughness: 0.88, normalScale: 0.8 }).clone()),
    },
    slabEdge: plaster('#d9cfc1'),
    plaster,
    panel,
    fabric,
    upholstery: (color) => surface('wool', color, { normalScale: 0.8 }),
    boucle: (color) => surface('boucle', color, { normalScale: 1.1 }),
    felt: (color) => surface('felt', color, { normalScale: 0.8 }),
    jute: surface('jute', '#e6d2b0', { normalScale: 1 }),
    surface,
    paint: (color, roughness = 0.6) => std({ color, roughness }),
    emissive: (color, intensity) => std({ color: '#000000', emissive: color, emissiveIntensity: intensity, roughness: 1 }),
  };
}
