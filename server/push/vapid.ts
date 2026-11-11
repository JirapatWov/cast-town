// VAPID (RFC 8292): how this server proves to a push service that it is the one a browser subscribed with. One P-256
// key pair per CAST install (kept in push.json, store.ts); every request carries
//   Authorization: vapid t=<JWT ES256 {aud: push service origin, exp: ≤ 24 h, sub: contact}>, k=<raw public key>
// A subscription is bound to the key it was made with: a new key means every device turns notifications on again.
import { createPrivateKey, createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';

export interface VapidKeys {
  /** Raw uncompressed P-256 public key (0x04 || x || y), base64url: the browser's applicationServerKey. */
  publicKey: string;
  /** The private scalar d, base64url. Never logged, never sent. */
  privateKey: string;
}

/** The fallback contact: the project's site (RFC 8292 allows an https: URL). CAST_PUSH_CONTACT replaces it. */
export const FALLBACK_CONTACT = 'https://casttown.dev';
const JWT_TTL_S = 3600;
const CACHE_MS = 30 * 60 * 1000;

export function newVapidKeys(): VapidKeys {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = privateKey.export({ format: 'jwk' });
  const pub = Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')]);
  return { publicKey: pub.toString('base64url'), privateKey: jwk.d! };
}

/** True when `k` holds a usable P-256 key pair. */
export function validVapidKeys(k: unknown): k is VapidKeys {
  const v = k as Partial<VapidKeys> | null;
  if (!v || typeof v.publicKey !== 'string' || typeof v.privateKey !== 'string') return false;
  try {
    privateKeyOf(v as VapidKeys);
    return true;
  } catch {
    return false;
  }
}

function privateKeyOf(k: VapidKeys): KeyObject {
  const pub = Buffer.from(k.publicKey, 'base64url');
  if (pub.length !== 65 || pub[0] !== 0x04) throw new Error('bad VAPID public key');
  return createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url'), d: k.privateKey },
    format: 'jwk',
  });
}

/** The contact sent as `sub`: CAST_PUSH_CONTACT, else the https origin the device subscribed from, else a fallback. */
export function vapidContact(configured: string | null | undefined, origin: string | null | undefined): string {
  if (configured && /^(mailto:|https:)/i.test(configured)) return configured;
  if (origin && /^https:\/\/[^/\s]+$/i.test(origin)) return origin;
  return FALLBACK_CONTACT;
}

const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

/** A signed VAPID JWT for one push service (`aud` = its origin). */
export function vapidJwt(k: VapidKeys, aud: string, sub: string, nowMs: number): string {
  const head = `${enc({ typ: 'JWT', alg: 'ES256' })}.${enc({ aud, exp: Math.floor(nowMs / 1000) + JWT_TTL_S, sub })}`;
  const sig = createSign('sha256').update(head).sign({ key: privateKeyOf(k), dsaEncoding: 'ieee-p1363' });
  return `${head}.${sig.toString('base64url')}`;
}

/** Authorization header values, one JWT per push service and contact, reused for half an hour. */
export function createVapid(k: VapidKeys, now: () => number = Date.now) {
  const cache = new Map<string, { value: string; until: number }>();
  return {
    publicKey: k.publicKey,
    authorization(endpoint: string, sub: string): string {
      const aud = new URL(endpoint).origin;
      const key = `${aud} ${sub}`;
      const hit = cache.get(key);
      if (hit && hit.until > now()) return hit.value;
      const value = `vapid t=${vapidJwt(k, aud, sub, now())}, k=${k.publicKey}`;
      if (cache.size > 100) cache.clear();
      cache.set(key, { value, until: now() + CACHE_MS });
      return value;
    },
  };
}
export type Vapid = ReturnType<typeof createVapid>;
