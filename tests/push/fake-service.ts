// A fake push service for tests: checks the VAPID JWT against the k= key, decrypts each message with the test
// browser's key, and records what came in. The path picks the answer: /ok (201), /gone (410), /notfound (404),
// /slow (429 Retry-After 120), /big (413), /jwt (403 BadJwtToken), /hang (never answers), /redirect (302 → /ok),
// /flaky (503 once, then 201).
import { createECDH, createPublicKey, createVerify, randomBytes } from 'node:crypto';
import { decrypt } from '../../server/push/ece';

export interface Received {
  path: string;
  headers: Record<string, string>;
  jwt: { header: Record<string, unknown>; claims: Record<string, unknown>; verified: boolean; k: string };
  payload: unknown;
}

export function browserKeys() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return { priv: ecdh.getPrivateKey(), p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url'), authBuf: auth };
}

export function verifyVapid(authorization: string): Received['jwt'] {
  const m = /^vapid t=([^,\s]+),\s*k=([A-Za-z0-9_-]+)$/.exec(authorization);
  if (!m) throw new Error(`bad Authorization: ${authorization.slice(0, 20)}`);
  const [h, c, s] = m[1]!.split('.');
  const raw = Buffer.from(m[2]!, 'base64url');
  const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' });
  const sig = Buffer.from(s!, 'base64url');
  const verified = sig.length === 64 && createVerify('sha256').update(`${h}.${c}`).verify({ key, dsaEncoding: 'ieee-p1363' }, sig);
  return { header: JSON.parse(Buffer.from(h!, 'base64url').toString()), claims: JSON.parse(Buffer.from(c!, 'base64url').toString()), verified, k: m[2]! };
}

export function startFakePushService(keys: { priv: Buffer; authBuf: Buffer }) {
  const received: Received[] = [];
  let flaky = 0;
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      const body = Buffer.from(await req.arrayBuffer());
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => (headers[k] = v));
      let jwt: Received['jwt'];
      let payload: unknown = null;
      try {
        jwt = verifyVapid(headers.authorization ?? '');
        payload = JSON.parse(decrypt(body, keys.priv, keys.authBuf).toString('utf8'));
      } catch (err) {
        return new Response(`bad request: ${(err as Error).message}`, { status: 400 });
      }
      received.push({ path: url.pathname, headers, jwt, payload });
      const p = url.pathname.split('/')[1];
      if (p === 'gone') return new Response('', { status: 410 });
      if (p === 'notfound') return new Response('', { status: 404 });
      if (p === 'slow') return new Response('slow down', { status: 429, headers: { 'retry-after': '120' } });
      if (p === 'big') return new Response('too big', { status: 413 });
      if (p === 'jwt') return new Response(JSON.stringify({ reason: 'BadJwtToken' }), { status: 403 });
      if (p === 'hang') return new Promise<Response>(() => {});
      if (p === 'redirect') return new Response(null, { status: 302, headers: { location: '/ok' } });
      if (p === 'flaky' && flaky++ === 0) return new Response('later', { status: 503 });
      return new Response(null, { status: 201 });
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  return { origin, received, stop: () => server.stop(true) };
}
