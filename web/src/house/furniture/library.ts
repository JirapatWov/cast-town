// Library + utility: two oak bookshelves full of books, washer/dryer by the door, a workbench with a
// pegboard tucked under the staircase, storage boxes, a hall rug, and the wall clock (shows the real time).
import * as THREE from 'three';
import { ROOM } from '../layout';
import { practical } from '../lighting';
import { mulberry32 } from '../../people/rng';
import { Kit, box, cyl, group, metricUV, rbox } from './kit';

const W = ROOM.halfW;
const BOOK_COLORS = ['#8b3a2f', '#2f4b3e', '#3b4a6b', '#c9a063', '#e2d6c2', '#6d5a4b', '#a8604a', '#56636e', '#d9c8a9', '#3e3a36', '#7d8a72', '#b88a5a'];

export function buildBookshelf(kit: Kit, seed: number): THREE.Group {
  const { pal } = kit;
  const g = new THREE.Group();
  const w = 1.2, h = 2.05, d = 0.36, t = 0.03;
  g.add(box(t, h, d, pal.oak, -w / 2 + t / 2, 0, 0));
  g.add(box(t, h, d, pal.oak, w / 2 - t / 2, 0, 0));
  g.add(box(w, t, d, pal.oak, 0, h - t, 0));
  g.add(box(w - 2 * t, 0.012, 0.01, pal.oak, 0, 0, -d / 2 + 0.005)); // back rail
  g.add(box(w - 2 * t, h - 0.02, 0.012, pal.paint('#d8ccb9', 0.8), 0, 0.01, -d / 2 + 0.006)); // back panel
  const shelves = [0.06, 0.46, 0.86, 1.26, 1.66];
  for (const y of shelves) g.add(box(w - 2 * t, t, d - 0.02, pal.oak, 0, y, 0.005));
  // books: one instanced mesh per bookshelf with per-instance colors
  const r = mulberry32(seed);
  const mats: THREE.Matrix4[] = [];
  const cols: THREE.Color[] = [];
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  for (const y0 of shelves) {
    let x = -w / 2 + t + 0.02;
    const end = w / 2 - t - 0.02;
    while (x < end - 0.03) {
      if (r() < 0.08) { x += 0.12 + r() * 0.1; continue; } // gap for decor
      if (r() < 0.1) {
        // a short horizontal stack
        let yy = y0 + t;
        const sw = 0.18 + r() * 0.06;
        if (x + sw > end) break;
        for (let k = 0; k < 2 + Math.floor(r() * 3); k++) {
          const bh = 0.03 + r() * 0.02;
          s.set(sw - r() * 0.03, bh, 0.15 + r() * 0.06);
          p.set(x + sw / 2, yy + bh / 2, 0.02);
          q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), (r() - 0.5) * 0.15);
          mats.push(m.compose(p, q, s).clone());
          cols.push(new THREE.Color(BOOK_COLORS[Math.floor(r() * BOOK_COLORS.length)]));
          yy += bh;
        }
        x += sw + 0.02;
        continue;
      }
      const bw = 0.022 + r() * 0.03, bh = 0.2 + r() * 0.13, bd = 0.17 + r() * 0.08;
      const lean = r() < 0.07 ? 0.25 : 0;
      s.set(bw, bh, bd);
      p.set(x + bw / 2 + lean * bh * 0.5, y0 + t + bh / 2 * Math.cos(lean), 0.03 - (0.24 - bd) / 2);
      q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), -lean);
      mats.push(m.compose(p, q, s).clone());
      cols.push(new THREE.Color(BOOK_COLORS[Math.floor(r() * BOOK_COLORS.length)]).multiplyScalar(0.85 + r() * 0.25));
      x += bw + (lean ? bh * 0.4 : 0.002);
    }
  }
  const books = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), pal.paint('#ffffff', 0.85), mats.length);
  mats.forEach((mm, i) => { books.setMatrixAt(i, mm); books.setColorAt(i, cols[i]); });
  books.castShadow = false; // the shelf casts; books inside it would only add a shadow draw per cascade
  books.userData.batchable = true; // merged into the room batch (batch.ts)
  books.receiveShadow = true;
  g.add(books);
  // a couple of decor objects
  g.add(cyl(0.05, 0.06, 0.16, pal.paint('#c86f4f', 0.4), 0.38, 1.29, 0.02, 16));
  g.add(cyl(0.07, 0.07, 0.05, pal.ceramic, -0.4, 0.89, 0.02, 18));
  return g;
}

function buildWasher(kit: Kit, dryer: boolean): THREE.Group {
  const { pal } = kit;
  const white = pal.paint('#f2f0eb', 0.3);
  const g = group(rbox(0.6, 0.85, 0.6, 0.03, white, 0, 0, 0));
  g.add(box(0.56, 0.1, 0.01, pal.paint('#e2e0da', 0.4), 0, 0.72, 0.3));
  const knob = cyl(0.028, 0.028, 0.025, pal.steel, 0, 0, 0, 16);
  knob.rotation.x = Math.PI / 2;
  knob.position.set(0.18, 0.77, 0.31);
  g.add(knob);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.022, 10, 32), pal.steel);
  ring.position.set(0, 0.4, 0.305);
  g.add(ring);
  const glass = new THREE.Mesh(new THREE.CircleGeometry(0.16, 32), dryer ? pal.screenOff : pal.paint('#5d6c74', 0.08));
  glass.position.set(0, 0.4, 0.302);
  g.add(glass);
  return g;
}

function buildWorkbench(kit: Kit): THREE.Group {
  const { pal } = kit;
  const g = new THREE.Group();
  const w = 1.7, d = 0.66, h = 0.9;
  g.add(rbox(w, 0.06, d, 0.008, pal.oak, 0, h - 0.06, 0));
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) g.add(box(0.05, h - 0.06, 0.05, pal.blackMetal, sx * (w / 2 - 0.06), 0, sz * (d / 2 - 0.06)));
  g.add(box(w - 0.1, 0.03, d - 0.1, pal.walnut, 0, 0.18, 0));
  // storage boxes on the lower shelf
  g.add(rbox(0.42, 0.24, 0.36, 0.01, pal.paint('#c9b08a', 0.9), -0.45, 0.21, 0));
  g.add(rbox(0.36, 0.2, 0.32, 0.01, pal.paint('#4c5a63', 0.6), 0.25, 0.21, 0.02));
  // vise + toolbox + lamp on top
  g.add(box(0.12, 0.1, 0.16, pal.paint('#3a5f7a', 0.5), 0.65, h, 0.18));
  g.add(rbox(0.4, 0.16, 0.2, 0.01, pal.paint('#a8382c', 0.45), -0.45, h, 0.05));
  // pegboard on the wall behind + tools
  const peg = new THREE.Group();
  peg.add(box(w, 0.8, 0.02, pal.paint('#cdb38f', 0.9), 0, 1.15, -d / 2 - 0.01));
  const tool = (tw: number, th: number, x: number, y: number, c: string) => peg.add(box(tw, th, 0.02, pal.paint(c, 0.5), x, y, -d / 2 + 0.01));
  tool(0.04, 0.3, -0.6, 1.4, '#3a3c3f'); tool(0.14, 0.04, -0.6, 1.68, '#8a8d90');
  tool(0.03, 0.26, -0.35, 1.42, '#a8382c'); tool(0.03, 0.22, -0.25, 1.45, '#e0b24a');
  tool(0.05, 0.28, 0.0, 1.4, '#6b6f73'); tool(0.25, 0.04, 0.35, 1.62, '#3a3c3f'); tool(0.04, 0.2, 0.55, 1.45, '#3a5f7a');
  g.add(peg);
  return g;
}

export async function furnishLibrary(kit: Kit) {
  const { pal } = kit;
  // bookshelves on the left wall, facing +X
  for (const [i, z] of [-0.95, 0.35].entries()) {
    const shelf = buildBookshelf(kit, 17 + i * 13);
    kit.add(shelf, -W + 0.2, z, Math.PI / 2);
    kit.block(-W + 0.2, z, 1.2, 0.38, Math.PI / 2);
    kit.stations.add('bookshelf', `books-${i}a`, new THREE.Vector3(-W + 0.95, 0, z - 0.3), -Math.PI / 2);
    kit.stations.add('bookshelf', `books-${i}b`, new THREE.Vector3(-W + 0.95, 0, z + 0.3), -Math.PI / 2);
  }
  // washer + dryer past the door
  for (const [i, z] of [4.25, 4.95].entries()) {
    const wsh = buildWasher(kit, i === 1);
    kit.add(wsh, -W + 0.33, z, Math.PI / 2);
    kit.block(-W + 0.33, z, 0.62, 0.62, Math.PI / 2);
  }
  kit.stations.add('washer', 'washer', new THREE.Vector3(-W + 1.15, 0, 4.25), -Math.PI / 2);
  const basket = group(cyl(0.2, 0.17, 0.32, pal.fabric('#cbb894', 1), 0, 0, 0, 20));
  kit.add(basket, -W + 0.45, 5.6, 0);

  // workbench + storage tucked under the staircase along the right wall (the flight climbs over them from the
  // front, so the tall pegboard sits under the high end and the low boxes under the first steps)
  const bench = buildWorkbench(kit);
  const benchX = W - 0.35, benchZ = 1.35;
  kit.add(bench, benchX, benchZ, -Math.PI / 2);
  kit.block(benchX, benchZ, 1.7, 0.68, -Math.PI / 2);
  kit.stations.add('workbench', 'bench-lean', new THREE.Vector3(benchX - 0.33 - 0.47, 0, benchZ - 0.25), Math.PI / 2);
  kit.stations.add('workbench', 'bench-floor', new THREE.Vector3(W - 1.55, 0, 3.05), Math.PI / 2);
  const toolbox = rbox(0.42, 0.2, 0.22, 0.01, pal.paint('#3a5f7a', 0.45), 0, 0, 0);
  kit.add(group(toolbox), W - 0.95, 3.05, Math.PI / 2);
  kit.addLamp(new THREE.Vector3(W - 0.6, 1.75, benchZ), { intensity: 1.1, distance: 3, color: '#ffd6a0' });
  for (const [k, [z, h, w]] of ([[3.55, 0.5, 0.52], [4.15, 0.34, 0.46]] as const).entries()) {
    const b = rbox(w, h, 0.5, 0.012, pal.paint(['#c9b08a', '#b7a07e'][k], 0.9), 0, 0, 0);
    kit.add(group(b), W - 0.4, z, -Math.PI / 2 + (k ? 0.08 : -0.04));
    kit.block(W - 0.4, z, w, 0.5, -Math.PI / 2);
  }
  const crate = rbox(0.34, 0.22, 0.3, 0.01, pal.paint('#4c5a63', 0.6), 0, 0, 0);
  kit.add(group(crate), W - 0.38, 3.55, -Math.PI / 2 + 0.2, 0.5);

  // hall: round jute rug, bench + plants along the front wall
  const rug = new THREE.Mesh(metricUV(new THREE.CylinderGeometry(1.5, 1.5, 0.012, 64)), pal.jute);
  rug.position.set(1.4, 0.006, 3.0);
  rug.receiveShadow = true;
  kit.root.add(rug);
  // reading lounge on the rug: two armchairs facing each other, a round table and a floor lamp
  const lounge = await kit.glb('/assets/props-interior/modern_arm_chair_01_1k.glb', { height: 0.95 });
  for (const [x, yaw] of [[0.35, Math.PI / 2 - 0.25], [2.45, -Math.PI / 2 + 0.25]] as const) {
    const c = lounge.clone();
    kit.add(c, x, 3.0, yaw);
    kit.block(x, 3.0, 0.8, 0.85, yaw);
    kit.stations.add('armchair', `lounge-${x}`, new THREE.Vector3(x + Math.sin(yaw) * 0.06, 0, 3.0 + Math.cos(yaw) * 0.06), yaw, { sit: { seatY: 0.43 } });
  }
  const roundTable = group(cyl(0.32, 0.32, 0.03, pal.walnut, 0, 0.5, 0, 28), cyl(0.025, 0.03, 0.5, pal.blackMetal, 0, 0, 0, 10), cyl(0.2, 0.22, 0.02, pal.blackMetal, 0, 0, 0, 20));
  roundTable.add(cyl(0.05, 0.045, 0.1, pal.paint('#3f6e8c', 0.35), 0.1, 0.53, 0.05, 16));
  roundTable.add(rbox(0.2, 0.03, 0.15, 0.004, pal.paint('#8b3a2f', 0.7), -0.08, 0.53, -0.06));
  kit.add(roundTable, 1.4, 3.0, 0);
  kit.block(1.4, 3.0, 0.65, 0.65);
  const floorLamp = group(
    cyl(0.14, 0.15, 0.025, pal.blackMetal, 0, 0, 0, 24),
    cyl(0.012, 0.012, 1.45, pal.brass, 0, 0.02, 0, 10),
  );
  const lshade = cyl(0.17, 0.22, 0.3, practical(pal.emissive('#ffd9a8', 1.2)), 0, 1.38, 0, 28);
  const lm = lshade.material as THREE.MeshStandardMaterial;
  lm.color.set('#efe2cc');
  lm.side = THREE.DoubleSide;
  floorLamp.add(lshade);
  kit.add(floorLamp, 1.4, 3.85, 0);
  kit.block(1.4, 3.85, 0.35, 0.35);
  kit.addLamp(new THREE.Vector3(1.4, 1.5, 3.85), { intensity: 2.2, distance: 5, color: '#ffc58a' });

  const hallBench = group(rbox(1.5, 0.05, 0.4, 0.01, pal.oak, 0, 0.42, 0), ...[-0.65, 0.65].flatMap((x) => [box(0.04, 0.42, 0.34, pal.blackMetal, x, 0, 0)]));
  kit.add(hallBench, 0, ROOM.halfD - 0.35, 0);
  kit.block(0, ROOM.halfD - 0.35, 1.5, 0.42);
  const plant = await kit.glb('/assets/props-interior/potted_plant_02_1k.glb', { height: 1.1 });
  kit.add(plant, -3.0, ROOM.halfD - 0.45, 1.2);
  kit.block(-3.0, ROOM.halfD - 0.45, 0.55, 0.55);
  kit.stations.add('plants', 'plant-hall', new THREE.Vector3(-3.0, 0, ROOM.halfD - 1.25), 0);
  const plant2 = plant.clone();
  kit.add(plant2, 3.1, ROOM.halfD - 0.45, 2.7);
  kit.block(3.1, ROOM.halfD - 0.45, 0.55, 0.55);

  // wall clock — real time
  const clock = await kit.glb('/assets/props-interior/wall_clock_1k.glb', { scale: 1.15, center: false });
  clock.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && /glass/i.test((m.material as THREE.Material).name)) {
      m.material = new THREE.MeshStandardMaterial({ color: '#ffffff', transparent: true, opacity: 0.12, roughness: 0.05 });
      m.castShadow = false;
    }
  });
  clock.position.set(-3.67, 1.78, -ROOM.halfD + 0.005);
  clock.userData.noBatch = true; // hands rotate
  kit.onWall('back', clock, 2.1);
  const hands = { h: clock.getObjectByName('wall_clock_hours_hand'), m: clock.getObjectByName('wall_clock_minute_hand'), s: clock.getObjectByName('wall_clock_second_hand') };
  kit.updaters.push(() => {
    const d = new Date();
    const sec = d.getSeconds() + d.getMilliseconds() / 1000;
    const min = d.getMinutes() + sec / 60;
    const hr = (d.getHours() % 12) + min / 60;
    if (hands.s) hands.s.rotation.z = -(sec / 60) * Math.PI * 2;
    if (hands.m) hands.m.rotation.z = -(min / 60) * Math.PI * 2;
    if (hands.h) hands.h.rotation.z = -(hr / 12) * Math.PI * 2;
  });

  // vacuum route: a loop over the open floor in front of the sofa
  kit.stations.add('vacuum', 'vacuum', new THREE.Vector3(-0.5, 0, 1.2), Math.PI / 2, {
    route: [new THREE.Vector3(-1.8, 0, 0.6), new THREE.Vector3(3.8, 0, 0.6), new THREE.Vector3(3.8, 0, 4.6), new THREE.Vector3(-1.8, 0, 4.6)],
  });
  // open-floor spots for listening / calling the user (face the camera)
  const centers: [number, number][] = [[-0.6, 1.6], [1.4, 1.75], [3.3, 1.9], [-1.4, 3.3], [4.1, 3.6], [-0.4, 4.6]];
  centers.forEach(([x, z], i) => kit.stations.add('center', `center-${i}`, new THREE.Vector3(x, 0, z), 0));
}
