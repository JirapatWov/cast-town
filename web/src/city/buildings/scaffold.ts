// Construction scaffolding and dust for a project building that gains or loses a storey: galvanised standards in
// two rows, ledgers, transoms, timber boards per lift, guard rails and zig-zag braces, built around the footprint
// over the height range that changes. The group's origin is the scaffold base so it can spring up (scale.y).
import * as THREE from 'three';
import { haloTexture } from '../fx';
import type { CityMaterials } from '../materials';
import { Batch } from '../util/mesh-writer';
import { rng } from '../util/random';

const LIFT = 2.0;
const BAY = 2.1;

export interface ScaffoldArea {
  cx: number;
  cz: number;
  hw: number;
  hd: number;
}

export class Scaffold {
  readonly group = new THREE.Group();
  private puffs: { s: THREE.Sprite; delay: number; grow: number }[] = [];
  private puffMat: THREE.SpriteMaterial;

  /** `area` is the walls' half extents (local, lawn level); the scaffold spans y0..y1 (local). */
  constructor(area: ScaffoldArea, y0: number, y1: number, mats: CityMaterials, seed: number) {
    const r = rng(seed);
    const h = Math.max(LIFT, y1 - y0);
    const batch = new Batch();
    const tube = batch.writer(mats.frame);
    const board = batch.writer(mats.wood);
    tube.setColor([0.62, 0.64, 0.66]);
    const box = (x: number, y: number, z: number, w: number, hh: number, d: number) =>
      tube.box(new THREE.Matrix4().makeTranslation(x, y, z), w, hh, d);
    const T = 0.05;
    const inner = 0.55, outer = 1.35; // distance of the two rows of standards from the walls
    const lifts: number[] = [];
    for (let y = LIFT * 0.5; y <= h - 0.9; y += LIFT) lifts.push(y);
    // the four faces, each as a run along `a` at a fixed offset; corners wrap
    const faces = [
      { ax: 'x' as const, len: 2 * area.hw, c: area.cz + area.hd, sign: 1, mid: area.cx },
      { ax: 'x' as const, len: 2 * area.hw, c: area.cz - area.hd, sign: -1, mid: area.cx },
      { ax: 'z' as const, len: 2 * area.hd, c: area.cx + area.hw, sign: 1, mid: area.cz },
      { ax: 'z' as const, len: 2 * area.hd, c: area.cx - area.hw, sign: -1, mid: area.cz },
    ];
    for (const f of faces) {
      const run = f.len + 2 * outer;
      const bays = Math.max(2, Math.round(run / BAY));
      const P = (a: number, off: number, y: number): [number, number, number] =>
        f.ax === 'x' ? [f.mid + a, y, f.c + f.sign * off] : [f.c + f.sign * off, y, f.mid + a];
      const along = (a: number, off: number, y: number, len: number, t = T) => {
        const [x, yy, z] = P(a, off, y);
        if (f.ax === 'x') box(x, yy, z, len, t, t);
        else box(x, yy, z, t, t, len);
      };
      for (let b = 0; b <= bays; b++) {
        const a = -run / 2 + (b / bays) * run;
        for (const off of [inner, outer]) {
          const [x, , z] = P(a, off, 0);
          box(x, h / 2, z, T, h, T);
        }
        // transoms between the rows at every lift
        for (const y of lifts) {
          const [x, , z] = P(a, (inner + outer) / 2, y - 0.06);
          if (f.ax === 'x') box(x, y - 0.06, z, T, T, outer - inner + 0.1);
          else box(x, y - 0.06, z, outer - inner + 0.1, T, T);
        }
      }
      for (const y of lifts) {
        // ledgers, guard rails on the outside, boards
        along(0, inner, y - 0.06, run, T);
        along(0, outer, y - 0.06, run, T);
        along(0, outer, y + 0.55, run, T * 0.8);
        along(0, outer, y + 1.05, run, T * 0.8);
        for (let b = 0; b < bays; b++) {
          const a = -run / 2 + ((b + 0.5) / bays) * run;
          const tone = 0.85 + r() * 0.25;
          board.setColor([1.05 * tone, 0.86 * tone, 0.6 * tone]);
          const [x, yy, z] = P(a, (inner + outer) / 2, y);
          const bl = run / bays - 0.04;
          board.box(new THREE.Matrix4().makeTranslation(x, yy, z), f.ax === 'x' ? bl : outer - inner - 0.08, 0.045, f.ax === 'x' ? outer - inner - 0.08 : bl);
          // zig-zag brace on the outer face
          if (b % 2 === 0) {
            const a0 = -run / 2 + (b / bays) * run, a1 = -run / 2 + ((b + 1) / bays) * run;
            const ya = y - 0.06 - LIFT * 0.5 + 0.1, yb = y + LIFT * 0.5 - 0.15;
            if (ya < 0) continue;
            const pa = new THREE.Vector3(...P(a0, outer + 0.04, ya)), pb = new THREE.Vector3(...P(a1, outer + 0.04, yb));
            const len = pa.distanceTo(pb);
            const m = new THREE.Matrix4().lookAt(pa, pb, new THREE.Vector3(0, 1, 0)).setPosition(pa.clone().add(pb).multiplyScalar(0.5));
            tube.box(m, T * 0.8, T * 0.8, len);
          }
        }
      }
    }
    batch.build(this.group, 'scaffold');
    this.group.position.y = y0;
    this.group.traverse((o) => {
      o.raycast = () => {};
    });

    // dust: soft puffs that billow out around the base of the changing storeys
    this.puffMat = new THREE.SpriteMaterial({ map: haloTexture(), color: new THREE.Color(0.86, 0.82, 0.75), transparent: true, opacity: 0, depthWrite: false });
    for (let i = 0; i < 16; i++) {
      const s = new THREE.Sprite(this.puffMat.clone());
      const side = i % 4;
      const t = r() * 2 - 1;
      const x = side < 2 ? area.cx + t * area.hw : area.cx + (side === 2 ? 1 : -1) * (area.hw + 0.6);
      const z = side >= 2 ? area.cz + t * area.hd : area.cz + (side === 0 ? 1 : -1) * (area.hd + 0.6);
      s.position.set(x, y0 + 0.3 + r() * 1.2, z);
      s.raycast = () => {};
      s.visible = false;
      this.puffs.push({ s, delay: r() * 0.5, grow: 2.5 + r() * 2.5 });
    }
  }

  /** Puffs live in the building group (not the scaffold, which is scaled). */
  attachPuffs(parent: THREE.Object3D): void {
    for (const p of this.puffs) parent.add(p.s);
  }

  /** Dust over the first ~1.6 s from `t` = 0 (call with negative t before it starts). */
  updatePuffs(t: number): void {
    for (const p of this.puffs) {
      const k = (t - p.delay) / 1.4;
      const on = k > 0 && k < 1;
      p.s.visible = on;
      if (!on) continue;
      p.s.scale.setScalar(1.2 + p.grow * Math.sqrt(k));
      (p.s.material as THREE.SpriteMaterial).opacity = 0.42 * Math.sin(Math.PI * k) * (1 - k * 0.4);
    }
  }

  dispose(): void {
    this.group.removeFromParent();
    this.group.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    for (const p of this.puffs) {
      p.s.removeFromParent();
      (p.s.material as THREE.Material).dispose();
    }
    this.puffMat.dispose();
  }
}
