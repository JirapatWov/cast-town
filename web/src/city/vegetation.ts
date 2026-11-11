// Vegetation placement API used by the town planner, the park and the building gardens. Trees and shrubs become
// instances of the tree system (real branching trees with leaf-sprig cards, LODs and wind, see trees/); clipped
// hedges are leafy boxes with sprig "fuzz" breaking their outline; flowers are blossom cards over leafy tufts.
// Hedges and flowers are static and merged (one draw call per material per batch).
import * as THREE from 'three';
import type { CityMaterials } from './materials';
import type { TreeSystem } from './trees';
import { staticPlant } from './trees/static';
import type { SpeciesId } from './trees/species';
import { Batch, type MeshWriter } from './util/mesh-writer';
import { range, rng, valueNoise3 } from './util/random';

/** 'far' / 'farConifer': countryside trees beyond the town edge (they don't cast shadows from afar). */
export type TreeKind = 'broadleaf' | 'columnar' | 'conifer' | 'far' | 'farConifer';

/** A tree or shrub to be instanced (coordinates in the space of whoever collected it). */
export interface PlantPlacement {
  species: SpeciesId;
  x: number;
  y: number;
  z: number;
  scale: number;
  rotY: number;
  cast: boolean;
  tint?: [number, number, number];
}

interface Hedge {
  x: number;
  y: number;
  z: number;
  len: number;
  rotY: number;
  h: number;
  w: number;
}

interface Flower {
  x: number;
  y: number;
  z: number;
  s: number;
  c: THREE.Color;
}

const AUTUMN_TINTS: [number, number, number][] = [[1, 1, 1], [1.08, 0.78, 0.55], [1.12, 0.62, 0.4]];

function hedgeGeometry(): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(1, 1, 1, 10, 4, 3);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const p = new THREE.Vector3();
  const colors: number[] = [];
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    // rounded top edges + lumpiness
    if (p.y > 0.49) p.y -= Math.max(Math.abs(p.z) - 0.28, 0) * 0.7;
    p.x += valueNoise3(p.x * 6, p.y * 6, p.z * 6) * 0.02;
    p.z += valueNoise3(p.x * 5 + 3, p.y * 5, p.z * 5) * 0.06;
    p.y += valueNoise3(p.x * 4 + 7, p.y * 4, p.z * 4) * 0.03;
    pos.setXYZ(i, p.x, p.y + 0.5, p.z);
    const ao = 0.45 + 0.6 * (p.y + 0.5);
    colors.push(ao, ao, ao);
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  g.computeVertexNormals();
  return g;
}

let hedgeGeo: THREE.BufferGeometry | null = null;

export class Vegetation {
  private plants: PlantPlacement[] = [];
  private hedges: Hedge[] = [];
  private flowers: Flower[] = [];
  private r = rng(4242);
  /** Trunk/canopy circles for car collisions. */
  readonly colliders: { x: number; z: number; r: number }[] = [];

  addTree(kind: TreeKind, x: number, z: number, y: number, scale = 1, opts: { autumn?: boolean; collide?: boolean } = {}): void {
    const r = this.r;
    const s = scale * range(r, 0.85, 1.15);
    let species: SpeciesId;
    let tint: [number, number, number] | undefined;
    if (kind === 'conifer' || kind === 'farConifer') species = 'pine';
    else if (kind === 'columnar') species = 'poplar';
    else if (opts.autumn) {
      species = 'aspen';
      tint = AUTUMN_TINTS[Math.floor(r() * AUTUMN_TINTS.length)];
    } else species = r() < 0.56 ? 'oak' : 'ash';
    const far = kind === 'far' || kind === 'farConifer';
    this.plants.push({ species, x, y, z, scale: s, rotY: r() * Math.PI * 2, cast: !far, tint });
    if (opts.collide !== false && !far) this.colliders.push({ x, z, r: 0.45 * s });
  }

  addShrub(x: number, z: number, y: number, scale = 1): void {
    const s = scale * range(this.r, 0.8, 1.2);
    this.plants.push({ species: 'shrub', x, y: y - 0.05 * s, z, scale: s, rotY: this.r() * Math.PI * 2, cast: true });
  }

  addHedge(x: number, z: number, y: number, len: number, rotY: number, h = 1.1, w = 0.8): void {
    this.hedges.push({ x, y, z, len, rotY, h, w });
  }

  addFlower(x: number, z: number, y: number, color: number): void {
    this.flowers.push({ x, y, z, s: range(this.r, 0.75, 1.2), c: new THREE.Color(color) });
  }

  /** Town level: trees and shrubs become tree-system instances; hedges and flowers are merged into one group. */
  build(mats: CityMaterials, trees: TreeSystem): THREE.Group {
    const rnd = rng(9090);
    for (const p of this.plants) {
      trees.add(p.species, p.x, p.y, p.z, p.scale, rnd, { cast: p.cast, rotY: p.rotY, tint: p.tint && new THREE.Color(...p.tint) });
    }
    const group = new THREE.Group();
    group.name = 'vegetation';
    const batch = new Batch();
    this.writeStatic(batch, mats);
    batch.build(group, 'vegetation');
    return group;
  }

  /**
   * Building gardens: hedges and flowers are merged into `batch`. Trees and shrubs go to `sink` when given (the city
   * instances them, with wind and LODs); otherwise (planters on storeys and roofs, which move when floors are added)
   * they are merged as static card plants.
   */
  mergeInto(batch: Batch, mats: CityMaterials, sink?: PlantPlacement[]): void {
    this.writeStatic(batch, mats);
    if (sink) {
      sink.push(...this.plants);
      return;
    }
    const leaves = batch.writer(mats.foliage);
    const bark = batch.writer(mats.bark);
    for (const p of this.plants) {
      const g = staticPlant(p.species);
      const m = new THREE.Matrix4().compose(
        new THREE.Vector3(p.x, p.y, p.z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, p.rotY, 0)), new THREE.Vector3(p.scale, p.scale, p.scale),
      );
      const c = g.leafColor;
      const t = p.tint ?? [1, 1, 1];
      leaves.setColor([c[0] * t[0], c[1] * t[1], c[2] * t[2]]);
      leaves.geometry(g.leaves, m);
      bark.setColor([1, 1, 1]);
      bark.geometry(g.bark, m);
    }
  }

  private writeStatic(batch: Batch, mats: CityMaterials): void {
    if (this.hedges.length) {
      const core = batch.writer(mats.hedge);
      const fuzz = batch.writer(mats.hedgeFuzz, { cast: false });
      for (const h of this.hedges) this.writeHedge(core, fuzz, h);
    }
    if (this.flowers.length) {
      const w = batch.writer(mats.flower, { cast: false });
      for (const f of this.flowers) this.writeFlower(w, f);
    }
  }

  private writeHedge(core: MeshWriter, fuzz: MeshWriter, h: Hedge): void {
    const geo = (hedgeGeo ??= hedgeGeometry());
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, h.rotY, 0));
    const m = new THREE.Matrix4().compose(new THREE.Vector3(h.x, h.y, h.z), q, new THREE.Vector3(h.len, h.h, h.w));
    core.setColor([1, 1, 1]);
    core.geometry(geo, m);
    // sprig cards poking out of the top and both long sides (breaks the perfect box outline)
    const r = rng(Math.floor(h.x * 13 + h.z * 7 + h.len * 3) >>> 0);
    const n = Math.round(h.len * (h.h + h.w) * 4.2);
    const ax = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    const az = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    const up = new THREE.Vector3(0, 1, 0);
    const base = new THREE.Vector3(h.x, h.y, h.z);
    const c = new THREE.Vector3(), nrm = new THREE.Vector3(), t1 = new THREE.Vector3(), t2 = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      const along = (r() - 0.5) * (h.len - 0.2);
      const face = r();
      if (face < 0.4) {
        // top
        c.copy(base).addScaledVector(ax, along).addScaledVector(az, (r() - 0.5) * h.w * 0.8).addScaledVector(up, h.h - 0.04);
        nrm.copy(up);
      } else {
        const side = face < 0.7 ? 1 : -1;
        c.copy(base).addScaledVector(ax, along).addScaledVector(az, side * h.w * 0.5).addScaledVector(up, h.h * (0.25 + r() * 0.7));
        nrm.copy(az).multiplyScalar(side);
      }
      const size = 0.32 + r() * 0.22;
      const yaw = r() * Math.PI * 2;
      // card plane: roughly perpendicular to the surface, leaning outward
      t1.set(Math.cos(yaw), 0, Math.sin(yaw));
      t2.copy(nrm).multiplyScalar(0.8).addScaledVector(up, 0.5).normalize();
      if (Math.abs(t1.dot(t2)) > 0.9) t1.set(-t2.z, 0, t2.x).normalize();
      const o = c.clone().addScaledVector(nrm, -0.08);
      const a = o.clone().addScaledVector(t1, -size / 2), b = o.clone().addScaledVector(t1, size / 2);
      const d = a.clone().addScaledVector(t2, size), e = b.clone().addScaledVector(t2, size);
      const shade = 0.75 + r() * 0.3;
      fuzz.setColor([0.5 * shade, 0.6 * shade, 0.4 * shade]);
      const n0 = nrm.clone().addScaledVector(up, 0.4).normalize();
      const i0 = fuzz.vertex(a.x, a.y, a.z, n0.x, n0.y, n0.z, 0, 0);
      fuzz.vertex(b.x, b.y, b.z, n0.x, n0.y, n0.z, 1, 0);
      fuzz.vertex(e.x, e.y, e.z, n0.x, n0.y, n0.z, 1, 1);
      fuzz.vertex(d.x, d.y, d.z, n0.x, n0.y, n0.z, 0, 1);
      fuzz.indices(i0, i0 + 1, i0 + 2, i0, i0 + 2, i0 + 3);
    }
  }

  private writeFlower(w: MeshWriter, f: Flower): void {
    const s = f.s;
    const r = this.r;
    const yaw = r() * Math.PI;
    const ca = Math.cos(yaw), sa = Math.sin(yaw);
    const quad = (p: THREE.Vector3[], u0: number, u1: number, color: [number, number, number]) => {
      w.setColor(color);
      const i0 = w.vertex(p[0].x, p[0].y, p[0].z, 0, 1, 0, u0, 0);
      w.vertex(p[1].x, p[1].y, p[1].z, 0, 1, 0, u1, 0);
      w.vertex(p[2].x, p[2].y, p[2].z, 0, 1, 0, u1, 1);
      w.vertex(p[3].x, p[3].y, p[3].z, 0, 1, 0, u0, 1);
      w.indices(i0, i0 + 1, i0 + 2, i0, i0 + 2, i0 + 3);
    };
    const V = (x: number, y: number, z: number) => new THREE.Vector3(f.x + x, f.y + y, f.z + z);
    const t = 0.2 * s, th = 0.26 * s, R = 0.24 * s;
    const green: [number, number, number] = [0.8 + r() * 0.3, 0.85 + r() * 0.3, 0.75];
    // leafy rosette: a flat card and two crossed upright ones (rosette seen from the side reads as a fan of leaves)
    quad([V(-R * ca + R * sa, 0.06 * s, -R * sa - R * ca), V(R * ca + R * sa, 0.06 * s, R * sa - R * ca), V(R * ca - R * sa, 0.06 * s, R * sa + R * ca), V(-R * ca - R * sa, 0.06 * s, -R * sa + R * ca)], 0.5, 1, green);
    quad([V(-ca * t, -0.04, -sa * t), V(ca * t, -0.04, sa * t), V(ca * t, th, sa * t), V(-ca * t, th, -sa * t)], 0.5, 1, green);
    quad([V(sa * t, -0.04, -ca * t), V(-sa * t, -0.04, ca * t), V(-sa * t, th, ca * t), V(sa * t, th, -ca * t)], 0.5, 1, green);
    // blossoms: a flat card on top and a tilted one
    const col: [number, number, number] = [f.c.r, f.c.g, f.c.b];
    const b = 0.2 * s, y = th * 0.8;
    quad([V(-b * ca - b * sa, y, -b * sa + b * ca), V(b * ca - b * sa, y, b * sa + b * ca), V(b * ca + b * sa, y, b * sa - b * ca), V(-b * ca + b * sa, y, -b * sa - b * ca)], 0, 0.5, col);
    quad([V(-b * sa, y - 0.08 * s, b * ca), V(b * sa, y - 0.08 * s, -b * ca), V(b * sa + 0.1 * s * ca, y + 0.12 * s, -b * ca + 0.1 * s * sa), V(-b * sa + 0.1 * s * ca, y + 0.12 * s, b * ca + 0.1 * s * sa)], 0, 0.5, col);
  }
}
