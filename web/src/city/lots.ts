// Empty lots: a "FOR SALE" sign, corner stakes and a subtle outline on the lawn. Each empty lot is clickable
// (lot:click). In placement mode the outlines pulse amber and a "Place here" chip floats over each lot.
import * as THREE from 'three';
import type { Lot } from '../../../shared/protocol';
import { additive, groundDecal, poolTexture } from './fx';
import { placeChip } from './labels';
import { LAWN_Y, lotToWorld } from './layout';
import type { CityMaterials } from './materials';
import { signTexture } from './textures';
import { Batch, type MeshWriter } from './util/mesh-writer';
import type { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

const AMBER = new THREE.Color('#F5A524');
const OUTLINE_IDLE = new THREE.Color(0xf1ecdf);

let forSaleTex: THREE.Texture | null = null;
function forSaleTexture(): THREE.Texture {
  return (forSaleTex ??= signTexture((g, w, h) => {
    g.fillStyle = '#fbf8f2';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#c8432f';
    g.fillRect(0, 0, w, h * 0.5);
    g.fillStyle = '#ffffff';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = '800 120px Inter, "Helvetica Neue", Arial, sans-serif';
    g.fillText('FOR SALE', w / 2, h * 0.27);
    g.fillStyle = '#2a2622';
    g.font = '600 58px Inter, "Helvetica Neue", Arial, sans-serif';
    g.fillText('place a project here', w / 2, h * 0.72);
    g.strokeStyle = '#2a2622';
    g.lineWidth = 10;
    g.strokeRect(5, 5, w - 10, h - 10);
  }, 1024, 400));
}

interface LotEntry {
  lot: Lot;
  pick: THREE.Mesh;
  chip: CSS2DObject;
}

export class LotMarkers {
  readonly group = new THREE.Group();
  private statics = new THREE.Group();
  private outlineMat = new THREE.MeshBasicMaterial({ color: OUTLINE_IDLE, transparent: true, opacity: 0.09, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
  private signMat: THREE.MeshStandardMaterial;
  private hoverFill: THREE.Mesh;
  private entries = new Map<string, LotEntry>();
  private key = '';
  private placement = false;
  private hovered: string | null = null;
  /** Idle outlines are unlit paint: they dim with the daylight instead of glowing at night. */
  private daylight = 1;

  constructor(private mats: CityMaterials, private onClick: (lotId: string) => void) {
    this.group.name = 'lots';
    this.group.add(this.statics);
    this.signMat = new THREE.MeshStandardMaterial({ map: forSaleTexture(), roughness: 0.55 });
    this.hoverFill = groundDecal(1, additive(poolTexture(), AMBER, 0.0));
    this.hoverFill.visible = false;
    this.group.add(this.hoverFill);
  }

  /** Rebuild markers when the set of empty lots changes. */
  setEmpty(lots: Lot[]): void {
    const key = lots.map((l) => l.id).sort().join(',');
    if (key === this.key) return;
    this.key = key;
    for (const e of this.entries.values()) {
      e.chip.removeFromParent();
      e.chip.element.remove();
      e.pick.removeFromParent();
      e.pick.geometry.dispose();
    }
    this.entries.clear();
    this.statics.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    this.statics.clear();

    const batch = new Batch();
    const outline = new THREE.Group();
    const posts = batch.writer(this.mats.wood);
    const metal = batch.writer(this.mats.metal);
    const tips = batch.writer(this.mats.trim, { cast: false });
    const faces: THREE.BufferGeometry[] = [];
    const lines: THREE.BufferGeometry[] = [];
    for (const lot of lots) {
      const m = new THREE.Matrix4().makeRotationY(lot.rotY).setPosition(lot.x, 0, lot.z);
      const hw = lot.width / 2 - 0.8, hd = lot.depth / 2 - 0.8;
      // outline: four thin strips just above the lawn
      for (const [x, z, w, d] of [[0, hd, 2 * hw, 0.1], [0, -hd, 2 * hw, 0.1], [hw, 0, 0.1, 2 * hd], [-hw, 0, 0.1, 2 * hd]] as const) {
        const g = new THREE.PlaneGeometry(w, d);
        g.rotateX(-Math.PI / 2);
        g.translate(x, LAWN_Y + 0.03, z);
        g.applyMatrix4(m);
        lines.push(g);
      }
      // corner stakes with orange tips
      for (const [x, z] of [[hw, hd], [-hw, hd], [hw, -hd], [-hw, -hd]]) {
        stake(posts, tips, m, x, z);
      }
      // sign: two posts + board, facing the street (local +Z)
      const sz = lot.depth / 2 - 2.2;
      posts.setColor([0.9, 0.85, 0.8]);
      for (const dx of [-1.15, 1.15]) posts.box(new THREE.Matrix4().makeTranslation(dx, LAWN_Y + 1.0, sz - 0.05).premultiply(m), 0.1, 2.0, 0.1);
      metal.box(new THREE.Matrix4().makeTranslation(0, LAWN_Y + 1.85, sz - 0.05).premultiply(m), 2.5, 0.05, 0.05);
      posts.setColor([0.75, 0.7, 0.66]);
      posts.box(new THREE.Matrix4().makeTranslation(0, LAWN_Y + 1.35, sz - 0.05).premultiply(m), 2.3, 0.94, 0.05);
      const f = new THREE.PlaneGeometry(2.24, 0.875);
      f.translate(0, LAWN_Y + 1.35, sz - 0.02);
      f.applyMatrix4(m);
      faces.push(f);

      // pick volume + placement chip
      const pick = new THREE.Mesh(new THREE.BoxGeometry(lot.width, 2.5, lot.depth), new THREE.MeshBasicMaterial({ visible: false }));
      pick.position.set(lot.x, 1.25, lot.z);
      pick.rotation.y = lot.rotY;
      pick.userData = { kind: 'lot', id: lot.id };
      this.group.add(pick);
      const chip = placeChip(() => this.onClick(lot.id), (on) => this.setHover(on ? lot.id : null));
      const c = lotToWorld(lot, 0, 0);
      chip.position.set(c.x, 3.2, c.z);
      chip.visible = this.placement;
      this.group.add(chip);
      this.entries.set(lot.id, { lot, pick, chip });
    }
    batch.build(this.statics, 'lots');
    if (faces.length) {
      const signs = new THREE.Mesh(mergeSimple(faces), this.signMat);
      signs.castShadow = true;
      signs.receiveShadow = true;
      this.statics.add(signs);
      const ol = new THREE.Mesh(mergeSimple(lines), this.outlineMat);
      ol.renderOrder = 1;
      ol.receiveShadow = false;
      outline.add(ol);
      this.statics.add(outline);
    }
    faces.forEach((g) => g.dispose());
    lines.forEach((g) => g.dispose());
    if (this.hovered && !this.entries.has(this.hovered)) this.setHover(null);
  }

  get pickables(): THREE.Object3D[] {
    return [...this.entries.values()].map((e) => e.pick);
  }

  has(lotId: string): boolean {
    return this.entries.has(lotId);
  }

  lots(): Lot[] {
    return [...this.entries.values()].map((e) => e.lot);
  }

  setPlacement(on: boolean): void {
    this.placement = on;
    for (const e of this.entries.values()) e.chip.visible = on;
  }

  setHover(lotId: string | null): void {
    this.hovered = lotId;
    const e = lotId ? this.entries.get(lotId) : undefined;
    this.hoverFill.visible = !!e;
    for (const x of this.entries.values()) x.chip.element.classList.toggle('is-hover', x.lot.id === lotId);
    if (e) {
      this.hoverFill.position.set(e.lot.x, LAWN_Y + 0.05, e.lot.z);
      const sideways = Math.abs(Math.sin(e.lot.rotY)) > 0.5;
      this.hoverFill.scale.set(sideways ? e.lot.depth : e.lot.width, 1, sideways ? e.lot.width : e.lot.depth);
    }
  }

  setNight(night: number): void {
    this.daylight = THREE.MathUtils.lerp(1, 0.12, night);
  }

  update(dt: number, t: number, camera?: THREE.Camera): void {
    if (this.placement && camera) {
      for (const e of this.entries.values()) {
        const far = camera.position.distanceTo(e.chip.position) > 150;
        e.chip.element.classList.toggle('is-far', far);
      }
    }
    const pulse = 0.5 + 0.5 * Math.sin(t * Math.PI * 2 * 0.9);
    if (this.placement) {
      this.outlineMat.color.copy(AMBER).multiplyScalar(1.4 + 1.6 * pulse);
      this.outlineMat.opacity = 0.75 + 0.25 * pulse;
    } else {
      this.outlineMat.color.copy(OUTLINE_IDLE).multiplyScalar(this.daylight);
      this.outlineMat.opacity = 0.09; // a faint survey line, not a white chalk frame
    }
    const fill = this.hoverFill.material as THREE.MeshBasicMaterial;
    const target = this.hoverFill.visible ? (this.placement ? 0.5 + 0.25 * pulse : 0.32) : 0;
    fill.opacity += (target - fill.opacity) * (1 - Math.exp(-dt * 10));
  }
}

function stake(posts: MeshWriter, tips: MeshWriter, m: THREE.Matrix4, x: number, z: number) {
  posts.setColor([0.95, 0.88, 0.78]);
  posts.box(new THREE.Matrix4().makeTranslation(x, LAWN_Y + 0.3, z).premultiply(m), 0.07, 0.6, 0.07);
  tips.setColor([1.0, 0.42, 0.08]);
  tips.box(new THREE.Matrix4().makeTranslation(x, LAWN_Y + 0.66, z).premultiply(m), 0.08, 0.12, 0.08);
}

/** Merge geometries that share position/normal/uv (PlaneGeometry pieces). */
function mergeSimple(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], idx: number[] = [];
  let base = 0;
  for (const g of geos) {
    const p = g.getAttribute('position'), n = g.getAttribute('normal'), t = g.getAttribute('uv');
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i));
      nor.push(n.getX(i), n.getY(i), n.getZ(i));
      uv.push(t.getX(i), t.getY(i));
    }
    const index = g.getIndex()!;
    for (let i = 0; i < index.count; i++) idx.push(base + index.getX(i));
    base += p.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  out.setIndex(idx);
  out.computeBoundingSphere();
  return out;
}
