// Small hand props, built procedurally (a few draw calls each): the handoff folder, a phone, a mug, a
// watering can, a stick vacuum and a laptop. Placement each frame is done by the person controller.
import * as THREE from 'three';

const mat = (color: THREE.ColorRepresentation, roughness = 0.6, metalness = 0) =>
  new THREE.MeshStandardMaterial({ color, roughness, metalness });
/** A material owned by one prop instance (disposed with it). */
const own = (color: THREE.ColorRepresentation, roughness = 0.6) => {
  const m = mat(color, roughness);
  m.userData.owned = true;
  return m;
};

/** Free a prop's geometries and its per-instance materials (shared ones stay). */
export function disposeProp(o: THREE.Object3D) {
  o.traverse((c) => {
    const m = c as THREE.Mesh;
    if (!m.isMesh) return;
    m.geometry.dispose();
    const mm = m.material as THREE.Material;
    if (mm.userData.owned) mm.dispose();
  });
  o.removeFromParent();
}

const shared = {
  paper: mat('#f4efe4', 0.85),
  black: mat('#1b1c1f', 0.35, 0.2),
  screen: new THREE.MeshBasicMaterial({ color: '#7fb4ff' }),
  ceramic: mat('#efe9df', 0.3),
  metal: mat('#9aa3ab', 0.35, 0.8),
  green: mat('#4f8a6a', 0.45),
  plastic: mat('#e6e2da', 0.45),
  red: mat('#d45a3a', 0.45),
};

function shadowed<T extends THREE.Object3D>(o: T): T {
  o.traverse((c) => {
    if ((c as THREE.Mesh).isMesh) (c as THREE.Mesh).castShadow = true;
  });
  return o;
}

/** A4-ish card folder in `color`, with a paper peeking out and a label strip. Origin at its center. */
export function makeFolder(color: THREE.ColorRepresentation): THREE.Group {
  const g = new THREE.Group();
  const cover = own(color, 0.55);
  const back = new THREE.Mesh(new THREE.BoxGeometry(0.31, 0.012, 0.23), cover);
  const paper = new THREE.Mesh(new THREE.BoxGeometry(0.29, 0.01, 0.21), shared.paper);
  paper.position.set(0.012, 0.009, 0.01);
  const flap = new THREE.Mesh(new THREE.BoxGeometry(0.31, 0.004, 0.2), cover);
  flap.position.set(0, 0.016, -0.015);
  const label = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.002, 0.035), shared.paper);
  label.position.set(-0.07, 0.019, 0.03);
  g.add(back, paper, flap, label);
  g.userData.cover = cover;
  return shadowed(g);
}

export function makePhone(): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.072, 0.15, 0.009), shared.black);
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.064, 0.138), shared.screen);
  screen.position.z = 0.0047;
  g.add(body, screen);
  return shadowed(g);
}

export function makeMug(): THREE.Group {
  const g = new THREE.Group();
  const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.038, 0.1, 18), shared.ceramic);
  const handle = new THREE.Mesh(new THREE.TorusGeometry(0.028, 0.008, 6, 14), shared.ceramic);
  handle.position.x = 0.045;
  const coffee = new THREE.Mesh(new THREE.CircleGeometry(0.037, 18).rotateX(-Math.PI / 2), own('#3b2417', 0.2));
  coffee.position.y = 0.04;
  g.add(cup, handle, coffee);
  return shadowed(g);
}

export function makeWateringCan(): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.1, 0.2, 20), shared.green);
  body.position.y = -0.14;
  const spout = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.018, 0.32, 8), shared.green);
  spout.position.set(0, -0.1, 0.17);
  spout.rotation.x = 1.0;
  const handle = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.012, 6, 16, Math.PI), shared.green);
  handle.position.y = -0.04;
  handle.rotation.y = Math.PI / 2;
  g.add(body, spout, handle);
  return shadowed(g);
}

/** Stick vacuum: `head` sits on the floor, `stick` is stretched from the hands to the head each frame. */
export function makeVacuum(): { group: THREE.Group; head: THREE.Object3D; stick: THREE.Mesh; motor: THREE.Mesh } {
  const group = new THREE.Group();
  const head = new THREE.Group();
  const nozzle = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.045, 0.09), shared.black);
  nozzle.position.y = 0.023;
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.012, 0.02), shared.red);
  stripe.position.set(0, 0.04, 0.035);
  head.add(nozzle, stripe);
  const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 1, 8).translate(0, 0.5, 0), shared.metal);
  const motor = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.22, 14), shared.plastic);
  group.add(head, stick, motor);
  return { group: shadowed(group), head, stick, motor };
}

/** Open laptop (origin: middle of the base's bottom; the lid hinges at the back, −Z… toward +Z is the user).
 *  The screen glows in `tint`. 0.32 × 0.22 m base, lid opened ~105°. */
export function makeLaptop(tint: THREE.ColorRepresentation): THREE.Group {
  const g = new THREE.Group();
  const shell = own('#3a3d42', 0.4);
  const base = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.016, 0.22), shell);
  base.position.y = 0.008;
  const keys = new THREE.Mesh(new THREE.PlaneGeometry(0.27, 0.09).rotateX(-Math.PI / 2), shared.black);
  keys.position.set(0, 0.0165, -0.025);
  const pad = new THREE.Mesh(new THREE.PlaneGeometry(0.09, 0.055).rotateX(-Math.PI / 2), own('#4a4e54', 0.3));
  pad.position.set(0, 0.0165, 0.065);
  const hinge = new THREE.Group();
  hinge.position.set(0, 0.016, -0.108);
  hinge.rotation.x = -(105 - 90) * (Math.PI / 180); // past upright, away from the user
  const lid = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.21, 0.008).translate(0, 0.105, -0.004), shell);
  const glow = new THREE.MeshBasicMaterial({ color: tint });
  glow.userData.owned = true;
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.29, 0.18).translate(0, 0.107, 0.0005), glow);
  hinge.add(lid, screen);
  g.add(base, keys, pad, hinge);
  return shadowed(g);
}
