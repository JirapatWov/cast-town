// /api/push… (signed in): Settings → Notifications & app turns Web Push on for this paired device.
//   GET    /api/push               {enabled, watching, publicKey, subscribed, endpoint?, prefs, lastError?}
//                                   (watching: some device has notifications on, so pages report presence)
//   PUT    /api/push/subscription  {endpoint, keys: {p256dh, auth}, prefs?}   one per device (a new one replaces it)
//   PATCH  /api/push/prefs         {waiting?, runs?, errors?}
//   DELETE /api/push/subscription
//   POST   /api/push/test          send "Test from CAST" to this device now → {ok, error?} in plain words
//   POST   /api/push/presence      {visible, page} → 204 (any signed-in page: "someone is looking")
// A subscription belongs to a paired device (a session): signing the device out ends it. Tailscale logins and
// raw-token scripts have no device, so they are told to pair. Writes must come from our own origin; bodies ≤ 4 KB.
import { createECDH } from 'node:crypto';
import type { AllowDecision } from '../auth';
import { originAllowed } from '../auth';
import { readTextCapped } from '../util';
import type { Notifier } from './notifier';
import { endpointAllowed } from './send';
import { cleanPrefs, DEFAULT_PREFS, type PushStore } from './store';

const BODY_MAX = 4096;
const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
export const PAIR_FIRST = 'Pair this browser to get notifications: notifications belong to a paired device.';
export const OFF_TEXT = 'Notifications are off on this server (CAST_PUSH=off).';

/** A P-256 point the browser could have made (65 bytes, uncompressed, on the curve). */
export function validP256(raw: Buffer): boolean {
  if (raw.length !== 65 || raw[0] !== 0x04) return false;
  try {
    const e = createECDH('prime256v1');
    e.generateKeys();
    e.computeSecret(raw);
    return true;
  } catch {
    return false;
  }
}

const b64 = (v: unknown): Buffer | null => {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(v) || v.length > 200) return null;
  return Buffer.from(v.replace(/=+$/, ''), 'base64url');
};

/** The page origin a subscription was made on: its Origin header, else what the request came in as. */
function originOf(req: Request): string {
  const o = req.headers.get('origin');
  if (o && /^https?:\/\/[^/]+$/.test(o)) return o.toLowerCase();
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  if (!host) return '';
  const proto = (req.headers.get('x-forwarded-proto') ?? new URL(req.url).protocol.replace(':', '')).toLowerCase();
  return `${proto === 'https' ? 'https' : 'http'}://${host.toLowerCase()}`;
}

/** The push service's refusal in words a person can act on. */
export function testErrorText(error: string | undefined): string {
  if (!error) return 'The push service refused it.';
  if (/BadJwtToken/i.test(error)) return `${error} — the push service did not accept CAST's contact address. Set CAST_PUSH_CONTACT=mailto:you@example.com on the server, restart CAST, then turn notifications on again here.`;
  return error;
}

export interface PushRoutesDeps {
  enabled: boolean;
  store: PushStore | null;
  notifier: Notifier | null;
  allowedOrigins: string[];
  extraEndpoints: readonly string[];
  now?: () => number;
}

export function createPushRoutes(d: PushRoutesDeps) {
  const now = d.now ?? Date.now;
  return function routes(req: Request, url: URL, decision: AllowDecision): Promise<Response> | null {
    const path = url.pathname;
    if (path !== '/api/push' && !path.startsWith('/api/push/')) return null;
    return (async () => {
      const m = req.method;
      const writes = m !== 'GET' && m !== 'HEAD';
      if (writes && !originAllowed(req, d.allowedOrigins)) return json({ error: 'Forbidden: cross-origin request' }, 403);
      let body: Record<string, unknown> = {};
      if (writes) {
        const text = await readTextCapped(req, BODY_MAX).catch(() => '');
        if (text === null) return json({ error: 'Request too large' }, 413);
        if (text.trim()) {
          try {
            const parsed = JSON.parse(text) as unknown;
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
            else return json({ error: 'Send a JSON object' }, 400);
          } catch {
            return json({ error: 'Send JSON' }, 400);
          }
        }
      }
      if (path === '/api/push/presence') {
        if (m !== 'POST') return json({ error: 'Use POST' }, 405);
        const page = typeof body.page === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(body.page) ? body.page : null;
        if (page && d.notifier) d.notifier.presence(page, decision.deviceId, body.visible === true);
        return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
      }
      if (!d.enabled || !d.store || !d.notifier) {
        if (path === '/api/push' && m === 'GET') return json({ enabled: false });
        return json({ error: OFF_TEXT }, 409);
      }
      const id = decision.via === 'session' ? decision.deviceId : null;
      const watching = d.store.list().length > 0;
      if (!id) return json({ error: PAIR_FIRST, enabled: true, watching }, 400);
      const sub = d.store.get(id);

      if (path === '/api/push') {
        if (writes) return json({ error: 'Method not allowed' }, 405);
        return json({
          enabled: true,
          watching,
          publicKey: d.store.vapid.publicKey,
          subscribed: !!sub,
          ...(sub ? { endpoint: sub.endpoint, lastError: sub.lastError } : {}),
          prefs: sub?.prefs ?? DEFAULT_PREFS,
        });
      }
      if (path === '/api/push/subscription') {
        if (m === 'DELETE') {
          d.store.remove([id]);
          return json({ ok: true, subscribed: false });
        }
        if (m !== 'PUT') return json({ error: 'Use PUT or DELETE' }, 405);
        const endpoint = typeof body.endpoint === 'string' ? body.endpoint : '';
        if (!endpointAllowed(endpoint, d.extraEndpoints)) return json({ error: 'That push service is not one CAST sends to.' }, 400);
        const keys = (body.keys ?? {}) as { p256dh?: unknown; auth?: unknown };
        const p256dh = b64(keys.p256dh);
        const auth = b64(keys.auth);
        if (!p256dh || !validP256(p256dh)) return json({ error: 'The subscription’s key is not a valid P-256 key.' }, 400);
        if (!auth || auth.length !== 16) return json({ error: 'The subscription’s auth secret must be 16 bytes.' }, 400);
        const prefs = cleanPrefs(body.prefs, sub?.prefs ?? DEFAULT_PREFS);
        d.store.put({
          deviceId: id,
          endpoint,
          p256dh: p256dh.toString('base64url'),
          auth: auth.toString('base64url'),
          origin: originOf(req),
          prefs,
          createdAt: now(),
          failures: 0,
        });
        return json({ ok: true, subscribed: true, prefs });
      }
      if (path === '/api/push/prefs') {
        if (m !== 'PATCH') return json({ error: 'Use PATCH' }, 405);
        if (!sub) return json({ error: 'Notifications are not on for this device.' }, 404);
        const prefs = cleanPrefs(body, sub.prefs);
        d.store.update(id, { prefs });
        return json({ ok: true, prefs });
      }
      if (path === '/api/push/test') {
        if (m !== 'POST') return json({ error: 'Use POST' }, 405);
        if (!sub) return json({ ok: false, error: 'Notifications are not on for this device.' }, 404);
        const r = await d.notifier.sendTest(id);
        return json(r.ok ? { ok: true } : { ok: false, error: testErrorText(r.error) });
      }
      return json({ error: 'Not found' }, 404);
    })();
  };
}
