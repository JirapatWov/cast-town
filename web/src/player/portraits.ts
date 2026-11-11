// Portraits of the homeowner looks for the settings picker: each look is posed once in a small studio scene
// (soft room environment, warm key, cool rim), rendered by the app's own renderer into a half-float target at 2×
// and resolved in JS (box downsample, filmic tone curve, sRGB) to a PNG data URL. Rendered on demand, one at a
// time between frames, kept per browser (localStorage) so each look is rendered once, and dropped from the queue
// when the picker closes. An avatar loaded only for its portrait gives its GPU memory back afterwards.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { Engine } from '../core/types';
import { AVATARS } from '../people/avatars';
import { createPlayerBody } from './character-api';
import type { PortraitProvider } from './prefs';
import { deviceStorage } from '../ui/dom';

const W = 112;
const H = 140;
const SS = 2;

export function createPortraits(engine: Engine): PortraitProvider {
  const cache = new Map<string, Promise<string | null>>();
  const queue: { look: string; done: (url: string | null) => void }[] = [];
  let working = false;
  let studio: { scene: THREE.Scene; camera: THREE.PerspectiveCamera; rt: THREE.WebGLRenderTarget } | null = null;

  function setup() {
    if (studio) return studio;
    const renderer = engine.renderer;
    const scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.55;
    pmrem.dispose();
    const key = new THREE.DirectionalLight('#fff1dc', 2.4);
    key.position.set(-1.2, 2.6, 2.2);
    const rim = new THREE.DirectionalLight('#cfe0ff', 1.6);
    rim.position.set(1.6, 2.2, -1.8);
    const fill = new THREE.HemisphereLight('#fdf5ea', '#6b5a4a', 0.5);
    scene.add(key, rim, fill, key.target, rim.target);
    const camera = new THREE.PerspectiveCamera(24, W / H, 0.1, 20);
    const rt = new THREE.WebGLRenderTarget(W * SS, H * SS, { type: THREE.HalfFloatType, depthBuffer: true });
    studio = { scene, camera, rt };
    return studio;
  }

  async function render(look: string): Promise<string | null> {
    if (!engine.renderer) return null;
    const { scene, camera, rt } = setup();
    const body = await createPlayerBody(engine.assets, look);
    try {
      const model = body.ch.model;
      model.rotation.y = -0.38; // a three-quarter view reads better than straight on
      scene.add(model);
      body.anim.play('Idle_Loop', { fade: 0 });
      body.anim.update(0.4);
      model.updateMatrixWorld(true);
      const head = body.head(new THREE.Vector3()) ?? new THREE.Vector3(0, 1.6 * body.height, 0);
      const target = new THREE.Vector3(head.x, head.y - 0.2, head.z);
      camera.position.set(target.x + 0.18, target.y + 0.06, target.z + 2.15);
      camera.lookAt(target);
      camera.updateMatrixWorld(true);
      const renderer = engine.renderer;
      await renderer.compileAsync(scene, camera);
      // render between frames: wait for the next one to finish, then draw and restore everything we touched
      await new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0)));
      const prevTarget = renderer.getRenderTarget();
      const prevColor = renderer.getClearColor(new THREE.Color());
      const prevAlpha = renderer.getClearAlpha();
      const prevAuto = renderer.autoClear;
      const prevShadow = renderer.shadowMap.autoUpdate;
      renderer.shadowMap.autoUpdate = false;
      renderer.setRenderTarget(rt);
      renderer.setClearColor(0x000000, 0);
      renderer.autoClear = true;
      renderer.clear();
      renderer.render(scene, camera);
      const px = new Uint16Array(W * SS * H * SS * 4);
      renderer.readRenderTargetPixels(rt, 0, 0, W * SS, H * SS, px);
      renderer.setRenderTarget(prevTarget);
      renderer.setClearColor(prevColor, prevAlpha);
      renderer.autoClear = prevAuto;
      renderer.shadowMap.autoUpdate = prevShadow;
      scene.remove(model);
      return toDataUrl(px);
    } finally {
      body.dispose();
      body.releaseGpu();
    }
  }

  async function work() {
    if (working) return;
    working = true;
    try {
      for (let job = queue.shift(); job; job = queue.shift()) {
        let url: string | null = null;
        try {
          url = await render(job.look);
          if (url) remember(job.look, url);
        } catch (e) {
          console.warn('[player] portrait failed', e);
        }
        if (!url) cache.delete(job.look);
        job.done(url);
      }
    } finally {
      working = false;
    }
  }

  return {
    get(look) {
      let p = cache.get(look);
      if (p) return p;
      const kept = recall(look);
      p = kept ? Promise.resolve(kept) : new Promise<string | null>((done) => queue.push({ look, done }));
      cache.set(look, p);
      if (!kept) void work();
      return p;
    },
    cancel() {
      // looks still waiting: forget them (the picker asks again next time it opens)
      for (const job of queue.splice(0)) {
        cache.delete(job.look);
        job.done(null);
      }
    },
  };
}

// ── per-browser store: one small PNG per look, invalidated when the avatar file changes ──────────

const STORE = 'rlt.player.portraits.v1';

function fingerprint(look: string): string {
  const a = AVATARS.find((x) => x.id === look);
  return a ? `${a.file}|${a.tris.join(',')}|${a.height}|${W}x${H}` : look;
}

function readStore(): Record<string, { fp: string; url: string }> {
  try {
    return JSON.parse(deviceStorage.get(STORE) ?? '{}') as Record<string, { fp: string; url: string }>;
  } catch {
    return {};
  }
}

function recall(look: string): string | null {
  const hit = readStore()[look];
  return hit && hit.fp === fingerprint(look) && hit.url.startsWith('data:image/png') ? hit.url : null;
}

function remember(look: string, url: string) {
  try {
    const all = readStore();
    all[look] = { fp: fingerprint(look), url };
    deviceStorage.set(STORE, JSON.stringify(all));
  } catch {
    /* storage full or blocked: portraits are simply rendered again next visit */
  }
}

const half = THREE.DataUtils.fromHalfFloat;

/** ACES (Narkowicz fit) with a touch of exposure, then sRGB. */
function tone(x: number): number {
  x *= 0.9;
  const v = (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14);
  const c = Math.min(1, Math.max(0, v));
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

function toDataUrl(px: Uint16Array): string | null {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  if (!g) return null;
  const img = g.createImageData(W, H);
  const sw = W * SS;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let r = 0, gg = 0, b = 0, a = 0;
      for (let j = 0; j < SS; j++) {
        for (let i = 0; i < SS; i++) {
          // GL rows run bottom-up
          const sy = (H - 1 - y) * SS + (SS - 1 - j);
          const k = (sy * sw + x * SS + i) * 4;
          const al = Math.min(1, half(px[k + 3]));
          r += half(px[k]) * al;
          gg += half(px[k + 1]) * al;
          b += half(px[k + 2]) * al;
          a += al;
        }
      }
      const o = (y * W + x) * 4;
      const n = SS * SS;
      if (a > 0) {
        img.data[o] = Math.round(tone(r / a) * 255);
        img.data[o + 1] = Math.round(tone(gg / a) * 255);
        img.data[o + 2] = Math.round(tone(b / a) * 255);
      }
      img.data[o + 3] = Math.round((a / n) * 255);
    }
  }
  g.putImageData(img, 0, 0);
  return c.toDataURL('image/png');
}
