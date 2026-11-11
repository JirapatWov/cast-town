// The house view, its residents and the homeowner avatar: one chunk that main.ts imports lazily (finding #70). It is
// about a third of the app's code and the town needs none of it to appear; its furniture and residents load later
// still, when someone heads for a door (house.init(), finding #21).
import type { AppContext, CityView } from './core/types';
import { createHouseView } from './house';
import { createPlayer } from './player';

export function createInterior(ctx: AppContext, city: CityView) {
  const house = createHouseView(ctx);
  const player = createPlayer({ engine: ctx.engine, bus: ctx.bus, store: ctx.store, house, city });
  return { house, player };
}

export type Interior = ReturnType<typeof createInterior>;
