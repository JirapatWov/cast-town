// Installing CAST on this device (Settings → Pair a phone → "Install CAST on this device"): which platform the page
// runs on, and what to do there. Pure (tests/web/install-text.test.ts) apart from installPrompt(), which keeps
// Chrome's beforeinstallprompt for the Install button.
//
// iPhone and iPad: Share → Add to Home Screen. That app has its own cookies (pairing in Safari does not carry over)
// and no address bar, so it pairs on its own private page: paste a link copied here, or type the short code.
// Chrome / Edge (desktop, Android): their Install shares the browser's cookies — already paired. Mac Safari: File →
// Add to Dock copies the cookies once, so it is paired too.

export type Platform = 'ios-safari' | 'ios-standalone' | 'android-chrome' | 'desktop-chrome' | 'desktop-safari' | 'installed' | 'other';

export function platformOf(ua: string, o: { standalone: boolean; touchPoints?: number }): Platform {
  // iPadOS Safari says "Macintosh"; only touch tells it apart
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && (o.touchPoints ?? 0) > 1);
  if (o.standalone) return ios ? 'ios-standalone' : 'installed';
  if (ios) return 'ios-safari';
  if (/Android/.test(ua)) return /Chrome\/|EdgA\/|SamsungBrowser\//.test(ua) ? 'android-chrome' : 'other';
  if (/Edg\/|Chrome\//.test(ua) && !/Mobile/.test(ua)) return 'desktop-chrome';
  if (/Macintosh/.test(ua) && /Version\/[\d.]+.*Safari\//.test(ua)) return 'desktop-safari';
  return 'other';
}

export interface InstallHelp {
  steps: string[];
  /** copy-app-link: a one-time link for the Home Screen app, copied in the same tap; install: Chrome's prompt. */
  button?: 'copy-app-link' | 'install';
  /** CAST already runs installed here. */
  done?: boolean;
}

export function installHelp(p: Platform, canPrompt: boolean): InstallHelp {
  switch (p) {
    case 'ios-safari':
      return {
        steps: [
          'Tap Share (□↑) → Add to Home Screen. Keep “Open as Web App” on.',
          'Open CAST from your Home Screen.',
          'It asks to be paired: tap the field → Paste → Pair this device.',
        ],
        button: 'copy-app-link',
      };
    case 'ios-standalone':
    case 'installed':
      return { steps: ['CAST is installed on this device ✓'], done: true };
    case 'android-chrome':
    case 'desktop-chrome':
      return canPrompt
        ? { steps: ['Install CAST as an app: it opens in its own window and stays signed in (it shares this browser’s sign-in).'], button: 'install' }
        : { steps: [p === 'android-chrome' ? 'In Chrome’s ⋮ menu, choose Add to Home screen → Install.' : 'In the address bar, click the Install icon (or ⋮ → Cast, save and share → Install page as app). It keeps this sign-in.'] };
    case 'desktop-safari':
      return { steps: ['File → Add to Dock. The Dock app keeps this sign-in.'] };
    default:
      return { steps: ['This browser can’t install CAST as an app. Chrome, Edge and Safari can.'] };
  }
}

/** XXXX-XXXX-XXXX, the way the code is shown and read out. */
export function formatShortCode(raw: string): string {
  const s = raw.toUpperCase().replace(/[\s-]+/g, '');
  return s.length === 12 ? `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}` : s;
}

/** Display mode of this page: in the installed app (Home Screen, Dock, Chrome's app window). */
export function isStandalone(): boolean {
  try {
    return matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: window-controls-overlay)').matches || (navigator as { standalone?: boolean }).standalone === true;
  } catch {
    return false;
  }
}

/** This device's platform. */
export function currentPlatform(): Platform {
  return platformOf(navigator.userAgent, { standalone: isStandalone(), touchPoints: navigator.maxTouchPoints });
}

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();

/** Keep Chrome's install prompt for the Install button (call once, early). */
export function captureInstallPrompt(): void {
  if (typeof addEventListener !== 'function') return;
  addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // no mini-infobar: Settings offers it
    deferred = e as BeforeInstallPromptEvent;
    for (const fn of [...listeners]) fn();
  });
  addEventListener('appinstalled', () => {
    deferred = null;
    for (const fn of [...listeners]) fn();
  });
}

export const canPromptInstall = () => deferred !== null;
export function onInstallPrompt(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Show Chrome's install dialog; true when the person installed. */
export async function promptInstall(): Promise<boolean> {
  const e = deferred;
  if (!e) return false;
  deferred = null;
  await e.prompt();
  return (await e.userChoice).outcome === 'accepted';
}
