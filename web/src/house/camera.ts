// Dollhouse orbit camera: left-drag rotate, wheel zoom, right-drag / shift-drag pan along the floor.
// Pitch and zoom are clamped and the target stays inside the house, so the user can never get lost.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CAMERA_HOME, ROOM } from './layout';

const DEG = Math.PI / 180;

/** three's OrbitControls.disconnect() sets the element's touch-action back to '' (auto). The canvas is shared with the
 *  city, whose MapControls stay connected: with touch-action auto the browser takes one-finger drags (pointercancel
 *  after the first move) and pinches (page zoom) away from the 3D camera. The canvas never wants browser touch
 *  gestures, so put 'none' back every time. */
export function keepTouchAction(el: HTMLElement | SVGElement | null | undefined) {
  if (el) el.style.touchAction = 'none';
}

export class HouseCamera {
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  /** Time (performance.now) of the last user interaction — auto camera moves must respect it. */
  lastInteraction = 0;
  /** ≥ 1 on screens narrower than 16:9 whose (capped) field of view can't show a 16:9 framing's width: framings
   *  pull back by this much so a room — or the whole floor — still fits across a portrait phone. */
  fit = 1;
  /** Height of the floor on show: the orbit target stays between it and 1.6 m above it. */
  private base = 0;
  private tween: {
    t0: number; ms: number;
    fromT: THREE.Vector3; toT: THREE.Vector3;
    fromS: THREE.Spherical; toS: THREE.Spherical;
    toBase: number;
    resolve: () => void;
  } | null = null;

  constructor(dom: HTMLElement) {
    // the orbit never comes closer than 5 m, so a 0.3 m near plane costs nothing and buys depth precision
    this.camera = new THREE.PerspectiveCamera(38, 16 / 9, 0.3, 200);
    const c = new OrbitControls(this.camera, dom);
    c.enableDamping = true;
    c.dampingFactor = 0.09;
    c.screenSpacePanning = false; // pan slides along the floor
    c.minDistance = CAMERA_HOME.minDistance;
    c.maxDistance = CAMERA_HOME.maxDistance;
    c.minPolarAngle = (90 - CAMERA_HOME.maxElevationDeg) * DEG;
    c.maxPolarAngle = (90 - CAMERA_HOME.minElevationDeg) * DEG;
    c.rotateSpeed = 0.6;
    c.zoomSpeed = 0.9;
    c.panSpeed = 0.8;
    c.zoomToCursor = true;
    c.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    c.addEventListener('start', () => {
      this.lastInteraction = performance.now();
      this.finishTween(false); // the user grabbed the camera: stop flying, stay where we are
    });
    c.addEventListener('change', () => this.clampTarget());
    this.controls = c;
    c.disconnect();
    keepTouchAction(dom);
    this.home();
  }

  get floorBase(): number {
    return this.base;
  }

  /** Jump to a floor height (no animation), keeping the framing relative to the floor. */
  setBase(y: number) {
    this.finishTween(true);
    const dy = y - this.base;
    this.base = y;
    this.controls.target.y += dy;
    this.camera.position.y += dy;
    this.controls.update();
  }

  /** Fly to an orbit (target + spherical angles) over `ms`, ending with the floor base at `base`. */
  flyTo(opts: { base: number; target?: THREE.Vector3Like; azimuthDeg?: number; elevationDeg?: number; distance?: number; ms?: number }): Promise<void> {
    this.finishTween(true);
    const fromT = this.controls.target.clone();
    const fromS = new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(fromT));
    const toT = opts.target ? new THREE.Vector3(opts.target.x, opts.target.y, opts.target.z) : fromT.clone().setY(fromT.y + opts.base - this.base);
    const toS = fromS.clone();
    if (opts.distance !== undefined) toS.radius = opts.distance;
    if (opts.elevationDeg !== undefined) toS.phi = (90 - opts.elevationDeg) * DEG;
    if (opts.azimuthDeg !== undefined) {
      toS.theta = opts.azimuthDeg * DEG;
      // take the short way round
      while (toS.theta - fromS.theta > Math.PI) toS.theta -= 2 * Math.PI;
      while (toS.theta - fromS.theta < -Math.PI) toS.theta += 2 * Math.PI;
    }
    const ms = opts.ms ?? 700;
    if (ms <= 0) {
      this.base = opts.base;
      this.applyOrbit(toT, toS);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.tween = { t0: performance.now(), ms, fromT, toT, fromS, toS, toBase: opts.base, resolve };
    });
  }

  private applyOrbit(t: THREE.Vector3, s: THREE.Spherical) {
    this.controls.target.copy(t);
    this.camera.position.setFromSpherical(s).add(t);
    this.camera.lookAt(t);
    this.controls.update();
  }

  private finishTween(complete: boolean) {
    const tw = this.tween;
    if (!tw) return;
    this.tween = null;
    this.base = tw.toBase; // first: applying the orbit re-clamps the target to the floor
    if (complete) this.applyOrbit(tw.toT, tw.toS);
    else this.clampTarget();
    tw.resolve();
  }

  /** Reset to the framing that shows the whole floor. */
  home() {
    const h = CAMERA_HOME;
    const t = new THREE.Vector3(h.target.x, h.target.y + this.base, h.target.z);
    const az = h.azimuthDeg * DEG, el = h.elevationDeg * DEG;
    const d = h.distance * this.fit;
    this.camera.position.set(
      t.x + d * Math.cos(el) * Math.sin(az),
      t.y + d * Math.sin(el),
      t.z + d * Math.cos(el) * Math.cos(az),
    );
    this.controls.target.copy(t);
    this.camera.lookAt(t);
    this.controls.update();
  }

  /** Set an explicit orbit (dev harness / screenshots). */
  orbit(azimuthDeg: number, elevationDeg: number, distance: number, target?: THREE.Vector3Like) {
    const t = target ? new THREE.Vector3(target.x, target.y, target.z) : this.controls.target.clone();
    const az = azimuthDeg * DEG, el = elevationDeg * DEG;
    this.camera.position.set(t.x + distance * Math.cos(el) * Math.sin(az), t.y + distance * Math.sin(el), t.z + distance * Math.cos(el) * Math.cos(az));
    this.controls.target.copy(t);
    this.controls.update();
  }

  connect(dom: HTMLElement) { this.controls.connect(dom); }
  disconnect() {
    this.controls.disconnect();
    keepTouchAction(this.controls.domElement);
  }

  private fovAspect = 0;

  setAspect(aspect: number) {
    // the engine also writes camera.aspect on resize/setView, so track the aspect the FOV was fitted to
    if (Math.abs(this.camera.aspect - aspect) > 1e-3 || Math.abs(this.fovAspect - aspect) > 1e-3) {
      this.fovAspect = aspect;
      this.camera.aspect = aspect;
      // Keep the horizontal field of view of a 16:9 screen on narrower ones (tablets, phones in portrait),
      // so the whole floor stays in frame instead of a narrow slice of it.
      const base = 38 * DEG;
      const hHalf = Math.atan(Math.tan(base / 2) * (16 / 9));
      const v = aspect >= 16 / 9 ? base : Math.min(66 * DEG, 2 * Math.atan(Math.tan(hHalf) / aspect));
      this.camera.fov = v / DEG;
      this.camera.updateProjectionMatrix();
      // what the FOV cap leaves out of the width is made up by distance (bounded: people must stay visible)
      const shownHalf = Math.atan(Math.tan(v / 2) * aspect);
      this.fit = THREE.MathUtils.clamp(Math.tan(hHalf) / Math.tan(shownHalf), 1, 1.6);
      this.controls.maxDistance = CAMERA_HOME.maxDistance * this.fit;
    }
  }

  update() {
    const tw = this.tween;
    if (tw) {
      const k = Math.min(1, (performance.now() - tw.t0) / tw.ms);
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2; // easeInOutCubic
      const t = tw.fromT.clone().lerp(tw.toT, e);
      const s = new THREE.Spherical(
        THREE.MathUtils.lerp(tw.fromS.radius, tw.toS.radius, e),
        THREE.MathUtils.lerp(tw.fromS.phi, tw.toS.phi, e),
        THREE.MathUtils.lerp(tw.fromS.theta, tw.toS.theta, e),
      );
      this.controls.target.copy(t);
      this.camera.position.setFromSpherical(s).add(t);
      if (k >= 1) this.finishTween(true);
      else this.camera.lookAt(t);
    }
    this.controls.update();
  }

  private clampTarget() {
    if (this.tween) return; // flying between floors / rooms
    const t = this.controls.target;
    const cx = THREE.MathUtils.clamp(t.x, -ROOM.halfW + 1, ROOM.halfW - 1);
    const cz = THREE.MathUtils.clamp(t.z, -ROOM.halfD + 1, ROOM.halfD - 1);
    const cy = THREE.MathUtils.clamp(t.y, this.base, this.base + 1.6);
    if (cx !== t.x || cy !== t.y || cz !== t.z) {
      const d = new THREE.Vector3(cx - t.x, cy - t.y, cz - t.z);
      t.add(d);
      this.camera.position.add(d);
    }
  }
}
