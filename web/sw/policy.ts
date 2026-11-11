// The service worker's rules, as pure functions (tests/web/sw-policy.test.ts; web/sw/sw.ts applies them).
//
// The worker exists for three things: an offline page instead of a white screen (the Home Screen app has no
// address bar and no error page of its own), Web Push notifications, and keeping hashed code chunks a page may still
// ask for after a deploy. It never caches a page (HTML), an API answer or anything of a city: every request it does
// not know goes to the network untouched — so a new build always takes over on the next load, and nothing it does
// can strand a device on an old app.
import { BRAND_COLORS, markSvg } from '../../shared/brand';

export type Route = 'pass' | 'navigate' | 'navigate-city' | 'asset';

/** Every cache this worker makes starts with this (server/pwa.ts's kill switch deletes them by it). */
export const CACHE_PREFIX = 'cast-';
export const ASSET_CACHE = `${CACHE_PREFIX}assets-v1`;
/** Hashed chunks kept (oldest first out). */
export const MAX_ASSETS = 80;
/** A page load that takes longer than this shows the offline page (a city's has no limit: its hub answers). */
export const NAV_TIMEOUT_MS = 12_000;

/** A Vite chunk straight under /assets/ with its content hash: never changes, so it may be kept. Release files of the
 *  3D town live in subfolders (/assets/hdri/…) and never match. */
const ASSET_RE = /^\/assets\/[A-Za-z0-9._-]+-[A-Za-z0-9_-]{8}\.(?:js|css)$/;

export interface RouteRequest {
  method: string;
  url: string;
  /** Request.mode: 'navigate' for a page load. */
  mode: string;
}

/** What the worker does with one request; 'pass' = nothing at all (no respondWith). */
export function route(r: RouteRequest, origin: string): Route {
  if (r.method !== 'GET') return 'pass';
  let u: URL;
  try {
    u = new URL(r.url);
  } catch {
    return 'pass';
  }
  if (u.origin !== origin) return 'pass';
  const p = u.pathname;
  if (u.searchParams.has('token')) return 'pass'; // pairing links: the server's redirect and cookie, untouched
  if (p.startsWith('/api/') || p === '/ws' || p === '/term') return 'pass';
  if (r.mode === 'navigate') {
    // the app's pages only: a file opened in a tab (/favicon.svg, /assets/…) is not a page of the app
    if (/\.[A-Za-z0-9]+$/.test(p) && !p.endsWith('.html')) return 'pass';
    if (p.startsWith('/assets/') || p.startsWith('/fonts/')) return 'pass';
    return p.startsWith('/city/') ? 'navigate-city' : 'navigate';
  }
  if (p.startsWith('/city/')) return 'pass';
  if (u.search === '' && ASSET_RE.test(p)) return 'asset';
  return 'pass';
}

/** A page load's answer is swapped for the offline page only when it is tailscale serve's own "bad gateway" (CAST
 *  is not running behind it): CAST's answers all carry nosniff. Everything else — the app, the 403 page, redirects,
 *  CAST's own errors — passes through as it is. */
export function swapsForOffline(status: number, fromCast: boolean): boolean {
  return (status === 502 || status === 504) && !fromCast;
}

/** The offline page's two themes: the boot screen's tokens (web/index.html --boot-*; the background is also the bar
 *  colour, web/src/ui/theme.ts THEME_COLOR) and the brand's mark colours. */
export const OFFLINE_THEMES = {
  dark: { bg: '#0e0d0c', text: '#f4f1ec', muted: '#a8a29e', faint: '#918a85', ink: BRAND_COLORS.ink, lamp: BRAND_COLORS.sun, btn: '#f4f1ec', btnText: '#1b1a18', ring: '#f5c26b' },
  light: { bg: '#f1ece4', text: '#1f1b17', muted: '#4d463f', faint: '#5e564f', ink: BRAND_COLORS.inkOnLight, lamp: BRAND_COLORS.sunOnLight, btn: '#1f1b17', btnText: '#fbf9f6', ring: '#a35f00' },
} as const;

const vars = (t: (typeof OFFLINE_THEMES)['dark' | 'light']) =>
  `--bg:${t.bg}; --text:${t.text}; --muted:${t.muted}; --faint:${t.faint}; --ink:${t.ink}; --lamp:${t.lamp}; --btn:${t.btn}; --btn-text:${t.btnText}; --ring:${t.ring};`;

/** The splash's dim lamp in its first frame (web/index.html .boot-ember, the iOS launch images). */
export const OFFLINE_LAMP = 0.32;

/** The page shown when CAST can't be reached. Self-contained (no other file, no other host); it tries
 *  /api/health every few seconds and when the device comes back online, and reloads once CAST answers.
 *  It looks like the start of the boot screen: the mark alone on the screen's centre at 96 px — where the iOS launch
 *  image and the splash put it — its lamp dim, breathing while it waits, and a few words under it. In a browser tab it
 *  takes the splash background of the theme (Settings → Theme, else the device's; the same key and rule as
 *  web/index.html's pre-paint script); in the installed app it is night, as the splash starts there: the OS launch
 *  screen before it is dark for everyone — on the window's first page only, like the splash (sessionStorage
 *  'rlt.launch' is "day" once the window's night is over: a reload while offline shows the theme). */
export function offlineHtml(): string {
  const { dark, light } = OFFLINE_THEMES;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark light">
<meta name="theme-color" content="${dark.bg}">
<title>CAST · Offline</title>
<script>
  (function () {
    var t = null;
    try { t = localStorage.getItem('rlt.theme'); } catch (e) {}
    if (t !== 'light' && t !== 'dark') t = window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    var day = false;
    try { day = sessionStorage.getItem('rlt.launch') === 'day'; } catch (e) {}
    if (((window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true) && !day) t = 'dark';
    document.documentElement.setAttribute('data-theme', t);
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute('content', t === 'light' ? '${light.bg}' : '${dark.bg}');
  })();
</script>
<style>
  :root { color-scheme: dark; ${vars(dark)} }
  @media (prefers-color-scheme: light) { :root:not([data-theme='dark']) { color-scheme: light; ${vars(light)} } }
  :root[data-theme='light'] { color-scheme: light; ${vars(light)} }
  * { box-sizing: border-box; }
  html { height: 100%; background: var(--bg); }
  /* the mark on the screen's centre (not the safe area's: the launch image's place), the words below it; a screen too
     short for that (a phone held sideways) moves the mark up rather than scroll */
  body { margin: 0; height: 100%; overflow-y: auto; display: grid; grid-template-rows: minmax(0, 1fr) auto minmax(min-content, 1fr);
    justify-items: center;
    background: var(--bg); color: var(--text); text-align: center; -webkit-font-smoothing: antialiased;
    font: 0.9375rem/1.5 Inter, system-ui, -apple-system, 'Segoe UI', sans-serif;
    padding: max(1.5rem, env(safe-area-inset-top), env(safe-area-inset-bottom)) max(1.5rem, env(safe-area-inset-left), env(safe-area-inset-right)); }
  .mark { grid-row: 2; display: block; width: 96px; height: 96px; }
  .mark path { stroke: var(--ink); }
  .mark circle { fill: var(--lamp); opacity: ${OFFLINE_LAMP}; }
  main { grid-row: 3; align-self: start; width: min(22rem, 100%); padding-top: 2rem; }
  h1 { margin: 0 0 0.375rem; font-size: 1.0625rem; line-height: 1.4; font-weight: 600; letter-spacing: -0.005em; }
  p { margin: 0; color: var(--muted); }
  .btn { display: inline-flex; align-items: center; justify-content: center; min-height: 2.75rem; margin-top: 1.5rem; padding: 0 1.25rem;
    border-radius: 999px; background: var(--btn); color: var(--btn-text); font-weight: 600; text-decoration: none; }
  .btn:focus-visible { outline: 2px solid var(--ring); outline-offset: 3px; }
  .wait { margin-top: 1rem; font-size: 0.8125rem; color: var(--faint); }
  @media (max-height: 28rem) {
    main { width: min(30rem, 100%); padding-top: 1.25rem; }
    .btn { margin-top: 1rem; }
    .wait { margin-top: 0.5rem; }
  }
  /* the lamp breathes while CAST is being asked: someone will be home soon */
  @media (prefers-reduced-motion: no-preference) {
    .mark circle { animation: lamp 2.8s ease-in-out infinite alternate; }
    @keyframes lamp { to { opacity: 0.6; } }
  }
</style>
</head>
<body>
${markSvg({ cls: 'mark' })}
<main>
  <h1>CAST can’t be reached</h1>
  <p>This device is offline, Tailscale is off, or the computer running CAST is asleep.</p>
  <a class="btn" href="">Try again</a>
  <p class="wait" aria-live="polite">CAST opens by itself as soon as it answers.</p>
</main>
<script>
  (function () {
    var busy = false;
    function probe() {
      if (busy) return;
      busy = true;
      fetch('/api/health', { cache: 'no-store', credentials: 'same-origin' }).then(function (r) { if (r.ok) location.reload(); }, function () {}).then(function () { busy = false; });
    }
    addEventListener('online', probe);
    setInterval(probe, 3000);
  })();
</script>
</body>
</html>`;
}

export interface NotificationData {
  next: string;
  kind: string;
  badge?: number;
}

export interface NotificationPlan {
  title: string;
  options: {
    body: string;
    tag?: string;
    renotify: boolean;
    data: NotificationData;
    icon: string;
    badge: string;
    lang: string;
    dir: 'ltr' | 'rtl' | 'auto';
    silent: boolean;
    timestamp: number;
  };
}

/** A same-origin path from `raw` (a path or an absolute URL on this origin); '/' for anything else. */
export function sameOriginPath(raw: unknown, origin: string): string {
  if (typeof raw !== 'string' || !raw || raw.includes('\\')) return '/';
  try {
    const u = new URL(raw, origin);
    if (u.origin !== origin || (!raw.startsWith('/') && !raw.startsWith(origin)) || raw.startsWith('//')) return '/';
    return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    return '/';
  }
}

const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');

/** A push message (server/push/notifier.ts pushPayload: declarative Web Push with the worker's data inside, or just
 *  {notification}) → what showNotification gets. Never null: a push must always show something (Safari ends a
 *  subscription whose pushes show nothing). */
export function payloadToNotification(raw: unknown, origin: string, now = Date.now()): NotificationPlan {
  const n = (raw && typeof raw === 'object' && 'notification' in raw ? (raw as { notification: unknown }).notification : raw) as Record<string, unknown> | null;
  const ok = !!n && typeof n === 'object' && typeof n.title === 'string' && !!n.title;
  const d = (ok && n.data && typeof n.data === 'object' ? n.data : {}) as Record<string, unknown>;
  const badgeRaw = typeof d.badge === 'number' ? d.badge : ok ? Number.parseInt(str(n.app_badge), 10) : NaN;
  const badge = Number.isFinite(badgeRaw) && badgeRaw >= 0 ? Math.floor(badgeRaw) : undefined;
  const tag = ok ? str(n.tag, 100) || undefined : undefined;
  return {
    title: ok ? str(n.title) : 'CAST needs you',
    options: {
      body: ok ? str(n.body, 500) : '',
      ...(tag ? { tag } : {}),
      renotify: !!tag,
      data: { next: sameOriginPath(d.next, origin), kind: str(d.kind, 20) || 'waiting', ...(badge !== undefined ? { badge } : {}) },
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      lang: 'en',
      dir: 'ltr',
      silent: false,
      timestamp: now,
    },
  };
}
