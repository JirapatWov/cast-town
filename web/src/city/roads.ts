// Ground, asphalt, lane markings, crosswalks, raised sidewalks with curbs, and block lawns.
import * as THREE from 'three';
import { INTERSECTIONS } from '../../../shared/city-layout';
import type { CityMaterials } from './materials';
import { armsAt, BLOCKS, CURB_W, HALF_ROAD, LAWN_Y, ROAD_PIECES, SIDEWALK_WIDTH, TOWN, WALK_Y, type Rect } from './layout';
import { Batch, type MeshWriter } from './util/mesh-writer';

const BLOCK_CORNER_R = 4.5;
const OUTER_CORNER_R = 10;
const MARK_Y = 0.012;

/** Rounded rectangle as a THREE.Shape in extrude space (shape y = -world z). */
function roundedRectShape(r: Rect, radius: number, asPath = false): THREE.Shape | THREE.Path {
  const s = asPath ? new THREE.Path() : new THREE.Shape();
  const { x0, x1 } = r;
  const y0 = -r.z1, y1 = -r.z0; // flip
  const rad = Math.max(0.01, Math.min(radius, (x1 - x0) / 2, (y1 - y0) / 2));
  s.moveTo(x0 + rad, y0);
  s.lineTo(x1 - rad, y0);
  s.quadraticCurveTo(x1, y0, x1, y0 + rad);
  s.lineTo(x1, y1 - rad);
  s.quadraticCurveTo(x1, y1, x1 - rad, y1);
  s.lineTo(x0 + rad, y1);
  s.quadraticCurveTo(x0, y1, x0, y1 - rad);
  s.lineTo(x0, y0 + rad);
  s.quadraticCurveTo(x0, y0, x0 + rad, y0);
  return s;
}

const inset = (r: Rect, d: number): Rect => ({ x0: r.x0 + d, z0: r.z0 + d, x1: r.x1 - d, z1: r.z1 - d });

/** Flat ring (outer minus hole) extruded upward to `height`, written into `w`. */
function extrudeRing(w: MeshWriter, outer: Rect, outerR: number, hole: Rect, holeR: number, height: number, y0 = 0) {
  const shape = roundedRectShape(outer, outerR) as THREE.Shape;
  shape.holes.push(roundedRectShape(hole, holeR, true) as THREE.Path);
  const g = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false, curveSegments: 8 });
  g.rotateX(-Math.PI / 2);
  g.translate(0, y0, 0);
  w.geometry(g);
  g.dispose();
}

function flatShape(w: MeshWriter, shape: THREE.Shape, y: number) {
  const g = new THREE.ShapeGeometry(shape, 8);
  g.rotateX(-Math.PI / 2);
  g.translate(0, y, 0);
  w.geometry(g);
  g.dispose();
}

/** Axis-aligned flat quad on the road with UVs that match the asphalt mapping (rotated for x-roads). */
function roadQuad(w: MeshWriter, x0: number, z0: number, x1: number, z1: number, y: number, uvAlongX: boolean) {
  const uv = (x: number, z: number): [number, number] => (uvAlongX ? [z, x] : [x, z]);
  w.quad(
    { x: x0, y, z: z1 }, { x: x1, y, z: z1 }, { x: x1, y, z: z0 }, { x: x0, y, z: z0 },
    [uv(x0, z1), uv(x1, z1), uv(x1, z0), uv(x0, z0)],
  );
}

function buildAsphalt(w: MeshWriter) {
  // x-roads get UVs rotated 90° so the texture's long cracks run along the direction of travel.
  for (const p of ROAD_PIECES) {
    if (p.axis === 'x') roadQuad(w, p.a0, p.c - HALF_ROAD, p.a1, p.c + HALF_ROAD, 0, true);
    else roadQuad(w, p.c - HALF_ROAD, p.a0, p.c + HALF_ROAD, p.a1, 0, false);
  }
  for (const [x, z] of INTERSECTIONS) roadQuad(w, x - HALF_ROAD, z - HALF_ROAD, x + HALF_ROAD, z + HALF_ROAD, 0, false);
  // fill under the rounded curb corners
  for (const b of BLOCKS) {
    const r = BLOCK_CORNER_R;
    for (const [cx, cz] of [[b.x0, b.z0], [b.x1 - r, b.z0], [b.x0, b.z1 - r], [b.x1 - r, b.z1 - r]]) roadQuad(w, cx, cz, cx + r, cz + r, -0.002, false);
  }
}

function buildMarkings(w: MeshWriter) {
  const dash = 3, gap = 5, lineW = 0.14;
  for (const p of ROAD_PIECES) {
    const along = p.axis === 'x';
    const armsStart = armsAt(along ? p.a0 - HALF_ROAD : p.c, along ? p.c : p.a0 - HALF_ROAD).length;
    const armsEnd = armsAt(along ? p.a1 + HALF_ROAD : p.c, along ? p.c : p.a1 + HALF_ROAD).length;
    const s0 = p.a0 + (armsStart > 2 ? 5.5 : 1);
    const s1 = p.a1 - (armsEnd > 2 ? 5.5 : 1);
    const q = (a0: number, a1: number, c0: number, c1: number) =>
      along ? roadQuad(w, a0, c0, a1, c1, MARK_Y, true) : roadQuad(w, c0, a0, c1, a1, MARK_Y, false);
    // dashed centre line
    const len = s1 - s0;
    const n = Math.floor((len + gap) / (dash + gap));
    const start = s0 + (len - (n * (dash + gap) - gap)) / 2;
    for (let i = 0; i < n; i++) {
      const a = start + i * (dash + gap);
      q(a, a + dash, p.c - lineW / 2, p.c + lineW / 2);
    }
    // solid edge lines
    for (const side of [-1, 1]) {
      const e = p.c + side * (HALF_ROAD - 0.55);
      q(s0, s1, e - 0.06, e + 0.06);
    }
  }

  // crosswalks + stop lines on every arm of T and cross intersections
  for (const [x, z] of INTERSECTIONS) {
    const arms = armsAt(x, z);
    if (arms.length < 3) continue;
    for (const { dx, dz } of arms) {
      const stripeW = 0.5, stripeGap = 0.55, d0 = HALF_ROAD + 0.8, d1 = HALF_ROAD + 3.8;
      for (let o = -HALF_ROAD + 0.7; o + stripeW <= HALF_ROAD - 0.6; o += stripeW + stripeGap) {
        if (dx !== 0) {
          const xa = x + dx * d0, xb = x + dx * d1;
          roadQuad(w, Math.min(xa, xb), z + o, Math.max(xa, xb), z + o + stripeW, MARK_Y, true);
        } else {
          const za = z + dz * d0, zb = z + dz * d1;
          roadQuad(w, x + o, Math.min(za, zb), x + o + stripeW, Math.max(za, zb), MARK_Y, false);
        }
      }
      // stop line across the inbound lane (right-hand traffic)
      const sd = HALF_ROAD + 4.5, sw = 0.4;
      const lx = dz, lz = -dx; // offset towards the inbound lane
      if (dx !== 0) {
        const xa = x + dx * sd, xb = x + dx * (sd + sw);
        const zc = z + lz * HALF_ROAD * 0.5;
        roadQuad(w, Math.min(xa, xb), zc - HALF_ROAD * 0.5 + 0.3, Math.max(xa, xb), zc + HALF_ROAD * 0.5 - 0.3, MARK_Y, true);
      } else {
        const za = z + dz * sd, zb = z + dz * (sd + sw);
        const xc = x + lx * HALF_ROAD * 0.5;
        roadQuad(w, xc - HALF_ROAD * 0.5 + 0.3, Math.min(za, zb), xc + HALF_ROAD * 0.5 - 0.3, Math.max(za, zb), MARK_Y, false);
      }
    }
  }
}

export interface RoadsResult {
  group: THREE.Group;
}

export function buildRoads(mats: CityMaterials): RoadsResult {
  const group = new THREE.Group();
  group.name = 'roads';
  const batch = new Batch();

  buildAsphalt(batch.writer(mats.asphalt, { cast: false }));
  buildMarkings(batch.writer(mats.marking, { cast: false }));

  const curb = batch.writer(mats.curb, { cast: false });
  const walk = batch.writer(mats.sidewalk, { cast: false });
  const lawn = batch.writer(mats.lawn, { cast: false });

  for (const b of BLOCKS) {
    const walkOuter = inset(b, CURB_W);
    const walkInner = inset(b, SIDEWALK_WIDTH);
    extrudeRing(curb, b, BLOCK_CORNER_R, walkOuter, BLOCK_CORNER_R - CURB_W, WALK_Y);
    extrudeRing(walk, walkOuter, BLOCK_CORNER_R - CURB_W, walkInner, 1.2, WALK_Y);
    flatShape(lawn, roundedRectShape(walkInner, 1.2) as THREE.Shape, LAWN_Y);
  }

  // Outer ring: curb + sidewalk outside the ring road, then the open countryside.
  const outerCurb = inset(TOWN, -CURB_W);
  const outerWalk = inset(TOWN, -SIDEWALK_WIDTH);
  extrudeRing(curb, outerCurb, OUTER_CORNER_R + CURB_W, TOWN, OUTER_CORNER_R, WALK_Y);
  extrudeRing(walk, outerWalk, OUTER_CORNER_R + SIDEWALK_WIDTH, outerCurb, OUTER_CORNER_R + CURB_W, WALK_Y);

  const groundShape = new THREE.Shape();
  groundShape.absarc(0, 0, 3000, 0, Math.PI * 2, false);
  groundShape.holes.push(roundedRectShape(outerWalk, OUTER_CORNER_R + SIDEWALK_WIDTH, true) as THREE.Path);
  flatShape(batch.writer(mats.ground, { cast: false }), groundShape, LAWN_Y);

  batch.build(group, 'roads');
  return { group };
}
