// UI dev harness: mounts createUI over a painted backdrop, talks to web/dev/ui-mock-server.ts, and
// plays the role of main.ts (nav:* → view:changed). ?scene=… opens a specific state for screenshots.
import type { Engine, ViewName } from '../src/core/types';
import { createBus, createStore } from '../src/net';
import { createUI } from '../src/ui';

declare global {
  interface Window {
    __ready?: boolean;
  }
}

const params = new URLSearchParams(location.search);
const scene = params.get('scene') ?? 'city';
const wsUrl = params.get('ws') ?? 'ws://127.0.0.1:4962/ws';

try {
  if (scene === 'onboarding') localStorage.removeItem('rlt.onboarded.v1');
  else localStorage.setItem('rlt.onboarded.v1', '1');
  if (scene === 'placement') localStorage.setItem('rlt.place.lastPath', '/home/you/projects');
} catch {
  /* storage blocked */
}

const engine = {
  quality: 'high',
  labelLayer: document.createElement('div'),
  setQuality() {},
  setPaused() {},
} as unknown as Engine;

const store = createStore(wsUrl);
const bus = createBus();

function go(view: ViewName, projectId: string | null) {
  document.body.dataset.view = view;
  store.setLocal({ view, currentProjectId: projectId });
  bus.emit('view:changed', { view, projectId: projectId ?? undefined });
  if (projectId) store.send({ t: 'enter_project', projectId });
}
bus.on('nav:enter', (p) => go('house', p.projectId));
bus.on('nav:city', () => go('city', null));
bus.on('nav:drive', () => go('drive', null));
bus.on('focusmode:change', (p) => document.body.classList.toggle('paused', p.on));

const ui = createUI({ engine, store, bus });
ui.mount(document.getElementById('app')!);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (fn: () => boolean, ms = 8000) => {
  const t = Date.now();
  while (!fn() && Date.now() - t < ms) await wait(50);
};

async function applyScene() {
  await until(() => store.state.city.projects.length > 0);
  await document.fonts.ready;
  switch (scene) {
    case 'chat':
      go('house', 'todo-api');
      await wait(100);
      ui.openAgent('todo-api:assistant');
      await wait(Number(params.get('t') ?? 3200));
      break;
    case 'workflow':
      go('house', 'todo-api');
      ui.openWorkflow('todo-api');
      await wait(400);
      break;
    case 'workflow-edit': {
      go('house', 'todo-api');
      ui.openWorkflow('todo-api');
      await wait(200);
      const cards = document.querySelectorAll<HTMLButtonElement>('.role-head');
      cards[1]?.click();
      await wait(150);
      document.querySelector('.wf-section-head')?.scrollIntoView({ block: 'start' });
      await wait(250);
      break;
    }
    case 'diff':
      go('house', 'todo-api');
      await wait(100);
      ui.openDiff('todo-api');
      await wait(500);
      break;
    case 'approvals':
      go('house', 'todo-api');
      await wait(100);
      ui.closePanels();
      await wait(300);
      break;
    case 'palette':
      go('city', null);
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', ctrlKey: true, bubbles: true }));
      await wait(100);
      if (params.get('q')) {
        const input = document.querySelector<HTMLInputElement>('.pal-input')!;
        input.value = params.get('q')!;
        input.dispatchEvent(new Event('input'));
      }
      await wait(200);
      break;
    case 'placement':
      go('city', null);
      ui.openPlacement('A-N2');
      await until(() => !!document.querySelector('.fb-row:not(.fb-up)'));
      document.querySelector<HTMLButtonElement>('.fb-row[aria-label^="blog-engine"]')?.click();
      await until(() => !!document.querySelector('.fb-crumb.is-current')?.textContent?.includes('blog-engine'));
      await wait(300);
      break;
    case 'providers':
      go('city', null);
      ui.openProviders();
      await wait(300);
      break;
    case 'focus':
      bus.emit('focusmode:change', { on: true });
      await wait(400);
      break;
    case 'inbox':
      go('house', 'todo-api');
      await wait(100);
      document.querySelector<HTMLButtonElement>('.tb-bell')?.click();
      await wait(300);
      break;
    case 'changes':
      go('house', 'todo-api');
      await wait(100);
      document.querySelector<HTMLButtonElement>('#ptab-changes')?.click();
      await wait(300);
      break;
    case 'onboarding':
      await wait(900);
      break;
    default:
      await wait(300);
  }
  window.__ready = true;
}
void applyScene();
