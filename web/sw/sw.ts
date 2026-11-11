// CAST's service worker (/sw.js, scope /). Built on its own as one classic script (web/vite.config.ts, an IIFE: no
// import or export), served by server/pwa.ts (no-cache; CAST_SERVICE_WORKER=off swaps in a self-removing worker).
// The rules are in policy.ts. In short:
//  • page loads go to the network, always; only when it can't be reached does the offline page stand in;
//  • hashed code chunks (immutable) are kept, so a page of an older build can still load its lazy parts;
//  • nothing else is touched: the API, WebSockets, pairing links, uploads, files, cities' own files;
//  • push → a notification, every time (and the app badge); a tap opens CAST where it points.
// A new build's worker takes over at once (skipWaiting + claim): it serves no page, so there is no old shell to keep.
import {
  ASSET_CACHE, CACHE_PREFIX, MAX_ASSETS, NAV_TIMEOUT_MS, offlineHtml, payloadToNotification, route, sameOriginPath, swapsForOffline,
} from './policy';

declare const self: ServiceWorkerGlobalScope;
declare const __CAST_BUILD__: string;
const BUILD = __CAST_BUILD__;
const ORIGIN = self.location.origin;

type BadgeNav = WorkerNavigator & { setAppBadge?(n?: number): Promise<void>; clearAppBadge?(): Promise<void> };

async function trim(): Promise<void> {
  const cache = await caches.open(ASSET_CACHE);
  const keys = await cache.keys();
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ASSETS))) await cache.delete(k);
}

self.addEventListener('install', (e) => {
  e.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      for (const k of await caches.keys()) if (k.startsWith(CACHE_PREFIX) && k !== ASSET_CACHE) await caches.delete(k);
      await trim().catch(() => {});
      await self.clients.claim();
      for (const c of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) c.postMessage({ t: 'cast-sw', build: BUILD });
    })(),
  );
});

self.addEventListener('message', (e) => {
  const m = e.data as { t?: unknown } | null;
  if (m?.t === 'cast-sw?') (e.source as Client | null)?.postMessage({ t: 'cast-sw', build: BUILD });
});

function offline(): Response {
  return new Response(offlineHtml(), { status: 503, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

async function page(req: Request, timed: boolean): Promise<Response> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const net = fetch(req);
    const res = timed
      ? await Promise.race([net, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('timeout')), NAV_TIMEOUT_MS)))])
      : await net;
    // a city's own pages and errors come from its hub: only a dead network stands in for them
    if (timed && swapsForOffline(res.status, res.headers.has('x-content-type-options'))) return offline();
    return res;
  } catch {
    return offline();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function asset(e: FetchEvent): Promise<Response> {
  const cache = await caches.open(ASSET_CACHE);
  const hit = await cache.match(e.request, { ignoreVary: true });
  if (hit) return hit;
  const res = await fetch(e.request);
  if (res.ok && res.type === 'basic' && /immutable/.test(res.headers.get('cache-control') ?? '')) {
    e.waitUntil(cache.put(e.request, res.clone()).then(trim).catch(() => {}));
  }
  return res;
}

self.addEventListener('fetch', (e) => {
  const r = route({ method: e.request.method, url: e.request.url, mode: e.request.mode }, ORIGIN);
  if (r === 'pass') return; // the network, untouched
  if (r === 'asset') return e.respondWith(asset(e));
  e.respondWith(page(e.request, r === 'navigate'));
});

self.addEventListener('push', (e) => {
  let data: unknown = null;
  try {
    data = e.data ? e.data.json() : null;
  } catch {
    data = null;
  }
  const n = payloadToNotification(data, ORIGIN);
  e.waitUntil(
    (async () => {
      // always a notification: Safari ends subscriptions whose pushes show nothing
      await self.registration.showNotification(n.title, n.options as NotificationOptions);
      const nav = self.navigator as BadgeNav;
      const b = n.options.data.badge;
      try {
        if (b !== undefined && typeof nav.setAppBadge === 'function') await (b > 0 ? nav.setAppBadge(b) : nav.clearAppBadge?.());
      } catch {
        /* no badge permission */
      }
    })(),
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const next = sameOriginPath((e.notification.data as { next?: unknown } | null)?.next, ORIGIN);
  e.waitUntil(
    (async () => {
      const all = (await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) as WindowClient[];
      // the home city's page routes it (a city page belongs to another server)
      const home = all.find((c) => !new URL(c.url).pathname.startsWith('/city/'));
      if (home) {
        await home.focus().catch(() => home);
        home.postMessage({ t: 'cast-open', next });
        return;
      }
      await self.clients.openWindow(new URL(next, ORIGIN).href);
    })(),
  );
});

interface SubscriptionChangeEvent extends ExtendableEvent {
  oldSubscription: PushSubscription | null;
  newSubscription: PushSubscription | null;
}

self.addEventListener('pushsubscriptionchange', ((e: SubscriptionChangeEvent) => {
  e.waitUntil(
    (async () => {
      let sub = e.newSubscription;
      if (!sub) {
        let key = e.oldSubscription?.options.applicationServerKey ?? null;
        if (!key) {
          const r = await fetch('/api/push', { credentials: 'same-origin', headers: { accept: 'application/json' } });
          const j = (await r.json()) as { publicKey?: string };
          if (!j.publicKey) return;
          const s = atob(j.publicKey.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (j.publicKey.length % 4)) % 4));
          const bytes = new Uint8Array(new ArrayBuffer(s.length));
          for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
          key = bytes.buffer;
        }
        sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      }
      const j = sub.toJSON();
      await fetch('/api/push/subscription', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: j.endpoint, keys: j.keys }),
      });
    })().catch(() => {}),
  );
}) as EventListener);
