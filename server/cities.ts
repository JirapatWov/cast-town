// Cities this hub knows (shared/cities.ts): the store (<dataDir>/cities.json), pairing with another machine's CAST
// server, and a short-lived status cache fed by probes and by the proxy (server/city-proxy.ts).
//
// What is kept: per city only the device-session cookie that server gave this hub when it paired (POST /api/pair,
// contract C2), never the pairing token. A server without POST /api/pair is refused (every CAST with the city proxy
// feature has it): its only other way in, `GET /?token=`, would make the token itself the stored cookie. A renewed
// session cookie replaces the stored one (adoptCookie, fed by the proxy and the probe). cities.json is 0600 and written
// atomically; cookies and tokens are never logged.
//
// Why each city is verified before it is stored: the address must answer /api/version as CAST with the city proxy
// feature (an older CAST can't be proxied correctly), and must not be this server itself (instanceId) — a hub that
// proxies to itself under another name would loop.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import {
  CITY_ID_RE, CITY_PROTOCOL, CITY_PROXY_FEATURE, MAX_CITIES, MAX_CITY_NAME,
  type AddCityInput, type CitiesResponse, type CityErrorCode, type CityStatus, type CitySummary, type VersionInfo,
} from '../shared/cities';
import { errorMessage, log, slugify, uniqueName, UserError, writeFileAtomic } from './util';

export type FetchLike = (input: string, init?: RequestInit & { decompress?: boolean }) => Promise<Response>;

/** A failure adding or re-pairing a city, in words for the user, with a code the client can branch on. */
export class CityError extends UserError {
  constructor(message: string, readonly code: CityErrorCode, readonly status = 400) {
    super(message);
    this.name = 'CityError';
  }
}

export interface CityRecord {
  id: string;
  name: string;
  url: string; // origin, no path, no trailing slash
  cookie: string; // `name=value` this hub sends to that server; never shown, never logged
  addedAt: number;
  instanceId?: string; // that server's /api/version instanceId when it was paired (spots the same machine twice)
  pairedAt?: number;
}

interface Known {
  status: CityStatus;
  version?: string;
  error?: string;
  at: number;
}

const PAIR_TIMEOUT_MS = 8000;
const PROBE_TIMEOUT_MS = 2500;
const STATUS_TTL_MS = 10_000;
/** A cookie this hub may store and send: one `name=value` pair, nothing that could smuggle another header field. */
const COOKIE_PAIR = /^[A-Za-z0-9_-]{1,64}=[^;\s,"\\]{1,1024}$/;
/** A pairing token: CAST writes 32 base64url chars; accept anything token-like within reason. */
const TOKEN_RE = /^[A-Za-z0-9._~+/=-]{16,512}$/;
const SESSION_COOKIE = 'rlt_session';

// ───────────────────────── input checks (pure; unit-tested) ─────────────────────────

/** An address the user typed → the origin of that CAST server ("http://192.168.1.20:4860"). Only http(s), no
 *  user:password@, no path. Without a scheme: https for a tailnet name (tailscale serve is https), else http. */
export function normalizeCityUrl(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new CityError('Enter the address of the other machine’s CAST.', 'invalid');
  let text = raw.trim();
  if (text.length > 2048) throw new CityError('That address is too long.', 'invalid');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `${/^[^/:?#]+\.ts\.net(?:[:/?#]|$)/i.test(text) ? 'https' : 'http'}://${text}`;
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    throw new CityError('That isn’t a web address. It looks like https://machine.tailnet.ts.net:8443 or http://192.168.1.20:4860.', 'invalid');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new CityError('The address must start with http:// or https://.', 'invalid');
  if (u.username || u.password) throw new CityError('Leave the user name and password out of the address — pairing is done with the token.', 'invalid');
  if (!u.hostname) throw new CityError('That address has no machine name in it.', 'invalid');
  return u.origin;
}

/** The address the user typed, checked against the pairing token: a token pasted into the Address field would come
 *  back in "could not reach <host>" (hosts are the address's own text), so it is refused without repeating it. */
export function cityUrlFrom(typed: string, token: string): string {
  const t = typed.trim();
  const bare = t.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/[/?#].*$/, '');
  const tokenLike = /^[A-Za-z0-9_-]{20,}$/.test(bare) && /[A-Z]/.test(bare) && /[a-z]/.test(bare);
  if ((token && t.toLowerCase().includes(token.toLowerCase())) || tokenLike) {
    throw new CityError('The Address field holds a pairing token. Put the other machine’s address there, and the token in the pairing field.', 'invalid');
  }
  return normalizeCityUrl(t);
}

/** The pairing field: a whole pairing link (any path, ?token=…) or a bare token. `url` is the link's origin. */
export function parsePairing(raw: unknown): { token: string; url: string | null } {
  if (typeof raw !== 'string' || !raw.trim()) throw new CityError('Paste the pairing link or token of the other machine.', 'invalid');
  const text = raw.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    let u: URL;
    try {
      u = new URL(text);
    } catch {
      throw new CityError('That pairing link is cut off — copy the whole link again.', 'invalid');
    }
    const token = u.searchParams.get('token')?.trim() ?? '';
    if (!token) throw new CityError('That link has no token in it. Copy the whole pairing link — it ends in ?token=…', 'invalid');
    if (!TOKEN_RE.test(token)) throw new CityError('The token in that link looks cut off — copy the whole link again.', 'invalid');
    return { token, url: u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null };
  }
  if (!TOKEN_RE.test(text)) throw new CityError('That doesn’t look like a pairing link or token.', 'invalid');
  return { token: text, url: null };
}

/** A display name: no control characters, single spaces, at most MAX_CITY_NAME characters; '' when nothing is left. */
export function cleanCityName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return [...raw.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim()].slice(0, MAX_CITY_NAME).join('').trim();
}

/** The machine part of an address for a default name: "studio" of studio.tail1.ts.net, an IP address whole. */
export function hostLabel(url: string): string {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    return '';
  }
  if (host.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host;
  return host.split('.')[0] ?? '';
}

/** A stable id for a new city: from its name, else its host; never 'home'; unique among `taken`. */
export function cityIdFor(name: string, url: string, taken: (id: string) => boolean): string {
  const label = hostLabel(url);
  const host = /^[\d.[\]:a-f]+$/i.test(label) && /[.:]/.test(label) ? '' : label; // an IP address makes a poor id
  let base = slugify(name, 28) || slugify(host, 28) || 'city';
  if (base === 'home') base = 'home-city';
  const id = uniqueName(base, (c) => taken(c) || !CITY_ID_RE.test(c));
  return CITY_ID_RE.test(id) ? id : uniqueName('city', taken);
}

/** The first `name=value` of Set-Cookie lines for one of `names` (in that order of preference; by default the device
 *  session only — never the legacy cookie, whose value is the pairing token); null when none, or when the server is
 *  clearing it (empty value / Max-Age=0). */
export function pickCookie(setCookies: string[], names: string[] = [SESSION_COOKIE]): string | null {
  for (const name of names) {
    for (const line of setCookies) {
      const first = line.split(';')[0]!.trim();
      const eq = first.indexOf('=');
      if (eq <= 0 || first.slice(0, eq).trim() !== name) continue;
      const value = first.slice(eq + 1).trim();
      if (!value || /;\s*max-age=0\b/i.test(line)) continue;
      const pair = `${name}=${value}`;
      if (COOKIE_PAIR.test(pair)) return pair;
    }
  }
  return null;
}

function setCookiesOf(res: Response): string[] {
  const h = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === 'function') return h.getSetCookie();
  const one = res.headers.get('set-cookie');
  return one ? [one] : [];
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// ───────────────────────── talking to another CAST server ─────────────────────────

async function timedFetch(f: FetchLike, url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await f(url, { ...init, signal: ctl.signal, redirect: 'manual' });
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(res: Response): Promise<unknown> {
  try {
    const text = await res.text();
    return text.length <= 64 * 1024 ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function asVersion(x: unknown): VersionInfo | null {
  if (!x || typeof x !== 'object') return null;
  const v = x as Partial<VersionInfo>;
  if (v.app !== 'cast' || typeof v.version !== 'string') return null;
  return {
    app: 'cast',
    version: v.version.slice(0, 40),
    protocol: typeof v.protocol === 'number' ? v.protocol : 0,
    features: Array.isArray(v.features) ? v.features.filter((s): s is string => typeof s === 'string').slice(0, 64) : [],
    instanceId: typeof v.instanceId === 'string' ? v.instanceId.slice(0, 64) : '',
    paired: v.paired === true,
    ...(typeof v.name === 'string' ? { name: cleanCityName(v.name) } : {}),
  };
}

export interface ProbeResult {
  info: VersionInfo | null;
  /** Session cookie the server handed out on this request (a renewed session), if any. */
  cookie: string | null;
}

/** GET <base>/api/version (with the city's cookie when given). Throws CityError('unreachable') when nothing answers. */
export async function fetchVersion(f: FetchLike, base: string, cookie: string | null, ms = PROBE_TIMEOUT_MS): Promise<ProbeResult> {
  let res: Response;
  try {
    res = await timedFetch(f, `${base}/api/version`, { headers: { accept: 'application/json', ...(cookie ? { cookie } : {}) } }, ms);
  } catch (err) {
    throw new CityError(`CAST could not reach ${hostOf(base)}. Check the address, and that CAST is running there.`, 'unreachable', 502);
  }
  const fresh = pickCookie(setCookiesOf(res), [SESSION_COOKIE]);
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    return { info: null, cookie: fresh };
  }
  return { info: asVersion(await readJson(res)), cookie: fresh };
}

/** Is `base` a CAST server that can be a city? Throws a CityError that says what is wrong. */
export async function verifyCastServer(f: FetchLike, base: string, ownInstanceId: string, ms = PAIR_TIMEOUT_MS): Promise<VersionInfo> {
  const { info } = await fetchVersion(f, base, null, ms);
  if (!info) {
    // A CAST from before cities has no /api/version (it sits behind sign-in there), but its /api/health says CAST.
    let oldCast = false;
    try {
      const res = await timedFetch(f, `${base}/api/health`, { headers: { accept: 'application/json' } }, ms);
      const body = (await readJson(res)) as { name?: unknown } | null;
      oldCast = res.ok && body?.name === 'cast';
    } catch {
      /* answered /api/version but not this: not CAST */
    }
    if (oldCast) throw new CityError(`${hostOf(base)} runs an older CAST — update it first.`, 'too-old');
    throw new CityError(`${hostOf(base)} answered, but it isn’t a CAST server. Check the address and port.`, 'not-cast');
  }
  if (!info.features.includes(CITY_PROXY_FEATURE) || info.protocol > CITY_PROTOCOL) {
    throw new CityError(
      info.protocol > CITY_PROTOCOL ? `${hostOf(base)} runs a newer CAST than this one — update this machine first.` : `${hostOf(base)} runs an older CAST — update it first.`,
      'too-old',
    );
  }
  if (info.instanceId && info.instanceId === ownInstanceId) {
    throw new CityError('That address is this CAST itself. Add a different machine.', 'self');
  }
  return info;
}

/** Pair with that server once: POST /api/pair trades the token for a device-session cookie, which is all the hub keeps.
 *  Never the browser's `GET /?token=` link: that would store the token itself as the cookie.
 *  Throws CityError('bad-token' | 'rate-limited' | 'too-old' | 'unreachable' | 'not-cast'). */
export async function pairWithServer(f: FetchLike, base: string, token: string, device: string, ms = PAIR_TIMEOUT_MS): Promise<{ cookie: string }> {
  const unreachable = () => new CityError(`CAST could not reach ${hostOf(base)}. Check the address, and that CAST is running there.`, 'unreachable', 502);
  const badToken = () => new CityError(`That pairing link or token doesn’t match ${hostOf(base)}. Copy it again from that machine.`, 'bad-token');
  const limited = () => new CityError('Too many wrong pairing tries on that machine — wait a minute, then try again.', 'rate-limited', 429);

  let res: Response;
  try {
    res = await timedFetch(f, `${base}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ token, device }),
    }, ms);
  } catch {
    throw unreachable();
  }
  const json = (res.headers.get('content-type') ?? '').includes('application/json');
  if (res.ok && json) {
    const body = (await readJson(res)) as { cookie?: unknown } | null;
    const cookie = typeof body?.cookie === 'string' ? body.cookie.trim() : '';
    if (cookie.startsWith(`${SESSION_COOKIE}=`) && COOKIE_PAIR.test(cookie)) return { cookie };
    // A 200 without a usable cookie in the body: maybe it set the session the browser way.
    const fromHeader = pickCookie(setCookiesOf(res));
    if (fromHeader) return { cookie: fromHeader };
    throw new CityError(`${hostOf(base)} accepted the token but gave this hub no device session. Update CAST there, then try again.`, 'not-cast', 502);
  }
  await res.body?.cancel().catch(() => {});
  if (res.status === 429) throw limited();
  if (res.status === 403 && json) throw badToken();
  // No POST /api/pair there (404/405, or the sign-in wall of a server from before device sessions)
  if (res.status === 404 || res.status === 405 || res.status === 401 || res.status === 403) {
    throw new CityError(`${hostOf(base)} runs an older CAST that can’t pair a hub (no device sessions) — update it first.`, 'too-old');
  }
  throw new CityError(`${hostOf(base)} didn’t accept the pairing (HTTP ${res.status}). Is that address a CAST server?`, 'not-cast', 502);
}

// ───────────────────────── instance id ─────────────────────────

/** This server's random instance id, kept in <dataDir>/instance-id (0600) so it survives restarts. */
export function loadOrCreateInstanceId(dataDir: string): string {
  const file = join(dataDir, 'instance-id');
  try {
    const id = readFileSync(file, 'utf8').trim();
    if (/^[a-f0-9]{16,64}$/.test(id)) return id;
  } catch {
    /* first start */
  }
  const id = randomBytes(16).toString('hex');
  writeFileAtomic(file, `${id}\n`, 0o600);
  return id;
}

/** The home city's name: C1 `cityName` when the config has it, else CAST_CITY_NAME / RLT_CITY_NAME, else the host name. */
export function homeCityName(cfg: object, env: Record<string, string | undefined> = process.env): string {
  const fromCfg = (cfg as { cityName?: unknown }).cityName;
  return cleanCityName(fromCfg) || cleanCityName(env.CAST_CITY_NAME) || cleanCityName(env.RLT_CITY_NAME) || cleanCityName(hostname()) || 'Home';
}

// ───────────────────────── the store ─────────────────────────

export interface CitiesOptions {
  dataDir: string;
  instanceId: string;
  homeName: string;
  version: string;
  fetch?: FetchLike;
  probeTimeoutMs?: number;
  pairTimeoutMs?: number;
  statusTtlMs?: number;
  now?: () => number;
}

export interface Cities {
  readonly file: string;
  list(): Promise<CitiesResponse>;
  add(input: unknown): Promise<CitySummary>;
  /** Rename (`name`) and/or re-pair (`pairing`, optionally with a new `url`). */
  update(id: string, input: unknown): Promise<CitySummary>;
  remove(id: string): boolean;
  get(id: string): CityRecord | undefined;
  /** Last known status (no probe): lets the proxy answer at once for a city that is known to be down. */
  known(id: string): Known | undefined;
  /** What the proxy just saw: the city answered, or could not be reached. */
  note(id: string, status: CityStatus, error?: string): void;
  /** That server handed this hub a renewed device-session cookie: keep it. */
  adoptCookie(id: string, cookie: string): void;
}

function loadRecords(file: string): CityRecord[] {
  if (!existsSync(file)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    const aside = `${file}.bad-${Date.now().toString(36)}`;
    try {
      renameSync(file, aside);
    } catch {
      /* leave it */
    }
    log('cities', `cities.json could not be read (${errorMessage(err)}); moved it to ${aside} and started with no cities`);
    return [];
  }
  const list = Array.isArray(raw) ? raw : Array.isArray((raw as { cities?: unknown })?.cities) ? (raw as { cities: unknown[] }).cities : [];
  const out: CityRecord[] = [];
  for (const x of list) {
    if (!x || typeof x !== 'object') continue;
    const r = x as Partial<CityRecord>;
    if (typeof r.id !== 'string' || !CITY_ID_RE.test(r.id) || r.id === 'home') continue;
    if (typeof r.url !== 'string' || typeof r.cookie !== 'string' || !COOKIE_PAIR.test(r.cookie)) continue;
    if (!r.cookie.startsWith(`${SESSION_COOKIE}=`)) {
      // an earlier build kept a server's legacy cookie (the pairing token itself): never again — add that city anew
      log('cities', `${r.id}: dropped a stored pairing token; add that city again`);
      continue;
    }
    let url: string;
    try {
      url = normalizeCityUrl(r.url);
    } catch {
      continue;
    }
    if (out.some((o) => o.id === r.id)) continue;
    out.push({
      id: r.id,
      name: cleanCityName(r.name) || r.id,
      url,
      cookie: r.cookie,
      addedAt: typeof r.addedAt === 'number' ? r.addedAt : Date.now(),
      ...(typeof r.instanceId === 'string' ? { instanceId: r.instanceId } : {}),
      ...(typeof r.pairedAt === 'number' ? { pairedAt: r.pairedAt } : {}),
    });
  }
  return out;
}

export function createCities(opts: CitiesOptions): Cities {
  const file = join(opts.dataDir, 'cities.json');
  const f: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));
  const now = opts.now ?? Date.now;
  const ttl = opts.statusTtlMs ?? STATUS_TTL_MS;
  const probeMs = opts.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  const pairMs = opts.pairTimeoutMs ?? PAIR_TIMEOUT_MS;
  const records = loadRecords(file);
  const status = new Map<string, Known>();
  const probing = new Map<string, Promise<void>>();
  const device = `CAST hub · ${opts.homeName}`.slice(0, 80);

  function save(): void {
    writeFileAtomic(file, `${JSON.stringify(records, null, 2)}\n`, 0o600);
  }

  function summary(r: CityRecord): CitySummary {
    const k = status.get(r.id);
    return {
      id: r.id,
      name: r.name,
      url: r.url,
      status: k?.status ?? 'offline',
      ...(k?.version ? { version: k.version } : {}),
      ...(k?.error ? { error: k.error } : {}),
    };
  }

  function probe(r: CityRecord): Promise<void> {
    const running = probing.get(r.id);
    if (running) return running;
    const p = (async () => {
      try {
        const { info, cookie } = await fetchVersion(f, r.url, r.cookie, probeMs);
        if (cookie) adoptCookie(r.id, cookie);
        if (!info) status.set(r.id, { status: 'error', error: `${hostOf(r.url)} no longer answers as CAST.`, at: now() });
        else if (!info.paired) status.set(r.id, { status: 'error', version: info.version, error: 'That machine no longer accepts this pairing — re-pair it.', at: now() });
        else if (info.instanceId && r.instanceId && info.instanceId !== r.instanceId) {
          // Its data folder was reset or the address now points at another machine: still works, so just remember it.
          r.instanceId = info.instanceId;
          save();
          status.set(r.id, { status: 'online', version: info.version, at: now() });
        } else status.set(r.id, { status: 'online', version: info.version, at: now() });
      } catch (err) {
        status.set(r.id, { status: 'offline', error: err instanceof CityError ? err.message : `CAST could not reach ${hostOf(r.url)}.`, at: now() });
      } finally {
        probing.delete(r.id);
      }
    })();
    probing.set(r.id, p);
    return p;
  }

  async function pairAndVerify(url: string, token: string): Promise<{ cookie: string; info: VersionInfo }> {
    const before = await verifyCastServer(f, url, opts.instanceId, pairMs);
    const { cookie } = await pairWithServer(f, url, token, device, pairMs);
    // The cookie must really open that city (and tells us its own name).
    const { info, cookie: upgraded } = await fetchVersion(f, url, cookie, pairMs);
    const kept = upgraded ?? cookie;
    if (info && !info.paired) throw new CityError(`${hostOf(url)} took the token but doesn’t accept this hub’s sign-in. Try pairing again.`, 'bad-token');
    return { cookie: kept, info: info ?? before };
  }

  function adoptCookie(id: string, cookie: string): void {
    const r = records.find((x) => x.id === id);
    if (!r || !cookie.startsWith(`${SESSION_COOKIE}=`) || !COOKIE_PAIR.test(cookie) || r.cookie === cookie) return;
    r.cookie = cookie;
    r.pairedAt = now();
    save();
    log('cities', `${id}: that machine renewed this hub's device session`);
  }

  return {
    file,
    async list() {
      const stale = records.filter((r) => {
        const k = status.get(r.id);
        return !k || now() - k.at > ttl;
      });
      await Promise.all(stale.map(probe));
      return { home: { id: 'home', name: opts.homeName, version: opts.version }, cities: records.map(summary) };
    },

    async add(input) {
      const x = (input && typeof input === 'object' ? input : {}) as Partial<AddCityInput>;
      if (records.length >= MAX_CITIES) throw new CityError(`A hub can hold at most ${MAX_CITIES} cities.`, 'limit');
      const pairing = parsePairing(x.pairing);
      const typed = typeof x.url === 'string' && x.url.trim() ? x.url : pairing.url;
      if (!typed) throw new CityError('Enter the address of the other machine’s CAST.', 'invalid');
      const url = typed === pairing.url ? normalizeCityUrl(typed) : cityUrlFrom(typed, pairing.token);
      const same = records.find((r) => r.url === url);
      if (same) throw new CityError(`That machine is already a city here (“${same.name}”).`, 'duplicate', 409);
      const { cookie, info } = await pairAndVerify(url, pairing.token);
      const twin = info.instanceId ? records.find((r) => r.instanceId === info.instanceId) : undefined;
      if (twin) throw new CityError(`That machine is already a city here (“${twin.name}”), under another address.`, 'duplicate', 409);
      const name = cleanCityName(x.name) || info.name || cleanCityName(hostLabel(url)) || 'City';
      const id = cityIdFor(name, url, (c) => records.some((r) => r.id === c));
      const rec: CityRecord = { id, name, url, cookie, addedAt: now(), pairedAt: now(), ...(info.instanceId ? { instanceId: info.instanceId } : {}) };
      records.push(rec);
      save();
      status.set(id, { status: 'online', version: info.version, at: now() });
      log('cities', `added ${id} (${hostOf(url)})`);
      return summary(rec);
    },

    async update(id, input) {
      const r = records.find((x) => x.id === id);
      if (!r) throw new CityError('There’s no such city here anymore.', 'not-found', 404);
      const x = (input && typeof input === 'object' ? input : {}) as { name?: unknown; pairing?: unknown; url?: unknown };
      let changed = false;
      if (x.name !== undefined) {
        const name = cleanCityName(x.name);
        if (!name) throw new CityError('Give the city a name.', 'invalid');
        if (name !== r.name) {
          r.name = name;
          changed = true;
        }
      }
      if (x.pairing !== undefined) {
        const pairing = parsePairing(x.pairing);
        const typed = typeof x.url === 'string' && x.url.trim() ? x.url : null;
        const url = typed ? cityUrlFrom(typed, pairing.token) : r.url;
        const other = records.find((o) => o !== r && o.url === url);
        if (other) throw new CityError(`That machine is already a city here (“${other.name}”).`, 'duplicate', 409);
        const { cookie, info } = await pairAndVerify(url, pairing.token);
        r.url = url;
        r.cookie = cookie;
        r.pairedAt = now();
        if (info.instanceId) r.instanceId = info.instanceId;
        status.set(r.id, { status: 'online', version: info.version, at: now() });
        changed = true;
        log('cities', `re-paired ${r.id} (${hostOf(url)})`);
      }
      if (changed) save();
      return summary(r);
    },

    remove(id) {
      const i = records.findIndex((x) => x.id === id);
      if (i < 0) return false;
      records.splice(i, 1);
      status.delete(id);
      save();
      log('cities', `removed ${id}`);
      return true;
    },

    get: (id) => records.find((x) => x.id === id),
    known: (id) => status.get(id),
    note(id, s, error) {
      if (!records.some((r) => r.id === id)) return;
      const prev = status.get(id);
      status.set(id, { status: s, version: prev?.version, ...(error ? { error } : {}), at: now() });
    },
    adoptCookie,
  };
}
