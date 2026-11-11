// #21 / #70: the static server compresses text and skies (brotli first) and lets browsers reuse the town's assets.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { cacheControl, createStatic, pickEncoding } from '../../server/static';

describe('pickEncoding', () => {
  test('prefers brotli, falls back to gzip, honours q=0', () => {
    expect(pickEncoding('gzip, deflate, br, zstd')).toBe('br');
    expect(pickEncoding('gzip, deflate')).toBe('gzip');
    expect(pickEncoding('br;q=0, gzip;q=0.8')).toBe('gzip');
    expect(pickEncoding('gzip;q=0')).toBe(null);
    expect(pickEncoding('identity')).toBe(null);
    expect(pickEncoding(null)).toBe(null);
    expect(pickEncoding('*')).toBe('gzip');
  });
});

describe('cacheControl', () => {
  test('hashed chunks are immutable; named 3D assets and fonts are reused and revalidated in the background', () => {
    expect(cacheControl('/assets/index-DGrDEYKJ.js')).toContain('immutable');
    const glb = cacheControl('/assets/props-city/street_lamp_01_1k.glb');
    expect(glb).toContain('max-age=86400');
    expect(glb).toContain('stale-while-revalidate');
    expect(cacheControl('/fonts/inter-latin-var.woff2')).toContain('stale-while-revalidate');
    expect(cacheControl('/index.html')).toBe('no-cache');
    expect(cacheControl('/manifest.webmanifest')).toBe('no-cache');
  });
});

describe('createStatic', () => {
  let dir = '';
  let serve: ReturnType<typeof createStatic>;
  const js = `export const town = ${JSON.stringify('cast '.repeat(4000))};\n`;
  const hdr = Buffer.concat([Buffer.from('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 64 +X 64\n'), Buffer.alloc(64 * 64 * 4, 7)]);
  const get = (path: string, headers: Record<string, string> = {}, method = 'GET') =>
    serve(new Request(`http://x${path}`, { method, headers }), new URL(`http://x${path}`));

  beforeAll(() => {
    dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'cast-static-'));
    mkdirSync(join(dir, 'assets/hdri'), { recursive: true });
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>CAST</title>');
    writeFileSync(join(dir, 'assets/index-AbCdEfGh12.js'), js);
    writeFileSync(join(dir, 'assets/hdri/sky_2k.hdr'), hdr);
    serve = createStatic({ distDir: dir, version: 't', port: 0 });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test('brotli when accepted, decoded back to the original bytes', async () => {
    const res = await get('/assets/index-AbCdEfGh12.js', { 'accept-encoding': 'gzip, br' });
    expect(res.headers.get('content-encoding')).toBe('br');
    expect(res.headers.get('vary')).toBe('Accept-Encoding');
    expect(res.headers.get('cache-control')).toContain('immutable');
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.length).toBeLessThan(js.length / 4);
    expect(brotliDecompressSync(body).toString()).toBe(js);
  });

  test('gzip for older clients, identity when nothing is accepted', async () => {
    const gz = await get('/assets/index-AbCdEfGh12.js', { 'accept-encoding': 'gzip' });
    expect(gz.headers.get('content-encoding')).toBe('gzip');
    expect(gunzipSync(Buffer.from(await gz.arrayBuffer())).toString()).toBe(js);
    const plain = await get('/assets/index-AbCdEfGh12.js');
    expect(plain.headers.get('content-encoding')).toBe(null);
    expect(await plain.text()).toBe(js);
  });

  test('skies (.hdr) are compressed too', async () => {
    const res = await get('/assets/hdri/sky_2k.hdr', { 'accept-encoding': 'br' });
    expect(res.headers.get('content-encoding')).toBe('br');
    expect(res.headers.get('cache-control')).toContain('stale-while-revalidate');
    expect(brotliDecompressSync(Buffer.from(await res.arrayBuffer())).equals(hdr)).toBe(true);
  });

  test('a revisit with the ETag gets a 304; HEAD has no body', async () => {
    const first = await get('/assets/hdri/sky_2k.hdr', { 'accept-encoding': 'br' });
    const etag = first.headers.get('etag')!;
    expect(etag).toBeTruthy();
    const again = await get('/assets/hdri/sky_2k.hdr', { 'accept-encoding': 'br', 'if-none-match': etag });
    expect(again.status).toBe(304);
    const head = await get('/assets/index-AbCdEfGh12.js', { 'accept-encoding': 'br' }, 'HEAD');
    expect(head.status).toBe(200);
    expect(head.body).toBe(null);
  });
});
