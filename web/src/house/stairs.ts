// Staircase: a straight open-riser flight (thick oak treads on two black steel stringers) climbing one storey
// along the right wall, a frameless glass balustrade with an oak handrail on the open side and a slim wall rail.
// Upstairs, a glass railing guards the stairwell opening beside the gallery.
import * as THREE from 'three';
import { STOREY_H } from '../../../shared/house-plan';
import { metricUV } from './furniture/kit';
import { ROOM, STAIR } from './layout';
import type { Palette } from './materials';

const RUN = STAIR.bottomZ - STAIR.topZ;
const SLOPE = Math.atan2(STOREY_H, RUN);

/** Walking-surface height along the flight (0 at the foot, STOREY_H at the landing). */
export function flightHeight(z: number): number {
  return STOREY_H * THREE.MathUtils.clamp((STAIR.bottomZ - z) / RUN, 0, 1);
}

export function inStairLane(x: number): boolean {
  return x > STAIR.laneX0 - 0.05 && x < STAIR.laneX1 + 0.1;
}

let glassMat: THREE.MeshPhysicalMaterial | null = null;
function railGlass(): THREE.MeshPhysicalMaterial {
  glassMat ??= new THREE.MeshPhysicalMaterial({
    color: '#e6f1ef', roughness: 0.05, metalness: 0, transparent: true, opacity: 0.18, envMapIntensity: 1.3,
    depthWrite: false, side: THREE.DoubleSide,
  });
  return glassMat;
}

function box(w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = m.receiveShadow = true;
  return m;
}

/** A bar from a to b (oak handrail, steel rail) with a rounded-rectangle-ish section. */
function bar(a: THREE.Vector3, b: THREE.Vector3, w: number, h: number, mat: THREE.Material): THREE.Mesh {
  const len = a.distanceTo(b);
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, len), mat);
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.lookAt(b.x + (m.parent ? 0 : 0), b.y, b.z);
  m.castShadow = m.receiveShadow = true;
  return m;
}

/** Glass panel spanning a sloped (or level) run: bottom edge a→b, `h` tall. */
function glassPanel(a: THREE.Vector3, b: THREE.Vector3, h: number): THREE.Mesh {
  const g = new THREE.BufferGeometry();
  const v = [a.x, a.y, a.z, b.x, b.y, b.z, b.x, b.y + h, b.z, a.x, a.y + h, a.z];
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, railGlass());
  m.renderOrder = 2;
  m.castShadow = false;
  m.receiveShadow = false;
  return m;
}

export interface Flight {
  group: THREE.Group;
  /** Show the flight only up to this height (floor-local m): the dollhouse cuts the stair like the walls beside it,
   *  so it never pokes up out of a cut-away floor into the empty storey above. */
  setVisibleTop(y: number): void;
}

/** Height the flight is shown up to, for the height of the wall it climbs along (cut 0.4 m → about 1.2 m of stair,
 *  enough to read as "stairs going up"; full wall → everything below the ceiling). */
export function flightTopFor(wallHeight: number): number {
  return THREE.MathUtils.mapLinear(THREE.MathUtils.clamp(wallHeight, ROOM.cutHeight, ROOM.height), ROOM.cutHeight, ROOM.height, 1.25, ROOM.height);
}

/** One flight from this floor (y = 0 at z = bottomZ) up to the next landing (y = STOREY_H at z = topZ). Every part is
 *  an instanced mesh with one instance per tread (bottom first), so cutting the flight is just an instance count. */
export function buildFlight(pal: Palette): Flight {
  const g = new THREE.Group();
  g.name = 'stair-flight';
  const { laneX0: x0, laneX1: x1, bottomZ, risers } = STAIR;
  const treads = risers - 1;
  const going = RUN / treads;
  const rise = STOREY_H / risers;
  const w = x1 - x0;
  const cx = (x0 + x1) / 2;
  const T = 0.055;
  const seg = Math.hypot(going, rise);
  const up = new THREE.Vector3(0, rise, -going).normalize();
  const qSlope = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), up);
  const m = new THREE.Matrix4(), one = new THREE.Vector3(1, 1, 1);
  const inst = (geo: THREE.BufferGeometry, mat: THREE.Material, n: number, shadow = true) => {
    const im = new THREE.InstancedMesh(geo, mat, n);
    im.castShadow = shadow;
    im.receiveShadow = true;
    im.frustumCulled = false; // the instances span the whole flight; the base geometry's bounds do not
    g.add(im);
    return im;
  };
  // oak treads
  const tread = inst(metricUV(new THREE.BoxGeometry(w - 0.04, T, going + 0.035)), pal.oak, treads);
  for (let i = 0; i < treads; i++) {
    const zFront = bottomZ - i * going;
    tread.setMatrixAt(i, m.makeTranslation(cx, (i + 1) * rise - T / 2, zFront - going / 2 + 0.0175));
  }
  // steel stringers under both tread ends, one sloped segment per tread
  const stringer = inst(new THREE.BoxGeometry(0.016, 0.24, seg * 1.04), pal.blackMetal, treads * 2);
  const nose = (z: number) => flightHeight(z) + 0.06;
  for (let i = 0; i < treads; i++) {
    const zMid = bottomZ - (i + 0.5) * going;
    for (const [k, x] of [x0 + 0.05, x1 - 0.05].entries()) {
      stringer.setMatrixAt(i * 2 + k, m.compose(new THREE.Vector3(x, flightHeight(zMid) - 0.1, zMid), qSlope, one));
    }
  }
  // frameless glass balustrade on the open side (sheared quads), oak handrail over it, slim steel rail on the wall
  const quadGeo = new THREE.BufferGeometry();
  quadGeo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 1, 0, 1, 1, 0, 1, 0], 3));
  quadGeo.setAttribute('normal', new THREE.Float32BufferAttribute([1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0], 3));
  quadGeo.setIndex([0, 1, 2, 0, 2, 3]);
  const glass = inst(quadGeo, railGlass(), treads, false);
  glass.renderOrder = 2;
  const gx = x0 + 0.012;
  const panelH = 0.86;
  for (let i = 0; i < treads; i++) {
    const za = bottomZ - i * going, zb = za - going;
    const a = new THREE.Vector3(gx, nose(za), za), b = new THREE.Vector3(gx, nose(zb), zb);
    const d = b.clone().sub(a);
    m.set(1, 0, d.x, a.x, 0, panelH, d.y, a.y, 0, 0, d.z, a.z, 0, 0, 0, 1);
    glass.setMatrixAt(i, m);
  }
  const rail = inst(new THREE.BoxGeometry(0.05, 0.045, seg * 1.02), pal.oak, treads);
  const wallRail = inst(new THREE.CylinderGeometry(0.018, 0.018, seg * 1.02, 10).rotateX(Math.PI / 2), pal.blackMetal, treads);
  const wx = x1 + 0.05;
  for (let i = 0; i < treads; i++) {
    const zMid = bottomZ - (i + 0.5) * going;
    rail.setMatrixAt(i, m.compose(new THREE.Vector3(gx, nose(zMid) + 0.9, zMid), qSlope, one));
    wallRail.setMatrixAt(i, m.compose(new THREE.Vector3(wx, nose(zMid) + 0.88, zMid), qSlope, one));
  }
  const parts: [THREE.InstancedMesh, number][] = [[tread, 1], [stringer, 2]];
  // the balustrade and rails stand ~0.9 m above the treads: in the cutaway they stop where their top would pass the
  // cut line (instead of a glass fin and handrail sailing over the cut-down wall into the garden behind)
  const guards: THREE.InstancedMesh[] = [glass, rail, wallRail];
  let shown = -1, shownGuard = -1;
  return {
    group: g,
    setVisibleTop(y) {
      // whole treads only: a cut lands between two treads, never through one
      const n = THREE.MathUtils.clamp(Math.floor(y / rise + 1e-3), 0, treads);
      const full = y >= ROOM.height - 0.01;
      const ng = full ? n : THREE.MathUtils.clamp(Math.floor((y - 0.7) / rise + 1e-3), 0, n);
      if (n === shown && ng === shownGuard) return;
      shown = n;
      shownGuard = ng;
      for (const [im, k] of parts) im.count = n * k;
      for (const im of guards) im.count = ng;
    },
  };
}

/** Upstairs: glass railing along the stairwell opening (gallery side), plus a closing panel at the far end of the
 *  opening when no flight continues up from this floor. */
export function buildWellRailing(pal: Palette, closeEnd: boolean): THREE.Group {
  const g = new THREE.Group();
  g.name = 'stair-railing';
  const { laneX0: x0, laneX1: x1, topZ, holeZ1 } = STAIR;
  const H = 0.95;
  const runs: [THREE.Vector3, THREE.Vector3][] = [[new THREE.Vector3(x0 - 0.02, 0, topZ + 0.05), new THREE.Vector3(x0 - 0.02, 0, holeZ1)]];
  if (closeEnd) runs.push([new THREE.Vector3(x0 - 0.02, 0, holeZ1 + 0.02), new THREE.Vector3(x1 + 0.08, 0, holeZ1 + 0.02)]);
  for (const [a, b] of runs) {
    g.add(glassPanel(a.clone().setY(0.05), b.clone().setY(0.05), H - 0.08));
    g.add(bar(a.clone().setY(H), b.clone().setY(H), 0.055, 0.045, pal.oak));
    g.add(bar(a.clone().setY(0.03), b.clone().setY(0.03), 0.04, 0.06, pal.blackMetal));
    // end posts
    for (const p of [a, b]) g.add(box(0.045, H, 0.045, pal.blackMetal, p.x, H / 2, p.z));
  }
  return g;
}
