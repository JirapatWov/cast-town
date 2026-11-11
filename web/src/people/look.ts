// Procedural head look over the clips: the neck (40%) and head (60%) turn toward a point (the screen, the
// camera over the shoulder, the room), clamped to what a seated person can do comfortably, plus a head shake.
// Additive on top of the clip pose and eased with frame-rate-independent exponentials.
import * as THREE from 'three';
import type { Character } from './character';

const MAX_YAW = THREE.MathUtils.degToRad(75);
const MAX_PITCH = THREE.MathUtils.degToRad(20);
const RATE = 3;
const _p = new THREE.Vector3(), _h = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0), _right = new THREE.Vector3();
const _q = new THREE.Quaternion(), _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion(), _qp = new THREE.Quaternion();
const _wq = new THREE.Quaternion();

export class HeadLook {
  /** Point to look at (person-group local space), or null to follow the clip. */
  target: THREE.Vector3 | null = null;
  /** Head shake on (error). */
  shake = false;
  private yaw = 0;
  private pitch = 0;
  private shakeW = 0;
  private t = 0;
  private neck: THREE.Object3D | null;
  private head: THREE.Object3D | null;

  constructor(ch: Character) {
    const bone = (n: string) => {
      try {
        return ch.bone(n);
      } catch {
        return null;
      }
    };
    this.neck = bone('neck_01');
    this.head = bone('Head');
  }

  /** `person` is the person group (faces +Z locally). Call after the mixer and the arm overlays. */
  apply(dt: number, person: THREE.Object3D) {
    if (!this.head) return;
    let wantYaw = 0, wantPitch = 0;
    if (this.target) {
      this.head.getWorldPosition(_h); // (brings the chain up from the person group up to date)
      person.worldToLocal(_h);
      _p.subVectors(this.target, _h);
      wantYaw = Math.atan2(_p.x, _p.z);
      // straight behind: keep turning over the same shoulder instead of flipping sides
      if (Math.abs(wantYaw) > MAX_YAW && this.yaw !== 0 && Math.sign(wantYaw) !== Math.sign(this.yaw) && Math.abs(wantYaw) > 2.4) wantYaw = -wantYaw;
      wantYaw = THREE.MathUtils.clamp(wantYaw, -MAX_YAW, MAX_YAW);
      wantPitch = THREE.MathUtils.clamp(Math.atan2(_p.y, Math.hypot(_p.x, _p.z)), -MAX_PITCH, MAX_PITCH);
    }
    const k = 1 - Math.exp(-RATE * dt);
    this.yaw += (wantYaw - this.yaw) * k;
    this.pitch += (wantPitch - this.pitch) * k;
    this.shakeW += ((this.shake ? 1 : 0) - this.shakeW) * (1 - Math.exp(-4 * dt));
    this.t += dt;
    const yaw = this.yaw + this.shakeW * 0.32 * Math.sin(this.t * 8.5) * (0.6 + 0.4 * Math.sin(this.t * 1.7));
    const pitch = this.pitch - this.shakeW * 0.12; // a lowered head while shaking it
    if (Math.abs(yaw) < 1e-4 && Math.abs(pitch) < 1e-4) return;
    person.getWorldQuaternion(_wq);
    _up.set(0, 1, 0);
    _right.set(1, 0, 0).applyQuaternion(_wq);
    // pitch > 0 looks up: about the person's +X (their left) a positive angle tips the face down
    if (this.neck) this.turn(this.neck, yaw * 0.4, pitch * 0.4);
    this.turn(this.head, yaw * (this.neck ? 0.6 : 1), pitch * (this.neck ? 0.6 : 1));
  }

  private turn(bone: THREE.Object3D, yaw: number, pitch: number) {
    _qa.setFromAxisAngle(_up, yaw);
    _qb.setFromAxisAngle(_right, -pitch);
    _q.multiplyQuaternions(_qa, _qb);
    bone.getWorldQuaternion(_wq).premultiply(_q);
    bone.parent!.getWorldQuaternion(_qp);
    bone.quaternion.copy(_qp.invert().multiply(_wq));
    bone.updateMatrixWorld(true);
  }
}
