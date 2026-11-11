// Walking paths: a path is cut into legs at its sharp corners (people stop there, turn on the spot and walk on);
// each leg is followed by pure pursuit (steer toward a point a little ahead on the path) with a speed limit that
// brakes in time for every corner ahead and for the end of the leg.
import * as THREE from 'three';

/** Angle (rad) between the direction a → b and the direction b → c. */
export function cornerAngle(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): number {
  const x1 = b.x - a.x, z1 = b.z - a.z, x2 = c.x - b.x, z2 = c.z - b.z;
  const l = Math.hypot(x1, z1) * Math.hypot(x2, z2);
  return l > 1e-9 ? Math.acos(THREE.MathUtils.clamp((x1 * x2 + z1 * z2) / l, -1, 1)) : 0;
}

/** `start` + `path` without near-duplicate points, cut at corners sharper than `sharp` (rad). Each leg starts at
 *  the previous leg's end. */
export function splitLegs(start: THREE.Vector3, path: THREE.Vector3[], sharp: number): THREE.Vector3[][] {
  const pts = [start.clone().setY(0)];
  for (const p of path) if (Math.hypot(p.x - pts[pts.length - 1].x, p.z - pts[pts.length - 1].z) > 0.02) pts.push(p.clone().setY(0));
  if (pts.length < 2) return [];
  const legs: THREE.Vector3[][] = [];
  let leg = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    leg.push(pts[i]);
    if (i < pts.length - 1 && cornerAngle(pts[i - 1], pts[i], pts[i + 1]) > sharp) {
      legs.push(leg);
      leg = [pts[i]];
    }
  }
  legs.push(leg);
  return legs;
}

/** Length of a polyline. */
export function legLength(pts: THREE.Vector3[]): number {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
  return l;
}

/** One leg (no sharp corners) followed from its first point. */
export class Track {
  private k = 0;
  private t = 0;
  private lens: number[] = [];

  constructor(readonly pts: THREE.Vector3[]) {
    for (let i = 1; i < pts.length; i++) this.lens.push(Math.max(1e-6, Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z)));
  }

  get end(): THREE.Vector3 {
    return this.pts[this.pts.length - 1];
  }

  /** Move along with the walker at `p` (the segment it is on, how far along); returns the length left. */
  update(p: THREE.Vector3): number {
    const last = this.pts.length - 2;
    for (;;) {
      this.t = this.param(this.k, p);
      if (this.k >= last) break;
      // past this segment's end, or nearer the next one (pure pursuit cuts corners): move on
      const tn = this.param(this.k + 1, p);
      if (this.t >= 1 || (this.t > 0.5 && this.dist(this.k + 1, tn, p) <= this.dist(this.k, this.t, p))) this.k++;
      else break;
    }
    let rem = (1 - this.t) * this.lens[this.k];
    for (let j = this.k + 1; j < this.lens.length; j++) rem += this.lens[j];
    return rem;
  }

  /** The point `ahead` m further along the path than the walker's (clamped to the end). */
  carrot(ahead: number, out: THREE.Vector3): THREE.Vector3 {
    let k = this.k, t = this.t, left = ahead;
    for (;;) {
      const room = (1 - t) * this.lens[k];
      if (left <= room || k >= this.lens.length - 1) {
        const tt = Math.min(1, t + left / this.lens[k]);
        return out.lerpVectors(this.pts[k], this.pts[k + 1], tt);
      }
      left -= room;
      k++;
      t = 0;
    }
  }

  /** Fastest speed now that still brakes (at `decel`) to `corner(angle)` at every corner ahead and to `end` at the
   *  end of the leg. */
  limit(vmax: number, decel: number, corner: (angle: number) => number, end: number): number {
    let v = vmax;
    let d = (1 - this.t) * this.lens[this.k];
    const horizon = (vmax * vmax) / (2 * decel) + 0.5;
    for (let j = this.k + 1; j < this.pts.length - 1 && d < horizon; j++) {
      const vc = corner(cornerAngle(this.pts[j - 1], this.pts[j], this.pts[j + 1]));
      // (the turn starts a little before the corner)
      v = Math.min(v, Math.sqrt(vc * vc + 2 * decel * Math.max(0, d - 0.25)));
      d += this.lens[j];
    }
    let rem = (1 - this.t) * this.lens[this.k];
    for (let j = this.k + 1; j < this.lens.length; j++) rem += this.lens[j];
    return Math.min(v, Math.sqrt(end * end + 2 * decel * rem));
  }

  private param(k: number, p: THREE.Vector3): number {
    const a = this.pts[k], b = this.pts[k + 1];
    const dx = b.x - a.x, dz = b.z - a.z;
    return THREE.MathUtils.clamp(((p.x - a.x) * dx + (p.z - a.z) * dz) / (this.lens[k] * this.lens[k]), 0, 1);
  }

  private dist(k: number, t: number, p: THREE.Vector3): number {
    const a = this.pts[k], b = this.pts[k + 1];
    return Math.hypot(a.x + (b.x - a.x) * t - p.x, a.z + (b.z - a.z) * t - p.z);
  }
}
