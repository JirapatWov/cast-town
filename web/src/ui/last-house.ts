// The house the user last worked in, remembered per city (storage): where the Town board's side panel opens while no
// house is in view, and what "this house" means then for the palette, the keyboard and the panel. Before, all of those
// fell back to the first house in the list, whichever it was.
import { storage } from './dom';

const KEY = 'rlt.house.last';

/** Entering a house, or opening its panel on purpose, makes it the last house used. */
export function rememberHouse(projectId: string | null | undefined): void {
  if (projectId) storage.set(KEY, projectId);
}

/** The last house used, if it still stands in the town. */
export function lastHouse(projectIds: readonly string[], last: string | null | undefined = storage.get(KEY)): string | null {
  return last && projectIds.includes(last) ? last : null;
}

/** Where the board's side panel opens at the town level: the last house used, else the only house. null (several
 *  houses, none used yet on this device) → the town's Inbox, rather than an arbitrary first house's people. */
export function townPanelHouse(projectIds: readonly string[], last?: string | null): string | null {
  return lastHouse(projectIds, last) ?? (projectIds.length === 1 ? projectIds[0]! : null);
}

/** Which Inbox the bell (and "Open inbox", "N more waiting") opens: inside a house that house's (undefined: the panel
 *  keeps its house), at the town level the town's (null), like the count on the bell. */
export function inboxScope(view: { view: string }): null | undefined {
  return view.view === 'house' ? undefined : null;
}
