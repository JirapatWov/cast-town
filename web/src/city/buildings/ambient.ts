// Decorative town buildings from AMBIENT: apartments (balconies), corner shops (shopfront, awning, sign) and
// brick townhouses (stoops, lintels). All merged into the shared batch.
import * as THREE from 'three';
import { AMBIENT, type AmbientBuilding } from '../../../../shared/city-layout';
import type { DecorPart } from '../decor-fade';
import { DEFAULT_WALL_STYLE, type Opening, type WallStyle, windowGrid } from '../facade';
import { LAWN_Y, type Footprint } from '../layout';
import { type CityMaterials, TEX_MEAN, tint } from '../materials';
import { signTexture } from '../textures';
import { type Batch, trs } from '../util/mesh-writer';
import { pick, rng } from '../util/random';
import { balcony, band, flatRoof, type KitWriters, kitWriters, rooftop, type Side, sideFrames, shell } from './kit';

const PLASTER_COLORS = [0xf3eadb, 0xeedfc3, 0xe8d2ac, 0xe3bf9c, 0xd2d5bd, 0xf0e2b8, 0xeed9c7, 0xe9e4d6];
const BRICK_TINTS: [number, number, number][] = [[1, 1, 1], [0.86, 0.8, 0.78], [1.1, 1.0, 0.94], [0.95, 0.88, 0.86]];
const DOOR_PAINTS = [0x22324a, 0x5b1f24, 0x234236, 0x1d1d1f, 0x6b4a2b, 0x3c4f63];
const AWNING_COLORS = [0x2f5a49, 0x9a3b2c, 0x2c3e5c, 0xc79a3a];
const SHOP_NAMES: [string, string][] = [['Lumen', 'CAFÉ · BAKERY'], ['Pages', 'BOOKS & PAPER'], ['Fern', 'FLOWERS'], ['Corner', 'GROCER']];

const lin = (hex: number): [number, number, number] => {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
};

export interface AmbientResult {
  footprints: Footprint[];
  extras: THREE.Object3D[];
  /** Each building's slice of the batch, so one can be faded when it hides a house (decor-fade.ts). */
  parts: DecorPart[];
}

const pickTile = (r: () => number, office = false) => () => (office ? 6 : pick(r, [0, 0, 1, 2, 3, 4, 5, 7, 1, 0]));
const pickLit = (r: () => number, p: number) => () => (r() < p ? 0.6 + r() * 0.4 : 0);

export function buildAmbient(batch: Batch, mats: CityMaterials): AmbientResult {
  const plasterKit = kitWriters(batch, mats, 'plaster');
  const brickKit = kitWriters(batch, mats, 'brick');
  const footprints: Footprint[] = [];
  const extras: THREE.Object3D[] = [];
  const parts: DecorPart[] = [];
  AMBIENT.forEach((b, i) => {
    const r = rng(1000 + i * 77);
    const m = trs(b.x, LAWN_Y, b.z, b.rotY);
    const before = batch.indexCounts();
    const own: THREE.Object3D[] = [];
    if (b.kind === 'apartment') {
      const isBrick = r() < 0.3;
      apartment(isBrick ? brickKit : plasterKit, isBrick, m, b, r);
    }
    else if (b.kind === 'shop') own.push(shop(plasterKit, m, b, r, i));
    else townhouse(brickKit, m, b, r);
    extras.push(...own);
    const ranges = new Map<THREE.Material, [number, number]>();
    for (const [mat, n] of batch.indexCounts()) {
      const from = before.get(mat) ?? 0;
      if (n > from) ranges.set(mat, [from, n]);
    }
    parts.push({ footprint: { x: b.x, z: b.z, hw: b.width / 2, hd: b.depth / 2, rotY: b.rotY }, ranges, extras: own });
    footprints.push({ x: b.x, z: b.z, hw: b.width / 2 + 0.3, hd: b.depth / 2 + 0.3, rotY: b.rotY });
  });
  return { footprints, extras, parts };
}

function wallTint(k: KitWriters, r: () => number, brick: boolean): [number, number, number] {
  const t = brick ? pick(r, BRICK_TINTS) : tint(pick(r, PLASTER_COLORS), TEX_MEAN.plaster);
  k.wall.setColor(t);
  return t;
}

function apartment(k: KitWriters, isBrick: boolean, m: THREE.Matrix4, b: AmbientBuilding, r: () => number) {
  const W = b.width, D = b.depth;
  const groundH = 3.8, floorH = 3.1;
  const H = groundH + (b.floors - 1) * floorH;
  const t = wallTint(k, r, isBrick);
  const style: WallStyle = { ...DEFAULT_WALL_STYLE, frameColor: r() < 0.5 ? [0.92, 0.92, 0.9] : [0.12, 0.13, 0.14] };
  const tiles = pickTile(r), lit = pickLit(r, 0.5);
  const openings = (side: Side, L: number): Opening[] => {
    const upper = windowGrid(L, { floors: b.floors - 1, floorH, baseV: groundH, winW: 1.4, winH: 1.75, sillH: 0.8, margin: 1.2, spacing: 3.0 }, tiles, lit);
    if (side !== 'front') {
      return [...upper, ...windowGrid(L, { floors: 1, floorH: groundH, baseV: 0, winW: 1.4, winH: 1.9, sillH: 1.0, margin: 1.2, spacing: 3.0 }, tiles, lit)];
    }
    const door: Opening = { u: L / 2 - 0.9, v: 0, w: 1.8, h: 3.0, kind: 'door', doorColor: [1, 1, 1] };
    const ground = windowGrid(L, { floors: 1, floorH: groundH, baseV: 0, winW: 1.4, winH: 1.9, sillH: 1.0, margin: 1.2, spacing: 3.0 }, tiles, lit)
      .filter((o) => o.u + o.w < door.u - 0.5 || o.u > door.u + door.w + 0.5);
    return [...upper, ...ground, door];
  };
  shell(k, m, W, D, H, openings, style);
  k.stone.setColor([0.78, 0.76, 0.72]);
  band(k.stone, m, W, D, 0, 0.7, 0.05);
  k.trim.setColor([0.94, 0.92, 0.88]);
  band(k.trim, m, W, D, groundH - 0.1, 0.18, 0.08);
  // entrance canopy
  const fr = sideFrames(m, W, D);
  k.trim.setColor([0.94, 0.93, 0.9]);
  k.trim.box(fr.front.f.matrix(W / 2, 3.25, 0.8), 3.2, 0.16, 1.6);
  // balconies on alternating columns of the front
  const cols = windowGrid(W, { floors: 1, floorH, baseV: 0, winW: 1.4, winH: 1, sillH: 0, margin: 1.2, spacing: 3.0 }, () => 0, () => 0);
  for (let f = 1; f < b.floors; f++) {
    cols.forEach((c, i) => {
      if ((i + f) % 2 === 0) balcony(k, fr.front.f, c.u + c.w / 2, groundH + (f - 1) * floorH, 2.2);
    });
  }
  flatRoof(k, m, W, D, H, { parapet: 0.8 });
  rooftop(k, m, W, D, H, r, t);
}

function shop(k: KitWriters, m: THREE.Matrix4, b: AmbientBuilding, r: () => number, idx: number): THREE.Object3D {
  const W = b.width, D = b.depth;
  const groundH = 4.4, floorH = 3.1;
  const H = groundH + (b.floors - 1) * floorH;
  const t = wallTint(k, r, false);
  const style: WallStyle = { ...DEFAULT_WALL_STYLE, frameColor: [0.93, 0.92, 0.9] };
  const tiles = pickTile(r), lit = pickLit(r, 0.48);
  const shopW = W - 6;
  const openings = (side: Side, L: number): Opening[] => {
    const upper = windowGrid(L, { floors: b.floors - 1, floorH, baseV: groundH, winW: 1.3, winH: 1.7, sillH: 0.85, margin: 1.2, spacing: 2.8 }, tiles, lit);
    if (side !== 'front') return upper;
    return [
      ...upper,
      { u: 1.4, v: 0.5, w: shopW - 1.2, h: 3.0, kind: 'shop', tile: 2, lit: 0.9 },
      { u: shopW + 0.8, v: 0, w: 1.4, h: 3.3, kind: 'door', doorColor: [0.5, 0.4, 0.35] },
      { u: W - 2.6, v: 0.5, w: 1.4, h: 3.0, kind: 'shop', tile: 2, lit: 0.9 },
    ];
  };
  shell(k, m, W, D, H, openings, style);
  k.stone.setColor([0.32, 0.31, 0.3]);
  band(k.stone, m, W, D, 0, 0.5, 0.06);
  const fr = sideFrames(m, W, D);
  // fascia band for the sign
  k.trim.setColor([0.16, 0.18, 0.2]);
  k.trim.box(fr.front.f.matrix(W / 2, groundH - 0.55, 0.06), W - 0.6, 0.9, 0.12);
  // awning: sloped fabric + valance
  const awn = lin(AWNING_COLORS[idx % AWNING_COLORS.length]);
  k.fabric.setColor(awn);
  const f = fr.front.f;
  const a0 = f.at(1.2, 3.75, 0.05), a1 = f.at(shopW + 0.4, 3.75, 0.05), a2 = f.at(shopW + 0.4, 3.15, 1.7), a3 = f.at(1.2, 3.15, 1.7);
  k.fabric.quad(a3, a2, a1, a0);
  k.fabric.box(f.matrix((1.2 + shopW + 0.4) / 2, 3.0, 1.7), shopW - 0.8, 0.3, 0.02);
  // upper-floor sills/cornice
  k.trim.setColor([0.94, 0.92, 0.88]);
  band(k.trim, m, W, D, groundH, 0.16, 0.07);
  flatRoof(k, m, W, D, H, { parapet: 0.6 });
  rooftop(k, m, W, D, H, r, t);

  // sign (own small mesh: canvas texture)
  const [name, sub] = SHOP_NAMES[idx % SHOP_NAMES.length];
  const signW = Math.min(W - 2, 7.2), signH = 0.8;
  const tex = signTexture((g, w, h) => {
    g.fillStyle = '#1a1d21';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#f3e7cf';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = '600 96px Georgia, "Times New Roman", serif';
    g.fillText(name, w / 2, h * 0.4);
    g.font = '600 30px Inter, system-ui, sans-serif';
    g.fillStyle = '#c9b48a';
    g.fillText(sub.split('').join(' '), w / 2, h * 0.82);
  }, 1800, 200);
  const sign = new THREE.Mesh(
    new THREE.PlaneGeometry(signW, signH),
    new THREE.MeshStandardMaterial({ map: tex, roughness: 0.5, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.25 }),
  );
  sign.matrixAutoUpdate = false;
  sign.matrix.copy(f.matrix(W / 2, groundH - 0.55, 0.125));
  sign.name = `shop-sign:${name}`;
  return sign;
}

function townhouse(k: KitWriters, m: THREE.Matrix4, b: AmbientBuilding, r: () => number) {
  const W = b.width, D = b.depth;
  const raised = 0.75, floorH = 3.3;
  const H = raised + b.floors * floorH;
  const bays = Math.max(2, Math.round(W / 6));
  const bayW = W / bays;
  wallTint(k, r, true);
  const style: WallStyle = { ...DEFAULT_WALL_STYLE, lintels: true, sillColor: [0.9, 0.88, 0.83], frameColor: [0.95, 0.95, 0.93], transom: 0.72 };
  const tiles = pickTile(r), lit = pickLit(r, 0.55);
  // painted doors use the plain trim material
  const kDoor: KitWriters = { ...k, door: k.trim };
  const doorPaints = Array.from({ length: bays }, () => lin(pick(r, DOOR_PAINTS)));
  const openings = (side: Side, L: number): Opening[] => {
    const out: Opening[] = [];
    if (side === 'front') {
      for (let i = 0; i < bays; i++) {
        const u0 = i * bayW;
        out.push({ u: u0 + 0.9, v: raised, w: 1.3, h: 2.9, kind: 'door', doorColor: doorPaints[i] });
        out.push({ u: u0 + bayW - 2.4, v: raised + 0.6, w: 1.25, h: 2.1, kind: 'window', tile: tiles(), lit: lit(), sill: 0.6 });
        for (let f = 1; f < b.floors; f++) {
          for (const uu of [u0 + 0.9, u0 + bayW - 2.4]) out.push({ u: uu, v: raised + f * floorH + 0.75, w: 1.25, h: 2.0, kind: 'window', tile: tiles(), lit: lit(), sill: 0.75 });
        }
      }
      return out;
    }
    return windowGrid(L, { floors: b.floors, floorH, baseV: raised, winW: 1.2, winH: 1.9, sillH: 0.8, margin: 1.4, spacing: 3.2 }, tiles, lit);
  };
  shell(kDoor, m, W, D, H, openings, style);
  // stone plinth up to the raised ground floor, string courses
  k.stone.setColor([0.86, 0.83, 0.77]);
  band(k.stone, m, W, D, 0, raised + 0.1, 0.06);
  k.trim.setColor([0.93, 0.91, 0.86]);
  for (let f = 1; f < b.floors; f++) band(k.trim, m, W, D, raised + f * floorH - 0.08, 0.14, 0.05);
  // stoops: steps up to each door
  const fr = sideFrames(m, W, D);
  k.stone.setColor([0.84, 0.81, 0.76]);
  for (let i = 0; i < bays; i++) {
    const u = i * bayW + 0.9 + 0.65;
    for (let s = 0; s < 3; s++) {
      const h = raised - s * 0.25;
      k.stone.box(fr.front.f.matrix(u, h / 2, 0.25 + s * 0.32), 1.9, h, 0.5 + s * 0.0, { skip: ['ny'] });
    }
  }
  flatRoof(k, m, W, D, H, { parapet: 0.6 });
}
