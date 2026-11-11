// Real Life Terminal — app entry. Wires engine → store → bus → city/house views → UI, owns the view state
// machine (city ⇄ house ⇄ drive), the transitions between views and the store → 3D fan-out.
import type * as THREE from 'three';
import type { TranscriptItem, WorkflowRun } from '../../shared/protocol';
import { createBootScreen, curtainNote, townProgress, trackAssets } from './boot';
import type { AppContext, Bus, CityView, Engine, HouseView, Store, ViewName } from './core/types';
import { townShown } from './core/town-shown';
import { createEngineSlot } from './engine-slot';
import type { Interior } from './interior';
import { createBus, createStore } from './net';
import { gitKey } from './net/reducer';
import type { Player } from './player';
import { createUI } from './ui';
import { blockOpts, bootFootText } from './ui/agents-health';
import { appNav } from './ui/nav-history';
import { isPhoneSized, isSheetLayout } from './ui/touch';
import { runAsWorkflow } from './ui/runs';
import { setTagModels } from './people/tag-state';
import { focusLandmark } from './ui/focus';
import { boardRemembered, searchWithoutBoard, startOnBoard, threeD, webglAvailable } from './ui/view-mode';

declare global {
  interface Window {
    /** Debug / QA handle (headless screenshots drive the app through it). */
    __rlt?: {
      store: Store;
      bus: Bus;
      engine: Engine | null;
      city: CityView | null;
      house: HouseView | null;
      /** The homeowner avatar (null without WebGL). */
      player?: Player | null;
      view(): { view: ViewName; projectId: string | null; busy: boolean };
      ready: { city: boolean; house: boolean };
    };
  }
}

const FADE_OUT_MS = 320;
const FADE_IN_MS = 460;
const APPROACH_TIMEOUT_MS = 1800;
/** A 3D start keeps the splash at most this long after the page started (and until the first snapshot) before it
 *  lifts onto the Town board while the town builds (finding #70): long enough that a quick town shows without the
 *  board flashing first, short enough that a phone or a slow line gets to the chat in seconds, not after all of 3D. */
const STAND_IN_MS = 3000;

const tracker = trackAssets();
const boot = createBootScreen(tracker);
/** Lift the splash. Its buttons (Reload, Continue without 3D) may hold the focus: hand it to the page's heading, not
 *  <body>. */
async function bootDone(opts?: { quick?: boolean }): Promise<void> {
  const held = !!document.getElementById('boot')?.contains(document.activeElement);
  if (!performance.getEntriesByName('cast:shell-ready').length) performance.mark('cast:shell-ready'); // QA scripts
  await boot.done(opts);
  if (held) focusLandmark();
}
const note = curtainNote();
const store = createStore();
const bus = createBus();

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | void> {
  return Promise.race([p, sleep(ms)]);
}

function parseHash(): { projectId: string; jobId?: string } | null {
  const m = /^#\/house\/([^/?#]+)(?:\/([^/?#]+))?/.exec(location.hash);
  if (!m) return null;
  try {
    return { projectId: decodeURIComponent(m[1]), jobId: m[2] ? decodeURIComponent(m[2]) : undefined };
  } catch {
    return null;
  }
}
/** `#/house/<projectId>` plus `/<jobId>` while a job other than 'main' is selected. */
function houseHash(projectId: string): string {
  const base = `#/house/${encodeURIComponent(projectId)}`;
  const job = store.activeJob(projectId);
  return job && job.id !== 'main' ? `${base}/${encodeURIComponent(job.id)}` : base;
}
/** Back / Forward (finding #50): entering a house is its own history entry ('push'), leaving one steps back to the
 *  town entry ('up'), other changes only update the address ('replace'). */
const nav = appNav();
function setHash(hash: string, how: 'push' | 'replace' | 'up' = 'replace') {
  nav[how](hash);
}

/** The models people can work on, for their name tags (people/tag-state.ts); null → mark nobody (ui/format.ts
 *  agentBlocked: the first account check still runs, or the scripted test model plays every model). */
function tagModels(s: Store['state']): string[] | null {
  const o = blockOpts(s.hello);
  return o.scripted || o.checking ? null : s.models.filter((m) => m.available).map((m) => m.id);
}

/** First snapshot (projects + residents) — resolves immediately if already here, or after `ms`. */
function snapshotArrived(ms: number): Promise<boolean> {
  if (store.state.city.projects.length) return Promise.resolve(true);
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      off();
      resolve(false);
    }, ms);
    const off = store.subscribe((_s, msg) => {
      if (msg?.t === 'snapshot') {
        clearTimeout(t);
        off();
        resolve(true);
      }
    });
  });
}

store.subscribe((s, msg) => {
  // models: the account check ended while the curtain is up; the snapshot (right after hello) brings the accounts
  if (msg?.t !== 'hello' && msg?.t !== 'snapshot' && msg?.t !== 'models') return;
  boot.setFoot(bootFootText(s.hello, msg.t === 'hello' ? undefined : s));
});

/** Engine stand-in when WebGL is unavailable: the 2D UI (focus mode) still drives everything. */
function createFlatEngine(): Engine {
  return {
    renderer: null as unknown as Engine['renderer'],
    canvas: document.createElement('canvas'),
    assets: null as unknown as Engine['assets'],
    quality: 'low',
    labelLayer: document.createElement('div'),
    setView() {},
    setQuality() {},
    onFrame: () => () => {},
    pick: () => null,
    fade: async () => {},
    setPaused() {},
  };
}

async function main() {
  const sceneEl = document.getElementById('scene')!;
  const deepLink = parseHash();

  // Board start (remembered from last time, ?2d, or a phone that never chose): no 3D download or build until someone
  // switches to 3D. The engine everyone holds is a slot: the flat stand-in until the real one is built (engine-slot.ts).
  const boardStart = startOnBoard(location.search, boardRemembered(), isPhoneSized());
  const engine = createEngineSlot(createFlatEngine());
  const ctx: AppContext = { engine, store, bus };
  // The city view arrives with the WebGL engine (build3D); the house view and the avatar with the interior chunk
  // (once the town is up, or on the way to a door).
  let city: CityView | null = null;
  let house: Interior['house'] | null = null;
  let player: Player | null = null;
  const panelCams: CityView['camera'][] = [];
  const ready = { city: false, house: false };
  window.__rlt = {
    store, bus, engine, ready,
    get city() { return city; },
    get house() { return house; },
    get player() { return player; },
    view: () => ({ view, projectId: houseId, busy: navBusy }),
  };
  /** The 3D town is up: views take the full transitions; until then (and without WebGL) the flat path. */
  const has3D = () => !!(city && ready.city);

  /** The interior code (house view + avatar), not its assets. Resolves false without 3D or when the chunk fails. */
  let interior: Promise<boolean> | null = null;
  function loadInterior(): Promise<boolean> {
    const c = city;
    if (!has3D() || !c) return Promise.resolve(false);
    interior ??= import('./interior').then(
      ({ createInterior }) => {
        ({ house, player } = createInterior(ctx, c));
        panelCams.push(house.camera);
        return true;
      },
      (e) => {
        console.error('[main] interior failed to load', e);
        interior = null; // a later entry tries again
        return false;
      },
    );
    return interior;
  }
  /** Start furnishing the house ahead of an entry (pointer over a building, a click, a deep link). */
  function warmHouse() {
    void loadInterior().then((ok) => {
      if (ok && house && !ready.house) house.init().then(() => (ready.house = true), (e) => console.error('[main] house init failed', e));
    });
  }

  // ───────── view state machine ─────────
  let view: ViewName = 'city';
  let houseId: string | null = null;
  let approachedId: string | null = null; // the city camera stands at this building's door
  let paused = false;
  let navBusy = false;
  let pendingNav: (() => Promise<void>) | null = null;
  let driveSince = 0;
  let drawn = false; // the town has been drawn once: its shaders are compiled

  /** Run one transition at a time; while one runs, only the latest request is kept. */
  function navigate(fn: () => Promise<void>) {
    if (navBusy) {
      pendingNav = fn;
      return;
    }
    navBusy = true;
    void (async () => {
      let next: (() => Promise<void>) | null = fn;
      while (next) {
        try {
          await next();
        } catch (e) {
          console.error('[main] transition failed', e);
          note.hide();
          await engine.fade(false, 200);
        }
        next = pendingNav;
        pendingNav = null;
      }
      navBusy = false;
    })();
  }

  function announce(v: ViewName, projectId: string | null) {
    view = v;
    store.setLocal({ view: v, currentProjectId: projectId });
    bus.emit('view:changed', { view: v, projectId: projectId ?? undefined });
  }

  async function ensureHouseReady(): Promise<boolean> {
    if (!(await loadInterior()) || !house) return false;
    if (ready.house) return true;
    const showNote = () => {
      const p = Math.round(tracker.progress(['house']) * 100);
      note.show(`Furnishing the house… ${p}%`);
    };
    showNote();
    const off = tracker.onChange(showNote);
    try {
      await house.init();
      ready.house = true;
      return true;
    } catch (e) {
      console.error('[main] house failed to load', e);
      return false;
    } finally {
      off();
      note.hide();
    }
  }

  async function doEnter(projectId: string, opts: { instant?: boolean } = {}) {
    const project = store.project(projectId);
    if (!project) return;
    warmHouse(); // the furniture loads while the camera swoops to the door
    if (!has3D() || !city) {
      houseId = projectId;
      store.send({ t: 'enter_project', projectId });
      const link = parseHash();
      if (link?.projectId === projectId && link.jobId && store.job(projectId, link.jobId)) store.setLocal({ currentProjectId: projectId, currentJobId: link.jobId });
      announce('house', projectId);
      setHash(houseHash(projectId), parseHash() ? 'replace' : 'push');
      return;
    }
    if (view === 'house' && houseId === projectId) return;
    const animate = !opts.instant && !paused;
    if (view === 'house' && house) {
      await engine.fade(true, FADE_OUT_MS);
      house.exit();
      player?.exitHouse();
      houseId = null;
    } else {
      if (animate) {
        player?.cityApproach(projectId);
        await withTimeout(city.approach(projectId), APPROACH_TIMEOUT_MS);
        approachedId = projectId;
      } else approachedId = null;
      await engine.fade(true, opts.instant ? 0 : FADE_OUT_MS);
      city.deactivate();
    }
    if (!(await ensureHouseReady()) || !house) {
      city.activate();
      announce('city', null);
      await engine.fade(false, FADE_IN_MS);
      return;
    }
    const fresh = store.project(projectId) ?? project;
    await house.enter(fresh);
    houseId = projectId;
    store.send({ t: 'enter_project', projectId });
    // deep link #/house/<projectId>/<jobId> selects that job (set with the house, or the house change resets it)
    const linkJob = parseHash()?.projectId === projectId ? parseHash()?.jobId : undefined;
    if (linkJob && store.job(projectId, linkJob)) store.setLocal({ currentProjectId: projectId, currentJobId: linkJob });
    syncHouse(true);
    player?.enterHouse(projectId, { walkIn: animate });
    // open on the room of the job in focus, framed as picking it does (the camera jumps while the curtain is down)
    const focus = store.activeJob(projectId);
    if (focus && focus.room.floor > 0) void house.focusRoom(focus.room);
    announce('house', projectId);
    setHash(houseHash(projectId), parseHash() ? 'replace' : 'push'); // a link / Back-Forward already shows it
    // one rendered frame of the interior before lifting the curtain
    await nextFrame();
    await nextFrame();
    await engine.fade(false, FADE_IN_MS);
  }

  async function doExitToCity() {
    if (view === 'city') {
      if (city?.driving) city.stopDriving();
      return;
    }
    if (view === 'drive') {
      if (city?.driving) city.stopDriving();
      announce('city', null);
      return;
    }
    const from = houseId;
    if (!has3D() || !city || !house) {
      houseId = null;
      announce('city', null);
      setHash('', 'up');
      return;
    }
    await engine.fade(true, FADE_OUT_MS);
    house.exit();
    player?.exitHouse();
    houseId = null;
    city.activate(); // steps back from the door it approached, so the house is in view
    syncCity();
    announce('city', null);
    setHash('', 'up');
    await nextFrame();
    await engine.fade(false, FADE_IN_MS);
    if (from && approachedId !== from) void city.flyTo({ projectId: from });
    approachedId = null;
  }

  async function doDrive() {
    if (!has3D() || !city) return;
    if (paused) bus.emit('focusmode:change', { on: false });
    if (view === 'house') await doExitToCity();
    city.startDriving();
    driveSince = performance.now();
    announce('drive', null);
  }

  async function doFlyTo(target: { projectId?: string; landmarkId?: string }) {
    if (!has3D() || !city) return;
    if (view === 'house') await doExitToCity();
    const p = city.flyTo(target);
    if (view === 'drive') announce('city', null); // flyTo parks the car
    await withTimeout(p, 2600);
  }

  // ───────── bus wiring ─────────
  bus.on('building:click', ({ projectId }) => navigate(() => doEnter(projectId)));
  bus.on('building:hover', ({ projectId }) => {
    if (projectId && ready.city) warmHouse();
  });
  bus.on('nav:enter', ({ projectId }) => navigate(() => doEnter(projectId)));
  bus.on('door:click', () => navigate(doExitToCity));
  bus.on('nav:city', () => navigate(doExitToCity));
  bus.on('nav:drive', () => navigate(doDrive));
  bus.on('nav:flyto', (t) => navigate(() => doFlyTo(t)));
  bus.on('quality:change', ({ quality }) => engine.setQuality(quality));
  // floors & job rooms in the house
  bus.on('floor:show', ({ floor }) => {
    if (house && view === 'house' && houseId) void house.showFloor(floor);
  });
  bus.on('job:select', ({ projectId, jobId }) => {
    if (!house || view !== 'house' || houseId !== projectId) return;
    const job = store.job(projectId, jobId);
    if (job) void house.focusRoom(job.room);
  });
  bus.on('focusmode:change', ({ on }) => {
    if (on === paused) return;
    paused = on;
    document.body.classList.toggle('rlt-paused', on);
    if (on && city?.driving) {
      city.stopDriving();
      if (view === 'drive') announce('city', null);
    }
    if (!on && ready.city && !drawn) return void firstDraw();
    engine.setPaused(on);
  });
  /** First look at a town built behind the board: its first frames compile the shaders (seconds on a weak GPU, the
   *  page holds still meanwhile). Say so, and paint the note before those frames take the main thread. */
  async function firstDraw() {
    note.show('Preparing the 3D town…');
    await nextFrame();
    await nextFrame();
    if (!paused) {
      drawn = true;
      engine.setPaused(false);
      await nextFrame();
      await nextFrame();
    }
    note.hide();
  }
  nav.onNavigate(() => {
    const link = parseHash();
    if (link && link.projectId !== houseId) navigate(() => doEnter(link.projectId));
    else if (!link && view === 'house') navigate(doExitToCity);
    else if (link?.jobId && houseId && store.job(houseId, link.jobId) && store.activeJob(houseId)?.id !== link.jobId) {
      store.setLocal({ currentJobId: link.jobId });
      bus.emit('job:select', { projectId: houseId, jobId: link.jobId });
    }
  });

  // The car can stop on its own (E at a lot, flyTo from the UI): fall back to the city view state.
  engine.onFrame(() => {
    if (view === 'drive' && !navBusy && city && !city.driving && performance.now() - driveSince > 3000) announce('city', null);
  });

  // ───────── store → 3D ─────────
  let cityQueued = false;
  function syncCity() {
    if (!city || !ready.city) return;
    const s = store.state;
    city.sync(s.city, s.agents, s.approvals);
  }
  function queueCity() {
    if (cityQueued) return;
    cityQueued = true;
    requestAnimationFrame(() => {
      cityQueued = false;
      syncCity();
    });
  }

  let houseQueued = false;
  let lastTV: unknown = undefined;
  /** Latest run of one job (an active run wins over a newer finished one). Runs saved before jobs → 'main'. */
  function latestRun(projectId: string, jobId?: string): WorkflowRun | null {
    let best: WorkflowRun | null = null;
    for (const r of Object.values(store.state.runs)) {
      if (r.projectId !== projectId) continue;
      if (jobId !== undefined && (r.jobId || 'main') !== jobId) continue;
      const active = r.status === 'running' || r.status === 'waiting_approval';
      const bestActive = best && (best.status === 'running' || best.status === 'waiting_approval');
      if (!best || (active && !bestActive) || (active === !!bestActive && r.startedAt > best.startedAt)) best = r;
    }
    return best;
  }
  /** Every job room's corkboard shows that job's latest run. */
  function syncBoard() {
    if (!house || !houseId) return;
    const project = store.project(houseId);
    const jobs = store.jobsOf(houseId);
    const list = jobs.length ? jobs : [{ id: 'main', workflowId: project?.workflowId ?? null }];
    for (const job of list) {
      const run = latestRun(houseId, job.id);
      // a run shows its own team (a one-off team is in no workflow); no run yet → the job's team
      const wfId = job.workflowId ?? project?.workflowId ?? null;
      const wf = run ? runAsWorkflow(store.state, run) : store.workflowOf(houseId, wfId) ?? null;
      house.setRunBoard(job.id, run, wf);
    }
  }
  /** Floors and job rooms of the house on show. */
  function syncPlan() {
    if (!house || !houseId) return;
    const project = store.project(houseId);
    if (project) house.syncPlan(project, store.jobsOf(houseId));
  }
  function syncTV(force = false) {
    if (!house || !houseId) return;
    // The living-room TV shows the house folder; a job's own copy (Job.worktree) is in the Changes tab and on Watch TV.
    const summary = store.state.git[gitKey(houseId)] ?? null;
    if (!force && summary === lastTV) return;
    lastTV = summary;
    house.setTV(summary);
  }
  function syncHouse(full = false) {
    if (!house || !houseId) return;
    const s = store.state;
    if (full) syncPlan();
    house.syncAgents(store.agentsOf(houseId), Object.values(s.approvals));
    if (full) {
      syncTV(true);
      syncBoard();
    }
  }
  function queueHouse() {
    if (houseQueued) return;
    houseQueued = true;
    requestAnimationFrame(() => {
      houseQueued = false;
      syncHouse();
    });
  }

  // speech bubbles: the user's command and the first line of each reply
  const spoken = new Set<string>();
  const plain = (s: string) =>
    s
      .replace(/```[\s\S]*?(```|$)/g, ' ')
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
      .replace(/[*_`>#]+/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
  function maybeSay(agentId: string, item: TranscriptItem) {
    if (!house || !houseId || spoken.has(item.id)) return;
    const agent = store.state.agents[agentId];
    if (!agent || agent.projectId !== houseId) return;
    if (item.kind === 'user') {
      spoken.add(item.id);
      // step briefs written by the workflow engine are shown as the folder handoff, not as speech (jobs run
      // their teams side by side, so look at every active run of the house)
      const engineBrief = Object.values(store.state.runs).some(
        (r) => r.projectId === houseId && (r.status === 'running' || r.status === 'waiting_approval') && r.steps.some((st) => st.agentId === agentId),
      );
      if (engineBrief || /^\s*(Task|Brief):/i.test(item.text)) return;
      house.say(agentId, clip(plain(item.text), 120), 4500);
      return;
    }
    if (item.kind !== 'assistant' || !item.text) return;
    const lines = item.text.split('\n');
    const firstIdx = lines.findIndex((l) => plain(l).length > 0);
    if (firstIdx < 0) return;
    const first = plain(lines[firstIdx]);
    const complete = !item.streaming || lines.length > firstIdx + 1 || first.length >= 90;
    if (!complete) return;
    spoken.add(item.id);
    house.say(agentId, clip(first, 110), 5200);
  }

  store.subscribe((s, msg) => {
    if (!msg) {
      if (view === 'house' && houseId && !navBusy) setHash(houseHash(houseId)); // the job picked in the panel
      return;
    }
    switch (msg.t) {
      case 'snapshot':
        setTagModels(tagModels(s));
        queueCity();
        if (houseId) {
          if (!s.city.projects.some((p) => p.id === houseId)) navigate(doExitToCity);
          else {
            syncHouse(true);
          }
        }
        return;
      case 'city':
        queueCity();
        if (houseId && !s.city.projects.some((p) => p.id === houseId)) navigate(doExitToCity);
        else if (houseId) {
          syncPlan();
          queueHouse();
        }
        return;
      case 'jobs':
        if (msg.projectId === houseId) {
          syncPlan();
          syncBoard();
          queueHouse();
        }
        return;
      case 'agent':
      case 'agent_removed':
      case 'approval':
      case 'approval_resolved':
        queueCity();
        if (houseId) queueHouse();
        return;
      case 'git':
        if (msg.summary.projectId === houseId && !msg.summary.jobId) syncTV();
        return;
      case 'run':
        if (msg.run.projectId === houseId) syncBoard();
        return;
      case 'workflows':
        syncBoard();
        return;
      case 'models':
        // name tags say "not connected" on people whose model has no sign-in
        if (setTagModels(tagModels(s)) && houseId) queueHouse();
        return;
      case 'handoff':
        if (house && msg.projectId === houseId) house.handoff(msg.fromAgentId, msg.toAgentId, msg.label);
        return;
      case 'transcript_reset':
        for (const it of msg.items) spoken.add(it.id);
        return;
      case 'transcript_upsert':
        maybeSay(msg.agentId, msg.item);
        return;
      default:
        // toasts, acks and fs_list replies are the UI's business
        return;
    }
  });

  // ───────── UI ─────────
  const ui = createUI(ctx);
  ui.mount(document.body);
  /** Build the 3D town: the WebGL engine and the city with its assets (a house's furniture and residents load on the
   *  way to its door, the interior code once the town is on show). False when this device can't: 3D is then
   *  unavailable and the board is all there is. Progress goes to the board's view switch. */
  let building: Promise<boolean> | null = null;
  let codeFailed = false;
  function build3D(): Promise<boolean> {
    building ??= (async () => {
      threeD.set('loading', 0);
      const progress = townProgress(tracker, (v, w) => threeD.state === 'loading' && threeD.set('loading', v, w));
      let built = false;
      try {
        // the renderer, the town's code and three itself are chunks of their own: the first chunk (this file, the
        // 2D shell) never waits for them, and a Board start (or no WebGL) never downloads them
        let mods: [typeof import('./engine'), typeof import('./city')];
        try {
          mods = await Promise.all([import('./engine'), import('./city')]);
        } catch (e) {
          // the code didn't arrive (connection lost, a city that went away, an update mid-visit): nothing wrong with
          // this browser, so 3D stays on offer — but the browser keeps a failed module import for the life of the
          // page, so asking for 3D again reloads it (the loader below)
          console.error('[main] the 3D town’s code failed to load', e);
          codeFailed = true;
          building = null;
          threeD.set('idle');
          return false;
        }
        const [eng, { createCityView }] = mods;
        try {
          tracker.attach(eng.loadingManager); // before the first asset: the bar and the view switch count it
          engine.attach(await eng.createEngine(sceneEl));
        } catch (e) {
          console.error('[main] 3D engine failed to start', e);
          threeD.set('unavailable');
          return false;
        }
        engine.setPaused(paused);
        bus.emit('quality:change', { quality: engine.quality }); // the UI shows the real engine's pick
        const c = createCityView(ctx);
        city = c;
        panelCams.push(c.camera);
        installPanelOffset(engine, panelCams);
        try {
          await c.init();
        } catch (e) {
          console.error('[main] city init failed', e);
          threeD.set('unavailable');
          return false;
        }
        boot.cityLoaded();
        ready.city = true;
        built = true;
        return true;
      } finally {
        if (built) progress.preparing(); // until the town is on show: the first frames compile its shaders
        progress.stop();
      }
    })();
    return building;
  }

  /** The town was built behind the board (a board start, or a 3D start that opened on the board while it built):
   *  set it up where the user is (inside a house: that house, no swoop), then say it is ready — the UI switches to it
   *  when that was asked for (threeD.wanted). */
  async function adopt3D() {
    if (!city) return;
    if (view === 'house' && houseId) {
      const id = houseId;
      houseId = null; // entered on the flat path: the 3D house isn't, yet
      view = 'city';
      city.activate();
      syncCity();
      await doEnter(id, { instant: true }); // loads the interior on the way
    } else {
      city.activate();
      syncCity();
      void loadInterior().then(() => player?.cityReady());
    }
    townShown();
    threeD.set('ready');
  }

  const toBoard = () => {
    if (!paused) bus.emit('focusmode:change', { on: true });
  };
  // without 3D a link to a house (#/house/<id>, a reload) opens it on the town board all the same
  const openDeepLink = async () => {
    if (deepLink && store.project(deepLink.projectId)) await doEnter(deepLink.projectId, { instant: true });
    else if (deepLink) setHash('');
  };

  // switching to 3D from the board builds the town (a board start); after the town's code failed to arrive it
  // reloads the page into 3D instead: this page would only get the same failure back, without asking the network
  threeD.setLoader(() => {
    if (codeFailed) return location.replace(location.pathname + searchWithoutBoard(location.search) + location.hash);
    void build3D().then((ok) => {
      if (ok) navigate(adopt3D);
      else toBoard();
    });
  });
  const canGL = webglAvailable();
  if (boardStart || !canGL) {
    threeD.set(canGL ? 'idle' : 'unavailable');
    boot.phase('Opening the town board…', 0.5, 1);
    toBoard();
    await snapshotArrived(deepLink ? 6000 : 4000);
    await openDeepLink();
    await bootDone();
    return;
  }

  // ───────── 3D start: the 2D shell now, the town when it is built (finding #70) ─────────
  // The top bar, chat, panels and the Town board are up already (createUI above, all in the first chunk) and talk to
  // the server over the socket; the renderer and the town build in the background (build3D: the city only — a
  // house's furniture and residents load on the way to its door). The splash waits for the town only while that is
  // quick: once the first snapshot is in and STAND_IN_MS have passed since the page started, it lifts onto the board,
  // which shows how far the town is, and the town takes over when it is ready — unless the board was picked
  // meanwhile (threeD.wanted, ui/index.ts).
  threeD.want(true);
  boot.phase('Starting the renderer…', 0, 0.12);
  const built = build3D();
  boot.phase('Building the town…', 0.12, deepLink ? 0.6 : 0.8, ['city']);
  const shellUp = snapshotArrived(deepLink ? 6000 : 4000).then(() => sleep(STAND_IN_MS - performance.now()));
  const first = await Promise.race([built.then(() => 'town' as const), shellUp.then(() => 'board' as const)]);
  if (first === 'board') {
    toBoard();
    await openDeepLink();
    void bootDone({ quick: true }); // at once: the town's build may hold the main thread any moment now
    // built: adopt3D says 'ready' and the UI switches if still wanted; failed: build3D said 'unavailable' and the UI
    // keeps the board (with a word if 3D was still wanted)
    // (two frames first: the board and the 3D label paint "getting the graphics ready" before the town's first frame
    // holds the main thread compiling shaders)
    void built.then(async (ok) => ok && (await nextFrame(), await nextFrame(), navigate(adopt3D)));
    return;
  }
  threeD.want(false); // the town is here before anyone could pick a view: nothing to switch
  if (!(await built) || !city) {
    if (!engine.attached) {
      // no WebGL after all (the board says 3D isn't available here), or the town's code didn't arrive (3D stays on
      // offer, and a toast said why): straight to the board
      boot.phase('Opening the town board…', 0.5, 1);
      await snapshotArrived(deepLink ? 6000 : 4000);
      toBoard();
      await openDeepLink();
      void bootDone();
      return;
    }
    boot.fail('The 3D town could not be built on this device. You can still use everything from the town board.', {
      reload: () => location.reload(),
      continue2d: () => {
        toBoard();
        void openDeepLink().finally(() => void bootDone());
      },
    });
    return;
  }
  // (assigned inside build3D: TypeScript can't see that here)
  const c = city as CityView;
  // the first frames compile the town's shaders (seconds on a weak GPU): an honest last step, not a stuck 94 %
  boot.phase('Preparing graphics…', deepLink ? 0.6 : 0.8, deepLink ? 0.6 : 0.8, []);
  // paint the bar's "still working" sheen (frame 1 paints it, frame 2 goes on) before the first town frame holds
  // the main thread compiling shaders
  await nextFrame();
  await nextFrame();
  c.activate();
  drawn = true;
  syncCity();
  threeD.set('ready');

  const haveSnapshot = await snapshotArrived(deepLink ? 6000 : 1500);
  if (haveSnapshot) syncCity();
  if (deepLink && store.project(deepLink.projectId)) {
    boot.phase('Opening the house…', 0.6, 0.85, ['house']);
    // the city camera stands where the house would be left, then enter without the swoop; Back lands in the town
    nav.seedTown();
    await doEnter(deepLink.projectId, { instant: true });
  } else if (deepLink) setHash('');

  // the avatar by the parked car: its code and body load once the town is on show
  const meetAvatar = () => {
    if (view === 'city') void loadInterior().then(() => player?.cityReady());
  };
  // two rendered frames so the reveal never shows an empty canvas (the first one compiles what is left to compile)
  await nextFrame();
  boot.phase('Preparing graphics…', 0.92, 0.92, []);
  await nextFrame();
  townShown();
  const reveal = bootDone();
  meetAvatar();
  await reveal;
}

/**
 * When the side panel is open on a wide screen, slide the projection centre left (and pull back a little) so
 * whatever the camera frames — the house, a building after fly-to — sits in the middle of the area the panel
 * leaves free. On a phone the panel is a bottom sheet: slide the centre up into the strip above it instead.
 * Picking and CSS2D labels follow automatically because both read the camera's projection matrix.
 */
function installPanelOffset(engine: Engine, cameras: THREE.PerspectiveCamera[]) {
  const root = document.querySelector<HTMLElement>('.rlt-ui');
  if (!root) return;
  let target = 0; // px of screen width covered by the panel (+ gap)
  let targetY = 0; // px of screen height covered by the bottom sheet
  let targetTop = 0; // px of screen height under the top bar (only counted with the sheet up)
  let now = 0;
  let nowY = 0;
  let nowTop = 0;
  const read = () => {
    const panel = root.querySelector<HTMLElement>('.sidepanel');
    const wide = !isSheetLayout(); // a docked panel (desktop, tablet, a phone held sideways), not the bottom sheet
    const open = !!panel && root.classList.contains('has-panel') && !root.classList.contains('is-focus');
    target = wide && open ? panel!.offsetWidth + 12 : 0;
    // phone with the sheet up: the floor switcher stands in the strip's right edge, keep the house clear of it
    const fs = root.querySelector<HTMLElement>('.floor-switch');
    if (!wide && open && !panel!.classList.contains('is-expanded') && fs && !fs.hidden) target = fs.offsetWidth + 8;
    // an expanded sheet covers nearly everything: nothing sensible to frame above it. The top bar's height
    // counts too — the strip left for the house runs from under it to the sheet.
    const topbar = root.querySelector<HTMLElement>('.topbar');
    const top = topbar ? topbar.getBoundingClientRect().bottom : 0;
    targetY = !wide && open && !panel!.classList.contains('is-expanded') ? Math.min(panel!.offsetHeight, innerHeight * 0.7) : 0;
    targetTop = targetY ? Math.min(top, 80) : 0;
  };
  const mo = new MutationObserver(read);
  mo.observe(root, { attributes: true, attributeFilter: ['class'] });
  const sheet = root.querySelector<HTMLElement>('.sidepanel');
  if (sheet) mo.observe(sheet, { attributes: true, attributeFilter: ['class'] }); // phone: expanded or not
  if (sheet) new ResizeObserver(read).observe(sheet); // desktop: its width dragged (panel-resize.ts), or larger text
  addEventListener('resize', read);
  read();
  const key = new Map<THREE.PerspectiveCamera, string>();
  const ease = (from: number, to: number, dt: number) => {
    const v = from + (to - from) * (1 - Math.exp(-dt * 9));
    return Math.abs(to - v) < 0.5 ? to : v;
  };
  engine.onFrame((dt) => {
    if (now !== target) now = ease(now, target, dt);
    if (nowY !== targetY) nowY = ease(nowY, targetY, dt);
    if (nowTop !== targetTop) nowTop = ease(nowTop, targetTop, dt);
    const w = engine.canvas.clientWidth || innerWidth;
    const h = engine.canvas.clientHeight || innerHeight;
    for (const cam of cameras) {
      if (now < 0.5 && nowY < 0.5) {
        if (cam.view?.enabled) cam.clearViewOffset();
        key.delete(cam);
        continue;
      }
      const k = `${now.toFixed(2)}|${nowY.toFixed(2)}|${nowTop.toFixed(2)}|${w}|${h}`;
      if (cam.view?.enabled && key.get(cam) === k) continue;
      key.set(cam, k);
      // zoom out so the framing roughly fits the free area (a portrait phone's framing is width-bound, so the
      // sheet needs less of it)
      const top = nowTop;
      const zoom = 1 + 0.75 * (now / w) + 0.4 * ((nowY + top) / h);
      // full-image centre (w/2, h/2) lands at the centre of the free area ((w - now) / 2, (top + h - nowY) / 2)
      const ox = w / 2 - (zoom * (w - now)) / 2;
      const oy = h / 2 - (zoom * (top + h - nowY)) / 2;
      cam.setViewOffset(w, h, ox, oy, w * zoom, h * zoom);
    }
  });
}

main().catch((e) => {
  console.error('[main] boot failed', e);
  boot.fail(String((e as Error)?.message ?? e), { reload: () => location.reload(), continue2d: () => void boot.done() });
});
