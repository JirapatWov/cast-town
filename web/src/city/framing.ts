// The town's start view, fitted to the screen (finding #63): a phone held upright sees a narrow slice of the town from
// the desktop's start pose, and the user's own houses fell off its edge (todo-api's name tag at x = -199). When the
// houses don't all fit, the view turns toward them and steps back until they do. Pure, so it can be tested.
import * as THREE from 'three';

export interface FramePose {
  target: THREE.Vector3;
  radius: number;
  phi: number;
  theta: number;
}

type P3 = { x: number; y: number; z: number };

/** Room kept clear at the screen's edges, in px: half a name tag at the sides, the bars at top and bottom. */
const PAD = { side: 80, top: 120, bottom: 120 };
const TURNS = 16;

const _cam = new THREE.PerspectiveCamera();
const _sph = new THREE.Spherical();
const _v = new THREE.Vector3();

/** Is every point on screen, clear of the pads, seen from `pose`? */
export function poseShows(pose: FramePose, points: readonly P3[], view: { width: number; height: number }, fov: number): boolean {
  _cam.fov = fov;
  _cam.aspect = view.width / view.height;
  _cam.near = 0.5;
  _cam.far = 5000;
  _cam.updateProjectionMatrix();
  _sph.set(pose.radius, pose.phi, pose.theta);
  _cam.position.setFromSpherical(_sph).add(pose.target);
  _cam.lookAt(pose.target);
  _cam.updateMatrixWorld(true);
  const mx = 1 - (2 * PAD.side) / view.width;
  const top = 1 - (2 * PAD.top) / view.height;
  const bottom = -1 + (2 * PAD.bottom) / view.height;
  return points.every((p) => {
    _v.set(p.x, p.y, p.z).project(_cam);
    return _v.z < 1 && Math.abs(_v.x) <= mx && _v.y <= top && _v.y >= bottom;
  });
}

/** `base` when it already shows every point; else a view centred on the points (same tilt) that does: facing as
 *  `base` does if stepping back is enough, turned as little as will do otherwise. With nothing that fits, `base`. */
export function framePose(base: FramePose, points: readonly P3[], view: { width: number; height: number }, fov: number, maxRadius: number): FramePose {
  if (!points.length || view.width < 50 || view.height < 50 || poseShows(base, points, view, fov)) return base;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of points) {
    x0 = Math.min(x0, p.x);
    x1 = Math.max(x1, p.x);
    z0 = Math.min(z0, p.z);
    z1 = Math.max(z1, p.z);
  }
  const target = new THREE.Vector3((x0 + x1) / 2, 0, (z0 + z1) / 2);
  for (let k = 0; k < TURNS; k++) {
    // base's own facing first, then ever further turns either way
    const theta = base.theta + Math.ceil(k / 2) * (k % 2 ? 1 : -1) * ((Math.PI * 2) / TURNS);
    for (let radius = Math.min(base.radius, maxRadius); radius <= maxRadius; radius += 10) {
      const pose = { target, radius, phi: base.phi, theta };
      if (poseShows(pose, points, view, fov)) return pose;
    }
  }
  return base;
}
