// City camera: MapControls (left-drag pan, right-drag orbit, wheel zoom-to-cursor) with damping, bounded to the
// town, plus eased fly-to / approach animations that hand control back to the user when done.
import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';

const BOUNDS = { x0: -175, x1: 175, z0: -135, z1: 135 };

interface Pose {
  target: THREE.Vector3;
  radius: number;
  phi: number; // polar angle from +Y
  theta: number; // azimuth (three.js Spherical convention)
}

interface Tween {
  from: Pose;
  to: Pose;
  t: number;
  duration: number;
  ease: (t: number) => number;
  resolve: () => void;
}

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeIn = (t: number) => t * t * (2.2 - 1.2 * t);
const _sph = new THREE.Spherical();
const _off = new THREE.Vector3();

export class CityCameraRig {
  readonly controls: MapControls;
  private tween: Tween | null = null;
  private active = false;

  constructor(readonly camera: THREE.PerspectiveCamera, dom: HTMLElement) {
    const c = new MapControls(camera, dom);
    c.enableDamping = true;
    c.dampingFactor = 0.075;
    c.zoomToCursor = true;
    c.screenSpacePanning = false;
    c.minDistance = 14;
    c.maxDistance = 380;
    c.minPolarAngle = 0.18;
    c.maxPolarAngle = 1.32;
    c.panSpeed = 1.1;
    c.rotateSpeed = 0.6;
    c.zoomSpeed = 1.1;
    c.enabled = false;
    this.controls = c;
  }

  setActive(on: boolean): void {
    this.active = on;
    this.controls.enabled = on && !this.tween;
  }

  get busy(): boolean {
    return this.tween !== null;
  }

  pose(): Pose {
    _off.copy(this.camera.position).sub(this.controls.target);
    _sph.setFromVector3(_off);
    return { target: this.controls.target.clone(), radius: _sph.radius, phi: _sph.phi, theta: _sph.theta };
  }

  /** Place the camera immediately. */
  set(target: THREE.Vector3, radius: number, phi: number, theta: number): void {
    this.tween?.resolve();
    this.tween = null;
    this.apply({ target, radius, phi, theta });
    this.controls.enabled = this.active;
    this.controls.update();
  }

  /** Smoothly move to a pose; resolves when the camera arrives. */
  animateTo(to: Pose, duration = 1.4, ease = easeInOut): Promise<void> {
    this.tween?.resolve();
    const from = this.pose();
    // shortest azimuth path
    let dt = to.theta - from.theta;
    dt = Math.atan2(Math.sin(dt), Math.cos(dt));
    to = { ...to, theta: from.theta + dt };
    this.controls.enabled = false;
    return new Promise((resolve) => {
      this.tween = { from, to, t: 0, duration: Math.max(0.01, duration), ease, resolve };
    });
  }

  /** Fly so `target` sits in view at `radius`, looking from azimuth `theta` (defaults: keep current). */
  flyTo(target: THREE.Vector3, opts: { radius?: number; phi?: number; theta?: number; duration?: number } = {}): Promise<void> {
    const cur = this.pose();
    const radius = opts.radius ?? 55;
    const dist = cur.target.distanceTo(target);
    const duration = opts.duration ?? THREE.MathUtils.clamp(0.9 + dist / 180, 1.0, 2.0);
    return this.animateTo({ target: target.clone(), radius, phi: opts.phi ?? 0.95, theta: opts.theta ?? cur.theta }, duration);
  }

  /** Swoop down toward a door: ends close and low, looking at the entrance (accelerating, for a fade-out). */
  approach(door: THREE.Vector3, facing: THREE.Vector3, duration = 1.1): Promise<void> {
    const theta = Math.atan2(facing.x, facing.z);
    return this.animateTo({ target: door.clone().setY(door.y + 1.4), radius: 7, phi: 1.32, theta }, duration, easeIn);
  }

  update(dt: number): void {
    const tw = this.tween;
    if (tw) {
      tw.t = Math.min(1, tw.t + dt / tw.duration);
      const e = tw.ease(tw.t);
      // arc: lift the radius a little mid-flight when travelling far
      const travel = tw.from.target.distanceTo(tw.to.target);
      const lift = Math.sin(Math.PI * e) * Math.min(60, travel * 0.25);
      this.apply({
        target: tw.from.target.clone().lerp(tw.to.target, e),
        radius: THREE.MathUtils.lerp(tw.from.radius, tw.to.radius, e) + lift,
        phi: THREE.MathUtils.lerp(tw.from.phi, tw.to.phi, e),
        theta: THREE.MathUtils.lerp(tw.from.theta, tw.to.theta, e),
      });
      if (tw.t >= 1) {
        this.tween = null;
        this.controls.enabled = this.active;
        this.controls.update();
        tw.resolve();
      }
      return;
    }
    if (!this.active) return;
    this.controls.update(dt);
    // keep the focus inside the town
    const t = this.controls.target;
    const cx = THREE.MathUtils.clamp(t.x, BOUNDS.x0, BOUNDS.x1);
    const cz = THREE.MathUtils.clamp(t.z, BOUNDS.z0, BOUNDS.z1);
    const cy = THREE.MathUtils.clamp(t.y, 0, 30);
    if (cx !== t.x || cz !== t.z || cy !== t.y) {
      const dx = cx - t.x, dz = cz - t.z, dy = cy - t.y;
      t.set(cx, cy, cz);
      this.camera.position.x += dx;
      this.camera.position.y += dy;
      this.camera.position.z += dz;
    }
  }

  private apply(p: Pose): void {
    this.controls.target.copy(p.target);
    _sph.set(p.radius, p.phi, p.theta);
    this.camera.position.setFromSpherical(_sph).add(p.target);
    this.camera.lookAt(p.target);
  }
}
