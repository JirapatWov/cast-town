// VAPID (RFC 8292) and push.json: one key pair per install, created once, 0600, never logged; JWTs that verify.
import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPushStore } from '../../server/push/store';
import { createVapid, FALLBACK_CONTACT, vapidContact, vapidJwt } from '../../server/push/vapid';
import { verifyVapid } from './fake-service';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'cast-vapid-'));
  roots.push(d);
  return d;
};

const sub = (deviceId: string, n = 1) => ({
  deviceId,
  endpoint: `https://web.push.apple.com/Q${n}`,
  p256dh: 'BA',
  auth: 'AA',
  origin: 'https://box.tail.ts.net:8443',
  prefs: { waiting: true, runs: true, errors: false },
  createdAt: n,
  failures: 0,
});

describe('push.json', () => {
  test('made once with mode 0600 and the same keys after a restart', () => {
    const dir = tmp();
    const a = createPushStore(dir);
    expect(statSync(join(dir, 'push.json')).mode & 0o777).toBe(0o600);
    expect(Buffer.from(a.vapid.publicKey, 'base64url')).toHaveLength(65);
    a.put(sub('d-1'));
    const b = createPushStore(dir);
    expect(b.vapid).toEqual(a.vapid);
    expect(b.list().map((s) => s.deviceId)).toEqual(['d-1']);
  });

  test('a corrupt file gives new keys and drops the subscriptions (they were bound to the old key)', () => {
    const dir = tmp();
    const a = createPushStore(dir);
    a.put(sub('d-1'));
    writeFileSync(join(dir, 'push.json'), '{ not json');
    const logs: string[] = [];
    const spy = spyOn(console, 'log').mockImplementation((...args: unknown[]) => void logs.push(args.join(' ')));
    const b = createPushStore(dir);
    spy.mockRestore();
    expect(b.vapid.publicKey).not.toBe(a.vapid.publicKey);
    expect(b.list()).toEqual([]);
    expect(logs.join('\n')).toContain('devices must turn notifications on again');
    expect(logs.join('\n')).not.toContain(b.vapid.privateKey);
  });

  test('one subscription per device and per endpoint; remove by device', () => {
    const s = createPushStore(tmp());
    s.put(sub('d-1', 1));
    s.put({ ...sub('d-1', 2) });
    expect(s.list()).toHaveLength(1);
    expect(s.get('d-1')?.endpoint).toBe('https://web.push.apple.com/Q2');
    s.put({ ...sub('d-2', 2) }); // same endpoint, paired again as another device
    expect(s.list().map((x) => x.deviceId)).toEqual(['d-2']);
    s.put(sub('d-3', 3));
    expect(s.remove(['d-2', 'd-9'])).toBe(1);
    expect(s.list().map((x) => x.deviceId)).toEqual(['d-3']);
  });

  test('at most 50, the least recently used go first', () => {
    const s = createPushStore(tmp());
    for (let i = 1; i <= 52; i++) s.put(sub(`d-${i}`, i));
    expect(s.list()).toHaveLength(50);
    expect(s.get('d-1')).toBeUndefined();
    expect(s.get('d-52')).toBeDefined();
  });

  test('after close (shutdown, then Delete all CAST data) nothing writes push.json back', () => {
    const dir = tmp();
    const s = createPushStore(dir);
    s.put(sub('d-1', 1));
    s.close();
    rmSync(join(dir, 'push.json')); // the wipe
    s.update('d-1', { lastOkAt: 5, failures: 0 }); // a send that was still under way
    s.put(sub('d-2', 2));
    s.removeEndpoint('https://web.push.apple.com/Q1');
    expect(() => statSync(join(dir, 'push.json'))).toThrow();
  });
});

describe('VAPID JWT', () => {
  const keyDir = tmp();
  const keys = createPushStore(keyDir).vapid;

  test('ES256, aud = the push service origin, exp within 24 h, a 64-byte signature that verifies with k', () => {
    const now = 1_800_000_000_000;
    const v = createVapid(keys, () => now);
    const h = v.authorization('https://web.push.apple.com/QGuid-123?x=1', 'mailto:me@example.com');
    const jwt = verifyVapid(h);
    expect(jwt.verified).toBe(true);
    expect(jwt.k).toBe(keys.publicKey);
    expect(jwt.header).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(jwt.claims.aud).toBe('https://web.push.apple.com');
    expect(jwt.claims.sub).toBe('mailto:me@example.com');
    const exp = jwt.claims.exp as number;
    expect(exp).toBeGreaterThan(now / 1000);
    expect(exp).toBeLessThanOrEqual(now / 1000 + 24 * 3600);
    expect(h).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
  });

  test('cached per push service for half an hour', () => {
    let now = 1_800_000_000_000;
    const v = createVapid(keys, () => now);
    const a = v.authorization('https://fcm.googleapis.com/fcm/send/abc', FALLBACK_CONTACT);
    expect(v.authorization('https://fcm.googleapis.com/fcm/send/other', FALLBACK_CONTACT)).toBe(a);
    expect(v.authorization('https://web.push.apple.com/x', FALLBACK_CONTACT)).not.toBe(a);
    now += 31 * 60 * 1000;
    expect(v.authorization('https://fcm.googleapis.com/fcm/send/abc', FALLBACK_CONTACT)).not.toBe(a);
  });

  test('sub: CAST_PUSH_CONTACT, else the https origin the device used, else the fallback', () => {
    expect(vapidContact('mailto:owner@example.com', 'https://box.tail.ts.net:8443')).toBe('mailto:owner@example.com');
    expect(vapidContact(null, 'https://box.tail.ts.net:8443')).toBe('https://box.tail.ts.net:8443');
    expect(vapidContact(null, 'http://127.0.0.1:4860')).toBe(FALLBACK_CONTACT);
    expect(vapidContact(null, '')).toBe(FALLBACK_CONTACT);
    expect(FALLBACK_CONTACT).toMatch(/^(mailto:|https:\/\/)/);
  });

  test('a JWT never carries the private key', () => {
    const t = vapidJwt(keys, 'https://web.push.apple.com', FALLBACK_CONTACT, Date.now());
    expect(t).not.toContain(keys.privateKey);
    expect(readFileSync(join(keyDir, 'push.json'), 'utf8')).toContain(keys.privateKey); // only the 0600 file has it
  });
});
