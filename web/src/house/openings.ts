// Windows (black steel frames, glass, sills, linen curtains) and the front door.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ROOM, type Opening, type WallDef } from './layout';
import type { Palette } from './materials';
import { curtainLinen } from './window-view';

/** Group in a wall-local frame: X along the wall, Y up, +Z into the room, inner face at z = 0. */
export function wallFrame(def: WallDef, u: number): THREE.Group {
  const g = new THREE.Group();
  const [ox, oz] = def.outward;
  if (def.axis === 'x') g.position.set(u, 0, def.at);
  else g.position.set(def.at, 0, u);
  // local +Z must point inward (−outward)
  g.rotation.y = Math.atan2(-ox, -oz);
  return g;
}

function box(w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number, shadow = true) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = shadow;
  m.receiveShadow = true;
  return m;
}

/** One mesh per material for a moving part, which the static batching leaves alone. */
function mergeByMaterial(g: THREE.Group) {
  const byMat = new Map<THREE.Material, THREE.Mesh[]>();
  for (const c of g.children as THREE.Mesh[]) {
    if (!c.isMesh) continue;
    const mat = c.material as THREE.Material;
    byMat.set(mat, [...(byMat.get(mat) ?? []), c]);
  }
  for (const [mat, ms] of byMat) {
    if (ms.length < 2) continue;
    const merged = new THREE.Mesh(mergeGeometries(ms.map((m) => (m.updateMatrix(), m.geometry.applyMatrix4(m.matrix)))), mat);
    merged.castShadow = ms.some((m) => m.castShadow);
    merged.receiveShadow = true;
    for (const m of ms) { g.remove(m); m.geometry.dispose(); }
    g.add(merged);
  }
}

export function buildWindow(def: WallDef, o: Opening, pal: Palette): THREE.Group {
  const T = ROOM.wallT;
  const w = o.to - o.from, h = o.top - o.sill;
  const g = wallFrame(def, (o.from + o.to) / 2);
  g.name = `window:${def.id}`;
  const f = 0.05, fd = 0.07, zc = -T * 0.45;
  const frame = pal.blackMetal;
  const parts = new THREE.Group();
  parts.add(box(w, f, fd, frame, 0, o.sill + f / 2, zc));
  parts.add(box(w, f, fd, frame, 0, o.top - f / 2, zc));
  parts.add(box(f, h, fd, frame, -w / 2 + f / 2, o.sill + h / 2, zc));
  parts.add(box(f, h, fd, frame, w / 2 - f / 2, o.sill + h / 2, zc));
  // mullions: vertical split for wide windows, transom bar on tall ones
  if (w > 1.25) parts.add(box(0.035, h, fd * 0.8, frame, 0, o.sill + h / 2, zc));
  if (h > 1.6) parts.add(box(w, 0.035, fd * 0.8, frame, 0, o.top - h * 0.28, zc));
  g.add(parts);
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(w - 2 * f, h - 2 * f), pal.glass);
  glass.position.set(0, o.sill + h / 2, zc);
  glass.castShadow = false;
  glass.renderOrder = 2;
  g.add(glass);
  // interior sill board
  g.add(box(w + 0.12, 0.035, T * 0.55 + 0.05, pal.baseboard, 0, o.sill - 0.0175 + 0.001, -T * 0.55 / 2 + 0.05 / 2 + 0.0, true));
  if (o.curtains) g.add(buildCurtains(w, o.top, pal));
  return g;
}

/** Two gathered linen panels on a slim black rod: deep pinch-pleat folds that flare a little toward the hem. */
function buildCurtains(w: number, top: number, pal: Palette): THREE.Group {
  const g = new THREE.Group();
  const rodY = Math.min(top + 0.18, ROOM.height - 0.06);
  const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, w + 0.8, 10).rotateZ(Math.PI / 2), pal.blackMetal);
  rod.position.set(0, rodY, 0.1);
  g.add(rod);
  for (const s of [-1, 1]) {
    const fin = new THREE.Mesh(new THREE.SphereGeometry(0.022, 10, 8), pal.blackMetal);
    fin.position.set(s * (w / 2 + 0.4), rodY, 0.1);
    g.add(fin);
  }
  const mat = curtainMaterial(pal);
  const panelW = 0.56, panelH = rodY - 0.035;
  const pleats = 7;
  for (const side of [-1, 1]) {
    const geo = new THREE.PlaneGeometry(panelW, panelH, 42, 10);
    const pos = geo.getAttribute('position');
    const uv = geo.getAttribute('uv');
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i);
      const t = (y + panelH / 2) / panelH; // 0 hem → 1 heading
      const ph = (x / panelW + 0.5) * pleats * Math.PI * 2;
      // folds: tight at the heading tape, deeper and softer toward the hem; the panel spreads 12 % at the hem
      const depth = 0.028 + 0.03 * (1 - t);
      const z = Math.sin(ph) * depth + Math.sin(ph * 0.5 + 1.3) * 0.012 * (1 - t);
      const spread = 1 + 0.12 * (1 - t) * (1 - t);
      // the cloth length along the folds, so the weave keeps its real scale across the pleats
      uv.setXY(i, (x / panelW + 0.5) * panelW * 1.9, y + panelH / 2);
      pos.setXYZ(i, x * spread, y, z);
    }
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, mat);
    m.position.set(side * (w / 2 + 0.16), rodY - panelH / 2 - 0.015, 0.1);
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
  }
  return g;
}

const curtainMats = new WeakMap<Palette, THREE.MeshStandardMaterial>();
/** One linen for every curtain of a house (they batch per wall), glowing faintly with daylight behind it. */
function curtainMaterial(pal: Palette): THREE.MeshStandardMaterial {
  let m = curtainMats.get(pal);
  if (!m) {
    m = curtainLinen(pal.fabric('#efe6d6', 0.98).clone());
    m.side = THREE.DoubleSide;
    curtainMats.set(pal, m);
  }
  return m;
}

export interface DoorHandle {
  group: THREE.Group;
  leaf: THREE.Object3D; // pick target
  setOpen(on: boolean): void;
  update(dt: number): void;
}

export function buildDoor(def: WallDef, o: Opening, pal: Palette): DoorHandle {
  const T = ROOM.wallT;
  const w = o.to - o.from, h = o.top;
  const g = wallFrame(def, (o.from + o.to) / 2);
  g.name = 'front-door';
  // casing trim on the interior side
  const trim = pal.baseboard;
  g.add(box(0.07, h + 0.07, 0.02, trim, -w / 2 - 0.035, (h + 0.07) / 2, 0.01));
  g.add(box(0.07, h + 0.07, 0.02, trim, w / 2 + 0.035, (h + 0.07) / 2, 0.01));
  g.add(box(w + 0.14, 0.07, 0.02, trim, 0, h + 0.035, 0.01));
  // threshold
  g.add(box(w, 0.015, T, pal.oak, 0, 0.0075, -T / 2));
  // leaf, hinged on the left edge (pivot group)
  const pivot = new THREE.Group();
  pivot.position.set(-w / 2 + 0.01, 0, -T * 0.25);
  const leafMat = pal.paint('#46564f', 0.5);
  const leaf = new THREE.Group();
  leaf.name = 'door-leaf';
  const slab = box(w - 0.02, h - 0.01, 0.045, leafMat, (w - 0.02) / 2, (h - 0.01) / 2, 0);
  leaf.add(slab);
  // raised panels
  for (const [py, ph] of [[0.55, 0.75], [1.45, 0.85]] as const) {
    leaf.add(box(w - 0.24, ph, 0.012, leafMat, (w - 0.02) / 2, py, 0.028));
    leaf.add(box(w - 0.24, ph, 0.012, leafMat, (w - 0.02) / 2, py, -0.028));
  }
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.03, 16, 12), pal.brass);
  knob.position.set(w - 0.1, 1.0, 0.05);
  leaf.add(knob);
  const knob2 = knob.clone();
  knob2.position.z = -0.05;
  leaf.add(knob2);
  mergeByMaterial(leaf);
  pivot.add(leaf);
  pivot.userData.noBatch = true; // swings open
  g.add(pivot);
  // doormat inside
  const mat = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.012, 0.6), pal.fabric('#7a6a58', 1));
  mat.position.set(0, 0.006, 0.55);
  mat.receiveShadow = true;
  mat.name = 'doormat';
  g.add(mat);

  let open = 0, target = 0;
  return {
    group: g,
    leaf,
    setOpen(on) { target = on ? 1 : 0; },
    update(dt) {
      if (Math.abs(open - target) < 1e-3) return;
      open += (target - open) * (1 - Math.exp(-dt * 6));
      pivot.rotation.y = -open * 1.45; // swings into the room
    },
  };
}
