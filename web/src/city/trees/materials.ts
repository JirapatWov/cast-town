// Materials for trees, shrubs and hedges: alpha-tested leaf-sprig cards with wind, canopy normals (no back-face
// flip, so a crown shades as one soft volume), sun translucency (leaves glow when back-lit) and an alpha boost on
// distant mips (cards don't thin out to nothing far away). Bark sways with the same wind field as its leaves.
import * as THREE from 'three';

export type LeafType = 'oak' | 'ash' | 'aspen' | 'pine';
export type BarkType = 'oak' | 'birch' | 'pine';

/** Shared wind/time uniforms (one object for every vegetation material, updated once per frame). */
export const WIND = {
  uTime: { value: 0 },
  uWindDir: { value: new THREE.Vector2(0.8, 0.6).normalize() },
  uWindStrength: { value: 1 },
};

const WIND_PARS = /* glsl */ `
uniform float uTime;
uniform vec2 uWindDir;
uniform float uWindStrength;
attribute vec2 aWind;
// world-space wind offset for a vertex of a plant rooted at origin: a slow sway of the whole crown (travelling gusts)
// plus a quick flutter of each card (phase per card in aWind.y)
vec3 rltWind(vec3 p, vec3 origin, vec2 w, float flutter) {
  float ph = dot(origin.xz, vec2(0.083, 0.061));
  float gust = 0.55 + 0.45 * sin(uTime * 0.31 + origin.x * 0.017 - origin.z * 0.011);
  float sway = (sin(uTime * 1.05 + ph) * 0.65 + sin(uTime * 1.83 + ph * 1.7) * 0.35) * gust;
  vec3 d = vec3(uWindDir.x, 0.0, uWindDir.y);
  vec3 off = d * (sway * 0.16 + gust * 0.1) * w.x;
  off.y -= abs(sway) * 0.03 * w.x;
  float f = sin(uTime * 6.3 + w.y + p.y * 1.7) * flutter * (0.4 + gust);
  off += vec3(f, f * 0.6, -f * 0.8) * 0.045 * w.x;
  return off * uWindStrength;
}
`;

const PROJECT_WIND = (flutter: number) => /* glsl */ `
vec4 mvPosition = vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
  mvPosition = instanceMatrix * mvPosition;
  vec3 rltOrigin = instanceMatrix[3].xyz;
#else
  vec3 rltOrigin = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
#endif
mvPosition.xyz += rltWind(mvPosition.xyz, rltOrigin, aWind, ${flutter.toFixed(2)});
mvPosition = modelViewMatrix * mvPosition;
gl_Position = projectionMatrix * mvPosition;
`;

// instanced meshes are built in world space (identity model matrix), so 'instance space' is world space
function injectWind(shader: THREE.WebGLProgramParametersWithUniforms, flutter: number) {
  Object.assign(shader.uniforms, WIND);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${WIND_PARS}`)
    .replace('#include <project_vertex>', PROJECT_WIND(flutter));
}

const NO_FLIP_NORMAL = THREE.ShaderChunk.normal_fragment_begin.replace('normal *= faceDirection;', '');

// alpha boost on far mips: keep the coverage of sprig cards as they shrink
const ALPHA_BOOST = /* glsl */ `
#include <map_fragment>
#ifdef USE_MAP
{
  vec2 tsz = vec2(textureSize(map, 0));
  vec2 ddx = dFdx(vMapUv * tsz), ddy = dFdy(vMapUv * tsz);
  float mip = max(0.0, 0.5 * log2(max(dot(ddx, ddx), dot(ddy, ddy))));
  diffuseColor.a *= 1.0 + mip * 0.28;
}
#endif
`;

/** Sun light passing through the leaves toward the viewer, added inside the sun-light loop (already shadowed). */
function withTranslucency(chunk: string, amount: number): string {
  const at = chunk.indexOf('getSunShadow');
  if (at < 0) return chunk;
  const re = chunk.indexOf('RE_Direct(', at);
  if (re < 0) return chunk;
  const add = `{ float rltT = pow( saturate( dot( geometryViewDir, - directLight.direction ) ), 4.0 ) * 0.85 + 0.15;
      reflectedLight.directDiffuse += directLight.color * material.diffuseColor * rltT * ${amount.toFixed(3)}; }
    `;
  return chunk.slice(0, re) + add + chunk.slice(re);
}

export interface LeafMaterialOpts {
  map: THREE.Texture;
  color?: THREE.ColorRepresentation;
  wind?: boolean;
  /** Back-light glow strength (0 = off). */
  translucency?: number;
  alphaTest?: number;
  roughness?: number;
  /** Far-LOD atlas: uv.x > 1.5 marks trunk vertices (plain vertex colour, no texture). */
  trunkFlag?: boolean;
  name: string;
}

export function leafMaterial(o: LeafMaterialOpts): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    name: o.name, map: o.map, color: o.color ?? 0xffffff, alphaTest: o.alphaTest ?? 0.42, side: THREE.DoubleSide,
    vertexColors: true, roughness: o.roughness ?? 0.8, metalness: 0,
  });
  const wind = o.wind !== false;
  const tl = o.translucency ?? 0.32;
  m.onBeforeCompile = (shader) => {
    if (wind) injectWind(shader, 1);
    let frag = shader.fragmentShader
      .replace('#include <normal_fragment_begin>', NO_FLIP_NORMAL)
      .replace('#include <map_fragment>', o.trunkFlag ? TRUNK_MAP : ALPHA_BOOST);
    if (tl > 0) frag = frag.replace('#include <lights_fragment_begin>', withTranslucency(THREE.ShaderChunk.lights_fragment_begin, tl));
    // canopy normals are a soft fake: sky reflections off them read as a grey sheen, so keep only a little specular
    frag = frag.replace(
      '#include <aomap_fragment>',
      '#include <aomap_fragment>\nreflectedLight.directSpecular *= 0.3;\nreflectedLight.indirectSpecular *= 0.25;',
    );
    shader.fragmentShader = frag;
  };
  m.customProgramCacheKey = () => `rlt-leaf:${wind ? 1 : 0}:${tl}:${o.trunkFlag ? 1 : 0}`;
  return m;
}

const TRUNK_MAP = /* glsl */ `
#ifdef USE_MAP
if ( vMapUv.x > 1.5 ) {
  diffuseColor.rgb *= vec3( 0.36, 0.29, 0.22 );
} else {
  vec4 sampledDiffuseColor = texture2D( map, vMapUv );
  diffuseColor *= sampledDiffuseColor;
  vec2 tsz = vec2(textureSize(map, 0));
  vec2 ddx = dFdx(vMapUv * tsz), ddy = dFdy(vMapUv * tsz);
  float mip = max(0.0, 0.5 * log2(max(dot(ddx, ddx), dot(ddy, ddy))));
  diffuseColor.a *= 1.0 + mip * 0.3;
}
#endif
`;

/** Depth material for shadow passes that sways like the visible leaves (alpha-tested cards cast dappled shadows). */
export function leafDepthMaterial(map: THREE.Texture, alphaTest = 0.42, wind = true): THREE.MeshDepthMaterial {
  const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map, alphaTest, side: THREE.DoubleSide });
  if (wind) {
    m.onBeforeCompile = (shader) => injectWind(shader, 1);
    m.customProgramCacheKey = () => 'rlt-leaf-depth';
  }
  return m;
}

export function barkDepthMaterial(): THREE.MeshDepthMaterial {
  const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  m.onBeforeCompile = (shader) => injectWind(shader, 0);
  m.customProgramCacheKey = () => 'rlt-bark-depth';
  return m;
}

export function barkMaterial(name: string, map: THREE.Texture, normalMap: THREE.Texture, color: THREE.ColorRepresentation = 0xffffff): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    name, map, normalMap, normalScale: new THREE.Vector2(1.2, 1.2), color, roughness: 0.93, metalness: 0, vertexColors: true,
  });
  m.onBeforeCompile = (shader) => injectWind(shader, 0);
  m.customProgramCacheKey = () => 'rlt-bark';
  return m;
}

/**
 * Clipped hedge: dense foliage texture mapped from world position (any box size keeps the same leaf scale),
 * picked per face from the dominant normal axis. Works for merged (world-space) and instanced geometry.
 */
export function hedgeMaterial(map: THREE.Texture, normalMap: THREE.Texture): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    name: 'hedge', map, normalMap, normalScale: new THREE.Vector2(1.3, 1.3), color: 0xffffff, roughness: 0.82, vertexColors: true,
  });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <worldpos_vertex>',
      `#include <worldpos_vertex>
      {
        #ifdef USE_INSTANCING
          vec4 hw = modelMatrix * instanceMatrix * vec4( transformed, 1.0 );
          vec3 hn = abs( normalize( mat3( modelMatrix ) * mat3( instanceMatrix ) * objectNormal ) );
        #else
          vec4 hw = modelMatrix * vec4( transformed, 1.0 );
          vec3 hn = abs( normalize( mat3( modelMatrix ) * objectNormal ) );
        #endif
        vec2 huv = ( hn.y > 0.6 ? hw.xz : ( hn.x > hn.z ? hw.zy : hw.xy ) ) / 1.15;
        vMapUv = huv;
        vNormalMapUv = huv;
      }`,
    );
  };
  m.customProgramCacheKey = () => 'rlt-hedge';
  return m;
}
