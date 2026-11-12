// Before the first snapshot (ClientState.synced) the page knows nothing about the town: an empty list of houses then
// means "not here yet", never "you have none". Coming back to CAST after a long while (a phone's installed app, a tab
// left for hours) the socket may take seconds to connect and deliver it, and the page used to show "Place your first
// project" meanwhile. One reading for every place that lists the houses — the Board, the 3D town's keyboard list and
// banner, the Fly to and terminal menus, the Inbox, the placement dialog's free lots — and the welcome waits for it.
// Pure, for tests.
import { APP_NAME } from '../../../shared/brand';
import type { Lot } from '../../../shared/protocol';
import type { ClientState, Store } from '../core/types';

type Known = Pick<ClientState, 'connected' | 'synced'>;

export const LOADING_HOUSES = 'Loading your projects…';
export const NO_HOUSES = 'No projects yet';
export const CONNECTING = `Connecting to the ${APP_NAME} server…`;

/** What stands in for the houses while they are on their way (with why, in a second line); null once they are known. */
export function housesLoading(s: Known): { title: string; detail: string } | null {
  if (s.synced) return null;
  return { title: LOADING_HOUSES, detail: s.connected ? 'They show up here in a moment.' : CONNECTING };
}

/** The one disabled line of a houses menu without a house in it: still loading, or really none. */
export function noHousesItem(s: Known): { label: string; disabled: true; onSelect(): void } {
  return { label: s.synced ? NO_HOUSES : LOADING_HOUSES, disabled: true, onSelect: () => {} };
}

/** The lots a new house can go on; null while the town is still on its way (its lots and houses aren't known). */
export function freeLots(s: Pick<ClientState, 'synced' | 'city'>): Lot[] | null {
  if (!s.synced) return null;
  const taken = new Set(s.city.projects.map((p) => p.lotId));
  return s.city.lots.filter((l) => !taken.has(l.id));
}

/** Run `fn` once the first snapshot is in (at once, if it is). Returns what cancels the wait. */
export function whenSynced(store: Pick<Store, 'state' | 'subscribe'>, fn: () => void): () => void {
  if (store.state.synced) {
    fn();
    return () => {};
  }
  const off = store.subscribe((s) => {
    if (!s.synced) return;
    off();
    fn();
  });
  return off;
}
