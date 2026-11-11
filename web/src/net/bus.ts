// Tiny typed event bus shared by the 3D views, the UI and main.
import type { Bus, BusEvents } from '../core/types';

type Handler = (payload: never) => void;

export function createBus(): Bus {
  const handlers = new Map<keyof BusEvents, Set<Handler>>();

  return {
    on(k, fn) {
      let set = handlers.get(k);
      if (!set) handlers.set(k, (set = new Set()));
      set.add(fn as Handler);
      return () => {
        set.delete(fn as Handler);
      };
    },
    emit(k, payload) {
      const set = handlers.get(k);
      if (!set) return;
      // Copy so handlers may unsubscribe while we iterate.
      for (const fn of [...set]) {
        try {
          (fn as (p: typeof payload) => void)(payload);
        } catch (err) {
          console.error(`[bus] handler for "${String(k)}" threw`, err);
        }
      }
    },
  };
}
