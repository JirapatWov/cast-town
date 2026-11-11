// Living room: walnut media console + big wall TV (live git diff), velvet sofa facing it, armchair,
// coffee table on a wool rug, arc floor lamp, plants and framed prints.
import * as THREE from 'three';
import { ROOM } from '../layout';
import { practical } from '../lighting';
import { rug } from '../rooms/pieces';
import { artTexture } from '../textures';
import type { TvScreen } from '../tv';
import { Kit, box, cyl, group, rbox } from './kit';

const BACK = -ROOM.halfD;
export const SOFA = { x: 0, z: -1.35 };

export async function furnishLiving(kit: Kit, tv: TvScreen) {
  const { pal } = kit;

  // ── media console + TV ──
  const console_ = await kit.glb('/assets/props-interior/modern_wooden_cabinet_1k.glb', { width: 2.2 });
  const cs = console_.userData.size as THREE.Vector3;
  kit.add(console_, 0, BACK + cs.z / 2 + 0.02, 0);
  kit.block(0, BACK + cs.z / 2 + 0.02, cs.x, cs.z);
  const tvGroup = new THREE.Group();
  const TW = 1.86, TH = 1.05;
  tvGroup.add(rbox(TW + 0.03, TH + 0.03, 0.035, 0.008, pal.plastic, 0, -0.015 - TH / 2, 0));
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(TW, TH), tv.material);
  screen.position.set(0, 0, 0.0185);
  screen.name = 'tv-screen';
  tvGroup.add(screen);
  tvGroup.position.set(0, cs.y + 0.32 + TH / 2, BACK + 0.04);
  kit.onWall('back', tvGroup, 2.0);
  kit.pickable(tvGroup, { kind: 'tv', label: 'TV · view changes', anchor: new THREE.Vector3(0, tvGroup.position.y + TH / 2 + 0.15, BACK + 0.1) });
  // a soft glow pool from the screen
  kit.addLamp(new THREE.Vector3(0, tvGroup.position.y, BACK + 0.6), { intensity: 0.9, distance: 3.5, color: '#9fc4ff' });
  // console decor
  const decor = group(
    box(0.05, 0.24, 0.17, pal.paint('#c9a063', 0.6), -0.95, 0, 0),
    box(0.045, 0.21, 0.16, pal.paint('#2f4b3e', 0.7), -0.9, 0, 0),
    box(0.05, 0.26, 0.18, pal.paint('#e6dccb', 0.7), -0.85, 0, 0),
    cyl(0.07, 0.05, 0.22, pal.paint('#d6c6ad', 0.35), 0.9, 0, 0, 20),
  );
  kit.add(decor, 0, BACK + cs.z / 2, 0, cs.y);

  // ── rug + coffee table ──
  const livingRug = rug(pal, 3.4, 2.4, 'living', '#e9dfcf', '#c7a98a', '#9c6f55');
  livingRug.position.set(0, 0.006, -2.7);
  kit.root.add(livingRug);
  const table = await kit.glb('/assets/props-interior/modern_coffee_table_01_1k.glb', { height: 0.4 });
  kit.add(table, 0, -2.75, Math.PI / 2);
  const tsz = table.userData.size as THREE.Vector3;
  kit.block(0, -2.75, tsz.z, tsz.x);
  const tableTop = group(
    rbox(0.24, 0.035, 0.17, 0.004, pal.paint('#3b4a6b', 0.7), -0.25, 0, 0),
    rbox(0.22, 0.03, 0.16, 0.004, pal.paint('#e2d6c2', 0.7), -0.24, 0.035, 0.01),
    cyl(0.06, 0.06, 0.06, pal.ceramic, 0.25, 0, -0.05, 18),
  );
  kit.add(tableTop, 0, -2.75, 0, tsz.y);

  // ── sofa (velvet, warm oat) facing the TV ──
  const sofa = await kit.glb('/assets/props-interior/khronos/GlamVelvetSofa.glb', { width: 2.3 });
  sofa.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.MeshPhysicalMaterial | undefined;
    if (m && /fabric/i.test(m.name)) {
      // deep ink velvet: the pile catches a pale sheen at grazing angles, so the cushions' shapes read
      m.color.set('#3e5165');
      if ('sheenColor' in m) m.sheenColor.set('#a9bfd3');
      if ('sheen' in m) m.sheen = Math.max(m.sheen, 0.8);
      if ('sheenRoughness' in m) m.sheenRoughness = 0.42;
    }
  });
  kit.add(sofa, SOFA.x, SOFA.z, Math.PI);
  const ss = sofa.userData.size as THREE.Vector3;
  kit.block(SOFA.x, SOFA.z, ss.x, ss.z);
  const pillows = await kit.glb('/assets/props-interior/throw_pillows_01_1k.glb', { width: 0.55 });
  pillows.position.set(-0.75, 0.42, 0.05);
  const p2 = pillows.clone();
  p2.position.set(0.8, 0.42, 0.05);
  p2.rotation.y = Math.PI;
  sofa.add(pillows, p2);
  // a knitted throw folded over the left arm and the seat
  const throwMat = pal.fabric('#c9826b', 0.95);
  const throwTop = rbox(0.5, 0.025, 0.7, 0.01, throwMat, 0, 0, 0);
  throwTop.position.set(-1.0, 0.6, 0.02);
  throwTop.rotation.z = 0.12;
  const throwDrop = rbox(0.025, 0.36, 0.66, 0.01, throwMat, 0, 0, 0);
  throwDrop.position.set(-1.25, 0.26, 0.02);
  sofa.add(throwTop, throwDrop);
  // three seats; root faces −Z (toward the TV)
  for (const [k, dx] of [-0.62, 0, 0.62].entries()) {
    kit.stations.add('sofa', `sofa-${k}`, new THREE.Vector3(SOFA.x + dx, 0, SOFA.z - 0.08), Math.PI, { sit: { seatY: 0.44 } });
  }

  // ── armchair angled toward the coffee table ──
  const arm = await kit.glb('/assets/props-interior/khronos/SheenChair.glb', { width: 0.82 });
  arm.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.MeshPhysicalMaterial | undefined;
    if (m && /fabric/i.test(m.name)) { m.color.set('#b07a4e'); if ('sheenColor' in m) m.sheenColor.set('#f0c79a'); }
  });
  const ax = -2.35, az = -2.55, ayaw = Math.PI / 2 + 0.35;
  kit.add(arm, ax, az, ayaw);
  kit.block(ax, az, 0.8, 0.75, ayaw);
  kit.stations.add('armchair', 'armchair', new THREE.Vector3(ax + 0.03, 0, az), ayaw, { sit: { seatY: 0.42 } });

  // ── arc floor lamp beside the sofa ──
  const lamp = new THREE.Group();
  lamp.add(cyl(0.16, 0.18, 0.03, pal.marble, 0, 0, 0, 28));
  const arc = new THREE.Mesh(new THREE.TorusGeometry(0.75, 0.012, 8, 40, Math.PI * 0.62), pal.brass);
  arc.position.set(-0.75, 0.0, 0);
  arc.rotation.set(0, 0, 0);
  lamp.add(cyl(0.012, 0.012, 1.15, pal.brass, 0, 0.03, 0, 10));
  arc.position.set(-0.62, 1.15, 0);
  arc.rotation.z = 0.08;
  lamp.add(arc);
  const shade = cyl(0.12, 0.2, 0.2, practical(pal.emissive('#ffd8a8', 1.6)), -1.3, 1.5, 0, 28);
  (shade.material as THREE.MeshStandardMaterial).side = THREE.DoubleSide;
  (shade.material as THREE.MeshStandardMaterial).color.set('#f3e5cf');
  lamp.add(shade);
  kit.add(lamp, 1.85, -1.1, Math.PI * 0.85);
  kit.block(1.85, -1.1, 0.4, 0.4);
  kit.addLamp(new THREE.Vector3(1.85 + 1.3 * Math.cos(Math.PI * 0.85), 1.45, -1.1 - 1.3 * Math.sin(Math.PI * 0.85)),
    { intensity: 2.4, distance: 5.5, color: '#ffbe78', shadow: true });

  // ── side table with a plant, big plants by the windows ──
  const side = group(cyl(0.25, 0.25, 0.03, pal.walnut, 0, 0.52, 0, 24), cyl(0.02, 0.02, 0.52, pal.blackMetal, 0, 0, 0, 10), cyl(0.18, 0.18, 0.015, pal.blackMetal, 0, 0, 0, 20));
  const smallPlant = await kit.glb('/assets/props-interior/potted_plant_04_1k.glb', { height: 0.3 });
  smallPlant.position.y = 0.55;
  side.add(smallPlant);
  kit.add(side, -1.6, -0.95, 0);
  kit.block(-1.6, -0.95, 0.5, 0.5);
  const plant = await kit.glb('/assets/props-interior/potted_plant_02_1k.glb', { height: 1.35 });
  kit.add(plant, 3.55, BACK + 0.5, 0.4);
  kit.block(3.55, BACK + 0.5, 0.65, 0.65);
  kit.stations.add('plants', 'plant-tv', new THREE.Vector3(3.55, 0, BACK + 1.3), Math.PI);
  const plant2 = plant.clone();
  plant2.scale.setScalar(0.85);
  kit.add(plant2, -3.6, -1.0, 2.1);
  kit.block(-3.6, -1.0, 0.6, 0.6);
  kit.stations.add('plants', 'plant-living', new THREE.Vector3(-3.0, 0, -0.55), -Math.PI * 0.7);

  // ── framed prints on the sage wall flanking the TV ──
  const frameMat = pal.walnut;
  const print = (w: number, h: number, seed: number, palette: string[]) => {
    const g = group(box(w + 0.05, h + 0.05, 0.03, frameMat, 0, -(h + 0.05) / 2, 0));
    const art = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: artTexture(seed, palette), roughness: 0.9 }));
    art.position.set(0, 0, 0.016);
    g.add(art);
    return g;
  };
  // one print on the left wall between the dining window and the bookshelves, one in the workroom
  const p1 = print(0.42, 0.56, 3, ['#c86f4f', '#e4c9a5', '#5c6b56', '#2f3b46']);
  p1.position.set(-ROOM.halfW + 0.02, 1.92, -1.62);
  p1.rotation.y = Math.PI / 2;
  kit.onWall('left', p1, 2.2);
  const p3 = print(0.62, 0.44, 9, ['#3f6e8c', '#e9dcc6', '#c9a063', '#8b3a2f']);
  p3.position.set(4.45, 1.95, BACK + 0.02);
  kit.onWall('back', p3, 2.2);

  // standing spots by the living-room windows (idle gazing / phone calls)
  kit.stations.add('window', 'window-l', new THREE.Vector3(-2.65, 0, BACK + 0.75), Math.PI);
  kit.stations.add('window', 'window-r', new THREE.Vector3(2.65, 0, BACK + 0.75), Math.PI);
}
