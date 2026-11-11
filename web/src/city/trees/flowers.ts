// Flower beds: each flower is a leafy rosette (a flat card plus two crossed upright ones) under a flat blossom card
// and a tilted one (the city is mostly seen from above). The atlas is painted once on a canvas: left half white
// five-petal blossoms (tinted per flower through the vertex colour), right half the rosette of pointed leaves.
import * as THREE from 'three';
import { rng } from '../util/random';

let atlas: THREE.CanvasTexture | null = null;

export function flowerAtlas(): THREE.CanvasTexture {
  if (atlas) return atlas;
  const W = 512, H = 256;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  const r = rng(77);
  // blossoms: a loose cluster of five-petal flowers, white petals with soft shading, golden centres
  for (let i = 0; i < 15; i++) {
    const ang = r() * Math.PI * 2, d = Math.sqrt(r()) * 82;
    const cx = 128 + Math.cos(ang) * d, cy = 128 + Math.sin(ang) * d, R = 20 + r() * 14;
    const rot = r() * Math.PI;
    for (let p = 0; p < 5; p++) {
      const a = rot + (p / 5) * Math.PI * 2;
      const px = cx + Math.cos(a) * R * 0.55, py = cy + Math.sin(a) * R * 0.55;
      const grad = g.createRadialGradient(cx, cy, R * 0.1, px, py, R * 0.6);
      grad.addColorStop(0, 'rgb(200,195,190)');
      grad.addColorStop(1, 'rgb(255,255,255)');
      g.fillStyle = grad;
      g.beginPath();
      g.ellipse(px, py, R * 0.5, R * 0.32, a, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = 'rgb(120,86,30)';
    g.beginPath();
    g.arc(cx, cy, R * 0.2, 0, Math.PI * 2);
    g.fill();
  }
  // rosette: pointed leaves radiating from the centre, darker underneath, lighter on top
  for (let layer = 0; layer < 3; layer++) {
    const n = 14 - layer * 3;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + r() * 0.5 + layer * 0.7;
      const len = (108 - layer * 26) * (0.75 + r() * 0.3);
      const bx = 384, by = 128;
      const tx = bx + Math.cos(a) * len, ty = by + Math.sin(a) * len;
      const sh = 62 + layer * 26 + Math.floor(r() * 30);
      g.fillStyle = `rgb(${Math.floor(sh * 0.5)},${sh + 34},${Math.floor(sh * 0.3)})`;
      g.beginPath();
      const nx = -Math.sin(a) * (15 - layer * 2), ny = Math.cos(a) * (15 - layer * 2);
      g.moveTo(bx, by);
      g.quadraticCurveTo((bx + tx) / 2 + nx, (by + ty) / 2 + ny, tx, ty);
      g.quadraticCurveTo((bx + tx) / 2 - nx, (by + ty) / 2 - ny, bx, by);
      g.fill();
    }
  }
  atlas = new THREE.CanvasTexture(c);
  atlas.colorSpace = THREE.SRGBColorSpace;
  atlas.anisotropy = 4;
  return atlas;
}

export function flowerMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    name: 'flower', map: flowerAtlas(), alphaTest: 0.5, side: THREE.DoubleSide, vertexColors: true, roughness: 0.7,
  });
  // normals point up (written so); don't flip them for back faces
  m.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <normal_fragment_begin>',
      THREE.ShaderChunk.normal_fragment_begin.replace('normal *= faceDirection;', ''),
    );
  };
  m.customProgramCacheKey = () => 'rlt-flower';
  return m;
}
