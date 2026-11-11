// Registering CAST's service worker (/sw.js, web/sw/sw.ts) — on the home city only, once the page is up and idle,
// never in dev — and the ways out: the server's switch (CAST_SERVICE_WORKER=off → /api/session pwa.sw false),
// `?sw=off` on any address, and Settings → Notifications & app → "Reset the app's cache" (the Home Screen app has
// no address bar). A new build takes over by itself (the worker never serves a page); an open page is told
// "CAST was updated — Reload".
import { CITY_ID } from '../net/base';
import { searchWithout } from '../ui/settings-link';

declare const __CAST_BUILD__: string | undefined;
/** This page's build (vite.config.ts); the worker reports its own. */
export const BUILD: string = typeof __CAST_BUILD__ === 'string' ? __CAST_BUILD__ : 'dev';
const CACHE_PREFIX = 'cast-';
const UPDATE_EVERY_MS = 60 * 60 * 1000;

export interface RegisterDeps {
  /** /api/session's pwa facts (null: unknown). */
  session(): Promise<{ pwa?: { sw?: boolean } } | null>;
  /** The live connection came back (a server restart, often a deploy). */
  onReconnect(fn: () => void): void;
  /** "CAST was updated" with a Reload button. */
  updated(): void;
}

/** Workers are possible here: a secure context (https, or this machine's loopback address) on the home city. */
export function swPossible(): boolean {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator && isSecureContext && CITY_ID === null && !import.meta.env?.DEV;
}

/** Remove every worker of this origin and CAST's caches. The page keeps working (it never needed them). */
export async function resetAppCache(): Promise<void> {
  try {
    const regs = (await navigator.serviceWorker?.getRegistrations?.()) ?? [];
    await Promise.all(regs.map((r) => r.unregister().catch(() => false)));
  } catch {
    /* no workers */
  }
  try {
    if (typeof caches !== 'undefined') for (const k of await caches.keys()) if (k.startsWith(CACHE_PREFIX)) await caches.delete(k);
  } catch {
    /* no caches */
  }
}

/** `?sw=off`: remove the worker, and the parameter from the address. */
function takeSwOff(): boolean {
  const q = new URLSearchParams(location.search);
  if (q.get('sw') !== 'off') return false;
  try {
    history.replaceState(history.state, '', `${location.pathname}${searchWithout(location.search, 'sw')}${location.hash}`);
  } catch {
    /* keeps the parameter */
  }
  return true;
}

/** After the page has loaded and the browser is idle (Safari has no requestIdleCallback): never during the 3D boot. */
function whenIdle(fn: () => void): void {
  const idle = () => {
    const ric = (window as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    if (ric) ric(fn, { timeout: 10_000 });
    else setTimeout(fn, 3000);
  };
  if (document.readyState === 'complete') idle();
  else addEventListener('load', idle, { once: true });
}

let registration: Promise<ServiceWorkerRegistration | null> | null = null;

/** The worker's registration once it is registered (null when there is none here). */
export function swRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!swPossible()) return Promise.resolve(null);
  return registration ?? navigator.serviceWorker.getRegistration('/').then((r) => r ?? null, () => null);
}

export function registerServiceWorker(deps: RegisterDeps): void {
  if (!swPossible()) return;
  if (takeSwOff()) {
    void resetAppCache();
    return;
  }
  let told = false;
  const updated = () => {
    if (told) return;
    told = true;
    deps.updated();
  };
  // the worker says which build it is when it takes over; a different one than this page's → this page is old
  navigator.serviceWorker.addEventListener('message', (e: MessageEvent) => {
    const m = e.data as { t?: unknown; build?: unknown } | null;
    if (m?.t === 'cast-sw' && typeof m.build === 'string' && m.build !== BUILD) updated();
  });
  // a lazy chunk of this (old) build is gone from the server: the same advice
  addEventListener('vite:preloadError', updated);

  registration = new Promise((resolve) => {
    whenIdle(() => {
      void (async () => {
        const s = await deps.session().catch(() => null);
        if (s?.pwa?.sw === false) {
          await resetAppCache();
          return resolve(null);
        }
        try {
          const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
          resolve(reg);
          let checked = Date.now();
          const check = () => {
            checked = Date.now();
            void reg.update().catch(() => {});
          };
          deps.onReconnect(check);
          document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible' && Date.now() - checked > UPDATE_EVERY_MS) check();
          });
        } catch {
          resolve(null); // an old browser, a private window: CAST works without it
        }
      })();
    });
  });
}
