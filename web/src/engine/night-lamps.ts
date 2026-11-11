// Street-lamp light pools for the night: a fixed pool of shadowless point lights that follow the lamps nearest to
// what the camera looks at, so dozens of lamps light the pavement while the shader only ever pays for a few.
// The pool size never changes (no shader recompiles); lights fade with the time of day.
//   const pool = createNightLamps(engine, scene, camera, lampPositions, { height: 4.2 });
//   …when the lamp list changes: pool.setLamps(next)   …on dispose: pool.dispose()
import * as THREE from 'three';
import type { Engine, TimeOfDay } from '../core/types';
import { activeQualitySettings } from './quality';

export interface NightLampOptions {
  /** Light colour (sodium-warm by default). */
  color?: THREE.ColorRepresentation;
  /** Candela-ish intensity at full night. */
  intensity?: number;
  /** Light reach in metres. */
  distance?: number;
  /** Offset of the bulb above each lamp position (if positions are at the lamp base). */
  height?: number;
  /** Pool size (default: 4 on Low, 8 otherwise). */
  count?: number;
}

export interface NightLamps {
  setLamps(positions: THREE.Vector3Like[]): void;
  dispose(): void;
}

export function createNightLamps(
  engine: Engine, scene: THREE.Scene, camera: THREE.Camera, positions: THREE.Vector3Like[], opts: NightLampOptions = {},
): NightLamps {
  const count = opts.count ?? (activeQualitySettings().ao === 'off' ? 4 : 8);
  const color = new THREE.Color(opts.color ?? 0xffb864);
  const intensity = opts.intensity ?? 28;
  const distance = opts.distance ?? 16;
  const height = opts.height ?? 0;
  const group = new THREE.Group();
  group.name = 'night-lamps';
  const lights: THREE.PointLight[] = [];
  for (let i = 0; i < count; i++) {
    const l = new THREE.PointLight(color, 0, distance, 2);
    l.castShadow = false;
    group.add(l);
    lights.push(l);
  }
  scene.add(group);

  let lamps = positions.map((p) => new THREE.Vector3(p.x, p.y + height, p.z));
  let level = 0;
  const focus = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const ray = new THREE.Ray();
  const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  let since = 1;

  function place(camera: THREE.Camera) {
    camera.getWorldDirection(dir);
    ray.set(camera.position, dir);
    if (!ray.intersectPlane(ground, focus)) focus.copy(camera.position);
    // lamps near the focus point and near the camera both matter; weigh them so the frame centre wins
    const cam = camera.position;
    const scored = lamps
      .map((p) => ({ p, d: p.distanceToSquared(focus) * 0.7 + p.distanceToSquared(cam) * 0.3 }))
      .sort((a, b) => a.d - b.d);
    for (let i = 0; i < lights.length; i++) {
      const s = scored[i];
      const l = lights[i];
      if (!s) {
        l.intensity = 0;
        continue;
      }
      l.position.copy(s.p);
    }
  }

  const unFrame = engine.onFrame((dt) => {
    if (level <= 0 || !lamps.length) return;
    since += dt;
    if (since < 0.35) return; // re-pick a few times per second; light jumps hide under the lamp heads
    since = 0;
    place(camera);
    for (const l of lights) l.intensity = intensity * level;
  });

  const apply = (t: TimeOfDay) => {
    level = THREE.MathUtils.clamp((t.night - 0.2) / 0.8, 0, 1);
    since = 1;
    if (level <= 0) for (const l of lights) l.intensity = 0;
  };
  const unTod = engine.onTimeOfDay?.(apply) ?? (() => {});

  return {
    setLamps(next) {
      lamps = next.map((p) => new THREE.Vector3(p.x, p.y + height, p.z));
      since = 1;
    },
    dispose() {
      unFrame();
      unTod();
      group.removeFromParent();
      for (const l of lights) l.dispose();
    },
  };
}
