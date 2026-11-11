// Feet: where the clip puts the feet this frame, and what the controller does with that.
//  • stance — the planted part of the foot that carries the body. A walker turns about it (Person.turnWalking),
//    so turning while walking does not drag the planted foot round the hips.
//  • planter — turning on the spot and stopping: each foot stays put on the floor (two-bone leg IK over the clip),
//    pivoting a little on its ball as the body turns, until it lags its place under the body too far; then it
//    steps there in a short low arc. A body turning in place steps round instead of spinning on skating feet.
//    Once nothing lags any more the overlay fades out and the clip has the legs again.
import * as THREE from 'three';
import type { Character } from './character';
import { solveTwoBone, type Limb } from './typing';

/** A step: time (s), ankle lift (m, × height). The next foot may start once the step is this far along. */
const STEP_T = 0.26;
const STEP_LIFT = 0.05;
const STEP_OVERLAP = 0.8;
/** While turning a planted foot steps once it is this far from its place under the body (m) or turned this far
 *  from the body (rad); after the turn the smaller settle thresholds bring the feet home. */
const LAG_DIST = 0.08, LAG_YAW = 0.45;
const SETTLE_DIST = 0.03, SETTLE_YAW = 0.14;
/** Share of the body's turn a planted foot follows by pivoting on its ball. */
const PIVOT_SHARE = 0.35;

interface Foot {
  limb: Limb;
  ball: THREE.Bone;
  /** From the clip this frame, person-local: ankle (foot bone) and ball. */
  ankle: THREE.Vector3;
  toe: THREE.Vector3;
  /** Lift over the floor (m): the lower of heel and ball. */
  lift: number;
  /** Planted ankle (floor space: the person's parent; x/z used) and the body yaw its orientation belongs to. */
  anchor: THREE.Vector3;
  anchorYaw: number;
  step: { from: THREE.Vector3; fromYaw: number; t: number } | null;
}

const _p = new THREE.Vector3(), _h = new THREE.Vector3(), _t = new THREE.Vector3(), _pole = new THREE.Vector3();
const _q = new THREE.Quaternion(), _qc = new THREE.Quaternion(), _qp = new THREE.Quaternion(), _qs = new THREE.Quaternion();
const _ou = new THREE.Quaternion(), _ol = new THREE.Quaternion(), _up = new THREE.Vector3(0, 1, 0);
const ease = (x: number) => x * x * (3 - 2 * x);
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

export class Feet {
  private feet: [Foot, Foot];
  private ankleRest: number;
  private ballRest: number;
  private person: THREE.Object3D;
  private on = false;
  private weight = 0;
  /** Seconds since the body last turned (while holding). */
  private quiet = 0;
  private yaw = 0;
  private last = 1;

  constructor(ch: Character, person: THREE.Object3D, private height: number) {
    this.person = person;
    const foot = (s: 'l' | 'r'): Foot => ({
      limb: { upper: ch.bone(`thigh_${s}`), lower: ch.bone(`calf_${s}`), hand: ch.bone(`foot_${s}`) },
      ball: ch.bone(`ball_${s}`),
      ankle: new THREE.Vector3(), toe: new THREE.Vector3(), lift: 0, anchor: new THREE.Vector3(), anchorYaw: 0, step: null,
    });
    this.feet = [foot('l'), foot('r')];
    // bind pose (standing, feet flat): ankle and ball heights over the floor
    ch.model.updateMatrixWorld(true);
    const base = ch.model.getWorldPosition(_h).y;
    this.ankleRest = this.feet[0].limb.hand.getWorldPosition(_p).y - base;
    this.ballRest = this.feet[0].ball.getWorldPosition(_p).y - base;
  }

  /** Read the clip's feet (after the mixer update, with the person's transform current). */
  sample() {
    this.person.updateMatrixWorld(true);
    for (const f of this.feet) {
      this.person.worldToLocal(f.limb.hand.getWorldPosition(f.ankle));
      this.person.worldToLocal(f.ball.getWorldPosition(f.toe));
      f.lift = Math.min(f.ankle.y - this.ankleRest, f.toe.y - this.ballRest);
    }
  }

  /** The point the body stands on (person-local x/z): the ball of the planted foot (the heel while only the heel
   *  is down); while both feet are down, between them, weighted to the one with its ball down (a heel just
   *  striking carries little yet). */
  stance(out: THREE.Vector3): THREE.Vector3 {
    let wsum = 0;
    out.set(0, 0, 0);
    for (const f of this.feet) {
      const heel = f.ankle.y - this.ankleRest, ball = f.toe.y - this.ballRest;
      const heelDown = 1 - THREE.MathUtils.smoothstep(heel, 0.006, 0.03), ballDown = 1 - THREE.MathUtils.smoothstep(ball, 0.006, 0.03);
      const w = Math.max(ballDown, 0.25 * heelDown) + 1e-4;
      const b = THREE.MathUtils.smoothstep(heel - ball, -0.04, 0);
      out.x += w * THREE.MathUtils.lerp(f.ankle.x, f.toe.x, b);
      out.z += w * THREE.MathUtils.lerp(f.ankle.z, f.toe.z, b);
      wsum += w;
    }
    return out.divideScalar(wsum);
  }

  /** Where the feet are now (person-local ankles, x/z): held ones at their anchors, else as the clip has them. */
  placed(l: THREE.Vector2, r: THREE.Vector2) {
    const o = this.person.position, c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    this.feet.forEach((f, i) => {
      const out = i ? r : l;
      if (this.weight > 0.5 && !f.step) {
        const x = f.anchor.x - o.x, z = f.anchor.z - o.z;
        out.set(c * x - s * z, s * x + c * z);
      } else out.set(f.ankle.x, f.ankle.z);
    });
  }

  /** Holding the feet (or still fading out). */
  get active(): boolean {
    return this.on || this.weight > 0.003;
  }

  /** Not holding, or holding with nothing left to step. */
  get settled(): boolean {
    return !this.on || this.feet.every((f) => !f.step && this.lag(f, SETTLE_DIST, SETTLE_YAW) < 1);
  }

  /** Hold the feet where they are now (no-op while holding). `yaw`: the body's. */
  engage(yaw: number) {
    if (this.on) return;
    if (!this.active) {
      for (const f of this.feet) {
        this.toFloor(f.ankle, yaw, f.anchor);
        f.anchorYaw = yaw;
        f.step = null;
      }
      // the anchors are where the clip has the feet now, so holding them fully at once changes nothing this frame;
      // fading in instead lets the next clip's crossfade (a stop: frozen stride → idle) skate them meanwhile
      this.weight = 1;
    }
    this.on = true;
    this.quiet = 0;
    this.yaw = yaw;
  }

  /** Give the legs back to the clip (fades out). */
  release() {
    this.on = false;
  }

  /** Let go at once, anchors and steps dropped (the body was put somewhere else: a spawn or a room move). */
  reset() {
    this.on = false;
    this.weight = 0;
    for (const f of this.feet) f.step = null;
  }

  /** Per frame after `sample`: pivot and step what lags, IK the legs onto the anchors. */
  apply(dt: number, yaw: number) {
    this.weight += ((this.on ? 1 : 0) - this.weight) * Math.min(1, dt * (this.on ? 14 : 10));
    if (!this.active) {
      this.weight = 0;
      return;
    }
    const turn = wrap(yaw - this.yaw);
    this.yaw = yaw;
    const turning = Math.abs(turn) > 1e-4;
    for (const f of this.feet) {
      if (f.step) {
        f.step.t = Math.min(1, f.step.t + dt / STEP_T);
        if (f.step.t >= 1) {
          this.toFloor(f.ankle, yaw, f.anchor);
          f.anchorYaw = yaw;
          f.step = null;
        }
      } else if (!this.on) {
        // fading out: the anchors slide home with the fade (the IK target stays reachable)
        this.toFloor(f.ankle, yaw, _h);
        f.anchor.lerp(_h, Math.min(1, dt * 12));
        f.anchorYaw += wrap(yaw - f.anchorYaw) * Math.min(1, dt * 12);
      } else if (turning) {
        // the planted foot follows a share of the turn, pivoting on its ball
        const d = turn * PIVOT_SHARE;
        const ox = f.toe.x - f.ankle.x, oz = f.toe.z - f.ankle.z; // ankle → ball, body frame
        const a0 = f.anchorYaw, a1 = f.anchorYaw + d;
        f.anchor.x += (Math.cos(a0) - Math.cos(a1)) * ox + (Math.sin(a0) - Math.sin(a1)) * oz;
        f.anchor.z += (-Math.sin(a0) + Math.sin(a1)) * ox + (Math.cos(a0) - Math.cos(a1)) * oz;
        f.anchorYaw = a1;
      }
    }
    if (this.on) {
      const busy = this.feet.some((f) => f.step && f.step.t < STEP_OVERLAP);
      if (!busy && (turning || this.quiet > 0.1)) {
        // the foot that lags most steps (the other one when both lag about as much: alternate)
        const [dist, ang] = turning ? [LAG_DIST, LAG_YAW] : [SETTLE_DIST, SETTLE_YAW];
        let best = -1, bestLag = 1;
        this.feet.forEach((f, i) => {
          const lag = this.lag(f, dist, ang) * (i === this.last ? 0.75 : 1);
          if (lag > bestLag) { bestLag = lag; best = i; }
        });
        if (best >= 0) {
          const f = this.feet[best];
          f.step = { from: f.anchor.clone(), fromYaw: f.anchorYaw, t: 0 };
          this.last = best;
        }
      }
      this.quiet = turning ? 0 : this.quiet + dt;
      if (this.quiet > 0.25 && this.settled) this.on = false;
    }
    for (const f of this.feet) this.hold(f, yaw);
  }

  /** How far a planted foot lags its place under the body, in units of the thresholds (≥ 1: step). */
  private lag(f: Foot, dist: number, ang: number): number {
    if (f.step) return 0;
    this.toFloor(f.ankle, this.yaw, _h);
    return Math.max(Math.hypot(_h.x - f.anchor.x, _h.z - f.anchor.z) / dist, Math.abs(wrap(this.yaw - f.anchorYaw)) / ang);
  }

  /** Person-local point → floor space with the body at `yaw`. */
  private toFloor(p: THREE.Vector3, yaw: number, out: THREE.Vector3): THREE.Vector3 {
    const o = this.person.position, c = Math.cos(yaw), s = Math.sin(yaw);
    return out.set(o.x + c * p.x + s * p.z, o.y + p.y, o.z - s * p.x + c * p.z);
  }

  /** IK one leg onto its anchor (or along its step); the foot keeps its floor orientation. */
  private hold(f: Foot, yaw: number) {
    const person = this.person;
    let ax = f.anchor.x, az = f.anchor.z, ayaw = f.anchorYaw, lift = 0;
    if (f.step) {
      this.toFloor(f.ankle, yaw, _h);
      const e = ease(f.step.t);
      ax = THREE.MathUtils.lerp(f.step.from.x, _h.x, e);
      az = THREE.MathUtils.lerp(f.step.from.z, _h.z, e);
      ayaw = f.step.fromYaw + wrap(yaw - f.step.fromYaw) * e;
      lift = STEP_LIFT * this.height * Math.sin(Math.PI * f.step.t) ** 0.7;
    }
    const w = this.weight;
    const { upper, lower, hand } = f.limb;
    _ou.copy(upper.quaternion);
    _ol.copy(lower.quaternion);
    hand.getWorldQuaternion(_qc);
    // target: the anchored x/z at the clip's ankle height (+ the step's lift), person-local → world
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const lx = ax - person.position.x, lz = az - person.position.z;
    _t.set(c * lx - s * lz, f.ankle.y + lift, s * lx + c * lz);
    person.localToWorld(_t);
    // knee toward the toes of the held foot
    _pole.set(Math.sin(ayaw), 0.1, Math.cos(ayaw));
    if (person.parent) _pole.transformDirection(person.parent.matrixWorld);
    solveTwoBone(f.limb, _t, _pole);
    if (w < 0.999) {
      _qs.copy(upper.quaternion);
      upper.quaternion.copy(_ou).slerp(_qs, w);
      _qs.copy(lower.quaternion);
      lower.quaternion.copy(_ol).slerp(_qs, w);
      upper.updateMatrixWorld(true);
    }
    // the foot keeps the orientation it was planted with: the clip's, turned back by the body's turn since then
    _q.setFromAxisAngle(_up, wrap(ayaw - yaw) * w).multiply(_qc);
    lower.getWorldQuaternion(_qp);
    hand.quaternion.copy(_qp.invert().multiply(_q));
    hand.updateMatrixWorld(true);
  }
}
