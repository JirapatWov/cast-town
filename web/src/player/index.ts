// The homeowner avatar: a light "you" in the house (and by its door / the car in the city). It follows what you do
// and never stands in the way of it: every UI action happens first, the avatar reacts afterwards.
//   click a person      → their chat opens (the UI) and you walk over and face them
//   open the terminal   → you sit down at a desk computer (the one you clicked, else the nearest free one)
//   click the floor     → you walk there (TV / board / an empty room: you walk up to it)
//   switch floors       → you arrive by the stairs; picking a job upstairs walks you into its room
//   arrow keys (+ WASD if enabled) while the 3D view has focus → walk
// The avatar is never pickable, residents get priority on desks and paths, and with reduced motion every move
// happens at once.
import * as THREE from 'three';
import type { Bus, CityView, Engine, HouseView, Store, ViewName } from '../core/types';
import type { HouseDev } from '../house';
import type { Slot } from '../people/types';
import { Avatar, type Ground } from './avatar';
import { createPlayerBody, reserveLook } from './character-api';
import { createCityHost } from './city-host';
import { createHouseHost, STAIRS } from './house-host';
import { Ripple } from './marker';
import { createPortraits } from './portraits';
import { playerPrefs, type PlayerPrefs } from './prefs';

export interface PlayerDeps {
  engine: Engine;
  bus: Bus;
  store: Store;
  house: HouseView & { dev: HouseDev };
  city: CityView;
}

export interface Player {
  /** Call right after house.enter(): the avatar walks in through the front door (or appears on the floor on show). */
  enterHouse(projectId: string, opts?: { walkIn?: boolean }): void;
  /** Call right after house.exit(). */
  exitHouse(): void;
  /** Call before the city camera swoops to a building's door: you walk up to it. */
  cityApproach(projectId: string): void;
  /** Call once the town is built and on show (first load): you stand by the parked car. */
  cityReady(): void;
  /** QA probes. */
  readonly dev: {
    avatar(): Avatar | null;
    state(): Record<string, unknown>;
    walkTo(x: number, z: number): void;
    /** Run the avatar's simulation forward without rendering (headless QA, where frames are slow). */
    advance(seconds: number): void;
  };
}

const CLICK_SLOP = 6;
const CLICK_MS = 650;
const WELCOME = new THREE.Vector3(-6.7, 0, 2.35); // just inside the front door, by the living room

export function createPlayer(deps: PlayerDeps): Player {
  const { engine, bus, store } = deps;
  const hh = createHouseHost(deps.house);
  const ch = createCityHost(deps.city, store);
  const canvas = engine.canvas;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const ripple = new Ripple(() => reduced.matches);

  let prefs: PlayerPrefs = playerPrefs.get();
  // residents who get their look from now on are given someone else's (looks stay with a resident all session)
  reserveLook(prefs.show ? prefs.look : null);
  let avatar: Avatar | null = null;
  let bodyLook = '';
  let building: Promise<Avatar | null> | null = null;

  /** Where the avatar lives now. */
  let place: { kind: 'house'; projectId: string; since: number } | { kind: 'city' } | null = null;
  /** Floor the avatar stands on (house). */
  let avFloor = 0;
  let view: ViewName = 'city';
  let lastHouseId: string | null = null;
  let cityPlaced = false;
  let doorHeld: { open(on: boolean): void } | null = null;
  let terminalOpen = false;
  let atTerminal = false;
  let lastComputer: { t: number; point: THREE.Vector3; floor: number } | null = null;
  let lastJob: { t: number; floor: number; slot: number } | null = null;
  let talkingTo: string | null = null;
  const spoken = new Set<string>();

  // ── avatar lifecycle ────────────────────────────────────────────────────────────────────────

  function ensureAvatar(): Promise<Avatar | null> {
    if (avatar && bodyLook === prefs.look) return Promise.resolve(avatar);
    building ??= (async () => {
      const look = prefs.look;
      try {
        const body = await createPlayerBody(engine.assets, look, () => engine.quality);
        if (avatar) avatar.setBody(body);
        else {
          avatar = new Avatar(body);
          avatar.onSeatTaken = onSeatTaken;
        }
        bodyLook = look;
        avatar.instantMode = reduced.matches;
        return avatar;
      } catch (e) {
        console.warn('[player] could not build the avatar', e);
        return null;
      } finally {
        building = null;
      }
    })();
    return building.then((a) => (a && bodyLook !== prefs.look ? ensureAvatar() : a));
  }

  function releaseDoor() {
    doorHeld?.open(false);
    doorHeld = null;
  }

  function hide() {
    releaseDoor();
    atTerminal = false;
    avatar?.detach();
  }

  // ── house ───────────────────────────────────────────────────────────────────────────────────

  const inHouse = () => place?.kind === 'house' && !!avatar?.ground && prefs.show;

  function houseGround(floor: number): Ground | null {
    return hh.ground(floor);
  }

  /** A good place to stand on a floor when appearing there without walking. */
  function defaultSpot(floor: number): THREE.Vector3 {
    const g = houseGround(floor)!;
    return g.snap(floor === 0 ? WELCOME.clone() : new THREE.Vector3(6.6, 0, -0.15));
  }

  function spawnInHouse(a: Avatar, walkIn: boolean) {
    const floor = hh.shownFloor();
    const g = houseGround(floor);
    if (!g) return;
    releaseDoor();
    avFloor = floor;
    const door = floor === 0 ? hh.frontDoor() : null;
    if (door && walkIn && !reduced.matches) {
      a.place(g, door.outside, Math.atan2(door.inside.x - door.outside.x, door.inside.z - door.outside.z));
      const spot = defaultSpot(0);
      a.traverse([door.inside.clone()], () => 0, () => a.walkSteps(spot, new THREE.Vector3(2, 0, -1.5)), {
        start: () => {
          door.open(true);
          doorHeld = door;
        },
        end: releaseDoor,
      });
    } else {
      // appear facing the camera a little, so you see yourself arrive
      const spot = defaultSpot(floor);
      const cam = g.cameraPosition(new THREE.Vector3());
      a.place(g, spot, Math.atan2(cam.x - spot.x, cam.z - spot.z));
    }
    a.setVisible(true);
    a.marker.flash(4);
  }

  function arriveOn(floor: number, from: number) {
    const a = avatar;
    const g = houseGround(floor);
    if (!a || !g) return;
    releaseDoor();
    atTerminal = false;
    avFloor = floor;
    const fresh = place?.kind === 'house' && performance.now() - place.since < 1500;
    const dest = arrivalTarget(floor);
    if (fresh || reduced.matches || from === floor) {
      a.place(g, dest ?? defaultSpot(floor));
      a.marker.flash(3);
      return;
    }
    const { laneX, footZ, topZ, landing, inLane, up, storey } = STAIRS;
    const then = () => a.walkSteps(dest ?? g.snap(floor === 0 ? new THREE.Vector3(6.4, 0, 4.6) : new THREE.Vector3(6.4, 0, -0.1)));
    if (from < floor) {
      // up the flight from the storey below: rise through the stairwell onto the landing
      a.place(g, new THREE.Vector3(laneX, 0, footZ), Math.PI);
      a.traverse([new THREE.Vector3(laneX, 0, topZ - 0.05), landing.clone()], (x, z) => (inLane(x) && z > topZ ? up(z) - storey : 0), then);
    } else {
      // down this floor's own flight from the storey above, then off it beside the foot
      a.place(g, new THREE.Vector3(laneX, 0, topZ + 0.05), 0);
      const off = floor === 0
        ? [new THREE.Vector3(7.35, 0, 5.45)]
        : [new THREE.Vector3(7.5, 0, 5.55), new THREE.Vector3(7.5, 0, 0.3), new THREE.Vector3(6.9, 0, -0.15)];
      a.traverse([new THREE.Vector3(laneX, 0, footZ), ...off], (x, z) => (inLane(x) ? (z <= topZ ? storey : up(z)) : 0), then);
    }
    a.marker.flash(3);
  }

  /** Picking a job upstairs walks you into its room. */
  function arrivalTarget(floor: number): THREE.Vector3 | null {
    if (!lastJob || performance.now() - lastJob.t > 2500 || lastJob.floor !== floor || floor === 0) return null;
    const spot = hh.roomSpot(floor, lastJob.slot);
    return spot ? houseGround(floor)!.snap(spot) : null;
  }

  function onSeatTaken(slot: Slot) {
    if (!atTerminal || !terminalOpen || !avatar) {
      atTerminal = false;
      return;
    }
    const next = pickComputer(null, slot);
    if (next) avatar.sitAt(next, { typing: true });
    else atTerminal = false;
  }

  /** A free desk computer on the floor: the one nearest the clicked point, else the nearest to you. */
  function pickComputer(near: THREE.Vector3 | null, exclude?: Slot): Slot | null {
    const a = avatar;
    if (!a) return null;
    const free = hh.computers(avFloor).filter((s) => !s.occupant && s !== exclude);
    if (!free.length) return null;
    const by = (p: THREE.Vector3) => (s: Slot) => s.pos.distanceToSquared(p);
    if (near) {
      const d = by(near);
      const close = free.filter((s) => d(s) < 2.4 * 2.4).sort((x, y) => d(x) - d(y));
      if (close[0]) return close[0];
    }
    const d = by(a.position);
    return free.sort((x, y) => d(x) - d(y))[0];
  }

  function goToComputer(near: THREE.Vector3 | null) {
    const a = avatar;
    if (!inHouse() || !a) return;
    if (atTerminal && a.seatSlot && !a.seatSlot.occupant) {
      a.setTyping(true);
      return;
    }
    const slot = pickComputer(near);
    if (slot) {
      atTerminal = true;
      a.sitAt(slot, { typing: true });
      return;
    }
    // every computer is in use: stand beside the one you clicked, looking at its screen
    const all = hh.computers(avFloor);
    const target = near ?? all[0]?.pos;
    if (!target) return;
    const g = houseGround(avFloor)!;
    a.walkTo(g.snap(target.clone().setY(0).add(new THREE.Vector3(0.7, 0, 0.5))), { face: target });
  }

  // ── pointer: click to walk (capture phase: runs before the house picker, never stops it) ───────

  let down: { x: number; y: number; t: number } | null = null;
  const pointers = new Set<number>();
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  const onDown = (e: PointerEvent) => {
    pointers.add(e.pointerId);
    if (pointers.size > 1) {
      down = null; // pinch / two-finger pan
      return;
    }
    if (e.button !== 0 || view !== 'house') return;
    down = { x: e.clientX, y: e.clientY, t: e.timeStamp };
    // let the 3D view take keyboard focus (arrow keys walk); clicks on it never type anywhere
    if (document.activeElement !== canvas) canvas.focus({ preventScroll: true });
  };
  const onUp = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    const d = down;
    down = null;
    if (!d || e.button !== 0 || !inHouse()) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > CLICK_SLOP || e.timeStamp - d.t > CLICK_MS) return;
    const hit = hh.pickAt(e.clientX, e.clientY);
    if (hit?.kind === 'person') return; // the bus brings person:click
    if (hit?.kind === 'prop' && hit.prop === 'door') return; // back to the city
    const p = floorPoint(e);
    if (!p) return;
    if (hit?.kind === 'prop' && hit.prop === 'computer') {
      lastComputer = { t: performance.now(), point: p.raw, floor: avFloor };
      return; // computer:click → the terminal opens → you sit down
    }
    const a = avatar!;
    talkingTo = null;
    atTerminal = false;
    if (hit?.kind === 'prop') {
      a.walkTo(p.snapped, { face: p.raw.clone().setY(0) });
      return;
    }
    a.walkTo(p.snapped);
    ripple.play(a.ground!.root, p.snapped);
  };
  const onCancel = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    down = null;
  };

  /** Where a click lands on the floor on show (floor-local): the first visible surface, pushed off walls. */
  function floorPoint(e: PointerEvent): { raw: THREE.Vector3; snapped: THREE.Vector3 } | null {
    const floor = hh.shownFloor();
    if (floor !== avFloor) return null;
    const root = hh.root(floor);
    const g = houseGround(floor);
    if (!root || !g) return null;
    const rect = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, hh.view.camera);
    const hits = raycaster.intersectObject(root, true);
    const people = g.root;
    for (const h of hits) {
      if (!usable(h.object, root, people)) continue;
      const local = root.worldToLocal(h.point.clone());
      if (h.face) {
        const n = h.face.normal.clone().transformDirection(h.object.matrixWorld);
        if (Math.abs(n.y) < 0.5) local.addScaledVector(n.setY(0).normalize(), 0.35);
      }
      if (Math.abs(local.x) > 11.8 || Math.abs(local.z) > 6.6) return null;
      const flatP = local.clone().setY(0);
      const snapped = g.snap(flatP);
      if (snapped.distanceTo(flatP) > 2.2) return null;
      return { raw: local, snapped };
    }
    return null;
  }

  function usable(o: THREE.Object3D, root: THREE.Object3D, people: THREE.Object3D): boolean {
    const mesh = o as THREE.Mesh;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      if (!m || m.visible === false) return false;
      if (m.transparent && m.opacity < 0.35) return false;
    }
    for (let x: THREE.Object3D | null = o; x && x !== root; x = x.parent) {
      if (!x.visible || x === people || x.userData.rltPlayer) return false;
    }
    return true;
  }

  // ── keyboard: arrows (and WASD when enabled) while the 3D view has focus ───────────────────────

  const held = new Set<string>();
  const KEYS: Record<string, [number, number]> = { ArrowUp: [0, 1], ArrowDown: [0, -1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
  const WASD: Record<string, [number, number]> = { KeyW: [0, 1], KeyS: [0, -1], KeyA: [-1, 0], KeyD: [1, 0] };
  const dirOf = (code: string) => KEYS[code] ?? (prefs.wasd ? WASD[code] : undefined);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey || document.activeElement !== canvas || !inHouse()) return;
    if (!dirOf(e.code)) return;
    held.add(e.code);
    // the key walks: keep it from the UI shortcuts (W workflow, A/D approvals) while the 3D view has focus
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (held.delete(e.code)) e.preventDefault();
  };
  const clearKeys = () => held.clear();

  const _f = new THREE.Vector3(), _r = new THREE.Vector3();
  function updateDrive() {
    const a = avatar;
    if (!a) return;
    if (document.activeElement !== canvas) held.clear();
    let fx = 0, fz = 0;
    for (const code of held) {
      const d = dirOf(code);
      if (!d) continue;
      fx += d[0];
      fz += d[1];
    }
    if (!fx && !fz) {
      a.drive.set(0, 0);
      return;
    }
    // camera-relative: up = away from the camera along the floor
    hh.view.camera.getWorldDirection(_f).setY(0).normalize();
    _r.set(-_f.z, 0, _f.x);
    const x = _f.x * fz + _r.x * fx, z = _f.z * fz + _r.z * fx;
    const len = Math.hypot(x, z) || 1;
    a.drive.set(x / len, z / len);
    talkingTo = null;
    atTerminal = false;
  }

  // ── per frame ───────────────────────────────────────────────────────────────────────────────

  function inScene(o: THREE.Object3D, scene: THREE.Object3D): boolean {
    for (let x: THREE.Object3D | null = o; x; x = x.parent) if (x === scene) return true;
    return false;
  }

  let unFrame: (() => void) | null = null;
  function frame(dt: number) {
    const a = avatar;
    ripple.tick(dt);
    if (!a || !a.ground || !prefs.show) return;
    a.instantMode = reduced.matches;
    if (place?.kind === 'house') {
      // the floor we stood on was taken down (fewer floors) or rebuilt: reappear on the floor on show
      if (avFloor >= hh.floorCount() || !inScene(a.group, hh.view.scene) || hh.ground(avFloor) !== a.ground) {
        const g = houseGround(hh.shownFloor());
        if (!g) return;
        avFloor = hh.shownFloor();
        a.place(g, defaultSpot(avFloor));
      }
      updateDrive();
      a.update(dt, hh.neighbours(avFloor, dt));
    } else if (place?.kind === 'city') {
      a.drive.set(0, 0);
      a.update(dt, []);
    }
  }

  function connect() {
    unFrame ??= engine.onFrame(frame);
  }

  // focusable by click only (arrow keys walk), never by Tab; no focus ring around the whole 3D view
  canvas.tabIndex = canvas.tabIndex >= 0 ? canvas.tabIndex : -1;
  canvas.style.outline = 'none';
  canvas.addEventListener('pointerdown', onDown, { capture: true });
  canvas.addEventListener('pointerup', onUp, { capture: true });
  canvas.addEventListener('pointercancel', onCancel, { capture: true });
  window.addEventListener('keydown', onKeyDown, { capture: true });
  window.addEventListener('keyup', onKeyUp, { capture: true });
  window.addEventListener('blur', clearKeys);
  reduced.addEventListener?.('change', () => {
    if (avatar) avatar.instantMode = reduced.matches;
  });

  // ── city ────────────────────────────────────────────────────────────────────────────────────

  function cityPlace(kind: 'door' | 'car', projectId?: string | null) {
    if (!prefs.show) return;
    void ensureAvatar().then((a) => {
      if (!a || view !== 'city' || ch.driving() || place?.kind === 'house') return;
      if (kind === 'door' && projectId) {
        const d = ch.door(projectId);
        if (d) {
          // on the garden path just out of the door (paths are ~1.2 m wide: stay on them, not in the beds)
          const pos = d.door.clone().addScaledVector(d.facing, 1.7);
          a.place(ch.ground(d.door.y), pos.setY(0), Math.atan2(d.facing.x, d.facing.z) - 0.5);
          finishCity(a);
          return;
        }
      }
      const car = ch.car();
      const left = new THREE.Vector3(car.forward.z, 0, -car.forward.x);
      const pos = car.pos.clone().addScaledVector(left, 1.45).addScaledVector(car.forward, -0.4);
      a.place(ch.ground(0), pos, Math.atan2(left.x + car.forward.x * 0.6, left.z + car.forward.z * 0.6));
      finishCity(a);
    });
  }

  function finishCity(a: Avatar) {
    place = { kind: 'city' };
    cityPlaced = true;
    a.setVisible(true);
    a.marker.flash(4);
    connect();
  }

  bus.on('view:changed', ({ view: v }) => {
    const prev = view;
    view = v;
    if (v === 'drive') {
      if (place?.kind === 'city') hide();
      place = null;
    } else if (v === 'city' && place?.kind !== 'house') {
      if (prev === 'house' && lastHouseId) cityPlace('door', lastHouseId);
      else if (prev === 'drive' || !cityPlaced) cityPlace('car');
    }
  });

  // ── bus + store ─────────────────────────────────────────────────────────────────────────────

  bus.on('person:click', ({ agentId }) => {
    const a = avatar;
    if (!inHouse() || !a || !hh.personAt(agentId, avFloor)) return;
    talkingTo = agentId;
    atTerminal = false;
    a.approach(() => hh.personAt(agentId, avFloor), { talk: 2.2 });
  });

  bus.on('computer:click', () => {
    const c = lastComputer && performance.now() - lastComputer.t < 1500 && lastComputer.floor === avFloor ? lastComputer.point : null;
    lastComputer = null;
    goToComputer(c);
  });

  bus.on('job:select', ({ projectId, jobId }) => {
    const job = store.job(projectId, jobId);
    if (!job || place?.kind !== 'house' || place.projectId !== projectId) return;
    lastJob = { t: performance.now(), floor: job.room.floor, slot: job.room.slot };
    // same floor: walk over to the room (the floor-change path handles the stairs)
    const a = avatar;
    if (!a || !inHouse() || job.room.floor !== avFloor || job.room.floor === 0 || atTerminal) return;
    const spot = arrivalTarget(avFloor);
    if (spot && spot.distanceTo(a.position) > 2.5) a.walkTo(spot);
  });

  bus.on('floor:changed', ({ projectId, floor }) => {
    if (place?.kind !== 'house' || place.projectId !== projectId || !inHouse()) return;
    if (floor !== avFloor) arriveOn(floor, avFloor);
  });

  // the terminal dock: open → sit at a computer and type, closed → stand up
  const watchTerminal = () => {
    const root = document.querySelector('.rlt-ui');
    if (!root) return false;
    const read = () => {
      const open = root.classList.contains('has-term');
      if (open === terminalOpen) return;
      terminalOpen = open;
      if (open) {
        // a click on a computer already sent us there (computer:click comes first)
        if (!atTerminal) goToComputer(null);
      } else if (atTerminal) {
        atTerminal = false;
        avatar?.standUp();
      }
    };
    new MutationObserver(read).observe(root, { attributes: true, attributeFilter: ['class'] });
    read();
    return true;
  };
  if (!watchTerminal()) requestAnimationFrame(function retry() {
    if (!watchTerminal()) requestAnimationFrame(retry);
  });

  // saying something to the person you are facing: you talk with your hands for a moment
  store.subscribe((_s, msg) => {
    if (!msg) return;
    if (msg.t === 'transcript_reset') for (const it of msg.items) spoken.add(it.id);
    if (msg.t !== 'transcript_upsert' || msg.item.kind !== 'user' || spoken.has(msg.item.id)) return;
    spoken.add(msg.item.id);
    const a = avatar;
    if (!a || !inHouse() || msg.agentId !== talkingTo) return;
    const p = hh.personAt(msg.agentId, avFloor);
    if (p && p.distanceTo(a.position) < 2.6) a.talk(2.8);
  });

  playerPrefs.subscribe((next, prev) => {
    prefs = next;
    reserveLook(next.show ? next.look : null);
    if (next.show !== prev.show) {
      if (!next.show) hide();
      else if (place?.kind === 'house') void ensureAvatar().then((a) => a && place?.kind === 'house' && spawnInHouse(a, false));
      else if (view === 'city') cityPlace(lastHouseId ? 'door' : 'car', lastHouseId);
    }
    if (next.look !== prev.look && avatar) void ensureAvatar();
  });

  playerPrefs.setPortraitProvider(createPortraits(engine));

  return {
    enterHouse(projectId, opts = {}) {
      releaseDoor();
      avatar?.detach();
      place = { kind: 'house', projectId, since: performance.now() };
      lastHouseId = projectId;
      atTerminal = false;
      talkingTo = null;
      connect();
      if (!prefs.show) return;
      const walkIn = opts.walkIn ?? false;
      void ensureAvatar().then((a) => {
        if (!a || place?.kind !== 'house' || place.projectId !== projectId || a.ground) return;
        spawnInHouse(a, walkIn && performance.now() - place.since < 2500);
      });
    },
    exitHouse() {
      if (place?.kind === 'house') {
        hide();
        place = null;
      }
    },
    cityApproach(projectId) {
      const a = avatar;
      if (!prefs.show || !a || place?.kind !== 'city' || reduced.matches) return;
      const d = ch.door(projectId);
      if (!d) return;
      const toward = Math.atan2(-d.facing.x, -d.facing.z);
      const from = d.door.clone().addScaledVector(d.facing, 3.6).setY(0);
      if (a.position.distanceTo(from) > 8) a.place(ch.ground(d.door.y), from, toward);
      a.traverse([d.door.clone().addScaledVector(d.facing, 0.35).setY(0)], () => d.door.y);
    },
    cityReady() {
      if (view === 'city' && !place && !cityPlaced) cityPlace('car');
    },
    dev: {
      avatar: () => avatar,
      state: () => ({
        place: place?.kind ?? null,
        floor: avFloor,
        step: avatar?.stepName ?? null,
        seated: avatar?.seated ?? false,
        atTerminal,
        terminalOpen,
        pos: avatar ? avatar.position.toArray().map((v) => +v.toFixed(2)) : null,
        look: bodyLook,
        show: prefs.show,
      }),
      walkTo(x, z) {
        const g = avatar?.ground;
        if (g && avatar) avatar.walkTo(g.snap(new THREE.Vector3(x, 0, z)));
      },
      advance(seconds) {
        for (let t = 0; t < seconds; t += 1 / 30) frame(1 / 30);
      },
    },
  };
}
