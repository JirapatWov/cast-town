// Central Park: a looping cobbled path with a fountain plaza, flower beds, hedges, benches and a grove.
import * as THREE from 'three';
import { LANDMARKS } from '../../../shared/city-layout';
import { LAWN_Y } from './layout';
import type { CityMaterials } from './materials';
import type { PropPlacement } from './street-props';
import type { Batch, MeshWriter } from './util/mesh-writer';
import { rng } from './util/random';
import type { Vegetation } from './vegetation';

const PATH_Y = LAWN_Y + 0.025;
const FLOWER_COLORS = [0xd97757, 0xf2c14e, 0xf7f3e8, 0xc45a7a, 0x8e75f0, 0xe8945a];

function roundedRect(x0: number, z0: number, x1: number, z1: number, r: number, path = false): THREE.Shape | THREE.Path {
  const s = path ? new THREE.Path() : new THREE.Shape();
  const y0 = -z1, y1 = -z0;
  s.moveTo(x0 + r, y0);
  s.lineTo(x1 - r, y0);
  s.quadraticCurveTo(x1, y0, x1, y0 + r);
  s.lineTo(x1, y1 - r);
  s.quadraticCurveTo(x1, y1, x1 - r, y1);
  s.lineTo(x0 + r, y1);
  s.quadraticCurveTo(x0, y1, x0, y1 - r);
  s.lineTo(x0, y0 + r);
  s.quadraticCurveTo(x0, y0, x0 + r, y0);
  return s;
}

function flat(w: MeshWriter, shape: THREE.Shape, y: number) {
  const g = new THREE.ShapeGeometry(shape, 10);
  g.rotateX(-Math.PI / 2);
  g.translate(0, y, 0);
  w.geometry(g);
  g.dispose();
}

function ring(w: MeshWriter, cx: number, cz: number, rOut: number, rIn: number, y0: number, h: number) {
  const shape = new THREE.Shape();
  shape.absarc(cx, -cz, rOut, 0, Math.PI * 2, false);
  const hole = new THREE.Path();
  hole.absarc(cx, -cz, rIn, 0, Math.PI * 2, true);
  shape.holes.push(hole);
  const g = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false, curveSegments: 40 });
  g.rotateX(-Math.PI / 2);
  g.translate(0, y0, 0);
  w.geometry(g);
  g.dispose();
}

export interface ParkResult {
  benches: PropPlacement[];
  lamps: PropPlacement[];
  bins: PropPlacement[];
  colliders: { x: number; z: number; r: number }[];
}

export function buildPark(batch: Batch, mats: CityMaterials, veg: Vegetation): ParkResult {
  const park = LANDMARKS.find((l) => l.kind === 'park')!;
  const cx = park.x, cz = park.z;
  const hw = park.width / 2, hd = park.depth / 2;
  const x0 = cx - hw, x1 = cx + hw, z0 = cz - hd, z1 = cz + hd;
  const paving = batch.writer(mats.paving, { cast: false });
  const stone = batch.writer(mats.stone);
  const water = batch.writer(mats.water, { cast: false });
  const r = rng(77);

  // loop path + spokes to each side + a central plaza
  const loop = roundedRect(x0 + 6, z0 + 6, x1 - 6, z1 - 6, 8) as THREE.Shape;
  loop.holes.push(roundedRect(x0 + 8.6, z0 + 8.6, x1 - 8.6, z1 - 8.6, 6, true) as THREE.Path);
  flat(paving, loop, PATH_Y);
  const plaza = new THREE.Shape();
  plaza.absarc(cx, -cz, 7.5, 0, Math.PI * 2, false);
  flat(paving, plaza, PATH_Y + 0.004);
  const spoke = (ax: number, az: number, bx: number, bz: number, w: number) => {
    const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz);
    const nx = (-dz / len) * (w / 2), nz = (dx / len) * (w / 2);
    paving.quad(
      { x: ax + nx, y: PATH_Y + 0.002, z: az + nz }, { x: bx + nx, y: PATH_Y + 0.002, z: bz + nz },
      { x: bx - nx, y: PATH_Y + 0.002, z: bz - nz }, { x: ax - nx, y: PATH_Y + 0.002, z: az - nz },
      [[ax + nx, az + nz], [bx + nx, bz + nz], [bx - nx, bz - nz], [ax - nx, az - nz]],
    );
  };
  spoke(x0 - 0.5, cz, cx - 7, cz, 2.4);
  spoke(cx + 7, cz, x1 + 0.5, cz, 2.4);
  spoke(cx, z1 + 0.5, cx, cz + 7, 2.4);
  spoke(cx, z0 - 0.5, cx, cz - 7, 2.4);

  // fountain: basin ring, water, pedestal + bowl
  stone.setColor([1.05, 1.02, 0.98]);
  ring(stone, cx, cz, 3.6, 3.15, PATH_Y, 0.55);
  ring(stone, cx, cz, 3.75, 3.6, PATH_Y, 0.08);
  const disc = new THREE.Shape();
  disc.absarc(cx, -cz, 3.16, 0, Math.PI * 2, false);
  flat(water, disc, PATH_Y + 0.42);
  const col = new THREE.CylinderGeometry(0.35, 0.5, 1.5, 16);
  stone.geometry(col, new THREE.Matrix4().makeTranslation(cx, PATH_Y + 0.75, cz));
  const bowl = new THREE.CylinderGeometry(1.25, 0.45, 0.4, 24);
  stone.geometry(bowl, new THREE.Matrix4().makeTranslation(cx, PATH_Y + 1.6, cz));
  const bowlWater = new THREE.Shape();
  bowlWater.absarc(cx, -cz, 1.12, 0, Math.PI * 2, false);
  flat(water, bowlWater, PATH_Y + 1.78);
  col.dispose();
  bowl.dispose();

  // flower beds around the plaza (between the spokes), edged with stone
  for (let q = 0; q < 4; q++) {
    const a = Math.PI / 4 + (q * Math.PI) / 2;
    const bx = cx + Math.cos(a) * 10.5, bz = cz + Math.sin(a) * 10.5;
    stone.setColor([0.95, 0.92, 0.88]);
    ring(stone, bx, bz, 2.6, 2.35, LAWN_Y, 0.18);
    const soil = new THREE.Shape();
    soil.absarc(bx, -bz, 2.36, 0, Math.PI * 2, false);
    stone.setColor([0.38, 0.3, 0.24]);
    flat(stone, soil, LAWN_Y + 0.1);
    const c1 = FLOWER_COLORS[q % FLOWER_COLORS.length], c2 = FLOWER_COLORS[(q + 2) % FLOWER_COLORS.length];
    for (let i = 0; i < 95; i++) {
      const rr = Math.sqrt(r()) * 2.15, aa = r() * Math.PI * 2;
      veg.addFlower(bx + Math.cos(aa) * rr, bz + Math.sin(aa) * rr, LAWN_Y + 0.1, rr < 1.1 ? c1 : c2);
    }
    veg.addShrub(bx, bz, LAWN_Y + 0.1, 0.8);
  }

  // hedges framing the park edge, with gaps where the spokes enter
  const hedge = (ax: number, az: number, bx: number, bz: number) => {
    const len = Math.hypot(bx - ax, bz - az);
    veg.addHedge((ax + bx) / 2, (az + bz) / 2, LAWN_Y, len, Math.atan2(-(bz - az), bx - ax), 0.95, 0.8);
  };
  const gap = 2.2;
  hedge(x0 + 1, z0 + 1, cx - gap, z0 + 1); hedge(cx + gap, z0 + 1, x1 - 1, z0 + 1);
  hedge(x0 + 1, z1 - 1, cx - gap, z1 - 1); hedge(cx + gap, z1 - 1, x1 - 1, z1 - 1);
  hedge(x0 + 1, z0 + 1.5, x0 + 1, cz - gap); hedge(x0 + 1, cz + gap, x0 + 1, z1 - 1.5);
  hedge(x1 - 1, z0 + 1.5, x1 - 1, cz - gap); hedge(x1 - 1, cz + gap, x1 - 1, z1 - 1.5);

  // grove: trees in the lawn between hedge and loop, and inside the loop corners
  const placed: { x: number; z: number }[] = [];
  const free = (x: number, z: number) => {
    const inLoopBand = x > x0 + 4.8 && x < x1 - 4.8 && z > z0 + 4.8 && z < z1 - 4.8 && !(x > x0 + 9.8 && x < x1 - 9.8 && z > z0 + 9.8 && z < z1 - 9.8);
    const nearSpoke = Math.abs(x - cx) < 3.2 || Math.abs(z - cz) < 3.2;
    const nearPlaza = Math.hypot(x - cx, z - cz) < 14.5;
    return !inLoopBand && !nearSpoke && !nearPlaza && !placed.some((p) => Math.hypot(p.x - x, p.z - z) < 6.2);
  };
  for (let i = 0; i < 600 && placed.length < 34; i++) {
    const x = x0 + 3 + r() * (park.width - 6), z = z0 + 3 + r() * (park.depth - 6);
    if (!free(x, z)) continue;
    placed.push({ x, z });
    veg.addTree(r() < 0.2 ? 'columnar' : 'broadleaf', x, z, LAWN_Y, 1.0 + r() * 0.4, { autumn: r() < 0.12 });
  }

  // benches around the plaza and along the loop, lamps at the plaza
  const benches: PropPlacement[] = [];
  const lamps: PropPlacement[] = [];
  const bins: PropPlacement[] = [];
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2 + Math.PI / 8;
    benches.push({ x: cx + Math.cos(a) * 6.6, z: cz + Math.sin(a) * 6.6, y: PATH_Y, rotY: -a - Math.PI / 2 });
  }
  for (const a of [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4]) {
    lamps.push({ x: cx + Math.cos(a) * 8.1, z: cz + Math.sin(a) * 8.1, y: LAWN_Y, rotY: 0 });
  }
  bins.push({ x: cx + 7.8, z: cz + 1.6, y: PATH_Y, rotY: 0 }, { x: cx - 7.8, z: cz - 1.6, y: PATH_Y, rotY: 0 });
  return { benches, lamps, bins, colliders: [{ x: cx, z: cz, r: 3.8 }] };
}
