// Drivable car: Khronos CarConcept (static parts merged per material, wheels on steer pivots), arcade physics,
// collisions against building footprints / tree + lamp circles, a lagging chase camera, "Press E" prompts
// and a frosted-glass HUD. The city owns one Driver; the car stays parked where it was left.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CAR_SPAWN } from '../../../shared/city-layout';
import type { Assets, Quality } from '../core/types';
import { createDriveHud, type DriveHud } from './labels';
import { type Footprint, surfaceHeight, TOWN } from './layout';

const CAR_URL = '/assets/vehicles/khronos/CarConcept_meshopt.glb';
const CAR_LENGTH = 4.5;
const HIDE = ['License Plate', 'License_Plate', 'InteriorSteeringEmblem', 'BodyWindshieldWipers', 'BodyWindshieldWipersBase'];
const NO_SHADOW = /^(Interior|Floormat|Dashboard|Panel Sides|Hardware)/;
const WHEELS = ['WheelFrontL', 'WheelFrontR', 'WheelRearL', 'WheelRearR'];

// arcade tuning (m, s)
const MAX_FWD = 24;
const MAX_REV = 7;
const ACCEL = 9;
const BRAKE = 22;
const DRAG = 0.06;
const ROLLING = 0.5;
const ENGINE_BRAKE = 1.4;
const CAR_R = 1.0; // collision circles (front + rear)
const CAR_AXLE = 1.25;
const BOUNDS = { x0: TOWN.x0 - 28, x1: TOWN.x1 + 28, z0: TOWN.z0 - 28, z1: TOWN.z1 + 28 };

interface Wheel {
  pivot: THREE.Object3D;
  spin: THREE.Object3D;
  front: boolean;
}

export interface DriveTarget {
  kind: 'building' | 'lot' | 'landmark';
  id: string;
  label: string;
  x: number;
  z: number;
}

export interface DriveWorld {
  footprints(): Footprint[];
  circles: { x: number; z: number; r: number }[];
  targets(): DriveTarget[];
  use(t: DriveTarget): void;
  exit(): void;
}

/** Copy an attribute (possibly quantized / interleaved) into a plain Float32 attribute. */
function toFloat(a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): THREE.BufferAttribute {
  const out = new Float32Array(a.count * a.itemSize);
  for (let i = 0; i < a.count; i++) for (let c = 0; c < a.itemSize; c++) out[i * a.itemSize + c] = a.getComponent(i, c);
  return new THREE.BufferAttribute(out, a.itemSize);
}

function plainGeometry(src: THREE.BufferGeometry, m: THREE.Matrix4): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', toFloat(src.getAttribute('position')));
  const n = src.getAttribute('normal');
  if (n) g.setAttribute('normal', toFloat(n));
  const uv = src.getAttribute('uv');
  g.setAttribute('uv', uv ? toFloat(uv) : new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
  const idx = src.getIndex();
  if (idx) g.setIndex(new THREE.BufferAttribute(Uint32Array.from({ length: idx.count }, (_, i) => idx.getX(i)), 1));
  else g.setIndex(new THREE.BufferAttribute(Uint32Array.from({ length: g.getAttribute('position').count }, (_, i) => i), 1));
  if (!n) g.computeVertexNormals();
  g.applyMatrix4(m);
  return g;
}

async function buildCar(assets: Assets): Promise<{ root: THREE.Group; wheels: Wheel[]; wheelR: number }> {
  const gltf = await assets.gltf(CAR_URL);
  const src = gltf.scene.clone(true);
  for (const n of HIDE) src.getObjectByName(n)?.removeFromParent();
  const root = new THREE.Group();
  root.name = 'car';
  root.add(src);
  root.updateMatrixWorld(true);

  // wheels: pivot at the hub (steers about body-up), spin node rolls about its local X; drop the baked pose
  const wheels: Wheel[] = [];
  const wheelParts = new Set<THREE.Object3D>();
  for (const name of WHEELS) {
    const w = src.getObjectByName(name);
    if (!w || !w.parent) continue;
    const pivot = new THREE.Object3D();
    pivot.position.copy(w.position);
    w.parent.add(pivot);
    w.position.set(0, 0, 0);
    w.quaternion.identity();
    pivot.add(w);
    // brake discs / pads don't need to spin: they get merged into the static body
    w.traverse((o) => {
      if (!/Brake/.test(o.name)) wheelParts.add(o);
    });
    wheels.push({ pivot, spin: w, front: name.includes('Front') });
  }
  root.updateMatrixWorld(true);

  // merge everything static by material
  const inv = root.matrixWorld.clone().invert();
  const byMat = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const remove: THREE.Object3D[] = [];
  src.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || wheelParts.has(mesh)) return;
    const mat = mesh.material as THREE.Material;
    const rel = inv.clone().multiply(mesh.matrixWorld);
    if (!byMat.has(mat)) byMat.set(mat, []);
    byMat.get(mat)!.push(plainGeometry(mesh.geometry, rel));
    remove.push(mesh);
  });
  for (const o of remove) o.removeFromParent();

  const glass = new THREE.MeshStandardMaterial({
    name: 'car-glass', color: 0x161a20, roughness: 0.04, metalness: 0, transparent: true, opacity: 0.35, envMapIntensity: 1.5, depthWrite: false,
  });
  for (const [mat, geos] of byMat) {
    const merged = mergeGeometries(geos, false);
    geos.forEach((g) => g.dispose());
    if (!merged) continue;
    const isGlass = mat.name === 'Glass' || (mat as THREE.MeshPhysicalMaterial).transmission > 0;
    const m = new THREE.Mesh(merged, isGlass ? glass : mat);
    m.name = `car:${mat.name || 'default'}`;
    m.castShadow = !isGlass && !NO_SHADOW.test(mat.name);
    m.receiveShadow = true;
    if (isGlass) m.renderOrder = 1;
    root.add(m);
  }
  src.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }
  });

  // scale to a believable length; body origin is at the tyre contact plane
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const s = CAR_LENGTH / Math.max(size.x, size.z);
  const inner = new THREE.Group();
  inner.scale.setScalar(s);
  while (root.children.length) inner.add(root.children[0]);
  root.add(inner);
  return { root, wheels, wheelR: 0.38 * s };
}

export class Driver {
  readonly hud: DriveHud;
  car: THREE.Group | null = null;
  driving = false;
  private wheels: Wheel[] = [];
  private wheelR = 0.38;
  private wheelbase = 2.8;
  private x = CAR_SPAWN.x;
  private z = CAR_SPAWN.z;
  private y = 0;
  private yaw = CAR_SPAWN.rotY;
  private speed = 0;
  private steer = 0;
  private roll = 0;
  private pitch = 0;
  private keys = new Set<string>();
  private camPos = new THREE.Vector3();
  private camLook = new THREE.Vector3();
  private intro = 1;
  private introFrom = { pos: new THREE.Vector3(), look: new THREE.Vector3() };
  private target: DriveTarget | null = null;
  private loading: Promise<void> | null = null;

  constructor(
    private scene: THREE.Scene,
    private camera: THREE.PerspectiveCamera,
    private assets: Assets,
    private world: DriveWorld,
    hudParent: HTMLElement,
  ) {
    this.hud = createDriveHud(() => this.world.exit());
    hudParent.appendChild(this.hud.root);
  }

  load(): Promise<void> {
    return (this.loading ??= buildCar(this.assets).then(({ root, wheels, wheelR }) => {
      this.car = root;
      this.wheels = wheels;
      this.wheelR = wheelR;
      const fz = wheels.find((w) => w.front)?.pivot, rz = wheels.find((w) => !w.front)?.pivot;
      if (fz && rz) {
        const a = fz.getWorldPosition(new THREE.Vector3()), b = rz.getWorldPosition(new THREE.Vector3());
        this.wheelbase = Math.max(2, a.distanceTo(b));
      }
      this.scene.add(root);
      this.place();
    }));
  }

  private shadowOn = true;
  private casters: THREE.Mesh[] = [];

  /** Parked and far from the camera: stop rendering the car into the shadow map (sooner on Low). */
  lod(camera: THREE.Camera, quality: Quality = 'high'): void {
    if (!this.car) return;
    const on = this.driving || camera.position.distanceTo(this.car.position) < (quality === 'low' ? 45 : 150);
    if (on === this.shadowOn) return;
    this.shadowOn = on;
    if (!this.casters.length) this.car.traverse((o) => (o as THREE.Mesh).isMesh && (o as THREE.Mesh).castShadow && this.casters.push(o as THREE.Mesh));
    for (const m of this.casters) m.castShadow = on;
  }

  get position(): THREE.Vector3 {
    return new THREE.Vector3(this.x, this.y, this.z);
  }

  get forward(): THREE.Vector3 {
    return new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
  }

  start(): void {
    if (this.driving) return;
    this.driving = true;
    this.keys.clear();
    this.speed = 0;
    this.intro = 0;
    this.introFrom.pos.copy(this.camera.position);
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    this.introFrom.look.copy(this.camera.position).addScaledVector(dir, 40);
    this.chase(1, true);
    this.hud.show(true);
    this.hud.setPrompt(null);
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('keyup', this.onKey);
    window.addEventListener('blur', this.onBlur);
  }

  stop(): void {
    if (!this.driving) return;
    this.driving = false;
    this.keys.clear();
    this.speed = 0;
    this.steer = 0;
    this.hud.show(false);
    this.target = null;
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('keyup', this.onKey);
    window.removeEventListener('blur', this.onBlur);
    this.camera.fov = 38;
    this.camera.updateProjectionMatrix();
    this.place();
  }

  /** Teleport (dev) */
  setPose(x: number, z: number, yaw: number): void {
    this.x = x;
    this.z = z;
    this.yaw = yaw;
    this.y = surfaceHeight(x, z);
    this.place();
  }

  private onBlur = () => this.keys.clear();

  private onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const down = e.type === 'keydown';
    if (down && e.code === 'Escape') {
      e.preventDefault();
      this.world.exit();
      return;
    }
    if (down && (e.code === 'KeyE' || e.code === 'Enter') && !e.repeat) {
      if (this.target) {
        e.preventDefault();
        this.world.use(this.target);
      }
      return;
    }
    if (/^(Arrow|Space)/.test(e.code)) e.preventDefault();
    if (down) this.keys.add(e.code);
    else this.keys.delete(e.code);
  };

  /** Advance physics + camera; dt in seconds. */
  update(dt: number): void {
    if (!this.car) return;
    if (!this.driving) return;
    const step = Math.min(dt, 1 / 30);
    for (let left = dt; left > 1e-6; left -= step) this.physics(Math.min(step, left));
    this.place();
    this.chase(dt, false);
    this.prompt();
    this.hud.setSpeed(this.speed * 3.6);
  }

  /** Hold keys for `seconds` of simulated time (dev screenshots). */
  simulate(seconds: number, keys: string[]): void {
    for (const k of keys) this.keys.add(k);
    const dt = 1 / 60;
    for (let t = 0; t < seconds; t += dt) {
      this.physics(dt);
      this.place();
      this.intro = 1;
      this.chase(dt, false);
    }
    for (const k of keys) this.keys.delete(k);
    this.chase(1, true);
    this.prompt();
    this.hud.setSpeed(this.speed * 3.6);
  }

  private physics(dt: number): void {
    const k = this.keys;
    const throttle = k.has('KeyW') || k.has('ArrowUp') ? 1 : 0;
    const back = k.has('KeyS') || k.has('ArrowDown') ? 1 : 0;
    const steerIn = (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0) - (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0);
    const hand = k.has('Space');
    const v0 = this.speed;

    let a = 0;
    if (throttle) a += this.speed < 0 ? BRAKE : ACCEL * (1 - Math.max(0, this.speed) / (MAX_FWD * 1.08));
    if (back) a -= this.speed > 0.5 ? BRAKE : ACCEL * 0.7 * (1 + Math.min(0, this.speed) / MAX_REV);
    if (hand) a -= Math.sign(this.speed) * BRAKE * 1.2;
    a -= this.speed * DRAG + Math.sign(this.speed) * (ROLLING + (throttle || back ? 0 : ENGINE_BRAKE));
    const next = this.speed + a * dt;
    // don't let drag/brakes flip the direction of travel
    this.speed = !throttle && !back && Math.sign(next) !== Math.sign(this.speed) ? 0 : THREE.MathUtils.clamp(next, -MAX_REV, MAX_FWD);
    if (hand && Math.abs(this.speed) < 0.4) this.speed = 0;

    const maxSteer = 0.62 / (1 + Math.abs(this.speed) / 9);
    const target = steerIn * maxSteer;
    const rate = steerIn === 0 ? 5 : 3.2;
    this.steer += THREE.MathUtils.clamp(target - this.steer, -rate * dt, rate * dt);
    const yawRate = (this.speed / this.wheelbase) * Math.tan(this.steer);
    this.yaw += yawRate * dt;

    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    this.x += fx * this.speed * dt;
    this.z += fz * this.speed * dt;
    this.collide(fx, fz);

    const gy = surfaceHeight(this.x, this.z);
    this.y += (gy - this.y) * (1 - Math.exp(-dt * 14));
    const lat = this.speed * yawRate;
    this.roll += (THREE.MathUtils.clamp(-lat * 0.007, -0.05, 0.05) - this.roll) * (1 - Math.exp(-dt * 6));
    const lon = (this.speed - v0) / Math.max(dt, 1e-3);
    this.pitch += (THREE.MathUtils.clamp(-lon * 0.0035, -0.03, 0.03) - this.pitch) * (1 - Math.exp(-dt * 5));

    for (const w of this.wheels) {
      w.spin.rotation.x += (this.speed / this.wheelR) * dt;
      if (w.front) w.pivot.rotation.z = this.steer;
    }
  }

  private collide(fx: number, fz: number): void {
    let hit = false;
    let nx = 0, nz = 0;
    for (const off of [CAR_AXLE, -CAR_AXLE]) {
      const cx = this.x + fx * off, cz = this.z + fz * off;
      const push = this.pushOut(cx, cz);
      if (push) {
        this.x += push.x;
        this.z += push.z;
        nx += push.x;
        nz += push.z;
        hit = true;
      }
    }
    if (this.x < BOUNDS.x0 || this.x > BOUNDS.x1 || this.z < BOUNDS.z0 || this.z > BOUNDS.z1) {
      const x = THREE.MathUtils.clamp(this.x, BOUNDS.x0, BOUNDS.x1), z = THREE.MathUtils.clamp(this.z, BOUNDS.z0, BOUNDS.z1);
      nx += x - this.x;
      nz += z - this.z;
      this.x = x;
      this.z = z;
      hit = true;
    }
    if (hit) {
      const l = Math.hypot(nx, nz) || 1;
      const into = -(fx * nx + fz * nz) / l * Math.sign(this.speed || 1); // 1 = head-on
      if (into > 0.6) this.speed *= -0.18;
      else this.speed *= 1 - 0.5 * Math.max(0, into);
    }
  }

  private pushOut(cx: number, cz: number): { x: number; z: number } | null {
    let px = 0, pz = 0, any = false;
    for (const f of this.world.footprints()) {
      const dx = cx - f.x, dz = cz - f.z;
      if (Math.abs(dx) > f.hw + f.hd + CAR_R + 1 && Math.abs(dz) > f.hw + f.hd + CAR_R + 1) continue;
      const c = Math.cos(f.rotY), s = Math.sin(f.rotY);
      // world → local (local X = (cos, -sin), local Z = (sin, cos))
      const lx = dx * c - dz * s, lz = dx * s + dz * c;
      const qx = THREE.MathUtils.clamp(lx, -f.hw, f.hw), qz = THREE.MathUtils.clamp(lz, -f.hd, f.hd);
      let ox = lx - qx, oz = lz - qz;
      let d = Math.hypot(ox, oz);
      if (d >= CAR_R) continue;
      if (d < 1e-4) {
        // centre inside: push out through the nearest face
        const ex = f.hw - Math.abs(lx), ez = f.hd - Math.abs(lz);
        if (ex < ez) { ox = Math.sign(lx) || 1; oz = 0; d = -ex; } else { ox = 0; oz = Math.sign(lz) || 1; d = -ez; }
        const l = Math.hypot(ox, oz);
        ox /= l; oz /= l;
      } else {
        ox /= d; oz /= d;
      }
      const depth = CAR_R - d;
      // local → world
      px += (ox * c + oz * s) * depth;
      pz += (-ox * s + oz * c) * depth;
      any = true;
    }
    for (const o of this.world.circles) {
      const dx = cx - o.x, dz = cz - o.z;
      const rr = o.r + CAR_R * 0.8;
      if (Math.abs(dx) > rr || Math.abs(dz) > rr) continue;
      const d = Math.hypot(dx, dz);
      if (d >= rr || d < 1e-5) continue;
      px += (dx / d) * (rr - d);
      pz += (dz / d) * (rr - d);
      any = true;
    }
    return any ? { x: px, z: pz } : null;
  }

  private place(): void {
    if (!this.car) return;
    this.car.position.set(this.x, this.y, this.z);
    this.car.rotation.set(this.pitch, this.yaw, this.roll, 'YXZ');
    this.car.updateMatrixWorld(true);
  }

  private chase(dt: number, snap: boolean): void {
    const f = this.forward;
    const dist = 8.4 + Math.abs(this.speed) * 0.07;
    const desired = new THREE.Vector3(this.x, this.y, this.z).addScaledVector(f, this.speed < -0.5 ? 2 - dist : -dist);
    desired.y += 3.1;
    const look = new THREE.Vector3(this.x, this.y + 1.15, this.z).addScaledVector(f, 4);
    if (snap) {
      this.camPos.copy(desired);
      this.camLook.copy(look);
    } else {
      this.camPos.lerp(desired, 1 - Math.exp(-dt * 4.5));
      this.camLook.lerp(look, 1 - Math.exp(-dt * 9));
    }
    this.camPos.y = Math.max(this.camPos.y, surfaceHeight(this.camPos.x, this.camPos.z) + 1.2);
    let pos = this.camPos, at = this.camLook;
    if (this.intro < 1) {
      this.intro = Math.min(1, this.intro + dt / 1.3);
      const e = this.intro < 0.5 ? 4 * this.intro ** 3 : 1 - Math.pow(-2 * this.intro + 2, 3) / 2;
      pos = this.introFrom.pos.clone().lerp(this.camPos, e);
      at = this.introFrom.look.clone().lerp(this.camLook, e);
    }
    this.camera.position.copy(pos);
    this.camera.lookAt(at);
    const fov = 54 + Math.min(8, Math.abs(this.speed) * 0.3);
    if (Math.abs(this.camera.fov - fov) > 0.05) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  private prompt(): void {
    let best: DriveTarget | null = null;
    let bd = 11;
    for (const t of this.world.targets()) {
      const d = Math.hypot(t.x - this.x, t.z - this.z);
      if (d < bd) {
        bd = d;
        best = t;
      }
    }
    this.target = best;
    this.hud.setPrompt(best ? best.label : null);
  }

  dispose(): void {
    this.stop();
    this.hud.root.remove();
  }
}
