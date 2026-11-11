// Static file serving for web/dist: SPA fallback to index.html, long cache for hashed /assets, ETags, and brotli /
// gzip for text assets and the RGBE skies (big JS bundles and HDRs travel over Tailscale, often to a phone).
// Compression runs off the event loop (zlib's thread pool) once per file version and is kept in memory, so it is
// effectively pre-compressed after the first request. Shows a placeholder until the app is built.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, constants as zlib, gzip } from 'node:zlib';
import { FRAME_GUARD_HEADERS, placeholderPage } from './pages';
import { isInside } from './util';

const brotliAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

// .hdr: Radiance RGBE is only run-length coded; brotli takes another ~40 % off a sky (5.2 → 3.3 MB).
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.txt', '.map', '.wasm', '.gltf', '.md', '.xml', '.hdr', '.webmanifest']);
const EXTRA_TYPES: Record<string, string> = {
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.hdr': 'application/octet-stream',
  '.ktx2': 'image/ktx2',
  '.wasm': 'application/wasm',
  '.mjs': 'text/javascript;charset=utf-8',
};
const HASHED = /-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/;
const COMPRESS_MAX_BYTES = 12 * 1024 * 1024;
/** Above this, brotli drops to a quality that compresses a 5 MB sky in under a second (q9 takes ~5 s). */
const BROTLI_BIG_BYTES = 2 * 1024 * 1024;

export type Encoding = 'br' | 'gzip';

/** The best encoding the client accepts (brotli first), honouring `;q=0` refusals. */
export function pickEncoding(acceptEncoding: string | null): Encoding | null {
  const ok = new Set<string>();
  for (const part of (acceptEncoding ?? '').toLowerCase().split(',')) {
    const [name, ...params] = part.trim().split(';');
    const q = params.map((p) => /^\s*q=([\d.]+)\s*$/.exec(p)?.[1]).find((v) => v !== undefined);
    if (name && (q === undefined || Number(q) > 0)) ok.add(name.trim());
  }
  if (ok.has('br')) return 'br';
  if (ok.has('gzip') || ok.has('*')) return 'gzip';
  return null;
}

/** Cache-Control for a static path. Vite's hashed chunks never change; the 3D assets and fonts keep their names
 *  across releases, so they are fresh for a day/week and then revalidated in the background (stale-while-revalidate:
 *  a returning visitor's town loads from cache at once, an ETag 304 follows). */
export function cacheControl(pathname: string): string {
  if (pathname.startsWith('/assets/')) {
    return HASHED.test(pathname) ? 'public, max-age=31536000, immutable' : 'public, max-age=86400, stale-while-revalidate=2592000';
  }
  if (pathname.startsWith('/fonts/')) return 'public, max-age=604800, stale-while-revalidate=2592000';
  return 'no-cache';
}

interface Packed {
  key: string; // etag of the source version
  data: Promise<Uint8Array<ArrayBuffer> | null>;
}

export interface StaticOptions {
  distDir: string;
  version: string;
  port: number;
  /** A compiled server: the placeholder can't tell anyone to run `bun run build` (pages.ts). */
  compiled?: boolean;
}

export function createStatic(opts: StaticOptions): (req: Request, url: URL) => Promise<Response> {
  const dist = normalize(opts.distDir);
  const packed = new Map<string, Packed>(); // `${encoding}:${file}`

  function placeholder(req: Request): Response {
    return new Response(req.method === 'HEAD' ? null : placeholderPage({ version: opts.version, port: opts.port, compiled: opts.compiled, distDir: dist }), {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...FRAME_GUARD_HEADERS },
    });
  }

  /** The file compressed with `enc`, made once per version (concurrent requests share the work). */
  function compressed(file: string, key: string, enc: Encoding, size: number): Promise<Uint8Array<ArrayBuffer> | null> {
    const id = `${enc}:${file}`;
    const hit = packed.get(id);
    if (hit && hit.key === key) return hit.data;
    const data = (async () => {
      try {
        const raw = readFileSync(file);
        const out =
          enc === 'br'
            ? await brotliAsync(raw, { params: { [zlib.BROTLI_PARAM_QUALITY]: size > BROTLI_BIG_BYTES ? 5 : 9, [zlib.BROTLI_PARAM_SIZE_HINT]: size } })
            : await gzipAsync(raw, { level: 6 });
        return new Uint8Array(out); // a copy that owns a plain ArrayBuffer (zlib may hand back a pooled slice)
      } catch {
        packed.delete(id);
        return null;
      }
    })();
    packed.set(id, { key, data });
    return data;
  }

  async function sendFile(req: Request, file: string, pathname: string): Promise<Response> {
    const st = statSync(file);
    const ext = extname(file).toLowerCase();
    const etag = `W/"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
    const bunFile = Bun.file(file);
    const headers: Record<string, string> = {
      'content-type': EXTRA_TYPES[ext] ?? (bunFile.type || 'application/octet-stream'),
      'cache-control': cacheControl(pathname),
      etag,
      'x-content-type-options': 'nosniff',
      ...(ext === '.html' ? FRAME_GUARD_HEADERS : {}), // only CAST may frame CAST (pages.ts)
    };
    if (req.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });

    if (COMPRESSIBLE.has(ext) && st.size > 1024 && st.size <= COMPRESS_MAX_BYTES) {
      headers['vary'] = 'Accept-Encoding';
      const enc = pickEncoding(req.headers.get('accept-encoding'));
      const body = enc ? await compressed(file, etag, enc, st.size) : null;
      if (enc && body) {
        headers['content-encoding'] = enc;
        return new Response(req.method === 'HEAD' ? null : body, { headers });
      }
    }
    return new Response(req.method === 'HEAD' ? null : bunFile, { headers });
  }

  function resolveInDist(pathname: string): string | null {
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return null;
    }
    if (decoded.includes('\0')) return null;
    const full = normalize(join(dist, decoded));
    return isInside(dist, full) ? full : null;
  }

  return async function serveStatic(req: Request, url: URL): Promise<Response> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return new Response('Method not allowed\n', { status: 405, headers: { allow: 'GET, HEAD' } });
    }
    const index = join(dist, 'index.html');
    const target = resolveInDist(url.pathname);
    if (!target) return new Response('Bad request\n', { status: 400 });

    let file = target;
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (existsSync(file) && statSync(file).isFile()) return sendFile(req, file, url.pathname);

    // SPA fallback: extension-less routes get the app shell; missing files with an extension are real 404s.
    const isRoute = !extname(url.pathname) && !url.pathname.startsWith('/assets/');
    if (isRoute) return existsSync(index) ? sendFile(req, index, '/index.html') : placeholder(req);
    return new Response('Not found\n', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  };
}
