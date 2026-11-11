// The viewer's file route (server/files.ts) answers before sign-in — the key in the path is the auth — so it must
// never serve anything outside the house folder, never a secret-looking or hidden file, always sandboxed, and a key
// must stop working the moment the pairing token changes (Settings → New pairing token / sign everyone out).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileViewer, type FileViewer } from '../../server/files';

const root = mkdtempSync(join(tmpdir(), 'cast-sec-files-'));
const house = join(root, 'house');
const dataDir = join(root, 'data');
const outside = join(root, 'outside');
let token = 'first-pairing-token-0123456789';
let viewer: FileViewer;

beforeAll(() => {
  for (const d of [house, dataDir, outside, join(house, 'src'), join(house, '.git'), join(house, 'site')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(house, 'README.md'), '# hello\n');
  writeFileSync(join(house, 'src', 'app.ts'), 'export const a = 1;\n');
  writeFileSync(join(house, 'site', 'index.html'), '<!doctype html><title>x</title><script>document.title = 1</script>');
  writeFileSync(join(house, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  writeFileSync(join(house, '.env'), 'SECRET=1\n');
  writeFileSync(join(house, '.git', 'config'), '[core]\n');
  writeFileSync(join(house, 'token'), 'a-token-file\n');
  writeFileSync(join(house, 'server.pem'), 'key\n');
  writeFileSync(join(outside, 'secret.txt'), 'outside the house\n');
  writeFileSync(join(dataDir, 'token'), 'data token\n');
  writeFileSync(join(dataDir, 'city.json'), '{}');
  symlinkSync(join(outside, 'secret.txt'), join(house, 'link-out.txt'));
  symlinkSync(outside, join(house, 'dir-out'));
  symlinkSync(join(house, '.git', 'config'), join(house, 'git-config.txt'));
  viewer = createFileViewer({
    dataDir,
    city: { project: (id: string) => (id === 'p1' ? { path: house } : undefined) } as never,
    jobs: { get: () => undefined } as never,
    token: () => token,
    ompAgentDir: join(root, 'agent'),
  });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

const BASE = 'http://127.0.0.1:1';
/** GET a raw path (the URL parser folds dot segments exactly as Bun does for a real request). */
const get = (path: string, init: RequestInit = {}) => viewer.handle(new Request(BASE + path, init), new URL(BASE + path));

describe('keys', () => {
  test('a key opens its house; a forged or tampered key looks like nothing', async () => {
    const { base } = viewer.mintKey('p1');
    expect((await get(`${base}README.md`)).status).toBe(200);
    const [body, sig] = base.split('/')[3]!.split('.');
    expect((await get(`/api/files/${body}.${'A'.repeat(sig!.length)}/README.md`)).status).toBe(404);
    const forged = Buffer.from(JSON.stringify(['p1', 'h', Math.floor(Date.now() / 1000) + 3600])).toString('base64url');
    expect((await get(`/api/files/${forged}.${sig}/README.md`)).status).toBe(404);
  });

  test('a new pairing token ends every key at once (no restart needed)', async () => {
    const { base } = viewer.mintKey('p1');
    expect((await get(`${base}README.md`)).status).toBe(200);
    token = 'second-pairing-token-abcdefghij';
    expect((await get(`${base}README.md`)).status).toBe(404);
    const fresh = viewer.mintKey('p1').base;
    expect((await get(`${fresh}README.md`)).status).toBe(200);
  });
});

describe('the route never leaves the house', () => {
  const tricks = [
    '..%2f..%2foutside%2fsecret.txt',
    '%2e%2e/%2e%2e/outside/secret.txt',
    'src/..%5c..%5coutside%5csecret.txt',
    '%2Foutside%2Fsecret.txt',
    '..\\..\\outside\\secret.txt',
    'src%00.md',
    'link-out.txt',
    'dir-out/secret.txt',
    'git-config.txt',
    '.env',
    '.git/config',
    '%2egit/config',
    'token',
    'server.pem',
    'C:%5cWindows%5cwin.ini',
  ];
  for (const t of tricks) {
    test(`${t} is refused`, async () => {
      const { base } = viewer.mintKey('p1');
      const res = await get(base + t);
      expect(res.status).not.toBe(200);
      const text = await res.text();
      expect(text).not.toContain('outside the house');
      expect(text).not.toContain('SECRET=1');
      expect(text).not.toContain('[core]');
      expect(text).not.toContain('a-token-file');
    });
  }
});

describe('what is served is sandboxed', () => {
  test('an HTML page runs only in an opaque origin, behind the shim', async () => {
    const { base } = viewer.mintKey('p1');
    const res = await get(`${base}site/`);
    expect(res.status).toBe(200);
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toMatch(/^sandbox /);
    expect(csp).not.toContain('allow-same-origin');
    expect(csp).not.toContain('allow-top-navigation');
    expect(csp).not.toMatch(/allow-popups(?!-)/);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await res.text()).indexOf('CAST viewer')).toBeLessThan(200); // the shim comes first, right after the doctype
  });

  test('SVG never runs scripts; text stays text; errors are sandboxed too', async () => {
    const { base } = viewer.mintKey('p1');
    const svg = await get(`${base}logo.svg`);
    expect(svg.headers.get('content-security-policy')).toMatch(/^sandbox;.*script-src 'none'/);
    const md = await get(`${base}README.md`);
    expect(md.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    const missing = await get(`${base}nope.html`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get('content-security-policy')).toMatch(/^sandbox/);
  });

  test('only GET, HEAD and the CORS preflight', async () => {
    const { base } = viewer.mintKey('p1');
    expect((await get(`${base}README.md`, { method: 'POST', body: 'x' })).status).toBe(405);
    expect((await get(`${base}README.md`, { method: 'DELETE' })).status).toBe(405);
  });
});
