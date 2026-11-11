// Where an app launch or a notification takes the person: the manifest's shortcuts (`/?panel=inbox`,
// `/?settings=…`), Chrome's launch queue (launch_handler focus-existing: an open CAST window gets the new URL), and
// the service worker's {t:'cast-open', next} after a notification was tapped while CAST was open.
import type { SettingsSection } from '../ui/settings';
import { searchWithout, settingsFromSearch } from '../ui/settings-link';

export type PanelLink = 'inbox';

/** The address this page was opened with, before `?panel=` / `?settings=` are taken out of it (this module loads with
 *  the app, ahead of that): Chrome's first launch params name it, and they were handled at load already. */
const LOADED_URL = typeof location === 'undefined' ? '' : location.href;

/** The panel `?panel=` asks for; null when there is none (or an unknown one). */
export function panelFromSearch(search: string): PanelLink | null {
  const v = new URLSearchParams(search).get('panel');
  return v?.trim().toLowerCase() === 'inbox' ? 'inbox' : null;
}

/** Read and remove `?panel=` from this page's address (a reload must not open it again). */
export function takePanelLink(loc: Pick<Location, 'search' | 'pathname' | 'hash'> = location, hist: Pick<History, 'replaceState' | 'state'> = history): PanelLink | null {
  const asked = panelFromSearch(loc.search);
  if (!asked) return null;
  try {
    hist.replaceState(hist.state, '', `${loc.pathname}${searchWithout(loc.search, 'panel')}${loc.hash}`);
  } catch {
    /* the panel still opens */
  }
  return asked;
}

export interface LaunchTargets {
  openInbox(): void;
  openSettings(section?: SettingsSection): void;
}

/** Go to a same-origin URL inside the open app: the Inbox, a Settings section, a house; another path loads it. */
export function routeTo(raw: string, t: LaunchTargets): void {
  let u: URL;
  try {
    u = new URL(raw, location.origin);
  } catch {
    return;
  }
  if (u.origin !== location.origin) return;
  if (u.pathname !== location.pathname) {
    location.assign(u.href);
    return;
  }
  if (panelFromSearch(u.search)) t.openInbox();
  const settings = settingsFromSearch(u.search);
  if (settings !== null) t.openSettings(settings || undefined);
  if (u.hash.startsWith('#/house/') && u.hash !== location.hash) location.hash = u.hash;
}

interface LaunchParams {
  targetURL?: string;
}
type LaunchQueue = { setConsumer(fn: (p: LaunchParams) => void): void };

/** Follow shortcuts, launches and notification taps for the life of the page. */
export function installLaunch(t: LaunchTargets): void {
  if (takePanelLink()) t.openInbox();
  const q = (window as { launchQueue?: LaunchQueue }).launchQueue;
  let first = true;
  q?.setConsumer((p) => {
    // the first launch is this page's own load (already handled above and by ?settings=)
    if (first) {
      first = false;
      if (p.targetURL === LOADED_URL || p.targetURL === location.href) return;
    }
    if (p.targetURL) routeTo(p.targetURL, t);
  });
  navigator.serviceWorker?.addEventListener('message', (e: MessageEvent) => {
    const m = e.data as { t?: unknown; next?: unknown } | null;
    if (m?.t === 'cast-open' && typeof m.next === 'string') routeTo(m.next, t);
  });
}
