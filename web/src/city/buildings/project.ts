// A project's building on its lot: `floors` storeys of the style's geometry (merged per material, with per-building
// material clones so hover can lift just this building), a physical name sign, a roof beacon, a porch light, an
// approval ring on the ground and a CSS2D name tag. Status drives the beacon, porch light and tag; window light is
// per storey (busy jobs on a floor → its rooms light up warm, a pending approval there → amber).
//
// When the storey count changes the city builds a new ProjectBuilding with the changing storeys split off:
// a scaffold springs up, the new storey grows out of the old roof line while the roof rides up on top of it
// (or the top storey sinks away and the roof comes down), dust puffs, the scaffold drops away.
import * as THREE from 'three';
import { STOREY_H } from '../../../../shared/house-plan';
import type { Lot, Project } from '../../../../shared/protocol';
import { additive, groundDecal, haloSprite, lightPoolMaterial, ringTexture } from '../fx';
import { FLOOR_SLOTS, ProjectGlassMaterial } from '../glass';
import { BuildingTag, type TagState } from '../labels';
import { type Footprint, LAWN_Y, lotToWorld } from '../layout';
import type { CityMaterials } from '../materials';
import { signTexture } from '../textures';
import { Batch } from '../util/mesh-writer';
import { hashString, rng } from '../util/random';
import type { PlantPlacement } from '../vegetation';
import { Scaffold } from './scaffold';
import { STYLE_BUILDERS, type StyleResult } from './styles';

const AMBER = new THREE.Color('#F5A524');
const WARM = new THREE.Color(0xffc27a);
const LAMP_WARM = new THREE.Color(1.0, 0.64, 0.33);
const LAMP_AMBER = new THREE.Color(1.0, 0.5, 0.1);
const HOVER_LIFT = new THREE.Color(0.1, 0.085, 0.06);
const _lift = new THREE.Color();
const SHARED = new Set(['foliage', 'bark', 'hedge', 'hedgeFuzz', 'flower', 'paving', 'sidewalk', 'ground', 'lawn']);

/** Glow targets per state: room lamps, porch bulb, light pool opacity, beacon intensity. */
const LOOK: Record<TagState, { glow: number; porch: number; pool: number; beacon: number }> = {
  idle: { glow: 0.14, porch: 1.6, pool: 0.12, beacon: 0 },
  busy: { glow: 1.8, porch: 6, pool: 0.5, beacon: 3.2 },
  approval: { glow: 1.4, porch: 5, pool: 0.42, beacon: 7 },
  error: { glow: 0.08, porch: 1.2, pool: 0.1, beacon: 0 },
};

let ownerSeq = 0;

/** Grow / shrink timeline (seconds after the start delay). */
const T = { pop: 0.45, riseStart: 0.4, riseEnd: 2.1, clear: 2.15, end: 2.75 };
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const easeOutBack = (x: number) => 1 + 2.2 * Math.pow(x - 1, 3) + 1.2 * Math.pow(x - 1, 2);

function nameSignTexture(name: string): THREE.CanvasTexture {
  return signTexture((g, w, h) => {
    g.fillStyle = '#f4f1ec';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#D97757';
    g.fillRect(0, 0, 22, h);
    g.fillStyle = '#1d1d20';
    g.textBaseline = 'middle';
    let size = 150;
    const font = (s: number) => `700 ${s}px Inter, "Helvetica Neue", Arial, sans-serif`;
    g.font = font(size);
    while (g.measureText(name).width > w - 110 && size > 60) g.font = font((size -= 6));
    g.fillText(name, 62, h * 0.53);
    g.fillStyle = 'rgba(29,29,32,0.18)';
    g.fillRect(22, h - 10, w - 22, 10);
  }, 1024, 320);
}

export interface BuildOptions {
  /** Storeys to build. */
  floors: number;
  /** Storeys from this index up are built apart so they can animate (default: none). */
  splitAt?: number;
  /** grow: storeys [splitAt, floors) rise in; shrink: they sink away and the building then reports `expired`. */
  anim?: 'grow' | 'shrink';
}

export class ProjectBuilding {
  readonly group = new THREE.Group();
  readonly pick: THREE.Mesh;
  readonly tag: BuildingTag;
  readonly footprint: Footprint;
  /** World-space door (ground level), outward facing and the building's visual centre. */
  readonly door: THREE.Vector3;
  readonly facing: THREE.Vector3;
  readonly center: THREE.Vector3;
  readonly height: number;
  readonly style: Project['style'];
  readonly lotId: string;
  /** Storeys once the running animation (if any) has finished. */
  readonly floors: number;
  /** A finished shrink: the city swaps this building for a plain one with `floors` storeys. */
  expired = false;
  /** Garden trees and shrubs in world space (the city instances them; key = `plantOwner`). */
  readonly plants: PlantPlacement[] = [];
  readonly plantOwner: string;
  private night = 0;
  private porchLens!: THREE.Mesh;
  private body = new THREE.Group();
  private rise = new THREE.Group();
  private roof = new THREE.Group();
  private clones = new Map<THREE.MeshStandardMaterial, THREE.Color>();
  private glass: ProjectGlassMaterial;
  private signTex: THREE.CanvasTexture;
  private faceMat: THREE.MeshStandardMaterial;
  private beaconMat: THREE.MeshStandardMaterial;
  private halo: THREE.Sprite;
  private ring: THREE.Mesh;
  private pool: THREE.Mesh;
  private porchMat: THREE.MeshStandardMaterial;
  private tagAnchor = new THREE.Vector3();
  private tagY: number;
  private state: TagState = 'idle';
  private meta = '';
  private floorStates: TagState[] | null = null;
  private floorGlow = new Array<number>(FLOOR_SLOTS).fill(LOOK.idle.glow);
  private floorTint = Array.from({ length: FLOOR_SLOTS }, () => LAMP_WARM.clone());
  private hover = false;
  private hoverT = 0;
  private porchT = LOOK.idle.porch;
  private poolT = LOOK.idle.pool;
  private beaconT = 0;
  private phase: number;
  private anim: { kind: 'grow' | 'shrink'; t: number; delay: number; dy: number } | null = null;
  private scaffold: Scaffold | null = null;

  constructor(project: Project, lot: Lot, base: CityMaterials, onClick: () => void, opts: BuildOptions) {
    const built = opts.floors;
    const split = opts.anim ? Math.max(1, Math.min(built, opts.splitAt ?? built)) : built;
    this.floors = opts.anim === 'shrink' ? split : built;
    this.style = project.style;
    this.lotId = lot.id;
    const seed = hashString(project.id);
    this.phase = (seed % 1000) / 1000;
    this.group.name = `project:${project.id}`;
    this.group.position.set(lot.x, 0, lot.z);
    this.group.rotation.y = lot.rotY;

    this.glass = new ProjectGlassMaterial(seed);
    this.glass.baseY.value = LAWN_Y;
    this.glass.floors.value = built;
    const cache = new Map<string, THREE.Material>();
    const mats = new Proxy(base, {
      get: (target, key: string) => {
        const v = (target as unknown as Record<string, unknown>)[key];
        if (key === 'glass') return this.glass;
        // ground surfaces and plants keep the shared material (no hover lift: lifted foliage reads as grey)
        if (!(v instanceof THREE.MeshStandardMaterial) || SHARED.has(key)) return v;
        let c = cache.get(key) as THREE.MeshStandardMaterial | undefined;
        if (!c) {
          c = v.clone();
          // clone() doesn't carry shader patches (weathering, macro variation)
          c.onBeforeCompile = v.onBeforeCompile;
          c.customProgramCacheKey = v.customProgramCacheKey;
          cache.set(key, c);
          this.clones.set(c, c.emissive.clone());
        }
        return c;
      },
    });

    const bodyB = new Batch(), riseB = new Batch(), roofB = new Batch();
    const localPlants: PlantPlacement[] = [];
    const res: StyleResult = STYLE_BUILDERS[project.style]({
      mats, glass: this.glass, rnd: rng(seed), floors: built,
      site: bodyB, storey: (i) => (i < split ? bodyB : riseB), roof: roofB, plants: localPlants,
    });
    this.plantOwner = `${project.id}#${++ownerSeq}`;
    for (const p of localPlants) {
      const w = lotToWorld(lot, p.x, p.z);
      this.plants.push({ ...p, x: w.x, z: w.z, rotY: p.rotY + lot.rotY });
    }
    this.height = LAWN_Y + res.height;

    // name sign: two posts + a board, the face is its own textured mesh
    const sx = res.sign.x, sz = res.sign.z, boardY = LAWN_Y + 1.42;
    const metal = bodyB.writer(mats.metal);
    const trim = bodyB.writer(mats.trim);
    for (const dx of [-1.0, 1.0]) metal.box(new THREE.Matrix4().makeTranslation(sx + dx, LAWN_Y + 0.9, sz - 0.02), 0.07, 1.8, 0.07);
    trim.setColor([0.16, 0.16, 0.17]);
    trim.box(new THREE.Matrix4().makeTranslation(sx, boardY, sz), 2.36, 0.8, 0.06);
    this.signTex = nameSignTexture(project.name);
    this.faceMat = new THREE.MeshStandardMaterial({ map: this.signTex, roughness: 0.6 });
    const face = new THREE.Mesh(new THREE.PlaneGeometry(2.24, 0.7), this.faceMat);
    face.position.set(sx, boardY, sz + 0.031);
    face.castShadow = true;
    face.receiveShadow = true;
    this.body.add(face);

    // beacon on the roof: base (+ mast on flat roofs) and a bulb whose emissive and halo follow the status
    const b = res.beacon;
    const roofMetal = roofB.writer(mats.metal);
    roofMetal.geometry(new THREE.CylinderGeometry(0.16, 0.2, 0.16, 12), new THREE.Matrix4().makeTranslation(b.x, b.y - 0.04, b.z));
    if (project.style === 'office' || project.style === 'studio') {
      const mast = project.style === 'office' ? 1.6 : 1.1;
      roofMetal.geometry(new THREE.CylinderGeometry(0.05, 0.06, mast, 8), new THREE.Matrix4().makeTranslation(b.x, b.y - 0.1 - mast / 2, b.z));
    }
    this.beaconMat = new THREE.MeshStandardMaterial({ color: 0x2a2620, roughness: 0.3, emissive: AMBER.clone(), emissiveIntensity: 0 });
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), this.beaconMat);
    bulb.position.set(b.x, b.y + 0.04, b.z);
    bulb.scale.y = 1.4;
    this.roof.add(bulb);
    this.halo = haloSprite(AMBER, 5);
    this.halo.position.set(b.x, b.y + 0.2, b.z);
    this.halo.visible = false;
    this.roof.add(this.halo);

    // porch light: emissive lens + a warm pool on the ground below
    this.porchMat = new THREE.MeshStandardMaterial({ color: 0x2a2620, emissive: WARM.clone(), emissiveIntensity: LOOK.idle.porch });
    const lens = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.2, 0.03), this.porchMat);
    lens.position.copy(res.porchLight);
    this.body.add(lens);
    this.porchLens = lens;
    this.pool = groundDecal(5, lightPoolMaterial());
    this.pool.position.set(res.porchLight.x, LAWN_Y + 0.06, res.porchLight.z + 1.4);
    this.body.add(this.pool);

    // approval ring around the house
    const fp = res.footprint;
    const ringSize = 2 * (Math.hypot(fp.hw, fp.hd) + 2.2);
    this.ring = groundDecal(ringSize, additive(ringTexture(), AMBER, 0));
    this.ring.position.set(fp.cx, LAWN_Y + 0.07, fp.cz);
    this.ring.visible = false;
    this.body.add(this.ring);

    bodyB.build(this.body, `project:${project.id}`);
    roofB.build(this.roof, `project:${project.id}:roof`);
    // the rising storeys pivot at their base so they can grow out of the roof line
    const riseBase = LAWN_Y + split * STOREY_H;
    for (const m of riseB.build(this.rise, `project:${project.id}:rise`)) {
      m.position.y = -riseBase;
      m.updateMatrix();
    }
    this.rise.position.y = riseBase;
    this.group.add(this.body, this.rise, this.roof);

    // invisible pick box (cheap to raycast, covers the whole building)
    const pickH = LAWN_Y + res.wallTop + (res.height - res.wallTop) * 0.7;
    this.pick = new THREE.Mesh(new THREE.BoxGeometry(fp.hw * 2, pickH, fp.hd * 2), new THREE.MeshBasicMaterial({ visible: false }));
    this.pick.position.set(fp.cx, pickH / 2, fp.cz);
    this.pick.userData = { kind: 'building', id: project.id };
    this.group.add(this.pick);

    this.tag = new BuildingTag(project.name, onClick);
    this.tagY = this.height + 1.4;
    this.tag.object.position.set(fp.cx, this.tagY, fp.cz);
    this.group.add(this.tag.object);

    if (opts.anim && built > split) {
      const dy = (built - split) * STOREY_H;
      this.anim = { kind: opts.anim, t: 0, delay: 0.15, dy };
      // walls only (the style footprint carries a 0.4 m margin)
      const area = { cx: fp.cx, cz: fp.cz, hw: fp.hw - 0.4, hd: fp.hd - 0.4 };
      this.scaffold = new Scaffold(area, riseBase - 1.2, riseBase + dy + 1.15, base, seed);
      this.scaffold.group.scale.y = 0.001;
      this.scaffold.group.visible = false;
      this.group.add(this.scaffold.group);
      this.scaffold.attachPuffs(this.group);
      this.applyAnim();
    }

    const c = lotToWorld(lot, fp.cx, fp.cz);
    this.footprint = { x: c.x, z: c.z, hw: fp.hw, hd: fp.hd, rotY: lot.rotY, id: project.id };
    const d = lotToWorld(lot, res.door.x, res.door.z);
    this.door = new THREE.Vector3(d.x, LAWN_Y, d.z);
    this.facing = new THREE.Vector3(Math.sin(lot.rotY), 0, Math.cos(lot.rotY));
    this.center = new THREE.Vector3(c.x, this.height * 0.4, c.z);
    this.group.updateMatrixWorld(true);
  }

  get animating(): boolean {
    return this.anim !== null;
  }

  /** Take over status, hover and the current light levels from the building this one replaces (no flicker). */
  adopt(prev: ProjectBuilding): void {
    this.setActivity(prev.state, prev.meta);
    this.floorStates = prev.floorStates;
    this.floorGlow = prev.floorGlow.slice();
    this.floorTint.forEach((c, i) => c.copy(prev.floorTint[i]));
    this.porchT = prev.porchT;
    this.poolT = prev.poolT;
    this.beaconT = prev.beaconT;
    this.hoverT = prev.hoverT;
    this.setNight(prev.night);
    this.setHover(prev.hover);
    this.applyHover();
  }

  /** Keep a pending animation from starting for at least `s` seconds (e.g. until the camera has settled). */
  holdAnimation(s: number): void {
    if (this.anim && this.anim.t === 0) this.anim.delay = Math.max(this.anim.delay, s);
  }

  /** Jump to the end of the running animation. */
  finishAnimation(): void {
    if (!this.anim) return;
    this.anim.delay = 0;
    this.anim.t = T.end;
    this.applyAnim();
  }

  setName(name: string): void {
    this.tag.setName(name);
  }

  setActivity(state: TagState, meta: string): void {
    this.state = state;
    this.meta = meta;
    this.tag.set(state, meta);
    this.ring.visible = state === 'approval';
    this.halo.visible = state === 'busy' || state === 'approval';
    this.beaconMat.emissive.copy(state === 'approval' ? AMBER : WARM);
    (this.halo.material as THREE.SpriteMaterial).color.copy(state === 'approval' ? AMBER : WARM);
  }

  /** Per-storey state (index = floor). null → every storey follows the building's state. */
  setFloorActivity(states: TagState[] | null): void {
    this.floorStates = states;
  }

  setHover(on: boolean): void {
    this.hover = on;
    this.tag.setHover(on);
  }

  /** World position just in front of the porch lantern (where a night light would sit). */
  porchLightPosition(): THREE.Vector3 {
    this.group.updateMatrixWorld();
    return this.porchLens.localToWorld(new THREE.Vector3(0, -0.1, 0.45));
  }

  /** Time of day (0 day … 1 night): porch light and its pool carry further, rooms of idle homes are lived-in. */
  setNight(night: number): void {
    this.night = night;
    this.glass.daylight(night);
  }

  update(dt: number, t: number, camera: THREE.Camera): void {
    const look = LOOK[this.state];
    const k = 1 - Math.exp(-dt * 4);
    const n = this.night;
    this.porchT += (look.porch * (1 + 0.8 * n) - this.porchT) * k;
    this.poolT += (look.pool * (1 + 1.2 * n) + 0.06 * n - this.poolT) * k;
    this.porchMat.emissiveIntensity = this.porchT;
    // light added in proportion to what's underneath: at night the ground is dark, so the porch light works harder
    // (near the camera the engine's night lights add a real light here as well)
    (this.pool.material as THREE.MeshBasicMaterial).color.copy(WARM).multiplyScalar(this.poolT * (3 + 5 * n));

    // beacon: busy breathes slowly, approval pulses (≈1.1 Hz) together with the ring
    const approvalPulse = 0.5 + 0.5 * Math.sin((t + this.phase) * Math.PI * 2 * 1.1);
    let pulse = 1;
    if (this.state === 'approval') pulse = approvalPulse;
    else if (this.state === 'busy') pulse = 0.8 + 0.2 * Math.sin((t + this.phase) * Math.PI * 2 * 0.35);
    this.beaconT += (look.beacon - this.beaconT) * k;
    this.beaconMat.emissiveIntensity = this.beaconT * (0.35 + 0.65 * pulse);
    const haloMat = this.halo.material as THREE.SpriteMaterial;
    haloMat.opacity = Math.min(1, this.beaconT / 4) * (0.35 + 0.65 * pulse);
    this.halo.scale.setScalar(this.state === 'approval' ? 4.2 + 2.2 * pulse : 3.6);
    if (this.ring.visible) {
      (this.ring.material as THREE.MeshBasicMaterial).opacity = 0.55 + 0.9 * pulse;
      const s = 0.94 + 0.08 * pulse;
      this.ring.scale.set(s, 1, s);
    }

    // hover: a gentle emissive lift on this building's materials
    const target = this.hover ? 1 : 0;
    if (Math.abs(target - this.hoverT) > 0.002) {
      this.hoverT += (target - this.hoverT) * (1 - Math.exp(-dt * 10));
      this.applyHover();
    }

    // room lights per storey: lamps fade up/down; a floor waiting for approval breathes amber
    for (let f = 0; f < FLOOR_SLOTS; f++) {
      const st = this.floorStates?.[f] ?? this.state;
      // someone lives here: at night the living room (ground floor) is always lit, the other storeys softly
      const lived = st === 'idle' ? (f === 0 ? 1.1 : 0.55) * n : 0;
      this.floorGlow[f] += (LOOK[st].glow + lived - this.floorGlow[f]) * k;
      this.floorTint[f].lerp(st === 'approval' ? LAMP_AMBER : LAMP_WARM, k);
      const g = this.floorGlow[f] * (st === 'approval' ? 0.65 + 0.5 * approvalPulse : 1);
      this.glass.setFloor(f, g, this.floorTint[f]);
    }

    if (this.anim) {
      if (this.anim.delay > 0) this.anim.delay -= dt;
      else this.anim.t += dt;
      this.applyAnim();
    }

    this.tagAnchor.setFromMatrixPosition(this.tag.object.matrixWorld);
    this.tag.setDistance(camera.position.distanceTo(this.tagAnchor));
  }

  private applyHover(): void {
    for (const [m, base] of this.clones) m.emissive.copy(base).lerp(_lift.copy(base).add(HOVER_LIFT), this.hoverT);
    this.glass.hover.value = this.hoverT;
  }

  private applyAnim(): void {
    const a = this.anim;
    if (!a) return;
    const t = a.t;
    const sc = this.scaffold;
    if (sc) {
      let s = easeOutBack(clamp01(t / T.pop));
      if (t > T.clear) s = 1 - Math.pow(clamp01((t - T.clear) / (T.end - T.clear)), 2);
      sc.group.scale.y = Math.max(0.001, s);
      sc.group.visible = t > 0 && s > 0.002;
      sc.updatePuffs(t - T.riseStart);
    }
    const k = easeInOut(clamp01((t - T.riseStart) / (T.riseEnd - T.riseStart)));
    const grown = a.kind === 'grow' ? k : 1 - k;
    this.rise.scale.y = Math.max(0.001, grown);
    this.rise.visible = grown > 0.002;
    this.roof.position.y = -a.dy * (1 - grown);
    this.tag.object.position.y = this.tagY + this.roof.position.y;
    if (t >= T.end) {
      this.anim = null;
      this.scaffold?.dispose();
      this.scaffold = null;
      if (a.kind === 'shrink') this.expired = true;
    }
  }

  dispose(): void {
    this.tag.object.removeFromParent();
    this.tag.root.remove();
    this.scaffold?.dispose();
    this.group.removeFromParent();
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
    });
    for (const m of this.clones.keys()) m.dispose();
    this.glass.dispose();
    this.signTex.dispose();
    this.faceMat.dispose();
    this.beaconMat.dispose();
    this.porchMat.dispose();
    (this.halo.material as THREE.Material).dispose();
    (this.ring.material as THREE.Material).dispose();
    (this.pool.material as THREE.Material).dispose();
  }
}
