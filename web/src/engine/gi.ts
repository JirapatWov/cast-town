// Interior global illumination: L2 spherical-harmonic irradiance probes (three r186 LightProbeGridWebGL).
//
// Two grids live in a GI scene: an INNER grid filling the floor on show (soft bounce from sunlit floors, lamps,
// tinted walls; dark corners stay dark) and a coarse OUTER grid around the whole lot (sky light for the garden and
// the shell of the other floors). Every object samples the grid whose box holds its origin, so the inner bounce
// never leaks onto the lawn. Bakes are progressive (a few probes per frame inside a CPU budget) into an off-screen
// grid that is swapped in when complete, so the image changes once instead of crawling layer by layer. Baked
// grids are cached per floor + time of day; a floor is re-baked only when its contents change.
//
// While baking: invisible shadow-only occluders (the dollhouse's full-height walls and ceiling) are drawn as matte
// plaster so light only enters through windows, people are hidden, and the sky is the current outdoor HDRI.
import * as THREE from 'three';
import { LightProbeGridWebGL } from 'three/addons/lighting/LightProbeGridWebGL.js';

export interface GIQuality {
  enabled: boolean;
  /** Inner grid probe counts (x, y, z). x even and z odd keep probes off the house's x=0 partition and on the corridor axis. */
  probes: [number, number, number];
  cubemapSize: number;
  /** Extra bounce passes (0 = one bounce of indirect light). */
  bounces: number;
  /** CPU milliseconds per frame spent baking. */
  budgetMs: number;
}

export interface GIVolume {
  /** World-space box of the interior to light (one floor). */
  box: THREE.Box3;
  /** Identity of the volume, e.g. `floor:2` (cache key). */
  key: string;
}

/** Bake-time sky: the outdoor HDRI of the current time of day (set by the engine). */
interface BakeSky {
  texture: THREE.Texture | null;
  intensity: number;
  rotationY: number;
}

const bakeSky: BakeSky = { texture: null, intensity: 1, rotationY: 0 };
let quality: GIQuality = { enabled: true, probes: [10, 3, 7], cubemapSize: 16, bounces: 1, budgetMs: 6 };
let phaseKey = 'day';
const registry = new Map<THREE.Scene, ProbeGI>();
/** ?gibudget=ms overrides the per-frame bake budget (headless screenshots bake everything in one go). */
const budgetOverride = (() => {
  try {
    return Number(new URLSearchParams(location.search).get('gibudget')) || 0;
  } catch {
    return 0;
  }
})();
const budget = () => budgetOverride || quality.budgetMs;
/** Bakes follow the frame time (ProbeGI.pace); off only to compare on a real GPU (engine debug.giPacing). */
let pacing = true;

export function setGIPacing(on: boolean) {
  pacing = on;
}

/** Engine → GI: the sky used as light source through windows during bakes. */
export function setGISky(texture: THREE.Texture | null, intensity: number, rotationY: number, phase: string) {
  const changed = phase !== phaseKey || texture !== bakeSky.texture;
  bakeSky.texture = texture;
  bakeSky.intensity = intensity;
  bakeSky.rotationY = rotationY;
  phaseKey = phase;
  if (changed) for (const gi of registry.values()) gi.phaseChanged();
}

export function setGIQuality(q: GIQuality) {
  const changed = JSON.stringify(q) !== JSON.stringify(quality);
  quality = q;
  if (changed) for (const gi of registry.values()) gi.qualityChanged();
}

export function giFor(scene: THREE.Scene | null | undefined): ProbeGI | undefined {
  return scene ? registry.get(scene) : undefined;
}

/** Create (once) the GI system of a scene. Call before the scene's first render so programs compile with probes. */
export function attachProbeGI(scene: THREE.Scene, renderer: THREE.WebGLRenderer): ProbeGI {
  let gi = registry.get(scene);
  if (!gi) {
    gi = new ProbeGI(scene, renderer);
    registry.set(scene, gi);
  }
  return gi;
}

/** Whether float 3D textures can be filtered (the probe atlas is RGBA32F). */
function supported(renderer: THREE.WebGLRenderer): boolean {
  const ext = renderer.extensions;
  return renderer.capabilities.isWebGL2 && ext.has('OES_texture_float_linear') && ext.has('EXT_color_buffer_float');
}

const PROXY = new THREE.MeshStandardMaterial({ name: 'gi-occluder', color: 0xe8e1d6, roughness: 0.92, metalness: 0 });
const OUTER_SIZE = new THREE.Vector3(120, 22, 100);
const OUTER_CENTER = new THREE.Vector3(0, 10, 0);

interface Job {
  grid: LightProbeGridWebGL;
  key: string;
  pass: number;
  next: number;
  /** Probes per slice, adapted to the time budget. */
  step: number;
  outer: boolean;
  signature: string;
  started: number;
}

interface Cached {
  grid: LightProbeGridWebGL;
  signature: string;
}

export class ProbeGI {
  readonly group = new THREE.Group();
  readonly ok: boolean;
  private inner: LightProbeGridWebGL;
  /** Volume key the inner grid was baked for (null: placeholder). */
  private innerKey: string | null = null;
  private outer: LightProbeGridWebGL;
  private placeholder: LightProbeGridWebGL;
  private outerPhase: string | null = null;
  private volume: GIVolume | null = null;
  private cache = new Map<string, Cached>();
  private job: Job | null = null;
  private dirtyAt = 0;
  private idleWaiters: (() => void)[] = [];
  private enabled = false;
  private budgetScale = 1;
  private framesSeen = 0;
  /** Probes a frame may bake (see pace()), what's left over from earlier frames, and when update() last ran. */
  private rate = 1;
  private allowance = 0;
  private lastUpdate = 0;
  private warm: THREE.Mesh;
  /** Bake statistics for the dev overlay / tests. */
  readonly stats = { bakes: 0, lastMs: 0, lastProbes: 0, callsPerProbe: 0 };

  constructor(private scene: THREE.Scene, private renderer: THREE.WebGLRenderer) {
    this.ok = supported(renderer);
    this.group.name = 'probe-gi';
    this.group.userData.noBatch = true;
    this.group.userData.giIgnore = true;
    // A grid needs a texture to count; until a floor is baked the inner slot holds an empty grid far away.
    this.placeholder = this.makeGrid(1, 1, 1, [2, 2, 2]);
    this.placeholder.position.set(0, -10000, 0);
    this.placeholder.updateBoundingBox();
    const tex = new THREE.Data3DTexture(new Uint16Array(4), 1, 1, 1);
    tex.type = THREE.HalfFloatType;
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    this.placeholder.texture = tex;
    this.inner = this.placeholder;
    this.outer = this.makeGrid(OUTER_SIZE.x, OUTER_SIZE.y, OUTER_SIZE.z, [2, 2, 2]);
    this.outer.position.copy(OUTER_CENTER);
    this.outer.updateBoundingBox();
    this.outer.texture = tex; // black until baked; replaced by its own atlas on the first bake
    this.group.add(this.inner, this.outer);
    // The bake draws invisible shadow casters with PROXY. A degenerate triangle with PROXY rides along in every frame
    // so its shader variant (lights, fog, probe grid of this scene) is compiled with the scene, not mid-bake.
    const warm = new THREE.Mesh(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(9), 3)).setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]), 3)), PROXY);
    warm.name = 'gi-warm';
    warm.frustumCulled = false;
    warm.castShadow = warm.receiveShadow = false;
    warm.userData.giIgnore = true;
    this.group.add(warm);
    this.warm = warm;
    this.setEnabled(this.ok && quality.enabled);
  }

  get active(): boolean {
    return this.enabled;
  }

  /** The interior volume last set by the view (also used to fit the indoor shadow frustum). */
  get volumeBox(): THREE.Box3 | null {
    return this.volume?.box ?? null;
  }

  /** True while a bake is queued or running. */
  get busy(): boolean {
    return this.enabled && (this.job !== null || this.dirtyAt > 0 || this.outerPhase !== phaseKey);
  }

  /** Resolves when no bake is pending (or after `timeoutMs`). */
  whenIdle(timeoutMs = 4000): Promise<void> {
    if (!this.busy) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(done, timeoutMs);
      function done() {
        clearTimeout(t);
        resolve();
      }
      this.idleWaiters.push(done);
    });
  }

  /** The interior on show (null: none, only the outer grid lights the scene). */
  setVolume(v: GIVolume | null) {
    const same = v && this.volume && v.key === this.volume.key && v.box.equals(this.volume.box);
    this.volume = v ? { key: v.key, box: v.box.clone() } : null;
    if (!this.enabled) return;
    if (!v) {
      this.setInner(this.placeholder, null);
      return;
    }
    if (same) {
      this.checkContents();
      return;
    }
    const cached = this.cache.get(this.cacheKey(v.key));
    if (cached) {
      this.setInner(cached.grid, v.key);
      this.checkContents();
    } else {
      // another floor's bake must not light this one: sky light (outer grid) until this floor is baked
      if (this.innerKey !== v.key) this.setInner(this.placeholder, null);
      this.schedule(0);
    }
  }

  /** Something in the volume may have changed (furniture rebuilt): re-bake if its contents differ. */
  checkContents() {
    if (!this.enabled || !this.volume) return;
    const cached = this.cache.get(this.cacheKey(this.volume.key));
    if (!cached || cached.signature !== this.signature(this.volume.box)) this.schedule(250);
  }

  /** Every cached bake is stale (quality changed). */
  invalidateAll() {
    for (const c of this.cache.values()) if (c.grid !== this.inner) c.grid.dispose();
    this.cache.clear();
    this.outerPhase = null;
    if (this.job) this.abortJob();
    if (this.enabled && this.volume) this.schedule(0);
  }

  /** Time of day changed: bakes are cached per phase, so switching back is instant; the outer grid re-bakes. */
  phaseChanged() {
    if (this.job) this.abortJob();
    this.outerPhase = null;
    if (!this.enabled || !this.volume) return;
    const cached = this.cache.get(this.cacheKey(this.volume.key));
    if (cached) {
      this.setInner(cached.grid, this.volume.key);
      this.checkContents();
    } else this.schedule(0);
  }

  qualityChanged() {
    const want = this.ok && quality.enabled;
    if (want !== this.enabled) this.setEnabled(want);
    if (!this.enabled) return;
    this.invalidateAll();
  }

  /** Engine, once per frame while this scene is rendered: run a slice of the current bake. `budgetScale` > 1
   *  while the view is covered (time-of-day dissolve), so the re-bake finishes under the cover. `steadyMs`: the
   *  frame time while nothing bakes, which bakes pace themselves against. */
  update(now = performance.now(), budgetScale = 1, steadyMs = 0) {
    const frameMs = this.lastUpdate ? now - this.lastUpdate : 0;
    this.lastUpdate = now;
    if (!this.enabled) return;
    // let the view render its first frames (and compile its shaders) before baking starts
    if (this.framesSeen < 3) {
      this.framesSeen++;
      return;
    }
    this.budgetScale = budgetScale;
    if (!this.job) {
      if (this.outerPhase !== phaseKey) this.startJob(true);
      else if (this.dirtyAt > 0 && now >= this.dirtyAt && this.volume) this.startJob(false);
      else if (this.dirtyAt === 0) this.flushIdle();
      if (!this.job) return;
    }
    this.runSlice(this.pace(frameMs, steadyMs));
  }

  dispose() {
    this.abortJob();
    for (const c of this.cache.values()) c.grid.dispose();
    this.cache.clear();
    this.outer.dispose();
    this.group.removeFromParent();
    registry.delete(this.scene);
  }

  // ── internals ────────────────────────────────────────────────────────────────────────────────

  private setEnabled(on: boolean) {
    this.enabled = on;
    if (on) {
      if (!this.group.parent) this.scene.add(this.group);
      if (this.volume) this.schedule(0);
    } else {
      this.abortJob();
      this.group.removeFromParent();
      this.flushIdle();
    }
  }

  private cacheKey(volumeKey: string): string {
    return `${volumeKey}|${phaseKey}`;
  }

  private schedule(delayMs: number) {
    const at = performance.now() + delayMs;
    this.dirtyAt = this.dirtyAt > 0 ? Math.min(this.dirtyAt, at) : at;
    if (this.job && !this.job.outer) this.abortJob(); // restart with the latest contents
  }

  private makeGrid(w: number, h: number, d: number, res: [number, number, number]): LightProbeGridWebGL {
    const g = new LightProbeGridWebGL(w, h, d, res[0], res[1], res[2]);
    g.name = 'probe-grid';
    g.userData.giIgnore = true;
    return g;
  }

  private setInner(grid: LightProbeGridWebGL, key: string | null) {
    this.innerKey = key;
    if (grid === this.inner) return;
    this.replaceChild(this.inner, grid);
    this.inner = grid;
  }

  /** Swap a grid in the GI group, keeping the inner grid first (the renderer picks the first box that contains). */
  private replaceChild(old: LightProbeGridWebGL, grid: LightProbeGridWebGL) {
    const i = this.group.children.indexOf(old);
    if (i < 0) return;
    old.parent = null;
    grid.removeFromParent();
    grid.parent = this.group;
    this.group.children[i] = grid;
  }

  private startJob(outer: boolean) {
    const res: [number, number, number] = outer ? [2, 2, 2] : quality.probes;
    let grid: LightProbeGridWebGL;
    if (outer) {
      grid = this.outer;
    } else {
      const box = this.volume!.box.clone();
      const size = box.getSize(new THREE.Vector3());
      // Probes sit inside the walls, above the floor and under the ceiling (a probe in a wall or on the floor plane
      // sees nothing useful) ...
      grid = this.makeGrid(Math.max(0.5, size.x - 0.6), Math.max(0.5, size.y - 0.75), Math.max(0.5, size.z - 0.6), res);
      box.getCenter(grid.position);
      grid.position.y = box.min.y + 0.25 + (size.y - 0.75) / 2;
      // ... but the box that decides which objects use this grid (and maps it in the shader) spans the whole floor,
      // slab to ceiling: floor meshes have their origin on the slab. bake() refreshes the box, so pin it.
      grid.updateBoundingBox = () => {
        grid.boundingBox.copy(box);
      };
      grid.updateBoundingBox();
      this.dirtyAt = 0;
    }
    this.job = {
      grid,
      key: outer ? 'outer' : this.volume!.key,
      pass: 0,
      next: 0,
      step: outer ? 8 : 2,
      outer,
      signature: outer ? '' : this.signature(this.volume!.box),
      started: performance.now(),
    };
  }

  private abortJob() {
    const j = this.job;
    this.job = null;
    if (j && !j.outer && j.grid !== this.inner && ![...this.cache.values()].some((c) => c.grid === j.grid)) disposeLater(j.grid);
  }

  /** Probes this frame may bake. The CPU budget alone doesn't bound a bake on a real GPU: a probe is ~500 draw
   *  calls, cheap to issue here but costly in the browser's GPU process (Chrome/Metal on an M3 Pro: 6 ms slices made
   *  50 ms frames for the whole bake). So the rate follows the frame time: it backs off while frames run well over
   *  the steady frame time and grows back while they don't; under 1, a probe bakes every few frames. */
  private pace(frameMs: number, steadyMs: number): number {
    if (!pacing || budgetOverride || this.budgetScale > 1) return Infinity; // headless bakes / under the dissolve
    const target = Math.max(steadyMs * 1.25, 18);
    if (frameMs > 0 && frameMs < 250) this.rate = frameMs > target ? Math.max(1 / 8, this.rate * 0.6) : Math.min(32, this.rate * 1.15);
    this.allowance = Math.min(this.allowance + this.rate, this.rate + 1);
    const n = Math.floor(this.allowance);
    this.allowance -= n;
    return n;
  }

  private runSlice(maxProbes = Infinity) {
    const j = this.job!;
    const total = j.grid.resolution.x * j.grid.resolution.y * j.grid.resolution.z;
    const t0 = performance.now();
    let spent = 0;
    let left = maxProbes;
    // a slice may cover several small chunks while the budget allows (pass boundaries restart at probe 0)
    while (left > 0 && spent < budget() * this.budgetScale && this.job === j) {
      const count = Math.min(j.step, total - j.next, left);
      left -= count;
      const c0 = performance.now();
      const programs0 = budgetOverride ? this.renderer.info.programs?.length ?? 0 : 0;
      this.bakeRange(j, j.next, count);
      const dt = performance.now() - c0;
      spent = performance.now() - t0;
      // adapt the chunk size so one chunk takes about half the budget
      const per = dt / Math.max(1, count);
      j.step = THREE.MathUtils.clamp(Math.round((budget() * this.budgetScale * 0.5) / Math.max(0.05, per)), 1, budgetOverride ? 4096 : 32);
      j.next += count;
      if (budgetOverride) console.log(`[gi] ${j.outer ? 'outer' : j.key} pass ${j.pass} probes ${j.next}/${total} in ${dt.toFixed(0)} ms, ${this.stats.callsPerProbe} calls/probe, +${(this.renderer.info.programs?.length ?? 0) - programs0} programs`);
      if (j.next >= total) {
        if (j.pass < (j.outer ? 0 : quality.bounces)) {
          j.pass++;
          j.next = 0;
        } else {
          this.finishJob(j);
          return;
        }
      }
    }
  }

  private finishJob(j: Job) {
    this.job = null;
    this.warm.visible = false; // its shader exists now: stop paying a draw call for it
    this.stats.bakes++;
    this.stats.lastMs = performance.now() - j.started;
    this.stats.lastProbes = j.grid.resolution.x * j.grid.resolution.y * j.grid.resolution.z;
    if (j.outer) {
      this.outerPhase = phaseKey;
      // the inner bake reads the garden through the windows: refresh it on top of the new sky light
      if (this.volume && this.dirtyAt === 0 && !this.cache.has(this.cacheKey(this.volume.key))) this.schedule(0);
      return;
    }
    const key = this.cacheKey(j.key);
    const old = this.cache.get(key);
    if (old && old.grid !== j.grid && old.grid !== this.inner) old.grid.dispose();
    this.cache.set(key, { grid: j.grid, signature: j.signature });
    if (this.volume && this.volume.key === j.key) {
      const prev = this.inner;
      this.setInner(j.grid, j.key);
      if (prev !== this.placeholder && ![...this.cache.values()].some((c) => c.grid === prev)) prev.dispose();
    }
  }

  private flushIdle() {
    if (this.busy) return;
    const w = this.idleWaiters;
    this.idleWaiters = [];
    for (const fn of w) fn();
  }

  /** Bake probes [start, start+count) of the job's grid with the scene staged for GI. */
  private bakeRange(j: Job, start: number, count: number) {
    const scene = this.scene;
    const restore: (() => void)[] = [];
    // stage: occluders visible, people hidden, sky as background, shadow maps reused
    const hide = (o: THREE.Object3D) => {
      o.visible = false;
      restore.push(() => (o.visible = true));
    };
    const walk = (o: THREE.Object3D) => {
      if (!o.visible) return;
      if (o !== this.group && !(o as LightProbeGridWebGL).isLightProbeGrid && (o.userData.giIgnore || o.name.startsWith('person:') || o.name.startsWith('player'))) {
        hide(o);
        return;
      }
      const m = o as THREE.Mesh;
      if (m.isMesh && !Array.isArray(m.material)) {
        if ((m as THREE.SkinnedMesh).isSkinnedMesh) {
          hide(m);
          return;
        }
        const mat = m.material as THREE.Material;
        if (mat.colorWrite === false && m.castShadow) {
          m.material = PROXY;
          restore.push(() => (m.material = mat));
        }
      }
      const l = o as THREE.Light & { shadow?: THREE.LightShadow };
      if (l.isLight && l.castShadow && l.shadow?.map) {
        // keep the shadow maps the last frame rendered instead of redrawing every caster per slice
        const s = l.shadow;
        const au = s.autoUpdate, nu = s.needsUpdate;
        s.autoUpdate = false;
        s.needsUpdate = false;
        restore.push(() => {
          s.autoUpdate = au;
          s.needsUpdate = nu;
        });
      }
      for (const c of o.children) walk(c);
    };
    walk(scene);
    const bg = scene.background, bgI = scene.backgroundIntensity, bgB = scene.backgroundBlurriness;
    const bgR = scene.backgroundRotation.y;
    // fog off without changing shader variants (a null fog would recompile every material for the bake)
    const fog = scene.fog as (THREE.Fog & THREE.FogExp2) | null;
    const fogNear = fog?.near, fogFar = fog?.far, fogDensity = fog?.density;
    if (bakeSky.texture) {
      scene.background = bakeSky.texture;
      scene.backgroundIntensity = bakeSky.intensity;
      scene.backgroundBlurriness = 0.35;
      scene.backgroundRotation.y = bakeSky.rotationY;
    }
    if (fog?.isFog) {
      fog.near = 1e7;
      fog.far = 1e7 + 1;
    } else if (fog?.isFogExp2) fog.density = 0;
    let swapped = false;
    if (!j.outer && j.grid !== this.inner) {
      this.replaceChild(this.inner, j.grid);
      swapped = true;
    }
    const calls0 = this.renderer.info.render.calls;
    try {
      j.grid.bake(this.renderer, scene, {
        // one capture setup for every bake (a different size or range re-creates the cube target and camera)
        cubemapSize: quality.cubemapSize,
        near: 0.05,
        far: 220,
        start,
        count,
        pass: j.pass,
      });
    } catch (e) {
      console.warn('[gi] bake failed', e);
      this.job = null;
    } finally {
      if (swapped) this.replaceChild(j.grid, this.inner);
      scene.background = bg;
      scene.backgroundIntensity = bgI;
      scene.backgroundBlurriness = bgB;
      scene.backgroundRotation.y = bgR;
      if (fog?.isFog) {
        fog.near = fogNear!;
        fog.far = fogFar!;
      } else if (fog?.isFogExp2) fog.density = fogDensity!;
      for (let i = restore.length - 1; i >= 0; i--) restore[i]();
      this.stats.callsPerProbe = Math.round((this.renderer.info.render.calls - calls0) / Math.max(1, count));
    }
  }

  /** Cheap identity of what is inside a box (meshes and their geometry/material), ignoring people. */
  private signature(box: THREE.Box3): string {
    let n = 0, ids = 0, mats = 0;
    const p = new THREE.Vector3();
    const walk = (o: THREE.Object3D) => {
      if (!o.visible || o.userData.giIgnore || o.name.startsWith('person:') || o.name.startsWith('player')) return;
      const m = o as THREE.Mesh;
      if (m.isMesh && !(m as THREE.SkinnedMesh).isSkinnedMesh) {
        p.setFromMatrixPosition(m.matrixWorld);
        if (box.containsPoint(p)) {
          n++;
          ids = (ids + m.geometry.id * 31 + m.id) % 1e9;
          const mat = m.material as THREE.Material | THREE.Material[];
          mats = (mats + (Array.isArray(mat) ? mat.length * 7 : mat.version + 1)) % 1e9;
        }
      }
      for (const c of o.children) walk(c);
    };
    walk(this.scene);
    return `${n}:${ids}:${mats}`;
  }
}

/** Free a grid when the main thread is idle: an abort happens on a floor switch or a rebuilt room, and freeing the
 *  half-baked atlas (a 3D render target) right there added its GL teardown to that frame. */
function disposeLater(grid: LightProbeGridWebGL) {
  const run = () => grid.dispose();
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 3000 });
  else setTimeout(run, 500);
}
