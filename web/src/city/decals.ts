// Road wear and street furniture painted onto the asphalt: darker wheel tracks along every lane, repaired patches,
// tar-sealed cracks, oil stains where cars park and stop, manhole covers and kerbside drain grates. One canvas atlas,
// one merged mesh (a single draw call), soft-edged and blended over the asphalt.
import * as THREE from 'three';
import { INTERSECTIONS } from '../../../shared/city-layout';
import { HALF_ROAD, ROAD_PIECES } from './layout';
import { type MeshWriter, Batch } from './util/mesh-writer';
import { rng } from './util/random';

// atlas tiles (4 × 2 grid of 256² cells; tracks use a full-width strip in the bottom row)
type Tile = 'manhole' | 'drain' | 'patch' | 'oil' | 'tar' | 'patch2' | 'track';
const CELL: Record<Exclude<Tile, 'track'>, [number, number]> = { manhole: [0, 0], drain: [1, 0], patch: [2, 0], oil: [3, 0], tar: [0, 1], patch2: [1, 1] };

let atlasTex: THREE.CanvasTexture | null = null;

function atlas(): THREE.CanvasTexture {
  if (atlasTex) return atlasTex;
  const W = 1024, H = 768, C = 256;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  const r = rng(515);
  const cell = (i: number, j: number) => [i * C, j * C] as const;

  // manhole: cast-iron disc with a raised grid pattern and a worn rim
  {
    const [x, y] = cell(0, 0);
    const cx = x + C / 2, cy = y + C / 2;
    g.fillStyle = 'rgba(40,40,42,1)';
    g.beginPath();
    g.arc(cx, cy, 118, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = 'rgba(95,92,88,1)';
    g.lineWidth = 9;
    g.beginPath();
    g.arc(cx, cy, 110, 0, Math.PI * 2);
    g.stroke();
    g.save();
    g.beginPath();
    g.arc(cx, cy, 100, 0, Math.PI * 2);
    g.clip();
    g.strokeStyle = 'rgba(78,76,74,1)';
    g.lineWidth = 5;
    for (let k = -100; k <= 100; k += 16) {
      g.beginPath();
      g.moveTo(cx + k, cy - 100);
      g.lineTo(cx + k + 30, cy + 100);
      g.stroke();
      g.beginPath();
      g.moveTo(cx - 100, cy + k);
      g.lineTo(cx + 100, cy + k - 30);
      g.stroke();
    }
    g.restore();
    g.fillStyle = 'rgba(28,28,30,1)';
    g.fillRect(cx - 14, cy - 4, 28, 8);
  }
  // drain grate: steel frame with slots
  {
    const [x, y] = cell(1, 0);
    g.fillStyle = 'rgba(52,52,54,1)';
    g.fillRect(x + 28, y + 70, 200, 116);
    g.fillStyle = 'rgba(8,8,9,1)';
    for (let k = 0; k < 9; k++) g.fillRect(x + 42 + k * 20.5, y + 82, 11, 92);
  }
  // blotches: soft irregular shapes built from overlapping radial gradients
  const blot = (cx: number, cy: number, R: number, col: [number, number, number], alpha: number, n: number) => {
    for (let k = 0; k < n; k++) {
      const a = r() * Math.PI * 2, d = r() * R * 0.45;
      const px = cx + Math.cos(a) * d, py = cy + Math.sin(a) * d, rr = R * (0.35 + r() * 0.4);
      const grad = g.createRadialGradient(px, py, 0, px, py, rr);
      grad.addColorStop(0, `rgba(${col[0]},${col[1]},${col[2]},${alpha})`);
      grad.addColorStop(1, `rgba(${col[0]},${col[1]},${col[2]},0)`);
      g.fillStyle = grad;
      g.fillRect(px - rr, py - rr, rr * 2, rr * 2);
    }
  };
  // repaired patch: a darker, smoother rectangle of newer asphalt with a sealed seam
  const patch = (i: number, j: number, w: number, h: number) => {
    const [x, y] = cell(i, j);
    const cx = x + C / 2, cy = y + C / 2;
    g.save();
    g.translate(cx, cy);
    g.rotate((r() - 0.5) * 0.08);
    g.fillStyle = 'rgba(22,22,24,0.55)';
    g.fillRect(-w / 2, -h / 2, w, h);
    g.strokeStyle = 'rgba(10,10,12,0.75)';
    g.lineWidth = 4;
    g.strokeRect(-w / 2, -h / 2, w, h);
    g.restore();
    for (let k = 0; k < 220; k++) {
      g.fillStyle = `rgba(${r() < 0.5 ? 70 : 12},${r() < 0.5 ? 70 : 12},${r() < 0.5 ? 72 : 14},${0.12 + r() * 0.12})`;
      g.fillRect(cx - w / 2 + r() * w, cy - h / 2 + r() * h, 2, 2);
    }
  };
  patch(2, 0, 210, 150);
  patch(1, 1, 150, 220);
  // oil stain: dark core, faint iridescent-free halo
  blot(3 * C + C / 2, C / 2, 95, [14, 13, 12], 0.5, 9);
  blot(3 * C + C / 2, C / 2, 40, [8, 8, 8], 0.55, 5);
  // tar snakes: wandering sealed cracks
  {
    const [x, y] = cell(0, 1);
    g.strokeStyle = 'rgba(9,9,10,0.8)';
    g.lineCap = 'round';
    for (let k = 0; k < 3; k++) {
      g.lineWidth = 5 + r() * 4;
      g.beginPath();
      let px = x + 20 + r() * 40, py = y + 30 + r() * 190;
      g.moveTo(px, py);
      for (let s = 0; s < 14; s++) {
        px += 14 + r() * 4;
        py += (r() - 0.5) * 34;
        py = Math.min(y + C - 16, Math.max(y + 16, py));
        g.lineTo(px, py);
      }
      g.stroke();
    }
  }
  // wheel track: a long soft dark streak (full width of the bottom row, along u)
  {
    const y0 = 2 * C;
    for (let k = 0; k < 900; k++) {
      const px = r() * W, py = y0 + C / 2 + (r() - 0.5) * C * 0.42 * (r() + 0.4);
      const rr = 18 + r() * 40;
      const grad = g.createRadialGradient(px, py, 0, px, py, rr);
      grad.addColorStop(0, 'rgba(12,12,13,0.07)');
      grad.addColorStop(1, 'rgba(12,12,13,0)');
      g.fillStyle = grad;
      g.fillRect(px - rr, py - rr, rr * 2, rr * 2);
    }
    // fade the track out toward the strip's top and bottom
    const fadeG = g.createLinearGradient(0, y0, 0, y0 + C);
    fadeG.addColorStop(0, 'rgba(0,0,0,1)');
    fadeG.addColorStop(0.3, 'rgba(0,0,0,0)');
    fadeG.addColorStop(0.7, 'rgba(0,0,0,0)');
    fadeG.addColorStop(1, 'rgba(0,0,0,1)');
    g.globalCompositeOperation = 'destination-out';
    g.fillStyle = fadeG;
    g.fillRect(0, y0, W, C);
    g.globalCompositeOperation = 'source-over';
  }
  atlasTex = new THREE.CanvasTexture(c);
  atlasTex.colorSpace = THREE.SRGBColorSpace;
  atlasTex.anisotropy = 8;
  return atlasTex;
}

function decalMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    name: 'road-decals', map: atlas(), transparent: true, depthWrite: false, roughness: 0.8, metalness: 0.05,
    polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
  });
}

/** Ground-aligned quad centred at (x, z), `along` = unit direction of its length. */
function put(w: MeshWriter, tile: Tile, x: number, z: number, len: number, wid: number, ax: number, az: number, y = 0.004, u0 = 0, u1 = 1): void {
  let a: number, b: number, c: number, d: number;
  if (tile === 'track') {
    a = u0;
    c = u1;
    b = 0;
    d = 1 / 3;
  } else {
    const [i, j] = CELL[tile];
    a = i / 4;
    c = (i + 1) / 4;
    // canvas rows run top-down; texture v runs bottom-up
    b = 1 - (j + 1) / 3;
    d = 1 - j / 3;
  }
  const hx = (ax * len) / 2, hz = (az * len) / 2;
  const px = (-az * wid) / 2, pz = (ax * wid) / 2;
  const i0 = w.vertex(x - hx - px, y, z - hz - pz, 0, 1, 0, a, b);
  w.vertex(x + hx - px, y, z + hz - pz, 0, 1, 0, c, b);
  w.vertex(x + hx + px, y, z + hz + pz, 0, 1, 0, c, d);
  w.vertex(x - hx + px, y, z - hz + pz, 0, 1, 0, a, d);
  w.indices(i0, i0 + 2, i0 + 1, i0, i0 + 3, i0 + 2);
}

export function buildRoadDecals(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'road-decals';
  const batch = new Batch();
  const w = batch.writer(decalMaterial(), { cast: false });
  const r = rng(808);
  for (const p of ROAD_PIECES) {
    const ax = p.axis === 'x' ? 1 : 0, az = p.axis === 'x' ? 0 : 1;
    const at = (along: number, across: number): [number, number] => (p.axis === 'x' ? [along, p.c + across] : [p.c + across, along]);
    const len = p.a1 - p.a0;
    // wheel tracks: two per lane, in segments so the texture's streaks don't repeat visibly
    for (const lane of [-3, 3]) {
      for (const off of [-0.85, 0.85]) {
        for (let s = p.a0; s < p.a1 - 0.5; s += 16) {
          const e = Math.min(p.a1, s + 16);
          const [x, z] = at((s + e) / 2, lane + off + (r() - 0.5) * 0.1);
          const u0 = r() * 0.5;
          put(w, 'track', x, z, e - s, 0.9, ax, az, 0.003, u0, u0 + ((e - s) / 16) * 0.5);
        }
      }
    }
    // manholes on the lane centres, drains at the kerb
    for (let s = p.a0 + 8 + r() * 10; s < p.a1 - 6; s += 28 + r() * 30) {
      const [x, z] = at(s, (r() < 0.5 ? -1 : 1) * (1.5 + r() * 1.8));
      put(w, 'manhole', x, z, 0.85, 0.85, ax, az, 0.006);
    }
    for (let s = p.a0 + 2 + r() * 4; s < p.a1 - 2; s += 22 + r() * 20) {
      const side = r() < 0.5 ? -1 : 1;
      const [x, z] = at(s, side * (HALF_ROAD - 0.42));
      put(w, 'drain', x, z, 0.9, 0.5, ax, az, 0.006);
    }
    // patches, tar snakes and oil stains (stains gather near the kerb and before junctions)
    const n = Math.round(len / 18);
    for (let k = 0; k < n; k++) {
      const s = p.a0 + 2 + r() * (len - 4);
      const roll = r();
      if (roll < 0.35) {
        const [x, z] = at(s, (r() - 0.5) * 8);
        put(w, r() < 0.5 ? 'patch' : 'patch2', x, z, 1.6 + r() * 2.2, 1.2 + r() * 1.4, ax, az, 0.004);
      } else if (roll < 0.7) {
        const [x, z] = at(s, (r() - 0.5) * 9);
        put(w, 'tar', x, z, 2.5 + r() * 3, 1.4 + r(), r() < 0.5 ? ax : az, r() < 0.5 ? az : ax, 0.005);
      } else {
        const [x, z] = at(s, (r() < 0.5 ? -1 : 1) * (HALF_ROAD - 1.2 - r() * 0.8));
        put(w, 'oil', x, z, 0.8 + r() * 1.1, 0.7 + r() * 0.9, ax, az, 0.005);
      }
    }
    // stains where cars wait at the junction
    for (const end of [p.a0 + 3, p.a1 - 3]) {
      if (r() < 0.6) {
        const [x, z] = at(end + (r() - 0.5) * 2, (end === p.a0 + 3 ? 1 : -1) * 3 * (p.axis === 'x' ? 1 : -1));
        put(w, 'oil', x, z, 1.4, 1.0, ax, az, 0.005);
      }
    }
  }
  // junction boxes: a manhole or two and some general grime
  for (const [x, z] of INTERSECTIONS) {
    if (r() < 0.5) put(w, 'manhole', x + (r() - 0.5) * 4, z + (r() - 0.5) * 4, 0.85, 0.85, 1, 0, 0.006);
    put(w, 'oil', x + (r() - 0.5) * 3, z + (r() - 0.5) * 3, 3.2, 2.6, 1, 0, 0.004);
  }
  for (const m of batch.build(group, 'road-decals')) {
    m.renderOrder = 1;
    m.receiveShadow = true;
    m.raycast = () => {};
  }
  return group;
}
