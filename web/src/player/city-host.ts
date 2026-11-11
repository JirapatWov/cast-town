// Adapter from the city view to what the player needs: a building's front door, the parked car, and a flat
// ground to stand on. Reads the city's debug handle when present and falls back to the shared lot layout.
import * as THREE from 'three';
import { CAR_SPAWN, LOTS } from '../../../shared/city-layout';
import type { CityView, Store } from '../core/types';
import type { Ground } from './avatar';

interface CityDebug {
  building?(id: string): { door?: THREE.Vector3; facing?: THREE.Vector3 } | undefined;
  driver?: { position?: THREE.Vector3; forward?: THREE.Vector3; car?: unknown };
}

export interface CityHost {
  readonly scene: THREE.Scene;
  readonly camera: THREE.Camera;
  /** Front door (world, ground level) and the outward direction of a project building. */
  door(projectId: string): { door: THREE.Vector3; facing: THREE.Vector3 } | null;
  /** The parked car (world) and its forward direction, when loaded. */
  car(): { pos: THREE.Vector3; forward: THREE.Vector3 };
  driving(): boolean;
  /** A flat ground at height y (city coordinates are world coordinates). */
  ground(y: number): Ground;
}

export function createCityHost(city: CityView, store: Store): CityHost {
  const debug = () => (city as unknown as { debug?: CityDebug }).debug;
  const grounds = new Map<number, Ground>();
  return {
    scene: city.scene,
    camera: city.camera,
    door(projectId) {
      const b = debug()?.building?.(projectId);
      if (b?.door && b.facing) return { door: b.door.clone(), facing: b.facing.clone().setY(0).normalize() };
      const lotId = store.project(projectId)?.lotId;
      const lot = LOTS.find((l) => l.id === lotId);
      if (!lot) return null;
      const facing = new THREE.Vector3(Math.sin(lot.rotY), 0, Math.cos(lot.rotY));
      return { door: new THREE.Vector3(lot.x, 0.12, lot.z).addScaledVector(facing, lot.depth / 2 - 3), facing };
    },
    car() {
      const d = debug()?.driver;
      if (d?.position && d.forward) return { pos: d.position.clone().setY(0), forward: d.forward.clone().setY(0).normalize() };
      return { pos: new THREE.Vector3(CAR_SPAWN.x, 0, CAR_SPAWN.z), forward: new THREE.Vector3(Math.sin(CAR_SPAWN.rotY), 0, Math.cos(CAR_SPAWN.rotY)) };
    },
    driving: () => city.driving,
    ground(y) {
      const key = Math.round(y * 100);
      let g = grounds.get(key);
      if (!g) {
        g = {
          root: city.scene,
          findPath: (_a, b) => [b.clone()],
          snap: (p) => p.clone(),
          isFree: () => true,
          heightAt: () => y,
          cameraPosition: (out) => out.copy(city.camera.position),
        };
        grounds.set(key, g);
      }
      return g;
    },
  };
}
