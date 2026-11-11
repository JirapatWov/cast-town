// Dollhouse cutaway: every wall whose outward side faces the camera drops to waist height, smoothly.
// "outward" is the side from which a wall would block the view: outside for exterior walls, the corridor
// (or the +x neighbour) for partitions, so a room's display wall stays up while the wall in front of it drops.
import * as THREE from 'three';
import { ROOM, type WallDef, type WallId } from './layout';
import type { WallMesh } from './walls';

/** cutaway = camera-driven; up = every wall full height (floors below the shown one); down = all cut. */
export type WallMode = 'cutaway' | 'down' | 'up';

const _mid = new THREE.Vector2(), _to = new THREE.Vector2();

export class Cutaway {
  mode: WallMode = 'cutaway';

  constructor(private walls: Map<WallId, WallMesh>) {}

  /** Decide target heights from the camera (floor-local) and animate. `target` (floor-local orbit target) lets the
   *  corridor show through: upstairs the front rooms' display wall (corr-s) hides the whole corridor behind it, so
   *  it stays up only while the camera is zoomed into one of those front rooms. */
  update(cameraPos: THREE.Vector3, dt: number, immediate = false, target?: THREE.Vector3) {
    for (const wall of this.walls.values()) {
      const def = wall.def;
      let cut: boolean;
      if (this.mode === 'down') cut = true;
      else if (this.mode === 'up') cut = false;
      else {
        // Direction from the wall's middle to the camera, in the floor plane.
        const c = (def.span[0] + def.span[1]) / 2;
        if (def.axis === 'x') _mid.set(c, def.at); else _mid.set(def.at, c);
        _to.set(cameraPos.x - _mid.x, cameraPos.z - _mid.y).normalize();
        const facing = _to.x * def.outward[0] + _to.y * def.outward[1];
        // Hysteresis around the threshold so a slow orbit does not make walls flicker.
        const wasCut = wall.target < ROOM.height - 0.01;
        cut = facing > (wasCut ? -0.32 : -0.22);
        // any wall standing between the camera and what it looks at drops too (partitions upstairs when zoomed
        // into a room from the side, the display walls when orbiting round to look out of a room)
        if (!cut && target && blocksSight(def, cameraPos, target, wasCut)) cut = true;
        if (!cut && def.id === 'corr-s' && target) {
          const inFront = target.z > (wasCut ? 1.45 : 1.2);
          const near = cameraPos.distanceTo(target) < (wasCut ? 15 : 16.5);
          cut = !(inFront && near);
        }
      }
      wall.target = cut ? ROOM.cutHeight : ROOM.height;
      if (immediate) wall.setHeightImmediate(wall.target);
      else wall.update(dt);
    }
  }
}

/** Does the wall cross the sight line from the camera to the orbit target (in the floor plane)? */
function blocksSight(def: WallDef, cam: THREE.Vector3, target: THREE.Vector3, wasCut: boolean): boolean {
  const alongX = def.axis === 'x';
  const ca = alongX ? cam.x : cam.z, cc = alongX ? cam.z : cam.x;
  const ta = alongX ? target.x : target.z, tc = alongX ? target.z : target.x;
  const dc = cc - def.at, dt = tc - def.at;
  // the target must be clear of the wall (not standing in it) and the camera on the other side
  const clear = wasCut ? 0.05 : 0.2;
  if (Math.abs(dt) < clear || Math.sign(dc) === Math.sign(dt)) return false;
  const u = dt / (dt - dc); // 0 at the target, 1 at the camera
  const a = ta + (ca - ta) * u;
  const margin = wasCut ? 0.7 : 0.35;
  return a > Math.min(def.span[0], def.span[1]) - margin && a < Math.max(def.span[0], def.span[1]) + margin;
}
