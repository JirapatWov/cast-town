// Access control. The GUI can run commands on this machine, so every request must come from someone the owner let in:
//  1. A paired device: the `rlt_session` cookie holds a random session secret (devices.ts keeps only its hash). Pairing
//     exchanges the pairing token (or a one-time pairing code) for a session: `?token=` on a page load sets the cookie
//     and redirects to the clean URL; scripts and other CAST servers use POST /api/pair (JSON). The private page's
//     own form posts there too (x-www-form-urlencoded: a pasted link or a typed short code, for CAST on a phone's Home
//     Screen, which has its own cookies and no address bar) and gets a 303 with the cookie. The token itself is never
//     put in a cookie again. Browsers paired before sessions existed carry `rlt_token=<token>`: accepted and silently
//     upgraded to a session (no re-pairing after an update).
//  2. Tailscale: `tailscale serve` adds `Tailscale-User-Login`. It counts only when the owner listed logins
//     (allowedUsers; empty by default → the header is ignored), the TCP peer is loopback (tailscale serve runs on this
//     machine — anything on the LAN could send the header itself) and the Host is one tailscale serve uses (a
//     DNS-rebinding page could send it too, but never with our Host; see tailnetHost).
//  3. `?token=<pairing token>` on a WebSocket or non-GET request: scripts, no session.
// WebSocket upgrades and state-changing API calls additionally must come from our own origin when they carry an Origin
// (blocks cross-site WebSocket hijacking and same-site CSRF from other local ports); without one (scripts, the city
// proxy of another CAST) they rely on the credentials alone.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { cleanDeviceName, createDeviceBook, deviceNameFromUserAgent, type DeviceBook, type DeviceKind, type DeviceRecord } from './devices';
import { FRAME_GUARD_HEADERS, forbiddenPage, type DenyReason, type PairingHint } from './pages';
import { log, readTextCapped, safeNext, writeFileAtomic } from './util';

export const SESSION_COOKIE = 'rlt_session';
/** Legacy: the pairing token itself as a cookie (before device sessions). Read once, then replaced. */
export const TOKEN_COOKIE = 'rlt_token';
const TAILSCALE_LOGIN = 'tailscale-user-login';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
/** Parallel requests of one page that still carry the legacy cookie share one new session. */
const LEGACY_DEDUPE_MS = 2 * 60 * 1000;
/** Wrong pairing attempts (`?token=`, POST /api/pair) per client address before it has to wait. Only wrong tries count
 *  and only wrong tries are refused: the right token (192 bits) or a valid one-time code (144 bits) always pairs, so
 *  nobody can lock the owner out by failing on purpose. The limit only quiets a pest — except for the short typed
 *  codes (60 bits, devices.ts): those are not even looked at while the address waits, so guessing one online is
 *  capped at PAIR_FAILURE_LIMIT tries per window per address against at most 20 live codes (about 2e-16). A change to
 *  the limiter must keep both rules. */
export const PAIR_FAILURE_LIMIT = 10;
export const PAIR_FAILURE_WINDOW_MS = 10 * 60 * 1000;
const PAIR_BODY_MAX = 4096;
/** The private page's form names a device added from CAST on a Home Screen apart from the same phone's browser. */
export const HOME_SCREEN_SUFFIX = ' (Home Screen app)';
/** The device name the CAST menu-bar app pairs with (the Mac app contract); such a session is kind 'app'. */
export const MENU_BAR_DEVICE_NAME = 'CAST menu bar (Mac)';

/** kind of a POST /api/pair session: 'app' when the body says so, or for the menu-bar app's own device name. */
export function pairKind(body: { kind?: unknown; device?: unknown }): DeviceKind | undefined {
  if (body.kind === 'app') return 'app';
  return typeof body.device === 'string' && body.device.trim() === MENU_BAR_DEVICE_NAME ? 'app' : undefined;
}

export type AuthVia = 'session' | 'token' | 'tailnet';

export type AllowDecision = {
  kind: 'allow';
  user: string;
  via: AuthVia;
  /** The paired device (via 'session'); null for tailnet logins and raw-token scripts. */
  deviceId: string | null;
  /** Cookies to set on whatever response answers this request (legacy upgrade, session refresh). */
  setCookie?: string[];
};

export type AuthDecision =
  | AllowDecision
  | { kind: 'redirect'; location: string; setCookie: string[] }
  | { kind: 'deny'; reason: DenyReason | 'bad-origin'; login?: string };

export interface CheckOptions {
  /** WebSocket upgrade or a request that changes something: an Origin, when sent, must be ours. */
  websocket?: boolean;
  /** The TCP peer's address (Bun's server.requestIP); null/undefined when unknown. */
  peer?: string | null;
}

/** Sessions that just ended, so their open WebSockets can be closed. token: the pairing token changed (sockets that
 *  authenticated with `?token=` itself must reconnect with the new one). */
export interface RevokeEvent {
  deviceIds: string[];
  token: boolean;
}

export interface Auth {
  /** The current pairing token (it can change: rotateToken). */
  readonly token: string;
  readonly tokenFile: string;
  readonly devices: DeviceBook;
  check(req: Request, url: URL, opts?: CheckOptions): AuthDecision;
  /** Response for a deny decision: a friendly HTML page for browsers (with the pairing form), plain text for API/WS
   *  clients. */
  denyResponse(decision: Extract<AuthDecision, { kind: 'deny' }>, req: Request): Response;
  /** POST /api/pair (unauthenticated): JSON {token, device} → {cookie, deviceId}; the private page's form
   *  (x-www-form-urlencoded token, next, app) → 303 to next with the session cookie. */
  pair(req: Request, peer?: string | null): Promise<Response>;
  /** /api/session and /api/devices… for an allowed request; null when the path is not one of them. */
  api(req: Request, url: URL, decision: AllowDecision): Promise<Response> | null;
  /** A new pairing token (old links stop working; sessions stay unless revoked separately). */
  rotateToken(): void;
  onRevoke(fn: (e: RevokeEvent) => void): () => void;
}

export interface AuthOptions {
  dataDir: string;
  allowedUsers: string[]; // lower-cased logins
  allowedOrigins: string[]; // lower-cased origins without trailing slash
  /** What the 403 page tells people about getting a pairing link (token file, command). */
  pairing?: PairingHint;
  /** Extra fields for GET /api/session (the page's own facts about this server: terminal, city name). */
  sessionInfo?: () => Record<string, unknown>;
  now?: () => number;
}

function newToken(): string {
  return randomBytes(24).toString('base64url');
}

function loadOrCreateToken(file: string): string {
  if (existsSync(file)) {
    const t = readFileSync(file, 'utf8').trim();
    if (t.length >= 16) return t;
  }
  const token = newToken();
  writeFileAtomic(file, token + '\n', 0o600);
  return token;
}

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function isHttps(req: Request, url: URL): boolean {
  return url.protocol === 'https:' || (req.headers.get('x-forwarded-proto') ?? '').toLowerCase() === 'https';
}

/** 127.0.0.0/8 and ::1, also as IPv4-mapped IPv6 (Bun reports ::ffff:127.0.0.1 on dual-stack sockets). */
export function isLoopback(addr: string | null | undefined): boolean {
  if (!addr) return false;
  const a = addr.toLowerCase().replace(/^::ffff:/, '');
  return a === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

/** Whose wrong pairing tries a request counts towards. Behind `tailscale serve` every request comes from 127.0.0.1, so
 *  there the address serve puts in X-Forwarded-For (the tailnet device's own) is used — trusted only from a loopback
 *  peer, because anyone else could write any address in it. A local process could too, but it gains nothing by that:
 *  a wrong try is refused either way and the right secret always works. */
export function pairLimitKey(req: Request, peer: string | null | undefined): string {
  const direct = peer ?? 'unknown';
  if (!isLoopback(peer)) return direct;
  const forwarded = req.headers.get('x-forwarded-for');
  if (!forwarded) return direct;
  // serve sets one address; when there are more, the last one is what the proxy next to us saw
  const last = forwarded.split(',').pop()!.trim().replace(/^\[|\]$/g, '');
  return isIP(last) ? `fwd:${last.toLowerCase()}` : direct;
}

/** The Origin of a WebSocket handshake (or a state-changing request) must match the host the browser talked to
 *  (direct, vite proxy, or tailscale serve). No Origin: not a browser (scripts, tests, a CAST city proxy). */
export function originAllowed(req: Request, extra: string[]): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return true;
  let host: string;
  try {
    host = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  const seen = [req.headers.get('host'), req.headers.get('x-forwarded-host')]
    .filter((h): h is string => !!h)
    .map((h) => h.toLowerCase());
  return seen.includes(host) || extra.includes(origin.replace(/\/+$/, '').toLowerCase());
}

/** A Host a request from `tailscale serve` has: the tailnet name (*.ts.net, a bare MagicDNS name), an IP (serve proxies to
 *  127.0.0.1; 100.x for plain HTTP), localhost, or a host from allowedOrigins. A page that rebinds its own domain to
 *  this machine always sends that domain as Host (browsers don't let a page change it), so its own
 *  Tailscale-User-Login header is ignored. */
function tailnetHost(req: Request, extra: string[]): boolean {
  const raw = req.headers.get('host');
  if (!raw) return true; // not from a browser
  let name: string;
  try {
    name = new URL(`http://${raw}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (name.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(name)) return true;
  if (name === 'localhost' || !name.includes('.') || name.endsWith('.ts.net')) return true;
  return extra.some((o) => {
    try {
      return new URL(o).hostname.toLowerCase() === name;
    } catch {
      return false;
    }
  });
}

function wantsHtml(req: Request): boolean {
  return (req.headers.get('accept') ?? '').includes('text/html');
}

/** A pasted pairing link (`https://host/?token=…`) or the bare token/code. */
export function tokenFromInput(raw: string): string {
  const s = raw.trim();
  if (/^https?:\/\//i.test(s)) {
    try {
      return new URL(s).searchParams.get('token')?.trim() ?? '';
    } catch {
      return '';
    }
  }
  return s;
}

const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };
function json(data: unknown, status = 200, extra: Record<string, string> = {}, cookies: string[] = []): Response {
  const headers = new Headers({ ...JSON_HEADERS, ...extra });
  for (const c of cookies) headers.append('set-cookie', c);
  return new Response(JSON.stringify(data), { status, headers });
}

/** Failed pairing attempts per client address in a sliding window. */
function createLimiter(now: () => number) {
  const fails = new Map<string, { n: number; resetAt: number }>();
  return {
    blocked(key: string): number {
      const f = fails.get(key);
      if (!f) return 0;
      if (now() >= f.resetAt) {
        fails.delete(key);
        return 0;
      }
      return f.n >= PAIR_FAILURE_LIMIT ? f.resetAt - now() : 0;
    },
    fail(key: string) {
      const f = fails.get(key);
      if (!f || now() >= f.resetAt) fails.set(key, { n: 1, resetAt: now() + PAIR_FAILURE_WINDOW_MS });
      else f.n++;
      if (fails.size > 10_000) fails.clear(); // a flood of addresses must not grow this forever
    },
  };
}

export function createAuth(opts: AuthOptions): Auth {
  const now = opts.now ?? Date.now;
  const tokenFile = join(opts.dataDir, 'token');
  let token = loadOrCreateToken(tokenFile);
  const devices = createDeviceBook(opts.dataDir, now);
  const allowed = new Set(opts.allowedUsers);
  const limiter = createLimiter(now);
  const legacyUpgrades = new Map<string, { secret: string; deviceId: string; at: number }>();
  const listeners = new Set<(e: RevokeEvent) => void>();

  const emit = (e: RevokeEvent) => {
    if (!e.deviceIds.length && !e.token) return;
    for (const fn of [...listeners]) {
      try {
        fn(e);
      } catch (err) {
        log('auth', 'revoke listener failed', err);
      }
    }
  };

  /** A typed short code: only looked at while this address may still try (PAIR_FAILURE_LIMIT). */
  const shortCode = (given: string, key: string) => limiter.blocked(key) === 0 && devices.consumePairCode(given, { short: true });

  function cookie(req: Request, url: URL, name: string, value: string, maxAge = COOKIE_MAX_AGE): string {
    return [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`, ...(isHttps(req, url) ? ['Secure'] : [])].join('; ');
  }
  const clearCookie = (req: Request, url: URL, name: string) => cookie(req, url, name, '', 0);

  function newSession(req: Request, name?: string, kind?: DeviceKind): { secret: string; device: DeviceRecord } {
    const s = devices.create({ name, userAgent: req.headers.get('user-agent'), kind });
    log('auth', `paired a new device: ${s.device.name} (${s.device.id})`);
    return s;
  }

  /** A browser still carrying `rlt_token=<token>`: give it a session and drop the old cookie. */
  function upgradeLegacy(req: Request, url: URL, peer: string | null | undefined): AllowDecision {
    const key = `${peer ?? ''}|${req.headers.get('user-agent') ?? ''}`;
    for (const [k, v] of legacyUpgrades) if (now() - v.at > LEGACY_DEDUPE_MS) legacyUpgrades.delete(k);
    let hit = legacyUpgrades.get(key);
    if (!hit || !devices.get(hit.deviceId)) {
      const { secret, device } = devices.create({ userAgent: req.headers.get('user-agent') });
      hit = { secret, deviceId: device.id, at: now() };
      legacyUpgrades.set(key, hit);
      log('auth', `moved a browser paired before device sessions to its own session: ${device.name} (${device.id})`);
    }
    return {
      kind: 'allow',
      user: 'token',
      via: 'session',
      deviceId: hit.deviceId,
      setCookie: [cookie(req, url, SESSION_COOKIE, hit.secret), clearCookie(req, url, TOKEN_COOKIE)],
    };
  }

  function check(req: Request, url: URL, o: CheckOptions = {}): AuthDecision {
    if (o.websocket && !originAllowed(req, opts.allowedOrigins)) return { kind: 'deny', reason: 'bad-origin' };

    let login: string | undefined;
    if (allowed.size > 0 && isLoopback(o.peer) && tailnetHost(req, opts.allowedOrigins)) {
      const l = req.headers.get(TAILSCALE_LOGIN)?.trim();
      if (l) {
        if (allowed.has(l.toLowerCase())) return { kind: 'allow', user: l, via: 'tailnet', deviceId: null };
        login = l; // not on the list: still welcome with a pairing (below), else told why
      }
    }

    const fromQuery = url.searchParams.get('token');
    if (fromQuery !== null) {
      // The secret is checked first: the right one works even while this address is blocked for wrong tries.
      const wrong = (): AuthDecision => {
        const key = pairLimitKey(req, o.peer);
        if (limiter.blocked(key)) return { kind: 'deny', reason: 'rate-limited' };
        limiter.fail(key);
        return { kind: 'deny', reason: 'bad-token' };
      };
      const isToken = sameSecret(fromQuery, token);
      if (o.websocket || req.method !== 'GET') {
        // Scripts: the token itself, no session. One-time codes are only for pairing a device.
        if (isToken) return { kind: 'allow', user: 'token', via: 'token', deviceId: null };
        return wrong();
      }
      if (!isToken && !devices.consumePairCode(fromQuery) && !shortCode(fromQuery, pairLimitKey(req, o.peer))) return wrong();
      const clean = new URL(url);
      clean.searchParams.delete('token');
      // One leading slash: a path like `//host` would send the browser to another server.
      const location = clean.pathname.replace(/^\/{2,}/, '/') + clean.search + clean.hash;
      // Already paired (a second click on the link): keep that session instead of listing the browser twice.
      const current = readCookie(req, SESSION_COOKIE);
      const kept = current ? devices.verify(current) : undefined;
      const secret = kept && current ? current : newSession(req).secret;
      return { kind: 'redirect', location, setCookie: [cookie(req, url, SESSION_COOKIE, secret), clearCookie(req, url, TOKEN_COOKIE)] };
    }

    let signedOut = false;
    const session = readCookie(req, SESSION_COOKIE);
    if (session) {
      const d = devices.verify(session);
      if (d) {
        const decision: AllowDecision = { kind: 'allow', user: 'token', via: 'session', deviceId: d.id };
        // A page load renews the cookie, so a device in use never hits the one-year expiry.
        if (!o.websocket && req.method === 'GET' && wantsHtml(req)) {
          decision.setCookie = [cookie(req, url, SESSION_COOKIE, session)];
          if (readCookie(req, TOKEN_COOKIE) !== null) decision.setCookie.push(clearCookie(req, url, TOKEN_COOKIE));
        }
        return decision;
      }
      signedOut = true; // revoked, or the data folder was reset
    }

    const legacy = readCookie(req, TOKEN_COOKIE);
    if (legacy !== null && !signedOut) {
      if (sameSecret(legacy, token)) return upgradeLegacy(req, url, o.peer);
      return login ? { kind: 'deny', reason: 'not-allowed', login } : { kind: 'deny', reason: 'bad-token' };
    }
    if (login) return { kind: 'deny', reason: 'not-allowed', login };
    return { kind: 'deny', reason: signedOut ? 'signed-out' : 'no-token' };
  }

  /** The private page (HTML), with the pairing form; `next`: where the form's pairing lands (a safeNext path). */
  function denyPage(reason: DenyReason, next: string, login?: string): Response {
    return new Response(forbiddenPage(reason, { login, pairing: opts.pairing, next }), {
      status: reason === 'rate-limited' ? 429 : 403,
      headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-type': 'text/html; charset=utf-8', ...FRAME_GUARD_HEADERS },
    });
  }

  function denyResponse(d: Extract<AuthDecision, { kind: 'deny' }>, req: Request): Response {
    const status = d.reason === 'rate-limited' ? 429 : 403;
    const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
    if (d.reason === 'bad-origin' || !wantsHtml(req)) {
      const text = d.reason === 'bad-origin' ? 'Forbidden: cross-origin WebSocket' : `Forbidden: ${d.reason}`;
      return new Response(text + '\n', { status, headers: { ...headers, 'content-type': 'text/plain; charset=utf-8' } });
    }
    // the page the browser asked for (without any token), so pairing on this page lands where it was going
    let next = '/';
    try {
      const u = new URL(req.url);
      next = safeNext(u.pathname + u.search + u.hash) ?? '/';
    } catch {
      /* keep '/' */
    }
    return denyPage(d.reason, next, d.login);
  }

  /** The private page's form: a pasted link, a bare code, the token, or a typed short code → 303 + session cookie. */
  async function pairForm(req: Request, peer: string | null | undefined, text: string): Promise<Response> {
    const url = new URL(req.url);
    if (!originAllowed(req, opts.allowedOrigins)) {
      return new Response('Forbidden: cross-origin request\n', { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
    }
    const fields = new URLSearchParams(text);
    const next = safeNext(fields.get('next') ?? '/') ?? '/';
    const given = tokenFromInput(fields.get('token') ?? '');
    const key = pairLimitKey(req, peer);
    const ok = !!given && given.length <= 2048 && (sameSecret(given, token) || devices.consumePairCode(given) || shortCode(given, key));
    if (!ok) {
      if (limiter.blocked(key)) return denyPage('rate-limited', next);
      limiter.fail(key);
      return denyPage('bad-token', next);
    }
    // Already paired (the form used twice): keep that session instead of listing the browser twice.
    const current = readCookie(req, SESSION_COOKIE);
    const kept = current ? devices.verify(current) : undefined;
    const app = fields.get('app') === '1';
    const name = cleanDeviceName(`${deviceNameFromUserAgent(req.headers.get('user-agent'))}${app ? HOME_SCREEN_SUFFIX : ''}`);
    const secret = kept && current ? current : newSession(req, name).secret;
    const headers = new Headers({ location: next, 'cache-control': 'no-store' });
    headers.append('set-cookie', cookie(req, url, SESSION_COOKIE, secret));
    headers.append('set-cookie', clearCookie(req, url, TOKEN_COOKIE));
    return new Response(null, { status: 303, headers });
  }

  async function pair(req: Request, peer?: string | null): Promise<Response> {
    if (req.method !== 'POST') return json({ error: 'Use POST with {"token": "…", "device": "a name"}' }, 405, { allow: 'POST' });
    // Read at most PAIR_BODY_MAX bytes: this route answers anyone, and a chunked body has no Content-Length to refuse.
    const isForm = (req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/x-www-form-urlencoded');
    const text = await readTextCapped(req, PAIR_BODY_MAX).catch(() => '');
    if (text === null) {
      if (isForm) return new Response('That is too long for a pairing link.\n', { status: 413, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
      return json({ error: 'Request too large' }, 413);
    }
    if (isForm) return pairForm(req, peer, text);
    let body: { token?: unknown; device?: unknown; kind?: unknown };
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      return json({ error: 'Send JSON like {"token": "…", "device": "my laptop"}' }, 400);
    }
    const given = typeof body?.token === 'string' ? tokenFromInput(body.token) : '';
    const key = pairLimitKey(req, peer);
    if (!given || !(sameSecret(given, token) || devices.consumePairCode(given) || shortCode(given, key))) {
      // Only a wrong token counts, and only a wrong token is refused while the address waits (see PAIR_FAILURE_LIMIT).
      const wait = limiter.blocked(key);
      if (wait) return json({ error: 'Too many wrong pairing attempts. Wait a few minutes and try again.' }, 429, { 'retry-after': String(Math.ceil(wait / 1000)) });
      limiter.fail(key);
      return json({ error: 'That pairing token doesn’t match this server.' }, 403);
    }
    const { secret, device } = newSession(req, typeof body.device === 'string' ? body.device : undefined, pairKind(body));
    return json({ cookie: `${SESSION_COOKIE}=${secret}`, deviceId: device.id, name: device.name, ...(device.kind ? { kind: device.kind } : {}) });
  }

  function rotateToken(): void {
    token = newToken();
    writeFileAtomic(tokenFile, token + '\n', 0o600);
    log('auth', `new pairing token written to ${tokenFile} — earlier pairing links no longer work`);
    emit({ deviceIds: [], token: true });
  }

  function revoke(ids: string[]): string[] {
    const gone = devices.revoke(ids);
    if (gone.length) log('auth', `signed out ${gone.length} device${gone.length === 1 ? '' : 's'}`);
    emit({ deviceIds: gone, token: false });
    return gone;
  }

  function api(req: Request, url: URL, d: AllowDecision): Promise<Response> | null {
    const path = url.pathname;
    if (path !== '/api/session' && path !== '/api/devices' && !path.startsWith('/api/devices/')) return null;
    return (async () => {
      const writes = req.method !== 'GET' && req.method !== 'HEAD';
      if (writes && !originAllowed(req, opts.allowedOrigins)) return json({ error: 'Forbidden: cross-origin request' }, 403);
      const current = d.deviceId ? devices.get(d.deviceId) : undefined;

      if (path === '/api/session') {
        if (writes) return json({ error: 'Method not allowed' }, 405, { allow: 'GET' });
        return json({ ...opts.sessionInfo?.(), via: d.via, user: d.via === 'tailnet' ? d.user : null, deviceId: current?.id ?? null, deviceName: current?.name ?? null });
      }
      if (path === '/api/devices') {
        if (writes) return json({ error: 'Method not allowed' }, 405, { allow: 'GET' });
        return json({
          via: d.via,
          currentId: current?.id ?? null,
          devices: devices.list().map((x) => ({ ...x, current: x.id === current?.id })),
        });
      }
      const rest = path.slice('/api/devices/'.length);
      if (rest === 'rotate-token' && req.method === 'POST') {
        const body = (await req.json().catch(() => ({}))) as { revokeAll?: unknown };
        rotateToken();
        let revoked: string[] = [];
        if (body?.revokeAll === true) {
          devices.clearPairCodes();
          revoked = devices.revokeAllExcept(current?.id ?? null);
          emit({ deviceIds: revoked, token: false });
        }
        return json({ ok: true, tokenFile, revoked: revoked.length });
      }
      if (rest === 'revoke-others' && req.method === 'POST') {
        const others = devices.list().map((x) => x.id).filter((id) => id !== current?.id);
        return json({ ok: true, revoked: revoke(others).length });
      }
      if (rest === 'pair-link' && req.method === 'POST') {
        const { code, short, expiresAt } = devices.newPairCode();
        return json({ code, short, expiresAt, path: `/?token=${code}` });
      }
      if (/^d-[0-9a-f]{6,32}$/.test(rest) && req.method === 'DELETE') {
        if (!devices.get(rest)) return json({ error: 'That device is not paired (any more).' }, 404);
        // Signing out this device keeps its (now dead) cookie: the next page load then says "signed out" instead of
        // the first-visit page.
        const self = rest === current?.id;
        revoke([rest]);
        return json({ ok: true, signedOut: self });
      }
      return json({ error: 'Not found' }, 404);
    })();
  }

  return {
    get token() {
      return token;
    },
    tokenFile,
    devices,
    check,
    denyResponse,
    pair,
    api,
    rotateToken,
    onRevoke(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
