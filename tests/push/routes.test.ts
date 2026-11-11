// /api/push…: a paired device turns notifications on, changes what it wants, sends itself a test, turns them off.
// Subscriptions are checked (allowlisted push service, a real P-256 key, a 16-byte secret) and belong to a session.
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuth, type AllowDecision } from '../../server/auth';
import { createPush } from '../../server/push';
import { PAIR_FIRST } from '../../server/push/routes';
import { browserKeys, startFakePushService } from './fake-service';

const roots: string[] = [];
const keys = browserKeys();
const fake = startFakePushService(keys);
afterAll(() => {
  fake.stop();
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const BASE = 'http://127.0.0.1:4860';
function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'cast-pushroutes-'));
  roots.push(dataDir);
  const auth = createAuth({ dataDir, allowedUsers: [], allowedOrigins: [] });
  const push = createPush({ dataDir, enabled: true, devices: auth.devices, contact: null, extraEndpoints: [fake.origin], allowedOrigins: [] });
  const me = auth.devices.create({ name: 'phone' });
  const session: AllowDecision = { kind: 'allow', user: 'token', via: 'session', deviceId: me.device.id };
  async function call(method: string, path: string, body?: unknown, o: { decision?: AllowDecision; origin?: string; raw?: string } = {}) {
    const req = new Request(`${BASE}${path}`, {
      method,
      headers: { host: '127.0.0.1:4860', ...(method !== 'GET' ? { origin: o.origin ?? BASE, 'content-type': 'application/json' } : {}) },
      body: o.raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    const res = await push.routes(req, new URL(req.url), o.decision ?? session);
    if (!res) throw new Error('not a push route');
    return res;
  }
  return { auth, push, me, call };
}

const subscription = (path = '/ok/me') => ({ endpoint: `${fake.origin}${path}`, keys: { p256dh: keys.p256dh, auth: keys.auth } });

describe('/api/push', () => {
  test('GET → enabled, the VAPID public key, not subscribed yet', async () => {
    const { call, push } = setup();
    const r = (await (await call('GET', '/api/push')).json()) as Record<string, unknown>;
    expect(r).toMatchObject({ enabled: true, subscribed: false, publicKey: push.store!.vapid.publicKey, prefs: { waiting: true, runs: true, errors: false } });
  });

  test('PUT stores it (one per device), PATCH changes prefs, DELETE removes it', async () => {
    const { call, push, me } = setup();
    const put = await call('PUT', '/api/push/subscription', { ...subscription('/ok/a'), prefs: { errors: true } });
    expect(put.status).toBe(200);
    expect(push.store!.get(me.device.id)).toMatchObject({ endpoint: `${fake.origin}/ok/a`, origin: BASE, prefs: { waiting: true, runs: true, errors: true } });
    await call('PUT', '/api/push/subscription', subscription('/ok/b'));
    expect(push.store!.list()).toHaveLength(1);
    expect(push.store!.get(me.device.id)?.endpoint).toBe(`${fake.origin}/ok/b`);
    expect(push.store!.get(me.device.id)?.prefs.errors).toBe(true); // kept from before
    const got = (await (await call('GET', '/api/push')).json()) as Record<string, unknown>;
    expect(got).toMatchObject({ subscribed: true, endpoint: `${fake.origin}/ok/b` });
    const patched = (await (await call('PATCH', '/api/push/prefs', { runs: false })).json()) as { prefs: Record<string, boolean> };
    expect(patched.prefs).toEqual({ waiting: true, runs: false, errors: true });
    expect((await call('DELETE', '/api/push/subscription')).status).toBe(200);
    expect(push.store!.list()).toHaveLength(0);
    expect((await call('PATCH', '/api/push/prefs', { runs: true })).status).toBe(404);
  });

  test('bad subscriptions → 400: key length, a point off the curve, a short secret, a push service CAST doesn’t know', async () => {
    const { call, push } = setup();
    const bad = [
      { ...subscription(), keys: { p256dh: Buffer.alloc(33, 4).toString('base64url'), auth: keys.auth } },
      { ...subscription(), keys: { p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url'), auth: keys.auth } },
      { ...subscription(), keys: { p256dh: keys.p256dh, auth: Buffer.alloc(8).toString('base64url') } },
      { ...subscription(), endpoint: 'https://10.0.0.5/push' },
      { ...subscription(), endpoint: 'http://127.0.0.1:1/x' },
      { ...subscription(), endpoint: 'https://example.com/push' },
    ];
    for (const b of bad) expect((await call('PUT', '/api/push/subscription', b)).status).toBe(400);
    expect(push.store!.list()).toHaveLength(0);
  });

  test('writes from another origin → 403; bodies over 4 KB → 413', async () => {
    const { call } = setup();
    expect((await call('PUT', '/api/push/subscription', subscription(), { origin: 'https://evil.example' })).status).toBe(403);
    expect((await call('PUT', '/api/push/subscription', undefined, { raw: JSON.stringify({ ...subscription(), pad: 'x'.repeat(5000) }) })).status).toBe(413);
  });

  test('Tailscale logins and raw-token scripts are told to pair', async () => {
    const { call } = setup();
    for (const decision of [
      { kind: 'allow', user: 'me@example.com', via: 'tailnet', deviceId: null },
      { kind: 'allow', user: 'token', via: 'token', deviceId: null },
    ] as AllowDecision[]) {
      const r = await call('PUT', '/api/push/subscription', subscription(), { decision });
      expect(r.status).toBe(400);
      expect(((await r.json()) as { error: string }).error).toBe(PAIR_FIRST);
      expect((await call('GET', '/api/push', undefined, { decision })).status).toBe(400);
    }
  });

  test('watching: true once any device has notifications on (pages then report whether they are seen)', async () => {
    const { call, auth } = setup();
    const tailnet: AllowDecision = { kind: 'allow', user: 'me@example.com', via: 'tailnet', deviceId: null };
    const watching = async (decision?: AllowDecision) =>
      ((await (await call('GET', '/api/push', undefined, { decision })).json()) as { watching: boolean }).watching;
    expect(await watching()).toBe(false);
    expect(await watching(tailnet)).toBe(false);
    const other = auth.devices.create({ name: 'laptop' });
    const otherSession: AllowDecision = { kind: 'allow', user: 'token', via: 'session', deviceId: other.device.id };
    await call('PUT', '/api/push/subscription', subscription('/ok/laptop'), { decision: otherSession });
    expect(await watching()).toBe(true); // this device has none, another has
    expect(await watching(tailnet)).toBe(true); // a browser signed in by Tailscale still reports presence
  });

  test('POST /api/push/test reaches the push service, encrypted, with the test notification', async () => {
    const { call } = setup();
    await call('PUT', '/api/push/subscription', subscription('/ok/test'));
    const r = (await (await call('POST', '/api/push/test', {})).json()) as { ok: boolean };
    expect(r.ok).toBe(true);
    const got = fake.received.at(-1)!;
    expect(got.path).toBe('/ok/test');
    expect(got.payload).toMatchObject({ notification: { title: 'Test from CAST', tag: 'cast-test' } });
  });

  test('a push service that refuses the JWT: the test says what to do', async () => {
    const { call, push, me } = setup();
    await call('PUT', '/api/push/subscription', subscription('/jwt/x'));
    const r = (await (await call('POST', '/api/push/test', {})).json()) as { ok: boolean; error: string };
    expect(r.ok).toBe(false);
    expect(r.error).toContain('BadJwtToken');
    expect(r.error).toContain('CAST_PUSH_CONTACT');
    expect(push.store!.get(me.device.id)?.lastError).toContain('403');
  });

  test('POST /api/push/presence → 204, for any signed-in page', async () => {
    const { call } = setup();
    expect((await call('POST', '/api/push/presence', { visible: true, page: 'abc_123' })).status).toBe(204);
    expect((await call('POST', '/api/push/presence', { visible: false, page: 'abc_123' }, { decision: { kind: 'allow', user: 'x', via: 'tailnet', deviceId: null } })).status).toBe(204);
  });

  test('signing the device out (Settings → Devices) ends its subscription', async () => {
    const { call, push, me, auth } = setup();
    auth.onRevoke((e) => push.forget(e.deviceIds)); // as server/index.ts wires it
    await call('PUT', '/api/push/subscription', subscription('/ok/out'));
    const other = auth.devices.create({ name: 'mac' });
    const req = new Request(`${BASE}/api/devices/${me.device.id}`, { method: 'DELETE', headers: { host: '127.0.0.1:4860', origin: BASE } });
    const res = await auth.api(req, new URL(req.url), { kind: 'allow', user: 'token', via: 'session', deviceId: other.device.id });
    expect(res!.status).toBe(200);
    expect(push.store!.list()).toHaveLength(0);
  });

  test('CAST_PUSH=off: GET says so, writes are refused, no push.json', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cast-pushoff-'));
    roots.push(dataDir);
    const push = createPush({ dataDir, enabled: false, devices: { get: () => ({}) }, contact: null, extraEndpoints: [], allowedOrigins: [] });
    const req = (method: string, path: string) => new Request(`${BASE}${path}`, { method, headers: { host: '127.0.0.1:4860' }, body: method === 'GET' ? undefined : '{}' });
    const d: AllowDecision = { kind: 'allow', user: 'token', via: 'session', deviceId: 'd-1' };
    const g = await push.routes(req('GET', '/api/push'), new URL(`${BASE}/api/push`), d)!;
    expect(await g.json()).toEqual({ enabled: false });
    expect((await push.routes(req('PUT', '/api/push/subscription'), new URL(`${BASE}/api/push/subscription`), d))!.status).toBe(409);
    expect(push.store).toBeNull();
    expect(await Bun.file(join(dataDir, 'push.json')).exists()).toBe(false);
  });
});
