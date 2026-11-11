// The in-between furniture of the open-plan ground floor. The rooms were furnished as islands with metres of bare
// parquet between them (the whole right half in front of the desks was empty); these pieces make it read as a
// lived-in home: a rug under the dining table, a console behind the sofa, a team table with a pendant in the
// right-hand bay, an entry console and coat rack by the door, more plants and prints. Decor only (no stations), every
// piece a nav obstacle, and the walkways to the door, the desks, the stairs and the workbench stay clear.
import * as THREE from 'three';
import { ROOM } from '../layout';
import { bookStack, credenza, drumPendant, framedArt, lampShade, rug } from '../rooms/pieces';
import { Kit, box, cyl, group, rbox } from './kit';

const W = ROOM.halfW, D = ROOM.halfD;

/** A small table lamp: ceramic base, linen shade (a practical: glows at dusk and night). */
function tableLamp(kit: Kit, color = '#d9cdb8'): THREE.Group {
  const { pal } = kit;
  return group(
    cyl(0.07, 0.09, 0.26, pal.paint(color, 0.35), 0, 0, 0, 20),
    cyl(0.01, 0.01, 0.1, pal.brass, 0, 0.26, 0, 8),
    cyl(0.12, 0.16, 0.2, lampShade(pal, '#f1e6d3', 1.1), 0, 0.33, 0, 24),
  );
}

/** Freestanding coat rack: a turned pole on a round foot, four pegs, two coats and a scarf. */
function coatRack(kit: Kit): THREE.Group {
  const { pal } = kit;
  const g = group(cyl(0.2, 0.22, 0.03, pal.blackMetal, 0, 0, 0, 24), cyl(0.022, 0.026, 1.78, pal.walnut, 0, 0.03, 0, 10));
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + 0.4;
    const peg = cyl(0.012, 0.012, 0.2, pal.brass, 0, 0, 0, 6);
    peg.position.set(Math.cos(a) * 0.08, 1.66, Math.sin(a) * 0.08);
    peg.rotation.set(Math.sin(a) * 0.9, 0, -Math.cos(a) * 0.9);
    g.add(peg);
  }
  const coat = (color: string, a: number, len: number) => {
    const c = rbox(0.42, len, 0.14, 0.05, pal.fabric(color, 0.95), 0, 0, 0);
    c.position.set(Math.cos(a) * 0.17, 1.66 - len, Math.sin(a) * 0.17);
    c.rotation.y = -a + Math.PI / 2;
    c.rotation.x = 0.06;
    return c;
  };
  g.add(coat('#6b5a4a', 0.4, 1.0), coat('#3e5165', 0.4 + Math.PI, 0.86));
  const scarf = rbox(0.12, 0.7, 0.04, 0.02, pal.fabric('#c9826b', 0.95), 0, 0, 0);
  scarf.position.set(Math.cos(0.4 + Math.PI / 2) * 0.12, 1.0, Math.sin(0.4 + Math.PI / 2) * 0.12);
  g.add(scarf);
  return g;
}

export async function furnishFill(kit: Kit) {
  const { pal } = kit;
  const plantTall = await kit.glb('/assets/props-interior/potted_plant_02_1k.glb', { height: 1.25 });
  const plantSmall = await kit.glb('/assets/props-interior/potted_plant_04_1k.glb', { height: 0.34 });
  const chairProto = await kit.glb('/assets/props-interior/dining_chair_02_1k.glb', { height: 0.95 });
  const plant = (x: number, z: number, scale: number, yaw: number) => {
    const p = plantTall.clone();
    p.scale.multiplyScalar(scale);
    kit.add(p, x, z, yaw);
    kit.block(x, z, 0.55 * scale, 0.55 * scale);
  };

  // ── dining: a flat-woven rug under the table and chairs ──
  const diningRug = rug(pal, 3.0, 2.7, 'dining', '#e6dccb', '#a9b8a0', '#6d5a4b', 'jute');
  diningRug.position.set(-5.0, 0.006, 2.0);
  kit.root.add(diningRug);

  // ── a console behind the sofa: lamp, books, a vase ──
  const cx = 0, cz = -0.5;
  const consoleT = group(
    rbox(1.7, 0.04, 0.36, 0.008, pal.walnut, 0, 0.72, 0),
    rbox(1.62, 0.025, 0.3, 0.006, pal.walnut, 0, 0.16, 0),
    ...[-0.8, 0.8].flatMap((x) => [-0.14, 0.14].map((z) => box(0.03, 0.72, 0.03, pal.blackMetal, x, 0, z))),
  );
  const lamp = tableLamp(kit, '#c9b79c');
  lamp.position.set(-0.6, 0.76, 0);
  const books = bookStack(pal, 31, 3);
  books.position.set(0.15, 0.76, 0.02);
  const vase = cyl(0.06, 0.08, 0.3, pal.paint('#3e5165', 0.3), 0.62, 0.76, 0, 18);
  const basket = cyl(0.17, 0.15, 0.22, pal.fabric('#cbb894', 1), -0.35, 0.185, 0, 18);
  consoleT.add(lamp, books, vase, basket);
  kit.add(consoleT, cx, cz, 0);
  kit.block(cx, cz, 1.7, 0.36);
  kit.addLamp(new THREE.Vector3(cx - 0.6, 1.15, cz), { intensity: 0.9, distance: 3.2, color: '#ffbf80' });

  // ── team table in the right-hand bay: rug, four chairs, a pendant ──
  const mx = 5.55, mz = 3.05; // nav cells of the center-4 spot (4.1, 3.6) and the workbench floor spot (7.45, 3.05) stay free
  const meetRug = rug(pal, 3.3, 2.6, 'meeting', '#ece3d3', '#c9826b', '#3e5165');
  meetRug.position.set(mx, 0.006, mz);
  kit.root.add(meetRug);
  const top = rbox(2.0, 0.045, 0.95, 0.012, pal.oak, 0, 0.73, 0);
  const table = group(top, ...[-0.88, 0.88].map((x) => box(0.06, 0.73, 0.8, pal.blackMetal, x, 0, 0)));
  table.add(box(1.76, 0.04, 0.04, pal.blackMetal, 0, 0.64, 0));
  const laptop = rbox(0.34, 0.015, 0.24, 0.004, pal.steel, 0, 0.775, 0);
  laptop.position.set(-0.45, 0.775, 0.12);
  const mugs = [cyl(0.04, 0.04, 0.09, pal.paint('#e9e1d3', 0.3), 0.35, 0.775, -0.2, 14), cyl(0.04, 0.04, 0.09, pal.paint('#a9b8a0', 0.3), 0.55, 0.775, 0.22, 14)];
  const notes = bookStack(pal, 12, 2);
  notes.position.set(0.1, 0.775, -0.18);
  table.add(laptop, ...mugs, notes);
  kit.add(table, mx, mz, 0);
  kit.block(mx, mz, 2.0, 0.95);
  for (const dx of [-0.5, 0.5]) {
    for (const side of [-1, 1]) {
      const c = chairProto.clone();
      const z = mz + side * 0.72;
      kit.add(c, mx + dx, z, side < 0 ? 0 : Math.PI);
      kit.block(mx + dx, z, 0.45, 0.45);
    }
  }
  const pendant = drumPendant(pal, ROOM.height, '#e9dcc4', 0.36, 0.95);
  kit.hang(kit.add(pendant, mx, mz, 0));
  kit.addLamp(new THREE.Vector3(mx, ROOM.height - 1.15, mz), { intensity: 1.6, distance: 4.2, color: '#ffc58a' });

  // ── front of the right bay: a low sideboard with a lamp and a plant, a tall plant by the stairs ──
  const sb = credenza(kit, 1.5, pal.oak);
  const sbLamp = tableLamp(kit, '#e9e1d3');
  sbLamp.position.set(-0.5, 0.62, 0);
  const sbPlant = plantSmall.clone();
  sbPlant.position.set(0.45, 0.62, 0);
  sb.add(sbLamp, sbPlant);
  kit.add(sb, 3.65, D - 0.3, Math.PI);
  kit.block(3.65, D - 0.3, 1.5, 0.44);
  kit.addLamp(new THREE.Vector3(4.15, 1.0, D - 0.4), { intensity: 0.7, distance: 2.8, color: '#ffbf80' });
  plant(6.75, D - 0.45, 1.05, 0.7);

  // ── entry: a console past the laundry corner, a coat rack by the door, a plant under the window ──
  const entry = credenza(kit, 1.4);
  const eLamp = tableLamp(kit, '#c9826b');
  eLamp.position.set(0.5, 0.62, 0);
  const eBooks = bookStack(pal, 5, 2);
  eBooks.position.set(-0.35, 0.62, 0.02);
  entry.add(eLamp, eBooks);
  kit.add(entry, -7.3, D - 0.3, Math.PI);
  kit.block(-7.3, D - 0.3, 1.4, 0.44);
  kit.addLamp(new THREE.Vector3(-7.8, 1.0, D - 0.4), { intensity: 0.7, distance: 2.8, color: '#ffbf80' });
  plant(-5.4, D - 0.5, 0.9, 2.2);
  const rack = coatRack(kit);
  kit.add(rack, -W + 0.42, 1.68, 0);
  kit.block(-W + 0.42, 1.68, 0.45, 0.45);

  // ── plants in the corners the living room left bare ──
  plant(-2.2, -0.35, 0.8, 1.4);

  // ── prints: a pair flanking the TV (between it and the curtained windows) ──
  const palA = ['#c9826b', '#e9e1d3', '#a9b8a0', '#3e5165'];
  const palB = ['#3e5165', '#efe7da', '#c9a46a', '#8b3a2f'];
  for (const [x, seed, p] of [[-1.45, 21, palA], [1.45, 22, palB]] as const) {
    const art = framedArt(kit, 0.4, 0.56, seed, [...p]);
    art.position.set(x, 2.25, -D + 0.02);
    kit.onWall('back', art, 2.2);
  }
}
