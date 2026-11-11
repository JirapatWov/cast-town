// Kitchen + dining: olive-green cabinet run with a marble top, tiled backsplash, sink under the
// window, cooktop + steel hood, tall fridge, espresso machine, and an oak dining table with chairs.
import * as THREE from 'three';
import { ROOM } from '../layout';
import { practicalGlobes } from '../lighting';
import { Kit, box, cyl, group, rbox } from './kit';

const BACK = -ROOM.halfD;
const DEPTH = 0.62, TOP = 0.92;
const RUN = { x0: -8.15, x1: -3.95 };
const MODULE = 0.6;

export async function furnishKitchen(kit: Kit) {
  const { pal } = kit;
  const front = pal.paint('#5c6b56', 0.42); // olive lacquer
  const handle = pal.brass;
  const zc = BACK + DEPTH / 2;

  // ── base cabinets ──
  const run = new THREE.Group();
  run.name = 'kitchen-run';
  const n = Math.round((RUN.x1 - RUN.x0) / MODULE);
  const kinds = ['drawers', 'door', 'sink', 'dishwasher', 'drawers', 'oven', 'door'];
  for (let i = 0; i < n; i++) {
    const x = RUN.x0 + MODULE * (i + 0.5);
    const kind = kinds[i] ?? 'door';
    run.add(box(MODULE - 0.004, 0.1, DEPTH - 0.08, pal.rubber, x, 0, zc - 0.04)); // toe kick
    run.add(box(MODULE - 0.004, TOP - 0.14, DEPTH - 0.04, pal.lacquer, x, 0.1, zc - 0.02)); // carcass
    const fz = BACK + DEPTH - 0.02;
    if (kind === 'drawers') {
      const hs = [0.2, 0.25, 0.3];
      let y = 0.11;
      for (const h of hs.reverse()) {
        run.add(rbox(MODULE - 0.012, h - 0.008, 0.02, 0.004, front, x, y, fz));
        run.add(box(0.22, 0.012, 0.018, handle, x, y + h - 0.05, fz + 0.02));
        y += h;
      }
    } else if (kind === 'dishwasher') {
      run.add(rbox(MODULE - 0.012, TOP - 0.15, 0.02, 0.004, pal.steel, x, 0.11, fz));
      run.add(box(0.4, 0.014, 0.02, pal.blackMetal, x, TOP - 0.12, fz + 0.02));
    } else if (kind === 'oven') {
      run.add(rbox(MODULE - 0.012, 0.18, 0.02, 0.004, front, x, 0.11, fz));
      run.add(rbox(MODULE - 0.012, TOP - 0.34, 0.022, 0.004, pal.screenOff, x, 0.3, fz));
      run.add(box(0.46, 0.014, 0.02, pal.steel, x, TOP - 0.1, fz + 0.025));
      run.add(box(0.36, 0.2, 0.002, pal.emissive('#ff9a4a', 0.0), x, 0.4, fz + 0.012));
    } else {
      run.add(rbox(MODULE - 0.012, TOP - 0.15, 0.02, 0.004, front, x, 0.11, fz));
      run.add(box(0.012, 0.18, 0.018, handle, x + (i % 2 ? -1 : 1) * (MODULE / 2 - 0.06), TOP - 0.3, fz + 0.02));
    }
  }
  // marble worktop with the sink cut-out
  const sinkX = RUN.x0 + MODULE * 2.5;
  const topY = TOP - 0.04;
  const lenL = sinkX - 0.26 - RUN.x0, lenR = RUN.x1 - (sinkX + 0.26);
  run.add(box(lenL, 0.04, DEPTH + 0.02, pal.marble, RUN.x0 + lenL / 2, topY, zc + 0.01));
  run.add(box(lenR, 0.04, DEPTH + 0.02, pal.marble, RUN.x1 - lenR / 2, topY, zc + 0.01));
  run.add(box(0.52, 0.04, 0.09, pal.marble, sinkX, topY, BACK + 0.045));
  run.add(box(0.52, 0.04, 0.1, pal.marble, sinkX, topY, BACK + DEPTH - 0.04));
  // sink basin + faucet
  run.add(box(0.5, 0.2, 0.42, pal.steel, sinkX, TOP - 0.24, zc + 0.01));
  const basinIn = box(0.46, 0.01, 0.38, pal.paint('#8f9396', 0.3), sinkX, TOP - 0.22, zc + 0.01);
  run.add(basinIn);
  run.add(cyl(0.018, 0.022, 0.3, pal.steel, sinkX, TOP, BACK + 0.08, 14));
  const spout = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.014, 10, 20, Math.PI), pal.steel);
  spout.position.set(sinkX, TOP + 0.3, BACK + 0.18);
  spout.rotation.y = Math.PI / 2;
  run.add(spout);
  // cooktop
  const cookX = RUN.x0 + MODULE * 5.5;
  run.add(box(0.58, 0.008, 0.5, pal.screenOff, cookX, TOP, zc + 0.02));
  for (const [dx, dz] of [[-0.14, -0.11], [0.14, -0.11], [-0.14, 0.12], [0.14, 0.12]]) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.075, 0.004, 6, 28), pal.paint('#3a3c3f', 0.4));
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(cookX + dx, TOP + 0.009, zc + 0.02 + dz);
    run.add(ring);
  }
  // pot on the cooktop
  run.add(cyl(0.11, 0.1, 0.14, pal.steel, cookX - 0.14, TOP + 0.01, zc + 0.14, 24));
  kit.add(run, 0, 0);
  kit.block((RUN.x0 + RUN.x1) / 2, zc, RUN.x1 - RUN.x0, DEPTH);

  // ── backsplash tiles (under the window only up to the sill) ──
  const win = { x0: -7.45, x1: -5.85, sill: 1.12 };
  const splashTop = 1.52;
  const splash = (x0: number, x1: number, y1: number) => {
    const w = x1 - x0, h = y1 - TOP;
    const geo = new THREE.PlaneGeometry(w, h);
    const uv = geo.getAttribute('uv');
    for (let i = 0; i < uv.count; i++) uv.setXY(i, x0 + uv.getX(i) * w, TOP + uv.getY(i) * h);
    const m = new THREE.Mesh(geo, pal.tiles);
    m.position.set((x0 + x1) / 2, TOP + h / 2, BACK + 0.004);
    m.receiveShadow = true;
    return m;
  };
  kit.onWall('back', group(splash(RUN.x0, win.x0, splashTop), splash(win.x1, RUN.x1, splashTop), splash(win.x0, win.x1, win.sill)), 1.5);

  // ── upper cabinets + hood ──
  const uppers = new THREE.Group();
  const upper = (x0: number, x1: number) => {
    const w = x1 - x0, x = (x0 + x1) / 2;
    uppers.add(box(w - 0.004, 0.72, 0.34, pal.oak, x, 1.52, BACK + 0.17));
    const doors = Math.max(1, Math.round(w / 0.4));
    for (let k = 0; k < doors; k++) {
      const dw = w / doors, dx = x0 + dw * (k + 0.5);
      uppers.add(rbox(dw - 0.01, 0.7, 0.02, 0.004, pal.oak, dx, 1.53, BACK + 0.35));
      uppers.add(box(0.012, 0.12, 0.018, handle, dx + (k % 2 ? 1 : -1) * (dw / 2 - 0.05), 1.56, BACK + 0.37));
    }
    // warm under-cabinet light strip
    uppers.add(box(w - 0.06, 0.012, 0.03, pal.emissive('#ffd59a', 3.2), x, 1.505, BACK + 0.3));
  };
  upper(RUN.x0, win.x0 - 0.08);
  upper(RUN.x0 + MODULE * 4, cookX - 0.3);
  upper(cookX + 0.3, RUN.x1);
  uppers.add(box(0.62, 0.1, 0.5, pal.steel, cookX, 1.62, BACK + 0.25));
  uppers.add(box(0.28, ROOM.height - 1.72, 0.26, pal.steel, cookX, 1.72, BACK + 0.13));
  kit.onWall('back', uppers, 2.0);
  kit.addLamp(new THREE.Vector3(-6.1, 1.35, BACK + 0.55), { intensity: 1.6, distance: 3.2, color: '#ffcf96' });

  // ── fridge (tall, brushed steel) ──
  const fridge = group(
    rbox(0.78, 1.95, 0.7, 0.02, pal.steel, 0, 0, 0),
    box(0.76, 0.006, 0.01, pal.blackMetal, 0, 1.25, 0.351),
    box(0.02, 0.5, 0.03, pal.blackMetal, -0.3, 1.4, 0.37),
    box(0.02, 0.7, 0.03, pal.blackMetal, -0.3, 0.45, 0.37),
  );
  kit.add(fridge, -8.6, BACK + 0.36, 0);
  kit.block(-8.6, BACK + 0.36, 0.8, 0.72);

  // ── countertop life: espresso machine, mugs, kettle, fruit bowl, cutting board, herbs on the sill ──
  const espresso = group(
    rbox(0.32, 0.36, 0.34, 0.03, pal.steel, 0, 0, 0),
    rbox(0.3, 0.08, 0.3, 0.02, pal.blackMetal, 0, 0.36, 0),
    box(0.22, 0.012, 0.12, pal.blackMetal, 0, 0.06, 0.15),
    cyl(0.03, 0.03, 0.05, pal.blackMetal, 0, 0.22, 0.18, 14),
    cyl(0.035, 0.03, 0.07, pal.ceramic, -0.05, 0.075, 0.15, 14),
  );
  kit.add(espresso, -7.82, BACK + 0.28, 0, TOP);
  kit.add(cyl(0.08, 0.09, 0.2, pal.paint('#d9cdb8', 0.3), 0, 0, 0, 20), -4.35, BACK + 0.25, 0, TOP); // kettle
  const bowl = group(cyl(0.16, 0.08, 0.08, pal.ceramic, 0, 0, 0, 24));
  for (let k = 0; k < 5; k++) {
    const f = new THREE.Mesh(new THREE.SphereGeometry(0.045, 12, 10), pal.paint(['#e09a3a', '#b4382c', '#d7c24a', '#e09a3a', '#7aa03e'][k], 0.5));
    f.position.set(Math.cos(k * 1.3) * 0.07, 0.09 + (k % 2) * 0.03, Math.sin(k * 1.3) * 0.07);
    f.castShadow = true;
    bowl.add(f);
  }
  kit.add(bowl, -5.45, BACK + 0.32, 0, TOP);
  const board = rbox(0.42, 0.025, 0.28, 0.01, pal.oak, 0, 0, 0);
  board.rotation.y = 0.2;
  kit.add(group(board), -7.0, BACK + 0.36, 0, TOP);
  const herbs = await kit.glb('/assets/props-interior/potted_plant_04_1k.glb', { height: 0.26 });
  herbs.position.set(-6.9, win.sill + 0.001, BACK - 0.05);
  const herbs2 = herbs.clone();
  herbs2.position.x = -6.35;
  kit.onWall('back', group(herbs, herbs2), 1.5);

  // ── island (marble top over olive fronts) — people lean on its far side, facing the camera ──
  const ISL = { x: -6.1, z: -3.55, w: 2.2, d: 0.9 };
  const island = group(
    box(ISL.w - 0.06, 0.1, ISL.d - 0.12, pal.rubber, 0, 0, 0),
    box(ISL.w - 0.04, TOP - 0.14, ISL.d - 0.06, front, 0, 0.1, 0),
    box(ISL.w + 0.06, 0.04, ISL.d + 0.06, pal.marble, 0, TOP - 0.04, 0),
  );
  for (let k = 0; k < 4; k++) {
    const dx = -ISL.w / 2 + 0.03 + (ISL.w - 0.06) * (k + 0.5) / 4;
    island.add(box((ISL.w - 0.06) / 4 - 0.012, TOP - 0.16, 0.012, front, dx, 0.11, ISL.d / 2 - 0.025));
    island.add(box(0.2, 0.012, 0.016, handle, dx, TOP - 0.13, ISL.d / 2 - 0.012));
  }
  kit.add(island, ISL.x, ISL.z, 0);
  kit.block(ISL.x, ISL.z, ISL.w, ISL.d);
  // stools on the camera side (decor) + a few things on top
  for (const dx of [-0.6, 0.6]) {
    const stool = group(
      cyl(0.19, 0.19, 0.05, pal.walnut, 0, 0.64, 0, 22),
      ...[0, 1, 2, 3].map((k) => {
        const leg = box(0.025, 0.64, 0.025, pal.blackMetal, Math.cos(k * Math.PI / 2 + 0.8) * 0.13, 0, Math.sin(k * Math.PI / 2 + 0.8) * 0.13);
        return leg;
      }),
      new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.008, 6, 24).rotateX(Math.PI / 2), pal.blackMetal).translateY(0.25),
    );
    kit.add(stool, ISL.x + dx, ISL.z + ISL.d / 2 + 0.38, 0);
    kit.block(ISL.x + dx, ISL.z + ISL.d / 2 + 0.38, 0.4, 0.4);
  }
  const herbs3 = herbs.clone();
  herbs3.position.set(ISL.x + 0.75, TOP, ISL.z);
  kit.root.add(herbs3);
  const bowl2 = bowl.clone();
  kit.add(bowl2, ISL.x - 0.4, ISL.z + 0.05, 0, TOP);
  bowl.visible = false;

  // ── stations: counter/island (lean), sink (dishes), coffee ──
  const edge = BACK + DEPTH;
  kit.stations.add('counter', 'island-a', new THREE.Vector3(ISL.x - 0.55, 0, ISL.z - ISL.d / 2 - 0.42), 0);
  kit.stations.add('counter', 'island-b', new THREE.Vector3(ISL.x + 0.55, 0, ISL.z - ISL.d / 2 - 0.42), 0);
  kit.stations.add('counter', 'counter-stove', new THREE.Vector3(cookX, 0, edge + 0.42), Math.PI);
  kit.stations.add('sink', 'sink', new THREE.Vector3(sinkX, 0, edge + 0.42), Math.PI);
  kit.stations.add('coffee', 'coffee', new THREE.Vector3(-7.82, 0, edge + 0.38), Math.PI);

  // ── dining ──
  const table = await kit.glb('/assets/props-interior/dining_table_1k.glb', { height: 0.76 });
  const tx = -5.0, tz = 2.0;
  kit.add(table, tx, tz, 0);
  const ts = table.userData.size as THREE.Vector3;
  kit.block(tx, tz, ts.x, ts.z);
  const chairProto = await kit.glb('/assets/props-interior/dining_chair_02_1k.glb', { height: 0.95 });
  const seats: [number, number, number][] = [];
  for (const dx of [-0.5, 0.5]) {
    seats.push([tx + dx, tz - ts.z / 2 - 0.22, 0]); // north side, facing +Z
    seats.push([tx + dx, tz + ts.z / 2 + 0.22, Math.PI]); // south side, facing −Z
  }
  seats.forEach(([x, z, yaw], k) => {
    const c = chairProto.clone();
    kit.add(c, x, z, yaw);
    kit.block(x, z, 0.45, 0.45);
    kit.stations.add('dining', `dining-${k}`, new THREE.Vector3(x, 0, z), yaw, { sit: { seatY: 0.47 } });
  });
  const vase = group(cyl(0.05, 0.07, 0.22, pal.paint('#b9a58b', 0.4), 0, 0, 0, 18));
  for (let k = 0; k < 4; k++) {
    const stem = box(0.006, 0.28, 0.006, pal.paint('#5c7a46', 0.8), Math.cos(k * 1.6) * 0.02, 0.2, Math.sin(k * 1.6) * 0.02);
    stem.rotation.z = (k - 1.5) * 0.15;
    vase.add(stem);
    const bloom = new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 8), pal.paint(['#f0d9a8', '#e8b4a0', '#f3efe6', '#e7c46f'][k], 0.8));
    bloom.position.set(Math.cos(k * 1.6) * 0.02 + (k - 1.5) * 0.04, 0.5, Math.sin(k * 1.6) * 0.02);
    vase.add(bloom);
  }
  kit.add(vase, tx, tz, 0, 0.76);
  // pendant over the table
  const pendant = await kit.glb('/assets/props-interior/modern_ceiling_lamp_01_1k.glb', { scale: 1 });
  practicalGlobes(pendant);
  const ph = (pendant.userData.size as THREE.Vector3).y;
  kit.hang(kit.add(pendant, tx, tz, 0, ROOM.height - ph));
  kit.addLamp(new THREE.Vector3(tx, ROOM.height - ph + 0.15, tz), { intensity: 3.2, distance: 5, color: '#ffc27d' });
}
