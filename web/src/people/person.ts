// Person controller: one agent's body in the house. A small plan/step machine drives it:
//   activity changes → (stand up) → walk the A* path → turn → sit / lean / pace / loop a clip.
// Steps are tiny objects with start/update; walking and station loops are interruptible, transitions
// (sitting down, standing up, one-shots) always finish, and a station is held at least DWELL seconds.
// Busy leads and team members work seated at their own desk (activities.ts DESK_WORK): between tool calls only
// the seated clip and the overlays (typing, mouse, raised hand, head look, screen) change, and they stay seated
// for DESK_GRACE seconds after the work ends before standing up to wander (work that comes back while they get up
// sits them back down). A seat stays theirs until they are off it.
// Walking: paths are cut at sharp corners (stop, turn on the spot, walk on); legs are followed with braking for
// corners, turns while walking pivot on the stance foot, and turns on the spot step round (feet.ts).
import * as THREE from 'three';
import { VENDOR_COLORS, type Activity, type AgentInfo } from '../../../shared/protocol';
import { behaviorFor, DESK_GRACE, deskBehavior, FALLBACK_SEATS, standingWork, stationKinds, worksAtDesk, type Behavior, type PropKind } from './activities';
import { Animator } from './animator';
import { lookForAgent, type Look } from './appearance';
import { createCharacter, type Character } from './character';
import { Feet } from './feet';
import type { CharacterLibrary } from './library';
import { legLength, splitLegs, Track } from './locomotion';
import { HeadLook } from './look';
import { disposeProp, makeFolder, makeLaptop, makeMug, makePhone, makeVacuum, makeWateringCan } from './props';
import { hashString, mulberry32 } from './rng';
import { FloorMarkers, PersonTag } from './tag';
import type { PeopleWorld, Slot } from './types';
import { ArmOverlay } from './typing';

/** Walking pace (m/s): with the clips' ~0.95 m/s stride that is ~110 steps/min, an unhurried indoor walk. */
export const WALK_SPEED = 1.15;
/** Carrying the handoff folder: the upright formal walk, the folder held to the chest (ArmOverlay.carry). */
const CARRY_CLIP = 'Walk_Formal_Loop';
const CARRY_SPEED = 1.0;
const DWELL = 1.2;
/** Fastest on-the-spot turn (rad/s) and how fast it builds up (rad/s²); the feet step round (feet.ts). */
const TURN_RATE = 3;
const TURN_ACCEL = 12;
/** Walking: speeding up / slowing down (m/s²); brakes are planned softer than they can be. */
const ACCEL = 1.6, DECEL = 2.6, PLAN_DECEL = 1.8;
/** Fastest turn while walking (rad/s): the body turns about its stance foot, the planted foot stays put. */
const WALK_TURN = 2.4;
/** Path corners sharper than this are a stop: turn on the spot, walk on. */
const SHARP = THREE.MathUtils.degToRad(100);
/** Turn on the spot first when the way on is further round than this. */
const PIVOT_OVER = THREE.MathUtils.degToRad(50);
/** Walking slows down with a heading error over FREE_ALIGN and stops (to turn on the spot) at STOP_OVER. */
const FREE_ALIGN = THREE.MathUtils.degToRad(20), STOP_OVER = THREE.MathUtils.degToRad(80);
/** Speed at the end of a leg (m/s). Legs shorter than SHUFFLE (m) are stepped over without turning. */
const END_SPEED = 0.15;
const SHUFFLE = 0.4, SHUFFLE_SPEED = 0.35;
/** Clips the feet can be held in (turning on the spot, stopping, shuffling). */
const STANDING = /^(Idle_|Walk_|Interact|Yes|Consume)/;
/** Corner speed (m/s) for a path corner of `angle` rad (gentle ones at full speed). */
const cornerSpeed = (angle: number) =>
  angle <= FREE_ALIGN ? Infinity : WALK_SPEED * THREE.MathUtils.clamp(1 - ((angle - FREE_ALIGN) / (SHARP - FREE_ALIGN)) * 0.72, 0.28, 1);
const PELVIS_ABOVE_SEAT = 0.1;
/** Ground speed (m/s) each locomotion clip was authored for at timeScale 1 (fallbacks; the library measures them
 *  from the planted foot). */
export const CLIP_SPEED: Record<string, number> = { Walk_Loop: 0.95, Walk_Formal_Loop: 0.95 };
/** Desk top height (m): keyboards, laptops on desks and dining tables. */
const TABLE_Y = 0.75;

interface Step {
  name: string;
  /** Can be abandoned for a new plan (walking, loops). Transitions always run to completion. */
  interruptible: boolean;
  start?(): void;
  /** Returns true when finished. */
  update(dt: number): boolean;
  /** Getting up from a seat: the steps that sit back down from here (null once that is no longer possible). */
  revert?(): Step[] | null;
}

/** Seated work in progress (overlay timers, screen). */
interface DeskWork {
  b: Behavior;
  slot: Slot;
  /** The bursting overlay is on (typing / mouse) until `burstAt`. */
  burstOn: boolean;
  burstAt: number;
  /** The monitor is lit for this person; goes dark at `screenOffAt` (idle in the grace period). */
  lit: boolean;
  screenOffAt: number;
}

interface Seat {
  slot: Slot;
  /** False while only the chair is pulled out (person still standing). */
  sitting: boolean;
  /** How far the chair is pulled out (m along −facing), animated toward `chairTarget`. */
  chair: number;
  chairTarget: number;
}

export interface PersonEnv {
  world: PeopleWorld;
  find(agentId: string): Person | undefined;
  onClick(agentId: string): void;
}

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _v2 = new THREE.Vector2(), _cam = new THREE.Vector3();
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _q = new THREE.Quaternion();
const _st = new THREE.Vector3(), _m = new THREE.Matrix4(), _q2 = new THREE.Quaternion();
const _fl = new THREE.Vector2(), _fr = new THREE.Vector2();
const facingOf = (yaw: number, out = new THREE.Vector3()) => out.set(Math.sin(yaw), 0, Math.cos(yaw));
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const smooth = (e0: number, e1: number, x: number) => THREE.MathUtils.smoothstep(x, e0, e1);

export class Person {
  readonly id: string;
  readonly group = new THREE.Group();
  readonly look: Look;
  readonly ch: Character;
  readonly anim: Animator;
  readonly tag: PersonTag;
  readonly markers: FloorMarkers;
  readonly proxy: THREE.Mesh;
  agent: AgentInfo;
  /** Activity requested by the server (approvals override to waiting_approval). */
  desired: Activity;
  /** Activity whose plan is running. */
  current: Activity | null = null;
  slot: Slot | null = null;
  leaving = false;
  gone = false;
  hover = false;

  private steps: Step[] = [];
  private step: Step | null = null;
  private dirty = true;
  private settledAt = -1;
  private clock = 0;
  private yaw = 0;
  private speed = 0;
  private yOff = 0;
  private seat: Seat | null = null;
  private arms: ArmOverlay;
  private rand: () => number;
  private wanderIndex = 0;
  private celebrated = false;
  private instant = false;
  private carry: { to: string; label: string } | null = null;
  private holdFolderFor = 0;
  /** How far this body's torso pokes through the folder held to the chest (m; measured once, −1: not yet). */
  private folderFit = -1;
  private prop: PropKind = null;
  private props: Partial<Record<Exclude<PropKind, null>, THREE.Object3D>> = {};
  private vacuum: ReturnType<typeof makeVacuum> | null = null;
  private tagY = 2.1;
  /** Clock time the agent was last at work (DESK_WORK); seated people keep their seat until lastWorkAt + grace. */
  private lastWorkAt = -Infinity;
  private grace = DESK_GRACE[0];
  /** The seat taken for work (own desk or a fallback seat), while the plan uses it. */
  private workSlot: Slot | null = null;
  private desk: DeskWork | null = null;
  private laptop: THREE.Object3D | null = null;
  private headLook: HeadLook;
  private lookAt = new THREE.Vector3();
  private feet: Feet;
  /** Moved by the walker this frame / last frame (feet: stance tracking, a stop plants them). */
  private walking = false;
  private wasWalking = false;
  /** On-the-spot turn rate (rad/s), ramped. */
  private turnW = 0;
  /** Body transform the feet saw last (a change while standing makes them step). */
  private feetYaw = 0;
  private feetPos = new THREE.Vector3();
  private feetClip = '';
  /** The seat taken for work while sitting on it (work coming back during the stand-up sits back down on it). */
  private lastWorkSeat: Slot | null = null;

  /** `look` defaults to the agent's own; its body must be loaded (`lib.load(look)`). */
  constructor(agent: AgentInfo, lib: CharacterLibrary, private env: PersonEnv, look?: Look) {
    this.id = agent.id;
    this.agent = agent;
    this.desired = agent.activity;
    this.look = look ?? lookForAgent(agent);
    this.ch = createCharacter(lib, this.look);
    this.anim = new Animator(this.ch.model, this.ch.entry.clips, this.look.height);
    this.arms = new ArmOverlay(this.ch, agent.appearance.seed, this.look.height);
    this.headLook = new HeadLook(this.ch);
    this.rand = mulberry32(agent.appearance.seed ^ 0x9e3779b9);
    this.group.name = `person:${agent.name}`;
    this.group.add(this.ch.model);
    this.feet = new Feet(this.ch, this.group, this.look.height);

    const vendor = VENDOR_COLORS[agent.vendor] ?? VENDOR_COLORS.other;
    this.markers = new FloorMarkers(vendor);
    this.group.add(this.markers.group);
    this.tag = new PersonTag(() => env.onClick(this.id));
    this.group.add(this.tag.object);
    this.proxy = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 1.8, 10).translate(0, 0.9, 0), new THREE.MeshBasicMaterial({ visible: false }));
    this.proxy.userData.agentId = agent.id;
    this.group.add(this.proxy);
    this.tag.update(agent, this.desired);
  }

  get position(): THREE.Vector3 {
    return this.group.position;
  }

  get world(): PeopleWorld {
    return this.env.world;
  }

  get seated(): boolean {
    return !!this.seat;
  }

  // ── public API (manager) ──────────────────────────────────────────────────────────────────────
  /** Place the person directly at their activity's station (house just opened). */
  spawnAt(p: THREE.Vector3, yaw = 0) {
    this.group.position.copy(p);
    this.setYaw(yaw);
    this.feet.reset();
    this.instant = true;
    this.anim.play('Idle_Loop', { fade: 0 });
  }

  /** Walk in through the front door. */
  spawnAtDoor() {
    const { door } = this.env.world;
    this.group.position.copy(door.outside);
    this.setYaw(Math.atan2(door.inside.x - door.outside.x, door.inside.z - door.outside.z));
    this.anim.play('Walk_Loop', { fade: 0 });
    this.steps = [
      this.doorStep(true),
      this.walk(door.inside, { straight: true, locked: true }),
      this.doorStep(false),
    ];
    this.dirty = true;
    this.next();
  }

  setAgent(agent: AgentInfo, activity: Activity) {
    // leaving work: the seat is kept for a grace period (a gap between tasks or workflow steps)
    if (activity !== this.desired && worksAtDesk(this.agent, this.desired) && !worksAtDesk(agent, activity)) this.grace = this.between(DESK_GRACE);
    this.agent = agent;
    if (activity !== this.desired) {
      this.desired = activity;
      this.dirty = true;
      if (activity !== 'done') this.celebrated = false;
    }
    this.tag.update(agent, activity);
    this.markers.setMode(activity === 'waiting_approval' ? 'attn' : activity === 'error' || agent.status === 'error' ? 'error' : 'normal');
  }

  handoff(toAgentId: string, label: string) {
    this.carry = { to: toAgentId, label };
    this.dirty = true;
    this.say(`Handing off: ${label}`, 2600);
  }

  say(text: string, ms = 4000) {
    this.tag.say(text, ms);
  }

  /** Receive a folder (hold it for a moment). */
  receiveFolder() {
    this.holdFolderFor = 2.6;
  }

  /** Move into another world (the job moved to another room). Same floor: walk over there; another floor:
   *  reappear in the new room (people never ride the stairs between job rooms). */
  relocate(world: PeopleWorld) {
    const old = this.env.world;
    if (old === world) return;
    old.stations.disown(this.id);
    // a seat being sat on is let go once they are up (unseat)
    if (!this.onSeat(this.slot)) old.stations.release(this.slot);
    this.slot = null;
    this.workSlot = null;
    this.env.world = world;
    if (old.root !== world.root) {
      this.dropSeat();
      world.root.add(this.group);
      this.spawnAt(world.snap(world.spawnPoint()));
      this.steps = [];
      this.step = null;
    }
    this.dirty = true;
  }

  /** The station under this person is gone (its room was refurnished): settle again at once. */
  replanNow() {
    this.env.world.stations.release(this.slot);
    this.slot = null;
    this.workSlot = null;
    this.dropSeat();
    this.group.position.copy(this.env.world.snap(this.group.position));
    this.feet.reset();
    this.steps = [];
    this.step = null;
    this.instant = true;
    this.dirty = true;
  }

  private dropSeat() {
    for (const s of this.seat ? [this.seat, ...this.chairsReturning] : this.chairsReturning) s.chair = s.chairTarget = 0;
    this.updateChair(1);
    if (this.seat) this.leftSeat(this.seat.slot);
    this.seat = null;
    this.chairsReturning = [];
    this.yOff = 0;
    this.arms.typing.target = 0;
    this.arms.typing.weight = 0;
    this.arms.mouse.target = 0;
    this.arms.mouse.weight = 0;
    this.endDesk();
  }

  leave() {
    if (this.leaving) return;
    this.leaving = true;
    this.carry = null;
    this.dirty = false;
    const { door } = this.env.world;
    this.env.world.stations.disown(this.id);
    if (!this.onSeat(this.slot)) this.env.world.stations.release(this.slot);
    this.slot = null;
    this.workSlot = null;
    this.steps = [
      ...this.unseat(),
      this.walk(door.inside),
      this.doorStep(true),
      this.walk(door.outside, { straight: true }),
      this.doorStep(false),
      { name: 'gone', interruptible: false, update: () => { this.gone = true; return true; } },
    ];
    this.step = null;
    this.next();
  }

  update(dt: number) {
    this.clock += dt;
    this.walking = false;
    if (worksAtDesk(this.agent, this.desired) || (this.desired === 'error' && this.atWorkSeat())) this.lastWorkAt = this.clock;
    if (this.dirty && !this.leaving) this.sitBack();
    if (this.dirty && !this.leaving && this.canSwitch()) this.replan();
    if (this.step && this.step.update(dt)) this.next();
    if (!this.step && !this.leaving) {
      // plan finished (an idle spot timed out): wander somewhere else for the same activity
      if (!this.dirty) this.wanderIndex++;
      this.dirty = true;
      if (this.canSwitch()) this.replan();
    }

    this.anim.update(dt);
    this.anim.takeShift(_v2);
    if (_v2.lengthSq() > 0) {
      _v.set(_v2.x, 0, _v2.y).applyAxisAngle(THREE.Object3D.DEFAULT_UP, this.yaw);
      this.group.position.add(_v);
    }
    this.ch.model.position.y = this.yOff;
    this.group.position.y = this.env.world.heightAt(this.group.position.x, this.group.position.z);
    this.group.rotation.y = this.yaw;
    this.updateChair(dt);
    this.updateFeet(dt);
    this.tickDesk();
    this.arms.apply(dt, this.group);
    this.headLook.apply(dt, this.group);
    this.updateProps(dt);

    // tag follows the head (smoothed), markers stay on the floor
    this.ch.bone('Head').getWorldPosition(_v);
    this.group.worldToLocal(_v);
    this.tagY += (_v.y + 0.36 - this.tagY) * Math.min(1, dt * 5);
    this.tag.object.position.set(0, this.tagY, 0);
    this.env.world.cameraPosition(_cam);
    const camDistance = _cam.distanceTo(this.group.position);
    this.tag.tick(dt, camDistance, this.hover);
    this.markers.tick(dt, this.hover, this.seated, camDistance);
  }

  dispose() {
    this.env.world.stations.disown(this.id);
    this.env.world.stations.release(this.slot);
    if (this.seat) this.leftSeat(this.seat.slot);
    this.slot = null;
    for (const s of this.seat ? [this.seat, ...this.chairsReturning] : this.chairsReturning) s.chair = s.chairTarget = 0;
    this.updateChair(1);
    for (const o of Object.values(this.props)) if (o) disposeProp(o);
    if (this.laptop) disposeProp(this.laptop);
    this.anim.dispose();
    this.ch.dispose();
    this.tag.dispose();
    this.markers.dispose();
    this.proxy.geometry.dispose();
    this.group.removeFromParent();
  }

  // ── planning ─────────────────────────────────────────────────────────────────────────────────
  private canSwitch(): boolean {
    if (!this.step) return true;
    if (!this.step.interruptible) return false;
    return this.settledAt < 0 || this.clock - this.settledAt >= DWELL;
  }

  private next() {
    this.step = this.steps.shift() ?? null;
    this.step?.start?.();
    // instant mode lasts until the first step that has to wait (a loop)
    if (this.step && this.instant && this.step.update(0)) this.next();
  }

  private replan() {
    const { world } = this.env;
    const act = this.desired;
    this.dirty = false;
    this.current = act;
    this.settledAt = -1;
    this.arms.raise.target = 0;
    this.arms.hold.target = 0;
    if (!this.carry) this.setProp(null);
    const steps: Step[] = [];
    const prev = this.slot;
    let slot: Slot | null = null;
    let work: Slot | null = null;

    if (this.carry) {
      const carry = this.carry;
      const to = this.env.find(carry.to);
      const target = to ? this.besidePoint(to.position) : world.snap(this.group.position);
      steps.push(...this.unseat());
      steps.push(this.call(() => this.setProp('folder')));
      steps.push(this.walk(target, { clip: CARRY_CLIP, speed: CARRY_SPEED }));
      if (to) steps.push(this.turnTo(() => Math.atan2(to.position.x - this.position.x, to.position.z - this.position.z)));
      steps.push(this.oneShot('Interact', 0.45, () => {
        this.setProp(null);
        to?.receiveFolder();
        this.carry = null;
        this.dirty = true;
      }));
      slot = null;
    } else if (worksAtDesk(this.agent, act) || this.holdsWorkSeat(act)) {
      // seated work at their own desk; after the work, kept seated through the grace period (error: shaking the
      // head at the desk)
      const hold = !worksAtDesk(this.agent, act);
      const seat = hold ? this.seat!.slot : this.workSeat();
      if (act === 'done') this.celebrated = true; // (Yes is a standing clip)
      if (seat) {
        const b = deskBehavior(hold && act !== 'error' ? 'idle' : act, seat);
        if (this.seat?.sitting && this.seat.slot === seat) steps.push(this.seatedLoop(seat, b, hold && act !== 'error' ? this.lastWorkAt + this.grace : undefined));
        else steps.push(...this.unseat(), ...this.sitPlan(seat, b));
        slot = seat;
        work = seat;
      } else {
        // every seat in reach is taken: stand in our own room (no wandering)
        const spot = this.roomSpot();
        steps.push(...this.unseat());
        if (spot.distanceToSquared(this.group.position) > 0.36) steps.push(this.walk(spot));
        const b = standingWork(act);
        if (b.faceCamera) steps.push(this.turnTo(() => this.cameraYaw()));
        steps.push(this.stay(null, b));
      }
    } else if (act === 'error') {
      steps.push(...this.unseat(), this.stay(null, { clip: 'Idle_No_Loop', faceCamera: true }));
    } else if (act === 'waiting_approval') {
      const out = this.stepOutPoint();
      steps.push(...this.unseat(), this.walk(out), this.turnTo(() => this.cameraYaw()), this.stay(null, { clip: 'Idle_Loop', raise: true, faceCamera: true }));
    } else {
      const celebrate = act === 'done' && !this.celebrated;
      if (celebrate) this.celebrated = true;
      const kinds = stationKinds(act, this.agent, this.wanderIndex);
      if (kinds.length) {
        // keep the current seat when the new activity sits at the same kind (writing ↔ writing)
        slot = world.stations.claim(kinds, this.id, this.group.position);
      }
      const b = slot ? behaviorFor(act, slot) : { clip: 'Idle_Loop' as const };
      // (only once actually seated: with the chair merely pulled out the person is still standing)
      const keepSeat = !!(this.seat?.sitting && slot && this.seat.slot === slot && b.sit);
      if (!keepSeat) steps.push(...this.unseat());
      if (celebrate) steps.push(this.oneShot('Yes'));
      if (!slot) {
        // every matching station is taken: stand somewhere in our own room (a moved job's people follow it)
        const spot = this.roomSpot();
        if (spot.distanceToSquared(this.group.position) > 0.36) steps.push(this.walk(spot));
        steps.push(this.stay(null, b));
      }
      else if (keepSeat) steps.push(this.seatedLoop(slot, b));
      else steps.push(...this.goTo(slot, b));
    }
    // (a seat being sat on is let go once they are up: unseat)
    if (prev && prev !== slot && !this.onSeat(prev)) world.stations.release(prev);
    this.slot = slot;
    this.workSlot = work;
    this.steps = steps;
    this.step = null;
    this.next();
  }

  /** Seated at the seat taken for work. */
  private atWorkSeat(): boolean {
    return !!(this.seat?.sitting && this.workSlot && this.seat.slot === this.workSlot && this.slot === this.workSlot);
  }

  /** After the work (or on an error at the desk), a seated worker stays put for the grace period. */
  private holdsWorkSeat(act: Activity): boolean {
    if (this.agent.kind === 'subagent' || !this.atWorkSeat()) return false;
    return act === 'error' || this.clock - this.lastWorkAt < this.grace;
  }

  /** Sitting on `slot` (or with its chair pulled out): it stays theirs until they are off it. */
  private onSeat(slot: Slot | null): boolean {
    return !!slot && this.seat?.slot === slot;
  }

  /** Off the seat `slot`: let it go unless the plan holds it again. */
  private leftSeat(slot: Slot) {
    if (this.lastWorkSeat === slot) this.lastWorkSeat = null;
    if (slot !== this.slot && slot.occupant === this.id) this.env.world.stations.release(slot);
  }

  /** Work came back while they push the chair out / get up from the work seat after the grace period: sit back
   *  down from where they are (the step's revert) and keep the seat, instead of standing up to sit down again. */
  private sitBack() {
    const seat = this.seat;
    if (!seat?.sitting || !this.step?.revert || this.carry || !worksAtDesk(this.agent, this.desired)) return;
    if (seat.slot !== this.lastWorkSeat || seat.slot.occupant !== this.id) return;
    const back = this.step.revert();
    if (!back) return;
    // the spot claimed for afterwards goes back; the seat is the work seat again (replan keeps it)
    if (this.slot && this.slot !== seat.slot) this.env.world.stations.release(this.slot);
    this.slot = this.workSlot = seat.slot;
    this.steps = back;
    this.step = null;
    this.next();
  }

  /** Where to work: a fallback seat already sat on for work is kept (no switching mid-task); else the own desk,
   *  else a fallback seat (a free desk nobody owns, sofa, armchair, dining chair: room first, then shared). */
  private workSeat(): Slot | null {
    const { stations } = this.env.world;
    if (this.atWorkSeat() && this.workSlot!.owner !== this.id) return this.workSlot;
    return stations.ownDesk(this.id) ?? stations.claim(FALLBACK_SEATS, this.id, this.group.position);
  }

  private goTo(slot: Slot, b: Behavior): Step[] {
    if (b.sit && slot.sit) return this.sitPlan(slot, b);
    if (b.route === 'pace' && slot.route?.length) return [this.walk(slot.route[0]), this.pace(slot, b)];
    if (b.route === 'loop' && slot.route?.length) return [this.walk(slot.route[0]), this.routeLoop(slot, b)];
    return [this.walk(slot.pos), this.turnTo(b.faceCamera ? () => this.cameraYaw() : () => slot.yaw), this.stay(slot, b)];
  }

  // ── sitting ──────────────────────────────────────────────────────────────────────────────────
  /** Hips travel this far backward during Sitting_Enter (and forward again in Sitting_Exit). */
  private sitDepth(): number {
    const i = this.anim.info('Sitting_Enter');
    return i ? i.offEnd.distanceTo(i.offStart) * this.look.height : 0.25;
  }

  private sitPlan(slot: Slot, b: Behavior): Step[] {
    const sit = slot.sit!;
    const f = facingOf(slot.yaw);
    const slide = sit.chair ? sit.slide ?? 0 : 0;
    const pulled = slot.pos.clone().addScaledVector(f, -slide);
    const stand = pulled.clone().addScaledVector(f, this.sitDepth());
    const steps: Step[] = [];
    if (this.instant) {
      steps.push(this.call(() => {
        this.group.position.copy(slot.pos);
        this.setYaw(slot.yaw);
        this.seat = { slot, sitting: true, chair: 0, chairTarget: 0 };
        this.yOff = this.seatOffset(slot, b);
      }));
      steps.push(this.seatedLoop(slot, b));
      return steps;
    }
    // once the chair is out the rest runs to completion (a replan in between would find a seat that is not sat on)
    if (slide) {
      const side = this.sidePoint(stand, slot.yaw);
      steps.push(this.walk(side));
      steps.push(this.call(() => { this.seat = { slot, sitting: false, chair: 0, chairTarget: slide }; }));
      steps.push(this.walk(stand, { straight: true, speed: 0.6, locked: true }));
    } else {
      steps.push(this.walk(stand));
      steps.push(this.call(() => { this.seat = { slot, sitting: false, chair: 0, chairTarget: 0 }; }));
    }
    steps.push(this.turnTo(() => slot.yaw, { locked: true }));
    steps.push(this.sitDown(slot, b));
    if (slide) steps.push(this.scoot(slot, b, +1));
    steps.push(this.seatedLoop(slot, b));
    return steps;
  }

  private seatOffset(slot: Slot, b: Behavior): number {
    const info = this.anim.info(b.sit ?? 'Sitting_Idle_Loop');
    const s = this.look.height;
    return slot.sit!.seatY + PELVIS_ABOVE_SEAT * s - (info?.pelvisYStart ?? 0.55) * s;
  }

  private sitDown(slot: Slot, b: Behavior): Step {
    const target = this.seatOffset(slot, b);
    return {
      name: 'sit-down',
      interruptible: false,
      start: () => {
        if (this.seat) this.seat.sitting = true;
        this.anim.play('Sitting_Enter', { once: true });
      },
      update: () => {
        this.yOff = target * smooth(0.3, 0.9, this.anim.progress);
        return this.anim.finished;
      },
    };
  }

  /** Slide in (+1) toward the desk with the chair, or back out (−1); `onto`: slide in to this seated position
   *  (from wherever the chair is). The scoot out can be reverted (sitBack). */
  private scoot(slot: Slot, b: Behavior, dir: 1 | -1, onto?: THREE.Vector3): Step {
    const slide = slot.sit!.slide ?? 0;
    const f = facingOf(slot.yaw);
    const from = new THREE.Vector3(), to = new THREE.Vector3();
    let t = 0, T = 0.7;
    const step: Step = {
      name: 'scoot',
      interruptible: false,
      start: () => {
        t = 0;
        from.copy(this.group.position);
        if (onto) to.copy(onto);
        else to.copy(from).addScaledVector(f, slide * dir);
        T = 0.7 * THREE.MathUtils.clamp(from.distanceTo(to) / Math.max(slide, 1e-3), 0.3, 1);
        if (dir > 0) this.anim.play(b.sit ?? 'Sitting_Idle_Loop', { fade: 0.35 });
        else this.arms.typing.target = 0;
      },
      update: (dt) => {
        t = Math.min(1, t + dt / T);
        this.group.position.lerpVectors(from, to, smooth(0, 1, t));
        // the chair is out by how far they are from the seated position
        const seated = dir > 0 ? to : from;
        if (this.seat) this.seat.chair = this.seat.chairTarget = THREE.MathUtils.clamp(_a.subVectors(seated, this.group.position).dot(f), 0, slide);
        return t >= 1;
      },
    };
    if (dir < 0) step.revert = () => [this.scoot(slot, b, 1, from.clone())];
    return step;
  }

  /** Sitting_Exit played back from where it got to: down onto the seat again, then the seated clip. */
  private sitBackDown(seatedY: number, clip: string): Step {
    return {
      name: 'sit-back',
      interruptible: false,
      start: () => this.anim.setTimeScale(-1.25),
      update: () => {
        const p = this.anim.current === 'Sitting_Exit' ? this.anim.progress : 0;
        this.yOff = seatedY * (1 - smooth(0.05, 0.6, p));
        if (p > 0.002) return false;
        this.yOff = seatedY;
        this.anim.play(clip, { fade: 0.3 });
        return true;
      },
    };
  }

  /** Seated at `slot`: the clip, hands, head and screen per `b`. Ends after `b.wander` or at clock `until`. */
  private seatedLoop(slot: Slot, b: Behavior, until?: number): Step {
    let wanderAt = Infinity;
    return {
      name: 'seated',
      interruptible: true,
      start: () => {
        this.settle();
        this.lastWorkSeat = slot === this.workSlot ? slot : null;
        this.anim.play(b.sit ?? 'Sitting_Idle_Loop', { once: false, fade: this.instant ? 0 : 0.3 });
        this.setProp(b.prop ?? null);
        const lap = !this.hasTable(slot);
        const laptop = this.showLaptop(b.laptop ? slot : null);
        this.arms.seated = true;
        this.arms.lap = lap;
        if (laptop) this.arms.keyboard.set(laptop.position.y + 0.004, laptop.position.z + 0.02);
        else this.arms.keyboard.set(TABLE_Y, 0.36);
        this.arms.typing.target = b.typing ? 1 : 0;
        this.arms.mouse.target = b.mouse ? 1 : 0;
        this.arms.raise.target = b.raise ? 1 : 0;
        if (this.instant) {
          this.arms.typing.weight = this.arms.typing.target;
          this.arms.mouse.weight = this.arms.mouse.target;
        }
        const was = this.desk?.slot === slot && this.desk.lit;
        const lit = !!(b.screen || b.typing) && !!slot.screen;
        if (lit) slot.screen!.setActive(true, VENDOR_COLORS[this.agent.vendor]);
        else if (!was) slot.screen?.setActive(false);
        const bursts = b.bursts;
        this.desk = {
          b, slot,
          burstOn: bursts ? !!b[bursts.overlay] : false,
          burstAt: bursts ? this.clock + this.between(b[bursts.overlay] ? bursts.on : bursts.off) : Infinity,
          lit: lit || was,
          // idle in the grace period: the screen goes dark a little later
          screenOffAt: !lit && was ? this.clock + 3 : Infinity,
        };
        if (b.wander) wanderAt = this.clock + this.between(b.wander);
        this.instant = false;
      },
      update: () => this.clock > wanderAt || (until !== undefined && this.clock > until),
    };
  }

  /** A table in front of the seat (desk, dining table); otherwise the laptop goes on the lap. */
  private hasTable(slot: Slot): boolean {
    return slot.kind === 'desk' || slot.kind === 'dining';
  }

  /** Per frame while seated at work: overlay bursts, the screen going dark, where the head looks. */
  private tickDesk() {
    const d = this.desk;
    this.headLook.shake = !!d?.b.shake;
    if (!d) {
      this.headLook.target = null;
      return;
    }
    const { b } = d;
    if (b.bursts && this.clock >= d.burstAt) {
      d.burstOn = !d.burstOn;
      d.burstAt = this.clock + this.between(d.burstOn ? b.bursts.on : b.bursts.off);
      this.arms[b.bursts.overlay].target = d.burstOn ? 1 : 0;
    }
    if (this.clock >= d.screenOffAt) {
      d.screenOffAt = Infinity;
      d.lit = false;
      d.slot.screen?.setActive(false);
    }
    const t = this.lookAt;
    switch (b.look) {
      case 'screen':
        if (this.laptop?.visible) t.set(0, this.laptop.position.y + 0.12, this.laptop.position.z + 0.08);
        else t.set(0, 1.0, 0.85);
        break;
      case 'camera':
        this.toLocal(this.env.world.cameraPosition(t));
        break;
      case 'room':
        this.toLocal(t.copy(this.env.world.spawnPoint())).setY(1.25);
        break;
      default:
        this.headLook.target = null;
        return;
    }
    this.headLook.target = t;
  }

  /** Floor-local point → this person's local frame (faces +Z). */
  private toLocal(p: THREE.Vector3): THREE.Vector3 {
    return p.sub(this.group.position).applyAxisAngle(THREE.Object3D.DEFAULT_UP, -this.yaw);
  }

  /** Seated work is over (standing up, dropped): overlays off, laptop away. */
  private endDesk() {
    if (this.desk) {
      this.arms.mouse.target = 0;
      this.arms.raise.target = 0;
    }
    this.desk = null;
    this.arms.seated = false;
    this.arms.lap = false;
    this.showLaptop(null);
  }

  /** The person's own laptop in front of them at `slot` (on the table, else on the lap); null hides it. */
  private showLaptop(slot: Slot | null): THREE.Object3D | null {
    if (!slot) {
      if (this.laptop) this.laptop.visible = false;
      return null;
    }
    if (!this.laptop) {
      this.laptop = makeLaptop(VENDOR_COLORS[this.agent.vendor] ?? '#7fb4ff');
      this.laptop.rotation.y = Math.PI; // the user side (+Z) toward the person
      this.group.add(this.laptop);
    }
    // on a table: past the near edge (~0.32 m in front of the seat); on the lap: over the thighs
    if (this.hasTable(slot)) this.laptop.position.set(0, (slot.kind === 'dining' ? TABLE_Y + 0.01 : TABLE_Y) + 0.002, 0.46);
    else this.laptop.position.set(0, (slot.sit?.seatY ?? 0.45) + 0.16, 0.3);
    this.laptop.visible = true;
    return this.laptop;
  }

  /** Steps that get a seated person back on their feet (no-op when standing). */
  private unseat(): Step[] {
    const seat = this.seat;
    if (!seat) return [];
    if (!seat.sitting) {
      // only the chair was pulled out: push it back
      return [this.call(() => {
        this.seat = null;
        this.endDesk();
        this.releaseChairLater(seat);
        this.leftSeat(seat.slot);
      })];
    }
    const slot = seat.slot;
    const slide = slot.sit?.chair ? slot.sit.slide ?? 0 : 0;
    const steps: Step[] = [];
    steps.push(this.call(() => {
      this.arms.typing.target = 0;
      this.setProp(null);
      this.endDesk();
      slot.screen?.setActive(false);
    }));
    const seated = this.group.position.clone();
    if (slide) steps.push(this.scoot(slot, { clip: 'Idle_Loop' }, -1));
    const from = this.yOff;
    steps.push({
      name: 'stand-up',
      interruptible: false,
      start: () => this.anim.play('Sitting_Exit', { once: true }),
      update: () => {
        this.yOff = from * (1 - smooth(0.05, 0.6, this.anim.progress));
        if (!this.anim.finished) return false;
        this.yOff = 0;
        return true;
      },
      // not up yet: play the stand-up back down, then slide in again
      revert: () => this.anim.current !== 'Sitting_Exit' || this.anim.finished ? null
        : [this.sitBackDown(from, 'Sitting_Idle_Loop'), ...(slide ? [this.scoot(slot, { clip: 'Idle_Loop', sit: 'Sitting_Idle_Loop' }, 1, seated)] : [])],
    });
    if (slide) {
      steps.push(this.call(() => this.anim.play('Idle_Loop')));
      steps.push(this.walk(() => this.sidePoint(this.group.position.clone(), slot.yaw), { straight: true, speed: 0.7, locked: true }));
    }
    steps.push(this.call(() => {
      if (this.seat) this.seat.chairTarget = 0;
      this.seat = null;
      this.releaseChairLater(seat);
      this.leftSeat(slot);
    }));
    return steps;
  }

  private chairsReturning: Seat[] = [];
  private releaseChairLater(seat: Seat) {
    seat.chairTarget = 0;
    this.chairsReturning.push(seat);
  }

  private updateChair(dt: number) {
    const all = this.seat ? [this.seat, ...this.chairsReturning] : this.chairsReturning;
    for (const s of all) {
      const chair = s.slot.sit?.chair;
      if (!chair) continue;
      s.chair += (s.chairTarget - s.chair) * Math.min(1, dt * 6);
      const home = (chair.userData.home ??= chair.position.clone()) as THREE.Vector3;
      chair.position.copy(home).addScaledVector(facingOf(s.slot.yaw, _w), -s.chair);
    }
    this.chairsReturning = this.chairsReturning.filter((s) => Math.abs(s.chair) > 0.002);
  }

  /** A free spot beside a chair's standing point (desks are entered from the side). */
  private sidePoint(stand: THREE.Vector3, yaw: number): THREE.Vector3 {
    const right = _a.set(Math.cos(yaw), 0, -Math.sin(yaw));
    let best = stand.clone();
    let bestErr = Infinity;
    for (const s of [1, -1]) {
      const p = stand.clone().addScaledVector(right, 0.62 * s);
      const err = this.env.world.snap(p).distanceTo(p) + (s === 1 ? 0 : 0.01);
      if (err < bestErr) { bestErr = err; best = p; }
    }
    return best;
  }

  // ── standing behaviours ──────────────────────────────────────────────────────────────────────
  private stay(slot: Slot | null, b: Behavior): Step {
    let phase: 'intro' | 'loop' | 'accent' = 'loop';
    let nextAccent = Infinity, wanderAt = Infinity;
    return {
      name: `stay:${b.clip}`,
      interruptible: true,
      start: () => {
        this.settle();
        this.setProp(b.prop ?? null);
        this.arms.raise.target = b.raise ? 1 : 0;
        if (b.intro && !this.instant) {
          this.anim.play(b.intro, { once: true });
          phase = 'intro';
        } else {
          this.anim.play(b.clip, { once: false, fade: this.instant ? 0 : 0.25 });
          phase = 'loop';
        }
        if (b.accent) nextAccent = this.clock + this.between(b.accent.every);
        if (b.wander) wanderAt = this.clock + this.between(b.wander);
        if (this.instant && slot) this.setYaw(b.faceCamera ? this.cameraYaw() : slot.yaw);
        this.instant = false;
      },
      update: (dt) => {
        if (b.faceCamera) this.turnToward(this.cameraYaw(), dt, 3);
        if (phase !== 'loop' && this.anim.finished) {
          this.anim.play(b.clip, { once: false });
          phase = 'loop';
        } else if (phase === 'loop' && b.accent && this.clock > nextAccent) {
          this.anim.play(b.accent.clip, { once: true });
          phase = 'accent';
          nextAccent = this.clock + this.between(b.accent.every);
        }
        return phase === 'loop' && this.clock > wanderAt;
      },
    };
  }

  /** Thinking: short paces along the route, pausing with folded arms facing the board (stop, turn, walk). */
  private pace(slot: Slot, b: Behavior): Step {
    const route = slot.route!;
    let i = 0;
    let pauseUntil = 0;
    let walk: ((dt: number) => boolean) | null = null;
    return {
      name: 'pace',
      interruptible: true,
      start: () => {
        this.settle();
        this.instant = false;
        pauseUntil = this.clock + 0.6;
        walk = null;
        this.toIdle('Idle_FoldArms_Loop');
      },
      update: (dt) => {
        if (!walk) {
          const facing = this.turnInPlace(slot.yaw, dt);
          if (facing && this.clock > pauseUntil) {
            i = (i + 1) % route.length;
            walk = this.walker([route[i]], 0.85, b.clip, { idle: 'Idle_FoldArms_Loop' });
          }
          return false;
        }
        if (walk(dt)) {
          walk = null;
          pauseUntil = this.clock + this.between([1.8, 3.4]);
          this.toIdle('Idle_FoldArms_Loop');
        }
        return false;
      },
    };
  }

  /** Vacuuming: an easy walk round and round a closed loop, right hand on the stick, strokes back and forth. */
  private routeLoop(slot: Slot, b: Behavior): Step {
    const route = slot.route!;
    let walk: ((dt: number) => boolean) | null = null;
    return {
      name: 'route',
      interruptible: true,
      start: () => {
        this.settle();
        this.instant = false;
        this.setProp(b.prop ?? null);
        this.arms.hold.target = b.prop === 'vacuum' ? 1 : 0;
        walk = null;
      },
      update: (dt) => {
        if (!walk) {
          // a dozen laps from the nearest corner on (rebuilt when they are done)
          let k = 0;
          route.forEach((p, j) => { if (p.distanceToSquared(this.group.position) < route[k].distanceToSquared(this.group.position)) k = j; });
          const laps: THREE.Vector3[] = [];
          for (let n = 1; n <= route.length * 12; n++) laps.push(route[(k + n) % route.length]);
          walk = this.walker(laps, 0.5, b.clip, { keepClip: true });
        }
        if (walk(dt)) walk = null;
        return false;
      },
    };
  }

  private oneShot(clip: string, at = 1, onAt?: () => void): Step {
    let fired = false;
    return {
      name: `once:${clip}`,
      interruptible: false,
      start: () => {
        if (this.instant) { fired = true; onAt?.(); return; }
        this.anim.play(clip, { once: true, restart: true });
      },
      update: () => {
        if (this.instant) return true;
        if (!fired && this.anim.progress >= at) { fired = true; onAt?.(); }
        if (this.anim.finished) {
          if (!fired) { fired = true; onAt?.(); }
          return true;
        }
        return false;
      },
    };
  }

  private call(fn: () => void): Step {
    return { name: 'call', interruptible: false, update: () => { fn(); return true; } };
  }

  private doorStep(open: boolean): Step {
    return this.call(() => this.env.world.door.open(open));
  }

  // ── locomotion ───────────────────────────────────────────────────────────────────────────────
  private walk(target: THREE.Vector3 | (() => THREE.Vector3), opts: { straight?: boolean; clip?: string; speed?: number; locked?: boolean } = {}): Step {
    let goal = new THREE.Vector3();
    let run: ((dt: number) => boolean) | null = null;
    return {
      name: 'walk',
      interruptible: !opts.locked,
      start: () => {
        goal = (typeof target === 'function' ? target() : target).clone();
        run = null;
        if (this.instant) return;
        let path = opts.straight ? [goal.clone()] : this.env.world.findPath(this.group.position, goal);
        if (!path.length) path = [goal.clone()];
        run = this.walker(path, opts.speed ?? WALK_SPEED, opts.clip ?? 'Walk_Loop');
      },
      update: (dt) => {
        if (this.instant || !run) {
          this.group.position.copy(goal);
          return true;
        }
        return run(dt);
      },
    };
  }

  /** Walk `path` from here at up to `vmax` with `clip`. The path is cut into legs at its sharp corners; a leg that
   *  starts far round from the facing is begun by turning on the spot (in the `idle` clip), short legs are stepped
   *  over without turning, the rest is followed by pure pursuit, slowing for corners and stopping at the end.
   *  Returns the per-frame update (true once at the end of the path). Substeps keep it frame-rate independent. */
  private walker(path: THREE.Vector3[], vmax: number, clip: string, opts: { idle?: string; keepClip?: boolean } = {}): (dt: number) => boolean {
    const legs = splitLegs(this.group.position, path, SHARP);
    const idle = opts.idle ?? 'Idle_Loop';
    // from standing (a walk given up for a one-shot or a stay left its speed behind): start from rest
    if (!this.wasWalking) this.speed = 0;
    let i = 0, track: Track | null = null, mode: 'walk' | 'pivot' | 'shuffle' = 'walk', settle = 0;
    const tick = (dt: number): boolean => {
      const pos = this.group.position;
      if (!track) {
        if (i >= legs.length) return true;
        track = new Track([new THREE.Vector3(pos.x, 0, pos.z), ...legs[i].slice(1)]);
        mode = legLength(track.pts) < SHUFFLE ? 'shuffle' : 'walk';
        settle = 0;
      }
      const end = track.end;
      const rem = track.update(pos);
      const dEnd = Math.hypot(end.x - pos.x, end.z - pos.z);
      if (mode === 'shuffle' || rem < 0.12) {
        if (dEnd < 0.02) {
          pos.x = end.x;
          pos.z = end.z;
          track = null;
          this.speed = 0;
          if (++i < legs.length) return false;
          // stopped: the stride freezes while the next clip fades in (the feet plant, feet.ts)
          if (this.anim.current?.startsWith('Walk_')) this.anim.setTimeScale(0);
          return true;
        }
        // a few steps' way (or the last few cm of a leg): straight there, without turning, still braking down to
        // END_SPEED on the end (else they arrive at the ~0.7 m/s the brake curve has here and stop dead)
        const v = mode === 'shuffle' ? SHUFFLE_SPEED : Math.max(END_SPEED, Math.min(this.speed, Math.sqrt(END_SPEED * END_SPEED + 2 * PLAN_DECEL * dEnd)));
        if (mode === 'shuffle') this.toIdle(idle);
        const step = Math.min(dEnd, v * dt);
        pos.x += ((end.x - pos.x) / dEnd) * step;
        pos.z += ((end.z - pos.z) / dEnd) * step;
        if (mode !== 'shuffle') {
          this.speed = v;
          this.stride(clip, opts.keepClip);
          this.walking = true;
        }
        return false;
      }
      const L = THREE.MathUtils.clamp(0.3 + 0.45 * this.speed, 0.3, 0.75);
      const c = track.carrot(L, _c);
      const want = Math.atan2(c.x - pos.x, c.z - pos.z);
      const alpha = wrap(want - this.yaw), a = Math.abs(alpha);
      if (mode === 'pivot') {
        // turning on the spot toward the way on (the feet step round); off once they have caught up
        if (!this.turnInPlace(want, dt)) return false;
        settle += dt;
        if (!this.feet.settled && settle < 0.5) return false;
        mode = 'walk';
      } else if (this.speed < 0.1 && a > PIVOT_OVER) {
        mode = 'pivot';
        this.toIdle(idle);
        return false;
      }
      let v = vmax;
      if (a > FREE_ALIGN) v *= THREE.MathUtils.clamp((STOP_OVER - a) / (STOP_OVER - FREE_ALIGN), 0, 1);
      // slow enough to make the turn at WALK_TURN, and for the corners and the stop ahead
      v = Math.min(v, (WALK_TURN * L) / (2 * Math.max(0.05, Math.sin(Math.min(a, Math.PI / 2)))));
      v = Math.min(v, track.limit(vmax, PLAN_DECEL, cornerSpeed, END_SPEED));
      this.speed += THREE.MathUtils.clamp(v - this.speed, -DECEL * dt, ACCEL * dt);
      if (this.speed <= 1e-3) {
        this.speed = 0;
        return false;
      }
      this.turnW = 0;
      this.turnWalking(THREE.MathUtils.clamp((2 * this.speed * Math.sin(alpha)) / L, -WALK_TURN, WALK_TURN) * dt);
      pos.x += Math.sin(this.yaw) * this.speed * dt;
      pos.z += Math.cos(this.yaw) * this.speed * dt;
      this.stride(clip, opts.keepClip);
      this.walking = true;
      return false;
    };
    return (dt) => {
      const n = Math.min(30, Math.max(1, Math.ceil(dt * 60 - 1e-6)));
      for (let k = 0; k < n; k++) if (tick(dt / n)) return true;
      return false;
    };
  }

  /** The walk clip at a playback rate matched to the ground speed. From standing it starts once there is some way
   *  on, at the phase whose feet are nearest where the feet stand (they do not skate into the stride). */
  private stride(clip: string, keepClip = false) {
    const cur = this.anim.current ?? '';
    if (cur !== clip && this.speed < 0.06) return;
    const natural = (this.anim.info(clip)?.speed ?? CLIP_SPEED[clip] ?? 1) * this.look.height;
    const ts = THREE.MathUtils.clamp(this.speed / natural, keepClip ? 0.45 : 0.12, 1.6);
    if (cur !== clip) this.anim.play(clip, { once: false, timeScale: ts, at: cur.startsWith('Walk_') ? undefined : this.strideStart(clip) });
    else this.anim.setTimeScale(ts);
  }

  /** Time in the walk clip whose feet best match where the feet are (the clip's planted foot counts most). */
  private strideStart(clip: string): number {
    const info = this.anim.info(clip);
    const ft = info?.feet;
    if (!ft) return 0;
    this.feet.placed(_fl, _fr);
    const s = this.look.height, ox = info.offMean.x, oz = info.offMean.y;
    let best = 0, bestErr = Infinity;
    for (let k = 0; k < ft.times.length - 1; k++) {
      let err = 0;
      for (const [track, at] of [[ft.l, _fl], [ft.r, _fr]] as const) {
        const x = (track[k * 3] - ox) * s - at.x, z = (track[k * 3 + 2] - oz) * s - at.y;
        err += (track[k * 3 + 1] - ft.minY < 0.03 ? 1 : 0.35) * (x * x + z * z);
      }
      if (err < bestErr) { bestErr = err; best = ft.times[k]; }
    }
    return best;
  }

  /** Stop walking: the stride freezes where it is while `clip` fades in (the feet plant and step home). */
  private toIdle(clip: string) {
    const cur = this.anim.current ?? '';
    if (cur.startsWith('Walk_')) this.anim.setTimeScale(0);
    if (cur !== clip) this.anim.play(clip, { fade: 0.3 });
    this.speed = 0;
  }

  /** Turn while walking: about the stance foot (from the last frame's pose), so the planted foot stays put. */
  private turnWalking(d: number) {
    if (!d) return;
    const s = this.feet.stance(_st);
    const c0 = Math.cos(this.yaw), s0 = Math.sin(this.yaw), c1 = Math.cos(this.yaw + d), s1 = Math.sin(this.yaw + d);
    this.group.position.x += c0 * s.x + s0 * s.z - (c1 * s.x + s1 * s.z);
    this.group.position.z += -s0 * s.x + c0 * s.z - (-s1 * s.x + c1 * s.z);
    this.setYaw(this.yaw + d);
  }

  /** One frame of turning on the spot toward `yaw`, the rate ramped up to TURN_RATE and eased out; true when
   *  facing it. */
  private turnInPlace(yaw: number, dt: number): boolean {
    const d = wrap(yaw - this.yaw);
    if (Math.abs(d) < 0.02) {
      this.setYaw(yaw);
      this.turnW = 0;
      return true;
    }
    // ramp up, cruise, and brake to a stop on the target (constant deceleration)
    const want = Math.sign(d) * Math.min(TURN_RATE, Math.sqrt(2 * TURN_ACCEL * Math.abs(d)));
    this.turnW += THREE.MathUtils.clamp(want - this.turnW, -TURN_ACCEL * dt, TURN_ACCEL * dt);
    const step = this.turnW * dt;
    this.setYaw(this.yaw + (Math.sign(step) === Math.sign(d) ? Math.min(Math.abs(step), Math.abs(d)) * Math.sign(d) : step));
    return false;
  }

  /** Turn on the spot (Idle; the feet step round). Settles the feet before finishing (≤ 0.45 s). */
  private turnTo(yaw: () => number, opts: { locked?: boolean } = {}): Step {
    let target = 0;
    let settle = 0;
    return {
      name: 'turn',
      interruptible: !opts.locked,
      start: () => {
        target = yaw();
        settle = 0;
        if (this.instant) this.setYaw(target);
      },
      update: (dt) => {
        if (this.anim.current?.startsWith('Walk_')) this.toIdle('Idle_Loop');
        if (!this.turnInPlace(target, dt)) return false;
        settle += dt;
        return this.feet.settled || settle > 0.45;
      },
    };
  }

  /** Keep turning toward `yaw` (eased at `rate`, capped at TURN_RATE). */
  private turnToward(yaw: number, dt: number, rate: number) {
    const d = wrap(yaw - this.yaw) * (1 - Math.exp(-rate * dt));
    this.setYaw(this.yaw + THREE.MathUtils.clamp(d, -TURN_RATE * dt, TURN_RATE * dt));
  }

  /** Feet per frame: tracked while walking (stance), held and stepped while standing turns, stops or shuffles. */
  private updateFeet(dt: number) {
    const clip = this.anim.current ?? '';
    // (on their feet: also while still leaving a seat, e.g. stepping out from behind the desk)
    const standing = this.yOff === 0 && STANDING.test(clip);
    const shift = Math.hypot(this.group.position.x - this.feetPos.x, this.group.position.z - this.feetPos.z);
    // put somewhere else at once (spawn, room move, an instant plan): whatever the feet held is gone
    if (shift > 0.5) this.feet.reset();
    const moved = Math.abs(wrap(this.yaw - this.feetYaw)) > 1e-4 || shift > 1e-4;
    const stopped = this.wasWalking && !this.walking;
    // a new standing clip may stand differently: the feet step over instead of sliding there
    const changed = clip !== this.feetClip;
    this.feetClip = clip;
    this.feetYaw = this.yaw;
    this.feetPos.copy(this.group.position);
    this.wasWalking = this.walking;
    if (!standing || this.walking) this.feet.release();
    const hold = standing && !this.walking && (moved || stopped || changed);
    // a stop plants the feet where the last walking frame had them (this frame's crossfade has moved them already)
    if (hold && stopped) this.feet.engage(this.yaw);
    if (this.walking || hold || this.feet.active) this.feet.sample();
    if (hold) this.feet.engage(this.yaw);
    if (this.feet.active) this.feet.apply(dt, this.yaw);
  }

  private setYaw(y: number) {
    this.yaw = wrap(y);
    this.group.rotation.y = this.yaw;
  }

  private cameraYaw(): number {
    this.env.world.cameraPosition(_cam);
    return Math.atan2(_cam.x - this.group.position.x, _cam.z - this.group.position.z);
  }

  /** A stable open-floor spot in this person's room, spread around the room's spawn point per person. */
  private roomSpot(): THREE.Vector3 {
    const h = hashString(this.id);
    const a = ((h % 360) / 360) * Math.PI * 2;
    const r = 0.5 + ((h >>> 9) % 100) / 100;
    const p = this.env.world.spawnPoint();
    return this.env.world.snap(p.set(p.x + Math.cos(a) * r, 0, p.z + Math.sin(a) * r));
  }

  /** ~1.2 m from where they stand, toward the camera (open floor). */
  private stepOutPoint(): THREE.Vector3 {
    const base = this.seat ? this.seatStandPoint(this.seat) : this.group.position.clone();
    this.env.world.cameraPosition(_cam);
    _v.subVectors(_cam, base).setY(0).normalize();
    return this.env.world.snap(base.clone().addScaledVector(_v, 1.2));
  }

  private seatStandPoint(seat: Seat): THREE.Vector3 {
    const f = facingOf(seat.slot.yaw);
    return seat.slot.pos.clone().addScaledVector(f, this.sitDepth() - (seat.slot.sit?.slide ?? 0));
  }

  /** A point ~0.85 m from `other`, on our side, on walkable floor. */
  private besidePoint(other: THREE.Vector3): THREE.Vector3 {
    _v.subVectors(this.group.position, other).setY(0);
    if (_v.lengthSq() < 1e-4) _v.set(0, 0, 1);
    _v.normalize();
    return this.env.world.snap(other.clone().addScaledVector(_v, 0.85));
  }

  private settle() {
    this.settledAt = this.clock;
  }

  private between([a, b]: [number, number]): number {
    return a + (b - a) * this.rand();
  }

  // ── props ────────────────────────────────────────────────────────────────────────────────────
  private setProp(kind: PropKind) {
    if (this.prop === kind) return;
    for (const o of Object.values(this.props)) if (o) o.visible = false;
    this.prop = kind;
    if (!kind) return;
    let o = this.props[kind];
    if (!o) {
      o = this.makeProp(kind);
      this.props[kind] = o;
    }
    o.visible = true;
  }

  private makeProp(kind: Exclude<PropKind, null>): THREE.Object3D {
    const hand = this.ch.socket('hand_r');
    switch (kind) {
      case 'phone': {
        const p = makePhone();
        p.position.set(0.0, 0.09, 0.03);
        p.rotation.set(0, 0, 0);
        hand.add(p);
        return p;
      }
      case 'mug': {
        const m = makeMug();
        m.position.set(0.0, 0.08, 0.05);
        hand.add(m);
        return m;
      }
      case 'can': {
        const c = makeWateringCan();
        c.position.set(0, 0.08, 0.02);
        hand.add(c);
        return c;
      }
      case 'folder': {
        const f = makeFolder(VENDOR_COLORS[this.agent.vendor] ?? '#888');
        this.group.add(f);
        return f;
      }
      case 'vacuum': {
        this.vacuum = makeVacuum();
        this.group.add(this.vacuum.group);
        return this.vacuum.group;
      }
    }
  }

  /** How far the torso pokes through the back of `folder` (m, ≥ 0): skinned torso vertices inside its outline. */
  private chestThrough(folder: THREE.Object3D): number {
    folder.updateMatrixWorld(true);
    const inv = folder.matrixWorld.clone().invert(), v = new THREE.Vector3();
    let depth = 0;
    this.ch.model.traverse((o) => {
      const m = o as THREE.SkinnedMesh;
      if (!m.isSkinnedMesh) return;
      const pos = m.geometry.getAttribute('position'), si = m.geometry.getAttribute('skinIndex'), sw = m.geometry.getAttribute('skinWeight');
      if (!si || !sw) return;
      for (let i = 0; i < pos.count; i++) {
        // torso only (arms, head and hair are not what the folder rests against)
        let bone = 0, bw = -1;
        for (let k = 0; k < 4; k++) {
          const w = sw.getComponent(i, k);
          if (w > bw) { bw = w; bone = si.getComponent(i, k); }
        }
        if (!/^(spine|pelvis|clavicle)/.test(m.skeleton.bones[bone]?.name ?? '')) continue;
        m.getVertexPosition(i, v).applyMatrix4(m.matrixWorld).applyMatrix4(inv);
        // folder space: the cover is 0.31 × 0.23 (x / z), its back at y = −0.006
        if (Math.abs(v.x) < 0.16 && Math.abs(v.z) < 0.12 && v.y > -0.006 && v.y < 0.08) depth = Math.max(depth, v.y + 0.006);
      }
    });
    return depth;
  }

  private updateProps(dt: number) {
    if (this.holdFolderFor > 0) {
      this.holdFolderFor -= dt;
      if (!this.carry && this.prop !== 'folder') this.setProp('folder');
      if (this.holdFolderFor <= 0 && !this.carry) this.setProp(null);
    }
    // the folder is held to the chest (ArmOverlay.carry), except while handing it over (the hand reaches out)
    this.arms.carry.target = this.prop === 'folder' && this.anim.current !== 'Interact' ? 1 : 0;
    this.arms.carryOut += (Math.max(0, this.folderFit) - this.arms.carryOut) * Math.min(1, dt * 6);
    if (this.prop === 'folder' || this.prop === 'vacuum') {
      this.group.updateMatrixWorld(true);
      if (this.prop === 'folder') {
        // upright in the crook of the right forearm, front cover out, leaning back against the chest
        const hand = this.group.worldToLocal(this.ch.bone('hand_r').getWorldPosition(_b));
        const s = this.look.height;
        const f = this.props.folder!;
        f.position.set(hand.x - 0.075 * s, hand.y + 0.115 * s, hand.z - 0.035 * s);
        _m.makeBasis(_a.set(0, 1, 0), _b.set(0, 0, 1), _c.set(1, 0, 0));
        f.quaternion.setFromRotationMatrix(_m).premultiply(_q2.setFromAxisAngle(_a.set(1, 0, 0), -0.16));
        // a bulky chest pokes through it: once the arm is in place, measure by how much (once per body); the hand
        // and the folder are then held that much further out (ArmOverlay.carryOut)
        if (this.folderFit < 0 && this.arms.carry.weight > 0.95) {
          const d = this.chestThrough(f);
          this.folderFit = d > 0 ? d + 0.006 : 0;
        }
      } else if (this.vacuum) {
        const { head, stick, motor } = this.vacuum;
        const stroke = Math.sin(this.clock * 2.4);
        this.arms.holdTarget.set(-0.17, 0.9 * this.look.height, 0.36 + 0.09 * stroke);
        this.ch.bone('hand_r').getWorldPosition(_b);
        const top = this.group.worldToLocal(_b);
        head.position.set(-0.1, 0, top.z + 0.5 + 0.06 * stroke);
        head.rotation.y = 0.15 * stroke;
        const base = _w.set(head.position.x, 0.05, head.position.z - 0.02);
        const len = top.distanceTo(base);
        stick.position.copy(base);
        stick.scale.set(1, len, 1);
        _q.setFromUnitVectors(_v.set(0, 1, 0), _c.subVectors(top, base).normalize());
        stick.quaternion.copy(_q);
        motor.position.copy(base).lerp(top, 0.62);
        motor.quaternion.copy(_q);
      }
    }
  }
}
