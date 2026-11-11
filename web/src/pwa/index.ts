// CAST as an installed app (a PWA), from the page's side — one call from the UI (web/src/ui/index.ts):
//   register.ts  the service worker (home only, once idle; ?sw=off and the server's switch remove it)
//   badge.ts     the app icon's badge = answers owed (waitingCount)
//   push.ts      Web Push for this device (Settings → Notifications & app, ui/settings-notify.ts)
//   launch.ts    manifest shortcuts, Chrome's launch queue, notification taps
//   install.ts   how to install here (Settings → Pair a phone)
import type { Store } from '../core/types';
import { CITY_ID } from '../net/base';
import { loadSession } from '../net/session';
import '../ui/settings-notify';
import type { SettingsSection } from '../ui/settings';
import type { Shell } from '../ui/shell';
import { waitingCount } from '../ui/plans';
import { syncAppBadge } from './badge';
import { captureInstallPrompt } from './install';
import { installLaunch } from './launch';
import { resyncPush, serverPush, startPresence } from './push';
import { registerServiceWorker } from './register';

export interface PwaDeps {
  store: Store;
  toast: Shell['toast'];
  openInbox(): void;
  openSettings(section?: SettingsSection): void;
}

let installed = false;

export function installPwa(d: PwaDeps): void {
  if (installed) return;
  installed = true;
  captureInstallPrompt();
  installLaunch({ openInbox: d.openInbox, openSettings: d.openSettings });
  if (CITY_ID !== null) return; // a city through a hub: its server's app, not this one's

  syncAppBadge(waitingCount(d.store.state));
  d.store.subscribe((s) => syncAppBadge(waitingCount(s)));

  registerServiceWorker({
    session: () => loadSession(),
    onReconnect(fn) {
      let was = d.store.state.connected;
      d.store.subscribe((s) => {
        if (s.connected === was) return;
        was = s.connected;
        if (s.connected) fn();
      });
    },
    updated: () => d.toast('info', 'CAST was updated.', { action: { label: 'Reload', run: () => location.reload() }, ttl: 120_000 }),
  });

  void loadSession().then(async (s) => {
    if (s?.pwa?.push === false || !s?.pwa) return; // off, or a server without push
    const server = await serverPush().catch(() => null);
    if (server?.watching) startPresence();
    await resyncPush();
  });
}
