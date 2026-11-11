// CAST as an installed app (a PWA): the few release files a browser needs before it is paired, and the service
// worker's own rules.
//
// Public before sign-in (PUBLIC_PWA_PATHS): the service worker script, the manifest, the icons and the iOS launch images
// (shared/launch-images.ts). "Add to Home Screen" from the private page (the 403) then makes a real CAST app — its name,
// its icon, its launch screen, start_url "/" — instead of a screenshot bookmark, and a device's worker can update itself
// whatever its sign-in says. These are the same files every CAST release ships; /api/version and the 403 page already
// say a CAST server is here. Keep the list exact: no other web/dist file is served before auth.
//
// /sw.js (web/sw/sw.ts, built by web/vite.config.ts) is served no-cache with nosniff and never with
// Service-Worker-Allowed (its scope is / = the script's own folder). The kill switch CAST_SERVICE_WORKER=off serves
// SW_RESET_SCRIPT instead: a worker that empties CAST's caches and unregisters itself. It answers 200 — a 404 would
// leave the old worker in place — and never reloads a page (no reload loops). A dist without sw.js (an older build)
// gets the same reset script, for the same reason.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { launchImagePaths } from '../shared/launch-images';

export const SW_PATH = '/sw.js';

export const PUBLIC_PWA_PATHS: ReadonlySet<string> = new Set([
  SW_PATH,
  '/manifest.webmanifest',
  '/apple-touch-icon.png',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
  '/favicon.svg',
  '/favicon-32.png',
  ...launchImagePaths(), // iOS reads them when the app is added, from the 403 page too (server/pages.ts)
]);

/** Prefix of every cache CAST's worker makes (web/sw/policy.ts CACHE_PREFIX). */
export const CACHE_PREFIX = 'cast-';

/** The worker the kill switch serves: it removes itself and CAST's caches, and touches no page. */
export const SW_RESET_SCRIPT = `// CAST: the service worker is switched off on this server (CAST_SERVICE_WORKER=off). This one removes itself.
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf('${CACHE_PREFIX}') === 0; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.registration.unregister(); }));
});
`;

const SW_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'text/javascript; charset=utf-8',
  'cache-control': 'no-cache',
  'x-content-type-options': 'nosniff',
};

export interface PwaOptions {
  distDir: string;
  /** false: serve SW_RESET_SCRIPT (CAST_SERVICE_WORKER=off). */
  serviceWorker: boolean;
}

/** The answer for a public install file, before auth; null for every other path. */
export function pwaPublic(req: Request, url: URL, serveStatic: (req: Request, url: URL) => Promise<Response>, o: PwaOptions): Promise<Response> | null {
  if (!PUBLIC_PWA_PATHS.has(url.pathname)) return null;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return Promise.resolve(new Response('Method not allowed\n', { status: 405, headers: { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' } }));
  }
  // the static server keys on the path only: the query (a stray ?token=) neither pairs nor counts as a wrong try here
  const clean = new URL(url.origin + url.pathname);
  if (url.pathname === SW_PATH) {
    if (!o.serviceWorker || !existsSync(join(o.distDir, 'sw.js'))) {
      return Promise.resolve(new Response(req.method === 'HEAD' ? null : SW_RESET_SCRIPT, { status: 200, headers: SW_HEADERS }));
    }
    return serveStatic(req, clean).then((res) => {
      for (const [k, v] of Object.entries(SW_HEADERS)) res.headers.set(k, v);
      res.headers.delete('service-worker-allowed');
      return res;
    });
  }
  return serveStatic(req, clean);
}
