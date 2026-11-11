// Workroom: three oak desks facing the back wall (monitors toward the camera), swivel chairs that
// slide with the sitter, desk lamps, and the corkboard job board on the wall behind.
import * as THREE from 'three';
import { Screen, type ScreenAtlas } from '../screens';
import { Kit, box, cyl, group, local, rbox } from './kit';

export const DESK_Z = -3.25; // desk center
export const DESK_XS = [4.45, 6.1, 7.75];
const DESK_W = 1.36, DESK_D = 0.7, DESK_H = 0.75;

/** Swivel chair in two materials (black frame, upholstery), so a chair island merges into two draws. */
export function buildOfficeChair(kit: Kit, fabric: THREE.Material): THREE.Group {
  const frame = kit.pal.blackMetal;
  const g = new THREE.Group();
  g.name = 'office-chair';
  // five-star base with casters
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const leg = box(0.03, 0.025, 0.3, frame, 0, 0.05, 0);
    leg.geometry.translate(0, 0, 0.15);
    leg.position.set(0, 0.06, 0);
    leg.rotation.y = a;
    g.add(leg);
    const caster = new THREE.Mesh(new THREE.SphereGeometry(0.025, 8, 6), frame);
    caster.position.set(Math.sin(a) * 0.29, 0.025, Math.cos(a) * 0.29);
    caster.castShadow = caster.receiveShadow = true; // same flags as the rest of the frame: one merged mesh
    g.add(caster);
  }
  g.add(cyl(0.022, 0.022, 0.32, frame, 0, 0.07, 0, 10));
  // seat + back
  g.add(rbox(0.5, 0.09, 0.48, 0.035, fabric, 0, 0.38, 0.02));
  g.add(box(0.05, 0.4, 0.03, frame, 0, 0.42, -0.23));
  const back = rbox(0.47, 0.5, 0.07, 0.03, fabric, 0, 0.6, -0.26);
  back.rotation.x = -0.12;
  g.add(back);
  // armrests
  for (const s of [-1, 1]) {
    g.add(box(0.03, 0.22, 0.03, frame, s * 0.24, 0.45, 0.0));
    g.add(rbox(0.06, 0.03, 0.26, 0.012, frame, s * 0.24, 0.66, 0.02));
  }
  return g;
}

export function buildDesk(kit: Kit, w = DESK_W): THREE.Group {
  const { pal } = kit;
  const g = new THREE.Group();
  g.add(rbox(w, 0.035, DESK_D, 0.01, pal.oak, 0, DESK_H - 0.035, 0));
  // black steel sled legs
  for (const s of [-1, 1]) {
    const x = s * (w / 2 - 0.08);
    g.add(box(0.04, DESK_H - 0.035, 0.04, pal.blackMetal, x, 0, DESK_D / 2 - 0.06));
    g.add(box(0.04, DESK_H - 0.035, 0.04, pal.blackMetal, x, 0, -DESK_D / 2 + 0.06));
    g.add(box(0.04, 0.03, DESK_D - 0.08, pal.blackMetal, x, 0, 0));
    g.add(box(0.04, 0.03, DESK_D - 0.08, pal.blackMetal, x, DESK_H - 0.065, 0));
  }
  g.add(box(w - 0.2, 0.25, 0.015, pal.blackMetal, 0, DESK_H - 0.3, -DESK_D / 2 + 0.07));
  return g;
}

export function buildMonitor(kit: Kit, screen: Screen): THREE.Group {
  const { pal } = kit;
  const g = new THREE.Group();
  g.add(rbox(0.24, 0.012, 0.17, 0.006, pal.blackMetal, 0, 0, 0));
  g.add(box(0.045, 0.26, 0.02, pal.blackMetal, 0, 0.01, -0.04));
  const body = rbox(0.64, 0.38, 0.025, 0.006, pal.plastic, 0, 0.17, -0.02);
  g.add(body);
  const s = new THREE.Mesh(screen.faceGeometry(0.61, 0.345), screen.material);
  s.position.set(0, 0.17 + 0.19, -0.02 + 0.0128);
  g.add(s);
  return g;
}

export function buildLaptop(kit: Kit, screen: Screen): THREE.Group {
  const { pal } = kit;
  const g = new THREE.Group();
  g.add(rbox(0.33, 0.016, 0.23, 0.006, pal.steel, 0, 0, 0));
  g.add(box(0.28, 0.002, 0.11, pal.plastic, 0, 0.016, 0.02));
  const lid = new THREE.Group();
  lid.position.set(0, 0.016, -0.11);
  lid.rotation.x = -0.32;
  lid.add(rbox(0.33, 0.22, 0.01, 0.005, pal.steel, 0, 0, -0.005));
  const s = new THREE.Mesh(screen.faceGeometry(0.3, 0.19), screen.material);
  s.position.set(0, 0.11, 0.0005);
  lid.add(s);
  g.add(lid);
  return g;
}

function deskClutter(kit: Kit, i: number): THREE.Group {
  const { pal } = kit;
  const g = new THREE.Group();
  // keyboard + mouse near the front edge, where the typing IK puts the hands
  g.add(rbox(0.42, 0.018, 0.14, 0.006, pal.paint('#e7e3dc', 0.5), 0, 0, DESK_D / 2 - 0.11)); // keyboard
  g.add(rbox(0.06, 0.022, 0.1, 0.02, pal.paint('#e7e3dc', 0.5), 0.3, 0, DESK_D / 2 - 0.12)); // mouse
  const mug = cyl(0.04, 0.036, 0.095, pal.paint(['#c86f4f', '#3f6e8c', '#e9e2d4'][i % 3], 0.35), -0.5, 0, 0.15, 18);
  g.add(mug);
  if (i !== 1) {
    const nb = rbox(0.17, 0.02, 0.23, 0.004, pal.paint(['#2f4b3e', '#8b3a2f', '#3b4a6b'][i % 3], 0.7), 0.48, 0, -0.08);
    nb.rotation.y = 0.25;
    g.add(nb);
  }
  return g;
}

export async function furnishWorkroom(kit: Kit, screens: Screen[], tints: string[], atlas?: ScreenAtlas) {
  const { pal } = kit;
  const chairFabric = pal.upholstery('#3d3f44');
  const lampProto = await kit.glb('/assets/props-interior/desk_lamp_arm_01_1k.glb', { height: 0.62 });
  const plantProto = await kit.glb('/assets/props-interior/potted_plant_04_1k.glb', { height: 0.3 });

  DESK_XS.forEach((x, i) => {
    const desk = buildDesk(kit);
    kit.add(desk, x, DESK_Z, 0);
    kit.block(x, DESK_Z, DESK_W, DESK_D);
    const screen = new Screen(100 + i, atlas);
    screens.push(screen);
    const top = group(deskClutter(kit, i));
    top.position.y = DESK_H;
    desk.add(top);
    const dev = i === 1 ? buildLaptop(kit, screen) : buildMonitor(kit, screen);
    dev.position.set(i === 1 ? 0 : 0.0, DESK_H, i === 1 ? -0.02 : -0.2);
    desk.add(dev);
    kit.pickable(dev, { kind: 'computer', label: 'Computer · open a terminal', anchor: new THREE.Vector3(x, DESK_H + (i === 1 ? 0.42 : 0.68), DESK_Z - 0.2) });
    if (i !== 1) {
      const lamp = lampProto.clone();
      lamp.position.set(i === 0 ? -0.52 : 0.52, DESK_H, -0.2);
      lamp.rotation.y = i === 0 ? 0.6 : -0.6;
      desk.add(lamp);
      kit.addLamp(local(x, DESK_Z, 0, i === 0 ? -0.35 : 0.35, -0.05, DESK_H + 0.5), { intensity: 1.2, distance: 2.6, color: '#ffc68a' });
    } else {
      const plant = plantProto.clone();
      plant.position.set(0.5, DESK_H, -0.18);
      desk.add(plant);
    }

    // chair + sitting slot (person faces the desk, −Z). The chair rests tucked in; people pull it out
    // (slide), sit, and scoot in until the hands reach the keyboard.
    const chair = buildOfficeChair(kit, chairFabric);
    const seatZ = DESK_Z + DESK_D / 2 + 0.32;
    kit.add(chair, x, seatZ, Math.PI);
    kit.block(x, seatZ, 0.5, 0.5);
    kit.stations.add('desk', `desk-${i}`, new THREE.Vector3(x, 0, seatZ), Math.PI, {
      sit: { seatY: 0.47, chair, slide: 0.3 },
      screen: { setActive: (on, tint) => screen.setActive(on, tint ?? tints[i % tints.length]) },
    });
  });

  // a tall plant to close the row, and a low credenza under the window
  const bigPlant = await kit.glb('/assets/props-interior/potted_plant_02_1k.glb', { height: 1.25 });
  kit.add(bigPlant, 8.45, -1.2, 0.8);
  kit.block(8.45, -1.2, 0.6, 0.6);
  kit.stations.add('plants', 'plant-work', new THREE.Vector3(8.45 - 0.75, 0, -1.2), Math.PI / 2);
  const cred = group(
    rbox(1.4, 0.55, 0.42, 0.01, pal.walnut, 0, 0.06, 0),
    box(1.32, 0.06, 0.36, pal.blackMetal, 0, 0, 0),
  );
  kit.add(cred, 8.05, -5.75, 0);
  kit.block(8.05, -5.75, 1.4, 0.45);
  const books = group(...[0, 1, 2, 3, 4].map((k) => box(0.035, 0.22 + (k % 3) * 0.03, 0.17, pal.paint(['#8b3a2f', '#e2d6c2', '#2f4b3e', '#c9a063', '#3b4a6b'][k], 0.8), -0.45 + k * 0.045, 0.61, 0)));
  cred.add(books);
  const p2 = plantProto.clone();
  p2.position.set(0.35, 0.61, 0);
  cred.add(p2);

  // pacing route + delegating spots in front of the corkboard (between the wall and the desks)
  const boardX = DESK_XS[1];
  kit.stations.add('corkboard', 'board-a', new THREE.Vector3(boardX - 0.55, 0, -5.0), Math.PI);
  kit.stations.add('corkboard', 'board-b', new THREE.Vector3(boardX + 0.55, 0, -5.0), Math.PI);
  kit.stations.add('pace', 'pace-a', new THREE.Vector3(boardX - 1.1, 0, -4.75), Math.PI, {
    route: [new THREE.Vector3(boardX - 1.4, 0, -4.7), new THREE.Vector3(boardX + 1.4, 0, -4.7)],
  });
  kit.stations.add('pace', 'pace-b', new THREE.Vector3(4.0, 0, -1.6), Math.PI, {
    route: [new THREE.Vector3(3.9, 0, -2.2), new THREE.Vector3(3.9, 0, -0.4)],
  });
}
