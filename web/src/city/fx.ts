// Cheap glow effects (no real lights: adding/removing lights recompiles every shader in the scene):
// additive halo sprites, a soft ground ring and warm light pools, all from small canvas gradients.
import * as THREE from 'three';

let halo: THREE.Texture | null = null;
let lightPoolTex: THREE.Texture | null = null;
let ring: THREE.Texture | null = null;
let pool: THREE.Texture | null = null;

function radial(size: number, stops: [number, string][]): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [o, col] of stops) grad.addColorStop(o, col);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function haloTexture(): THREE.Texture {
  return (halo ??= radial(128, [[0, 'rgba(255,255,255,1)'], [0.12, 'rgba(255,255,255,0.85)'], [0.35, 'rgba(255,255,255,0.22)'], [1, 'rgba(255,255,255,0)']]));
}

export function ringTexture(): THREE.Texture {
  return (ring ??= radial(256, [
    [0, 'rgba(255,255,255,0)'], [0.72, 'rgba(255,255,255,0)'], [0.86, 'rgba(255,255,255,0.95)'], [0.9, 'rgba(255,255,255,0.7)'], [1, 'rgba(255,255,255,0)'],
  ]));
}

export function poolTexture(): THREE.Texture {
  return (pool ??= radial(128, [[0, 'rgba(255,255,255,0.9)'], [0.4, 'rgba(255,255,255,0.4)'], [1, 'rgba(255,255,255,0)']]));
}

export function additive(map: THREE.Texture, color: THREE.ColorRepresentation, opacity = 1): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    map, color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, fog: true,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
}

/** Flat decal lying on the ground (XZ plane). */
export function groundDecal(size: number, mat: THREE.Material): THREE.Mesh {
  const g = new THREE.PlaneGeometry(size, size);
  g.rotateX(-Math.PI / 2);
  const m = new THREE.Mesh(g, mat);
  m.renderOrder = 2;
  m.raycast = () => {};
  return m;
}

export function haloSprite(color: THREE.ColorRepresentation, size: number): THREE.Sprite {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: haloTexture(), color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  s.scale.setScalar(size);
  s.renderOrder = 3;
  s.raycast = () => {};
  return s;
}

/** Light falloff in the colour channels (no alpha: see lightPoolMaterial). */
export function lightPoolTexture(): THREE.Texture {
  if (lightPoolTex) return lightPoolTex;
  const size = 128;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [o, v] of [[0, 1], [0.15, 0.85], [0.4, 0.42], [0.7, 0.12], [1, 0]] as const) grad.addColorStop(o, `rgb(${v * 255},${v * 255},${v * 255})`);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  lightPoolTex = new THREE.CanvasTexture(c);
  return lightPoolTex;
}

/**
 * A pool of light on the ground, blended as dst + dst × light: it brightens whatever is underneath in its own colour
 * (asphalt stays dark-ish, paving and grass pick up warm light) instead of painting a glowing disc. The material's
 * colour is the light (components may exceed 1); opacity has no effect.
 */
export function lightPoolMaterial(): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    name: 'light-pool', map: lightPoolTexture(), color: 0x000000, transparent: true, depthWrite: false, fog: false,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.DstColorFactor, blendDst: THREE.OneFactor,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
}
