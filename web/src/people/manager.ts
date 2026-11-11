// People manager: reconciles the project's agents with 3D people (spawn / retarget / leave via the door or the
// stairs), routes say() and handoff(), and exposes pick proxies for the house view. Each person lives in the
// world of their job's room (its floor, nav grid and stations); `worldFor` resolves it from the agent.
// Looks are picked so nobody in the house shares an avatar while others are free (residents first, helpers
// lean casual); a person appears once their avatar has loaded. People on hidden floors, or outside the view
// frustum, update at ~10 Hz (their mixers and walks catch up in one step when they come back into view).
import * as THREE from 'three';
import type { Activity, AgentInfo, ApprovalRequest } from '../../../shared/protocol';
import { lookForAgent, type Look } from './appearance';
import type { CharacterLibrary } from './library';
import { Person } from './person';
import type { PeopleWorld } from './types';

export interface PeopleOptions {
  onClick(agentId: string): void;
  /** The world (floor + room) this agent lives in. */
  worldFor(agent: AgentInfo): PeopleWorld;
}

const HIDDEN_STEP = 0.1;

/** Avatars nobody in a house should be given (the homeowner's look): residents pick around them. */
const reserved = new Set<string>();
export function reserveAvatars(ids: Iterable<string>) {
  reserved.clear();
  for (const id of ids) reserved.add(id);
}

/** The camera the people were last drawn with (captured from the bodies' onBeforeRender; shadow passes use
 *  onBeforeShadow, so this is the view camera). Used to throttle people outside the view. */
let viewCamera: THREE.Camera | null = null;
const _frustum = new THREE.Frustum();
const _m = new THREE.Matrix4();
const _sphere = new THREE.Sphere();

export class PeopleManager {
  readonly people = new Map<string, Person>();
  private leaving = new Set<Person>();
  private synced = false;
  private hovered: Person | null = null;
  private agents = new Map<string, AgentInfo>();
  /** Looks stay with an agent for the app's lifetime (same person on every visit). */
  private looks = new Map<string, Look>();
  /** Agents present at the first sync after a reset: placed directly even if their avatar arrives later. */
  private initial = new Set<string>();
  private last: { agents: AgentInfo[]; approvals: ApprovalRequest[] } | null = null;
  private generation = 0;
  private waiting = new Set<string>();
  private lag = new Map<Person, number>();

  constructor(
    private lib: CharacterLibrary,
    private opts: PeopleOptions,
  ) {}

  /** Reconcile with the current agent list. The first sync after `reset()` places everyone directly. */
  sync(agents: AgentInfo[], approvals: ApprovalRequest[]) {
    this.last = { agents, approvals };
    const waiting = new Set(approvals.map((a) => a.agentId));
    const seen = new Set<string>();
    if (!this.synced) for (const a of agents) this.initial.add(a.id);
    // residents and roles pick their avatars before helpers
    const ordered = [...agents].sort((a, b) => Number(a.kind === 'subagent') - Number(b.kind === 'subagent'));
    for (const agent of ordered) {
      seen.add(agent.id);
      this.agents.set(agent.id, agent);
      const activity: Activity = waiting.has(agent.id) ? 'waiting_approval' : agent.activity;
      const world = this.opts.worldFor(agent);
      let p = this.people.get(agent.id);
      if (!p) {
        const look = this.lookFor(agent);
        if (!this.lib.peek(look)) {
          this.whenLoaded(agent.id, look);
          continue;
        }
        p = new Person(agent, this.lib, {
          world,
          find: (id) => this.people.get(id),
          onClick: (id) => this.opts.onClick(id),
        }, look);
        this.people.set(agent.id, p);
        world.root.add(p.group);
        p.ch.body.onBeforeRender = (_r, _s, cam) => {
          if ((cam as THREE.PerspectiveCamera).isPerspectiveCamera) viewCamera = cam;
        };
        if (this.initial.has(agent.id) || agent.kind !== 'subagent') p.spawnAt(world.snap(world.spawnPoint()));
        else p.spawnAtDoor();
      } else if (p.world !== world) {
        p.relocate(world);
      }
      p.setAgent(agent, activity);
    }
    for (const [id, p] of this.people) {
      if (seen.has(id)) continue;
      this.people.delete(id);
      this.agents.delete(id);
      this.lag.delete(p);
      if (this.synced) {
        p.leave();
        this.leaving.add(p);
      } else {
        p.dispose();
      }
    }
    for (const id of this.agents.keys()) if (!seen.has(id)) this.agents.delete(id);
    this.synced = true;
  }

  private lookFor(agent: AgentInfo): Look {
    let look = this.looks.get(agent.id);
    if (!look) {
      const avoid = new Set<string>(reserved);
      for (const p of this.people.values()) if (p.look.avatar) avoid.add(p.look.avatar);
      for (const id of this.waiting) {
        const a = this.looks.get(id)?.avatar;
        if (a) avoid.add(a);
      }
      look = lookForAgent(agent, { avoid });
      this.looks.set(agent.id, look);
    }
    return look;
  }

  private whenLoaded(agentId: string, look: Look) {
    if (this.waiting.has(agentId)) return;
    this.waiting.add(agentId);
    const gen = this.generation;
    void this.lib.load(look).then(
      () => {
        this.waiting.delete(agentId);
        if (gen === this.generation && this.last) this.sync(this.last.agents, this.last.approvals);
      },
      (err) => console.error(`[people] no body at all for ${agentId} (fallback failed too)`, err),
    );
  }

  /** Worlds changed (rooms refurnished, jobs moved, floors added): move people whose world is different, and
   *  let everyone whose station disappeared settle again. */
  rehome(evicted: Set<string>) {
    for (const [id, p] of this.people) {
      const agent = this.agents.get(id);
      if (!agent) continue;
      const world = this.opts.worldFor(agent);
      if (p.world !== world) p.relocate(world);
      else if (evicted.has(id)) p.replanNow();
    }
  }

  say(agentId: string, text: string, ms?: number) {
    this.people.get(agentId)?.say(text, ms);
  }

  handoff(fromId: string, toId: string, label: string) {
    this.people.get(fromId)?.handoff(toId, label);
  }

  update(dt: number) {
    const cam = viewCamera;
    if (cam) _frustum.setFromProjectionMatrix(_m.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    this.frustumOk = !!cam;
    for (const p of this.people.values()) this.step(p, dt);
    for (const p of this.leaving) {
      this.step(p, dt);
      if (p.gone) {
        p.dispose();
        this.leaving.delete(p);
        this.lag.delete(p);
      }
    }
  }

  private frustumOk = false;

  /** Inside the last view frustum (generous sphere: tags, raised arms, a step of walking). */
  private onScreen(p: Person): boolean {
    if (!this.frustumOk) return true;
    p.group.getWorldPosition(_sphere.center);
    _sphere.center.y += 0.9;
    _sphere.radius = 1.6;
    return _frustum.intersectsSphere(_sphere);
  }

  /** Full rate when shown and in view; people on hidden floors or off-screen keep living (plans, walks) at
   *  ~10 Hz. */
  private step(p: Person, dt: number) {
    if (p.world.root.visible && this.onScreen(p)) {
      const owed = this.lag.get(p);
      if (owed) this.lag.delete(p);
      p.update(dt + (owed ?? 0));
      return;
    }
    const acc = (this.lag.get(p) ?? 0) + dt;
    if (acc < HIDDEN_STEP) {
      this.lag.set(p, acc);
      return;
    }
    this.lag.delete(p);
    p.update(Math.min(acc, 0.5));
  }

  /** Invisible capsules used for picking people (only people on shown floors). */
  pickTargets(): THREE.Object3D[] {
    const out: THREE.Object3D[] = [];
    for (const p of this.people.values()) if (p.world.root.visible) out.push(p.proxy);
    return out;
  }

  /** Agent ids per world root (status dots on room plates and floor buttons). */
  all(): Person[] {
    return [...this.people.values()];
  }

  setHover(agentId: string | null) {
    const p = agentId ? this.people.get(agentId) ?? null : null;
    if (p === this.hovered) return;
    if (this.hovered) this.hovered.hover = false;
    this.hovered = p;
    if (p) p.hover = true;
  }

  /** Remove everyone (house exit). The next sync places people directly again. */
  reset() {
    for (const p of this.people.values()) p.dispose();
    for (const p of this.leaving) p.dispose();
    this.people.clear();
    this.leaving.clear();
    this.agents.clear();
    this.lag.clear();
    this.initial.clear();
    this.waiting.clear();
    this.last = null;
    this.generation++;
    this.hovered = null;
    this.synced = false;
  }
}
