// The service worker's rules (web/sw/policy.ts, pure): what it touches at all, what it caches, the offline page, and
// how a push message becomes a notification. Everything not listed goes to the network untouched.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { splashBackgrounds, splashLamp } from '../../tools/splash/launch-images';
import { ASSET_CACHE, MAX_ASSETS, OFFLINE_LAMP, OFFLINE_THEMES, offlineHtml, payloadToNotification, route, swapsForOffline } from '../../web/sw/policy';

const O = 'https://box.tail.ts.net:8443';
const get = (path: string, mode = 'cors', method = 'GET') => route({ method, url: path.startsWith('http') ? path : `${O}${path}`, mode }, O);

describe('route()', () => {
  test('passes everything that is not an app page or a hashed chunk', () => {
    expect(get('/api/session', 'cors', 'POST')).toBe('pass');
    expect(get('/', 'navigate', 'POST')).toBe('pass');
    for (const p of [
      'https://cdn.example/x.js',
      '/api/session', '/api/pair', '/api/uploads/x', '/api/files/k/a', '/api/push/presence', '/api/status',
      '/ws', '/term',
      '/?token=abc',
      '/city/abc/assets/index-AbCdEf12.js',
      '/city/abc/api/session',
      '/assets/hdri/sky-overcast_1k.hdr',
      '/assets/models/house-AbCdEf12.glb',
      '/fonts/inter-latin-var.woff2',
      '/sw.js', '/manifest.webmanifest', '/icon-192.png',
      '/assets/x-12345678.js?v=1',
      '/assets/index.html',
    ]) expect(`${p} ${get(p)}`).toBe(`${p} pass`);
  });

  test('page loads: the town, a house, a city', () => {
    expect(get('/', 'navigate')).toBe('navigate');
    expect(get('/#/house/x', 'navigate')).toBe('navigate');
    expect(get('/?settings=pair', 'navigate')).toBe('navigate');
    expect(get('/city/abc/', 'navigate')).toBe('navigate-city');
    expect(get('/city/abc/#/house/y', 'navigate')).toBe('navigate-city');
    // pairing links, the API, files and plain files opened in a tab go straight to the network
    for (const p of ['/?token=abc', '/city/abc/?token=abc', '/api/files/k/readme.md', '/ws', '/favicon.svg', '/assets/hdri/sky.hdr']) expect(`${p} ${get(p, 'navigate')}`).toBe(`${p} pass`);
  });

  test('hashed flat chunks only', () => {
    for (const p of ['/assets/index-1jPUNxN8.js', '/assets/rolldown-runtime-WkwZ5CU-.js', '/assets/index-DEEFYe_B.css', '/assets/xterm-Bq_9-a0Z.js']) expect(`${p} ${get(p)}`).toBe(`${p} asset`);
    for (const p of ['/assets/index.js', '/assets/a/b-12345678.js', '/assets/x-1234567.js', '/assets/x-12345678.png']) expect(`${p} ${get(p)}`).toBe(`${p} pass`);
    expect(ASSET_CACHE).toBe('cast-assets-v1');
    expect(MAX_ASSETS).toBe(80);
  });
});

describe('the offline page', () => {
  test('self-contained: no other host, only probes /api/health, a Try again link', () => {
    const html = offlineHtml();
    expect((html.match(/https?:\/\/[^\s"'<)]+/g) ?? []).filter((u) => !u.startsWith('http://www.w3.org/'))).toEqual([]);
    expect(html).toContain("CAST can’t be reached");
    expect(html).toContain('/api/health');
    expect([...html.matchAll(/fetch\(['"]([^'"]+)/g)].map((m) => m[1])).toEqual(['/api/health']);
    expect(html).toContain('Try again');
    expect(html).toContain('env(safe-area-inset-top)');
    expect(html).toContain('<a class="btn" href="">Try again</a>'); // a reload of the address it stands in for
    expect(html).toContain("addEventListener('online', probe)");
    expect(html).toContain('setInterval(probe, 3000)');
  });

  test('looks like the start of the splash: its background per theme, the mark alone on the centre at 96 px, lamp dim', () => {
    const html = offlineHtml();
    const index = readFileSync(join(import.meta.dir, '../../web/index.html'), 'utf8');
    expect({ dark: OFFLINE_THEMES.dark.bg, light: OFFLINE_THEMES.light.bg }).toEqual(splashBackgrounds(index));
    // the theme as the app chose it (Settings → Theme), else the device's — index.html's pre-paint rule
    expect(html).toContain("localStorage.getItem('rlt.theme')");
    expect(html).toContain("matchMedia('(prefers-color-scheme: light)')");
    expect(html).toContain(":root[data-theme='light']");
    expect(html).toMatch(/@media \(prefers-color-scheme: light\) \{ :root:not\(\[data-theme='dark'\]\)/);
    expect(html).toContain('.mark { grid-row: 2; display: block; width: 96px; height: 96px; }');
    expect(html).toContain('grid-template-rows: minmax(0, 1fr) auto minmax(min-content, 1fr)');
    expect(html).toContain('.mark circle { fill: var(--lamp); opacity: 0.32; }');
    expect(splashLamp(index)).toBe(OFFLINE_LAMP); // the splash's first frame and the iOS launch images
    expect(html).toContain('@media (prefers-reduced-motion: no-preference)');
    expect(html.match(/<svg /g)?.length).toBe(1);
  });

  test('in the installed app it is night on the window’s first page, as the splash starts there; in a tab the theme as before', () => {
    const script = /<script>\s*\(function \(\) \{([\s\S]*?)\}\)\(\);\s*<\/script>/.exec(offlineHtml())![1];
    const run = (o: { stored?: string; osLight?: boolean; standalone?: boolean; iosStandalone?: boolean; day?: boolean }) => {
      const attrs: Record<string, string> = {};
      const meta = { content: '', setAttribute: (_: string, v: string) => (meta.content = v) };
      const doc = { documentElement: { setAttribute: (k: string, v: string) => (attrs[k] = v) }, querySelector: () => meta };
      const win = {
        matchMedia: (q: string) => ({ matches: q.includes('standalone') ? !!o.standalone : q.includes('light') ? !!o.osLight : false }),
      };
      const storage = { getItem: () => o.stored ?? null };
      const session = { getItem: (k: string) => (k === 'rlt.launch' && o.day ? 'day' : null) };
      new Function('window', 'matchMedia', 'document', 'localStorage', 'sessionStorage', 'navigator', script)(
        win, win.matchMedia, doc, storage, session, { standalone: o.iosStandalone === true },
      );
      return [attrs['data-theme'], meta.content];
    };
    expect(run({ stored: 'light' })).toEqual(['light', OFFLINE_THEMES.light.bg]);
    expect(run({ osLight: true })).toEqual(['light', OFFLINE_THEMES.light.bg]);
    expect(run({})).toEqual(['dark', OFFLINE_THEMES.dark.bg]);
    expect(run({ stored: 'light', standalone: true })).toEqual(['dark', OFFLINE_THEMES.dark.bg]);
    expect(run({ osLight: true, iosStandalone: true })).toEqual(['dark', OFFLINE_THEMES.dark.bg]);
    // a later page of the window (its night is over: a reload while offline, the app's Reload): the theme, like the splash
    expect(run({ stored: 'light', standalone: true, day: true })).toEqual(['light', OFFLINE_THEMES.light.bg]);
    expect(run({ osLight: true, iosStandalone: true, day: true })).toEqual(['light', OFFLINE_THEMES.light.bg]);
    expect(run({ standalone: true, day: true })).toEqual(['dark', OFFLINE_THEMES.dark.bg]);
  });

  test('replaces only a dead network or tailscale serve’s own bad gateway', () => {
    expect(swapsForOffline(502, false)).toBe(true);
    expect(swapsForOffline(504, false)).toBe(true);
    expect(swapsForOffline(502, true)).toBe(false); // CAST's own answer (a city offline page) passes through
    for (const s of [200, 302, 303, 403, 404, 500, 503]) expect(swapsForOffline(s, false)).toBe(false);
  });
});

describe('payloadToNotification()', () => {
  const declarative = {
    web_push: 8030,
    mutable: true,
    notification: { title: 'Assistant needs your OK', body: 'todo-api · tap to answer', navigate: `${O}/#/house/todo`, tag: 'ap1', app_badge: '2', data: { v: 1, kind: 'waiting', next: '/#/house/todo', badge: 2 } },
  };
  test('declarative and plain JSON give the same notification', () => {
    const a = payloadToNotification(declarative, O, 1);
    const b = payloadToNotification({ notification: declarative.notification }, O, 1);
    expect(a).toEqual(b);
    expect(a.title).toBe('Assistant needs your OK');
    expect(a.options).toMatchObject({ body: 'todo-api · tap to answer', tag: 'ap1', renotify: true, icon: '/icon-192.png', data: { next: '/#/house/todo', kind: 'waiting', badge: 2 } });
  });

  test('garbage still gives a notification (Safari ends subscriptions that show none)', () => {
    for (const junk of [null, 'x', 42, {}, { notification: 'x' }, { notification: { title: 7 } }]) {
      const n = payloadToNotification(junk, O);
      expect(n.title).toBe('CAST needs you');
      expect(n.options.data.next).toBe('/');
    }
  });

  test('a next outside this origin is refused', () => {
    for (const next of ['https://evil.example/x', '//evil.example/x', 'javascript:alert(1)', '\\\\evil']) {
      expect(payloadToNotification({ notification: { title: 't', data: { next } } }, O).options.data.next).toBe('/');
    }
    expect(payloadToNotification({ notification: { title: 't', data: { next: `${O}/?panel=inbox` } } }, O).options.data.next).toBe('/?panel=inbox');
    // the badge falls back to app_badge
    expect(payloadToNotification({ notification: { title: 't', app_badge: '3' } }, O).options.data.badge).toBe(3);
  });
});
