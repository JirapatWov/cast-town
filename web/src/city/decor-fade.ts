// Decor buildings that stand between the camera and a user's house turn into faint glass outlines (finding #63: a
// cottage behind two apartment blocks, a house behind a 4-storey shop). The town's decor is merged into one mesh per
// material (a handful of draw calls); each decor building is a contiguous index range in those meshes, so fading one
// only splits its meshes into groups — its range drawn with a see-through ghost material — and costs extra draw calls
// only while something is faded. Its shadow stays, so the light doesn't jump.
// The pure parts (segment vs box, which decor hides what, the hold before it comes back) are exported for tests.
import * as THREE from 'three';

/** A decor building's oriented box on the ground: centre, half extents along its local X/Z, rotation about Y, height. */
export interface DecorBox {
  x: number;
  z: number;
  hw: number;
  hd: number;
  rotY: number;
  top: number;
}

type P3 = { x: number; y: number; z: number };

/** Does the segment a→b pass through the box (slab test in the box's own frame)? Ends inside count. */
export function segmentHitsBox(a: P3, b: P3, box: DecorBox): boolean {
  const c = Math.cos(-box.rotY), s = Math.sin(-box.rotY);
  const local = (p: P3): [number, number, number] => {
    const dx = p.x - box.x, dz = p.z - box.z;
    return [dx * c + dz * s, p.y, -dx * s + dz * c];
  };
  const p = local(a), q = local(b);
  const lo = [-box.hw, 0, -box.hd], hi = [box.hw, box.top, box.hd];
  let t0 = 0, t1 = 1;
  for (let i = 0; i < 3; i++) {
    const d = q[i]! - p[i]!;
    if (Math.abs(d) < 1e-9) {
      if (p[i]! < lo[i]! || p[i]! > hi[i]!) return false;
      continue;
    }
    let ta = (lo[i]! - p[i]!) / d, tb = (hi[i]! - p[i]!) / d;
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
    if (t0 > t1) return false;
  }
  return true;
}

/** Indices of the decor boxes that hide any of the targets (house points) from the eye. */
export function occluders(eye: P3, targets: readonly P3[], boxes: readonly DecorBox[]): Set<number> {
  const out = new Set<number>();
  for (const t of targets) {
    boxes.forEach((box, i) => {
      if (!out.has(i) && segmentHitsBox(eye, t, box)) out.add(i);
    });
  }
  return out;
}

/** Which decor is faded: at once when it hides a house, back only after it has hidden nothing for `holdS` seconds
 *  (no flicker while the camera glides past an edge). */
export class FadeHold {
  private readonly clear: number[];
  readonly faded = new Set<number>();

  constructor(count: number, private readonly holdS = 0.6) {
    this.clear = new Array(count).fill(Infinity);
  }

  /** dt since the last step; `hiding`: what hides a house now. Returns true when the faded set changed. */
  step(dt: number, hiding: Set<number>): boolean {
    let changed = false;
    for (let i = 0; i < this.clear.length; i++) {
      if (hiding.has(i)) {
        this.clear[i] = 0;
        if (!this.faded.has(i)) {
          this.faded.add(i);
          changed = true;
        }
      } else if (this.faded.has(i)) {
        this.clear[i]! += dt;
        if (this.clear[i]! >= this.holdS) {
          this.faded.delete(i);
          changed = true;
        }
      }
    }
    return changed;
  }

  reset(): boolean {
    const had = this.faded.size > 0;
    this.faded.clear();
    this.clear.fill(Infinity);
    return had;
  }
}

/** One decor building as written into the town batch: its footprint, its index range per material, and its separate
 *  objects (a shop's sign). */
export interface DecorPart {
  footprint: Omit<DecorBox, 'top'>;
  ranges: Map<THREE.Material, [number, number]>;
  extras: THREE.Object3D[];
}

/** Balconies, canopies and awnings stick out of the footprint a little. */
const REACH = 1.0;

const CHECK_S = 0.12;
const _eye = new THREE.Vector3();
const _ndc = new THREE.Vector3();

export class DecorFade {
  private readonly hold: FadeHold;
  /** The parts' boxes (footprint plus reach, up to their highest point). */
  readonly boxes: DecorBox[];
  /** Town meshes that hold decor, with their own material and each part's range in them. */
  private readonly meshes: { mesh: THREE.Mesh; own: THREE.Material; ranges: ([number, number] | undefined)[] }[] = [];
  private readonly ghost = new THREE.MeshBasicMaterial({ name: 'decor-ghost', color: 0xe8eef5, transparent: true, opacity: 0.08, depthWrite: false });
  private since = CHECK_S;
  private lastEye = new THREE.Vector3(Infinity, 0, 0);
  private lastTargets = '';
  private hiding = new Set<number>();

  constructor(private readonly parts: DecorPart[], townMeshes: THREE.Mesh[]) {
    this.hold = new FadeHold(parts.length);
    const tops = parts.map(() => 0);
    for (const mesh of townMeshes) {
      const own = mesh.material as THREE.Material;
      const ranges = parts.map((p) => p.ranges.get(own));
      if (!ranges.some(Boolean)) continue;
      this.meshes.push({ mesh, own, ranges });
      // each part's height, from what it wrote (the town meshes sit at the origin, unrotated)
      const pos = mesh.geometry.getAttribute('position');
      const index = mesh.geometry.index;
      ranges.forEach((r, i) => {
        if (!r) return;
        for (let k = r[0]; k < r[1]; k++) tops[i] = Math.max(tops[i]!, pos.getY(index ? index.getX(k) : k));
      });
    }
    this.boxes = parts.map((p, i) => ({ ...p.footprint, hw: p.footprint.hw + REACH, hd: p.footprint.hd + REACH, top: tops[i]! }));
  }

  /** targets: the user's houses (a point in each); off: driving and the like — every decor building solid. */
  update(dt: number, camera: THREE.Camera, targets: readonly THREE.Vector3[], off = false): void {
    if (off) {
      if (this.hold.reset()) this.apply();
      return;
    }
    this.since += dt;
    if (this.since < CHECK_S) return;
    const step = this.since;
    this.since = 0;
    camera.getWorldPosition(_eye);
    // only houses on screen count (a decor building may hide one that is behind the camera's back)
    const seen = targets.filter((t) => {
      _ndc.copy(t).project(camera);
      return _ndc.z < 1 && Math.abs(_ndc.x) < 1.15 && Math.abs(_ndc.y) < 1.15;
    });
    const key = seen.map((t) => `${t.x.toFixed(1)},${t.y.toFixed(1)},${t.z.toFixed(1)}`).join(';');
    // a still camera keeps what it found last time (only the hold runs on)
    if (_eye.distanceToSquared(this.lastEye) > 0.01 || key !== this.lastTargets) this.hiding = occluders(_eye, seen, this.boxes);
    this.lastEye.copy(_eye);
    this.lastTargets = key;
    if (this.hold.step(step, this.hiding)) this.apply();
  }

  get faded(): ReadonlySet<number> {
    return this.hold.faded;
  }

  private apply(): void {
    const faded = this.hold.faded;
    for (const { mesh, own, ranges } of this.meshes) {
      const geo = mesh.geometry;
      const cut = ranges.filter((r, i): r is [number, number] => !!r && faded.has(i)).sort((a, b) => a[0] - b[0]);
      geo.clearGroups();
      if (!cut.length) {
        mesh.material = own;
        continue;
      }
      const count = geo.index ? geo.index.count : geo.getAttribute('position').count;
      let at = 0;
      for (const [s, e] of cut) {
        if (s > at) geo.addGroup(at, s - at, 0);
        geo.addGroup(s, e - s, 1);
        at = e;
      }
      if (at < count) geo.addGroup(at, count - at, 0);
      mesh.material = [own, this.ghost];
    }
    this.parts.forEach((p, i) => {
      for (const o of p.extras) o.visible = !faded.has(i);
    });
  }
}
