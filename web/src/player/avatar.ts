// The homeowner's body and a small step machine that drives it, kept apart from the residents' Person controller:
// the player only ever walks somewhere, follows someone, sits at a computer, climbs the stairs or stands aside.
//   plan = (stand up) → walk the nav path → turn → idle | seated
// Walking and loops can be replaced at any time; sitting down / standing up / the stairs always finish first
// (a new plan waits for them). With reduced motion every plan resolves at once (no walking, no sitting animation).
import * as THREE from 'three';
import type { Slot } from '../people/types';
import type { PlayerBody } from './character-api';
import { PlayerMarker } from './marker';

/** Where the avatar stands: one house floor (nav grid) or the city lot by a building. Coordinates are local to
 *  `root` (y = 0 on the walking surface). */
export interface Ground {
  readonly root: THREE.Object3D;
  /** Walkable path ending exactly at `to`, [] when unreachable. */
  findPath(from: THREE.Vector3, to: THREE.Vector3): THREE.Vector3[];
  snap(p: THREE.Vector3): THREE.Vector3;
  isFree(x: number, z: number): boolean;
  heightAt(x: number, z: number): number;
  cameraPosition(out: THREE.Vector3): THREE.Vector3;
  /** Is this station still built (its room may be refurnished under us)? */
  hasSlot?(slot: Slot): boolean;
}

/** A resident near the avatar (ground-local), for stepping aside. */
export interface Neighbour {
  id: string;
  pos: THREE.Vector3;
  /** Estimated velocity (m/s). */
  vel: THREE.Vector3;
  /** Station the resident is heading for / using, if any. */
  target: THREE.Vector3 | null;
}

export interface Step {
  name: string;
  /** Runs to completion even when a new plan arrives (it is queued behind). */
  locked?: boolean;
  start?(): void;
  /** True when finished. */
  update(dt: number): boolean;
}

interface Seat {
  slot: Slot;
  sitting: boolean;
  chair: number;
  chairTarget: number;
}

export const WALK_SPEED = 1.35;
const PELVIS_ABOVE_SEAT = 0.1;
const SCREEN_TINT = '#8fd6b0'; // a terminal's soft green, not a vendor colour

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _a = new THREE.Vector3(), _h = new THREE.Vector3();
const _v2 = new THREE.Vector2(), _cam = new THREE.Vector3();
const facingOf = (yaw: number, out = new THREE.Vector3()) => out.set(Math.sin(yaw), 0, Math.cos(yaw));
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const smooth = (e0: number, e1: number, x: number) => THREE.MathUtils.smoothstep(x, e0, e1);
const yawTo = (from: THREE.Vector3, to: THREE.Vector3) => Math.atan2(to.x - from.x, to.z - from.z);
const flat = (a: THREE.Vector3, b: THREE.Vector3) => Math.hypot(a.x - b.x, a.z - b.z);

export interface IdleOpts {
  /** Keep turning toward this point (ground-local) while it is close. */
  face?: () => THREE.Vector3 | null;
  /** Talk with the hands for this long first (s). */
  talk?: number;
}

export class Avatar {
  readonly group = new THREE.Group();
  readonly marker = new PlayerMarker();
  ground: Ground | null = null;
  /** Called when a resident claims the seat we are on (after we stood up). */
  onSeatTaken: ((slot: Slot) => void) | null = null;
  /** Keyboard walking direction (ground-local x/z, length ≤ 1); zero = no key held. */
  readonly drive = new THREE.Vector2();
  /** Reduced motion: plans resolve instantly. */
  instantMode = false;

  private yaw = 0;
  private speed = 0;
  private yOff = 0;
  private clock = 0;
  private seat: Seat | null = null;
  private chairsReturning: Seat[] = [];
  private steps: Step[] = [];
  private step: Step | null = null;
  private queued: (() => Step[]) | null = null;
  private instant = false;
  private hfn: ((x: number, z: number) => number) | null = null;
  private talkUntil = 0;
  private typing = false;
  private screenSlot: Slot | null = null;
  private chipY = 2;
  private neighbours: Neighbour[] = [];
  private asideCheck = 0;
  private walking = false;

  constructor(public body: PlayerBody) {
    this.group.name = 'player';
    this.group.add(body.ch.model, this.marker.decal, this.marker.chip);
    body.anim.play('Idle_Loop', { fade: 0 });
  }

  get position(): THREE.Vector3 {
    return this.group.position;
  }
  get heading(): number {
    return this.yaw;
  }
  get seated(): boolean {
    return !!this.seat?.sitting;
  }
  get seatSlot(): Slot | null {
    return this.seat?.slot ?? null;
  }
  /** Busy with something that must finish (sitting down, the stairs). */
  get locked(): boolean {
    return !!this.step?.locked;
  }
  get stepName(): string {
    return this.step?.name ?? 'none';
  }

  /** Swap the body (a new look) keeping position, heading and plan. */
  setBody(body: PlayerBody) {
    const old = this.body;
    this.group.remove(old.ch.model);
    this.group.add(body.ch.model);
    this.body = body;
    // the seated pose continues on the new body without replaying the sit-down
    const clip = this.seat?.sitting ? (this.typing ? 'Sitting_Talking_Loop' : 'Sitting_Idle_Loop') : this.walking ? 'Walk_Loop' : 'Idle_Loop';
    body.anim.play(clip, { fade: 0 });
    if (this.seat?.sitting) this.yOff = this.seatOffset(this.seat.slot);
    if (body.arms && this.typing) {
      body.arms.typing.target = 1;
      body.arms.typing.weight = 1;
    }
    old.dispose();
  }

  /** Put the avatar down on a ground at once (no walking), standing idle. */
  place(ground: Ground, pos: THREE.Vector3, yaw = this.yaw) {
    this.dropSeat();
    if (this.ground !== ground || this.group.parent !== ground.root) ground.root.add(this.group);
    this.ground = ground;
    this.group.position.copy(pos);
    this.setYaw(yaw);
    this.hfn = null;
    this.speed = 0;
    this.steps = [];
    this.step = null;
    this.queued = null;
    this.instant = false;
    this.run([this.idle()]);
  }

  detach() {
    this.dropSeat();
    this.steps = [];
    this.step = null;
    this.queued = null;
    this.group.removeFromParent();
    this.ground = null;
  }

  setVisible(on: boolean) {
    this.group.visible = on;
    this.marker.setVisible(on);
  }

  // ── plans ─────────────────────────────────────────────────────────────────────────────────────

  /** Walk to a point (ground-local) and stand there, optionally facing something. */
  walkTo(target: THREE.Vector3, opts: { face?: THREE.Vector3 | null; yaw?: number; talk?: number } = {}) {
    const face = opts.face ?? null;
    this.plan(() => {
      const steps: Step[] = [...this.unseat(), this.walk(target)];
      if (face) steps.push(this.turnTo(() => yawTo(this.group.position, face)));
      else if (opts.yaw !== undefined) steps.push(this.turnTo(() => opts.yaw!));
      steps.push(this.idle({ face: face ? () => face : undefined, talk: opts.talk }));
      return steps;
    });
    this.marker.flash(2.5);
  }

  /** Walk up to someone who may be moving (`where` is re-read while walking) and face them. */
  approach(where: () => THREE.Vector3 | null, opts: { stopAt?: number; talk?: number } = {}) {
    const stopAt = opts.stopAt ?? 1.05;
    const goal = () => {
      const p = where();
      if (!p || !this.ground) return null;
      _v.subVectors(this.group.position, p).setY(0);
      if (_v.lengthSq() < 1e-4) _v.set(0, 0, 1);
      _v.normalize();
      return this.ground.snap(p.clone().addScaledVector(_v, stopAt * 0.9));
    };
    this.plan(() => {
      const steps: Step[] = [...this.unseat()];
      const p0 = where();
      if (p0 && flat(p0, this.group.position) > stopAt + 0.15) steps.push(this.walk(goal, { stopAt: 0.12, repath: 0.6, until: () => { const p = where(); return !!p && flat(p, this.group.position) <= stopAt; } }));
      steps.push(this.turnTo(() => { const p = where(); return p ? yawTo(this.group.position, p) : this.yaw; }));
      steps.push(this.idle({ face: where, talk: opts.talk }));
      return steps;
    });
    this.marker.flash(2.5);
  }

  /** Sit at a desk slot (never claimed: a resident who claims it makes us stand up — see onSeatTaken). */
  sitAt(slot: Slot, opts: { typing: boolean }) {
    if (!slot.sit) {
      this.walkTo(slot.pos, { yaw: slot.yaw });
      return;
    }
    if (this.seat?.slot === slot && this.seat.sitting) {
      this.setTyping(opts.typing);
      return;
    }
    this.plan(() => [...this.unseat(), ...this.sitPlan(slot, opts.typing)]);
  }

  /** Stand up where we are (the terminal closed). */
  standUp() {
    if (!this.seat) return;
    this.plan(() => [...this.unseat(), this.idle()]);
  }

  setTyping(on: boolean) {
    this.typing = on;
    const arms = this.body.arms;
    if (arms && this.seat?.sitting) arms.typing.target = on ? 1 : 0;
    if (this.seat?.sitting) {
      this.body.anim.play(on ? 'Sitting_Talking_Loop' : 'Sitting_Idle_Loop', { fade: 0.35 });
      this.setScreen(on ? this.seat.slot : null);
    }
  }

  /** Walk a fixed polyline ignoring the nav grid (stairs), with an explicit walking-surface height. Locked. */
  traverse(points: THREE.Vector3[], heights: (x: number, z: number) => number, then?: () => Step[], hooks: { start?(): void; end?(): void } = {}) {
    this.plan(() => [...this.unseat(), this.polyline(points, heights, hooks), ...(then ? then() : [this.idle()])]);
  }

  /** Talk with the hands for a moment (we just said something to the person in front of us). */
  talk(seconds = 3) {
    this.talkUntil = Math.max(this.talkUntil, this.clock + seconds);
  }

  /** Steps for a plan that ends standing idle at `target` (used by callers that chain floors). */
  walkSteps(target: THREE.Vector3, face?: THREE.Vector3 | null): Step[] {
    const steps: Step[] = [this.walk(target)];
    if (face) steps.push(this.turnTo(() => yawTo(this.group.position, face)));
    steps.push(this.idle({ face: face ? () => face : undefined }));
    return steps;
  }

  sitSteps(slot: Slot, typing: boolean): Step[] {
    return this.sitPlan(slot, typing);
  }

  /** Start a plan now, or — while a locked step runs (sitting down, the stairs) — as soon as the locked run ends.
   *  The steps are built when the plan starts, so "stand up first" sees the seat as it is then. */
  private plan(build: () => Step[]) {
    if (this.step?.locked) {
      this.queued = build;
      return;
    }
    this.run(build());
  }

  private run(steps: Step[]) {
    this.instant = this.instantMode;
    this.steps = steps;
    this.step = null;
    this.queued = null;
    this.next();
  }

  private next() {
    for (let guard = 0; guard < 64; guard++) {
      if (this.queued && !this.steps[0]?.locked) {
        const build = this.queued;
        this.queued = null;
        this.instant = this.instantMode;
        this.steps = build();
      }
      this.step = this.steps.shift() ?? null;
      if (!this.step) return;
      this.step.start?.();
      // instant mode runs through every step that can finish at once (it ends at the first waiting loop)
      if (!this.instant || !this.step.update(0)) return;
    }
  }

  // ── per frame ─────────────────────────────────────────────────────────────────────────────────

  update(dt: number, neighbours: Neighbour[]) {
    this.clock += dt;
    this.neighbours = neighbours;
    const g = this.ground;
    if (!g) return;

    if (this.seat && g.hasSlot && !g.hasSlot(this.seat.slot)) {
      // the room was refurnished under us: get up on the spot
      this.dropSeat();
      this.group.position.copy(g.snap(this.group.position));
      this.run([this.idle()]);
    }

    this.updateDrive();
    if (this.step && this.step.update(dt)) this.next();
    if (!this.step) this.run([this.idle()]);
    this.checkAside(dt);

    const anim = this.body.anim;
    anim.update(dt);
    anim.takeShift(_v2);
    if (_v2.lengthSq() > 0) {
      _v.set(_v2.x, 0, _v2.y).applyAxisAngle(THREE.Object3D.DEFAULT_UP, this.yaw);
      this.group.position.add(_v);
    }
    const p = this.group.position;
    p.y = this.hfn ? this.hfn(p.x, p.z) : g.heightAt(p.x, p.z);
    this.body.ch.model.position.y = this.yOff;
    this.group.rotation.y = this.yaw;
    this.updateChairs(dt);
    this.body.arms?.apply(dt, this.group, 0.75);

    // the chip follows the head, smoothed; the decal stays on the floor (hidden on the stairs)
    if (this.body.head(_h)) {
      this.group.worldToLocal(_h);
      this.chipY += (_h.y + 0.34 - this.chipY) * Math.min(1, dt * 5);
    }
    this.marker.chip.position.set(0, this.chipY, 0);
    this.marker.decal.visible = this.group.visible && !this.hfn;
    this.marker.setSeated(!!this.seat?.sitting);
    this.marker.tick(dt, this.walking);
  }

  dispose() {
    this.dropSeat();
    this.marker.dispose();
    this.body.dispose();
    this.group.removeFromParent();
  }

  // ── keyboard ──────────────────────────────────────────────────────────────────────────────────

  private updateDrive() {
    if (this.drive.lengthSq() < 1e-4) return;
    if (this.step?.name === 'drive') return;
    if (this.step?.locked) return; // finish sitting down / the stairs first
    this.instant = false;
    this.run([...this.unseat(), this.driveStep()]);
  }

  private driveStep(): Step {
    let still = 0;
    return {
      name: 'drive',
      start: () => {
        this.walking = true;
        this.marker.flash(1.5);
      },
      update: (dt) => {
        const g = this.ground!;
        const d = this.drive;
        if (d.lengthSq() < 1e-4) {
          this.speed = Math.max(0, this.speed - dt * 6);
          still += dt;
          this.walkAnim(this.speed);
          if (still > 0.12 && this.speed < 0.05) {
            this.walking = false;
            this.steps = [this.idle()];
            return true;
          }
          if (this.speed > 0) this.slide(g, _w.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)), this.speed * dt);
          return false;
        }
        still = 0;
        const want = Math.atan2(d.x, d.y);
        const diff = Math.abs(wrap(want - this.yaw));
        this.turnToward(want, dt, 10);
        const target = WALK_SPEED * Math.min(1, d.length()) * THREE.MathUtils.clamp(Math.cos(diff), 0.25, 1);
        this.speed += (target - this.speed) * Math.min(1, dt * 8);
        _w.set(d.x, 0, d.y).normalize();
        this.slide(g, _w, this.speed * dt);
        this.walkAnim(this.speed);
        return false;
      },
    };
  }

  /** Move along `dir`, sliding along walls/furniture (nav cells) instead of stopping dead. */
  private slide(g: Ground, dir: THREE.Vector3, dist: number) {
    const p = this.group.position;
    const nx = p.x + dir.x * dist, nz = p.z + dir.z * dist;
    if (g.isFree(nx, nz)) p.set(nx, p.y, nz);
    else if (Math.abs(dir.x) > 0.05 && g.isFree(nx, p.z)) p.x = nx;
    else if (Math.abs(dir.z) > 0.05 && g.isFree(p.x, nz)) p.z = nz;
    else this.speed *= 0.5;
  }

  // ── stepping aside ────────────────────────────────────────────────────────────────────────────

  /** Idle and a resident walks at us, or their station is where we stand: move ~1.1 m out of the way. */
  private checkAside(dt: number) {
    this.asideCheck -= dt;
    if (this.asideCheck > 0) return;
    this.asideCheck = 0.25;
    if (this.step?.name !== 'idle' || !this.ground) return;
    const me = this.group.position;
    for (const n of this.neighbours) {
      const d = flat(n.pos, me);
      const coming = n.vel.lengthSq() > 0.03 && d < 1.0 && _v.subVectors(me, n.pos).setY(0).dot(n.vel) > 0.25 * d * n.vel.length();
      const station = n.target && flat(n.target, me) < 0.7 && d < 2.6;
      const crowd = d < 0.45;
      if (coming || station || crowd) {
        const spot = this.asideSpot(n);
        if (spot) {
          this.plan(() => [this.walk(spot, { speed: 1.1 }), this.idle({ face: () => n.pos })]);
          return;
        }
      }
    }
  }

  private asideSpot(n: Neighbour): THREE.Vector3 | null {
    const g = this.ground!;
    const me = this.group.position;
    const away = _a.subVectors(me, n.pos).setY(0);
    if (away.lengthSq() < 1e-4) away.set(1, 0, 0);
    away.normalize();
    const side = new THREE.Vector3(-n.vel.z, 0, n.vel.x);
    if (side.lengthSq() < 1e-4) side.copy(away);
    side.normalize();
    if (side.dot(away) < 0) side.negate();
    let best: THREE.Vector3 | null = null, bestScore = -Infinity;
    for (let k = 0; k < 12; k++) {
      const ang = (k / 12) * Math.PI * 2;
      const dir = new THREE.Vector3(Math.cos(ang), 0, Math.sin(ang));
      for (const r of [1.1, 1.5]) {
        const p = new THREE.Vector3(me.x + dir.x * r, 0, me.z + dir.z * r);
        if (!g.isFree(p.x, p.z)) continue;
        let score = dir.dot(side) * 1.5 + dir.dot(away) - r * 0.3;
        for (const o of this.neighbours) {
          const d = flat(o.pos, p);
          if (d < 0.9) score -= (0.9 - d) * 6;
          if (o.target && flat(o.target, p) < 0.8) score -= 4;
          if (o.vel.lengthSq() > 0.03) {
            // standing in their way again is no good: distance from their line of travel
            _v.copy(o.vel).setY(0).normalize();
            _w.subVectors(p, o.pos).setY(0);
            const along = _w.dot(_v);
            if (along > 0) score -= Math.max(0, 0.8 - Math.abs(_w.addScaledVector(_v, -along).length())) * 3;
          }
        }
        if (score > bestScore) {
          bestScore = score;
          best = p;
        }
      }
    }
    return best;
  }

  // ── steps ─────────────────────────────────────────────────────────────────────────────────────

  private idle(opts: IdleOpts = {}): Step {
    let nextFidget = 0;
    let fidgetUntil = 0;
    return {
      name: 'idle',
      start: () => {
        this.walking = false;
        this.speed = 0;
        if (opts.talk) this.talkUntil = this.clock + opts.talk;
        this.body.anim.play(this.talkUntil > this.clock ? 'Idle_Talking_Loop' : 'Idle_Loop', { fade: this.instant ? 0 : 0.3 });
        nextFidget = this.clock + 26 + Math.random() * 18;
        if (this.instant && opts.face) {
          const p = opts.face();
          if (p) this.setYaw(yawTo(this.group.position, p));
        }
        this.instant = false;
      },
      update: (dt) => {
        const face = opts.face?.();
        if (face && flat(face, this.group.position) < 3.5) this.turnToward(yawTo(this.group.position, face), dt, 3);
        let clip = 'Idle_Loop';
        if (this.talkUntil > this.clock) clip = 'Idle_Talking_Loop';
        else if (fidgetUntil > this.clock) clip = 'Idle_FoldArms_Loop';
        else if (this.clock > nextFidget) {
          fidgetUntil = this.clock + 7 + Math.random() * 5;
          nextFidget = fidgetUntil + 30 + Math.random() * 20;
          clip = 'Idle_FoldArms_Loop';
        }
        if (this.body.anim.current !== clip && this.body.has(clip)) this.body.anim.play(clip, { fade: 0.4 });
        return false;
      },
    };
  }

  private walk(
    target: THREE.Vector3 | (() => THREE.Vector3 | null),
    opts: { speed?: number; stopAt?: number; repath?: number; until?: () => boolean; straight?: boolean; locked?: boolean } = {},
  ): Step {
    let path: THREE.Vector3[] = [];
    let goal: THREE.Vector3 | null = null;
    let repathIn = opts.repath ?? Infinity;
    const resolve = () => (typeof target === 'function' ? target() : target);
    const plot = () => {
      goal = resolve()?.clone() ?? null;
      if (!goal || !this.ground) {
        path = [];
        return;
      }
      path = opts.straight ? [goal.clone()] : this.ground.findPath(this.group.position, goal);
      if (!path.length && this.ground.isFree(goal.x, goal.z)) path = [goal.clone()];
      while (path.length > 1 && flat(path[0], this.group.position) < 0.05) path.shift();
    };
    return {
      name: 'walk',
      locked: opts.locked,
      start: () => {
        plot();
        if (path.length && !this.instant) this.walking = true;
      },
      update: (dt) => {
        if (this.instant) {
          if (goal) this.group.position.set(goal.x, this.group.position.y, goal.z);
          return true;
        }
        if (opts.until?.()) return this.arrive();
        if (opts.repath !== undefined) {
          repathIn -= dt;
          if (repathIn <= 0) {
            repathIn = opts.repath;
            const g = resolve();
            if (!g) return this.arrive();
            if (!goal || flat(g, goal) > 0.3) plot();
          }
        }
        const wp = path[0];
        if (!wp) return this.arrive();
        const last = path.length === 1;
        if (!last && flat(wp, this.group.position) < 0.3) {
          path.shift();
          return false;
        }
        if (last && opts.stopAt && flat(wp, this.group.position) <= opts.stopAt) return this.arrive();
        if (this.moveToward(wp, dt, opts.speed ?? WALK_SPEED, last)) {
          path.shift();
          if (!path.length) return this.arrive();
        }
        return false;
      },
    };
  }

  private arrive(): boolean {
    this.speed = 0;
    this.walking = false;
    return true;
  }

  /** Straight segments with an explicit surface height (the stairs, a doorway walk-in). */
  private polyline(points: THREE.Vector3[], heights: (x: number, z: number) => number, hooks: { start?(): void; end?(): void }): Step {
    let i = 0;
    const done = () => {
      this.hfn = null;
      hooks.end?.();
      return this.arrive();
    };
    return {
      name: 'path',
      locked: true,
      start: () => {
        i = 0;
        this.hfn = heights;
        hooks.start?.();
        if (!this.instant) this.walking = true;
      },
      update: (dt) => {
        if (this.instant) {
          const end = points[points.length - 1];
          this.group.position.set(end.x, 0, end.z);
          if (points.length > 1) this.setYaw(yawTo(points[points.length - 2], end));
          return done();
        }
        const wp = points[i];
        if (!wp) return done();
        // on the stairs and through doors: a calmer pace than on the flat
        if (this.moveToward(wp, dt, 0.95, i === points.length - 1, true)) i++;
        return i >= points.length ? done() : false;
      },
    };
  }

  private turnTo(yaw: () => number): Step {
    let target = 0;
    return {
      name: 'turn',
      start: () => {
        target = yaw();
        if (this.instant) this.setYaw(target);
      },
      update: (dt) => {
        if (this.instant) return true;
        const d = wrap(target - this.yaw);
        if (Math.abs(d) < 0.06) {
          if (this.body.anim.current === 'Walk_Loop') this.body.anim.play('Idle_Loop', { fade: 0.3 });
          return true;
        }
        if (Math.abs(d) > 0.4) {
          if (this.body.anim.current !== 'Walk_Loop') this.body.anim.play('Walk_Loop', { timeScale: 0.55 });
          else this.body.anim.setTimeScale(0.55);
        }
        this.turnToward(target, dt, 6);
        return false;
      },
    };
  }

  private call(fn: () => void): Step {
    return { name: 'call', locked: true, update: () => { fn(); return true; } };
  }

  // ── sitting (the residents' choreography: pull the chair out, sit, scoot in) ─────────────────────

  private sitDepth(): number {
    const i = this.body.anim.info('Sitting_Enter');
    return i ? i.offEnd.distanceTo(i.offStart) * this.body.height : 0.25;
  }

  private seatOffset(slot: Slot): number {
    const info = this.body.anim.info(this.typing ? 'Sitting_Talking_Loop' : 'Sitting_Idle_Loop');
    const s = this.body.height;
    return (slot.sit?.seatY ?? 0.46) + PELVIS_ABOVE_SEAT * s - (info?.pelvisYStart ?? 0.55) * s;
  }

  private sitPlan(slot: Slot, typing: boolean): Step[] {
    const sit = slot.sit!;
    const f = facingOf(slot.yaw);
    const slide = sit.chair ? sit.slide ?? 0 : 0;
    const pulled = slot.pos.clone().addScaledVector(f, -slide);
    const stand = pulled.clone().addScaledVector(f, this.sitDepth());
    const steps: Step[] = [this.call(() => { this.typing = typing; })];
    if (this.instantMode) {
      steps.push(this.call(() => {
        this.group.position.set(slot.pos.x, this.group.position.y, slot.pos.z);
        this.setYaw(slot.yaw);
        this.seat = { slot, sitting: true, chair: 0, chairTarget: 0 };
        this.yOff = this.seatOffset(slot);
      }));
      steps.push(this.seatedLoop(slot));
      return steps;
    }
    // a resident may claim the desk while we walk over: give way before touching the chair
    const stillFree = this.call(() => {
      if (!slot.occupant) return;
      this.steps = [this.idle()];
      this.onSeatTaken?.(slot);
    });
    if (slide) {
      steps.push(this.walk(this.sidePoint(stand, slot.yaw)), stillFree);
      steps.push(this.call(() => { this.seat = { slot, sitting: false, chair: 0, chairTarget: slide }; }));
      steps.push(this.walk(stand, { straight: true, speed: 0.6, locked: true }));
    } else {
      steps.push(this.walk(stand), stillFree);
      steps.push(this.call(() => { this.seat = { slot, sitting: false, chair: 0, chairTarget: 0 }; }));
    }
    steps.push(this.turnTo(() => slot.yaw));
    steps.push(this.sitDown(slot));
    if (slide) steps.push(this.scoot(slot, +1));
    steps.push(this.seatedLoop(slot));
    return steps;
  }

  private sitDown(slot: Slot): Step {
    return {
      name: 'sit-down',
      locked: true,
      start: () => {
        if (this.seat) this.seat.sitting = true;
        this.body.anim.play('Sitting_Enter', { once: true });
      },
      update: () => {
        this.yOff = this.seatOffset(slot) * smooth(0.3, 0.9, this.body.anim.progress);
        return this.body.anim.finished;
      },
    };
  }

  private scoot(slot: Slot, dir: 1 | -1): Step {
    const slide = slot.sit!.slide ?? 0;
    const f = facingOf(slot.yaw);
    const from = new THREE.Vector3(), to = new THREE.Vector3();
    let t = 0;
    return {
      name: 'scoot',
      locked: true,
      start: () => {
        t = 0;
        from.copy(this.group.position);
        to.copy(from).addScaledVector(f, slide * dir);
        if (dir > 0) this.body.anim.play(this.typing ? 'Sitting_Talking_Loop' : 'Sitting_Idle_Loop', { fade: 0.35 });
        else if (this.body.arms) this.body.arms.typing.target = 0;
      },
      update: (dt) => {
        t = Math.min(1, t + dt / 0.7);
        const e = smooth(0, 1, t);
        this.group.position.lerpVectors(from, to, e);
        if (this.seat) this.seat.chair = this.seat.chairTarget = dir > 0 ? slide * (1 - e) : slide * e;
        return t >= 1;
      },
    };
  }

  private seatedLoop(slot: Slot): Step {
    return {
      name: 'seated',
      start: () => {
        this.walking = false;
        this.body.anim.play(this.typing ? 'Sitting_Talking_Loop' : 'Sitting_Idle_Loop', { fade: this.instant ? 0 : 0.3 });
        if (this.body.arms) {
          this.body.arms.typing.target = this.typing ? 1 : 0;
          if (this.instant) this.body.arms.typing.weight = this.typing ? 1 : 0;
        }
        this.setScreen(this.typing ? slot : null);
        this.instant = false;
      },
      update: () => {
        // a resident claimed this desk: give it back (the caller decides where we go next)
        if (slot.occupant) {
          const cb = this.onSeatTaken;
          this.plan(() => [...this.unseat(), this.idle()]);
          cb?.(slot);
        }
        return false;
      },
    };
  }

  private unseat(): Step[] {
    const seat = this.seat;
    if (!seat) return [];
    if (!seat.sitting) {
      return [this.call(() => {
        this.seat = null;
        this.releaseChairLater(seat);
      })];
    }
    if (this.instantMode) {
      return [this.call(() => {
        this.setScreen(null);
        if (this.body.arms) this.body.arms.typing.target = this.body.arms.typing.weight = 0;
        this.yOff = 0;
        this.seat = null;
        seat.chair = seat.chairTarget = 0;
        this.updateChairs(1, [seat]);
        this.group.position.copy(this.ground?.snap(this.sidePoint(this.group.position.clone(), seat.slot.yaw)) ?? this.group.position);
      })];
    }
    const slot = seat.slot;
    const slide = slot.sit?.chair ? slot.sit.slide ?? 0 : 0;
    const steps: Step[] = [];
    steps.push(this.call(() => {
      if (this.body.arms) this.body.arms.typing.target = 0;
      this.setScreen(null);
    }));
    if (slide) steps.push(this.scoot(slot, -1));
    let from = 0;
    steps.push({
      name: 'stand-up',
      locked: true,
      start: () => {
        from = this.yOff;
        this.body.anim.play('Sitting_Exit', { once: true });
      },
      update: () => {
        this.yOff = from * (1 - smooth(0.05, 0.6, this.body.anim.progress));
        if (!this.body.anim.finished) return false;
        this.yOff = 0;
        return true;
      },
    });
    if (slide) {
      steps.push(this.call(() => this.body.anim.play('Idle_Loop')));
      steps.push(this.walk(() => this.sidePoint(this.group.position.clone(), slot.yaw), { straight: true, speed: 0.7, locked: true }));
    }
    steps.push(this.call(() => {
      if (this.seat) this.seat.chairTarget = 0;
      this.seat = null;
      this.releaseChairLater(seat);
    }));
    return steps;
  }

  private releaseChairLater(seat: Seat) {
    seat.chairTarget = 0;
    if (!this.chairsReturning.includes(seat)) this.chairsReturning.push(seat);
  }

  private updateChairs(dt: number, extra: Seat[] = []) {
    const all = [...(this.seat ? [this.seat] : []), ...this.chairsReturning, ...extra];
    for (const s of all) {
      const chair = s.slot.sit?.chair;
      if (!chair) continue;
      s.chair += (s.chairTarget - s.chair) * Math.min(1, dt * 6);
      const home = (chair.userData.home ??= chair.position.clone()) as THREE.Vector3;
      chair.position.copy(home).addScaledVector(facingOf(s.slot.yaw, _w), -s.chair);
    }
    this.chairsReturning = this.chairsReturning.filter((s) => Math.abs(s.chair) > 0.002);
  }

  private dropSeat() {
    const seats = [...(this.seat ? [this.seat] : []), ...this.chairsReturning];
    for (const s of seats) s.chair = s.chairTarget = 0;
    this.updateChairs(1, seats);
    this.chairsReturning = [];
    this.seat = null;
    this.yOff = 0;
    this.setScreen(null);
    if (this.body.arms) this.body.arms.typing.target = this.body.arms.typing.weight = 0;
  }

  private setScreen(slot: Slot | null) {
    if (this.screenSlot && this.screenSlot !== slot && !this.screenSlot.occupant) this.screenSlot.screen?.setActive(false);
    this.screenSlot = slot;
    if (slot && !slot.occupant) slot.screen?.setActive(true, SCREEN_TINT);
  }

  /** A free spot beside a chair's standing point (desks are entered from the side). */
  private sidePoint(stand: THREE.Vector3, yaw: number): THREE.Vector3 {
    const right = _a.set(Math.cos(yaw), 0, -Math.sin(yaw));
    let best = stand.clone();
    let bestErr = Infinity;
    for (const s of [1, -1]) {
      const p = stand.clone().addScaledVector(right, 0.62 * s);
      const err = (this.ground ? this.ground.snap(p).distanceTo(p) : 0) + (s === 1 ? 0 : 0.01);
      if (err < bestErr) {
        bestErr = err;
        best = p;
      }
    }
    return best;
  }

  // ── locomotion ────────────────────────────────────────────────────────────────────────────────

  private moveToward(p: THREE.Vector3, dt: number, vmax: number, brake: boolean, ignoreGrid = false): boolean {
    const pos = this.group.position;
    _v.subVectors(p, pos).setY(0);
    const dist = _v.length();
    if (dist < 0.04) {
      pos.x = p.x;
      pos.z = p.z;
      return true;
    }
    const want = Math.atan2(_v.x, _v.z);
    const diff = Math.abs(wrap(want - this.yaw));
    this.turnToward(want, dt, 9);
    const align = THREE.MathUtils.clamp(Math.cos(diff), 0.12, 1);
    let target = vmax * align;
    if (brake) target = Math.min(target, dist * 2.4 + 0.18);
    this.speed += (target - this.speed) * Math.min(1, dt * 7);
    const step = Math.min(this.speed * dt, dist);
    _v.normalize();
    pos.addScaledVector(_v, step);
    if (!ignoreGrid) this.giveWay(dt, _v);
    this.walkAnim(this.speed);
    return step >= dist - 1e-4;
  }

  /** While walking, lean out of a resident's way (only onto free floor). */
  private giveWay(dt: number, dir: THREE.Vector3) {
    const g = this.ground;
    if (!g || !this.neighbours.length) return;
    const pos = this.group.position;
    for (const n of this.neighbours) {
      const d = flat(n.pos, pos);
      if (d > 0.7 || d < 1e-3) continue;
      _w.subVectors(pos, n.pos).setY(0).normalize();
      // push sideways relative to our heading, away from them
      const side = _a.set(-dir.z, 0, dir.x);
      const s = Math.sign(side.dot(_w)) || 1;
      const push = (0.7 - d) * 1.6 * dt;
      const nx = pos.x + side.x * s * push, nz = pos.z + side.z * s * push;
      if (g.isFree(nx, nz)) pos.set(nx, pos.y, nz);
    }
  }

  private walkAnim(speed: number) {
    const anim = this.body.anim;
    if (speed < 0.03) {
      if (anim.current === 'Walk_Loop') anim.play('Idle_Loop', { fade: 0.25 });
      return;
    }
    const ts = THREE.MathUtils.clamp(speed / this.body.walkSpeed, 0.35, 1.6);
    if (anim.current !== 'Walk_Loop') anim.play('Walk_Loop', { once: false, timeScale: ts });
    else anim.setTimeScale(ts);
  }

  private turnToward(yaw: number, dt: number, rate: number) {
    this.setYaw(this.yaw + wrap(yaw - this.yaw) * (1 - Math.exp(-rate * dt)));
  }

  private setYaw(y: number) {
    this.yaw = wrap(y);
    this.group.rotation.y = this.yaw;
  }

  /** Yaw toward the camera (ground-local). */
  cameraYaw(): number {
    if (!this.ground) return this.yaw;
    this.ground.cameraPosition(_cam);
    return yawTo(this.group.position, _cam);
  }
}
