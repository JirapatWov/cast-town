// Camera presets for headless screenshots of the city harness.
import type { CityView, Engine } from '../src/core/types';

type DebugCity = CityView & {
  debug?: {
    setCamera(target: [number, number, number], radius: number, phi: number, theta: number): void;
    lookFrom(pos: [number, number, number], target: [number, number, number]): void;
    simulateDrive(seconds: number, keys: string[], pose?: [number, number, number]): Promise<void>;
    setInstant(on: boolean): void;
    hover(kind: 'building' | 'lot' | 'landmark' | null, id?: string): void;
  };
};

export async function runShot(shot: string, city: DebugCity, _engine: Engine): Promise<void> {
  const d = city.debug;
  const set = (t: [number, number, number], r: number, phi: number, theta: number) => d?.setCamera(t, r, phi, theta);
  d?.setInstant(true);
  const settle = () => new Promise((r) => setTimeout(r, 50));
  switch (shot) {
    case 'p-house':
      await city.flyTo({ projectId: 'p-todo' });
      break;
    case 'p-hover':
      await city.flyTo({ projectId: 'p-todo' });
      d?.hover('building', 'p-todo');
      break;
    case 'p-cottage':
      await city.flyTo({ projectId: 'p-novel' });
      break;
    case 'p-office':
      await city.flyTo({ projectId: 'p-api' });
      break;
    case 'p-studio':
      await city.flyTo({ projectId: 'p-art' });
      break;
    case 'p-agency':
      await city.flyTo({ landmarkId: 'agency' });
      break;
    case 'forsale':
      set([-75, 1.6, 11.5], 15, 1.28, 2.75);
      break;
    case 'placement':
      city.setPlacementMode(true);
      set([-10, 0, 5], 230, 0.9, 0.5);
      d?.hover('lot', 'A-N2');
      break;
    case 'approach':
      await city.approach('p-todo');
      break;
    case 'overview':
      set([-8, 0, 0], 235, 0.86, 0.42);
      break;
    case 'house':
      set([-45, 2, 18], 34, 1.12, 2.62);
      break;
    case 'cottage':
      set([20, 2, 45], 32, 1.1, -2.2);
      break;
    case 'agency':
      set([60, 6, -72], 52, 1.08, 2.7);
      break;
    case 'lot':
      set([-75, 1, 12], 22, 1.2, 2.9);
      break;
    case 'street':
      set([-40, 2, 2], 22, 1.38, 1.9);
      break;
    case 'apartments':
      set([60, 8, 69], 45, 1.15, 0.5);
      break;
    case 'shops':
      set([24, 4, 69], 30, 1.25, 0.3);
      break;
    case 'sun': {
      // look straight at where the SunLight comes from: the HDRI sun disc should sit mid-frame
      const sky = new URLSearchParams(location.search).get('sky');
      const [x, y, z] = sky === 'golden' ? [-0.827, 0.327, -0.458] : [-0.5543, 0.7417, -0.3776];
      d?.lookFrom([0, 2, 0], [x * 100, 2 + y * 100, z * 100]);
      break;
    }
    case 'park':
      set([-63, 0, -55], 70, 0.95, 0.6);
      break;
    case 'drive':
      await d?.simulateDrive(2.6, ['KeyW']);
      break;
    case 'drive2':
      // heading west along Main Ave past the project house
      await d?.simulateDrive(2.0, ['KeyW'], [-20, -3, -Math.PI / 2]);
      break;
  }
  await settle();
  const c = city.camera.position;
  console.log('[city-shots] camera', c.x.toFixed(1), c.y.toFixed(1), c.z.toFixed(1), 'fov', city.camera.fov, 'aspect', city.camera.aspect.toFixed(2));
}
