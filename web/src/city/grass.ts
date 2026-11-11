// Grass blades around the camera: square tiles of a few hundred blades each (one shared patch geometry, instanced
// per tile), laid out where the camera can see them. Each blade grows only where the ground map says "lawn",
// takes its colour from the lawn texture under it (so blades melt into the ground), shortens in the shade of trees
// and walls, sways in the wind and fades out with distance. Off on Low; hidden when the camera is high up.
import * as THREE from 'three';
import type { Quality } from '../core/types';
import { GROUND_GLSL, GROUND_UNIFORMS } from './ground';
import { isOnRoad, LAWN_Y } from './layout';
import { WIND } from './trees/materials';
import { rng } from './util/random';

const TILE = 4;

/** Blades per tile and view radius (m) per quality. */
const SETTINGS: Record<Quality, { blades: number; radius: number } | null> = {
  low: null,
  medium: { blades: 900, radius: 18 },
  high: { blades: 1700, radius: 26 },
  ultra: { blades: 3400, radius: 44 },
};

function patchGeometry(blades: number, seed: number): THREE.BufferGeometry {
  const r = rng(seed);
  const pos: number[] = [], blade: number[] = [], idx: number[] = [];
  // one triangle per blade (base pair + tip); position = (root x, height param, root z). Many thin blades read as
  // a lawn better than fewer curved ones.
  const rows: [number, number][] = [[-1, 0], [1, 0], [0, 1]];
  for (let b = 0; b < blades; b++) {
    const x = r() * TILE, z = r() * TILE;
    const yaw = r() * Math.PI * 2, a = r(), c = r();
    for (const [side, t] of rows) {
      pos.push(x, t, z);
      blade.push(side, yaw, a, c);
    }
    idx.push(b * 3, b * 3 + 1, b * 3 + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aBlade', new THREE.Float32BufferAttribute(blade, 4));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(TILE / 2, 0.3, TILE / 2), TILE);
  return g;
}

const VERT_PARS = /* glsl */ `
attribute vec4 aBlade;
uniform float uTime;
uniform vec2 uWindDir;
uniform float uWindStrength;
uniform float uRadius;
uniform sampler2D uLawnMap;
uniform vec3 uLawnTint;
uniform sampler2D uMacro;
${GROUND_GLSL}
varying float vBladeT;
`;

const VERT_MAIN = /* glsl */ `
vec3 rltT = instanceMatrix[3].xyz;
vec3 rltRoot = rltT + vec3(position.x, ${LAWN_Y.toFixed(3)}, position.z);
vec2 guv = rltGroundUv(rltRoot.xz);
float lawnK = textureLod(uGroundMap, guv, 0.0).r;
float occ = textureLod(uGroundMap, guv, 2.5).g;
float camD = distance(rltRoot, cameraPosition);
float fade = 1.0 - smoothstep(uRadius * 0.55, uRadius, camD);
float tuft = texture2D(uMacro, rltRoot.xz * 0.23).r;
float h = (0.06 + 0.1 * aBlade.z) * (0.65 + 0.7 * tuft) * smoothstep(0.55, 0.8, lawnK) * fade * mix(0.6, 1.0, occ);
float t = position.y;
float w = (0.022 + 0.02 * aBlade.w) * (1.0 - t);
vec3 across = vec3(cos(aBlade.y), 0.0, sin(aBlade.y));
vec3 facing = vec3(-across.z, 0.0, across.x);
float gust = sin(uTime * 1.9 + rltRoot.x * 0.35 + rltRoot.z * 0.21) * 0.5 + 0.6;
vec3 lean = facing * (0.2 + 0.4 * aBlade.w) + vec3(uWindDir.x, 0.0, uWindDir.y) * gust * 0.4 * uWindStrength;
vec3 rltW = rltRoot + across * aBlade.x * w + vec3(0.0, t * h, 0.0) + lean * t * h;
vBladeT = t;
// lawn colour under the blade: mean of the grass texture, the lawn tint and the same large-scale variation
vec3 lawnCol = textureLod(uLawnMap, rltRoot.xz / 2.5, 7.0).rgb * uLawnTint;
float patchN = texture2D(uMacro, rltRoot.xz * 0.071 + 0.53).r;
lawnCol *= mix(vec3(1.0), vec3(1.14, 1.05, 0.7), smoothstep(0.58, 0.86, patchN) * 0.55 * occ) * mix(0.55, 1.0, occ);
vColor = vec4(lawnCol * mix(0.78, 1.15, t) * mix(vec3(1.0), vec3(1.08, 1.06, 0.82), t * aBlade.z), 1.0);
`;

export class GrassField {
  readonly mesh: THREE.InstancedMesh;
  private settings: { blades: number; radius: number } | null = null;
  private quality: Quality | null = null;
  private material: THREE.MeshStandardMaterial;
  private radius = { value: 26 };
  private last = new THREE.Vector3(Infinity, 0, 0);
  private lastDir = new THREE.Vector3();
  private dir = new THREE.Vector3();
  private frustum = new THREE.Frustum();
  private pv = new THREE.Matrix4();
  private sphere = new THREE.Sphere(new THREE.Vector3(), TILE * 0.8);

  constructor(lawn: THREE.MeshStandardMaterial, macro: THREE.Texture) {
    const m = new THREE.MeshStandardMaterial({ name: 'grass-blades', color: 0xffffff, roughness: 0.88, side: THREE.DoubleSide, vertexColors: true });
    m.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, WIND, GROUND_UNIFORMS, {
        uRadius: this.radius, uLawnMap: { value: lawn.map }, uLawnTint: { value: lawn.color }, uMacro: { value: macro },
      });
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
        // color_vertex is the first chunk of main(): the whole blade is worked out there
        .replace('#include <color_vertex>', VERT_MAIN)
        .replace('#include <begin_vertex>', 'vec3 transformed = rltW - rltT;')
        // lit like the lawn they stand on: normals mostly up, a little toward each blade's face
        .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = normalize(vec3(0.0, 1.0, 0.0) + facing * 0.3 * (t - 0.3));')
        .replace('#include <defaultnormal_vertex>', 'vec3 transformedNormal = normalMatrix * objectNormal;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vBladeT;')
        .replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replace('normal *= faceDirection;', ''));
    };
    m.customProgramCacheKey = () => 'rlt-grass';
    this.material = m;
    this.mesh = new THREE.InstancedMesh(new THREE.BufferGeometry(), m, 1);
    this.mesh.name = 'grass';
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.count = 0;
    this.mesh.raycast = () => {};
  }

  update(camera: THREE.Camera, quality: Quality): void {
    if (quality !== this.quality) {
      this.quality = quality;
      this.settings = SETTINGS[quality];
      this.last.set(Infinity, 0, 0);
      if (this.settings) {
        const old = this.mesh.geometry;
        this.mesh.geometry = patchGeometry(this.settings.blades, 77);
        old.dispose();
        this.radius.value = this.settings.radius;
        const cap = Math.ceil(((this.settings.radius * 2) / TILE + 2) ** 2);
        if (this.mesh.instanceMatrix.count < cap) {
          this.mesh.instanceMatrix = new THREE.InstancedBufferAttribute(new Float32Array(cap * 16), 16);
          this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        }
      }
    }
    const s = this.settings;
    const R = s?.radius ?? 0;
    const cam = camera.position;
    // nothing within reach of the fade radius once the camera is high above the ground
    this.mesh.visible = !!s && cam.y - LAWN_Y < R * 0.95;
    if (!this.mesh.visible || !s) return;
    camera.getWorldDirection(this.dir);
    if (cam.distanceToSquared(this.last) < 0.5 && this.dir.dot(this.lastDir) > 0.998) return;
    this.last.copy(cam);
    this.lastDir.copy(this.dir);
    camera.updateMatrixWorld();
    this.frustum.setFromProjectionMatrix(this.pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const reach = Math.sqrt(Math.max(0, R * R - (cam.y - LAWN_Y) ** 2)) + TILE;
    const i0 = Math.floor((cam.x - reach) / TILE), i1 = Math.floor((cam.x + reach) / TILE);
    const j0 = Math.floor((cam.z - reach) / TILE), j1 = Math.floor((cam.z + reach) / TILE);
    const arr = this.mesh.instanceMatrix.array as Float32Array;
    const cap = this.mesh.instanceMatrix.count;
    let n = 0;
    for (let i = i0; i <= i1 && n < cap; i++) {
      for (let j = j0; j <= j1 && n < cap; j++) {
        const x = i * TILE, z = j * TILE, cx = x + TILE / 2, cz = z + TILE / 2;
        if (Math.hypot(cx - cam.x, cz - cam.z) > reach) continue;
        // tiles that lie entirely on asphalt grow nothing
        if (isOnRoad(x, z) && isOnRoad(x + TILE, z) && isOnRoad(x, z + TILE) && isOnRoad(x + TILE, z + TILE) && isOnRoad(cx, cz)) continue;
        this.sphere.center.set(cx, LAWN_Y + 0.2, cz);
        if (!this.frustum.intersectsSphere(this.sphere)) continue;
        arr.fill(0, n * 16, n * 16 + 16);
        arr[n * 16] = arr[n * 16 + 5] = arr[n * 16 + 10] = arr[n * 16 + 15] = 1;
        arr[n * 16 + 12] = x;
        arr[n * 16 + 14] = z;
        n++;
      }
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.clearUpdateRanges();
    this.mesh.instanceMatrix.addUpdateRange(0, n * 16);
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
