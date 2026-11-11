// Unit tests of server/cities.ts: input checks, pairing (POST /api/pair only: a server without it is refused, so no
// pairing token is ever stored), the store's file (0600, no token in it), self/duplicate/too-old refusals and the
// status probe — against a fake fetch.
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CITY_PROXY_FEATURE } from '../../shared/cities';
import {
  CityError, cityIdFor, cityUrlFrom, cleanCityName, createCities, loadOrCreateInstanceId, normalizeCityUrl, pairWithServer, parsePairing, pickCookie,
  type FetchLike,
} from '../../server/cities';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'cast-cities-unit-'));
  dirs.push(d);
  return d;
}

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz012345';

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof CityError ? err.code : 'other';
  }
}
async function codeOfAsync(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (err) {
    return err instanceof CityError ? err.code : `other: ${(err as Error).message}`;
  }
}

describe('normalizeCityUrl', () => {
  test('origin only, no trailing slash or path', () => {
    expect(normalizeCityUrl('http://192.168.1.20:4860/')).toBe('http://192.168.1.20:4860');
    expect(normalizeCityUrl('  https://b.tail1.ts.net:8443/some/path?q=1#h ')).toBe('https://b.tail1.ts.net:8443');
    expect(normalizeCityUrl('HTTP://Example.COM')).toBe('http://example.com');
  });
  test('no scheme: https for tailnet names, http otherwise', () => {
    expect(normalizeCityUrl('b.tail1.ts.net:8443')).toBe('https://b.tail1.ts.net:8443');
    expect(normalizeCityUrl('192.168.1.20:4860')).toBe('http://192.168.1.20:4860');
    expect(normalizeCityUrl('studio:4860')).toBe('http://studio:4860');
  });
  test('refuses other schemes, credentials and junk', () => {
    expect(codeOf(() => normalizeCityUrl('ftp://x'))).toBe('invalid');
    expect(codeOf(() => normalizeCityUrl('file:///etc/passwd'))).toBe('invalid');
    expect(codeOf(() => normalizeCityUrl('javascript:alert(1)'))).toBe('invalid');
    expect(codeOf(() => normalizeCityUrl('http://user:pw@host:1'))).toBe('invalid');
    expect(codeOf(() => normalizeCityUrl('http://user@host:1'))).toBe('invalid');
    expect(codeOf(() => normalizeCityUrl(''))).toBe('invalid');
    expect(codeOf(() => normalizeCityUrl(42))).toBe('invalid');
    expect(codeOf(() => normalizeCityUrl('http://'))).toBe('invalid');
  });
});

describe('parsePairing', () => {
  test('a whole link or a bare token', () => {
    expect(parsePairing(`http://127.0.0.1:4860/?token=${TOKEN}`)).toEqual({ token: TOKEN, url: 'http://127.0.0.1:4860' });
    expect(parsePairing(`https://b.ts.net:8443/city/x/?a=1&token=${TOKEN}`)).toEqual({ token: TOKEN, url: 'https://b.ts.net:8443' });
    expect(parsePairing(`  ${TOKEN}\n`)).toEqual({ token: TOKEN, url: null });
  });
  test('refuses a link without a token, a cut token, junk', () => {
    expect(codeOf(() => parsePairing('http://host:1/'))).toBe('invalid');
    expect(codeOf(() => parsePairing('http://host:1/?token=short'))).toBe('invalid');
    expect(codeOf(() => parsePairing('not a token'))).toBe('invalid');
    expect(codeOf(() => parsePairing(''))).toBe('invalid');
  });
});

describe('names, ids, cookies', () => {
  test('cleanCityName', () => {
    expect(cleanCityName('  Studio\n  PC\u0000 ')).toBe('Studio PC');
    expect(cleanCityName('x'.repeat(80)).length).toBe(40);
    expect(cleanCityName(5)).toBe('');
  });
  test('cityIdFor: slug of the name, else the host; never home; unique', () => {
    const none = () => false;
    expect(cityIdFor('Studio PC', 'http://a:1', none)).toBe('studio-pc');
    expect(cityIdFor('บ้าน', 'http://studio-box.lan:1', none)).toBe('studio-box');
    expect(cityIdFor('Home', 'http://a:1', none)).toBe('home-city');
    expect(cityIdFor('Studio', 'http://a:1', (id) => id === 'studio')).toBe('studio-2');
    expect(cityIdFor('', 'http://10.0.0.1:1', none)).toBe('city');
    expect(cityIdFor('', 'http://[::1]:1', none)).toBe('city');
  });
  test('pickCookie takes the device session only (never the legacy token cookie), ignores clears and odd values', () => {
    expect(pickCookie(['rlt_token=T; Path=/', 'rlt_session=S; HttpOnly'])).toBe('rlt_session=S');
    expect(pickCookie(['rlt_token=T; Path=/'])).toBeNull();
    expect(pickCookie(['rlt_session=; Max-Age=0', 'rlt_token=T'])).toBeNull();
    expect(pickCookie(['rlt_session=S; Max-Age=0'])).toBeNull();
    expect(pickCookie(['other=1'])).toBeNull();
  });
  test('instance id is stable and 0600', () => {
    const d = tmp();
    const a = loadOrCreateInstanceId(d);
    expect(a).toMatch(/^[a-f0-9]{32}$/);
    expect(loadOrCreateInstanceId(d)).toBe(a);
    expect(statSync(join(d, 'instance-id')).mode & 0o777).toBe(0o600);
  });
});

// ── a fake CAST server behind fetch ──

interface FakeOpts {
  instanceId?: string;
  pair?: 'new' | 'old' | 'none';
  features?: string[];
  app?: string;
  noVersion?: boolean;
  healthCast?: boolean;
  down?: boolean;
  name?: string;
  session?: string;
}
function fakeServer(o: FakeOpts = {}) {
  const seen: { method: string; path: string; cookie: string | null; body?: string }[] = [];
  const session = o.session ?? 'rlt_session=SESSION123';
  const accepted = new Set([session, `rlt_token=${TOKEN}`]);
  const f: FetchLike = async (input, init) => {
    if (o.down) throw new TypeError('connect ECONNREFUSED');
    const u = new URL(input);
    const headers = new Headers(init?.headers);
    const cookie = headers.get('cookie');
    seen.push({ method: init?.method ?? 'GET', path: u.pathname + u.search, cookie, body: typeof init?.body === 'string' ? init.body : undefined });
    const json = (data: unknown, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...extra } });
    if (u.pathname === '/api/version' && !o.noVersion) {
      return json({ app: o.app ?? 'cast', version: '9.9.9', protocol: 1, features: o.features ?? [CITY_PROXY_FEATURE], instanceId: o.instanceId ?? 'remote-instance', paired: !!cookie && accepted.has(cookie), ...(cookie && accepted.has(cookie) ? { name: o.name ?? 'Beta box' } : {}) });
    }
    if (u.pathname === '/api/health') return json(o.healthCast ? { ok: true, name: 'cast', version: '0.1.0' } : { hello: 'world' });
    if (u.pathname === '/api/pair' && init?.method === 'POST' && o.pair !== 'old' && o.pair !== 'none') {
      const body = JSON.parse(String(init.body)) as { token: string };
      return body.token === TOKEN ? json({ cookie: session, deviceId: 'd1' }) : json({ error: 'wrong token' }, 403);
    }
    if (u.pathname === '/' && u.searchParams.has('token') && o.pair !== 'none') {
      if (u.searchParams.get('token') !== TOKEN) return new Response('Forbidden: bad-token\n', { status: 403 });
      return new Response(null, { status: 302, headers: { location: '/', 'set-cookie': `rlt_token=${TOKEN}; Path=/; HttpOnly` } });
    }
    return new Response('Forbidden: no-token\n', { status: 403, headers: { 'content-type': 'text/plain' } });
  };
  return { f, seen, session };
}

describe('pairWithServer', () => {
  test('new servers: POST /api/pair → the session cookie', async () => {
    const s = fakeServer({ pair: 'new' });
    expect(await pairWithServer(s.f, 'http://b:1', TOKEN, 'hub')).toEqual({ cookie: s.session });
    expect(s.seen.filter((r) => r.path.includes('token=')).length).toBe(0); // the token travels in the body only
  });
  test('older servers (no POST /api/pair) are refused as too old: no GET /?token=, no token cookie', async () => {
    for (const pair of ['old', 'none'] as const) {
      const s = fakeServer({ pair });
      expect(await codeOfAsync(pairWithServer(s.f, 'http://b:1', TOKEN, 'hub'))).toBe('too-old');
      expect(s.seen.map((r) => r.method + ' ' + r.path)).toEqual(['POST /api/pair']);
    }
  });
  test('a wrong token is reported as such', async () => {
    expect(await codeOfAsync(pairWithServer(fakeServer({ pair: 'new' }).f, 'http://b:1', 'x'.repeat(32), 'hub'))).toBe('bad-token');
  });
  test('a 200 that hands out no device session is not taken as a pairing', async () => {
    const f: FetchLike = async () => new Response(JSON.stringify({ cookie: `rlt_token=${TOKEN}` }), { status: 200, headers: { 'content-type': 'application/json' } });
    expect(await codeOfAsync(pairWithServer(f, 'http://b:1', TOKEN, 'hub'))).toBe('not-cast');
  });
  test('nothing listening', async () => {
    expect(await codeOfAsync(pairWithServer(fakeServer({ down: true }).f, 'http://b:1', TOKEN, 'hub'))).toBe('unreachable');
  });
});

describe('createCities', () => {
  test('add: verifies, pairs, stores only the cookie (0600, atomic), names the city', async () => {
    const d = tmp();
    const s = fakeServer({ pair: 'new' });
    const cities = createCities({ dataDir: d, instanceId: 'hub-instance', homeName: 'Alpha', version: '1.0.0', fetch: s.f });
    const city = await cities.add({ url: 'http://10.0.0.2:4860/', pairing: `http://127.0.0.1:4860/?token=${TOKEN}` });
    expect(city).toMatchObject({ id: 'beta-box', name: 'Beta box', url: 'http://10.0.0.2:4860', status: 'online', version: '9.9.9' });
    const file = join(d, 'cities.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const raw = readFileSync(file, 'utf8');
    expect(raw).not.toContain(TOKEN);
    expect(JSON.parse(raw)).toEqual([expect.objectContaining({ id: 'beta-box', url: 'http://10.0.0.2:4860', cookie: s.session, instanceId: 'remote-instance' })]);
    // and it loads back
    const again = createCities({ dataDir: d, instanceId: 'hub-instance', homeName: 'Alpha', version: '1.0.0', fetch: s.f });
    expect(again.get('beta-box')?.cookie).toBe(s.session);
    // the list never carries a cookie
    const list = await again.list();
    expect(JSON.stringify(list)).not.toContain('SESSION123');
    expect(list.home).toEqual({ id: 'home', name: 'Alpha', version: '1.0.0' });
    expect(list.cities[0]).toMatchObject({ id: 'beta-box', status: 'online' });
  });

  test('the address may come from the pairing link alone; a given name wins', async () => {
    const s = fakeServer({ pair: 'new' });
    const cities = createCities({ dataDir: tmp(), instanceId: 'hub', homeName: 'A', version: '1', fetch: s.f });
    const city = await cities.add({ name: 'Studio', url: '', pairing: `http://192.168.1.9:4860/?token=${TOKEN}` });
    expect(city).toMatchObject({ id: 'studio', name: 'Studio', url: 'http://192.168.1.9:4860' });
  });

  test('refuses itself, older and non-CAST servers, duplicates; nothing is stored', async () => {
    const d = tmp();
    const add = (o: FakeOpts, url = 'http://b:1') => createCities({ dataDir: d, instanceId: 'same-id', homeName: 'A', version: '1', fetch: fakeServer(o).f }).add({ url, pairing: TOKEN });
    expect(await codeOfAsync(add({ instanceId: 'same-id' }))).toBe('self');
    expect(await codeOfAsync(add({ features: [] }))).toBe('too-old');
    expect(await codeOfAsync(add({ noVersion: true, healthCast: true }))).toBe('too-old');
    expect(await codeOfAsync(add({ noVersion: true }))).toBe('not-cast');
    expect(await codeOfAsync(add({ app: 'other' }))).toBe('not-cast');
    expect(await codeOfAsync(add({ down: true }))).toBe('unreachable');
    expect(await codeOfAsync(add({ pair: 'new' }, 'http://b:1').then(() => 0).then(() => add({ pair: 'new' }, 'http://b:1')))).toBe('duplicate');
    expect(await codeOfAsync(add({ pair: 'new' }, 'http://b-alias:1'))).toBe('duplicate'); // same instanceId, other address
  });

  test('a pairing token pasted into the Address field is refused, and never repeated in the error', async () => {
    const messageOf = async (p: Promise<unknown>) => p.then(() => '', (err: Error) => err.message);
    const s = fakeServer({ pair: 'new', down: true }); // even a host that can't be reached must not be named
    const cities = createCities({ dataDir: tmp(), instanceId: 'hub', homeName: 'A', version: '1', fetch: s.f });
    for (const url of [TOKEN, `http://${TOKEN}:4860`, `https://${TOKEN.toLowerCase()}`, 'Zz9yX8wV7uT6sR5qP4oN3mL2']) {
      const msg = await messageOf(cities.add({ url, pairing: TOKEN }));
      expect(msg).toContain('Address field holds a pairing token');
      expect(msg.toLowerCase()).not.toContain(TOKEN.toLowerCase());
      expect(msg).not.toContain('Zz9yX8');
    }
    expect(s.seen).toEqual([]); // refused before anything was sent anywhere
    // ordinary addresses still go through (an unreachable one names its host: that is not a secret)
    expect(cityUrlFrom('studio-pc:4860', TOKEN)).toBe('http://studio-pc:4860');
    expect(cityUrlFrom('https://box.example.ts.net:8443', TOKEN)).toBe('https://box.example.ts.net:8443');
    expect(cityUrlFrom('DESKTOP-7K2J9QX', TOKEN)).toBe('http://desktop-7k2j9qx');
    expect(codeOf(() => cityUrlFrom(`http://x/?token=${TOKEN}`, TOKEN))).toBe('invalid');
  });

  test('rename keeps the id; re-pair swaps the cookie; remove forgets it', async () => {
    const d = tmp();
    const s = fakeServer({ pair: 'new' });
    const cities = createCities({ dataDir: d, instanceId: 'hub', homeName: 'A', version: '1', fetch: s.f });
    const c = await cities.add({ url: 'http://b:1', pairing: TOKEN, name: 'Beta' });
    expect(cities.get(c.id)?.cookie).toBe(s.session);
    expect((await cities.update(c.id, { name: 'Beta 2' })).id).toBe(c.id);
    expect(cities.get(c.id)?.name).toBe('Beta 2');
    expect(await codeOfAsync(cities.update(c.id, { name: '  ' }))).toBe('invalid');
    // re-pairing (a new pairing link from that machine) stores the new session
    const s2 = fakeServer({ pair: 'new', session: 'rlt_session=SESSION456' });
    const c2 = createCities({ dataDir: d, instanceId: 'hub', homeName: 'A', version: '1', fetch: s2.f });
    await c2.update(c.id, { pairing: TOKEN });
    expect(c2.get(c.id)?.cookie).toBe(s2.session);
    expect(readFileSync(join(d, 'cities.json'), 'utf8')).not.toContain(TOKEN);
    expect(c2.remove(c.id)).toBe(true);
    expect(c2.remove(c.id)).toBe(false);
    expect(JSON.parse(readFileSync(join(d, 'cities.json'), 'utf8'))).toEqual([]);
  });

  test('adoptCookie keeps a session the city renewed, and nothing else', async () => {
    const d = tmp();
    const cities = createCities({ dataDir: d, instanceId: 'hub', homeName: 'A', version: '1', fetch: fakeServer({ pair: 'new' }).f });
    const c = await cities.add({ url: 'http://b:1', pairing: TOKEN });
    cities.adoptCookie(c.id, 'rlt_session=NEW');
    expect(cities.get(c.id)?.cookie).toBe('rlt_session=NEW');
    cities.adoptCookie(c.id, 'bad cookie; x=1'); // never stores something that could smuggle more
    cities.adoptCookie(c.id, `rlt_token=${TOKEN}`); // nor a pairing token
    expect(cities.get(c.id)?.cookie).toBe('rlt_session=NEW');
  });

  test('a stored pairing token (an earlier build kept legacy cookies) is dropped on load, not sent', () => {
    const d = tmp();
    writeFileSync(join(d, 'cities.json'), JSON.stringify([
      { id: 'old-box', name: 'Old', url: 'http://b:1', cookie: `rlt_token=${TOKEN}`, addedAt: 1 },
      { id: 'new-box', name: 'New', url: 'http://c:1', cookie: 'rlt_session=S1', addedAt: 1 },
    ]));
    const cities = createCities({ dataDir: d, instanceId: 'hub', homeName: 'A', version: '1', fetch: fakeServer().f });
    expect(cities.get('old-box')).toBeUndefined();
    expect(cities.get('new-box')?.cookie).toBe('rlt_session=S1');
  });

  test('status: offline when it stops answering, error when it no longer accepts the pairing; cached', async () => {
    const d = tmp();
    let now = 1_000_000;
    let mode: 'up' | 'down' | 'unpaired' = 'up';
    const s = fakeServer({ pair: 'new' });
    const f: FetchLike = async (input, init) => {
      if (mode === 'down') throw new TypeError('ECONNREFUSED');
      if (mode === 'unpaired') return s.f(input, { ...init, headers: {} });
      return s.f(input, init);
    };
    const cities = createCities({ dataDir: d, instanceId: 'hub', homeName: 'A', version: '1', fetch: f, now: () => now, statusTtlMs: 10_000 });
    const c = await cities.add({ url: 'http://b:1', pairing: TOKEN });
    mode = 'down';
    expect((await cities.list()).cities[0]!.status).toBe('online'); // cached
    now += 11_000;
    expect((await cities.list()).cities[0]).toMatchObject({ status: 'offline' });
    mode = 'unpaired';
    now += 11_000;
    expect((await cities.list()).cities[0]).toMatchObject({ status: 'error', error: expect.stringContaining('re-pair') });
    cities.note(c.id, 'online');
    expect(cities.known(c.id)?.status).toBe('online');
  });

  test('a broken cities.json is moved aside, not overwritten silently', () => {
    const d = tmp();
    writeFileSync(join(d, 'cities.json'), '{nope');
    const cities = createCities({ dataDir: d, instanceId: 'hub', homeName: 'A', version: '1', fetch: fakeServer().f });
    expect(cities.get('x')).toBeUndefined();
    const { readdirSync } = require('node:fs') as typeof import('node:fs');
    expect(readdirSync(d).some((n: string) => n.startsWith('cities.json.bad-'))).toBe(true);
  });
});
