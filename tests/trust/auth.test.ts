// C2: pairing → device session, legacy rlt_token upgrade, POST /api/pair, one-time codes, rate limit, Tailscale header
// trust (allowlist + loopback peer + tailnet Host), revocation closing WebSockets, the devices API.
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuth, PAIR_FAILURE_LIMIT, pairLimitKey, type AuthOptions } from '../../server/auth';
import { createDeviceSockets, WS_SIGNED_OUT } from '../../server/device-sockets';
import { deviceNameFromUserAgent } from '../../server/devices';
import { forbiddenPage } from '../../server/pages';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
function setup(o: Partial<AuthOptions> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'cast-auth-'));
  roots.push(dataDir);
  const auth = createAuth({ dataDir, allowedUsers: [], allowedOrigins: [], ...o });
  return { auth, dataDir };
}

const CHROME_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const BASE = 'http://127.0.0.1:4860';

function req(path: string, o: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  const url = new URL(path, BASE);
  const headers = { host: '127.0.0.1:4860', 'user-agent': CHROME_MAC, ...o.headers };
  return { req: new Request(url, { method: o.method ?? 'GET', headers, body: o.body }), url };
}
const page = (path: string, cookie?: string) => req(path, { headers: { accept: 'text/html', ...(cookie ? { cookie } : {}) } });

/** The rlt_session=<secret> pair out of Set-Cookie lines. */
function sessionOf(setCookie: string[] | undefined): string {
  const c = (setCookie ?? []).find((x) => x.startsWith('rlt_session=') && !x.startsWith('rlt_session=;'));
  if (!c) throw new Error(`no session cookie in ${JSON.stringify(setCookie)}`);
  return c.split(';')[0]!;
}

describe('pairing with ?token=', () => {
  test('a page load with the token → 302 to the clean URL + a session cookie (never the token)', () => {
    const { auth } = setup();
    const { req: r, url } = page(`/house/x?token=${auth.token}&tab=chat`);
    const d = auth.check(r, url, { peer: '127.0.0.1' });
    expect(d.kind).toBe('redirect');
    if (d.kind !== 'redirect') return;
    expect(d.location).toBe('/house/x?tab=chat');
    const cookies = d.setCookie.join('\n');
    expect(cookies).toContain('rlt_session=');
    expect(cookies).toContain('HttpOnly');
    expect(cookies).toContain('SameSite=Lax');
    expect(cookies).toContain('Path=/');
    expect(cookies).toContain('Max-Age=31536000');
    expect(cookies).toContain('rlt_token=; '); // any legacy cookie is cleared
    expect(cookies).not.toContain(auth.token);
    expect(auth.devices.list()).toHaveLength(1);
    expect(auth.devices.list()[0]!.name).toBe('Chrome on macOS');

    // the session lets the browser in, and opens the WebSocket without an Origin (scripts, city proxy)
    const cookie = sessionOf(d.setCookie);
    const again = page('/', cookie);
    const ok = auth.check(again.req, again.url);
    expect(ok.kind).toBe('allow');
    if (ok.kind === 'allow') expect(ok.via).toBe('session');
    const ws = req('/ws', { headers: { cookie } });
    expect(auth.check(ws.req, ws.url, { websocket: true }).kind).toBe('allow');
  });

  test('Secure on https (direct or behind tailscale serve)', () => {
    const { auth } = setup();
    const r = new Request(`https://box.tail.ts.net/?token=${auth.token}`, { headers: { accept: 'text/html' } });
    const d = auth.check(r, new URL(r.url));
    expect(d.kind === 'redirect' && d.setCookie[0]).toContain('Secure');
    const f = req(`/?token=${auth.token}`, { headers: { 'x-forwarded-proto': 'https' } });
    const d2 = auth.check(f.req, f.url);
    expect(d2.kind === 'redirect' && d2.setCookie[0]).toContain('Secure');
  });

  test('a second click on the link keeps the same device', () => {
    const { auth } = setup();
    const first = page(`/?token=${auth.token}`);
    const d1 = auth.check(first.req, first.url);
    const cookie = sessionOf(d1.kind === 'redirect' ? d1.setCookie : []);
    const second = page(`/?token=${auth.token}`, cookie);
    const d2 = auth.check(second.req, second.url);
    expect(d2.kind).toBe('redirect');
    expect(sessionOf(d2.kind === 'redirect' ? d2.setCookie : [])).toBe(cookie);
    expect(auth.devices.list()).toHaveLength(1);
  });

  test('a wrong token is refused; scripts may use the token itself on WS / non-GET without a session', () => {
    const { auth } = setup();
    const bad = page('/?token=not-the-token');
    expect(auth.check(bad.req, bad.url)).toEqual({ kind: 'deny', reason: 'bad-token' });
    const ws = req(`/ws?token=${auth.token}`);
    const d = auth.check(ws.req, ws.url, { websocket: true });
    expect(d.kind === 'allow' && d.via).toBe('token');
    expect(auth.devices.list()).toHaveLength(0);
  });

  test('a one-time pairing code works once, only for pairing a device', () => {
    const { auth } = setup();
    const { code } = auth.devices.newPairCode();
    const asWs = req(`/ws?token=${code}`);
    expect(auth.check(asWs.req, asWs.url, { websocket: true }).kind).toBe('deny');
    const p = page(`/?token=${code}`);
    expect(auth.check(p.req, p.url).kind).toBe('redirect');
    const reuse = page(`/?token=${code}`);
    expect(auth.check(reuse.req, reuse.url)).toEqual({ kind: 'deny', reason: 'bad-token' });
  });

  test('a one-time code made from a city (Pair a phone under /city/<id>/) pairs with the hub and lands in that city', () => {
    const { auth } = setup();
    const { code } = auth.devices.newPairCode();
    const p = page(`/city/harbor/?token=${code}`);
    const d = auth.check(p.req, p.url, { peer: '127.0.0.1' });
    expect(d.kind === 'redirect' && d.location).toBe('/city/harbor/');
  });

  test('one-time codes expire', () => {
    let now = 1_000_000;
    const { auth } = setup({ now: () => now });
    const { code, expiresAt } = auth.devices.newPairCode();
    now = expiresAt + 1;
    const p = page(`/?token=${code}`);
    expect(auth.check(p.req, p.url).kind).toBe('deny');
  });

  test('too many wrong tokens from one address → its wrong tries are refused (429); the right token still pairs; others unaffected', () => {
    let now = 5_000_000;
    const { auth } = setup({ now: () => now });
    for (let i = 0; i < PAIR_FAILURE_LIMIT; i++) {
      const b = page(`/?token=wrong-${i}`);
      expect(auth.check(b.req, b.url, { peer: '100.64.0.9' })).toEqual({ kind: 'deny', reason: 'bad-token' });
    }
    const wrong = page('/?token=wrong-again');
    expect(auth.check(wrong.req, wrong.url, { peer: '100.64.0.9' })).toEqual({ kind: 'deny', reason: 'rate-limited' });
    // the token and a one-time code are high-entropy secrets: failing on purpose must not lock the owner out
    const right = page(`/?token=${auth.token}`);
    expect(auth.check(right.req, right.url, { peer: '100.64.0.9' }).kind).toBe('redirect');
    const { code } = auth.devices.newPairCode();
    const once = page(`/?token=${code}`);
    expect(auth.check(once.req, once.url, { peer: '100.64.0.9' }).kind).toBe('redirect');
    const script = req(`/ws?token=${auth.token}`);
    expect(auth.check(script.req, script.url, { peer: '100.64.0.9', websocket: true }).kind).toBe('allow');
    // still blocked for wrong ones; another address is not
    expect(auth.check(wrong.req, wrong.url, { peer: '100.64.0.9' })).toEqual({ kind: 'deny', reason: 'rate-limited' });
    expect(auth.check(wrong.req, wrong.url, { peer: '100.64.0.10' })).toEqual({ kind: 'deny', reason: 'bad-token' });
    now += 11 * 60 * 1000;
    expect(auth.check(wrong.req, wrong.url, { peer: '100.64.0.9' })).toEqual({ kind: 'deny', reason: 'bad-token' });
    const res = auth.denyResponse({ kind: 'deny', reason: 'rate-limited' }, page('/').req);
    expect(res.status).toBe(429);
  });

  test('behind tailscale serve (loopback peer) each tailnet device is limited on its own X-Forwarded-For address', () => {
    const { auth } = setup();
    const via = (path: string, fwd?: string) => req(path, { headers: { accept: 'text/html', ...(fwd ? { 'x-forwarded-for': fwd } : {}) } });
    for (let i = 0; i < PAIR_FAILURE_LIMIT; i++) {
      const b = via(`/?token=wrong-${i}`, '100.101.102.103');
      auth.check(b.req, b.url, { peer: '127.0.0.1' });
    }
    const pest = via('/?token=nope', '100.101.102.103');
    expect(auth.check(pest.req, pest.url, { peer: '127.0.0.1' })).toEqual({ kind: 'deny', reason: 'rate-limited' });
    // another tailnet device behind the same serve is not blocked by the pest
    const other = via('/?token=typo', '100.64.0.2');
    expect(auth.check(other.req, other.url, { peer: '::ffff:127.0.0.1' })).toEqual({ kind: 'deny', reason: 'bad-token' });
    // the header counts only from loopback: from the LAN it is ignored (keyed on the real peer)
    for (let i = 0; i < PAIR_FAILURE_LIMIT; i++) {
      const b = via(`/?token=lan-${i}`, `10.9.9.${i}`);
      auth.check(b.req, b.url, { peer: '192.168.1.50' });
    }
    const lan = via('/?token=lan-x', '10.9.9.200');
    expect(auth.check(lan.req, lan.url, { peer: '192.168.1.50' })).toEqual({ kind: 'deny', reason: 'rate-limited' });
  });

  test('pairLimitKey: X-Forwarded-For only from loopback, only a real address, the last hop wins', () => {
    const r = (fwd?: string) => new Request(`${BASE}/`, { headers: fwd ? { 'x-forwarded-for': fwd } : {} });
    expect(pairLimitKey(r('100.64.0.7'), '127.0.0.1')).toBe('fwd:100.64.0.7');
    expect(pairLimitKey(r('fd7a:115c:a1e0::1'), '::1')).toBe('fwd:fd7a:115c:a1e0::1');
    expect(pairLimitKey(r('6.6.6.6, 100.64.0.7'), '127.0.0.1')).toBe('fwd:100.64.0.7');
    expect(pairLimitKey(r('100.64.0.7'), '100.64.0.9')).toBe('100.64.0.9'); // not loopback: the header is not trusted
    expect(pairLimitKey(r('not-an-address'), '127.0.0.1')).toBe('127.0.0.1');
    expect(pairLimitKey(r(), '127.0.0.1')).toBe('127.0.0.1');
    expect(pairLimitKey(r(), null)).toBe('unknown');
  });
});

describe('legacy rlt_token cookie', () => {
  test('accepted once and silently upgraded to a session; the old cookie is cleared', () => {
    const { auth } = setup();
    const p = page('/', `rlt_token=${encodeURIComponent(auth.token)}`);
    const d = auth.check(p.req, p.url);
    expect(d.kind).toBe('allow');
    if (d.kind !== 'allow') return;
    expect(d.via).toBe('session');
    expect(d.deviceId).toMatch(/^d-/);
    const cookies = d.setCookie!.join('\n');
    expect(cookies).toContain('rlt_session=');
    expect(cookies).toMatch(/rlt_token=; .*Max-Age=0/);
    // the parallel requests of the same page load share that one session
    const asset = req('/assets/x.js', { headers: { cookie: `rlt_token=${auth.token}` } });
    const d2 = auth.check(asset.req, asset.url);
    expect(d2.kind === 'allow' && d2.deviceId).toBe(d.deviceId);
    expect(auth.devices.list()).toHaveLength(1);
  });

  test('a wrong legacy cookie is a bad token; a revoked session is not revived by a leftover legacy cookie', () => {
    const { auth } = setup();
    const p = page('/', 'rlt_token=old-token-from-before');
    expect(auth.check(p.req, p.url)).toEqual({ kind: 'deny', reason: 'bad-token' });
    const { secret, device } = auth.devices.create({ userAgent: CHROME_MAC });
    auth.devices.revoke([device.id]);
    const both = page('/', `rlt_session=${secret}; rlt_token=${auth.token}`);
    expect(auth.check(both.req, both.url)).toEqual({ kind: 'deny', reason: 'signed-out' });
  });
});

describe('POST /api/pair', () => {
  const pairReq = (body: unknown) =>
    new Request(`${BASE}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'Bun/1.4' }, body: JSON.stringify(body) });

  test('token → {cookie, deviceId}; the cookie works', async () => {
    const { auth } = setup();
    const res = await auth.pair(pairReq({ token: auth.token, device: 'Hub on studio' }), '127.0.0.1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cookie: string; deviceId: string };
    expect(body.cookie).toMatch(/^rlt_session=[A-Za-z0-9_-]{40,}$/);
    expect(auth.devices.get(body.deviceId)?.name).toBe('Hub on studio');
    const ws = req('/ws', { headers: { cookie: body.cookie } });
    const d = auth.check(ws.req, ws.url, { websocket: true });
    expect(d.kind === 'allow' && d.deviceId).toBe(body.deviceId);
  });

  test('a pasted pairing link and a one-time code work too', async () => {
    const { auth } = setup();
    expect((await auth.pair(pairReq({ token: `https://other.example:4860/?token=${auth.token}` }), null)).status).toBe(200);
    const { code } = auth.devices.newPairCode();
    expect((await auth.pair(pairReq({ token: code }), null)).status).toBe(200);
    expect((await auth.pair(pairReq({ token: code }), null)).status).toBe(403); // used up
  });

  test('bad token → 403 {error}; repeated failures → 429 for wrong tokens only; bad bodies → 400/405', async () => {
    const { auth } = setup();
    const res = await auth.pair(pairReq({ token: 'nope' }), '10.0.0.5');
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain('doesn’t match');
    for (let i = 1; i < PAIR_FAILURE_LIMIT; i++) await auth.pair(pairReq({ token: 'nope' }), '10.0.0.5');
    const limited = await auth.pair(pairReq({ token: 'nope' }), '10.0.0.5');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
    expect(JSON.stringify(await limited.json())).not.toContain('nope'); // never echoes what was sent
    // the right token, and a one-time code, still pair from that address
    expect((await auth.pair(pairReq({ token: auth.token, device: 'Owner phone' }), '10.0.0.5')).status).toBe(200);
    expect((await auth.pair(pairReq({ token: auth.devices.newPairCode().code }), '10.0.0.5')).status).toBe(200);
    expect((await auth.pair(pairReq({ token: 'nope' }), '10.0.0.5')).status).toBe(429);
    // behind tailscale serve: keyed on the forwarded tailnet address, so one pest doesn't block the others
    const fwd = (token: string, ip: string) =>
      new Request(`${BASE}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify({ token }) });
    for (let i = 0; i < PAIR_FAILURE_LIMIT; i++) await auth.pair(fwd('nope', '100.64.0.66'), '127.0.0.1');
    expect((await auth.pair(fwd('nope', '100.64.0.66'), '127.0.0.1')).status).toBe(429);
    expect((await auth.pair(fwd('nope', '100.64.0.67'), '127.0.0.1')).status).toBe(403);
    expect((await auth.pair(new Request(`${BASE}/api/pair`, { method: 'POST', body: 'not json' }), '10.0.0.6')).status).toBe(400);
    expect((await auth.pair(new Request(`${BASE}/api/pair`), '10.0.0.6')).status).toBe(405);
  });
});

describe('Tailscale-User-Login', () => {
  const tailnet = (login: string, o: { host?: string } = {}) =>
    req('/', { headers: { accept: 'text/html', 'tailscale-user-login': login, host: o.host ?? 'box.your-tailnet.ts.net' } });

  test('ignored entirely while the allowlist is empty (the default)', () => {
    const { auth } = setup();
    const r = tailnet('anyone@example.com');
    expect(auth.check(r.req, r.url, { peer: '127.0.0.1' })).toEqual({ kind: 'deny', reason: 'no-token' });
  });

  test('trusted only from a loopback peer with a tailnet Host, for listed logins', () => {
    const { auth } = setup({ allowedUsers: ['owner@example.com'] });
    const ok = tailnet('Owner@Example.com');
    const d = auth.check(ok.req, ok.url, { peer: '127.0.0.1' });
    expect(d.kind === 'allow' && d.via).toBe('tailnet');
    expect(auth.check(ok.req, ok.url, { peer: '::ffff:127.0.0.1' }).kind).toBe('allow');
    // the same header from the LAN (CAST bound to 0.0.0.0) counts for nothing
    expect(auth.check(ok.req, ok.url, { peer: '192.168.1.50' })).toEqual({ kind: 'deny', reason: 'no-token' });
    expect(auth.check(ok.req, ok.url, {})).toEqual({ kind: 'deny', reason: 'no-token' });
    // a DNS-rebinding page sends its own domain as Host
    const rebound = tailnet('owner@example.com', { host: 'evil.example.com' });
    expect(auth.check(rebound.req, rebound.url, { peer: '127.0.0.1' })).toEqual({ kind: 'deny', reason: 'no-token' });
    // a login not on the list is told why — and may still pair
    const guest = tailnet('guest@example.com');
    expect(auth.check(guest.req, guest.url, { peer: '127.0.0.1' })).toEqual({ kind: 'deny', reason: 'not-allowed', login: 'guest@example.com' });
    const { secret } = auth.devices.create({ userAgent: CHROME_MAC });
    const paired = req('/', { headers: { 'tailscale-user-login': 'guest@example.com', host: 'box.your-tailnet.ts.net', cookie: `rlt_session=${secret}` } });
    expect(auth.check(paired.req, paired.url, { peer: '127.0.0.1' }).kind).toBe('allow');
  });
});

describe('WebSocket origin', () => {
  test('a foreign Origin is refused even with a valid session', () => {
    const { auth } = setup();
    const { secret } = auth.devices.create({});
    const r = req('/ws', { headers: { cookie: `rlt_session=${secret}`, origin: 'https://evil.example' } });
    expect(auth.check(r.req, r.url, { websocket: true })).toEqual({ kind: 'deny', reason: 'bad-origin' });
    const same = req('/ws', { headers: { cookie: `rlt_session=${secret}`, origin: BASE } });
    expect(auth.check(same.req, same.url, { websocket: true }).kind).toBe('allow');
  });
});

describe('revocation and rotation', () => {
  function fakeSocket(deviceId: string | null, via: 'session' | 'token' | 'tailnet' = 'session') {
    const s = { data: { deviceId, via }, closed: null as null | { code?: number; reason?: string }, close(code?: number, reason?: string) { s.closed = { code, reason }; } };
    return s;
  }

  test('revoking a device closes its sockets (only its own) and later requests say signed-out', async () => {
    const { auth } = setup();
    const sockets = createDeviceSockets<ReturnType<typeof fakeSocket>>();
    auth.onRevoke((e) => sockets.revoked(e));
    const a = auth.devices.create({ name: 'phone' });
    const b = auth.devices.create({ name: 'laptop' });
    const wsA = fakeSocket(a.device.id);
    const termA = fakeSocket(a.device.id);
    const wsB = fakeSocket(b.device.id);
    for (const s of [wsA, termA, wsB]) sockets.add(s);

    const me = req('/api/devices/' + a.device.id, { method: 'DELETE', headers: { cookie: `rlt_session=${b.secret}`, origin: BASE } });
    const dec = auth.check(me.req, me.url);
    if (dec.kind !== 'allow') throw new Error('expected allow');
    const res = await auth.api(me.req, me.url, dec)!;
    expect(res.status).toBe(200);
    expect(wsA.closed?.code).toBe(WS_SIGNED_OUT);
    expect(termA.closed?.code).toBe(WS_SIGNED_OUT);
    expect(wsB.closed).toBeNull();
    const after = page('/', `rlt_session=${a.secret}`);
    expect(auth.check(after.req, after.url)).toEqual({ kind: 'deny', reason: 'signed-out' });
    expect(auth.denyResponse({ kind: 'deny', reason: 'signed-out' }, after.req).status).toBe(403);
  });

  test('rotating the token ends old links and token sockets, keeps sessions; revokeAll signs out the others', async () => {
    const { auth, dataDir } = setup();
    const sockets = createDeviceSockets<ReturnType<typeof fakeSocket>>();
    auth.onRevoke((e) => sockets.revoked(e));
    const oldToken = auth.token;
    const me = auth.devices.create({ name: 'me' });
    const other = auth.devices.create({ name: 'other' });
    const script = fakeSocket(null, 'token');
    const otherWs = fakeSocket(other.device.id);
    sockets.add(script);
    sockets.add(otherWs);

    const call = async (body: unknown) => {
      const r = req('/api/devices/rotate-token', { method: 'POST', headers: { cookie: `rlt_session=${me.secret}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const d = auth.check(r.req, r.url);
      if (d.kind !== 'allow') throw new Error('expected allow');
      return (await auth.api(r.req, r.url, d)!).json() as Promise<{ ok: boolean; revoked: number; tokenFile: string }>;
    };
    const r1 = await call({});
    expect(r1.ok).toBe(true);
    expect(JSON.stringify(r1)).not.toContain(auth.token); // the token stays on the server machine
    expect(auth.token).not.toBe(oldToken);
    expect(readFileSync(join(dataDir, 'token'), 'utf8').trim()).toBe(auth.token);
    expect(script.closed?.code).toBe(WS_SIGNED_OUT);
    expect(otherWs.closed).toBeNull();
    const oldLink = page(`/?token=${oldToken}`);
    expect(auth.check(oldLink.req, oldLink.url).kind).toBe('deny');
    const stillIn = page('/', `rlt_session=${other.secret}`);
    expect(auth.check(stillIn.req, stillIn.url).kind).toBe('allow');

    const r2 = await call({ revokeAll: true });
    expect(r2.revoked).toBe(1);
    expect(otherWs.closed?.code).toBe(WS_SIGNED_OUT);
    expect(auth.devices.list().map((d) => d.name)).toEqual(['me']);
  });
});

describe('devices API', () => {
  async function call(auth: ReturnType<typeof setup>['auth'], path: string, cookie: string, o: { method?: string; origin?: string } = {}) {
    const r = req(path, { method: o.method, headers: { cookie, ...(o.origin ? { origin: o.origin } : {}) } });
    const d = auth.check(r.req, r.url);
    if (d.kind !== 'allow') throw new Error(`not allowed: ${JSON.stringify(d)}`);
    const res = await auth.api(r.req, r.url, d);
    if (!res) throw new Error('not an api path');
    return res;
  }

  test('list marks this device; revoke-others; sign out this device; pair-link', async () => {
    const { auth } = setup();
    const me = auth.devices.create({ name: 'me' });
    auth.devices.create({ name: 'old phone' });
    auth.devices.create({ name: 'tablet' });
    const list = (await (await call(auth, '/api/devices', `rlt_session=${me.secret}`)).json()) as { devices: { id: string; name: string; current: boolean }[]; currentId: string };
    expect(list.devices).toHaveLength(3);
    expect(list.devices.find((d) => d.current)?.name).toBe('me');
    expect(list.currentId).toBe(me.device.id);
    expect(JSON.stringify(list)).not.toContain('hash');

    const session = (await (await call(auth, '/api/session', `rlt_session=${me.secret}`)).json()) as { via: string; deviceName: string };
    expect(session).toMatchObject({ via: 'session', deviceName: 'me' });

    const others = (await (await call(auth, '/api/devices/revoke-others', `rlt_session=${me.secret}`, { method: 'POST', origin: BASE })).json()) as { revoked: number };
    expect(others.revoked).toBe(2);

    const link = (await (await call(auth, '/api/devices/pair-link', `rlt_session=${me.secret}`, { method: 'POST' })).json()) as { code: string; path: string; expiresAt: number };
    expect(link.path).toBe(`/?token=${link.code}`);
    expect(link.code).not.toBe(auth.token);
    expect(link.expiresAt).toBeGreaterThan(Date.now());

    const out = await call(auth, `/api/devices/${me.device.id}`, `rlt_session=${me.secret}`, { method: 'DELETE' });
    expect(((await out.json()) as { signedOut: boolean }).signedOut).toBe(true);
    expect(auth.devices.list()).toHaveLength(0);
  });

  test('state-changing calls from another origin are refused; unknown devices 404', async () => {
    const { auth } = setup();
    const me = auth.devices.create({ name: 'me' });
    const res = await call(auth, '/api/devices/revoke-others', `rlt_session=${me.secret}`, { method: 'POST', origin: 'http://localhost:3000' });
    expect(res.status).toBe(403);
    expect((await call(auth, '/api/devices/d-0123456789ab', `rlt_session=${me.secret}`, { method: 'DELETE' })).status).toBe(404);
  });

  test('devices.json keeps hashes only, mode 0600, and survives a restart', () => {
    const { auth, dataDir } = setup();
    const { secret, device } = auth.devices.create({ name: 'phone', userAgent: CHROME_MAC });
    const file = join(dataDir, 'devices.json');
    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain(secret);
    expect(text).toContain(device.id);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(dataDir, 'token')).mode & 0o777).toBe(0o600);
    const again = createAuth({ dataDir, allowedUsers: [], allowedOrigins: [] });
    expect(again.devices.verify(secret)?.id).toBe(device.id);
  });
});

test('device names from user agents', () => {
  expect(deviceNameFromUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1')).toBe('Safari on iPhone');
  expect(deviceNameFromUserAgent('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36')).toBe('Chrome on Android');
  expect(deviceNameFromUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36 Edg/120')).toBe('Edge on Windows');
  expect(deviceNameFromUserAgent('curl/8.5.0')).toBe('curl');
  expect(deviceNameFromUserAgent(null)).toBe('Unknown device');
});

test('the 403 page names the real token file and command, never "poc"', () => {
  const html = forbiddenPage('no-token', { pairing: { tokenFile: '~/.local/share/cast/token', command: 'bun run pair' } });
  expect(html).toContain('~/.local/share/cast/token');
  expect(html).toContain('bun run pair');
  expect(html).toContain('Pair a phone');
  expect(html).not.toMatch(/\bpoc\b/);
  expect(forbiddenPage('bad-token')).not.toContain('anymore');
  expect(forbiddenPage('signed-out')).toContain('signed out');
});
