// Sending one Web Push message (RFC 8030) to one subscription: encrypted (ece.ts), signed (vapid.ts), to a push
// service CAST knows. A paired device chooses the endpoint, so it is checked against an allowlist of real push
// services — https, a known host, no IP address, no redirects followed — on subscribe and again on every send: CAST
// never becomes a way to make requests to machines on the owner's network (SSRF).
// Logs name only the push service's host and status: never an endpoint URL, a key or what was sent.
import { isIP } from 'node:net';
import { errorMessage, log } from '../util';
import { encrypt } from './ece';
import type { Vapid } from './vapid';

/** Push services of the browsers people use: Apple (Safari, iOS Home Screen apps), Google (Chrome, Edge on Android,
 *  most Chromium), Mozilla (Firefox), Microsoft (Edge on Windows). */
const KNOWN_HOSTS: readonly ((h: string) => boolean)[] = [
  (h) => /(^|\.)push\.apple\.com$/.test(h),
  (h) => h === 'fcm.googleapis.com',
  (h) => h === 'updates.push.services.mozilla.com',
  (h) => /\.notify\.windows\.com$/.test(h),
];

export const SEND_TIMEOUT_MS = 10_000;
export const RETRY_5XX_MS = 30_000;
const DEFAULT_BACKOFF_MS = 60_000;

/** True when CAST may send to `endpoint`: a known push service over https (default port), or an origin listed in
 *  CAST_PUSH_EXTRA_ENDPOINTS (tests, a local fake; http allowed there). */
export function endpointAllowed(endpoint: string, extra: readonly string[] = []): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (extra.includes(u.origin.toLowerCase())) return u.protocol === 'https:' || u.protocol === 'http:';
  if (u.protocol !== 'https:' || u.port !== '') return false;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (isIP(host.replace(/^\[|\]$/g, '')) || host === 'localhost' || host.endsWith('.localhost')) return false;
  return KNOWN_HOSTS.some((ok) => ok(host));
}

export type Urgency = 'very-low' | 'low' | 'normal' | 'high';

export interface SendOptions {
  /** Seconds the push service keeps an undelivered message. */
  ttl: number;
  urgency?: Urgency;
  /** Replaces an undelivered message with the same topic ([A-Za-z0-9_-]{1,32}). */
  topic?: string;
}

export interface SendTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface SendResult {
  ok: boolean;
  status: number;
  /** In plain words, for Settings (and lastError): the status and the push service's first words. */
  error?: string;
  /** The subscription no longer exists (404/410): drop it. */
  gone?: boolean;
}

export interface SenderOptions {
  vapid: Vapid;
  extraEndpoints?: readonly string[];
  fetch?: typeof fetch;
  timeoutMs?: number;
  retryDelayMs?: number;
  now?: () => number;
}

const hostOf = (endpoint: string) => {
  try {
    return new URL(endpoint).host;
  } catch {
    return 'push service';
  }
};

export function createSender(o: SenderOptions) {
  const doFetch = o.fetch ?? fetch;
  const now = o.now ?? Date.now;
  const timeoutMs = o.timeoutMs ?? SEND_TIMEOUT_MS;
  const retryMs = o.retryDelayMs ?? RETRY_5XX_MS;
  const backoff = new Map<string, number>(); // push service host → not before

  async function once(t: SendTarget, body: Buffer, opts: SendOptions, contact: string): Promise<SendResult> {
    const host = hostOf(t.endpoint);
    const headers: Record<string, string> = {
      ttl: String(Math.max(0, Math.round(opts.ttl))),
      urgency: opts.urgency ?? 'normal',
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      authorization: o.vapid.authorization(t.endpoint, contact),
    };
    if (opts.topic && /^[A-Za-z0-9_-]{1,32}$/.test(opts.topic)) headers.topic = opts.topic;
    let res: Response;
    try {
      res = await doFetch(t.endpoint, { method: 'POST', headers, body: new Uint8Array(body), redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      log('push', `${host}: ${timedOut ? 'no answer in time' : 'could not connect'}`);
      return { ok: false, status: 0, error: timedOut ? `${host} did not answer in ${Math.round(timeoutMs / 1000)} s` : `Could not reach ${host}: ${errorMessage(err)}` };
    }
    const text = res.ok ? '' : (await res.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!res.ok) await res.body?.cancel().catch(() => {});
    if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status };
    log('push', `${host} answered ${res.status}`);
    if (res.status === 404 || res.status === 410) return { ok: false, status: res.status, gone: true, error: `${res.status}: this device's subscription has ended` };
    if (res.status === 429) {
      const after = Number(res.headers.get('retry-after'));
      backoff.set(host, now() + (Number.isFinite(after) && after > 0 ? after * 1000 : DEFAULT_BACKOFF_MS));
    }
    if (res.status >= 300 && res.status < 400) return { ok: false, status: res.status, error: `${res.status}: ${host} answered with a redirect (not followed)` };
    return { ok: false, status: res.status, error: `${res.status}${text ? ` ${text}` : ''}` };
  }

  return {
    /** Encrypt and send `payload` (JSON text) to one subscription. `contact`: the VAPID sub (vapid.ts vapidContact). */
    async send(t: SendTarget, payload: string, opts: SendOptions, contact: string, extra: readonly string[] = o.extraEndpoints ?? []): Promise<SendResult> {
      if (!endpointAllowed(t.endpoint, extra)) return { ok: false, status: 0, error: 'This push service is not one CAST sends to.' };
      const host = hostOf(t.endpoint);
      const wait = (backoff.get(host) ?? 0) - now();
      if (wait > 0) return { ok: false, status: 429, error: `${host} asked CAST to slow down; trying again in ${Math.ceil(wait / 1000)} s` };
      let body: Buffer;
      try {
        body = encrypt(Buffer.from(payload, 'utf8'), { p256dh: Buffer.from(t.p256dh, 'base64url'), auth: Buffer.from(t.auth, 'base64url') });
      } catch (err) {
        return { ok: false, status: 0, error: `Could not encrypt for this device: ${errorMessage(err)}` };
      }
      const first = await once(t, body, opts, contact);
      if (first.status < 500 || retryMs < 0) return first;
      await new Promise((r) => setTimeout(r, retryMs));
      return once(t, body, opts, contact);
    },
  };
}
export type Sender = ReturnType<typeof createSender>;
