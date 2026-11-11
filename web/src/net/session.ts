// This browser's sign-in, from the page's side: what GET /api/session says (how it got in, which paired device it is,
// whether the server offers the terminal and who its shells run as), the paired-device API of Settings → Devices,
// and the watch that notices when this device was signed out (from another device, or by a server reset) so the page
// shows the server's "signed out" page instead of reconnecting forever.
//
// Devices and pairing belong to the server this browser is paired with — the hub (hubUrl): a city opened through it
// is paired with the hub, not with the browser. Facts about the city on screen (its terminal) come from apiUrl.
import type { TerminalAccess } from '../../../shared/terminal-protocol';
import type { Store } from '../core/types';
import { apiUrl, CITY_ID, hubUrl } from './base';

export interface SessionInfo {
  via: 'session' | 'token' | 'tailnet';
  /** The tailnet login (via 'tailnet'); null otherwise. */
  user: string | null;
  deviceId: string | null;
  deviceName: string | null;
  /** Absent from servers before the terminal switch: treat as on. */
  terminal?: TerminalAccess;
  cityName?: string;
  /** The installed-app switches (server/pwa.ts, server/push): absent from older servers. */
  pwa?: { sw?: boolean; push?: boolean };
}

export interface PairedDevice {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
  current: boolean;
  /** 'app': the CAST menu-bar app on the Mac that runs this server (not a browser). */
  kind?: 'app';
}

let current: SessionInfo | null = null;
let loading: Promise<SessionInfo | null> | null = null;
const listeners = new Set<(s: SessionInfo | null) => void>();

async function getJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, { credentials: 'same-origin', ...init, headers: { accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers } });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* not JSON (an older server's plain-text 404, an HTML error page) */
  }
  if (!res.ok) {
    const msg = (body as { error?: unknown } | null)?.error;
    throw Object.assign(new Error(typeof msg === 'string' ? msg : `The server answered ${res.status}`), { status: res.status });
  }
  return body as T;
}

/** This city's /api/session (cached; force to ask again). null when the server can't say (older server, offline). */
export function loadSession(force = false): Promise<SessionInfo | null> {
  if (loading && !force) return loading;
  loading = getJson<SessionInfo>(apiUrl('/api/session'))
    .then((s) => s)
    .catch(() => null)
    .then((s) => {
      if (s || !current) {
        current = s;
        for (const fn of [...listeners]) fn(s);
      }
      if (!s) loading = null; // try again next time
      return s;
    });
  return loading;
}

export function sessionInfo(): SessionInfo | null {
  return current;
}

export function onSession(fn: (s: SessionInfo | null) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The hub's own session (Settings → Devices talks to the hub). */
export function hubSession(): Promise<SessionInfo> {
  return getJson<SessionInfo>(hubUrl('/api/session'));
}

export function listDevices(): Promise<{ devices: PairedDevice[]; currentId: string | null; via: SessionInfo['via'] }> {
  return getJson(hubUrl('/api/devices'));
}

export function revokeDevice(id: string): Promise<{ ok: true; signedOut: boolean }> {
  return getJson(hubUrl(`/api/devices/${encodeURIComponent(id)}`), { method: 'DELETE' });
}

export function revokeOtherDevices(): Promise<{ ok: true; revoked: number }> {
  return getJson(hubUrl('/api/devices/revoke-others'), { method: 'POST', body: '{}' });
}

export function rotatePairingToken(revokeAll: boolean): Promise<{ ok: true; revoked: number; tokenFile: string }> {
  return getJson(hubUrl('/api/devices/rotate-token'), { method: 'POST', body: JSON.stringify({ revokeAll }) });
}

/** Where a one-time pairing link lands. The device always pairs with the hub (the code is the hub's); opened from a
 *  city (/city/<id>/), it lands in that city, which is what the user is looking at: the hub pairs it at
 *  /city/<id>/?token=… and redirects to /city/<id>/. `serverPath` is the hub's answer ('/?token=<code>'). */
export function pairLinkPath(serverPath: string, cityId: string | null): string {
  if (!cityId) return serverPath;
  const search = new URL(serverPath, 'http://hub.invalid').search;
  return `/city/${encodeURIComponent(cityId)}/${search}`;
}

/** A one-time pairing link (works once, for a few minutes) on the hub's origin, landing in the city on screen, and its
 *  short twin to type (CAST on a phone's Home Screen; '' from an older server). */
export async function newPairingLink(): Promise<{ link: string; short: string; expiresAt: number }> {
  const r = await getJson<{ path: string; short?: string; expiresAt: number }>(hubUrl('/api/devices/pair-link'), { method: 'POST', body: '{}' });
  return { link: new URL(pairLinkPath(r.path, CITY_ID), location.origin).toString(), short: r.short ?? '', expiresAt: r.expiresAt };
}

/** "Delete all CAST data" on this city's server. */
export function wipeAllData(confirm: string): Promise<{ ok: true }> {
  return getJson(apiUrl('/api/data/wipe'), { method: 'POST', body: JSON.stringify({ confirm }) });
}

/** 'signed-out' when the server refuses this browser now; 'unknown' when it can't be reached (restarting, offline). */
export async function probeAccess(): Promise<'ok' | 'signed-out' | 'unknown'> {
  try {
    const res = await fetch(apiUrl('/api/session'), { credentials: 'same-origin', headers: { accept: 'application/json' }, cache: 'no-store' });
    if (res.status === 401 || res.status === 403) return 'signed-out';
    return res.ok || res.status === 404 ? 'ok' : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** When the live connection drops, ask whether this device is still allowed in. Signed out (here or from another
 *  device, or the server's data was reset) → reload: the server answers with its "This device is signed out" page and
 *  how to pair again, instead of the town reconnecting forever. */
export function watchAccess(store: Store): void {
  let wasConnected = store.state.connected;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let tries = 0;
  const check = async () => {
    timer = null;
    if (store.state.connected) return;
    if ((await probeAccess()) === 'signed-out') {
      location.reload();
      return;
    }
    // Still down and unclear (server restarting?): look again now and then while it stays down.
    tries++;
    if (!store.state.connected) timer = setTimeout(() => void check(), Math.min(30_000, 2_000 * tries));
  };
  store.subscribe((s) => {
    if (s.connected === wasConnected) return;
    wasConnected = s.connected;
    if (s.connected) {
      tries = 0;
      if (timer) clearTimeout(timer);
      timer = null;
      return;
    }
    if (!timer) timer = setTimeout(() => void check(), 800);
  });
}
