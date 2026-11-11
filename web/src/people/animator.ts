// Clip playback with 0.25 s crossfades and pelvis compensation.
//
// UAL clips move the pelvis away from the armature root (seated clips sit ~0.33 m behind it, rail
// leans ~0.47 m). The controller reasons about where the BODY is, so the model is offset by the
// weighted pelvis offset of the active actions: the person's logical position is the pelvis ground
// point, whatever clip plays. When a one-shot finishes (e.g. Sitting_Enter moved the hips back), its
// offset switches from start to end and the difference is reported as a `shift` for the controller to
// add to the logical position, so nothing visibly jumps.
import * as THREE from 'three';
import type { ClipInfo } from './library';

export interface PlayOpts {
  /** Play once and hold the last frame (default: loop unless the clip name lacks `_Loop`). */
  once?: boolean;
  fade?: number;
  timeScale?: number;
  /** Restart even when already playing this clip. */
  restart?: boolean;
  /** Start this far into the clip (s). */
  at?: number;
}

interface Slot {
  action: THREE.AnimationAction;
  info: ClipInfo;
  once: boolean;
  comp: THREE.Vector2;
  finished: boolean;
}

export class Animator {
  readonly mixer: THREE.AnimationMixer;
  private slots = new Map<string, Slot>();
  private cur: Slot | null = null;
  private pendingShift = new THREE.Vector2();
  private tmp = new THREE.Vector2();

  constructor(
    private model: THREE.Object3D,
    private clips: Map<string, ClipInfo>,
    private scale: number,
  ) {
    this.mixer = new THREE.AnimationMixer(model);
  }

  get current(): string | null {
    return this.cur?.info.clip.name ?? null;
  }

  info(name: string): ClipInfo | undefined {
    return this.clips.get(name);
  }

  play(name: string, opts: PlayOpts = {}): void {
    const info = this.clips.get(name);
    if (!info) {
      console.warn(`[people] missing clip ${name}`);
      return;
    }
    const once = opts.once ?? !name.endsWith('_Loop');
    const fade = opts.fade ?? 0.25;
    if (this.cur && this.cur.info === info && !opts.restart && !this.cur.finished) {
      if (opts.timeScale !== undefined) this.cur.action.timeScale = opts.timeScale;
      return;
    }
    let slot = this.slots.get(name);
    if (!slot) {
      const action = this.mixer.clipAction(info.clip);
      slot = { action, info, once, comp: new THREE.Vector2(), finished: false };
      this.slots.set(name, slot);
    }
    const a = slot.action;
    slot.once = once;
    slot.finished = false;
    slot.comp.copy(once ? info.offStart : info.offMean);
    a.reset();
    if (opts.at !== undefined) a.time = opts.at;
    a.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
    a.clampWhenFinished = once;
    a.timeScale = opts.timeScale ?? 1;
    if (this.cur && fade > 0) {
      a.setEffectiveWeight(1).fadeIn(fade).play();
      // everything else still weighted fades out: running clips, a held (finished) one-shot and a stride frozen at
      // timeScale 0 (neither of those counts as "running")
      for (const s of this.slots.values()) if (s !== slot && s.action.isScheduled() && s.action.enabled) s.action.fadeOut(fade);
    } else {
      for (const s of this.slots.values()) if (s !== slot) s.action.stop();
      a.setEffectiveWeight(1).play();
    }
    this.cur = slot;
  }

  setTimeScale(ts: number) {
    if (this.cur) this.cur.action.timeScale = ts;
  }

  /** Current one-shot finished (holding its last frame). Loops never finish. */
  get finished(): boolean {
    return !!this.cur?.finished;
  }

  /** 0..1 progress through the current clip. */
  get progress(): number {
    if (!this.cur) return 0;
    const d = this.cur.info.clip.duration;
    return d > 0 ? THREE.MathUtils.clamp(this.cur.action.time / d, 0, 1) : 1;
  }

  update(dt: number) {
    this.mixer.update(dt);
    const s = this.cur;
    if (s && s.once && !s.finished) {
      const a = s.action;
      if (a.time >= s.info.clip.duration - 1e-3 || (!a.isRunning() && a.enabled && a.time > 0)) {
        s.finished = true;
        // the hips now rest at the clip's end offset: move the logical position there instead
        this.pendingShift.add(this.tmp.copy(s.info.offEnd).sub(s.comp).multiplyScalar(this.scale));
        s.comp.copy(s.info.offEnd);
      }
    }
    // model offset = −(weighted pelvis offset), so the pelvis sits at the person's origin
    let wsum = 0;
    const off = this.tmp.set(0, 0);
    for (const s of this.slots.values()) {
      // (a stopped action keeps `enabled` and its last weight: only actions still in the mixer count)
      const w = s.action.enabled && s.action.isScheduled() ? s.action.getEffectiveWeight() : 0;
      if (w <= 1e-4) continue;
      off.addScaledVector(s.comp, w);
      wsum += w;
    }
    if (wsum > 0) off.divideScalar(wsum);
    this.model.position.x = -off.x * this.scale;
    this.model.position.z = -off.y * this.scale;
  }

  /** Logical-position delta (model-local x/z, meters) accumulated from finished one-shots. */
  takeShift(out: THREE.Vector2): THREE.Vector2 {
    out.copy(this.pendingShift);
    this.pendingShift.set(0, 0);
    return out;
  }

  dispose() {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.model);
  }
}
