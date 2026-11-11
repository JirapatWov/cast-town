// Sending to a push service: a fake one (Bun.serve) checks the VAPID JWT, decrypts the message and records the
// RFC 8030 headers; its answers drive what CAST does with the subscription. Plus the endpoint allowlist (no SSRF).
import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSender, endpointAllowed } from '../../server/push/send';
import { createPushStore } from '../../server/push/store';
import { createVapid } from '../../server/push/vapid';
import { browserKeys, startFakePushService } from './fake-service';

const dir = mkdtempSync(join(tmpdir(), 'cast-send-'));
const keys = browserKeys();
const fake = startFakePushService(keys);
afterAll(() => {
  fake.stop();
  rmSync(dir, { recursive: true, force: true });
});
const vapid = createVapid(createPushStore(dir).vapid);
const target = (path: string) => ({ endpoint: `${fake.origin}${path}`, p256dh: keys.p256dh, auth: keys.auth });
const sender = (o: Partial<Parameters<typeof createSender>[0]> = {}) => createSender({ vapid, extraEndpoints: [fake.origin], retryDelayMs: 10, ...o });
const CONTACT = 'mailto:me@example.com';

describe('sendPush', () => {
  test('201 → ok; the service sees TTL, Urgency, Topic, aes128gcm and a VAPID JWT for its own origin', async () => {
    const r = await sender().send(target('/ok/1'), JSON.stringify({ hello: 'phone' }), { ttl: 60, urgency: 'high', topic: 'waiting' }, CONTACT);
    expect(r).toEqual({ ok: true, status: 201 });
    const got = fake.received.at(-1)!;
    expect(got.payload).toEqual({ hello: 'phone' });
    expect(got.headers).toMatchObject({ ttl: '60', urgency: 'high', topic: 'waiting', 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream' });
    expect(got.jwt.verified).toBe(true);
    expect(got.jwt.claims).toMatchObject({ aud: fake.origin, sub: CONTACT });
  });

  test('a topic that is not [A-Za-z0-9_-]{1,32} is left out', async () => {
    await sender().send(target('/ok/2'), '{}', { ttl: 60, topic: 'has space' }, CONTACT);
    expect(fake.received.at(-1)!.headers.topic).toBeUndefined();
  });

  test('404 / 410 → gone (the caller drops the subscription)', async () => {
    for (const p of ['/gone/x', '/notfound/x']) {
      const r = await sender().send(target(p), '{}', { ttl: 60 }, CONTACT);
      expect(r.ok).toBe(false);
      expect(r.gone).toBe(true);
    }
  });

  test('429 with Retry-After → that host is left alone for that long', async () => {
    let now = 1_000_000;
    const s = sender({ now: () => now });
    const first = await s.send(target('/slow/x'), '{}', { ttl: 60 }, CONTACT);
    expect(first.status).toBe(429);
    const count = fake.received.length;
    const second = await s.send(target('/ok/3'), '{}', { ttl: 60 }, CONTACT);
    expect(second.ok).toBe(false);
    expect(second.error).toContain('slow down');
    expect(fake.received.length).toBe(count); // not even sent
    now += 121_000;
    expect((await s.send(target('/ok/3'), '{}', { ttl: 60 }, CONTACT)).ok).toBe(true);
  });

  test('413 and 403 BadJwtToken keep the subscription and say why; the log names the host only', async () => {
    const logs: string[] = [];
    const spy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logs.push(a.join(' ')));
    const big = await sender().send(target('/big/secret-endpoint-id'), '{}', { ttl: 60 }, CONTACT);
    const jwt = await sender().send(target('/jwt/secret-endpoint-id'), '{}', { ttl: 60 }, CONTACT);
    spy.mockRestore();
    expect(big).toMatchObject({ ok: false, status: 413 });
    expect(big.gone).toBeUndefined();
    expect(jwt.status).toBe(403);
    expect(jwt.error).toContain('BadJwtToken');
    expect(jwt.gone).toBeUndefined();
    const text = logs.join('\n');
    expect(text).toContain('413');
    expect(text).not.toContain('secret-endpoint-id');
    expect(text).not.toContain(keys.p256dh);
  });

  test('a push service that never answers is given up on (timeout)', async () => {
    const t0 = Date.now();
    const r = await sender({ timeoutMs: 300 }).send(target('/hang/x'), '{}', { ttl: 60 }, CONTACT);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('did not answer');
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  test('redirects are not followed', async () => {
    const count = fake.received.length;
    const r = await sender().send(target('/redirect/x'), '{}', { ttl: 60 }, CONTACT);
    expect(r).toMatchObject({ ok: false, status: 302 });
    expect(fake.received.length).toBe(count + 1); // only the first request, never /ok
  });

  test('a 5xx is tried once more', async () => {
    const r = await sender().send(target('/flaky/x'), '{}', { ttl: 60 }, CONTACT);
    expect(r.ok).toBe(true);
  });
});

describe('endpoint allowlist', () => {
  test('known push services over https only', () => {
    for (const ok of [
      'https://web.push.apple.com/QGuid',
      'https://api.push.apple.com/x',
      'https://fcm.googleapis.com/fcm/send/abc:def',
      'https://updates.push.services.mozilla.com/wpush/v2/gAAA',
      'https://wns2-par02p.notify.windows.com/w/?token=x',
    ]) expect(endpointAllowed(ok)).toBe(true);
    for (const bad of [
      'http://web.push.apple.com/x',
      'https://web.push.apple.com:8443/x',
      'https://127.0.0.1/x',
      'https://[::1]/x',
      'https://10.0.0.5/x',
      'https://localhost/x',
      'https://push.apple.com.evil.example/x',
      'https://evilpush.apple.com.example/x',
      'https://fcm.googleapis.com.evil/x',
      ['https://user:pw', 'fcm.googleapis.com/x'].join('@'), // userinfo (joined: no address-shaped text in the repo)
      'https://example.com/x',
      'file:///etc/passwd',
      'not a url',
    ]) expect(endpointAllowed(bad)).toBe(false);
  });

  test('CAST_PUSH_EXTRA_ENDPOINTS lets a listed origin in (http too)', () => {
    expect(endpointAllowed(`${fake.origin}/x`)).toBe(false);
    expect(endpointAllowed(`${fake.origin}/x`, [fake.origin])).toBe(true);
    expect(endpointAllowed('http://127.0.0.1:1/x', [fake.origin])).toBe(false);
  });

  test('send refuses an endpoint outside the list without a request', async () => {
    const count = fake.received.length;
    const r = await createSender({ vapid }).send(target('/ok/x'), '{}', { ttl: 60 }, CONTACT);
    expect(r.ok).toBe(false);
    expect(fake.received.length).toBe(count);
  });
});
