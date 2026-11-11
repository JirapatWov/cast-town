// House view: a warm multi-storey dollhouse. The ground floor is the shared open-plan home (kitchen, living room,
// TV, front door, the workroom corner = job room 1A); every upper floor has a corridor, four job rooms furnished
// by job kind and the stairwell. One floor is on show at a time (cutaway); the storeys below stay up as the
// building's shell with glowing windows, the ones above are hidden. People live in their job's room.
import * as THREE from 'three';
import { MAX_FLOORS, STOREY_H, roomSlot } from '../../../shared/house-plan';
import type { AgentInfo, ApprovalRequest, GitSummary, Job, Project, RoomRef, Workflow, WorkflowRun } from '../../../shared/protocol';
import { VENDOR_COLORS } from '../../../shared/protocol';
import type { AppContext, HouseView } from '../core/types';
import { loadCharacterLibrary } from '../people/library';
import { PeopleManager } from '../people/manager';
import type { PeopleWorld } from '../people/types';
import { HouseCamera } from './camera';
import { vendorOf } from './corkboard';
import { Floor, type FloorHost, type RoomState } from './floors';
import type { PickTarget } from './furniture/kit';
import { CAMERA_HOME, FLOOR_OVERVIEW } from './layout';
import { buildLighting, type Lighting } from './lighting';
import { createPalette } from './materials';
import { HousePicker } from './picking';
import { declutterPlates } from './plates';
import { declutterTags } from './tag-layout';

/** Dev-only extras used by the harness (camera presets for screenshots, debug overlays). */
export interface HouseDev {
  orbit(azimuthDeg: number, elevationDeg: number, distance: number, target?: THREE.Vector3Like): void;
  showNav(on: boolean): void;
  info(): string;
  /** People manager (dev probes). */
  people(): unknown;
  /** Floors (dev probes). */
  floors(): Floor[];
  /** What a click at this screen point would hit (dev probes). */
  pickAt(x: number, y: number): unknown;
  /** Visible meshes counted by the names of their ancestors (draw-call hunting). */
  breakdown(depth?: number): [string, number][];
}

interface Built {
  floors: Floor[];
  people: PeopleManager;
  picker: HousePicker;
  lighting: Lighting;
  host: FloorHost;
}

const BUSY = new Set(['thinking', 'reading', 'writing', 'running', 'searching', 'delegating', 'handoff', 'listening']);

export function createHouseView(ctx: AppContext): HouseView & { dev: HouseDev } {
  const { engine, bus, store } = ctx;
  const scene = new THREE.Scene();
  scene.name = 'house';
  const cam = new HouseCamera(engine.canvas);
  let built: Built | null = null;
  let initPromise: Promise<void> | null = null;
  let project: Project | null = null;
  /** Project whose plan the upper floors were built for (kept across exit/enter of the same house). */
  let planFor: string | null = null;
  let jobs: Job[] = [];
  let agents: AgentInfo[] = [];
  let approvals: ApprovalRequest[] = [];
  let agentById = new Map<string, AgentInfo>();
  const boards = new Map<string, { run: WorkflowRun | null; wf: Workflow | null }>();
  const boardJob = new WeakMap<RoomState, string | null>();
  let shown = 0;
  let enteredAt = 0;
  let unFrame: (() => void) | null = null;
  let navDebug: THREE.Object3D | null = null;
  let time = 0;
  let declutterAt = 0;

  // ── people ↔ jobs ───────────────────────────────────────────────────────────────────────────
  function jobIdOf(a: AgentInfo): string {
    if (a.jobId) return a.jobId;
    const parent = a.parentId ? agentById.get(a.parentId) : undefined;
    return parent?.jobId || 'main';
  }

  function worldFor(agent: AgentInfo): PeopleWorld {
    const floors = built!.floors;
    const job = jobs.find((j) => j.id === jobIdOf(agent));
    if (job) {
      const f = floors[job.room.floor];
      if (f && f.rooms[job.room.slot]) return f.world(job.room.slot);
    }
    return floors[0].world(0);
  }

  function leadColor(job: Job): string {
    const lead = agents.find((a) => a.kind === 'resident' && jobIdOf(a) === job.id);
    return VENDOR_COLORS[lead?.vendor ?? vendorOf(job.leadModel)] ?? VENDOR_COLORS.other;
  }

  function jobStatus(job: Job): 'idle' | 'busy' | 'wait' {
    const inJob = agents.filter((a) => jobIdOf(a) === job.id);
    const ids = new Set(inJob.map((a) => a.id));
    // a lead waiting on a plan card is 'waiting_approval' too (the server says so; no ApprovalRequest behind it)
    if (approvals.some((ap) => ids.has(ap.agentId)) || inJob.some((a) => a.activity === 'waiting_approval')) return 'wait';
    return inJob.some((a) => a.status === 'busy' || BUSY.has(a.activity)) ? 'busy' : 'idle';
  }

  /** Push jobs to rooms (furniture, plates, boards). */
  function applyJobs() {
    if (!built || !project) return;
    const current = store.activeJob(project.id)?.id;
    for (const f of built.floors) {
      for (const room of f.rooms) {
        if (!room) continue;
        const job = jobs.find((j) => j.room.floor === f.index && j.room.slot === room.slot) ?? null;
        const color = job ? leadColor(job) : undefined;
        f.setRoom(room.slot, job, job ? { color, status: jobStatus(job), current: jobs.length > 1 && job.id === current } : {}, color ?? VENDOR_COLORS.anthropic);
        applyBoard(room);
      }
    }
  }

  function applyBoard(room: RoomState, force = false) {
    const id = room.job?.id ?? null;
    if (!force && boardJob.get(room) === id && room.board) return;
    boardJob.set(room, id);
    const b = id ? boards.get(id) : undefined;
    room.board?.set(b?.run ?? null, b?.wf ?? null);
  }

  // ── floors on show ──────────────────────────────────────────────────────────────────────────
  function setShown(floor: number) {
    if (!built) return;
    shown = floor;
    for (const f of built.floors) f.setState(f.index === floor ? 'shown' : f.index < floor ? 'below' : 'hidden');
    assignLamps();
    built.picker.clearHover();
  }

  function assignLamps() {
    if (!built) return;
    const f = built.floors[shown];
    if (f) built.lighting.lamps.assign(f.lamps(), f.base);
  }

  function settleWalls() {
    for (const f of built?.floors ?? []) f.settleWalls(cam.camera.position, cam.controls.target);
  }

  /** An orbit preset lifted to a floor: the entry pose (close: people read as people) or the whole-floor overview. */
  function pose(p: { target: THREE.Vector3Like; azimuthDeg: number; elevationDeg: number; distance: number }, base: number) {
    return { base, target: { x: p.target.x, y: p.target.y + base, z: p.target.z }, azimuthDeg: p.azimuthDeg, elevationDeg: p.elevationDeg, distance: p.distance * cam.fit };
  }

  /** The orbit that shows a whole floor (the elevator: every room of the storey in view). */
  const wholeFloor = (base: number) => pose(FLOOR_OVERVIEW, base);

  /** Recently entered (the curtain is still down): move the camera instantly. */
  const instant = () => performance.now() - enteredAt < 700;

  async function build() {
    const pal = createPalette(engine.assets);
    const libPromise = loadCharacterLibrary(engine.assets, () => engine.quality);
    const lighting = await buildLighting(scene, engine.renderer, engine.assets);
    const host: FloorHost = {
      pal,
      assets: engine.assets,
      cameraPosition: (out) => out.copy(cam.camera.position),
      roomClick: (room) => emitRoom(room),
      roomBuilt: (floor, room, evicted) => {
        if (!built) return;
        if (room) applyBoard(room, true);
        if (floor.index === shown) assignLamps();
        built.people.rehome(new Set(evicted));
      },
    };
    const ground = await Floor.ground(host);
    scene.add(ground.root);
    const floors = [ground];
    const people = new PeopleManager(await libPromise, {
      onClick: (agentId) => bus.emit('person:click', { agentId }),
      worldFor,
    });
    const picker = new HousePicker(engine, cam, {
      people: () => people.pickTargets(),
      props: () => (built?.floors ?? floors).filter((f) => f.state === 'shown').flatMap((f) => f.picks()),
      hoverPerson: (id) => people.setHover(id),
      hoverProp: (t) => {
        for (const f of built?.floors ?? floors) f.hoverRoom(t?.kind === 'room' && t.roomPart === 'floor' && t.room?.floor === f.index ? t.room.slot : null);
      },
      clickPerson: (agentId) => bus.emit('person:click', { agentId }),
      clickProp: (t) => clickProp(t),
    });
    scene.add(picker.tooltip);
    built = { floors, people, picker, lighting, host };
    setShown(0);
    settleWalls();
  }

  function emitRoom(room: RoomRef) {
    if (project) bus.emit('room:click', { projectId: project.id, floor: room.floor, slot: room.slot });
  }

  function clickProp(t: PickTarget) {
    if (!project) return;
    const projectId = project.id;
    if (t.kind === 'tv') bus.emit('tv:click', { projectId });
    else if (t.kind === 'board') {
      // a room's corkboard: select its job, then open the workflow panel
      if (t.room && jobs.some((j) => j.room.floor === t.room!.floor && j.room.slot === t.room!.slot)) emitRoom(t.room);
      bus.emit('board:click', { projectId });
    } else if (t.kind === 'door') bus.emit('door:click', { projectId });
    else if (t.kind === 'computer') bus.emit('computer:click', { projectId });
    else if (t.kind === 'room' && t.room) emitRoom(t.room);
  }

  /** Drop every upper floor (another house is coming in). */
  function resetPlan() {
    if (!built) return;
    while (built.floors.length > 1) built.floors.pop()!.dispose();
    jobs = [];
    boards.clear();
    const g = built.floors[0];
    g.setHasUpper(false);
    g.setRoom(0, null, {}, VENDOR_COLORS.anthropic);
    if (g.rooms[0]) applyBoard(g.rooms[0], true);
  }

  function frame(dt: number) {
    if (!built) return;
    time += dt;
    const canvas = engine.canvas;
    cam.setAspect(canvas.clientWidth / Math.max(1, canvas.clientHeight));
    cam.update();
    for (const f of built.floors) f.update(dt, time, cam.camera.position, cam.controls.target);
    built.people.update(dt);
    built.picker.update();
    const now = performance.now();
    if (now - declutterAt > 250) {
      declutterAt = now;
      const f = built.floors[shown];
      if (f) {
        f.occludePlates(cam.camera.position);
        declutterTags(engine.labelLayer); // people's tags first: the plates then make room for where they ended up
        declutterPlates(f.rooms.filter(Boolean).map((r) => r.plate), engine.labelLayer, now);
      }
    }
  }

  const view: HouseView = {
    scene,
    get camera() { return cam.camera; },
    get projectId() { return project?.id ?? null; },
    get floor() { return shown; },
    init() {
      initPromise ??= build();
      return initPromise;
    },
    async enter(p: Project) {
      await view.init();
      const b = built!;
      if (project && project.id !== p.id) b.people.reset(); // a different house: new residents
      if (planFor !== p.id) {
        b.people.reset();
        resetPlan();
        planFor = p.id;
      }
      project = p;
      b.floors[0].ground!.furnished.tv.setProject(p.name);
      setShown(0);
      cam.setAspect(engine.canvas.clientWidth / Math.max(1, engine.canvas.clientHeight));
      cam.setBase(0);
      cam.home();
      settleWalls();
      enteredAt = performance.now();
      cam.connect(engine.canvas);
      b.picker.connect();
      scene.userData.keepBackground = true; // the engine's indoor rig keeps our warm backdrop
      engine.setView(scene, cam.camera, 'indoor');
      b.lighting.adoptEngineRig(scene);
      unFrame?.();
      unFrame = engine.onFrame(frame);
    },
    exit() {
      cam.disconnect();
      built?.picker.disconnect();
      built?.people.reset();
      built?.floors[0].resetDoor();
      unFrame?.();
      unFrame = null;
      project = null;
    },
    syncPlan(p: Project, list: Job[]) {
      if (!built || !project || p.id !== project.id) return;
      project = p;
      const floors = built.floors;
      jobs = list.filter((j) => j.projectId === p.id);
      const n = THREE.MathUtils.clamp(Math.floor(p.floors || 1), 1, MAX_FLOORS);
      let changed = false;
      while (floors.length < n) {
        const f = Floor.upper(floors.length, built.host, false);
        f.setState('hidden');
        scene.add(f.root);
        floors.push(f);
        changed = true;
      }
      const removed = floors.length > n ? floors.splice(n) : [];
      floors.forEach((f, i) => f.setHasUpper(i < n - 1));
      applyJobs();
      // jobs may have moved rooms, floors may be gone: move people before tearing anything down
      built.people.rehome(new Set());
      for (const f of removed) f.dispose();
      if (removed.length) changed = true;
      if (shown >= n) void view.showFloor(n - 1);
      else if (changed) {
        setShown(shown);
        settleWalls();
      }
    },
    async showFloor(floor: number) {
      if (!built || !project) return;
      const f = THREE.MathUtils.clamp(Math.round(floor), 0, built.floors.length - 1);
      const was = shown;
      setShown(f);
      const now = instant();
      // the elevator shows the whole floor (also when asked to re-frame the floor already on show)
      await cam.flyTo({ ...wholeFloor(f * STOREY_H), ms: now ? 0 : was === f ? 450 : 750 });
      if (now) settleWalls();
      if (project) bus.emit('floor:changed', { projectId: project.id, floor: f });
    },
    async focusRoom(room: RoomRef) {
      if (!built || !project) return;
      const f = built.floors[room.floor];
      const def = roomSlot(room.floor, room.slot);
      if (!f || !def) return;
      const was = shown;
      if (was !== room.floor) setShown(room.floor);
      const r = def.rect;
      const mirror = room.floor > 0 && r.x0 >= 0;
      const small = r.x1 - r.x0 < 8;
      const now = instant();
      // The ground floor's job room is the open-plan home its people roam (sofa, kitchen…): back to the entry pose.
      const orbit = room.floor === 0
        ? pose(CAMERA_HOME, f.base)
        : {
            base: f.base,
            target: { x: (r.x0 + r.x1) / 2, y: f.base + 0.35, z: (r.z0 + r.z1) / 2 + 0.2 },
            azimuthDeg: mirror ? -24 : 24,
            elevationDeg: 52,
            distance: (small ? 11 : 12.5) * cam.fit,
          };
      await cam.flyTo({ ...orbit, ms: now ? 0 : 850 });
      if (now) settleWalls();
      if (was !== room.floor && project) bus.emit('floor:changed', { projectId: project.id, floor: room.floor });
    },
    syncAgents(list: AgentInfo[], aps: ApprovalRequest[]) {
      if (!built || !project) return;
      const pid = project.id;
      agents = list.filter((a) => a.projectId === pid);
      approvals = aps.filter((a) => a.projectId === pid);
      agentById = new Map(agents.map((a) => [a.id, a]));
      built.people.sync(agents, approvals);
      applyJobs(); // plates: status lights + lead colors
    },
    handoff(from: string, to: string, label: string) {
      built?.people.handoff(from, to, label);
    },
    say(agentId: string, text: string, ms?: number) {
      built?.people.say(agentId, text, ms);
    },
    setTV(summary: GitSummary | null) {
      built?.floors[0].ground?.furnished.tv.setSummary(summary);
    },
    setRunBoard(jobId: string, run: WorkflowRun | null, workflow: Workflow | null) {
      boards.set(jobId, { run, wf: workflow });
      for (const f of built?.floors ?? []) {
        for (const room of f.rooms) {
          if (room?.job?.id !== jobId) continue;
          boardJob.set(room, jobId);
          room.board?.set(run, workflow);
        }
      }
    },
  };

  const dev: HouseDev = {
    orbit(az, el, d, t) {
      const tt = t ?? { x: cam.controls.target.x, y: cam.controls.target.y, z: cam.controls.target.z };
      cam.orbit(az, el, d, tt);
      settleWalls();
    },
    showNav(on) {
      if (navDebug) { navDebug.removeFromParent(); navDebug = null; }
      const f = built?.floors[shown];
      if (on && f) { navDebug = f.nav.debugMesh(); f.root.add(navDebug); }
    },
    people() {
      return built?.people;
    },
    floors() {
      return built?.floors ?? [];
    },
    pickAt(x, y) {
      const h = built?.picker.pickAt(x, y);
      return h?.kind === 'prop' ? { kind: h.target.kind, label: h.target.label, room: h.target.room } : h ?? null;
    },
    breakdown(depth = 3) {
      const out = new Map<string, number>();
      scene.traverseVisible((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh || (m.material as THREE.Material).visible === false) return;
        const path: string[] = [];
        for (let p: THREE.Object3D | null = m; p && p !== scene; p = p.parent) if (p.name) path.push(p.name);
        const k = path.slice(0, depth).reverse().join('/') || '(unnamed)';
        out.set(k, (out.get(k) ?? 0) + 1);
      });
      return [...out].sort((a, b) => b[1] - a[1]).slice(0, 60);
    },
    info() {
      // count what the main pass draws (the composer's last pass resets renderer.info)
      let meshes = 0, tris = 0, skinned = 0;
      scene.traverseVisible((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh || !m.material || (m.material as THREE.Material).visible === false) return;
        const groups = Array.isArray(m.material) ? Math.max(1, m.geometry.groups.length) : 1;
        meshes += groups;
        if ((m as THREE.SkinnedMesh).isSkinnedMesh) skinned++;
        const idx = m.geometry.index;
        tris += ((idx ? idx.count : m.geometry.getAttribute('position').count) / 3) * ((m as THREE.InstancedMesh).count ?? 1);
      });
      const i = engine.renderer.info;
      return `floor ${shown + 1}/${built?.floors.length ?? 0} · draws≈${meshes} (skinned ${skinned}) · tris ${(tris / 1000).toFixed(0)}k · geoms ${i.memory.geometries} · tex ${i.memory.textures}`;
    },
  };
  return Object.assign(view, { dev });
}
