// The city view: builds the static town once, keeps project buildings in sync with the store, and owns the
// city camera, hover/click picking, placement mode and the drivable car.
//
// Bus events emitted: building:click, building:hover, lot:click, landmark:click, nav:city (Esc / exit while driving).
// Bus events consumed: placement:start / placement:end (same as calling setPlacementMode).
import * as THREE from 'three';
import { frontOf, LANDMARKS, LOTS } from '../../../shared/city-layout';
import { MAX_FLOORS } from '../../../shared/house-plan';
import type { AgentInfo, ApprovalRequest, CityState, Job, Lot, Project } from '../../../shared/protocol';
import type { AppContext, CityView } from '../core/types';
import { afterTownShown } from '../core/town-shown';
import { createNightLamps, type NightLamps } from '../engine/night-lamps';
import { type AgencyResult, buildAgency } from './buildings/agency';
import { buildAmbient } from './buildings/ambient';
import { type BuildOptions, ProjectBuilding } from './buildings/project';
import { CityCameraRig } from './camera-rig';
import { buildRoadDecals } from './decals';
import { DecorFade } from './decor-fade';
import { Driver, type DriveTarget } from './drive';
import { framePose, type FramePose } from './framing';
import { FLOOR_SLOTS } from './glass';
import { GrassField } from './grass';
import { GroundMap } from './ground';
import { BuildingTag, injectCityCss, type TagState } from './labels';
import { type Footprint, LAWN_Y, lotToWorld } from './layout';
import { LotMarkers } from './lots';
import { type CityMaterials, createCityMaterials } from './materials';
import { buildPark } from './park';
import { planTown } from './planting';
import { buildRoads } from './roads';
import { buildStreetProps, type StreetProps } from './street-props';
import { buildParkedCars, type ParkedCars } from './parked-cars';
import { TreeSystem } from './trees';
import { Batch } from './util/mesh-writer';
import { rng } from './util/random';
import { Vegetation } from './vegetation';

type PickKind = 'building' | 'lot' | 'landmark';
interface PickHit {
  kind: PickKind;
  id: string;
}

const HOME_POSE = { target: new THREE.Vector3(-10, 0, 5), radius: 230, phi: 1.0, theta: 0.5 };

const VERB: Partial<Record<AgentInfo['activity'], string>> = {
  listening: 'listening', thinking: 'thinking', reading: 'reading', writing: 'writing', running: 'running commands',
  searching: 'searching the web', delegating: 'delegating', waiting_approval: 'waiting for you', error: 'hit an error',
};

function clip(s: string, n = 44): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/** Status of a project from its agents and pending approvals. */
export function projectActivity(projectId: string, agents: Record<string, AgentInfo>, approvals: Record<string, ApprovalRequest>): { state: TagState; meta: string } {
  const list = Object.values(agents).filter((a) => a.projectId === projectId);
  const pending = Object.values(approvals).filter((a) => a.projectId === projectId);
  const waiting = list.filter((a) => a.activity === 'waiting_approval');
  if (pending.length || waiting.length) {
    const who = agents[pending[0]?.agentId ?? '']?.name ?? waiting[0]?.name ?? 'Someone';
    const what = pending[0]?.title ?? 'waiting for approval';
    return { state: 'approval', meta: clip(`${who} · ${what}`) };
  }
  const busy = list.filter((a) => a.status === 'busy' || a.status === 'starting');
  if (busy.length) {
    const a = busy[0];
    const doing = a.detail ?? VERB[a.activity] ?? 'working';
    return { state: 'busy', meta: clip(busy.length === 1 ? `${a.name} · ${doing}` : `${busy.length} working · ${a.name} ${VERB[a.activity] ?? 'busy'}`) };
  }
  const err = list.find((a) => a.status === 'error');
  if (err) return { state: 'error', meta: clip(`${err.name} hit an error`) };
  return { state: 'idle', meta: list.length ? `${list.length} resident${list.length > 1 ? 's' : ''} · idle` : 'Quiet' };
}

const STATE_RANK: Record<TagState, number> = { idle: 0, error: 1, busy: 2, approval: 3 };

/** Storeys of a project's building (servers from before floors existed send none). */
export function floorsOf(p: Project): number {
  const n = Math.round(Number(p.floors) || 1);
  return Math.max(1, Math.min(MAX_FLOORS, n));
}

/**
 * Status per storey from the jobs' rooms: a floor is busy when someone of a job on it works, 'approval' when one
 * of them waits for the user. null when the project's jobs aren't known (the whole building then shares one state).
 */
export function floorActivity(
  projectId: string, floors: number, agents: Record<string, AgentInfo>, approvals: Record<string, ApprovalRequest>, jobs: Job[] | undefined,
): TagState[] | null {
  if (!jobs?.length) return null;
  const floorOf = new Map(jobs.map((j) => [j.id, j.room?.floor ?? 0]));
  const out: TagState[] = new Array(floors).fill('idle');
  const bump = (f: number, s: TagState) => {
    const i = Math.max(0, Math.min(floors - 1, f));
    if (STATE_RANK[s] > STATE_RANK[out[i]]) out[i] = s;
  };
  const asking = new Set(Object.values(approvals).filter((a) => a.projectId === projectId).map((a) => a.agentId));
  for (const a of Object.values(agents)) {
    if (a.projectId !== projectId) continue;
    const f = floorOf.get(a.jobId) ?? 0;
    if (asking.has(a.id) || a.activity === 'waiting_approval') bump(f, 'approval');
    else if (a.status === 'busy' || a.status === 'starting') bump(f, 'busy');
    else if (a.status === 'error') bump(f, 'error');
  }
  return out;
}

export function createCityView(ctx: AppContext): CityView {
  const { engine, bus } = ctx;
  injectCityCss();
  const scene = new THREE.Scene();
  scene.name = 'city';
  const camera = new THREE.PerspectiveCamera(38, 16 / 9, 0.5, 3500);
  const rig = new CityCameraRig(camera, engine.canvas);

  let mats: CityMaterials | null = null;
  let ready = false;
  let active = false;
  let carRequested = false;
  let placement = false;
  let pending: [CityState, Record<string, AgentInfo>, Record<string, ApprovalRequest>] | null = null;
  let unFrame: (() => void) | null = null;
  let approached: string | null = null;
  let instant = false;

  const buildings = new Map<string, ProjectBuilding>();
  let last: { agents: Record<string, AgentInfo>; approvals: Record<string, ApprovalRequest> } | null = null;
  const projectsById = new Map<string, Project>();
  const projectsLayer = new THREE.Group();
  projectsLayer.name = 'projects';
  scene.add(projectsLayer);
  let lots: LotMarkers | null = null;
  let agency: AgencyResult | null = null;
  let agencyTag: BuildingTag | null = null;
  let agencyPick: THREE.Mesh | null = null;
  let ambientFootprints: Footprint[] = [];
  /** Decor buildings that hide a house from the camera turn see-through (finding #63). */
  let decorFade: DecorFade | null = null;
  const houseTargets: THREE.Vector3[] = [];
  let parked: ParkedCars | null = null;
  let streetProps: StreetProps | null = null;
  let trees: TreeSystem | null = null;
  const plantRnd = rng(3131);
  // time of day: 0 = day … 1 = night (engine.onTimeOfDay); signs keep their daytime emissive level here
  let night = 0;
  const signs: { mat: THREE.MeshStandardMaterial; day: number; night: number }[] = [];
  let lampPositions: THREE.Vector3Like[] = [];
  // ground map (lawn mask + occlusion) is re-rendered a moment after the town changes
  let groundMap: GroundMap | null = null;
  let groundRoots: THREE.Object3D[] = [];
  let groundDirty = -1;
  let grass: GrassField | null = null;
  const lowNoCast: THREE.Mesh[] = [];
  let castQuality: string | null = null;
  let nightLamps: NightLamps | null = null;
  let litSince = 1;
  const circles: { x: number; z: number; r: number }[] = [];
  const agencyLm = LANDMARKS.find((l) => l.id === 'agency')!;
  const parkLm = LANDMARKS.find((l) => l.id === 'park')!;

  const emitClick = (hit: PickHit) => {
    if (hit.kind === 'building') bus.emit('building:click', { projectId: hit.id });
    else if (hit.kind === 'lot') bus.emit('lot:click', { lotId: hit.id });
    else bus.emit('landmark:click', { landmarkId: hit.id });
  };

  // ───────────── driving ─────────────
  const driver = new Driver(scene, camera, engine.assets, {
    footprints: () => {
      const out = ambientFootprints.slice();
      if (parked) out.push(...parked.footprints);
      if (agency) out.push(agency.footprint);
      for (const b of buildings.values()) out.push(b.footprint);
      return out;
    },
    circles,
    targets: () => {
      const out: DriveTarget[] = [];
      for (const [id, b] of buildings) {
        const lot = LOTS.find((l) => l.id === b.lotId);
        if (!lot) continue;
        const p = frontOf(lot, 3);
        out.push({ kind: 'building', id, label: `Enter ${projectsById.get(id)?.name ?? 'project'}`, x: p.x, z: p.z });
      }
      for (const lot of lots?.lots() ?? []) {
        const p = frontOf(lot, 3);
        out.push({ kind: 'lot', id: lot.id, label: 'For sale · place a project here', x: p.x, z: p.z });
      }
      const a = frontOf(agencyLm, 3);
      out.push({ kind: 'landmark', id: 'agency', label: 'Visit the Talent Agency', x: a.x, z: a.z });
      return out;
    },
    use: (t) => emitClick({ kind: t.kind, id: t.id }),
    exit: () => {
      view.stopDriving();
      bus.emit('nav:city', {});
    },
  }, engine.labelLayer);

  // ───────────── picking / hover ─────────────
  let hovered: PickHit | null = null;
  let lastMove: PointerEvent | null = null;
  let down: { x: number; y: number; t: number } | null = null;

  const pickables = (): THREE.Object3D[] => {
    const out: THREE.Object3D[] = [];
    if (!placement) for (const b of buildings.values()) out.push(b.pick);
    if (lots) out.push(...lots.pickables);
    if (agencyPick && !placement) out.push(agencyPick);
    return out;
  };

  const pickAt = (ev: { clientX: number; clientY: number }): PickHit | null => {
    const hit = engine.pick(ev, camera, pickables());
    const ud = hit?.object.userData as Partial<PickHit> | undefined;
    return ud?.kind && ud.id ? { kind: ud.kind, id: ud.id } : null;
  };

  const setHovered = (h: PickHit | null) => {
    const same = h?.kind === hovered?.kind && h?.id === hovered?.id;
    if (same) return;
    const prevBuilding = hovered?.kind === 'building' ? hovered.id : null;
    if (hovered?.kind === 'building') buildings.get(hovered.id)?.setHover(false);
    if (hovered?.kind === 'lot') lots?.setHover(null);
    if (hovered?.kind === 'landmark') agencyTag?.setHover(false);
    hovered = h;
    if (h?.kind === 'building') buildings.get(h.id)?.setHover(true);
    if (h?.kind === 'lot') lots?.setHover(h.id);
    if (h?.kind === 'landmark') agencyTag?.setHover(true);
    engine.canvas.style.cursor = h ? 'pointer' : '';
    const nextBuilding = h?.kind === 'building' ? h.id : null;
    if (prevBuilding !== nextBuilding) bus.emit('building:hover', { projectId: nextBuilding });
  };

  const onPointerMove = (e: PointerEvent) => {
    lastMove = e;
  };
  const onPointerLeave = () => {
    lastMove = null;
    setHovered(null);
  };
  const onPointerDown = (e: PointerEvent) => {
    if (e.button === 0) down = { x: e.clientX, y: e.clientY, t: performance.now() };
  };
  const onPointerUp = (e: PointerEvent) => {
    const d = down;
    down = null;
    if (!d || e.button !== 0 || driver.driving || rig.busy) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6 || performance.now() - d.t > 600) return;
    const hit = pickAt(e);
    if (hit) emitClick(hit);
  };
  const listen = (on: boolean) => {
    const c = engine.canvas;
    const f = on ? c.addEventListener.bind(c) : c.removeEventListener.bind(c);
    f('pointermove', onPointerMove as EventListener);
    f('pointerleave', onPointerLeave as EventListener);
    f('pointerdown', onPointerDown as EventListener);
    f('pointerup', onPointerUp as EventListener);
  };

  // ───────────── frame loop ─────────────
  const frame = (dt: number, t: number) => {
    if (driver.driving) driver.update(dt);
    else rig.update(dt);
    for (const [id, b] of buildings) {
      b.update(dt, t, camera);
      if (b.expired) swapBuilding(id, { floors: b.floors });
    }
    lots?.update(dt, t, camera);
    if (decorFade) {
      houseTargets.length = 0;
      for (const b of buildings.values()) houseTargets.push(b.center);
      decorFade.update(dt, camera, houseTargets, driver.driving);
    }
    streetProps?.update(camera, engine.quality);
    trees?.update(camera, dt, t);
    if (engine.quality !== castQuality) {
      castQuality = engine.quality;
      for (const m of lowNoCast) m.castShadow = castQuality !== 'low';
      parked?.setQuality(engine.quality);
      lowDetail(scene);
    }
    grass?.update(camera, engine.quality);
    if (groundDirty >= 0 && (groundDirty += dt) > 0.4 && groundMap && trees) {
      groundDirty = -1;
      groundMap.render(engine.renderer, scene, groundRoots, trees.discs());
    }
    if (nightLamps && lampsDirty) {
      lampsDirty = false;
      nightLamps.setLamps(nightLampList());
    }
    if (nightLamps && night > 0.2) {
      litSince += dt;
      if (litSince > 0.3) {
        litSince = 0;
        const lit: THREE.Vector3[] = [];
        scene.getObjectByName('night-lamps')?.children.forEach((l) => {
          if ((l as THREE.PointLight).intensity > 0) lit.push(l.position);
        });
        streetProps?.setLit(lit);
      }
    }
    driver.lod(camera, engine.quality);
    if (agencyTag && agency) agencyTag.setDistance(camera.position.distanceTo(new THREE.Vector3(agency.footprint.x, agency.height, agency.footprint.z)));
    if (lastMove && !driver.driving && !rig.busy && !down) {
      setHovered(pickAt(lastMove));
      lastMove = null;
    }
  };

  // ───────────── sync ─────────────
  const lotOfProject = (p: Project): Lot | undefined => {
    const lotList = ctx.store.state.city?.lots?.length ? ctx.store.state.city.lots : LOTS;
    return lotList.find((l) => l.id === p.lotId) ?? LOTS.find((l) => l.id === p.lotId);
  };

  // the engine's night-light pool follows the lamps nearest the view: street lanterns and every house's porch light
  // (positions are given at lamp base; the pool lifts them by LAMP_HEAD)
  const LAMP_HEAD = 3.45;
  const nightLampList = (): THREE.Vector3Like[] => [
    ...lampPositions,
    ...[...buildings.values()].map((b) => b.porchLightPosition().setY(b.porchLightPosition().y - LAMP_HEAD)),
  ];
  let lampsDirty = false;

  const applyNight = (k: number) => {
    night = k;
    if (!mats) return;
    mats.bulb.emissiveIntensity = THREE.MathUtils.lerp(2.5, 7, THREE.MathUtils.smoothstep(k, 0.1, 1));
    mats.glass.daylight(k);
    // the town's lit windows: a few lamps on by day, about half the flats at night
    for (let f = 0; f < FLOOR_SLOTS; f++) mats.glass.setFloor(f, THREE.MathUtils.lerp(0.45, 1.05, k));
    streetProps?.setNight(k);
    lots?.setNight(k);
    for (const b of buildings.values()) b.setNight(k);
    for (const s of signs) s.mat.emissiveIntensity = THREE.MathUtils.lerp(s.day, s.night, k);
    // real lights only once it gets dark: the first switch recompiles shaders under the engine's dissolve,
    // and daytime frames never pay for them
    if (k > 0.2 && !nightLamps && lampPositions.length) {
      nightLamps = createNightLamps(engine, scene, camera, nightLampList(), { height: LAMP_HEAD, distance: 15 });
    }
  };

  /** A building's garden trees/shrubs are tree-system instances owned by that building; it follows the time of day. */
  // Low leaves out the sprig cards that soften hedge outlines (one draw call per garden)
  const lowDetail = (root: THREE.Object3D) => {
    const on = engine.quality !== 'low';
    root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && ((o as THREE.Mesh).material as THREE.Material).name === 'hedgeFuzz') o.visible = on;
    });
  };
  const plantGarden = (b: ProjectBuilding) => {
    b.setNight(night);
    lampsDirty = true;
    lowDetail(b.group);
    groundDirty = 0;
    if (!trees) return;
    for (const p of b.plants) {
      // garden trees a touch smaller than street trees, so they frame the house rather than hide it
      trees.add(p.species, p.x, p.y, p.z, p.species === 'shrub' ? p.scale : p.scale * 0.86, plantRnd, { cast: p.cast, rotY: p.rotY, owner: b.plantOwner, tint: p.tint && new THREE.Color(...p.tint) });
    }
  };
  const disposeBuilding = (b: ProjectBuilding) => {
    trees?.removeOwner(b.plantOwner);
    b.dispose();
    groundDirty = 0;
    lampsDirty = true;
  };

  /** Replace a project's building (new storey count) keeping its status, hover and light levels. */
  const swapBuilding = (id: string, opts: BuildOptions, lotHint?: Lot) => {
    const prev = buildings.get(id);
    const p = projectsById.get(id);
    const lot = lotHint ?? (p && lotOfProject(p));
    if (!mats || !p || !lot) return;
    const next = new ProjectBuilding(p, lot, mats, () => bus.emit('building:click', { projectId: id }), opts);
    plantGarden(next);
    if (prev) {
      next.adopt(prev);
      disposeBuilding(prev);
    }
    // out of sight (inside a house): play the change when the city is shown again
    if (!active) next.holdAnimation(0.9);
    projectsLayer.add(next.group);
    buildings.set(id, next);
  };

  const applyFloorActivity = () => {
    if (!last) return;
    const jobs = ctx.store.state.jobs as Record<string, Job[]> | undefined;
    for (const [id, b] of buildings) b.setFloorActivity(floorActivity(id, b.floors, last.agents, last.approvals, jobs?.[id]));
  };

  const applySync = (city: CityState, agents: Record<string, AgentInfo>, approvals: Record<string, ApprovalRequest>) => {
    if (!mats || !lots) return;
    last = { agents, approvals };
    const lotList: Lot[] = city.lots?.length ? city.lots : LOTS;
    const lotOf = (id: string) => lotList.find((l) => l.id === id) ?? LOTS.find((l) => l.id === id);
    const seen = new Set<string>();
    for (const p of city.projects) {
      const lot = lotOf(p.lotId);
      if (!lot) continue;
      seen.add(p.id);
      projectsById.set(p.id, p);
      let b = buildings.get(p.id);
      if (b && (b.lotId !== lot.id || b.style !== p.style)) {
        if (hovered?.id === p.id) setHovered(null);
        disposeBuilding(b);
        buildings.delete(p.id);
        b = undefined;
      }
      const floors = floorsOf(p);
      if (!b) {
        const id = p.id;
        b = new ProjectBuilding(p, lot, mats, () => bus.emit('building:click', { projectId: id }), { floors });
        plantGarden(b);
        projectsLayer.add(b.group);
        buildings.set(p.id, b);
      } else if (b.floors !== floors) {
        // storeys added/removed: the new building animates from what is standing now
        b.finishAnimation();
        const from = b.floors;
        swapBuilding(p.id, floors > from ? { floors, splitAt: from, anim: 'grow' } : { floors: from, splitAt: floors, anim: 'shrink' }, lot);
        b = buildings.get(p.id)!;
      }
      b.setName(p.name);
      const a = projectActivity(p.id, agents, approvals);
      b.setActivity(a.state, a.meta);
    }
    for (const [id, b] of buildings) {
      if (seen.has(id)) continue;
      if (hovered?.id === id) setHovered(null);
      disposeBuilding(b);
      buildings.delete(id);
      projectsById.delete(id);
    }
    const used = new Set(city.projects.map((p) => p.lotId));
    lots.setEmpty(lotList.filter((l) => !used.has(l.id)));
    applyFloorActivity();
    if (atHome()) goHome();
  };

  const buildingPose = (b: ProjectBuilding) => ({
    // aim above the roof line so the name tag (and "Needs you" badge) stays in frame
    target: b.center.clone().setY(b.height * 0.55),
    radius: 28 + b.height * 1.5,
    theta: Math.atan2(b.facing.x, b.facing.z) + 0.55,
  });

  // The start view fitted to the screen (a phone held upright, #63), refitted while the camera still rests there.
  let home: FramePose | null = null;
  const goHome = () => {
    const pts = [...buildings.values()].flatMap((b) => [b.center.clone().setY(0), b.center.clone().setY(b.height + 3)]);
    const { clientWidth: width, clientHeight: height } = engine.canvas;
    home = framePose(HOME_POSE, pts, { width, height }, camera.fov, rig.controls.maxDistance);
    rig.set(home.target.clone(), home.radius, home.phi, home.theta);
  };
  const atHome = () => {
    if (!home || rig.busy) return false;
    const p = rig.pose();
    return p.target.distanceTo(home.target) < 0.5 && Math.abs(p.radius - home.radius) < 0.5 && Math.abs(p.phi - home.phi) < 0.01 && Math.abs(Math.sin((p.theta - home.theta) / 2)) < 0.01;
  };

  const view: CityView & { debug: object } = {
    scene,
    camera,
    async init() {
      const m = (mats = createCityMaterials(engine.assets));
      const roads = buildRoads(m).group;
      roads.add(buildRoadDecals());
      scene.add(roads);
      const town = new THREE.Group();
      town.name = 'town';
      const batch = new Batch();
      const amb = buildAmbient(batch, m);
      ambientFootprints = amb.footprints;
      const veg = new Vegetation();
      trees = await TreeSystem.create(engine.assets, () => engine.quality);
      scene.add(trees.group);

      // landmarks
      agency = buildAgency(batch, m);
      town.add(agency.sign);
      for (const [lx, lz] of [[-9.6, 8.6], [9.6, 8.6]]) {
        const p = lotToWorld(agencyLm, lx, lz);
        const planter = batch.writer(m.stone);
        planter.setColor([0.82, 0.8, 0.77]);
        planter.box(new THREE.Matrix4().makeTranslation(p.x, LAWN_Y + 0.35, p.z), 2.2, 0.7, 2.2);
        veg.addTree('columnar', p.x, p.z, LAWN_Y + 0.7, 0.85);
      }
      const park = buildPark(batch, m, veg);
      circles.push(...park.colliders);

      const plan = planTown(veg, amb.footprints, batch.writer(m.stone, { cast: false }));
      plan.benches.push(...park.benches);
      plan.lamps.push(...park.lamps);
      plan.bins.push(...park.bins);
      const townMeshes = batch.build(town, 'town');
      for (const mesh of townMeshes) {
        // window frames and trim: thousands of small casters whose shadows Low can do without
        if (mesh.name === 'town:frame' || mesh.name === 'town:trim') lowNoCast.push(mesh);
      }
      decorFade = new DecorFade(amb.parts, townMeshes);
      amb.extras.forEach((e) => town.add(e));
      town.add(veg.build(m, trees));
      circles.push(...veg.colliders);
      const props = await buildStreetProps(engine.assets, plan);
      town.add(props.group);
      try {
        parked = await buildParkedCars(engine.assets);
        parked.setQuality(engine.quality);
        town.add(parked.group);
      } catch (e) {
        console.warn('[city] parked cars failed to load', e);
      }
      streetProps = props;
      scene.add(town);
      lampPositions = plan.lamps.map((p) => ({ x: p.x, y: p.y, z: p.z }));
      town.traverse((o) => {
        const mat = (o as THREE.Mesh).material as THREE.MeshStandardMaterial;
        if (/^shop-sign/.test(o.name)) signs.push({ mat, day: mat.emissiveIntensity, night: 1.5 });
        if (o.name === 'agency-sign') signs.push({ mat, day: mat.emissiveIntensity, night: 2.4 });
      });

      // agency tag + pick volume
      const af = agency.footprint;
      agencyTag = new BuildingTag(agencyLm.name, () => bus.emit('landmark:click', { landmarkId: 'agency' }), { landmark: true });
      agencyTag.set('idle', 'Models & Providers');
      agencyTag.object.position.set(af.x, agency.height + 1.5, af.z);
      scene.add(agencyTag.object);
      agencyPick = new THREE.Mesh(new THREE.BoxGeometry(af.hw * 2, agency.height, af.hd * 2), new THREE.MeshBasicMaterial({ visible: false }));
      agencyPick.position.set(af.x, agency.height / 2, af.z);
      agencyPick.rotation.y = af.rotY;
      agencyPick.userData = { kind: 'landmark', id: 'agency' };
      scene.add(agencyPick);

      lots = new LotMarkers(m, (lotId) => bus.emit('lot:click', { lotId }));
      scene.add(lots.group);

      goHome();
      groundMap = new GroundMap();
      groundRoots = [roads, town, projectsLayer];
      groundMap.render(engine.renderer, scene, groundRoots, trees.discs());
      grass = new GrassField(m.lawn, m.macroNoise);
      scene.add(grass.mesh);
      if (engine.onTimeOfDay) engine.onTimeOfDay((t) => applyNight(t.night));
      else applyNight(0);
      ready = true;
      // the empty lots' FOR SALE signs wait for the first sync (main.ts: the first snapshot): before it every lot
      // would read as free, a town with no houses
      if (pending) applySync(...pending);
      pending = null;
    },
    activate() {
      if (active) return;
      active = true;
      // The parked car (3 MB, only needed up close or to drive) is not part of the town's first load: it rolls in
      // shortly after the town is on show (core/town-shown.ts). Driving before that waits for it (startDriving).
      if (!driver.car && !carRequested) {
        carRequested = true;
        afterTownShown(() => void driver.load().catch((e) => console.warn('[city] car failed to load', e)));
      }
      engine.setView(scene, camera, 'outdoor');
      if (approached) {
        // coming back out of a house: step back so the building is in view
        const b = buildings.get(approached);
        approached = null;
        if (b) {
          const p = buildingPose(b);
          rig.set(p.target, p.radius, 1.0, p.theta);
        }
      } else if (atHome()) goHome(); // the screen may have changed shape since
      rig.setActive(!driver.driving);
      for (const b of buildings.values()) b.holdAnimation(0.9);
      listen(true);
      unFrame = engine.onFrame(frame);
    },
    deactivate() {
      if (!active) return;
      active = false;
      if (driver.driving) {
        driver.stop();
        rig.controls.target.copy(driver.position);
      }
      setHovered(null);
      listen(false);
      rig.setActive(false);
      unFrame?.();
      unFrame = null;
    },
    sync(city, agents, approvals) {
      if (!ready) {
        pending = [city, agents, approvals];
        return;
      }
      applySync(city, agents, approvals);
    },
    async flyTo(target) {
      if (driver.driving) view.stopDriving();
      const duration = instant ? 0.01 : undefined;
      if (target.projectId) {
        const b = buildings.get(target.projectId);
        if (!b) return;
        const p = buildingPose(b);
        await rig.flyTo(p.target, { radius: p.radius, phi: 1.0, theta: p.theta, duration });
      } else if (target.landmarkId === 'agency' && agency) {
        const f = agency.footprint;
        await rig.flyTo(new THREE.Vector3(f.x, 7, f.z), { radius: 62, phi: 1.04, theta: Math.atan2(agency.facing.x, agency.facing.z) + 0.5, duration });
      } else if (target.landmarkId === 'park') {
        await rig.flyTo(new THREE.Vector3(parkLm.x, 0, parkLm.z), { radius: 78, phi: 0.95, duration });
      }
    },
    async approach(projectId) {
      if (driver.driving) view.stopDriving();
      const b = buildings.get(projectId);
      if (!b) return;
      approached = projectId;
      await rig.approach(b.door, b.facing, instant ? 0.01 : 1.1);
    },
    startDriving() {
      if (driver.driving || !ready) return;
      if (!driver.car) {
        void driver.load().then(() => view.startDriving());
        return;
      }
      setHovered(null);
      if (placement) view.setPlacementMode(false);
      rig.setActive(false);
      driver.start();
    },
    stopDriving() {
      if (!driver.driving) return;
      driver.stop();
      const car = driver.position.setY(0);
      rig.controls.target.copy(car);
      rig.setActive(active);
      void rig.flyTo(car, { radius: 70, phi: 0.95, duration: 1.2 });
    },
    get driving() {
      return driver.driving;
    },
    setPlacementMode(on) {
      if (on === placement) return;
      placement = on;
      lots?.setPlacement(on);
      setHovered(null);
      if (on && !driver.driving && rig.pose().radius < 150) {
        void rig.flyTo(HOME_POSE.target, { radius: HOME_POSE.radius, phi: HOME_POSE.phi, duration: instant ? 0.01 : 1.4 });
      }
    },
    debug: {
      setCamera(t: [number, number, number], r: number, phi: number, theta: number) {
        rig.set(new THREE.Vector3(...t), r, phi, theta);
      },
      /** Free camera (bypasses the orbit limits) — dev screenshots only. */
      lookFrom(pos: [number, number, number], target: [number, number, number]) {
        rig.setActive(false);
        camera.position.set(...pos);
        camera.lookAt(...target);
      },
      /** Camera animations complete immediately (screenshots). */
      setInstant(on: boolean) {
        instant = on;
      },
      hover(kind: PickKind | null, id?: string) {
        setHovered(kind && id ? { kind, id } : null);
      },
      async simulateDrive(seconds: number, keys: string[], pose?: [number, number, number]) {
        await driver.load();
        if (pose) driver.setPose(...pose);
        view.startDriving();
        driver.simulate(seconds, keys);
      },
      get driver() {
        return driver;
      },
      get store() {
        return ctx.store;
      },
      building(id: string) {
        return buildings.get(id);
      },
      /** Indices (into AMBIENT) of the decor buildings faded right now because they hide a house. */
      get fadedDecor() {
        return [...(decorFade?.faded ?? [])];
      },
      get trees() {
        return trees;
      },
      /** Preview the city's practical lights at a time of day (the sky stays as the engine has it). */
      setNight(k: number) {
        applyNight(k);
      },
    },
  };

  // a job moved to another room / was added on another floor: re-evaluate which storeys are lit
  ctx.store.subscribe((_s, msg) => {
    if (msg?.t === 'jobs' && ready) applyFloorActivity();
  });
  bus.on('placement:start', () => view.setPlacementMode(true));
  bus.on('placement:end', () => view.setPlacementMode(false));
  return view;
}
