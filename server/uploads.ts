// Images for chat messages. The browser shrinks a picture and POSTs it (raw body) to UPLOAD_PATH; RLT keeps it once,
// content-addressed, as <dataDir>/uploads/<sha256>.<ext> and answers its ImageRef. A prompt names images by id; the
// agent system reads them back (readUpload) and hands omp base64 — transcripts only ever hold the ids, and the chat
// shows the picture from GET UPLOAD_PATH/<id>. Raster types only (never SVG): the bytes must match the type.
// Images in tool results (generate_image, a read of a picture) are kept the same way (storeImage, via normalize.ts).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_UPLOAD_BYTES, UPLOAD_PATH, type ImageRef } from '../shared/protocol';
import { log, writeFileAtomic } from './util';

/** "<sha256>.<ext>" — the only names RLT writes or serves. */
export const UPLOAD_ID = /^[0-9a-f]{64}\.(png|jpg|gif|webp)$/;

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

export function uploadsDir(dataDir: string): string {
  return join(dataDir, 'uploads');
}

const startsWith = (b: Uint8Array, sig: number[], at = 0) => b.length >= at + sig.length && sig.every((x, i) => b[at + i] === x);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** The image type the bytes really are (magic numbers), or null. */
export function sniffImage(b: Uint8Array): string | null {
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(b, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(b, ascii('GIF87a')) || startsWith(b, ascii('GIF89a'))) return 'image/gif';
  if (startsWith(b, ascii('RIFF')) && startsWith(b, ascii('WEBP'), 8)) return 'image/webp';
  return null;
}

/** An uploaded image for omp (base64), or null when the id is malformed or the file is gone. */
export function readUpload(dataDir: string, id: string): { ref: ImageRef; data: string } | null {
  const m = UPLOAD_ID.exec(id);
  if (!m) return null;
  try {
    const data = readFileSync(join(uploadsDir(dataDir), id)).toString('base64');
    return { ref: { id, mimeType: MIME[m[1]!]! }, data };
  } catch {
    return null;
  }
}

/** Keep image bytes as an upload (content-addressed: the same bytes are written once) and return its ref; null when
 *  they aren't really PNG, JPEG, GIF or WebP. Used for chat images and for images in tool results (normalize.ts).
 *  Throws when the file can't be written. */
export function storeImage(dataDir: string, bytes: Uint8Array): ImageRef | null {
  const mimeType = sniffImage(bytes);
  if (!mimeType) return null;
  const id = `${createHash('sha256').update(bytes).digest('hex')}.${EXT[mimeType]}`;
  const file = join(uploadsDir(dataDir), id);
  if (!existsSync(file)) writeFileAtomic(file, bytes, 0o600);
  return { id, mimeType };
}

class TooLarge extends Error {}

/** The request body, at most `max` bytes (stops reading as soon as it is over — Content-Length can be absent). */
async function readCapped(req: Request, max: number): Promise<Uint8Array> {
  const declared = Number(req.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > max) throw new TooLarge();
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      void reader.cancel().catch(() => {});
      throw new TooLarge();
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });

const MAX_MB = Math.round(MAX_UPLOAD_BYTES / (1024 * 1024));

export interface Uploads {
  /** True for UPLOAD_PATH and UPLOAD_PATH/<anything> (the caller authenticates first — with the Origin check for POST). */
  matches(url: URL): boolean;
  handle(req: Request, url: URL): Promise<Response>;
  /** storeImage into this server's uploads (tool-result images); null when the bytes aren't a raster image. Throws. */
  store(bytes: Uint8Array): ImageRef | null;
}

export function createUploads(opts: { dataDir: string }): Uploads {
  const dir = uploadsDir(opts.dataDir);

  async function post(req: Request): Promise<Response> {
    const declared = (req.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    const ext = EXT[declared];
    if (!ext) return json({ error: 'Only PNG, JPEG, GIF and WebP images can be attached.' }, 415);
    let body: Uint8Array;
    try {
      body = await readCapped(req, MAX_UPLOAD_BYTES);
    } catch (err) {
      if (err instanceof TooLarge) return json({ error: `That image is too large (max ${MAX_MB} MB).` }, 413);
      return json({ error: 'The upload was interrupted — try again.' }, 400);
    }
    if (!body.byteLength) return json({ error: 'The image is empty.' }, 400);
    const real = sniffImage(body);
    if (!real) return json({ error: "That file isn't a PNG, JPEG, GIF or WebP image." }, 415);
    if (real !== declared) return json({ error: `That file is really ${real.slice(6).toUpperCase()}, not ${declared.slice(6).toUpperCase()}.` }, 415);
    let ref: ImageRef | null;
    try {
      ref = storeImage(opts.dataDir, body); // same bytes, same name: written once
    } catch (err) {
      log('http', `could not store upload ${ext}:`, err);
      return json({ error: "CAST couldn't store the image." }, 500);
    }
    return ref ? json(ref) : json({ error: "That file isn't a PNG, JPEG, GIF or WebP image." }, 415);
  }

  function get(req: Request, id: string): Response {
    const m = UPLOAD_ID.exec(id);
    if (!m) return json({ error: 'Not found' }, 404);
    let data: Buffer;
    try {
      data = readFileSync(join(dir, id));
    } catch {
      return json({ error: 'Not found' }, 404);
    }
    return new Response(req.method === 'HEAD' ? null : new Uint8Array(data), {
      headers: {
        'content-type': MIME[m[1]!]!,
        'content-length': String(data.byteLength),
        'x-content-type-options': 'nosniff',
        'cache-control': 'private, max-age=31536000, immutable',
        'content-security-policy': "default-src 'none'",
      },
    });
  }

  return {
    matches: (url) => url.pathname === UPLOAD_PATH || url.pathname.startsWith(`${UPLOAD_PATH}/`),
    store: (bytes) => storeImage(opts.dataDir, bytes),
    async handle(req, url) {
      if (url.pathname === UPLOAD_PATH) {
        if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
        return post(req);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return json({ error: 'Method not allowed' }, 405);
      return get(req, url.pathname.slice(UPLOAD_PATH.length + 1));
    },
  };
}
