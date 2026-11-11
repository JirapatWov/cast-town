// Upstairs corridor (shared by the four rooms): jute runners, two ceiling lights, a console with a lamp and a
// plant under the west window, a water cooler by the landing, a big plant, and shared stations (coffee, window,
// open floor). Stations here are untagged, so anyone on the floor can use them after their own room.
import * as THREE from 'three';
import { Kit, box, group, rbox } from './furniture/kit';
import { ROOM } from './layout';
import { fabric, waterCooler } from './rooms/pieces';

const P = '/assets/props-interior/';

export async function furnishCorridor(kit: Kit) {
  const { pal } = kit;
  // runners: three jute runners with a woven border
  const jute = pal.jute;
  const border = pal.upholstery('#6e5440');
  for (const x of [-5.9, -1.4, 3.1]) {
    const r = new THREE.Group();
    r.add(box(3.7, 0.012, 0.92, jute, 0, 0, 0));
    for (const z of [-0.41, 0.41]) r.add(box(3.7, 0.013, 0.06, border, 0, 0, z));
    for (const s of [-1, 1]) r.add(box(0.06, 0.013, 0.92, border, s * 1.82, 0, 0));
    r.traverse((m) => { (m as THREE.Mesh).castShadow = false; });
    kit.add(r, x, 0);
  }
  // ceiling lights (no hanging fixtures: the corridor sits behind the rooms' display walls and drums would float)
  for (const x of [-4.6, 2.6]) {
    kit.addLamp(new THREE.Vector3(x, ROOM.height - 0.85, 0), { intensity: 2.2, distance: 6, color: '#ffcf96' });
  }
  // console under the west window + a lamp and a plant
  const cons = new THREE.Group();
  cons.add(rbox(1.1, 0.035, 0.34, 0.006, pal.walnut, 0, 0.78, 0));
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) cons.add(box(0.025, 0.78, 0.025, pal.blackMetal, sx * 0.5, 0, sz * 0.13));
  cons.add(box(1.0, 0.02, 0.28, pal.walnut, 0, 0.22, 0));
  cons.add(group(rbox(0.3, 0.12, 0.22, 0.01, fabric(pal, '#b9a684', 1), 0, 0, 0)).translateY(0.24).translateX(-0.25));
  const vase = await kit.glb(`${P}opt/ceramic_vase_02.glb`, { height: 0.28, share: true });
  vase.position.set(-0.3, 0.815, 0);
  cons.add(vase);
  kit.add(cons, -ROOM.halfW + 0.2, 0, Math.PI / 2);
  kit.block(-ROOM.halfW + 0.2, 0, 1.1, 0.36, Math.PI / 2);
  const small = await kit.glb(`${P}potted_plant_04_1k.glb`, { height: 0.34, share: true });
  kit.add(small, -ROOM.halfW + 0.2, 0.32, 0, 0.815);
  const big = await kit.glb(`${P}potted_plant_02_1k.glb`, { height: 1.25, share: true });
  const bp = big.clone();
  kit.add(bp, -ROOM.halfW + 0.38, -0.62, 0.4);
  kit.block(-ROOM.halfW + 0.38, -0.62, 0.45, 0.45);
  kit.stations.add('plants', 'corr-plant-w', new THREE.Vector3(-ROOM.halfW + 1.05, 0, -0.45), -Math.PI / 2);
  kit.stations.add('window', 'corr-window', new THREE.Vector3(-ROOM.halfW + 0.85, 0, 0.35), -Math.PI / 2);
  // water cooler by the landing (against the corridor face of the north partition) + a plant
  const cooler = waterCooler(pal);
  kit.add(cooler, 6.55, -0.74, 0);
  kit.block(6.55, -0.74, 0.36, 0.36);
  kit.stations.add('coffee', 'corr-cooler', new THREE.Vector3(6.55, 0, -0.05), Math.PI);
  const bp2 = big.clone();
  kit.add(bp2, 6.65, 0.66, 1.3);
  kit.block(6.65, 0.66, 0.45, 0.45);
  kit.stations.add('plants', 'corr-plant-e', new THREE.Vector3(5.9, 0, 0.5), Math.PI / 2);
  // open corridor floor
  for (const [i, x] of [-6.2, -0.4, 4.2].entries()) kit.stations.add('center', `corr-center-${i}`, new THREE.Vector3(x, 0, 0.05), 0);
}
