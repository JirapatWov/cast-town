// The Engine everyone holds (UI, views, main) while the real one may not exist yet. A board start (see
// ui/view-mode.ts) runs on a flat stand-in and builds the WebGL engine only when someone switches to 3D: the slot
// forwards every call to whichever engine it holds, and moves frame callbacks over when the real one arrives.
import type { Engine } from './core/types';

export interface EngineSlot extends Engine {
  /** The real engine from now on (once). */
  attach(real: Engine): void;
  readonly attached: boolean;
}

export function createEngineSlot(initial: Engine): EngineSlot {
  let cur = initial;
  let attached = false;
  // Frame callbacks registered before attach (the drive watchdog, the panel offset) must keep running after it.
  const frames = new Map<object, { fn: (dt: number, elapsed: number) => void; off: () => void }>();

  return {
    get renderer() {
      return cur.renderer;
    },
    get canvas() {
      return cur.canvas;
    },
    get assets() {
      return cur.assets;
    },
    get quality() {
      return cur.quality;
    },
    get labelLayer() {
      return cur.labelLayer;
    },
    get timeOfDay() {
      return cur.timeOfDay;
    },
    get attached() {
      return attached;
    },
    setView: (scene, camera, preset) => cur.setView(scene, camera, preset),
    setQuality: (q) => cur.setQuality(q),
    pick: (ev, camera, objects) => cur.pick(ev, camera, objects),
    fade: (toBlack, ms) => cur.fade(toBlack, ms),
    setPaused: (p) => cur.setPaused(p),
    // optional on the flat engine (no time of day): absent there, so the UI hides the time-of-day menu
    setTimeOfDay: (mode) => cur.setTimeOfDay?.(mode),
    onTimeOfDay: (fn) => cur.onTimeOfDay?.(fn) ?? (() => {}),
    onFrame(fn) {
      const key = {};
      frames.set(key, { fn, off: cur.onFrame(fn) });
      return () => {
        frames.get(key)?.off();
        frames.delete(key);
      };
    },
    attach(real) {
      if (attached) return;
      attached = true;
      cur = real;
      for (const entry of frames.values()) {
        entry.off();
        entry.off = real.onFrame(entry.fn);
      }
    },
  };
}
