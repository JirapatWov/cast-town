// Talent Agency: a glassy four-storey office with a curtain wall, four vertical fins in the vendor colours,
// a cantilevered entrance canopy, a paved plaza with planters and an illuminated roof sign.
import * as THREE from 'three';
import { LANDMARKS } from '../../../../shared/city-layout';
import { VENDOR_COLORS } from '../../../../shared/protocol';
import { WallFrame } from '../facade';
import { type Footprint, LAWN_Y } from '../layout';
import type { CityMaterials } from '../materials';
import { signTexture } from '../textures';
import { type Batch, trs } from '../util/mesh-writer';
import { band, flatRoof, kitWriters, sideFrames } from './kit';

export interface AgencyResult {
  footprint: Footprint;
  sign: THREE.Mesh;
  /** World-space top of the building (for the label). */
  height: number;
  door: THREE.Vector3;
  facing: THREE.Vector3;
}

const VENDOR_COLORS_LIST = [VENDOR_COLORS.anthropic, VENDOR_COLORS.openai, VENDOR_COLORS.deepseek, VENDOR_COLORS.google];

const lin = (hex: string): [number, number, number] => {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
};

export function buildAgency(batch: Batch, mats: CityMaterials): AgencyResult {
  const L = LANDMARKS.find((l) => l.id === 'agency')!;
  // building sits toward the back of its plot, leaving a plaza toward the street
  const W = 22, D = 13, floors = 4, floorH = 3.9, groundH = 4.6;
  const H = groundH + (floors - 1) * floorH;
  const zOff = -2.6; // local: back of plot
  const m = trs(L.x, LAWN_Y, L.z, L.rotY).multiply(new THREE.Matrix4().makeTranslation(0, 0, zOff));
  const k = kitWriters(batch, mats, 'plaster');
  const fr = sideFrames(m, W, D);

  // stone side walls and a stone back with slot windows; front is a full curtain wall
  k.stone.setColor([1.12, 1.1, 1.05]);
  for (const side of ['right', 'left', 'back'] as const) {
    const { f, L: len } = fr[side];
    stoneWallWithSlots(k.stone, k.glass, k.frame, f, len, H, side === 'back' ? 2.4 : 3.0, floors, floorH, groundH);
  }
  curtainWall(k.glass, k.frame, k.trim, fr.front.f, W, H, floors, floorH, groundH);

  // vendor-colour fins standing proud of the curtain wall
  const fins = VENDOR_COLORS_LIST;
  fins.forEach((hex, i) => {
    k.trim.setColor(lin(hex));
    const u = W * (0.2 + i * 0.2);
    k.trim.box(fr.front.f.matrix(u, (groundH + H) / 2 + 0.3, 0.55), 0.38, H - groundH + 1.6, 1.1);
  });

  // entrance canopy (cantilevered slab) + posts
  k.trim.setColor([0.96, 0.95, 0.93]);
  k.trim.box(fr.front.f.matrix(W / 2, groundH - 0.25, 2.6), 9.5, 0.32, 5.2);
  k.metal.box(fr.front.f.matrix(W / 2 - 4.2, (groundH - 0.4) / 2, 4.8), 0.16, groundH - 0.4, 0.16);
  k.metal.box(fr.front.f.matrix(W / 2 + 4.2, (groundH - 0.4) / 2, 4.8), 0.16, groundH - 0.4, 0.16);

  flatRoof(k, m, W, D, H, { parapet: 0.9, cornice: false, capColor: [0.85, 0.86, 0.87] });
  k.stone.setColor([0.55, 0.56, 0.57]);
  band(k.stone, m, W, D, 0, 0.35, 0.04);

  // plaza paving in front (local plot space), planters with shrubs are added by the caller via vegetation
  const paving = batch.writer(mats.paving, { cast: false });
  const pm = trs(L.x, LAWN_Y + 0.025, L.z, L.rotY);
  const p0 = new THREE.Vector3(-L.width / 2 + 0.8, 0, zOff + D / 2).applyMatrix4(pm);
  const p1 = new THREE.Vector3(L.width / 2 - 0.8, 0, L.depth / 2 - 0.2).applyMatrix4(pm);
  const xa = Math.min(p0.x, p1.x), xb = Math.max(p0.x, p1.x), za = Math.min(p0.z, p1.z), zb = Math.max(p0.z, p1.z);
  const y = LAWN_Y + 0.025;
  paving.quad({ x: xa, y, z: zb }, { x: xb, y, z: zb }, { x: xb, y, z: za }, { x: xa, y, z: za }, [[xa, zb], [xb, zb], [xb, za], [xa, za]]);

  // roof sign (own mesh: canvas texture, emissive so it blooms a little)
  const tex = signTexture((g, w, h) => {
    g.clearRect(0, 0, w, h);
    g.fillStyle = '#16181c';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#fbf6ec';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = '700 132px Inter, "Helvetica Neue", Arial, sans-serif';
    g.fillText('T A L E N T   A G E N C Y', w / 2, h * 0.47);
    const sw = w / 4;
    VENDOR_COLORS_LIST.forEach((c, i) => {
      g.fillStyle = c;
      g.fillRect(i * sw, h - 18, sw, 18);
    });
  }, 2400, 240);
  const signW = 15, signH = 1.5;
  const sign = new THREE.Mesh(
    new THREE.PlaneGeometry(signW, signH),
    new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 0.9, roughness: 0.4 }),
  );
  sign.matrixAutoUpdate = false;
  sign.matrix.copy(fr.front.f.matrix(W / 2, H + 0.9 + signH / 2 + 0.15, 0.05));
  sign.castShadow = true;
  sign.name = 'agency-sign';
  // sign back + frame
  k.metal.box(fr.front.f.matrix(W / 2, H + 0.9 + signH / 2 + 0.15, -0.08), signW + 0.2, signH + 0.2, 0.2);

  const door = fr.front.f.at(W / 2, 0, 0.2);
  return {
    footprint: { x: L.x + Math.sin(L.rotY) * zOff, z: L.z + Math.cos(L.rotY) * zOff, hw: W / 2 + 0.6, hd: D / 2 + 0.6, rotY: L.rotY },
    sign,
    height: LAWN_Y + H + 3,
    door,
    facing: fr.front.f.normal.clone(),
  };
}

/** Full-height glazing with mullions every 1.5 m and white spandrel bands at each floor. */
function curtainWall(
  glass: ReturnType<typeof kitWriters>['glass'], frame: ReturnType<typeof kitWriters>['frame'], trim: ReturnType<typeof kitWriters>['trim'],
  f: WallFrame, W: number, H: number, floors: number, floorH: number, groundH: number,
) {
  const levels = [0, groundH, ...Array.from({ length: floors - 1 }, (_, i) => groundH + (i + 1) * floorH)];
  for (let i = 0; i < levels.length - 1; i++) {
    const v0 = levels[i], v1 = levels[i + 1];
    const cols = Math.round(W / 1.5);
    for (let c = 0; c < cols; c++) {
      const u0 = (c / cols) * W, u1 = ((c + 1) / cols) * W;
      glass.setExtra('aWin', [i === 0 ? 2 : 6, i === 0 ? 0.85 : (c * 7 + i * 3) % 5 === 0 ? 0.8 : 0.12]);
      glass.setExtra('aRoom', [u1 - u0, v1 - v0 - 0.5, 0.05, i === 0 ? 2.5 : 5]);
      glass.quad(f.at(u0, v0 + 0.05, -0.05), f.at(u1, v0 + 0.05, -0.05), f.at(u1, v1 - 0.45, -0.05), f.at(u0, v1 - 0.45, -0.05));
    }
    // spandrel band (opaque) hides each slab edge
    trim.setColor([0.93, 0.93, 0.92]);
    trim.box(f.matrix(W / 2, v1 - 0.22, 0.02), W + 0.04, 0.46, 0.18);
  }
  frame.setColor([0.12, 0.13, 0.14]);
  const cols = Math.round(W / 1.5);
  for (let c = 0; c <= cols; c++) frame.box(f.matrix((c / cols) * W, H / 2, 0.02), 0.08, H, 0.16);
}

/** Stone wall with tall slot windows. */
function stoneWallWithSlots(
  stone: ReturnType<typeof kitWriters>['stone'], glass: ReturnType<typeof kitWriters>['glass'], frame: ReturnType<typeof kitWriters>['frame'],
  f: WallFrame, len: number, H: number, spacing: number, floors: number, floorH: number, groundH: number,
) {
  const n = Math.floor((len - 2) / spacing);
  const start = (len - (n - 1) * spacing) / 2;
  const levels = [0, groundH, ...Array.from({ length: floors - 1 }, (_, i) => groundH + (i + 1) * floorH)];
  // solid wall pieces around slots: simple approach — vertical piers + horizontal bands
  const slotW = 0.9;
  const us = [0];
  for (let i = 0; i < n; i++) us.push(start + i * spacing - slotW / 2, start + i * spacing + slotW / 2);
  us.push(len);
  for (let i = 0; i < us.length - 1; i += 2) {
    const u0 = us[i], u1 = us[i + 1];
    stone.quad(f.at(u0, 0, 0), f.at(u1, 0, 0), f.at(u1, H, 0), f.at(u0, H, 0), [[u0, 0], [u1, 0], [u1, H], [u0, H]]);
  }
  for (let i = 1; i < us.length - 1; i += 2) {
    const u0 = us[i], u1 = us[i + 1];
    for (let l = 0; l < levels.length - 1; l++) {
      const v0 = levels[l], v1 = levels[l + 1];
      // spandrel below + above the glass
      stone.quad(f.at(u0, v0, 0), f.at(u1, v0, 0), f.at(u1, v0 + 0.6, 0), f.at(u0, v0 + 0.6, 0), [[u0, v0], [u1, v0], [u1, v0 + 0.6], [u0, v0 + 0.6]]);
      stone.quad(f.at(u0, v1 - 0.5, 0), f.at(u1, v1 - 0.5, 0), f.at(u1, v1, 0), f.at(u0, v1, 0), [[u0, v1 - 0.5], [u1, v1 - 0.5], [u1, v1], [u0, v1]]);
      glass.setExtra('aWin', [6, (i + l) % 4 === 0 ? 0.7 : 0.1]);
      glass.setExtra('aRoom', [u1 - u0, v1 - v0 - 1.1, 0.6, 1.2]);
      glass.quad(f.at(u0, v0 + 0.6, -0.18), f.at(u1, v0 + 0.6, -0.18), f.at(u1, v1 - 0.5, -0.18), f.at(u0, v1 - 0.5, -0.18));
      // reveals
      stone.quad(f.at(u0, v0 + 0.6, 0), f.at(u0, v0 + 0.6, -0.18), f.at(u0, v1 - 0.5, -0.18), f.at(u0, v1 - 0.5, 0));
      stone.quad(f.at(u1, v0 + 0.6, -0.18), f.at(u1, v0 + 0.6, 0), f.at(u1, v1 - 0.5, 0), f.at(u1, v1 - 0.5, -0.18));
      stone.quad(f.at(u0, v1 - 0.5, -0.18), f.at(u1, v1 - 0.5, -0.18), f.at(u1, v1 - 0.5, 0), f.at(u0, v1 - 0.5, 0));
      stone.quad(f.at(u0, v0 + 0.6, 0), f.at(u1, v0 + 0.6, 0), f.at(u1, v0 + 0.6, -0.18), f.at(u0, v0 + 0.6, -0.18));
      frame.setColor([0.12, 0.13, 0.14]);
      frame.box(f.matrix((u0 + u1) / 2, v0 + 0.6 + 0.03, -0.14), u1 - u0, 0.06, 0.08);
    }
  }
}
