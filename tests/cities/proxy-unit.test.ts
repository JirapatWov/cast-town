// Unit tests of the hub proxy's pure parts: path parsing, the target URL, request/response header filtering,
// Location rewriting, the sandbox CSP for city content, close codes.
import { describe, expect, test } from 'bun:test';
import {
  anonymousFailure, CITY_CONTENT_SANDBOX, cityTarget, createCityProxy, filterResponseHeaders, forwardRequestHeaders, hasSandbox, isCityContent, isKeyedFileRequest,
  offlineResponse, parseCityPath, relayCloseCode, rewriteLocation, unknownCityResponse, upstreamCloseCode,
} from '../../server/city-proxy';
import type { Cities, CityRecord } from '../../server/cities';
import { forbiddenPage } from '../../server/pages';

describe('parseCityPath', () => {
  test('splits id and rest', () => {
    expect(parseCityPath('/city/beta/api/version')).toEqual({ id: 'beta', rest: '/api/version' });
    expect(parseCityPath('/city/beta/')).toEqual({ id: 'beta', rest: '/' });
    expect(parseCityPath('/city/beta')).toEqual({ id: 'beta', rest: '' });
  });
  test('refuses what is not a city id', () => {
    expect(parseCityPath('/city/')).toBeNull();
    expect(parseCityPath('/city/Beta/')).toBeNull();
    expect(parseCityPath('/city/-x/')).toBeNull();
    expect(parseCityPath('/city/a_b/')).toBeNull();
    expect(parseCityPath('/cityx/a/')).toBeNull();
    expect(parseCityPath('/api/cities')).toBeNull();
    expect(parseCityPath(`/city/${'a'.repeat(33)}/`)).toBeNull();
  });
});

describe('cityTarget', () => {
  test('keeps path and query on the city origin, drops the hub token', () => {
    expect(cityTarget('http://10.0.0.2:4860', '/api/x', '?a=1&token=SECRET&b=2')).toBe('http://10.0.0.2:4860/api/x?a=1&b=2');
    expect(cityTarget('https://b.ts.net:8443', '/', '')).toBe('https://b.ts.net:8443/');
    expect(cityTarget('https://b.ts.net:8443', '/term', '?target=town', true)).toBe('wss://b.ts.net:8443/term?target=town');
    expect(cityTarget('http://b:1', '/ws', '?token=x', true)).toBe('ws://b:1/ws');
  });
  test('a path that looks like a host stays a path', () => {
    expect(new URL(cityTarget('http://b:1', '//evil.example/x', '')).host).toBe('b:1');
  });
});

describe('forwardRequestHeaders', () => {
  const browser = new Headers({
    cookie: 'rlt_token=HUB; rlt_session=HUBSESSION',
    authorization: 'Bearer x',
    'proxy-authorization': 'Basic y',
    'tailscale-user-login': 'owner@example.com',
    'Tailscale-User-Name': 'Owner',
    'x-forwarded-for': '1.2.3.4',
    'X-Forwarded-Host': 'hub.example',
    'x-forwarded-proto': 'https',
    forwarded: 'for=1.2.3.4',
    'x-real-ip': '1.2.3.4',
    origin: 'https://hub.example',
    referer: 'https://hub.example/city/b/',
    host: 'hub.example',
    connection: 'keep-alive',
    upgrade: 'websocket',
    'sec-websocket-key': 'abc',
    'x-cast-hops': '2',
    accept: 'text/html',
    'accept-encoding': 'gzip',
    'user-agent': 'Test',
    'content-type': 'image/png',
    'if-none-match': 'W/"x"',
  });
  test('drops credentials, identity, forwarding and hop-by-hop headers; adds the city cookie', () => {
    const out = forwardRequestHeaders(browser, 'rlt_session=CITY', 2);
    const keys = [...out.keys()];
    for (const k of keys) expect(k).not.toMatch(/^(authorization|proxy-authorization|tailscale-|x-forwarded-|forwarded|x-real-ip|origin|referer|host|connection|upgrade|sec-websocket-)/);
    expect(out.get('cookie')).toBe('rlt_session=CITY');
    expect(out.get('x-cast-hops')).toBe('3');
    expect(out.get('accept')).toBe('text/html');
    expect(out.get('accept-encoding')).toBe('gzip');
    expect(out.get('user-agent')).toBe('Test');
    expect(out.get('content-type')).toBe('image/png');
    expect(out.get('if-none-match')).toBe('W/"x"');
  });
  test('without a city cookie (keyed files) no cookie at all goes out', () => {
    expect(forwardRequestHeaders(browser, null, 0).get('cookie')).toBeNull();
  });
});

describe('rewriteLocation', () => {
  const city = 'http://10.0.0.2:4860';
  test('root-relative and same-host absolute stay under the city prefix', () => {
    expect(rewriteLocation('/', 'beta', city)).toBe('/city/beta/');
    expect(rewriteLocation('/x?y=1#z', 'beta', city)).toBe('/city/beta/x?y=1#z');
    expect(rewriteLocation('http://10.0.0.2:4860/a/b', 'beta', city)).toBe('/city/beta/a/b');
    expect(rewriteLocation('https://10.0.0.2:4860/a', 'beta', city)).toBe('/city/beta/a');
    expect(rewriteLocation('//10.0.0.2:4860/a', 'beta', city)).toBe('/city/beta/a');
  });
  test('relative and other sites are left alone', () => {
    expect(rewriteLocation('next', 'beta', city)).toBe('next');
    expect(rewriteLocation('../up', 'beta', city)).toBe('../up');
    expect(rewriteLocation('https://example.com/x', 'beta', city)).toBe('https://example.com/x');
    expect(rewriteLocation('//example.com/x', 'beta', city)).toBe('//example.com/x');
    expect(rewriteLocation('http://10.0.0.2:9999/x', 'beta', city)).toBe('http://10.0.0.2:9999/x');
  });
});

describe('filterResponseHeaders', () => {
  const ctx = (rest: string) => ({ id: 'beta', cityUrl: 'http://10.0.0.2:4860', rest });
  function upstream(extra: Record<string, string> = {}, cookies: string[] = []): Headers {
    const h = new Headers({ 'content-type': 'text/html', etag: 'W/"1"', 'content-encoding': 'gzip', ...extra });
    for (const c of cookies) h.append('set-cookie', c);
    return h;
  }
  test('every Set-Cookie is dropped (and reported), policy headers for the whole origin too', () => {
    const { headers, setCookies } = filterResponseHeaders(
      upstream({ 'strict-transport-security': 'max-age=1', 'clear-site-data': '"*"', nel: '{}', 'report-to': '{}', 'service-worker-allowed': '/', 'transfer-encoding': 'chunked', connection: 'close' }, ['rlt_session=abc; Path=/; HttpOnly', 'other=1']),
      ctx('/'),
    );
    expect(headers.get('set-cookie')).toBeNull();
    expect(setCookies).toEqual(['rlt_session=abc; Path=/; HttpOnly', 'other=1']);
    for (const k of ['strict-transport-security', 'clear-site-data', 'nel', 'report-to', 'service-worker-allowed', 'transfer-encoding', 'connection']) expect(headers.get(k)).toBeNull();
    expect(headers.get('etag')).toBe('W/"1"');
    expect(headers.get('content-encoding')).toBe('gzip');
  });
  test('Location is rewritten', () => {
    expect(filterResponseHeaders(upstream({ location: '/x' }), ctx('/')).headers.get('location')).toBe('/city/beta/x');
  });
  test('the city own CSP and frame guard are kept', () => {
    const { headers } = filterResponseHeaders(upstream({ 'content-security-policy': "frame-ancestors 'self'", 'x-frame-options': 'SAMEORIGIN' }), ctx('/'));
    expect(headers.get('content-security-policy')).toBe("frame-ancestors 'self'");
    expect(headers.get('x-frame-options')).toBe('SAMEORIGIN');
  });
  test('city content (files, uploads) always ends up sandboxed', () => {
    const none = filterResponseHeaders(upstream(), ctx('/api/files/KEY/index.html')).headers;
    expect(none.get('content-security-policy')).toBe(CITY_CONTENT_SANDBOX);
    const noSandbox = filterResponseHeaders(upstream({ 'content-security-policy': "default-src 'none'" }), ctx('/api/uploads/abc.png')).headers;
    expect(hasSandbox(noSandbox.get('content-security-policy'))).toBe(true);
    expect(noSandbox.get('content-security-policy')).toContain("default-src 'none'");
    const already = filterResponseHeaders(upstream({ 'content-security-policy': "sandbox allow-scripts; default-src 'none'" }), ctx('/api/files/K/a.html')).headers;
    expect(already.get('content-security-policy')).toBe("sandbox allow-scripts; default-src 'none'");
    // the app itself is not sandboxed
    expect(filterResponseHeaders(upstream({ 'content-type': 'text/javascript' }), ctx('/assets/index.js')).headers.get('content-security-policy')).toBeNull();
  });
  test('a city HTML page without a frame guard gets the hub’s', () => {
    const { headers } = filterResponseHeaders(upstream(), ctx('/'));
    expect(headers.get('content-security-policy')).toBe("frame-ancestors 'self'");
    expect(headers.get('x-frame-options')).toBe('SAMEORIGIN');
  });
});

describe('small rules', () => {
  test('hasSandbox reads every policy and directive', () => {
    expect(hasSandbox(null)).toBe(false);
    expect(hasSandbox("default-src 'none'")).toBe(false);
    expect(hasSandbox("default-src 'none'; sandbox")).toBe(true);
    expect(hasSandbox("frame-ancestors 'self', sandbox allow-scripts")).toBe(true);
    expect(hasSandbox("script-src 'self' sandbox.example")).toBe(false);
  });
  test('city content paths', () => {
    expect(isCityContent('/api/files/k/x')).toBe(true);
    expect(isCityContent('/api/uploads/x.png')).toBe(true);
    expect(isCityContent('/api/filesx')).toBe(false);
    expect(isCityContent('/')).toBe(false);
  });
  test('keyed file requests: GET/HEAD of a file under a key only', () => {
    expect(isKeyedFileRequest('GET', '/api/files/KEY/index.html')).toBe(true);
    expect(isKeyedFileRequest('HEAD', '/api/files/KEY/a/b.css')).toBe(true);
    expect(isKeyedFileRequest('POST', '/api/files/KEY/index.html')).toBe(false);
    expect(isKeyedFileRequest('GET', '/api/files/KEY/')).toBe(false);
    expect(isKeyedFileRequest('GET', '/api/uploads/x.png')).toBe(false);
    expect(isKeyedFileRequest('GET', '/ws')).toBe(false);
  });
  test('close codes', () => {
    expect(relayCloseCode(1000)).toBe(1000);
    expect(relayCloseCode(1013)).toBe(1013);
    expect(relayCloseCode(4001)).toBe(4001);
    expect(relayCloseCode(1006)).toBe(1014);
    expect(relayCloseCode(1005)).toBe(1014);
    expect(upstreamCloseCode(1001)).toBe(1000);
    expect(upstreamCloseCode(4002)).toBe(4002);
  });
});

describe('city pages', () => {
  const html = (accept = 'text/html') => new Request('http://hub.test/city/b/', { headers: { accept } });
  test('the offline and no-such-city pages (signed-in only) use the app’s self-hosted fonts; pages strangers see don’t', async () => {
    const offline = await offlineResponse(html(), new URL('http://hub.test/city/b/'), { id: 'b', name: 'Box', url: 'http://10.0.0.2:4860' }).text();
    for (const page of [offline, await unknownCityResponse(html()).text()]) {
      expect(page).toContain('<link rel="stylesheet" href="/fonts/fonts.css">');
      expect(page).not.toMatch(/googleapis|gstatic/);
    }
    expect(forbiddenPage('no-token', {})).not.toContain('/fonts/');
    expect(await anonymousFailure().text()).toBe('Not found\n');
  });
});

describe('service workers', () => {
  // The hub's own worker (server/pwa.ts) is the only one on its origin: a city page can't register one from /city/<id>/.
  const city = { id: 'beta', name: 'Beta', url: 'http://10.0.0.2:4860', cookie: 'rlt_session=c', addedAt: 0 } as unknown as CityRecord;
  function proxy() {
    const calls: string[] = [];
    const cities = { get: (id: string) => (id === 'beta' ? city : undefined), note() {}, adoptCookie() {} } as unknown as Cities;
    const p = createCityProxy({
      cities,
      fetch: async (input) => {
        calls.push(String(input));
        return new Response('self.x=1', { headers: { 'content-type': 'text/javascript', 'service-worker-allowed': '/' } });
      },
    });
    return { p, calls };
  }
  const get = (path: string, headers: Record<string, string> = {}) => {
    const req = new Request(`http://hub:4860${path}`, { headers });
    const url = new URL(req.url);
    return { req, url, path: parseCityPath(url.pathname)! };
  };

  test('a request with Service-Worker: script → 404, never forwarded', async () => {
    const { p, calls } = proxy();
    const r = get('/city/beta/sw.js', { 'service-worker': 'script' });
    const res = await p.http(r.req, r.url, r.path);
    expect(res.status).toBe(404);
    expect(calls).toEqual([]);
  });

  test('without it the same file is forwarded as before, and Service-Worker-Allowed is still dropped', async () => {
    const { p, calls } = proxy();
    const r = get('/city/beta/sw.js');
    const res = await p.http(r.req, r.url, r.path);
    expect(res.status).toBe(200);
    expect(calls).toEqual(['http://10.0.0.2:4860/sw.js']);
    expect(res.headers.get('service-worker-allowed')).toBeNull();
  });
});
