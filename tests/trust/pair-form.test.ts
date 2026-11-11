// Pairing inside CAST on a phone's Home Screen: that app has its own cookie jar (pairing in Safari doesn't carry over)
// and no address bar, so the private page has a field to paste a pairing link or type a short code. The form posts
// to /api/pair (x-www-form-urlencoded) and gets a 303 to where it was going, with the session cookie.
// Short codes (12 Crockford characters, 60 bits) are checked only while the address is not rate-limited; the pairing
// token and long codes always work, so nobody can lock the owner out.
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuth, PAIR_FAILURE_LIMIT, type AuthOptions } from '../../server/auth';
import { normalizeShortCode, PAIR_CODE_TTL_MS } from '../../server/devices';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function setup(o: Partial<AuthOptions> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'cast-pairform-'));
  roots.push(dataDir);
  let t = 1_800_000_000_000;
  const clock = { now: () => t, advance: (ms: number) => (t += ms) };
  const auth = createAuth({ dataDir, allowedUsers: [], allowedOrigins: [], now: clock.now, ...o });
  return { auth, clock };
}

const BASE = 'http://127.0.0.1:4860';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Mobile/15E148 Safari/604.1';

function form(fields: Record<string, string>, o: { headers?: Record<string, string>; base?: string } = {}): Request {
  return new Request(`${o.base ?? BASE}/api/pair`, {
    method: 'POST',
    headers: {
      host: new URL(o.base ?? BASE).host,
      origin: o.base ?? BASE,
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'text/html,application/xhtml+xml',
      'user-agent': IPHONE,
      ...o.headers,
    },
    body: new URLSearchParams(fields).toString(),
  });
}

const cookiesOf = (res: Response) => res.headers.getSetCookie().join('\n');
const sessionOf = (res: Response) => res.headers.getSetCookie().find((c) => c.startsWith('rlt_session=') && !c.startsWith('rlt_session=;'))?.split(';')[0];

describe('the private page’s form', () => {
  test('a whole pasted link, a bare long code, the token, or a typed short code each pair: 303 + session cookie', async () => {
    const { auth } = setup();
    const inputs = [
      () => `https://box.tail.ts.net:8443/?token=${auth.devices.newPairCode().code}`,
      () => auth.devices.newPairCode().code,
      () => `  ${auth.token}  `,
      () => auth.devices.newPairCode().short.toLowerCase(),
      () => {
        const s = auth.devices.newPairCode().short;
        return `${s.slice(0, 4)} ${s.slice(4, 8)}-${s.slice(8)}`;
      },
    ];
    for (const input of inputs) {
      const res = await auth.pair(form({ token: input(), next: '/' }), '127.0.0.1');
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe('/');
      expect(res.headers.get('cache-control')).toBe('no-store');
      const cookies = cookiesOf(res);
      expect(cookies).toContain('rlt_session=');
      expect(cookies).toContain('HttpOnly');
      expect(cookies).toContain('rlt_token=; '); // a legacy cookie is cleared
      expect(cookies).not.toContain(auth.token);
      // the cookie lets the browser in
      const page = new Request(`${BASE}/`, { headers: { accept: 'text/html', cookie: sessionOf(res)! } });
      expect(auth.check(page, new URL(page.url)).kind).toBe('allow');
    }
    expect(auth.devices.list()).toHaveLength(inputs.length);
  });

  test('O/0 and I/L/1 mix-ups in a short code still pair', async () => {
    const { auth } = setup();
    let short = auth.devices.newPairCode().short;
    for (let i = 0; i < 50 && !/[01]/.test(short); i++) short = auth.devices.newPairCode().short;
    const typed = short.replace(/0/g, 'o').replace(/1/g, 'l');
    expect(normalizeShortCode(typed)).toBe(short);
    expect((await auth.pair(form({ token: typed }), '127.0.0.1')).status).toBe(303);
  });

  test('Secure on https behind tailscale serve', async () => {
    const { auth } = setup();
    const res = await auth.pair(form({ token: auth.token }, { headers: { 'x-forwarded-proto': 'https' } }), '127.0.0.1');
    expect(res.headers.getSetCookie().find((c) => c.startsWith('rlt_session='))).toContain('Secure');
  });

  test('Location is safeNext(next): another site, //host or a scheme fall back to /', async () => {
    const { auth } = setup();
    const go = async (next: string) => (await auth.pair(form({ token: auth.token, next }), '127.0.0.1')).headers.get('location');
    expect(await go('/#/house/todo-api')).toBe('/#/house/todo-api');
    expect(await go('/city/beta/?x=1')).toBe('/city/beta/?x=1');
    expect(await go('/?token=abc&settings=pair')).toBe('/?settings=pair');
    for (const bad of ['//evil.example', 'https://x', '\\\\evil', 'javascript:alert(1)', '']) expect(await go(bad)).toBe('/');
  });

  test('a wrong value → 403 page with the form again, never the value sent', async () => {
    const { auth } = setup();
    const res = await auth.pair(form({ token: 'MY-SECRET-TYPO-1234', next: '/#/house/x' }), '10.0.0.5');
    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'self'");
    const html = await res.text();
    expect(html).toContain('<form class="pair-form" method="post" action="/api/pair"');
    expect(html).toContain('didn’t work');
    expect(html).not.toContain('MY-SECRET-TYPO');
    expect(html).toContain('value="/#/house/x"'); // where it was going is kept
  });

  test(`${PAIR_FAILURE_LIMIT} wrong → the rate-limited page; then short codes are refused, long codes and the token still pair`, async () => {
    const { auth } = setup();
    for (let i = 0; i < PAIR_FAILURE_LIMIT; i++) expect((await auth.pair(form({ token: `wrong-${i}` }), '10.0.0.7')).status).toBe(403);
    const limited = await auth.pair(form({ token: 'wrong-again' }), '10.0.0.7');
    expect(limited.status).toBe(429);
    expect(await limited.text()).toContain('Too many');
    const { short, code } = auth.devices.newPairCode();
    expect((await auth.pair(form({ token: short }), '10.0.0.7')).status).toBe(429);
    // the refusal didn't use that code up: its long form still pairs from here
    expect((await auth.pair(form({ token: code }), '10.0.0.7')).status).toBe(303);
    expect((await auth.pair(form({ token: auth.token }), '10.0.0.7')).status).toBe(303);
    // another address isn't affected
    expect((await auth.pair(form({ token: auth.devices.newPairCode().short }), '10.0.0.8')).status).toBe(303);
  });

  test('short codes on ?token= page loads too, under the same blocked rule', () => {
    const { auth } = setup();
    const { short } = auth.devices.newPairCode();
    const page = (q: string, peer: string) => {
      const r = new Request(`${BASE}/?token=${encodeURIComponent(q)}`, { headers: { accept: 'text/html', 'user-agent': IPHONE } });
      return auth.check(r, new URL(r.url), { peer });
    };
    expect(page(short, '10.0.0.9').kind).toBe('redirect');
    for (let i = 0; i < PAIR_FAILURE_LIMIT; i++) page('nope', '10.0.0.10');
    const second = auth.devices.newPairCode();
    expect(page(second.short, '10.0.0.10')).toMatchObject({ kind: 'deny', reason: 'rate-limited' });
    expect(page(second.code, '10.0.0.10').kind).toBe('redirect');
  });

  test('an already-paired browser keeps its session; app=1 names the device “… (Home Screen app)”', async () => {
    const { auth } = setup();
    const first = await auth.pair(form({ token: auth.token, app: '1' }), '127.0.0.1');
    expect(auth.devices.list().map((d) => d.name)).toEqual(['Safari on iPhone (Home Screen app)']);
    const again = await auth.pair(form({ token: auth.devices.newPairCode().code }, { headers: { cookie: sessionOf(first)! } }), '127.0.0.1');
    expect(again.status).toBe(303);
    expect(sessionOf(again)).toBe(sessionOf(first));
    expect(auth.devices.list()).toHaveLength(1);
    await auth.pair(form({ token: auth.token, app: '' }), '127.0.0.1');
    expect(auth.devices.list().map((d) => d.name).sort()).toEqual(['Safari on iPhone', 'Safari on iPhone (Home Screen app)']);
  });

  test('a cross-site Origin is refused, and uses nothing up', async () => {
    const { auth } = setup();
    const { code } = auth.devices.newPairCode();
    const res = await auth.pair(form({ token: code }, { headers: { origin: 'https://evil.example' } }), '127.0.0.1');
    expect(res.status).toBe(403);
    expect(res.headers.getSetCookie()).toHaveLength(0);
    expect(auth.devices.list()).toHaveLength(0);
    expect(auth.devices.consumePairCode(code)).toBe(true);
  });

  test('bodies over 4 KB are refused', async () => {
    const { auth } = setup();
    const res = await auth.pair(form({ token: 'x'.repeat(5000) }), '127.0.0.1');
    expect(res.status).toBe(413);
  });
});

describe('one code, two forms', () => {
  test('a short code works once; using either form ends both', async () => {
    const { auth } = setup();
    const a = auth.devices.newPairCode();
    expect(a.short).toMatch(/^[0-9A-HJKMNP-TV-Z]{12}$/);
    expect(auth.devices.consumePairCode(a.short, { short: true })).toBe(true);
    expect(auth.devices.consumePairCode(a.short, { short: true })).toBe(false);
    expect(auth.devices.consumePairCode(a.code)).toBe(false);
    const b = auth.devices.newPairCode();
    expect(auth.devices.consumePairCode(b.code)).toBe(true);
    expect(auth.devices.consumePairCode(b.short, { short: true })).toBe(false);
    // a short code is not a long code and the other way round
    const c = auth.devices.newPairCode();
    expect(auth.devices.consumePairCode(c.short)).toBe(false);
    expect(auth.devices.consumePairCode(c.code, { short: true })).toBe(false);
  });

  test('both expire after 10 minutes; clearPairCodes ends both', () => {
    const { auth, clock } = setup();
    const a = auth.devices.newPairCode();
    expect(a.expiresAt).toBe(clock.now() + PAIR_CODE_TTL_MS);
    clock.advance(PAIR_CODE_TTL_MS + 1);
    expect(auth.devices.consumePairCode(a.short, { short: true })).toBe(false);
    expect(auth.devices.consumePairCode(a.code)).toBe(false);
    const b = auth.devices.newPairCode();
    auth.devices.clearPairCodes();
    expect(auth.devices.consumePairCode(b.short, { short: true })).toBe(false);
    expect(auth.devices.consumePairCode(b.code)).toBe(false);
  });

  test('the pair-link API returns the short code too', async () => {
    const { auth } = setup();
    const me = auth.devices.create({ name: 'me' });
    const r = new Request(`${BASE}/api/devices/pair-link`, { method: 'POST', headers: { cookie: `rlt_session=${me.secret}`, host: '127.0.0.1:4860' } });
    const url = new URL(r.url);
    const d = auth.check(r, url);
    if (d.kind !== 'allow') throw new Error('not allowed');
    const body = (await (await auth.api(r, url, d))!.json()) as { code: string; short: string; path: string };
    expect(body.short).toMatch(/^[0-9A-HJKMNP-TV-Z]{12}$/);
    expect(body.path).toBe(`/?token=${body.code}`);
    expect(auth.devices.consumePairCode(body.short, { short: true })).toBe(true);
  });
});

describe('JSON clients of POST /api/pair are unchanged', () => {
  test('token → {cookie, deviceId}; a short code works there too', async () => {
    const { auth } = setup();
    const json = (token: string) =>
      new Request(`${BASE}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, device: 'script' }) });
    const res = await auth.pair(json(auth.token), null);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { cookie: string }).cookie).toMatch(/^rlt_session=/);
    expect((await auth.pair(json('nope'), null)).status).toBe(403);
    expect((await auth.pair(json(auth.devices.newPairCode().short), null)).status).toBe(200);
  });
});
