// The app icon's badge (Home Screen on iOS 16.4+ with notifications allowed; installed Chrome/Edge on Windows, macOS,
// ChromeOS; Safari Dock apps): the number of answers the user owes — approval and question cards plus plan cards,
// the same count as the page title and the Mac menu bar (waitingCount). Home only: a city page leaves it alone (its
// counts are another server's). The service worker sets it from each push too.
import { CITY_ID } from '../net/base';

type BadgeNav = { setAppBadge?(n?: number): Promise<void>; clearAppBadge?(): Promise<void> };

let last = -1;

export function syncAppBadge(n: number, nav: BadgeNav = navigator as BadgeNav, cityId: string | null = CITY_ID): void {
  if (cityId !== null || typeof nav.setAppBadge !== 'function') return;
  const v = Math.max(0, Math.floor(n));
  if (v === last) return;
  last = v;
  try {
    const p = v > 0 ? nav.setAppBadge(v) : nav.clearAppBadge?.();
    void p?.catch(() => {});
  } catch {
    /* not allowed here */
  }
}

/** Tests: forget the last value. */
export function resetBadgeMemo(): void {
  last = -1;
}
