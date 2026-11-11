// Web Push from the page's side: turning notifications on for this device (always from a tap: the permission prompt
// never appears by itself), keeping the browser's subscription and the server's in step on every load, and telling
// the server while a page is visible (so a device you are looking at isn't buzzed — server/push/notifier.ts).
// The home city only: a city opened through a hub belongs to another server.
import { CITY_ID, hubUrl } from '../net/base';
import { swPossible, swRegistration } from './register';

export interface PushPrefs {
  waiting: boolean;
  runs: boolean;
  errors: boolean;
}

export interface ServerPush {
  enabled: boolean;
  publicKey?: string;
  subscribed?: boolean;
  endpoint?: string;
  prefs?: PushPrefs;
  lastError?: string;
  /** Some device of this server has notifications on (presence matters). */
  watching?: boolean;
  /** Why this browser can't (not a paired device). */
  error?: string;
}

/** What Settings shows. */
export type PushSupport =
  | { ok: true }
  | { ok: false; why: 'city' | 'insecure' | 'ios-tab' | 'unsupported' | 'no-worker' };

export function pushSupport(): PushSupport {
  if (CITY_ID !== null) return { ok: false, why: 'city' };
  if (typeof window === 'undefined') return { ok: false, why: 'unsupported' };
  if (!isSecureContext) return { ok: false, why: 'insecure' };
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  if (!('PushManager' in window) || !('Notification' in window)) return { ok: false, why: ios ? 'ios-tab' : 'unsupported' };
  if (!('serviceWorker' in navigator)) return { ok: false, why: 'unsupported' };
  if (!swPossible()) return { ok: false, why: 'no-worker' };
  return { ok: true };
}

async function call<T>(method: string, path: string, body?: unknown, keepalive = false): Promise<T> {
  const res = await fetch(hubUrl(path), {
    method,
    credentials: 'same-origin',
    keepalive,
    headers: { accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data: unknown = null;
  try {
    data = res.status === 204 ? null : await res.json();
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const e = (data as { error?: unknown } | null)?.error;
    throw Object.assign(new Error(typeof e === 'string' ? e : `The server answered ${res.status}`), { status: res.status, data });
  }
  return data as T;
}

export async function serverPush(): Promise<ServerPush> {
  try {
    return await call<ServerPush>('GET', '/api/push');
  } catch (err) {
    const data = (err as { data?: ServerPush }).data;
    if (data && typeof data === 'object') return { ...data, enabled: data.enabled !== false };
    throw err;
  }
}

/** base64url → the bytes pushManager.subscribe wants. */
export function keyBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64url.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(s.length));
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function putSubscription(sub: PushSubscription, prefs?: PushPrefs): Promise<{ prefs: PushPrefs }> {
  const j = sub.toJSON();
  return call('PUT', '/api/push/subscription', { endpoint: j.endpoint, keys: j.keys, ...(prefs ? { prefs } : {}) });
}

/** Turn notifications on: called straight from the tap, so subscribe() (which asks for permission) is the first thing
 *  that waits — Safari only allows the prompt inside the gesture. `reg` and `publicKey` were fetched beforehand. */
export async function turnOn(reg: ServiceWorkerRegistration, publicKey: string, prefs?: PushPrefs): Promise<{ prefs: PushPrefs }> {
  let sub: PushSubscription;
  try {
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  } catch (err) {
    // made with another key (this server's key changed): start over once
    const old = await reg.pushManager.getSubscription().catch(() => null);
    if (!old) throw err;
    await old.unsubscribe().catch(() => false);
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  }
  return putSubscription(sub, prefs);
}

export async function turnOff(reg: ServiceWorkerRegistration | null): Promise<void> {
  await call('DELETE', '/api/push/subscription', {});
  const sub = await reg?.pushManager.getSubscription().catch(() => null);
  await sub?.unsubscribe().catch(() => false);
}

export const setPrefs = (p: Partial<PushPrefs>) => call<{ prefs: PushPrefs }>('PATCH', '/api/push/prefs', p);
export const sendTest = () => call<{ ok: boolean; error?: string }>('POST', '/api/push/test', {});

/** Every home load with permission granted: the browser's subscription and the server's must match (iOS may drop the
 *  worker and its subscription under storage pressure; the server may have lost push.json). */
export async function resyncPush(): Promise<void> {
  if (!pushSupport().ok || Notification.permission !== 'granted') return;
  const server = await serverPush().catch(() => null);
  if (!server?.enabled || !server.publicKey || server.error) return;
  const reg = await swRegistration();
  if (!reg) return;
  const sub = await reg.pushManager.getSubscription().catch(() => null);
  if (sub && server.subscribed && sub.endpoint === server.endpoint) return;
  if (!sub && !server.subscribed) return; // never turned on here
  if (sub && !server.subscribed) {
    // the server forgot it (a new key, signed out and paired again): subscribe again with the current key
    await sub.unsubscribe().catch(() => false);
  }
  try {
    const fresh = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(server.publicKey) });
    await putSubscription(fresh, server.prefs);
  } catch {
    /* Settings shows the state */
  }
}

/** Tell the server while this page is visible and focused (every 30 s, and on every change). */
export function startPresence(): void {
  if (CITY_ID !== null) return;
  const page = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
  let was: boolean | null = null;
  const send = (force = false) => {
    const visible = document.visibilityState === 'visible' && document.hasFocus();
    if (!force && visible === was) return;
    was = visible;
    void call('POST', '/api/push/presence', { visible, page }, true).catch(() => {});
  };
  for (const ev of ['focus', 'blur']) addEventListener(ev, () => send());
  document.addEventListener('visibilitychange', () => send());
  addEventListener('pagehide', () => {
    was = null;
    void call('POST', '/api/push/presence', { visible: false, page }, true).catch(() => {});
  });
  setInterval(() => {
    if (was) send(true);
  }, 30_000);
  send(true);
}
