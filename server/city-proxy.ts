// The hub's reverse proxy: /city/<id>/<rest> → <that city's server>/<rest>, for HTTP (fetch, streamed both ways,
// redirects not followed) and WebSocket (/ws, /term: a server-side WebSocket bridged frame by frame).
//
// Trust model: a city is a machine the user controls (the Add dialog says so). Its pages run on the hub's origin, so
// they could act on the hub. What the proxy guarantees is narrower and must always hold:
//  • Nothing of the browser's credentials leaves the hub: Cookie, Authorization, Tailscale-* identity headers,
//    X-Forwarded-*/Forwarded, Origin and Referer are dropped, and the hub's own pairing token is removed from the
//    query. The city sees only the cookie it gave this hub (cities.ts), and only the hub's requests.
//  • Nothing of the city lands on the hub's origin beyond the page itself: every Set-Cookie is dropped (it could
//    overwrite the hub's own session), as are headers that would set policy for the whole origin (HSTS,
//    Clear-Site-Data, NEL, Service-Worker-Allowed). Redirects stay under /city/<id>/. A service worker script fetch
//    (`Service-Worker: script`) is never forwarded: no city can install a worker on the hub's origin (the hub's own
//    worker, server/pwa.ts, is the only one).
//  • Content another machine's agents wrote (/api/files/…, /api/uploads/…) is always CSP-sandboxed (opaque origin):
//    the city's own server already does that, and the hub adds `sandbox` if a response somehow lacks it.
//  • Request bodies (uploads) and responses stream; nothing is buffered, so the city's own size limits apply.
import type { ServerWebSocket } from 'bun';
import { CITY_PREFIX, CITY_ID_RE } from '../shared/cities';
import { FILES_PATH, UPLOAD_PATH } from '../shared/protocol';
import { pickCookie, type Cities, type CityRecord } from './cities';
import { escapeHtml, guardFraming, renderPage } from './pages';
import { log } from './util';

/** Request headers never forwarded to a city (lower-case). Plus any `tailscale-*`, `x-forwarded-*` and `sec-websocket-*`. */
const DROP_REQUEST = new Set([
  'cookie', 'authorization', 'proxy-authorization', 'origin', 'referer', 'host', 'forwarded', 'x-real-ip',
  'connection', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'proxy-connection', 'content-length',
  'x-cast-hops',
]);
/** Response headers never passed back to the browser (lower-case). */
const DROP_RESPONSE = new Set([
  'set-cookie', 'set-cookie2', 'connection', 'keep-alive', 'proxy-authenticate', 'te', 'trailer', 'transfer-encoding', 'upgrade',
  // policy for the whole hub origin, which a city must not set
  'strict-transport-security', 'clear-site-data', 'nel', 'report-to', 'service-worker-allowed', 'alt-svc', 'public-key-pins',
]);
/** Agent-written or user content: must reach the browser sandboxed. */
export const CITY_CONTENT_SANDBOX = 'sandbox allow-scripts allow-popups allow-forms';
/** A request that has already crossed this many hubs is a loop (a city whose address leads back into a hub). */
export const MAX_HOPS = 4;
const HOP_HEADER = 'x-cast-hops';
const HEADERS_TIMEOUT_MS = 20_000;
const WS_CONNECT_TIMEOUT_MS = 10_000;
/** Above this many bytes queued towards either side, the bridge is closed (the app reconnects and resyncs). */
const MAX_WS_BUFFER = 64 * 1024 * 1024;

export interface CityPath {
  id: string;
  /** '/…' on the city's server; '' when the URL was /city/<id> without the trailing slash. */
  rest: string;
}

/** /city/<id>/<rest> → { id, rest }; null for anything else. The URL parser has already resolved dot segments. */
export function parseCityPath(pathname: string): CityPath | null {
  if (!pathname.startsWith(`${CITY_PREFIX}/`)) return null;
  const tail = pathname.slice(CITY_PREFIX.length + 1);
  const slash = tail.indexOf('/');
  const id = slash < 0 ? tail : tail.slice(0, slash);
  if (!CITY_ID_RE.test(id)) return null;
  return { id, rest: slash < 0 ? '' : tail.slice(slash) };
}

/** Under these paths a city serves files its agents wrote or users uploaded. */
export function isCityContent(rest: string): boolean {
  return rest.startsWith(`${FILES_PATH}/`) || rest.startsWith(`${UPLOAD_PATH}/`);
}

/** A file of the city's viewer (/api/files/<key>/…): its key is the auth there, exactly like on the hub, so the
 *  sandboxed page's own loads — which carry no cookie — still work. Forwarded without the city's cookie. */
export function isKeyedFileRequest(method: string, rest: string): boolean {
  return (method === 'GET' || method === 'HEAD') && /^\/api\/files\/[^/]+\/./.test(rest);
}

/** The city URL a proxied request goes to: same path and query, minus `token` (the hub's own pairing token). */
export function cityTarget(cityUrl: string, rest: string, search: string, ws = false): string {
  const u = new URL(cityUrl);
  u.pathname = rest || '/';
  const q = new URLSearchParams(search);
  q.delete('token');
  const qs = q.toString();
  u.search = qs ? `?${qs}` : '';
  if (ws) u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return u.href;
}

/** The headers sent to the city: the browser's minus credentials, identity and hop-by-hop headers, plus the city's
 *  cookie (when given) and the hop count. Host comes from the target URL. */
export function forwardRequestHeaders(incoming: Headers, cookie: string | null, hops: number): Headers {
  const out = new Headers();
  incoming.forEach((value, key) => {
    const k = key.toLowerCase();
    if (DROP_REQUEST.has(k) || k.startsWith('tailscale-') || k.startsWith('x-forwarded-') || k.startsWith('sec-websocket-')) return;
    out.set(k, value);
  });
  if (cookie) out.set('cookie', cookie);
  out.set(HOP_HEADER, String(hops + 1));
  return out;
}

/** Hops this request has made through hubs so far (a client may claim any number; it only gets itself refused). */
export function hopsOf(req: Request): number {
  const n = Number.parseInt(req.headers.get(HOP_HEADER) ?? '0', 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** A Location from the city → the same place seen through the hub. Root-relative and same-host absolute URLs are
 *  moved under /city/<id>/; relative ones already resolve there; other sites are left alone. */
export function rewriteLocation(location: string, id: string, cityUrl: string): string {
  const prefix = `${CITY_PREFIX}/${id}`;
  if (location.startsWith('/') && !location.startsWith('//')) return prefix + location;
  const absolute = /^[a-z][a-z0-9+.-]*:/i.test(location) || location.startsWith('//');
  if (!absolute) return location; // relative: already resolves under the prefix
  let u: URL;
  try {
    u = new URL(location, cityUrl);
  } catch {
    return location;
  }
  if ((u.protocol === 'http:' || u.protocol === 'https:') && u.host === new URL(cityUrl).host) return prefix + u.pathname + u.search + u.hash;
  return location;
}

/** True when one of the CSP headers already carries a `sandbox` directive. */
export function hasSandbox(csp: string | null): boolean {
  if (!csp) return false;
  return csp.split(',').some((policy) => policy.split(';').some((d) => d.trim().toLowerCase().split(/\s+/)[0] === 'sandbox'));
}

/** The city's response headers → what the browser gets. Also returns a session cookie the city tried to set (adopted
 *  by the hub for that city when the city renews its device session; never forwarded). */
export function filterResponseHeaders(incoming: Headers, ctx: { id: string; cityUrl: string; rest: string }): { headers: Headers; setCookies: string[] } {
  const out = new Headers();
  const setCookies: string[] = [];
  const h = incoming as Headers & { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === 'function') setCookies.push(...h.getSetCookie());
  incoming.forEach((value, key) => {
    const k = key.toLowerCase();
    if (k === 'set-cookie' && typeof h.getSetCookie !== 'function') setCookies.push(value);
    if (DROP_RESPONSE.has(k)) return;
    if (k === 'location') {
      out.set('location', rewriteLocation(value, ctx.id, ctx.cityUrl));
      return;
    }
    out.append(k, value);
  });
  const csp = out.get('content-security-policy');
  if (isCityContent(ctx.rest)) {
    if (!hasSandbox(csp)) out.append('content-security-policy', CITY_CONTENT_SANDBOX);
  } else if ((out.get('content-type') ?? '').toLowerCase().startsWith('text/html') && !/frame-ancestors/i.test(csp ?? '')) {
    // A city page runs on the hub's origin: like every CAST page, only CAST itself may frame it (pages.ts).
    out.append('content-security-policy', "frame-ancestors 'self'");
    if (!out.has('x-frame-options')) out.set('x-frame-options', 'SAMEORIGIN');
  }
  return { headers: out, setCookies };
}

function json(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

function wantsHtml(req: Request): boolean {
  return (req.method === 'GET' || req.method === 'HEAD') && (req.headers.get('accept') ?? '').includes('text/html');
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// Colours are renderPage's theme variables (dark or light), sizes in rem like the rest of the page.
const PAGE_STYLE = `<style>
  .actions { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-top: 1.125rem; }
  .btn { display: inline-flex; align-items: center; height: 2.25rem; padding: 0 0.875rem; border-radius: 0.5625rem; font: 500 0.84375rem/1 Inter, system-ui, sans-serif;
    text-decoration: none; color: var(--text); background: var(--fill); border: 1px solid var(--btn-line); }
  .btn.primary { background: var(--btn); color: var(--btn-text); border-color: transparent; }
  .btn:focus-visible { outline: 2px solid var(--amber); outline-offset: 2px; }
</style>`;

function cityPage(title: string, heading: string, lead: string, retryHref: string | null, status: number): Response {
  const actions = `<div class="actions">${retryHref ? `<a class="btn primary" href="${escapeHtml(retryHref)}">Try again</a>` : ''}<a class="btn${retryHref ? '' : ' primary'}" href="/">Back to Home</a></div>`;
  // only signed-in browsers see these pages (keyed file requests get anonymousFailure), so the app's own fonts load
  const html = renderPage({ title, heading, lead, body: PAGE_STYLE + actions, footer: '<span class="dot warn"></span> CAST · cities', signedIn: true });
  return guardFraming(new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } }));
}

/** "<name> is offline" for page loads; 502 JSON for everything else (API, WebSocket). */
export function offlineResponse(req: Request, url: URL, city: Pick<CityRecord, 'id' | 'name' | 'url'>): Response {
  const host = hostOf(city.url);
  if (!wantsHtml(req)) return json({ error: `${city.name} is offline — CAST could not reach ${host}.`, city: city.id, offline: true }, 502);
  return cityPage(`${city.name} is offline · CAST`, `${city.name} is offline`, `CAST could not reach <b>${escapeHtml(host)}</b>. Check that the machine is on and CAST is running there.`, url.pathname + url.search, 502);
}

/** A keyed file request that can't be answered (unknown city, unreachable city, a hop loop): one and the same plain
 *  404 for all of them, served like the city's own file errors (sandboxed, never sniffed). These requests come before
 *  sign-in, so the answer must not tell a stranger which city ids exist (a 502 for "known but offline" would). */
export function anonymousFailure(): Response {
  return new Response('Not found\n', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': CITY_CONTENT_SANDBOX },
  });
}

export function unknownCityResponse(req: Request): Response {
  if (!wantsHtml(req)) return json({ error: 'There’s no such city here.' }, 404);
  return cityPage('No such city · CAST', 'There’s no such city here', 'It may have been removed. Your other cities are in the city menu at the top left.', null, 404);
}

function repairResponse(req: Request, url: URL, city: CityRecord): Response | null {
  if (!wantsHtml(req)) return null;
  return cityPage(
    `${city.name} needs pairing · CAST`,
    `${city.name} needs pairing again`,
    `<b>${escapeHtml(hostOf(city.url))}</b> no longer accepts this hub’s sign-in (its pairing token changed or this hub was signed out there). Open <b>Manage cities</b> in the city menu and choose <b>Re-pair</b>.`,
    url.pathname + url.search,
    403,
  );
}

/** Data of a proxied WebSocket (hub.ts WsData.city). The city's socket is open before the browser's is accepted. */
export interface CitySocket {
  id: string;
  up: WebSocket;
  /** What the city sent before the browser's socket opened (its hello and snapshot come right away). */
  early: (string | Uint8Array)[];
  earlyBytes: number;
  /** The city closed it before the browser's socket opened. */
  upClosed?: { code: number; reason: string };
  ws?: ServerWebSocket<{ city?: CitySocket }>;
  closed?: boolean;
}

export interface CityProxyOptions {
  cities: Cities;
  fetch?: (input: string, init: RequestInit & { decompress?: boolean; duplex?: 'half' }) => Promise<Response>;
  headersTimeoutMs?: number;
  wsConnectTimeoutMs?: number;
}

export interface CityProxy {
  /** Proxy one HTTP request (the caller has authenticated it, or it is a keyed file request). */
  http(req: Request, url: URL, path: CityPath): Promise<Response>;
  /** Open the city's side of a WebSocket bridge. Resolves with the data for srv.upgrade once the city has accepted it,
   *  or with a Response (unknown city, loop, the city can't be reached: 502) — then the browser's handshake fails
   *  and its socket never looks connected. */
  socket(req: Request, url: URL, path: CityPath): Promise<{ data: CitySocket } | Response>;
  open(ws: ServerWebSocket<{ city?: CitySocket }>): void;
  message(ws: ServerWebSocket<{ city?: CitySocket }>, raw: string | Buffer): void;
  close(ws: ServerWebSocket<{ city?: CitySocket }>, code: number, reason: string): void;
  closeAll(): void;
}

/** A close code the hub may send the browser: 1005/1006/1015 (and anything odd) mean "it just went away" → 1014 (bad gateway). */
export function relayCloseCode(code: number): number {
  if (code === 1000 || code === 1001 || code === 1003 || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999)) return code;
  return 1014;
}

/** A close code the hub may send the city as a WebSocket client: only 1000 and 3000–4999 are allowed there. */
export function upstreamCloseCode(code: number): number {
  return code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000;
}

export function createCityProxy(opts: CityProxyOptions): CityProxy {
  const { cities } = opts;
  const doFetch = opts.fetch ?? ((input, init) => fetch(input, init));
  const headersMs = opts.headersTimeoutMs ?? HEADERS_TIMEOUT_MS;
  const wsMs = opts.wsConnectTimeoutMs ?? WS_CONNECT_TIMEOUT_MS;
  const sockets = new Set<ServerWebSocket<{ city?: CitySocket }>>();

  async function http(req: Request, url: URL, path: CityPath): Promise<Response> {
    if (req.headers.get('service-worker') === 'script') return anonymousFailure();
    // Keyed file requests arrive before sign-in (city-routes beforeAuth): every failure of theirs is the same plain
    // 404 (anonymousFailure), so a stranger learns neither which cities exist nor where they are.
    const keyed = isKeyedFileRequest(req.method, path.rest);
    const city = cities.get(path.id);
    if (!city) return keyed ? anonymousFailure() : unknownCityResponse(req);
    if (!path.rest) {
      // /city/<id> → /city/<id>/ so the page's relative URLs (./assets/…) resolve inside the city.
      return new Response(null, { status: 308, headers: { location: `${CITY_PREFIX}/${city.id}/${url.search}`, 'cache-control': 'no-store' } });
    }
    const hops = hopsOf(req);
    if (hops >= MAX_HOPS) return keyed ? anonymousFailure() : json({ error: 'This request went round in a loop of CAST hubs. Check the cities’ addresses.' }, 508);

    const headers = forwardRequestHeaders(req.headers, keyed ? null : city.cookie, hops);
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    req.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => ctl.abort(), headersMs);
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && req.body !== null;
    let res: Response;
    try {
      res = await doFetch(cityTarget(city.url, path.rest, url.search), {
        method: req.method,
        headers,
        body: hasBody ? req.body : undefined,
        duplex: hasBody ? 'half' : undefined,
        redirect: 'manual',
        decompress: false, // pass the city's gzip through untouched (Content-Encoding stays true)
        signal: ctl.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onAbort);
      if (req.signal?.aborted) return new Response(null, { status: 499 });
      cities.note(city.id, 'offline', `CAST could not reach ${hostOf(city.url)}.`);
      return keyed ? anonymousFailure() : offlineResponse(req, url, city);
    }
    clearTimeout(timer); // the body may stream for as long as it takes
    if (keyed && res.status === 404) {
      // the city's own "no such key / file" would differ from anonymousFailure in its headers, telling a stranger that
      // this city id exists
      await res.body?.cancel().catch(() => {});
      return anonymousFailure();
    }
    const { headers: outHeaders, setCookies } = filterResponseHeaders(res.headers, { id: city.id, cityUrl: city.url, rest: path.rest });
    const upgraded = setCookies.length ? pickCookie(setCookies, ['rlt_session']) : null;
    if (upgraded && !keyed) cities.adoptCookie(city.id, upgraded);
    if (res.status === 403 && !keyed) {
      cities.note(city.id, 'error', 'That machine no longer accepts this pairing — re-pair it.');
      const page = repairResponse(req, url, city);
      if (page) {
        await res.body?.cancel().catch(() => {});
        return page;
      }
    } else if (res.status < 500) {
      cities.note(city.id, 'online');
    }
    const nullBody = req.method === 'HEAD' || res.status === 204 || res.status === 304;
    return new Response(nullBody ? null : res.body, { status: res.status, statusText: res.statusText, headers: outHeaders });
  }

  async function socket(req: Request, url: URL, path: CityPath): Promise<{ data: CitySocket } | Response> {
    const city = cities.get(path.id);
    if (!city) return unknownCityResponse(req);
    const hops = hopsOf(req);
    if (hops >= MAX_HOPS) return json({ error: 'This request went round in a loop of CAST hubs.' }, 508);
    const known = cities.known(city.id);
    // Known to be down a moment ago (a machine that is off makes every try wait for the timeout): say so at once.
    if (known?.status === 'offline' && Date.now() - known.at < 5000) return offlineResponse(req, url, city);
    const headers: Record<string, string> = {};
    forwardRequestHeaders(req.headers, city.cookie, hops).forEach((v, k) => {
      // the WebSocket handshake headers are the client library's own
      if (!['accept-encoding', 'accept', 'cache-control', 'pragma', 'content-type'].includes(k)) headers[k] = v;
    });
    let up: WebSocket;
    try {
      // Bun's WebSocket takes request headers: the city's cookie, never the browser's. No Origin (contract C2).
      up = new WebSocket(cityTarget(city.url, path.rest || '/', url.search, true), { headers } as unknown as string[]);
    } catch {
      cities.note(city.id, 'offline');
      return offlineResponse(req, url, city);
    }
    up.binaryType = 'arraybuffer';
    const s: CitySocket = { id: city.id, up, early: [], earlyBytes: 0 };
    up.onmessage = (ev) => {
      const data = typeof ev.data === 'string' ? ev.data : new Uint8Array(ev.data as ArrayBuffer);
      s.earlyBytes += typeof data === 'string' ? data.length * 2 : data.byteLength;
      if (s.earlyBytes > MAX_WS_BUFFER) up.close(1000, 'Too much before the browser was ready');
      else s.early.push(data);
    };
    up.onclose = (ev) => {
      s.upClosed = { code: ev.code, reason: ev.reason };
    };
    const opened = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => done(false), wsMs);
      const onAbort = () => done(false);
      const done = (ok: boolean) => {
        clearTimeout(timer);
        req.signal?.removeEventListener('abort', onAbort);
        up.removeEventListener('open', onOpen);
        up.removeEventListener('close', onClose);
        resolve(ok);
      };
      const onOpen = () => done(true);
      const onClose = () => done(false);
      up.addEventListener('open', onOpen);
      up.addEventListener('close', onClose);
      req.signal?.addEventListener('abort', onAbort, { once: true });
    });
    if (!opened) {
      try {
        up.close();
      } catch {
        /* never opened */
      }
      if (req.signal?.aborted) return new Response(null, { status: 499 });
      cities.note(city.id, 'offline', `CAST could not reach ${hostOf(city.url)}.`);
      return offlineResponse(req, url, city);
    }
    cities.note(city.id, 'online');
    return { data: s };
  }

  function shut(ws: ServerWebSocket<{ city?: CitySocket }>, code: number, reason: string): void {
    try {
      ws.close(relayCloseCode(code), reason.slice(0, 120));
    } catch {
      /* already closed */
    }
  }

  function open(ws: ServerWebSocket<{ city?: CitySocket }>): void {
    const s = ws.data.city;
    if (!s) return;
    sockets.add(ws);
    s.ws = ws;
    const { up } = s;
    for (const m of s.early) ws.send(m);
    s.early = [];
    s.earlyBytes = 0;
    if (s.upClosed) {
      s.closed = true;
      return shut(ws, s.upClosed.code, s.upClosed.reason);
    }
    up.onmessage = (ev) => {
      if (s.closed) return;
      ws.send(typeof ev.data === 'string' ? ev.data : new Uint8Array(ev.data as ArrayBuffer));
      if (ws.getBufferedAmount() > MAX_WS_BUFFER) {
        log('cities', `${s.id}: browser not keeping up with the city's socket; closing the bridge`);
        s.closed = true;
        try {
          up.close(1000, 'Too slow');
        } catch {
          /* ignore */
        }
        shut(ws, 1013, 'Too slow, please reconnect');
      }
    };
    up.onclose = (ev) => {
      if (s.closed) return;
      s.closed = true;
      if (ev.code === 1006 && !ev.wasClean) cities.note(s.id, 'offline');
      shut(ws, ev.code, ev.reason || (ev.code === 1006 ? 'City unreachable' : ''));
    };
  }

  function message(ws: ServerWebSocket<{ city?: CitySocket }>, raw: string | Buffer): void {
    const s = ws.data.city;
    if (!s || s.closed || s.up.readyState !== WebSocket.OPEN) return;
    s.up.send(typeof raw === 'string' ? raw : new Uint8Array(raw));
    if (s.up.bufferedAmount > MAX_WS_BUFFER) {
      log('cities', `${s.id}: the city is not keeping up; closing the bridge`);
      s.closed = true;
      s.up.close(1000, 'Too slow');
      shut(ws, 1013, 'Too slow, please reconnect');
    }
  }

  function close(ws: ServerWebSocket<{ city?: CitySocket }>, code: number, reason: string): void {
    sockets.delete(ws);
    const s = ws.data.city;
    if (!s || s.closed) return;
    s.closed = true;
    const up = s.up;
    if (up.readyState === WebSocket.CLOSED || up.readyState === WebSocket.CLOSING) return;
    try {
      up.close(upstreamCloseCode(code), reason.slice(0, 120));
    } catch {
      try {
        up.close();
      } catch {
        /* ignore */
      }
    }
  }

  return {
    http,
    socket,
    open,
    message,
    close,
    closeAll() {
      for (const ws of sockets) shut(ws, 1001, 'Server restarting');
      sockets.clear();
    },
  };
}
