// Procedural arm overlays on top of the clips, solved with a two-bone IK per arm:
//  • typing — both hands pulled onto the keyboard in front of a seated person, with alternating taps;
//  • mouse  — the right hand on a mouse beside the keyboard (the touchpad on a lap), drifting slowly;
//  • raise  — the right hand raised above the head with a slow wave ("needs you"; seated: straight up, beside
//             the name tag);
//  • hold   — the right hand on a tool handle at `holdTarget` (vacuum stick);
//  • carry  — the right forearm across the waist holding a folder upright against the chest (the left arm keeps
//             its swing), placed relative to the chest so it rides along with the walk.
// Each is blended by its own weight so it eases in and out with the pose underneath.
import * as THREE from 'three';
import type { Character } from './character';

/** Two-bone chain: upper / lower bone and the end bone placed by `solveTwoBone` (arm: hand, leg: foot). */
export interface Limb {
  upper: THREE.Bone;
  lower: THREE.Bone;
  hand: THREE.Bone;
}

interface Arm extends Limb {
  side: 1 | -1; // +1 = character's left (+X)
}

class Blend {
  weight = 0;
  target = 0;
  step(dt: number, rate: number) {
    this.weight += (this.target - this.weight) * Math.min(1, dt * rate);
    return this.weight;
  }
}

const _s = new THREE.Vector3(), _e = new THREE.Vector3(), _h = new THREE.Vector3(), _t = new THREE.Vector3();
const _pole = new THREE.Vector3(), _dir = new THREE.Vector3(), _perp = new THREE.Vector3(), _e2 = new THREE.Vector3();
const _q = new THREE.Quaternion(), _qw = new THREE.Quaternion(), _qp = new THREE.Quaternion(), _a = new THREE.Vector3(), _b = new THREE.Vector3();
const _orig = new THREE.Quaternion(), _orig2 = new THREE.Quaternion(), _orig3 = new THREE.Quaternion(), _solved = new THREE.Quaternion();

export class ArmOverlay {
  readonly typing = new Blend();
  readonly mouse = new Blend();
  readonly raise = new Blend();
  readonly hold = new Blend();
  readonly carry = new Blend();
  /** `carry`: the hand (and the folder on it) this much further out from the chest (m), for a bulky torso. */
  carryOut = 0;
  /** Right-hand target for `hold`, person space. */
  readonly holdTarget = new THREE.Vector3(-0.16, 0.92, 0.38);
  /** Keyboard (typing, mouse) in person space: x = height of the key tops' base, y = distance in front. */
  readonly keyboard = new THREE.Vector2(0.75, 0.36);
  /** The keyboard is a laptop on the lap (the mouse is its touchpad). */
  lap = false;
  /** Seated raise: the arm goes straight up, out to the side of the name tag. */
  seated = false;
  private arms: [Arm, Arm];
  private chest: THREE.Bone;
  private t = Math.random() * 10;

  constructor(ch: Character, private seed: number, private height: number) {
    this.chest = ch.bone('spine_03');
    this.arms = [
      { upper: ch.bone('upperarm_l'), lower: ch.bone('lowerarm_l'), hand: ch.bone('hand_l'), side: 1 },
      { upper: ch.bone('upperarm_r'), lower: ch.bone('lowerarm_r'), hand: ch.bone('hand_r'), side: -1 },
    ];
  }

  /** `person` is the person group (pelvis ground point, faces +Z locally). Call after the mixer update.
   *  `keyboardY` overrides `keyboard.x` (callers that only know the desk height). */
  apply(dt: number, person: THREE.Object3D, keyboardY = this.keyboard.x) {
    const wt = this.typing.step(dt, 4);
    const wm = this.mouse.step(dt, 3);
    const wr = this.raise.step(dt, 3.5);
    const wh = this.hold.step(dt, 6);
    const wc = this.carry.step(dt, 7);
    if (wt < 0.01 && wm < 0.01 && wr < 0.01 && wh < 0.01 && wc < 0.01) return;
    const kbZ = this.keyboard.y;
    this.t += dt;
    person.updateMatrixWorld(true);
    for (const arm of this.arms) {
      if (wt >= 0.01) {
        // keyboard point in person space: forward of the hips, at desk height, hands a bit apart
        const phase = this.t * (11 + (this.seed % 5)) + (arm.side > 0 ? 0 : 1.7);
        const tap = Math.max(0, Math.sin(phase)) * 0.012 + Math.max(0, Math.sin(phase * 1.63 + 0.5)) * 0.006;
        const drift = Math.sin(this.t * 0.7 + arm.side) * 0.02;
        _t.set(arm.side * (this.lap ? 0.11 : 0.135) + drift * 0.5, keyboardY + 0.035 + tap, kbZ + drift);
        _pole.set(arm.side * 0.9, -1, -0.5);
        this.reach(arm, person, wt, Math.sin(phase * 0.5) * 0.08);
      }
      if (wm >= 0.01 && arm.side < 0) {
        // small slow moves with the odd quick flick, a click now and then (hand dips)
        const dx = Math.sin(this.t * 0.9 + this.seed) * 0.025 + Math.sin(this.t * 2.3) * 0.008;
        const dz = Math.sin(this.t * 0.7 + 1.3) * 0.02;
        const click = Math.max(0, Math.sin(this.t * 3.1 + this.seed * 0.7)) ** 12 * 0.008;
        if (this.lap) _t.set(-0.02 + dx * 0.4, keyboardY + 0.03 - click, kbZ + 0.06 + dz * 0.4);
        else _t.set(-0.27 + dx, keyboardY + 0.03 - click, 0.32 + dz);
        _pole.set(-0.9, -1, -0.5);
        this.reach(arm, person, wm, 0);
      }
      if (wr >= 0.01 && arm.side < 0) {
        const wave = Math.sin(this.t * 4.2);
        if (this.seated) _t.set(-0.38 + wave * 0.04, 1.85 * this.height, 0.1);
        else _t.set(-0.3 + wave * 0.05, 2.02 * this.height, 0.12);
        _pole.set(-1, -0.25, -0.35);
        this.reach(arm, person, wr, wave * 0.25);
      }
      if (wh >= 0.01 && arm.side < 0) {
        _t.copy(this.holdTarget);
        _pole.set(-1, -0.7, -0.5);
        this.reach(arm, person, wh, 0);
      }
      if (wc >= 0.01 && arm.side < 0) {
        // forearm across the waist, hand just left of the middle: the folder stands on it against the chest
        person.worldToLocal(this.chest.getWorldPosition(_t));
        _t.set(_t.x + 0.02 * this.height, _t.y - 0.25 * this.height, _t.z + 0.17 * this.height + this.carryOut);
        _pole.set(-1, -0.45, -0.25);
        this.reach(arm, person, wc, 0);
      }
    }
  }

  /** IK `arm` toward _t (person space) with pole _pole (person space), blended by `w`. */
  private reach(arm: Arm, person: THREE.Object3D, w: number, flick: number) {
    person.localToWorld(_t);
    _pole.transformDirection(person.matrixWorld);
    _orig.copy(arm.upper.quaternion);
    _orig2.copy(arm.lower.quaternion);
    _orig3.copy(arm.hand.quaternion);
    solveTwoBone(arm, _t, _pole);
    _solved.copy(arm.upper.quaternion);
    arm.upper.quaternion.copy(_orig).slerp(_solved, w);
    _solved.copy(arm.lower.quaternion);
    arm.lower.quaternion.copy(_orig2).slerp(_solved, w);
    _q.setFromAxisAngle(_a.set(1, 0, 0), flick * w);
    arm.hand.quaternion.copy(_orig3).multiply(_q);
    arm.upper.updateMatrixWorld(true);
  }
}

/** Re-aim `arm.upper` / `arm.lower` (world-space minimal rotations) so `arm.hand` reaches `target` (world), the
 *  middle joint bending toward `pole` (world direction). */
export function solveTwoBone(arm: Limb, target: THREE.Vector3, pole: THREE.Vector3) {
  arm.upper.updateMatrixWorld(true);
  arm.upper.getWorldPosition(_s);
  arm.lower.getWorldPosition(_e);
  arm.hand.getWorldPosition(_h);
  const la = _s.distanceTo(_e), lb = _e.distanceTo(_h);
  _dir.subVectors(target, _s);
  const d = THREE.MathUtils.clamp(_dir.length(), Math.abs(la - lb) + 1e-3, (la + lb) * 0.999);
  _dir.normalize();
  const cosA = (la * la + d * d - lb * lb) / (2 * la * d);
  const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  _perp.copy(pole).addScaledVector(_dir, -pole.dot(_dir)).normalize();
  _e2.copy(_s).addScaledVector(_dir, la * cosA).addScaledVector(_perp, la * sinA);
  rotateBoneToward(arm.upper, _a.subVectors(_e, _s).normalize(), _b.subVectors(_e2, _s).normalize());
  arm.upper.updateMatrixWorld(true);
  arm.lower.getWorldPosition(_e);
  arm.hand.getWorldPosition(_h);
  rotateBoneToward(arm.lower, _a.subVectors(_h, _e).normalize(), _b.subVectors(target, _e).normalize());
}

/** Rotate `bone` (in world space) by the minimal rotation taking direction `from` to `to`. */
function rotateBoneToward(bone: THREE.Bone, from: THREE.Vector3, to: THREE.Vector3) {
  _q.setFromUnitVectors(from, to);
  bone.getWorldQuaternion(_qw);
  _qw.premultiply(_q);
  bone.parent!.getWorldQuaternion(_qp);
  bone.quaternion.copy(_qp.invert().multiply(_qw));
}
