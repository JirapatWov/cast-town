// Job rooms upstairs, furnished by job kind, laid out in the canonical room frame (rooms/frame.ts) so one layout
// fits rooms A–D. Every furnished room has stations for every activity (desks, bookshelves, corkboard + pacing,
// armchairs, windows, coffee, a counter to lean on, plants and a vacuum loop for helpers, open floor to listen),
// its own corkboard (the job's run board), a floor finish, a ceiling fixture and an accent lamp.
import * as THREE from 'three';
import type { JobKind } from '../../../../shared/protocol';
import { Corkboard } from '../corkboard';
import { Kit, box, cyl, group, metricUV, rbox } from '../furniture/kit';
import { buildBookshelf } from '../furniture/library';
import { buildDesk, buildLaptop, buildMonitor, buildOfficeChair } from '../furniture/workroom';
import { ROOM } from '../layout';
import { practicalGlobes } from '../lighting';
import { Screen, ScreenAtlas } from '../screens';
import type { Palette } from '../materials';
import type { RoomFrame } from './frame';
import {
  bankerLamp, beanBag, bookRow, bookStack, coffeeMachine, credenza, drumPendant, floorLamp, lampShade, framedArt, globe,
  libraryTable, miniFridge, mug, paint, paperStack, rug, serverRack, sideTable, standingDesk, wallShelf,
  whiteboard, writingDesk,
} from './pieces';

export interface RoomFurnished {
  board: Corkboard | null;
  screens: Screen[];
  /** The room's screens share one texture (one draw call for all of them). */
  atlas: ScreenAtlas;
}

const CEIL = ROOM.height;
const P = '/assets/props-interior/';
const VASE = `${P}opt/ceramic_vase_02.glb`;
const BASKET = `${P}opt/wicker_basket_02.glb`;
const DESK_H = 0.75;

/** Build a job room of `kind` into `kit` (floor-local coordinates). */
export async function furnishJobRoom(kit: Kit, f: RoomFrame, kind: JobKind, tint: string): Promise<RoomFurnished> {
  const out: RoomFurnished = { board: kit.own(new Corkboard()), screens: [], atlas: kit.own(new ScreenAtlas()) };
  floorFinish(kit, f, kind);
  mountBoard(kit, f, out.board!);
  if (kind === 'code') await codeRoom(kit, f, out, tint);
  else if (kind === 'write') await writeRoom(kit, f, out, tint);
  else if (kind === 'research') await researchRoom(kit, f, out, tint);
  else await generalRoom(kit, f, out, tint);
  windowSpots(kit, f);
  const { screens, board, atlas } = out;
  kit.updaters.push((dt) => {
    board?.update(dt);
    for (const s of screens) s.update(dt);
    atlas.update(dt);
  });
  return out;
}

/** An unoccupied room, staged like a freshly painted flat on viewing day: pale herringbone floor, a slatted oak
 *  bench with a folded throw and a vase of dried grass, two plants, a large print leaning on the wall and a paper
 *  lantern. Everything stands along the walls, leaving the open floor (the click target) clear. */
export async function furnishEmptyRoom(kit: Kit, f: RoomFrame) {
  const { pal } = kit;
  floorFinish(kit, f, 'empty');
  const c = f.vec(f.W / 2, f.D / 2);
  kit.hang(kit.add(paperLantern(pal, CEIL), c.x, c.z));
  kit.addLamp(new THREE.Vector3(c.x, CEIL - 0.95, c.z), { intensity: 2.8, distance: 7.5, color: '#ffe0b4' });

  // bench along the outer wall (under the window where there is one), dressed
  const bv = f.D * 0.5;
  const bench = slatBench(kit, 1.5);
  bench.add(rbox(0.42, 0.06, 0.34, 0.025, pal.boucle('#e8dccb'), -0.42, 0.45, 0));
  bench.add(bookStack(pal, 300 + f.slot, 2).translateX(0.05).translateY(0.45));
  const vase = await kit.glb(VASE, { height: 0.3, share: true });
  vase.position.set(0.5, 0.45, 0);
  bench.add(vase, grassStems(pal).translateX(0.5).translateY(0.45 + 0.27));
  f.place(kit, bench, 0.24, bv, Math.PI / 2);
  f.block(kit, 0.24, bv, 1.5, 0.4, Math.PI / 2);
  const basket = await kit.glb(BASKET, { height: 0.3, share: true });
  basket.add(rbox(0.26, 0.1, 0.2, 0.04, pal.boucle('#c9b79c'), 0, 0.24, 0));
  f.place(kit, basket, 0.3, bv + 1.08, 0.3);
  f.block(kit, 0.3, bv + 1.08, 0.4, 0.32);

  const big = await kit.glb(`${P}potted_plant_02_1k.glb`, { height: 1.35, share: true });
  const tall = big.clone();
  f.place(kit, tall, 0.45, f.D - 0.45, 0.4 + f.slot);
  f.block(kit, 0.45, f.D - 0.45, 0.6, 0.6);
  const small = await kit.glb(`${P}potted_plant_04_1k.glb`, { height: 0.55, share: true });
  f.place(kit, small.clone(), f.W - 0.35, f.D - 0.35, f.slot);
  f.block(kit, f.W - 0.35, f.D - 0.35, 0.4, 0.4);

  // a round jute rug in front of the bench
  const rugGeo = metricUV(new THREE.CylinderGeometry(0.95, 0.95, 0.012, 48));
  const jr = new THREE.Mesh(rugGeo, pal.jute);
  jr.receiveShadow = true;
  f.place(kit, group(jr), 1.3, bv, 0, 0.006);

  // a big print leaning on the display wall (it goes with the wall when the cutaway lowers it)
  const au = f.front ? 2.4 : f.W * 0.62;
  const tilt = new THREE.Group();
  const art = framedArt(kit, 0.9, 1.15, 500 + f.slot, ['#d8b48e', '#efe2cc', '#7d8a72', '#3b4a6b'], pal.oak);
  art.position.y = 1.2;
  tilt.add(art);
  tilt.rotation.x = -0.09;
  const lean = new THREE.Group();
  lean.add(tilt);
  f.onWall(kit, 'display', lean, au, 0.1, 0, 2.0);
  f.block(kit, au, 0.15, 1.0, 0.3);
}

/** Oak slat bench, origin bottom centre, long axis along x. */
function slatBench(kit: Kit, len: number): THREE.Group {
  const { pal } = kit;
  const g = new THREE.Group();
  const h = 0.45, d = 0.38;
  const n = 6;
  for (let i = 0; i < n; i++) g.add(rbox(len, 0.03, d / n - 0.012, 0.006, pal.oak, 0, h - 0.03, -d / 2 + (i + 0.5) * (d / n)));
  for (const s of [-1, 1]) {
    g.add(box(0.05, h - 0.03, d - 0.04, pal.oak, s * (len / 2 - 0.12), 0, 0));
  }
  g.add(box(len - 0.3, 0.04, 0.04, pal.oak, 0, 0.12, 0));
  return g;
}

/** A few dried grass stems fanning out of a vase neck (origin at the neck). */
function grassStems(pal: Palette): THREE.Group {
  const g = new THREE.Group();
  const stem = paint(pal, '#c8b48a', 0.9);
  const plumeMat = paint(pal, '#e2d2ad', 0.95);
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2, tilt = 0.12 + (i % 3) * 0.07;
    const len = 0.42 + (i % 4) * 0.07;
    const m = cyl(0.003, 0.004, len, stem, 0, 0, 0, 4);
    m.geometry.translate(0, len / 2, 0); // pivot at the stem's foot
    m.position.set(Math.cos(a) * 0.012, -0.04, Math.sin(a) * 0.012);
    m.rotation.set(Math.sin(a) * tilt, 0, -Math.cos(a) * tilt);
    m.castShadow = false;
    g.add(m);
    const plume = new THREE.Mesh(new THREE.SphereGeometry(0.022, 6, 5).scale(0.6, 2.2, 0.6), plumeMat);
    plume.position.set(0, len, 0);
    m.add(plume);
  }
  return g;
}

/** Rice-paper lantern on a cord, glowing softly. */
function paperLantern(pal: Palette, ceiling: number, r = 0.26, drop = 0.75): THREE.Group {
  const g = new THREE.Group();
  const y = ceiling - drop - r;
  const geo = new THREE.SphereGeometry(r, 28, 18);
  // faint horizontal ribs of the wire frame
  const pos = geo.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const py = pos.getY(i);
    const k = 1 - 0.012 * Math.max(0, Math.cos(py / r * Math.PI * 7));
    pos.setXYZ(i, pos.getX(i) * k, py * 0.94, pos.getZ(i) * k);
  }
  geo.computeVertexNormals();
  const shell = new THREE.Mesh(geo, lampShade(pal, '#f6efe2', 1.6));
  shell.position.y = y;
  shell.castShadow = false;
  g.add(shell);
  g.add(cyl(0.004, 0.004, drop, pal.blackMetal, 0, ceiling - drop, 0, 5));
  g.add(cyl(0.05, 0.05, 0.02, pal.ceramic, 0, ceiling - 0.02, 0, 16));
  return g;
}

// ── shared pieces of every furnished room ──────────────────────────────────────────────────────

function floorFinish(kit: Kit, f: RoomFrame, kind: JobKind | 'empty') {
  const { pal } = kit;
  // light woods everywhere (they bounce the daylight); the writers' library keeps the one dark walnut floor
  const mat = kind === 'empty' ? pal.floors.parquet : kind === 'write' ? pal.floors.walnut : kind === 'research' ? pal.floors.ash : pal.floors.oak;
  const geo = new THREE.PlaneGeometry(f.x1 - f.x0, f.z1 - f.z0).rotateX(-Math.PI / 2);
  geo.translate((f.x0 + f.x1) / 2, 0.004, (f.z0 + f.z1) / 2);
  const uv = geo.getAttribute('uv');
  const pos = geo.getAttribute('position');
  for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i), -pos.getZ(i));
  const m = new THREE.Mesh(geo, mat);
  m.receiveShadow = true;
  m.name = 'room-floor';
  kit.root.add(m);
}

/** The job's corkboard on the display wall, with pacing and delegating spots in front of it. */
function mountBoard(kit: Kit, f: RoomFrame, board: Corkboard) {
  const w = 2.1, h = 1.31, y = 2.32;
  const g = new THREE.Group();
  g.name = 'corkboard';
  g.add(box(w + 0.08, h + 0.08, 0.04, kit.pal.oak, 0, -(h + 0.08), 0.02)); // box() takes the bottom: top edge at y
  const face = new THREE.Mesh(new THREE.PlaneGeometry(w, h), board.material);
  face.position.set(0, -h / 2 - 0.04, 0.041);
  face.receiveShadow = true;
  g.add(face);
  f.onWall(kit, 'display', g, f.boardU, 0.0, y, 2.2);
  const top = f.vec(f.boardU, 0.1, y + 0.18);
  kit.pickable(g, { kind: 'board', label: 'Job board · workflow', anchor: top });
  const u = f.boardU;
  f.station(kit, 'corkboard', 'board-a', u - 0.55, 0.78, Math.PI);
  f.station(kit, 'corkboard', 'board-b', u + 0.55, 0.78, Math.PI);
  f.station(kit, 'pace', 'pace', u - 1.0, 0.72, Math.PI, { route: f.pts([u - 1.35, 0.72], [u + 1.35, 0.72]) });
}

/** Desks in a row facing the display wall (screens toward the camera), office chairs that slide. */
async function deskRow(kit: Kit, f: RoomFrame, out: RoomFurnished, row: DeskRow, tint: string,
  opts: { desk?: (i: number, w: number) => THREE.Group; chair?: () => Promise<THREE.Object3D>; depth?: number; device?: (i: number, s: Screen) => THREE.Object3D | null; v?: number } = {}) {
  const { pal } = kit;
  const v = opts.v ?? 1.75, d = opts.depth ?? 0.7;
  const { us, w } = row;
  const chairFabric = pal.upholstery(f.slot % 2 ? '#4a4e55' : '#3d3f44');
  for (const [i, u] of us.entries()) {
    const desk = opts.desk ? opts.desk(i, w) : buildDesk(kit, w);
    f.place(kit, desk, u, v, 0);
    f.block(kit, u, v, w, d, 0);
    const screen = kit.own(new Screen(300 + f.slot * 10 + i, out.atlas));
    out.screens.push(screen);
    const dev = opts.device ? opts.device(i, screen) : buildMonitor(kit, screen);
    if (dev) {
      desk.add(dev);
      kit.pickable(dev, { kind: 'computer', label: 'Computer · open a terminal', anchor: f.vec(u, v - 0.2, DESK_H + 0.7) });
    }
    const chair = opts.chair ? await opts.chair() : buildOfficeChair(kit, chairFabric);
    const seatV = v + d / 2 + 0.32;
    f.place(kit, chair, u, seatV, Math.PI);
    f.block(kit, u, seatV, 0.5, 0.5);
    f.station(kit, 'desk', `desk-${i}`, u, seatV, Math.PI, {
      sit: { seatY: 0.47, chair, slide: 0.3 },
      screen: { setActive: (on, t) => screen.setActive(on, t ?? tint) },
    });
  }
}

interface DeskRow { us: number[]; w: number }

/** Four desks in every room, so a whole team (a workflow runs up to four agents) can sit and write at once; the
 *  narrow room gets compact desks. The row leaves a wide gap at the inner end, the way in from the door. */
function deskRow4(f: RoomFrame, wide = 1.36): DeskRow {
  return f.small ? { us: [1.0, 2.25, 3.5, 4.75], w: 1.15 } : { us: [1.75, 3.2, 4.65, 6.1], w: wide };
}

/** A charging cable from the back of the desk top, over the edge and down to the floor (local to the desk top). */
function deskCable(pal: Palette, x: number, half: number): THREE.Mesh {
  const z = -0.33;
  const pts = [
    new THREE.Vector3(x, 0.006, z + 0.12), new THREE.Vector3(x + 0.12, 0.006, z + 0.04), new THREE.Vector3(x + 0.18, 0.004, z + 0.005),
    new THREE.Vector3(x + 0.2, -0.05, z - 0.02), new THREE.Vector3(x + 0.24, -0.42, z - 0.01), new THREE.Vector3(Math.min(half - 0.1, x + 0.34), -DESK_H + 0.006, z + 0.05),
  ];
  const geo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 24, 0.0035, 5);
  const m = new THREE.Mesh(geo, paint(pal, '#1d1f22', 0.6));
  m.castShadow = false;
  return m;
}

const mid = (row: DeskRow) => (row.us[0] + row.us[row.us.length - 1]) / 2;

function plant(kit: Kit, f: RoomFrame, proto: THREE.Group, u: number, v: number, id: string, faceYaw: number, spin = 0) {
  const p = proto.clone();
  f.place(kit, p, u, v, spin);
  const s = proto.userData.size as THREE.Vector3;
  f.block(kit, u, v, Math.max(0.4, s.x * 0.8), Math.max(0.4, s.z * 0.8));
  // the waterer stands 0.72 m out along `faceYaw` (canonical direction from the pot into the room), facing the pot
  const back = 0.72;
  f.station(kit, 'plants', id, u + Math.sin(faceYaw) * back, v + Math.cos(faceYaw) * back, faceYaw + Math.PI);
}

/** A bookshelf against a wall with two reading spots (and a crouch spot for helpers tidying the low shelf). */
function shelf(kit: Kit, f: RoomFrame, u: number, v: number, cyaw: number, seed: number, id: string) {
  const s = buildBookshelf(kit, seed);
  f.place(kit, s, u, v, cyaw);
  f.block(kit, u, v, 1.2, 0.38, cyaw);
  const fx = Math.sin(cyaw), fz = Math.cos(cyaw); // facing (u, v)
  const rx = Math.cos(cyaw), rz = -Math.sin(cyaw); // right
  const at = (side: number, dist: number) => [u + fx * dist + rx * side, v + fz * dist + rz * side] as const;
  const [ax, az] = at(-0.3, 0.6), [bx, bz] = at(0.3, 0.6), [cx, cz] = at(0, 0.62);
  f.station(kit, 'bookshelf', `${id}-a`, ax, az, cyaw + Math.PI);
  f.station(kit, 'bookshelf', `${id}-b`, bx, bz, cyaw + Math.PI);
  f.station(kit, 'washer', `${id}-tidy`, cx, cz, cyaw + Math.PI);
}

function centers(kit: Kit, f: RoomFrame, pts: [number, number][]) {
  pts.forEach(([u, v], i) => f.station(kit, 'center', `center-${i}`, u, v, 0));
}

function vacuum(kit: Kit, f: RoomFrame, u0: number, v0: number, u1: number, v1: number) {
  f.station(kit, 'vacuum', 'vacuum', (u0 + u1) / 2, v0, Math.PI / 2, { route: f.pts([u0, v0], [u1, v0], [u1, v1], [u0, v1]) });
}

/** Standing spots in front of the room's windows (idle gazing, phone calls), when the floor there is free. */
function windowSpots(kit: Kit, f: RoomFrame) {
  let i = 0;
  for (const w of f.windows()) {
    const mid = (w.from + w.to) / 2;
    const [u, v, yaw] = w.wall === 'display' ? [mid, 0.62, Math.PI] : w.wall === 'near' ? [mid, f.D - 0.62, 0] : w.wall === 'outer' ? [0.62, mid, -Math.PI / 2] : [f.W - 0.62, mid, Math.PI / 2];
    const p = f.vec(u, v);
    const hit = kit.obstacles.some((r) => p.x > r.x0 - 0.2 && p.x < r.x1 + 0.2 && p.z > r.z0 - 0.2 && p.z < r.z1 + 0.2);
    if (!hit) f.station(kit, 'window', `window-${i++}`, u, v, yaw);
  }
}

/** Main ceiling light (+ the fixture) at canonical (u, v). */
function mainLight(kit: Kit, f: RoomFrame, u: number, v: number, color = '#ffcf94', intensity = 3.4, y = CEIL - 0.55) {
  kit.addLamp(f.vec(u, v, y), { intensity, distance: 7.5, color });
}

async function pendants(kit: Kit, f: RoomFrame, pts: [number, number][]) {
  const proto = await kit.glb(`${P}modern_ceiling_lamp_01_1k.glb`, { scale: 1, share: true });
  practicalGlobes(proto);
  const h = (proto.userData.size as THREE.Vector3).y;
  for (const [u, v] of pts) kit.hang(f.place(kit, proto.clone(), u, v, 0, CEIL - h));
}

function lounge(kit: Kit, f: RoomFrame, lamp: { u: number; v: number }) {
  const fl = floorLamp(kit);
  f.place(kit, fl.group, lamp.u, lamp.v);
  f.block(kit, lamp.u, lamp.v, 0.35, 0.35);
  kit.addLamp(f.vec(lamp.u, lamp.v, fl.bulbY), { intensity: 1.7, distance: 4.2, color: '#ffc27e' });
}

// ── kinds ──────────────────────────────────────────────────────────────────────────────────────

/** General studio: oak desks, a sofa corner with coffee table, bookshelf, coffee credenza, plants and prints. */
async function generalRoom(kit: Kit, f: RoomFrame, out: RoomFurnished, tint: string) {
  const { pal } = kit;
  const W = f.W, D = f.D;
  const row = deskRow4(f);
  const { us } = row;
  const lampProto = await kit.glb(`${P}desk_lamp_arm_01_1k.glb`, { height: 0.62, share: true });
  const smallPlant = await kit.glb(`${P}potted_plant_04_1k.glb`, { height: 0.3, share: true });
  await deskRow(kit, f, out, row, tint, {
    device: (i, s) => {
      const dev = i === 1 ? buildLaptop(kit, s) : buildMonitor(kit, s);
      dev.position.set(0, DESK_H, i === 1 ? -0.02 : -0.2);
      return dev;
    },
  });
  // desk dressing: keyboard/mug, lamps on the end desks, a plant, notebooks, a cable down the back of each desk
  us.forEach((u, i) => {
    const half = row.w / 2;
    const top = group(
      rbox(0.42, 0.018, 0.14, 0.006, paint(pal, '#e7e3dc', 0.5), 0, 0, 0.24),
      rbox(0.06, 0.022, 0.1, 0.02, paint(pal, '#e7e3dc', 0.5), 0.3, 0, 0.23),
      mug(pal, ['#c86f4f', '#3f6e8c', '#e9e2d4', '#2f4b3e'][i % 4]).translateX(-half + 0.14).translateZ(0.12),
    );
    if (i === 0 || i === us.length - 1) {
      const l = lampProto.clone();
      l.position.set(i === 0 ? -half + 0.16 : half - 0.16, 0, -0.2);
      l.rotation.y = i === 0 ? 0.6 : -0.6;
      top.add(l);
    } else if (i === 1) {
      const p = smallPlant.clone();
      p.position.set(half - 0.18, 0, -0.16);
      top.add(p);
    } else {
      const nb = rbox(0.17, 0.02, 0.23, 0.004, paint(pal, '#8b3a2f', 0.7), half - 0.22, 0, 0.0);
      nb.rotation.y = 0.25;
      top.add(nb, bookStack(pal, 70 + f.slot, 2).translateX(half - 0.2).translateZ(-0.22));
    }
    top.add(deskCable(pal, -0.05, half));
    f.place(kit, top, u, 1.75, 0, DESK_H);
  });
  // corner plant + bookshelf
  const bigPlant = await kit.glb(`${P}potted_plant_02_1k.glb`, { height: 1.3, share: true });
  plant(kit, f, bigPlant, 0.45, 0.45, 'plant-a', Math.PI * 0.25, 0.7);
  if (f.front) shelf(kit, f, f.small ? 6.25 : 1.75, 0.19, 0, 41 + f.slot, 'books');
  else shelf(kit, f, 6.1, 0.19, 0, 41 + f.slot, 'books');
  // sofa corner against the outer wall
  const sofa = await kit.glb(`${P}khronos/GlamVelvetSofa.glb`, { width: 1.95 });
  sofa.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.MeshPhysicalMaterial | undefined;
    if (m && /fabric/i.test(m.name)) {
      m.color.set(f.slot % 2 ? '#8f5a42' : '#6f7d5c'); // rust or olive velvet
      if ('sheenColor' in m) m.sheenColor.set(f.slot % 2 ? '#e3a585' : '#c9d4a8');
    }
  });
  const sv = 3.8;
  f.place(kit, sofa, 0.5, sv, Math.PI / 2);
  f.block(kit, 0.5, sv, 1.95, 0.95, Math.PI / 2);
  for (const [k, dv] of [-0.45, 0.45].entries()) f.station(kit, 'sofa', `sofa-${k}`, 0.62, sv + dv, Math.PI / 2, { sit: { seatY: 0.44 } });
  kit.root.add(Object.assign(rug(pal, 2.7, 1.9, 'general-rug', '#ece2d2', '#c98f6b', '#8a5a44'), {}));
  const rugObj = kit.root.children[kit.root.children.length - 1];
  const rp = f.vec(1.65, sv);
  rugObj.position.set(rp.x, 0.006, rp.z);
  rugObj.rotation.y = f.yaw(Math.PI / 2);
  const table = await kit.glb(`${P}modern_coffee_table_01_1k.glb`, { height: 0.4, share: true });
  f.place(kit, table, 1.55, sv, 0);
  f.block(kit, 1.55, sv, 0.6, 1.2);
  f.place(kit, group(bookStack(pal, 5 + f.slot), mug(pal, '#3f6e8c').translateX(0.18)), 1.55, sv - 0.2, 0.3, 0.4);
  const arm = await kit.glb(`${P}khronos/SheenChair.glb`, { width: 0.8 });
  arm.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.MeshPhysicalMaterial | undefined;
    if (m && /fabric/i.test(m.name)) { m.color.set('#b07a4e'); if ('sheenColor' in m) m.sheenColor.set('#f0c79a'); }
  });
  f.place(kit, arm, 2.75, sv, -Math.PI / 2);
  f.block(kit, 2.75, sv, 0.8, 0.75, -Math.PI / 2);
  f.station(kit, 'armchair', 'armchair', 2.72, sv, -Math.PI / 2, { sit: { seatY: 0.42 } });
  const basket = await kit.glb(BASKET, { height: 0.32, share: true });
  basket.add(rbox(0.28, 0.1, 0.2, 0.04, pal.boucle(f.slot % 2 ? '#d9c6a8' : '#c8a98c'), 0, 0.26, 0));
  f.place(kit, basket, 2.85, sv + 0.85, 0.5);
  f.block(kit, 2.85, sv + 0.85, 0.4, 0.34);
  lounge(kit, f, { u: 0.42, v: 2.7 });
  // coffee credenza against the inner wall (lean here when "running" something)
  const cred = credenza(kit, 1.3, pal.oak);
  cred.add(coffeeMachine(pal).translateY(0.62).translateX(-0.3));
  const cv = await kit.glb(VASE, { height: 0.3, share: true });
  cv.position.set(0.35, 0.62, 0);
  cred.add(cv, bookStack(pal, 90 + f.slot, 2).translateY(0.62).translateX(0.02));
  f.place(kit, cred, W - 0.24, 2.3, -Math.PI / 2);
  f.block(kit, W - 0.24, 2.3, 1.3, 0.46, -Math.PI / 2);
  f.station(kit, 'coffee', 'coffee', W - 0.92, 2.0, Math.PI / 2);
  f.station(kit, 'counter', 'counter', W - 0.92, 2.75, Math.PI / 2);
  plant(kit, f, bigPlant, W - 0.45, D - 0.45, 'plant-b', -Math.PI * 0.75, 2.2);
  // prints
  if (!f.front) {
    f.onWall(kit, 'display', framedArt(kit, 0.5, 0.66, 20 + f.slot, ['#c86f4f', '#e4c9a5', '#5c6b56', '#2f3b46']), 7.35, 0.02, 2.05, 2.1);
    f.onWall(kit, 'display', framedArt(kit, 0.36, 0.46, 30 + f.slot, ['#3f6e8c', '#e9dcc6', '#c9a063', '#8b3a2f']), 8.0, 0.02, 1.85, 2.1);
  }
  f.onWall(kit, 'outer', framedArt(kit, 0.9, 0.6, 40 + f.slot, ['#d8b48e', '#efe2cc', '#7d8a72', '#3b4a6b']), 0.02, sv, 2.05, 2.1);
  const c = mid(row);
  await pendants(kit, f, f.small ? [[c, 1.9]] : [[c - 1.45, 1.9], [c + 1.45, 1.9]]);
  mainLight(kit, f, c, 2.3);
  centers(kit, f, f.small ? [[3.6, 3.35], [4.6, 3.75], [5.6, 3.3]] : [[4.2, 3.35], [5.4, 3.7], [6.6, 3.3]]);
  vacuum(kit, f, f.small ? 3.4 : 3.6, 3.0, f.small ? 6.0 : 7.4, D - 0.6);
}

/** Dev lab: dual-monitor desks, a server rack with blinking LEDs, a standing desk under a whiteboard,
 *  a bean bag corner, mini fridge + espresso, tech books. */
async function codeRoom(kit: Kit, f: RoomFrame, out: RoomFurnished, tint: string) {
  const { pal } = kit;
  const W = f.W, D = f.D;
  const row = deskRow4(f);
  const { us } = row;
  await deskRow(kit, f, out, row, tint, {
    device: (i, s) => {
      const g = new THREE.Group();
      if (f.small) {
        // compact desk: one monitor and the laptop beside it
        const m1 = buildMonitor(kit, s);
        m1.position.set(-0.12, DESK_H, -0.18);
        const lt = buildLaptop(kit, s);
        lt.position.set(0.38, DESK_H, -0.08);
        lt.rotation.y = -0.35;
        g.add(m1, lt);
      } else {
        const m1 = buildMonitor(kit, s);
        m1.position.set(-0.33, DESK_H, -0.18);
        m1.rotation.y = 0.16;
        const m2 = buildMonitor(kit, s);
        m2.position.set(0.33, DESK_H, -0.18);
        m2.rotation.y = -0.16;
        g.add(m1, m2);
      }
      g.add(deskCable(pal, -0.08, row.w / 2).translateY(DESK_H));
      // mechanical keyboard + mouse pad
      g.add(rbox(0.44, 0.03, 0.14, 0.006, paint(pal, i % 2 ? '#2a2c30' : '#e9e5dd', 0.5), 0, DESK_H, 0.22));
      g.add(rbox(0.3, 0.004, 0.25, 0.004, paint(pal, '#1f2124', 0.9), 0.42, DESK_H, 0.18));
      g.add(mug(pal, ['#c86f4f', '#3f6e8c', '#e9e2d4', '#2f4b3e'][i % 4]).translateX(-row.w / 2 + 0.13).translateY(DESK_H).translateZ(0.1));
      return g;
    },
  });
  // server rack in the display/outer corner
  const rack = serverRack(kit, 7 + f.slot);
  f.place(kit, rack.group, 0.42, 0.45, 0);
  f.block(kit, 0.42, 0.45, 0.62, 0.82);
  f.station(kit, 'workbench', 'rack-floor', 0.45, 1.1, Math.PI);
  kit.updaters.push((_dt, t) => rack.update(t));
  kit.addLamp(f.vec(0.45, 1.0, 1.2), { intensity: 0.6, distance: 2.2, color: '#7fb6ff' });
  // standing desk + whiteboard on the outer wall
  const sd = standingDesk(kit, 1.2);
  const lap = kit.own(new Screen(380 + f.slot, out.atlas));
  out.screens.push(lap);
  const lt = buildLaptop(kit, lap);
  lt.position.set(0, 1.05, -0.05);
  sd.add(lt);
  f.place(kit, sd, 0.36, 3.75, Math.PI / 2);
  f.block(kit, 0.36, 3.75, 1.2, 0.7, Math.PI / 2);
  f.station(kit, 'counter', 'standing', 1.08, 3.75, -Math.PI / 2, { screen: { setActive: (on, t) => lap.setActive(on, t ?? tint) } });
  f.onWall(kit, 'outer', whiteboard(kit, 1.6, 0.95, tint), 0.02, 3.75, 1.85, 2.3); // centred: 1.35 – 2.35 m
  // tech bookshelf
  if (f.front) shelf(kit, f, f.small ? 6.25 : 1.75, 0.19, 0, 61 + f.slot, 'books');
  else shelf(kit, f, 6.1, 0.19, 0, 61 + f.slot, 'books');
  // lounge: armchair + bean bag on a charcoal rug, floor lamp
  const rugM = rug(pal, 2.4, 1.6, 'code-rug', '#3a3d42', '#596069', '#25272a');
  const rp = f.vec(f.small ? 2.6 : 3.1, D - 0.95);
  rugM.position.set(rp.x, 0.006, rp.z);
  kit.root.add(rugM);
  const arm = await kit.glb(`${P}modern_arm_chair_01_1k.glb`, { height: 0.95, share: true });
  const au = f.small ? 2.0 : 2.5;
  f.place(kit, arm, au, D - 0.85, Math.PI - 0.35);
  f.block(kit, au, D - 0.85, 0.82, 0.9, Math.PI - 0.35);
  f.station(kit, 'armchair', 'armchair', au + Math.sin(f.yaw(Math.PI - 0.35)) * 0.0, D - 0.91, Math.PI - 0.35, { sit: { seatY: 0.43 } });
  const bag = beanBag(pal, '#c86f4f');
  f.place(kit, bag, au + 1.15, D - 0.95, 0.4);
  f.block(kit, au + 1.15, D - 0.95, 0.75, 0.75);
  lounge(kit, f, { u: au - 0.75, v: D - 0.45 });
  // mini fridge + espresso by the inner wall, a big plant in the corner
  const fridge = miniFridge(pal, '#2f3337');
  fridge.add(coffeeMachine(pal).translateY(0.85));
  f.place(kit, fridge, W - 0.28, 2.25, -Math.PI / 2);
  f.block(kit, W - 0.28, 2.25, 0.52, 0.54, -Math.PI / 2);
  f.station(kit, 'coffee', 'coffee', W - 0.98, 2.25, Math.PI / 2);
  const bigPlant = await kit.glb(`${P}potted_plant_02_1k.glb`, { height: 1.2, share: true });
  if (!f.small) plant(kit, f, bigPlant, W - 0.45, 0.45, 'plant-a', Math.PI * 0.75, 1.1);
  plant(kit, f, bigPlant, W - 0.45, D - 0.45, 'plant-b', -Math.PI * 0.75, 2.6);
  // wall shelf with gadgets above the desks' far end, a neon-ish poster
  if (!f.front) {
    f.onWall(kit, 'display', framedArt(kit, 0.6, 0.85, 50 + f.slot, ['#24384f', tint, '#e9e5dd', '#596069'], pal.blackMetal), 7.35, 0.02, 2.2, 2.25);
    f.onWall(kit, 'display', wallShelf(pal, 0.9, 70 + f.slot), 8.15, 0.0, 1.5, 1.6);
  }
  mainLight(kit, f, (us[0] + us[us.length - 1]) / 2, 2.2, '#ffe1bd', 3.2, CEIL - 0.8);
  centers(kit, f, f.small ? [[4.3, 3.4], [5.2, 3.75], [5.9, 3.25]] : [[4.9, 3.35], [6.1, 3.65], [7.2, 3.3]]);
  vacuum(kit, f, f.small ? 3.9 : 4.4, 3.05, f.small ? 6.1 : 7.5, D - 0.65);
}

/** Writer's study: walnut desks with banker's lamps and manuscripts, wall of books, a reading nook with two
 *  armchairs, a floor lamp and a warm rug, a tea cart. */
async function writeRoom(kit: Kit, f: RoomFrame, out: RoomFurnished, tint: string) {
  const { pal } = kit;
  const W = f.W, D = f.D;
  const row = deskRow4(f, 1.38);
  const chairProto = await kit.glb(`${P}dining_chair_02_1k.glb`, { height: 0.95, share: true });
  await deskRow(kit, f, out, row, tint, {
    desk: (_i, w) => writingDesk(kit, w),
    depth: 0.72,
    chair: async () => chairProto.clone(),
    device: (i, s) => {
      const g = new THREE.Group();
      const lt = buildLaptop(kit, s);
      lt.position.set(-0.1, DESK_H + 0.006, -0.02);
      g.add(lt);
      const half = row.w / 2;
      const lamp = bankerLamp(pal);
      lamp.position.set(-half + 0.2, DESK_H, -0.2);
      g.add(lamp);
      const ps = paperStack(pal, 5 + i);
      ps.position.set(half - 0.33, DESK_H, -0.05);
      ps.rotation.y = 0.2;
      g.add(ps);
      if (!f.small) g.add(bookStack(pal, 11 + i * 3 + f.slot, 3).translateX(half - 0.3).translateY(DESK_H).translateZ(-0.24));
      g.add(mug(pal, ['#e9e2d4', '#8b3a2f', '#2f4b3e', '#c9a063'][i % 4]).translateX(-half + 0.37).translateY(DESK_H).translateZ(0.2));
      g.add(deskCable(pal, -0.1, half).translateY(DESK_H));
      return g;
    },
  });
  // wall of books
  if (f.front) {
    shelf(kit, f, f.small ? 6.25 : 1.75, 0.19, 0, 81 + f.slot, 'books-a');
    if (!f.small) shelf(kit, f, 8.25, 0.19, 0, 91 + f.slot, 'books-b');
  } else {
    shelf(kit, f, 6.05, 0.19, 0, 81 + f.slot, 'books-a');
    shelf(kit, f, 7.3, 0.19, 0, 91 + f.slot, 'books-b');
  }
  // reading nook: bookshelf on the outer wall, two armchairs, side table, floor lamp, rug
  shelf(kit, f, 0.19, 3.85, Math.PI / 2, 101 + f.slot, 'books-c');
  const rugM = rug(pal, 2.9, 2.0, 'write-rug', '#9c4a36', '#e2c08f', '#4e2a20');
  const rp = f.vec(1.95, 3.85);
  rugM.position.set(rp.x, 0.006, rp.z);
  rugM.rotation.y = f.yaw(0.04);
  kit.root.add(rugM);
  const a1 = await kit.glb(`${P}khronos/SheenChair.glb`, { width: 0.8 });
  a1.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.MeshPhysicalMaterial | undefined;
    if (m && /fabric/i.test(m.name)) { m.color.set('#3f5a48'); if ('sheenColor' in m) m.sheenColor.set('#9fc3a8'); }
  });
  f.place(kit, a1, 1.25, 3.55, Math.PI / 2 + 0.35);
  f.block(kit, 1.25, 3.55, 0.8, 0.75, Math.PI / 2 + 0.35);
  f.station(kit, 'armchair', 'nook-a', 1.27, 3.55, Math.PI / 2 + 0.35, { sit: { seatY: 0.42 } });
  const a2 = await kit.glb(`${P}modern_arm_chair_01_1k.glb`, { height: 0.95, share: true });
  f.place(kit, a2, 2.75, 4.15, -Math.PI / 2 - 0.45);
  f.block(kit, 2.75, 4.15, 0.82, 0.9, -Math.PI / 2 - 0.45);
  f.station(kit, 'armchair', 'nook-b', 2.71, 4.13, -Math.PI / 2 - 0.45, { sit: { seatY: 0.43 } });
  const st = sideTable(kit, 0.22, 0.5);
  st.add(bookStack(pal, 33 + f.slot, 2).translateY(0.5));
  st.add(mug(pal, '#e9e2d4').translateY(0.5).translateX(0.12));
  f.place(kit, st, 1.95, 4.35);
  f.block(kit, 1.95, 4.35, 0.45, 0.45);
  lounge(kit, f, { u: 0.95, v: 4.55 });
  // tea cart by the inner wall
  const cart = new THREE.Group();
  cart.add(rbox(0.8, 0.025, 0.45, 0.006, pal.walnut, 0, 0.78, 0), rbox(0.8, 0.025, 0.45, 0.006, pal.walnut, 0, 0.3, 0));
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) cart.add(cyl(0.012, 0.012, 0.8, pal.brass, sx * 0.38, 0, sz * 0.2, 8));
  cart.add(cyl(0.07, 0.08, 0.14, paint(pal, '#e9e2d4', 0.3), -0.2, 0.805, 0, 20)); // teapot
  cart.add(mug(pal, '#8b3a2f').translateX(0.05).translateY(0.805), mug(pal, '#2f4b3e').translateX(0.18).translateY(0.805).translateZ(0.08));
  cart.add(bookRow(pal, 0.5, 120 + f.slot, 0.16, 0.22).translateX(-0.3).translateY(0.325));
  f.place(kit, cart, W - 0.3, 2.3, -Math.PI / 2);
  f.block(kit, W - 0.3, 2.3, 0.85, 0.5, -Math.PI / 2);
  f.station(kit, 'coffee', 'tea', W - 0.95, 2.1, Math.PI / 2);
  f.station(kit, 'counter', 'cart', W - 0.95, 2.75, Math.PI / 2);
  const bigPlant = await kit.glb(`${P}potted_plant_02_1k.glb`, { height: 1.35, share: true });
  plant(kit, f, bigPlant, 0.45, 0.45, 'plant-a', Math.PI * 0.25, 0.3);
  plant(kit, f, bigPlant, W - 0.45, D - 0.45, 'plant-b', -Math.PI * 0.75, 1.7);
  if (!f.front) f.onWall(kit, 'display', framedArt(kit, 0.42, 0.56, 60 + f.slot, ['#9c4a36', '#e2c08f', '#3f5a48', '#2b2622']), 8.25, 0.02, 2.0, 2.1);
  // warm drum pendants: one over the desks, one over the nook
  const c = mid(row);
  kit.hang(f.place(kit, drumPendant(pal, CEIL, '#e9dcc4', 0.27, 0.5), c, 1.9));
  kit.hang(f.place(kit, drumPendant(pal, CEIL, '#d9c2a0', 0.22, 0.55), 1.95, 3.9));
  mainLight(kit, f, c, 2.0, '#ffc98a', 3.2, CEIL - 1.0);
  centers(kit, f, f.small ? [[3.9, 3.4], [4.9, 3.8], [5.8, 3.3]] : [[4.4, 3.35], [5.6, 3.7], [6.8, 3.3]]);
  vacuum(kit, f, f.small ? 3.6 : 3.8, 3.05, f.small ? 6.1 : 7.5, D - 0.6);
}

/** Research library: a long oak library table with chairs on both sides (laptops and open books), shelves on
 *  two walls, a reading corner with a globe, map cabinet, pendants over the table. */
async function researchRoom(kit: Kit, f: RoomFrame, out: RoomFurnished, tint: string) {
  const { pal } = kit;
  const W = f.W, D = f.D;
  const len = f.small ? 2.7 : 3.7;
  const tu = f.small ? 2.1 : 3.0, tv = 2.05;
  const table = libraryTable(kit, len, 1.0);
  f.place(kit, table, tu, tv, 0);
  f.block(kit, tu, tv, len, 1.0);
  const chairProto = await kit.glb(`${P}dining_chair_02_1k.glb`, { height: 0.95, share: true });
  const per = f.small ? 2 : 3;
  const offs = per === 2 ? [-0.6, 0.6] : [-1.15, 0, 1.15];
  let k = 0;
  for (const side of [-1, 1]) {
    for (const du of offs) {
      const u = tu + du;
      const v = tv + side * (0.5 + 0.32);
      const yaw = side < 0 ? 0 : Math.PI;
      const chair = chairProto.clone();
      f.place(kit, chair, u, v, yaw);
      f.block(kit, u, v, 0.46, 0.46);
      const withLaptop = (k + f.slot) % 2 === 0;
      const s = withLaptop ? kit.own(new Screen(400 + f.slot * 10 + k, out.atlas)) : null;
      const top = new THREE.Group();
      if (s) {
        out.screens.push(s);
        const lt = buildLaptop(kit, s);
        lt.rotation.y = 0;
        lt.position.set(0, 0.0, -0.05);
        top.add(lt);
        kit.pickable(lt, { kind: 'computer', label: 'Computer · open a terminal', anchor: f.vec(u, tv + side * 0.25, DESK_H + 0.45) });
      } else {
        // an open book and notes
        const ob = new THREE.Group();
        ob.add(box(0.2, 0.012, 0.28, paint(pal, '#f4efe3', 0.9), -0.1, 0, 0), box(0.2, 0.012, 0.28, paint(pal, '#f4efe3', 0.9), 0.1, 0, 0));
        ob.children[0].rotation.z = 0.06; ob.children[1].rotation.z = -0.06;
        top.add(ob, paperStack(pal, 3).translateX(0.3));
      }
      f.place(kit, top, u, tv + side * 0.24, yaw, DESK_H);
      f.station(kit, 'desk', `seat-${k}`, u, v, yaw, {
        sit: { seatY: 0.47, chair, slide: 0.28 },
        ...(s ? { screen: { setActive: (on: boolean, t?: string) => s.setActive(on, t ?? tint) } } : {}),
      });
      k++;
    }
  }
  f.place(kit, globe(pal), tu - len / 2 + 0.3, tv, 0.5, DESK_H);
  f.place(kit, group(bookStack(pal, 140 + f.slot, 4)), tu + len / 2 - 0.3, tv + 0.1, -0.3, DESK_H);
  // shelves: display wall + the outer wall
  if (f.front) {
    shelf(kit, f, f.small ? 6.25 : 1.75, 0.19, 0, 151 + f.slot, 'books-a');
    if (!f.small) shelf(kit, f, 8.25, 0.19, 0, 161 + f.slot, 'books-b');
  } else {
    shelf(kit, f, 6.05, 0.19, 0, 151 + f.slot, 'books-a');
    shelf(kit, f, 7.3, 0.19, 0, 161 + f.slot, 'books-b');
  }
  shelf(kit, f, 0.19, 3.85, Math.PI / 2, 171 + f.slot, 'books-c');
  // reading corner: two armchairs, side table, floor lamp, rug
  const rugM = rug(pal, 2.4, 1.7, 'research-rug', '#d9dde0', '#5a6a80', '#2f3d55');
  const rp = f.vec(f.small ? 2.9 : 3.3, D - 0.85);
  rugM.position.set(rp.x, 0.006, rp.z);
  kit.root.add(rugM);
  const arm = await kit.glb(`${P}modern_arm_chair_01_1k.glb`, { height: 0.95, share: true });
  const au = f.small ? 2.35 : 2.75;
  f.place(kit, arm, au, D - 0.8, Math.PI - 0.3);
  f.block(kit, au, D - 0.8, 0.82, 0.9, Math.PI - 0.3);
  f.station(kit, 'armchair', 'read-a', au, D - 0.86, Math.PI - 0.3, { sit: { seatY: 0.43 } });
  f.place(kit, arm.clone(), au + 1.25, D - 0.8, Math.PI + 0.3);
  f.block(kit, au + 1.25, D - 0.8, 0.82, 0.9, Math.PI + 0.3);
  f.station(kit, 'armchair', 'read-b', au + 1.25, D - 0.86, Math.PI + 0.3, { sit: { seatY: 0.43 } });
  const st = sideTable(kit, 0.2, 0.5);
  st.add(globe(pal).translateY(0.5).translateX(-0.02));
  f.place(kit, st, au + 0.62, D - 0.5);
  f.block(kit, au + 0.62, D - 0.5, 0.42, 0.42);
  lounge(kit, f, { u: au - 0.7, v: D - 0.45 });
  // map cabinet (filing) + tea by the inner wall
  const cab = await kit.glb(`${P}drawer_cabinet_1k.glb`, { height: 1.15, share: true });
  const cs = cab.userData.size as THREE.Vector3;
  f.place(kit, cab, W - cs.z / 2 - 0.02, 2.2, -Math.PI / 2);
  f.block(kit, W - cs.z / 2 - 0.02, 2.2, cs.x, cs.z, -Math.PI / 2);
  f.station(kit, 'washer', 'files', W - cs.z - 0.55, 2.2, Math.PI / 2);
  f.station(kit, 'counter', 'cabinet', W - cs.z - 0.6, 2.85, Math.PI / 2);
  f.place(kit, group(coffeeMachine(pal)), W - cs.z / 2 - 0.02, 2.2 - 0.25, -Math.PI / 2, cs.y);
  f.station(kit, 'coffee', 'coffee', W - cs.z - 0.6, 1.6, Math.PI / 2);
  const bigPlant = await kit.glb(`${P}potted_plant_02_1k.glb`, { height: 1.25, share: true });
  plant(kit, f, bigPlant, 0.45, 0.45, 'plant-a', Math.PI * 0.25, 1.9);
  plant(kit, f, bigPlant, W - 0.45, D - 0.45, 'plant-b', -Math.PI * 0.75, 0.6);
  if (!f.front) f.onWall(kit, 'display', framedArt(kit, 0.55, 0.42, 70 + f.slot, ['#5a6a80', '#e9dcc6', '#c9a063', '#2f3d55']), 8.3, 0.02, 2.0, 2.1);
  await pendants(kit, f, per === 2 ? [[tu - 0.6, tv], [tu + 0.6, tv]] : [[tu - 1.15, tv], [tu, tv], [tu + 1.15, tv]]);
  mainLight(kit, f, tu, tv, '#ffd09a', 3.4);
  centers(kit, f, f.small ? [[1.2, 3.4], [4.0, 3.0], [4.2, 2.0]] : [[1.5, 3.3], [5.4, 3.1], [5.6, 2.2]]);
  vacuum(kit, f, 1.0, 3.25, f.small ? 4.0 : 5.6, 3.25);
}
