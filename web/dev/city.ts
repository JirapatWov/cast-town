// City dev harness: engine + city with a fake store. URL params:
//   ?q=low|medium|high|ultra   quality       ?shot=overview|house|cottage|agency|lot|drive   camera preset for screenshots
import { createEngine } from '../src/engine';
import { createCityView } from '../src/city';
import { createFakeBus, createFakeStore } from './city-fakes';

declare global {
  interface Window {
    __ready?: boolean;
    __city?: unknown;
    __engine?: unknown;
    __info?: unknown;
  }
}

const params = new URLSearchParams(location.search);
const shot = params.get('shot');
if (shot) document.body.classList.add('shot');

async function main() {
  const app = document.getElementById('app')!;
  const engine = await createEngine(app);
  const store = createFakeStore();
  const bus = createFakeBus();
  const city = createCityView({ engine, store, bus });
  window.__city = city;
  window.__engine = engine;
  await city.init();
  city.activate();
  city.sync(store.state.city, store.state.agents, store.state.approvals);

  bus.on('nav:city', () => city.stopDriving());
  bus.on('nav:drive', () => city.startDriving());
  bus.on('building:click', ({ projectId }) => void city.flyTo({ projectId }));
  bus.on('landmark:click', ({ landmarkId }) => void city.flyTo({ landmarkId }));
  bus.on('placement:start', () => city.setPlacementMode(true));
  bus.on('placement:end', () => city.setPlacementMode(false));

  const dev = document.getElementById('dev')!;
  const button = (label: string, fn: () => void) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = fn;
    dev.appendChild(b);
  };
  button('Fly: todo-api', () => void city.flyTo({ projectId: 'p-todo' }));
  button('Fly: moonlight', () => void city.flyTo({ projectId: 'p-novel' }));
  button('Fly: agency', () => void city.flyTo({ landmarkId: 'agency' }));
  button('Approach todo-api', () => void city.approach('p-todo'));
  button('Drive', () => city.startDriving());
  button('Stop driving', () => city.stopDriving());
  let placing = false;
  button('Toggle placement', () => city.setPlacementMode((placing = !placing)));
  for (const q of ['low', 'medium', 'high', 'ultra'] as const) button(q, () => engine.setQuality(q));

  if (shot) await import('./city-shots').then((m) => m.runShot(shot, city, engine));

  // let a few frames render before signalling the screenshot harness
  let frames = 0;
  const off = engine.onFrame(() => {
    if (++frames === 4) {
      const i = engine.renderer.info;
      window.__info = { calls: i.render.calls, triangles: i.render.triangles, geometries: i.memory.geometries, textures: i.memory.textures, programs: i.programs?.length };
      console.log('[city-dev] info', JSON.stringify(window.__info));
      if (params.has('stats')) {
        // top triangle contributors (geometry tris × instances), shadow casters flagged
        const rows: [string, number, number, boolean][] = [];
        city.scene.traverse((o) => {
          const m = o as import('three').Mesh;
          if (!m.isMesh || !m.visible) return;
          const g = m.geometry;
          const tris = (g.index ? g.index.count : g.getAttribute('position').count) / 3;
          const inst = (m as unknown as { count?: number }).count ?? 1;
          rows.push([m.name || m.parent?.name || m.type, tris, tris * inst, m.castShadow]);
        });
        rows.sort((a, b) => b[2] - a[2]);
        console.log('[city-dev] meshes', rows.length, 'total tris', rows.reduce((s, r) => s + r[2], 0));
        for (const r of rows.slice(0, 25)) console.log('[city-dev]', r[0], Math.round(r[1]), '×→', Math.round(r[2]), r[3] ? 'cast' : '');
      }
      window.__ready = true;
      off();
    }
  });
}

main().catch((e) => {
  console.error('[city-dev] failed', e);
  window.__ready = true;
});
