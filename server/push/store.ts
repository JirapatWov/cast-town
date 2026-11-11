// <dataDir>/push.json: this install's VAPID key pair and the paired devices that turned notifications on, one
// subscription per device. 0600, written atomically, never logged: it holds the private key and each subscription's
// endpoint and auth secret (capabilities to message that device). "Delete all CAST data" removes it.
// An unreadable file means new keys — and every subscription goes, because they are bound to the old key.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { log, writeFileAtomic } from '../util';
import { newVapidKeys, validVapidKeys, type VapidKeys } from './vapid';

const FILE_VERSION = 1;
export const MAX_SUBSCRIPTIONS = 50;

export interface PushPrefs {
  /** Someone waits for an OK, an answer or a plan. */
  waiting: boolean;
  /** A team run finished or failed. */
  runs: boolean;
  /** Someone stopped with an error. */
  errors: boolean;
}
export const DEFAULT_PREFS: PushPrefs = { waiting: true, runs: true, errors: false };

export interface PushSubscriptionRecord {
  deviceId: string;
  endpoint: string;
  /** base64url, 65 bytes */
  p256dh: string;
  /** base64url, 16 bytes */
  auth: string;
  /** The page origin it was made on (https://machine.tailnet.ts.net:8443): links in its notifications go there. */
  origin: string;
  prefs: PushPrefs;
  createdAt: number;
  lastOkAt?: number;
  /** What the push service last said when it refused (status + its first words), for Settings. */
  lastError?: string;
  failures: number;
}

export interface PushStore {
  readonly file: string;
  readonly vapid: VapidKeys;
  list(): PushSubscriptionRecord[];
  get(deviceId: string): PushSubscriptionRecord | undefined;
  /** Add or replace this device's subscription. */
  put(sub: PushSubscriptionRecord): void;
  update(deviceId: string, patch: Partial<Omit<PushSubscriptionRecord, 'deviceId'>>): void;
  /** Drop these devices' subscriptions; returns how many went. */
  remove(deviceIds: string[]): number;
  /** Drop subscriptions by endpoint (the push service said it is gone). */
  removeEndpoint(endpoint: string): void;
  /** Stop writing push.json (shutdown: a send still under way must not write the file back after a data wipe). */
  close(): void;
}

const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
export function cleanPrefs(raw: unknown, base: PushPrefs = DEFAULT_PREFS): PushPrefs {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Partial<PushPrefs>;
  return { waiting: bool(p.waiting, base.waiting), runs: bool(p.runs, base.runs), errors: bool(p.errors, base.errors) };
}

function sanitize(list: unknown): PushSubscriptionRecord[] {
  if (!Array.isArray(list)) return [];
  const out: PushSubscriptionRecord[] = [];
  for (const s of list as Partial<PushSubscriptionRecord>[]) {
    if (!s || typeof s.deviceId !== 'string' || typeof s.endpoint !== 'string' || typeof s.p256dh !== 'string' || typeof s.auth !== 'string') continue;
    out.push({
      deviceId: s.deviceId,
      endpoint: s.endpoint,
      p256dh: s.p256dh,
      auth: s.auth,
      origin: typeof s.origin === 'string' ? s.origin : '',
      prefs: cleanPrefs(s.prefs),
      createdAt: typeof s.createdAt === 'number' ? s.createdAt : Date.now(),
      ...(typeof s.lastOkAt === 'number' ? { lastOkAt: s.lastOkAt } : {}),
      ...(typeof s.lastError === 'string' ? { lastError: s.lastError.slice(0, 300) } : {}),
      failures: typeof s.failures === 'number' ? s.failures : 0,
    });
  }
  return out;
}

export function createPushStore(dataDir: string): PushStore {
  const file = join(dataDir, 'push.json');
  let vapid: VapidKeys | null = null;
  let subs: PushSubscriptionRecord[] = [];
  let closed = false;
  if (existsSync(file)) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as { vapid?: unknown; subscriptions?: unknown };
      if (!validVapidKeys(raw?.vapid)) throw new Error('no usable key');
      vapid = raw.vapid;
      subs = sanitize(raw.subscriptions);
    } catch {
      log('push', 'could not read push.json: made a new Web Push key; devices must turn notifications on again');
    }
  }
  const save = () => {
    if (closed) return;
    try {
      writeFileAtomic(file, `${JSON.stringify({ version: FILE_VERSION, vapid, subscriptions: subs }, null, 2)}\n`, 0o600);
    } catch (err) {
      log('push', `could not save push.json: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  if (!vapid) {
    vapid = newVapidKeys();
    subs = [];
    save();
  }
  const keys = vapid;
  return {
    file,
    vapid: keys,
    close() {
      closed = true;
    },
    list: () => subs.map((s) => ({ ...s, prefs: { ...s.prefs } })),
    get(deviceId) {
      const s = subs.find((x) => x.deviceId === deviceId);
      return s ? { ...s, prefs: { ...s.prefs } } : undefined;
    },
    put(sub) {
      // one per device, and one device per endpoint (a browser that paired again keeps a single subscription)
      subs = subs.filter((s) => s.deviceId !== sub.deviceId && s.endpoint !== sub.endpoint);
      subs.push({ ...sub, prefs: { ...sub.prefs } });
      if (subs.length > MAX_SUBSCRIPTIONS) {
        const seen = (s: PushSubscriptionRecord) => s.lastOkAt ?? s.createdAt;
        subs = [...subs].sort((a, b) => seen(b) - seen(a)).slice(0, MAX_SUBSCRIPTIONS);
      }
      save();
    },
    update(deviceId, patch) {
      const s = subs.find((x) => x.deviceId === deviceId);
      if (!s) return;
      Object.assign(s, patch);
      save();
    },
    remove(deviceIds) {
      const set = new Set(deviceIds);
      const before = subs.length;
      subs = subs.filter((s) => !set.has(s.deviceId));
      if (subs.length !== before) save();
      return before - subs.length;
    },
    removeEndpoint(endpoint) {
      const before = subs.length;
      subs = subs.filter((s) => s.endpoint !== endpoint);
      if (subs.length !== before) save();
    },
  };
}
