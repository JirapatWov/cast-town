// DeviceBook: the browsers (and scripts) paired with this server, one session each, kept in <dataDir>/devices.json.
//
// Pairing hands out a random session secret in the `rlt_session` cookie; the file keeps only its SHA-256, so a copy of
// the data folder (a backup, a support bundle) can't be replayed as a login. A device can be signed out on its own
// (revoke) without changing the pairing token, and the token can change without signing anyone out.
//
// Also here: one-time pairing codes ("Pair a phone" in Settings). A code is a short-lived, single-use stand-in for the
// pairing token, so a link shown on screen or in a QR code stops working once used or after a few minutes — and a
// paired browser never needs to see the real token at all. Each code comes as two secrets for the same pairing: the
// long one (144 bits) for links and QR codes, and a short one a person can type (12 Crockford base32 characters,
// 60 bits, shown XXXX-XXXX-XXXX) — into CAST on a phone's Home Screen, which has its own sign-in and no address bar.
// Using either ends both. auth.ts checks short codes only while the address is not rate-limited (PAIR_FAILURE_LIMIT).
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { log, writeFileAtomic } from './util';

const FILE_VERSION = 1;
/** A device not seen for this long is forgotten (its cookie would have expired too). */
export const SESSION_MAX_IDLE_MS = 365 * 24 * 60 * 60 * 1000;
/** lastSeenAt is refreshed at most this often (it is for the device list, not for security). */
const SEEN_GRANULARITY_MS = 60_000;
const SAVE_DEBOUNCE_MS = 5_000;
/** Keep the list bounded: scripts that pair on every run must not grow the file forever. Oldest-seen go first. */
const MAX_DEVICES = 200;
export const PAIR_CODE_TTL_MS = 10 * 60 * 1000;
const MAX_PAIR_CODES = 20;
const NAME_MAX = 60;
/** Crockford's base32: no I, L, O or U, so nothing typed can be misread. */
export const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const SHORT_CODE_LENGTH = 12;
const SHORT_CODE_RE = /^[0-9A-HJKMNP-TV-Z]{12}$/;

/** What a person typed → the short code it means: case, spaces and dashes don't matter, and I/L read as 1, O as 0.
 *  null when it can't be a short code. */
export function normalizeShortCode(input: string): string | null {
  const s = input.toUpperCase().replace(/[\s\-\u2010-\u2015\u2212]+/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  return SHORT_CODE_RE.test(s) ? s : null;
}

function newShortCode(): string {
  let s = '';
  for (let i = 0; i < SHORT_CODE_LENGTH; i++) s += CROCKFORD[randomInt(32)];
  return s;
}

/** What kind of client a session belongs to when it isn't a browser: 'app' = the CAST menu-bar app on the Mac that
 *  runs this server (Settings labels it and never offers it as "this device"). Absent: a browser or a script. */
export type DeviceKind = 'app';

export interface DeviceRecord {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
  userAgent?: string;
  kind?: DeviceKind;
  /** sha256 (hex) of the session secret. */
  hash: string;
}

export interface DeviceInfo {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
  kind?: DeviceKind;
}

export interface DeviceBook {
  readonly file: string;
  /** A new session: returns the secret for the cookie (never stored) and the device. */
  create(input: { name?: string; userAgent?: string | null; kind?: DeviceKind }): { secret: string; device: DeviceRecord };
  /** The device a session secret belongs to (and note that it was seen), or undefined. */
  verify(secret: string): DeviceRecord | undefined;
  get(id: string): DeviceRecord | undefined;
  list(): DeviceInfo[];
  /** Forget devices; returns the ids that existed. */
  revoke(ids: string[]): string[];
  /** Forget every device except `keep`; returns the revoked ids. */
  revokeAllExcept(keep: string | null): string[];
  /** Mint a one-time pairing code: the long code (links, QR codes) and its short twin (typed), one pairing. */
  newPairCode(): { code: string; short: string; expiresAt: number };
  /** True (and the code, both forms, is used up) when `code` is a live pairing code. short: `code` is what a person
   *  typed for a short code (normalizeShortCode) instead of a long code. */
  consumePairCode(code: string, opts?: { short?: boolean }): boolean;
  /** Drop every unused pairing code ("sign everyone out" must also end links shown but not opened yet). */
  clearPairCodes(): void;
  /** Write pending lastSeenAt changes now (shutdown). */
  flush(): void;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Printable, single-line, bounded: names come from user agents and from POST /api/pair. */
export function cleanDeviceName(name: string | null | undefined): string {
  const s = (name ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s.slice(0, NAME_MAX);
}

/** "Chrome on macOS", "Safari on iPhone", … from a User-Agent; good enough to tell your own devices apart. */
export function deviceNameFromUserAgent(ua: string | null | undefined): string {
  if (!ua) return 'Unknown device';
  const os = /iPhone/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) ? 'iPad'
    : /Android/.test(ua) ? 'Android'
    : /CrOS/.test(ua) ? 'ChromeOS'
    : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
    : /Windows/.test(ua) ? 'Windows'
    : /Linux/.test(ua) ? 'Linux'
    : '';
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /SamsungBrowser\//.test(ua) ? 'Samsung Internet'
    : /Firefox\/|FxiOS\//.test(ua) ? 'Firefox'
    : /OPR\//.test(ua) ? 'Opera'
    : /Chrome\/|CriOS\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari'
    : /curl\//i.test(ua) ? 'curl'
    : /^Bun\//.test(ua) ? 'Bun script'
    : '';
  if (browser && os) return `${browser} on ${os}`;
  return browser || os || 'Unknown device';
}

function sanitize(raw: unknown): DeviceRecord[] {
  const list = (raw as { devices?: unknown } | null)?.devices;
  if (!Array.isArray(list)) return [];
  const out: DeviceRecord[] = [];
  for (const d of list as Partial<DeviceRecord>[]) {
    if (!d || typeof d.id !== 'string' || typeof d.hash !== 'string' || !/^[0-9a-f]{64}$/.test(d.hash)) continue;
    const createdAt = typeof d.createdAt === 'number' ? d.createdAt : Date.now();
    out.push({
      id: d.id,
      name: cleanDeviceName(typeof d.name === 'string' ? d.name : '') || 'Unknown device',
      createdAt,
      lastSeenAt: typeof d.lastSeenAt === 'number' ? d.lastSeenAt : createdAt,
      ...(typeof d.userAgent === 'string' ? { userAgent: d.userAgent.slice(0, 300) } : {}),
      ...(d.kind === 'app' ? { kind: d.kind } : {}),
      hash: d.hash,
    });
  }
  return out;
}

export function createDeviceBook(dataDir: string, now: () => number = Date.now): DeviceBook {
  const file = join(dataDir, 'devices.json');
  let devices: DeviceRecord[] = [];
  if (existsSync(file)) {
    try {
      devices = sanitize(JSON.parse(readFileSync(file, 'utf8')));
    } catch (err) {
      // Unreadable: start empty (everyone pairs again) rather than refuse to start. Never guess a session valid.
      log('auth', `could not read ${file} (${err instanceof Error ? err.message : String(err)}); paired devices must pair again`);
    }
  }
  const before = devices.length;
  devices = devices.filter((d) => now() - d.lastSeenAt < SESSION_MAX_IDLE_MS);
  const byHash = new Map(devices.map((d) => [d.hash, d]));
  /** One record per pairing code, found by the hash of either of its secrets. */
  type PairCode = { long: string; short: string; expiresAt: number };
  const codes = new Map<string, PairCode>(); // sha256(long code) → record (insertion order = age)
  const shortIndex = new Map<string, PairCode>(); // sha256(short code) → the same record
  let timer: ReturnType<typeof setTimeout> | null = null;

  function save() {
    if (timer) clearTimeout(timer);
    timer = null;
    try {
      writeFileAtomic(file, `${JSON.stringify({ version: FILE_VERSION, devices }, null, 2)}\n`, 0o600);
    } catch (err) {
      log('auth', `could not save ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  function saveSoon() {
    if (!timer) timer = setTimeout(save, SAVE_DEBOUNCE_MS);
  }
  if (devices.length !== before) save();

  function forgetCode(c: PairCode) {
    codes.delete(c.long);
    shortIndex.delete(c.short);
  }
  function dropCodes() {
    const t = now();
    for (const c of [...codes.values()]) if (c.expiresAt <= t) forgetCode(c);
  }

  function remove(pred: (d: DeviceRecord) => boolean): string[] {
    const gone = devices.filter(pred);
    if (!gone.length) return [];
    devices = devices.filter((d) => !pred(d));
    for (const d of gone) byHash.delete(d.hash);
    save();
    return gone.map((d) => d.id);
  }

  return {
    file,
    create({ name, userAgent, kind }) {
      const secret = randomBytes(32).toString('base64url');
      const t = now();
      const device: DeviceRecord = {
        id: `d-${randomBytes(6).toString('hex')}`,
        name: cleanDeviceName(name) || deviceNameFromUserAgent(userAgent),
        createdAt: t,
        lastSeenAt: t,
        ...(userAgent ? { userAgent: userAgent.slice(0, 300) } : {}),
        ...(kind === 'app' ? { kind } : {}),
        hash: sha256(secret),
      };
      devices.push(device);
      byHash.set(device.hash, device);
      if (devices.length > MAX_DEVICES) {
        const oldest = [...devices].sort((a, b) => a.lastSeenAt - b.lastSeenAt).slice(0, devices.length - MAX_DEVICES);
        const ids = new Set(oldest.map((d) => d.id));
        devices = devices.filter((d) => !ids.has(d.id));
        for (const d of oldest) byHash.delete(d.hash);
      }
      save();
      return { secret, device };
    },
    verify(secret) {
      if (!secret || secret.length > 200) return undefined;
      const d = byHash.get(sha256(secret));
      if (!d) return undefined;
      const t = now();
      if (t - d.lastSeenAt > SESSION_MAX_IDLE_MS) {
        remove((x) => x === d);
        return undefined;
      }
      if (t - d.lastSeenAt >= SEEN_GRANULARITY_MS) {
        d.lastSeenAt = t;
        saveSoon();
      }
      return d;
    },
    get(id) {
      return devices.find((d) => d.id === id);
    },
    list() {
      return [...devices]
        .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
        .map(({ id, name, createdAt, lastSeenAt, kind }) => ({ id, name, createdAt, lastSeenAt, ...(kind ? { kind } : {}) }));
    },
    revoke(ids) {
      const set = new Set(ids);
      return remove((d) => set.has(d.id));
    },
    revokeAllExcept(keep) {
      return remove((d) => d.id !== keep);
    },
    newPairCode() {
      dropCodes();
      // A handful at most: each "Pair a phone" press mints one; older unused ones are dropped first.
      while (codes.size >= MAX_PAIR_CODES) forgetCode(codes.values().next().value!);
      const code = randomBytes(18).toString('base64url');
      let short = newShortCode();
      while (shortIndex.has(sha256(short))) short = newShortCode();
      const expiresAt = now() + PAIR_CODE_TTL_MS;
      const rec: PairCode = { long: sha256(code), short: sha256(short), expiresAt };
      codes.set(rec.long, rec);
      shortIndex.set(rec.short, rec);
      return { code, short, expiresAt };
    },
    consumePairCode(code, o = {}) {
      if (!code || code.length > 200) return false;
      dropCodes();
      let rec: PairCode | undefined;
      if (o.short) {
        const s = normalizeShortCode(code);
        rec = s ? shortIndex.get(sha256(s)) : undefined;
      } else {
        rec = codes.get(sha256(code));
      }
      if (!rec) return false;
      forgetCode(rec);
      return true;
    },
    clearPairCodes() {
      codes.clear();
      shortIndex.clear();
    },
    flush() {
      if (timer) save();
    },
  };
}
