// Images for chat messages. The browser shrinks a picture and POSTs it (raw body) to UPLOAD_PATH; RLT keeps it once,
// content-addressed, as <dataDir>/uploads/<sha256>.<ext> and answers its ImageRef. A prompt names images by id; the
// agent system reads them back (readUpload) and hands omp base64 — transcripts only ever hold the ids, and the chat
// shows the picture from GET UPLOAD_PATH/<id>. Raster types only (never SVG): the bytes must match the type.
// Images in tool results (generate_image, a read of a picture) are kept the same way (storeImage, via normalize.ts).
//
// Any other file attached to a message: POST FILE_UPLOAD_PATH?name=<name> (raw body) streams it (any size) to
// <dataDir>/uploads/files/<sha256>/<safe name> — the data folder, never the house folder,
// so no stray files land in the user's repo. Its id "<sha256>/<name>" is all a FileRef needs (size from the file,
// type from the name). The agent system hands the model the absolute paths (attachmentNote) and the person reads them
// with its own read tool. GET FILE_UPLOAD_PATH/<sha256>/<name> always answers as a download: generic type, nosniff,
// sandboxed CSP — the bytes are whatever the user picked (an .html file must never run on CAST's origin).
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { FILE_UPLOAD_PATH, MAX_UPLOAD_BYTES, UPLOAD_PATH, type FileRef, type ImageRef } from '../shared/protocol';
import { contentDisposition, log, receiveToFile, writeFileAtomic } from './util';

/** "<sha256>.<ext>" — the only names RLT writes or serves. */
export const UPLOAD_ID = /^[0-9a-f]{64}\.(png|jpg|gif|webp)$/;

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

export function uploadsDir(dataDir: string): string {
  return join(dataDir, 'uploads');
}

/** "<sha256>/<name>": an attached file (the name as safeFileName made it). */
export const FILE_ID = /^([0-9a-f]{64})\/([^/\\]+)$/;

/** Where attached files live: <dataDir>/uploads/files/<sha256>/<name>. */
export function fileUploadsDir(dataDir: string): string {
  return join(uploadsDir(dataDir), 'files');
}

/** A kept name is at most this many UTF-8 bytes (most file systems allow 255; room for the temp suffix). */
const MAX_NAME_BYTES = 200;
/** Control characters (C0, DEL, C1) and the invisible direction marks a name could use to fake its extension. */
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const utf8Bytes = (s: string) => Buffer.byteLength(s, 'utf8');

/** Cut `s` to at most `max` UTF-8 bytes without splitting a character. */
function cutBytes(s: string, max: number): string {
  let out = '';
  for (const ch of s) {
    if (utf8Bytes(out + ch) > max) break;
    out += ch;
  }
  return out;
}

/** The name an attached file is kept under: the last path segment only ("../x" → "x", "a\b" → "b"), no control or
 *  direction characters, no leading dots or spaces (".env" → "env": never a hidden file), at most MAX_NAME_BYTES with
 *  the extension kept. "file" when nothing is left. */
export function safeFileName(raw: string): string {
  let name = (raw.split(/[/\\]/).pop() ?? '').replace(UNSAFE_CHARS, '').normalize('NFC').trim().replace(/^[.\s]+/, '');
  if (utf8Bytes(name) > MAX_NAME_BYTES) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && utf8Bytes(name.slice(dot)) <= 16 && !/\s/.test(name.slice(dot)) ? name.slice(dot) : '';
    name = cutBytes(ext ? name.slice(0, dot) : name, MAX_NAME_BYTES - utf8Bytes(ext)).trimEnd() + ext;
  }
  return name || 'file';
}

/** A display type from the name (the browser's own guess is not kept: the id alone must give the whole FileRef). */
const FILE_TYPES: Record<string, string> = {
  pdf: 'application/pdf', csv: 'text/csv', tsv: 'text/tab-separated-values', txt: 'text/plain', md: 'text/markdown', log: 'text/plain',
  json: 'application/json', xml: 'application/xml', yaml: 'application/yaml', yml: 'application/yaml', html: 'text/html', htm: 'text/html',
  zip: 'application/zip', gz: 'application/gzip', tgz: 'application/gzip', tar: 'application/x-tar', '7z': 'application/x-7z-compressed', rar: 'application/vnd.rar',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet', rtf: 'application/rtf', epub: 'application/epub+zip',
  ipynb: 'application/x-ipynb+json', sqlite: 'application/vnd.sqlite3', db: 'application/vnd.sqlite3',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', heic: 'image/heic',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
};

export function fileTypeOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return (dot > 0 && FILE_TYPES[name.slice(dot + 1).toLowerCase()]) || 'application/octet-stream';
}

/** An attached file: its ref and absolute path, or null when the id is malformed or the file is gone. */
export function readFileRef(dataDir: string, id: string): { ref: FileRef; path: string } | null {
  const m = FILE_ID.exec(id);
  if (!m || safeFileName(m[2]!) !== m[2]) return null;
  const path = join(fileUploadsDir(dataDir), m[1]!, m[2]!);
  try {
    const st = lstatSync(path);
    if (!st.isFile()) return null;
    return { ref: { id, name: m[2]!, size: st.size, mimeType: fileTypeOf(m[2]!) }, path };
  } catch {
    return null;
  }
}

/** 1.2 MB / 340 KB / 12 bytes. */
export function fmtSize(n: number): string {
  if (n < 1024) return `${n} byte${n === 1 ? '' : 's'}`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

const NOTE_OPEN = '<cast-attachments>';
const NOTE_CLOSE = '</cast-attachments>';

/** What the model gets for a message with attached files: the text as typed, then where each file is. Reading them is
 *  a read-tier tool call (no approval card in any mode); omp's read handles text, PDFs, office documents, notebooks,
 *  archives and SQLite. The chat shows only the text and the files' chips. */
export function attachmentNote(text: string, files: { ref: FileRef; path: string }[]): string {
  if (!files.length) return text;
  const lines = files.map((f) => `- ${f.path} (${f.ref.name}, ${fmtSize(f.ref.size)})`);
  const note = [
    NOTE_OPEN,
    `The user attached ${files.length === 1 ? 'this file' : `these ${files.length} files`} to the message above. ${files.length === 1 ? 'It is' : 'They are'} saved on this machine outside the project folder; read ${files.length === 1 ? 'it' : 'them'} with your tools (read handles text, PDFs, office documents, notebooks, archives and SQLite).`,
    ...lines,
    NOTE_CLOSE,
  ].join('\n');
  return text ? `${text}\n\n${note}` : note;
}

/** The text without the attachment note (a message omp echoes back that CAST can't match to what it sent). */
export function stripAttachmentNote(text: string): string {
  const at = text.lastIndexOf(NOTE_OPEN);
  if (at < 0 || !text.trimEnd().endsWith(NOTE_CLOSE)) return text;
  return text.slice(0, at).trimEnd();
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

/** Keep an attached file: the body streams into a temp file (hashed on the way), which then moves to
 *  <files>/<sha256>/<name> — or goes away when the same bytes are already kept under that name. */
async function storeFileBody(dataDir: string, req: Request, rawName: string): Promise<FileRef> {
  const root = fileUploadsDir(dataDir);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const tmp = join(root, `.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
  const { size, sha256 } = await receiveToFile(req, tmp, 0o600);
  const name = safeFileName(rawName);
  const dir = join(root, sha256);
  const file = join(dir, name);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (existsSync(file)) rmSync(tmp, { force: true });
    else renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return { id: `${sha256}/${name}`, name, size, mimeType: fileTypeOf(name) };
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });

const MAX_MB = Math.round(MAX_UPLOAD_BYTES / (1024 * 1024));

export interface Uploads {
  /** True for UPLOAD_PATH and UPLOAD_PATH/<anything> — FILE_UPLOAD_PATH included (the caller authenticates first —
   *  with the Origin check for POST). */
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

  async function postFile(req: Request, url: URL): Promise<Response> {
    const name = url.searchParams.get('name') ?? '';
    if (!name.trim()) return json({ error: 'The file has no name.' }, 400);
    try {
      return json(await storeFileBody(opts.dataDir, req, name));
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOSPC') return json({ error: 'The disk of the CAST machine is full — free some space, then attach it again.' }, 507);
      if (req.signal?.aborted) return json({ error: 'The upload was interrupted — try again.' }, 400);
      log('http', 'could not store an attached file:', err);
      return json({ error: "CAST couldn't store the file — try again." }, 500);
    }
  }

  /** Always a download, whatever the name says: an attached .html or .svg must never render on CAST's origin. */
  function getFile(req: Request, rest: string): Response {
    const slash = rest.indexOf('/');
    let id: string;
    try {
      id = slash > 0 ? `${rest.slice(0, slash)}/${decodeURIComponent(rest.slice(slash + 1))}` : '';
    } catch {
      return json({ error: 'Not found' }, 404);
    }
    const f = readFileRef(opts.dataDir, id);
    if (!f) return json({ error: 'Not found' }, 404);
    return new Response(req.method === 'HEAD' ? null : Bun.file(f.path), {
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(f.ref.size),
        'content-disposition': contentDisposition('attachment', f.ref.name),
        'x-content-type-options': 'nosniff',
        'cache-control': 'private, max-age=31536000, immutable',
        'content-security-policy': "default-src 'none'; sandbox",
      },
    });
  }

  return {
    matches: (url) => url.pathname === UPLOAD_PATH || url.pathname.startsWith(`${UPLOAD_PATH}/`),
    store: (bytes) => storeImage(opts.dataDir, bytes),
    async handle(req, url) {
      if (url.pathname === FILE_UPLOAD_PATH) {
        if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
        return postFile(req, url);
      }
      if (url.pathname.startsWith(`${FILE_UPLOAD_PATH}/`)) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return json({ error: 'Method not allowed' }, 405);
        return getFile(req, url.pathname.slice(FILE_UPLOAD_PATH.length + 1));
      }
      if (url.pathname === UPLOAD_PATH) {
        if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
        return post(req);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return json({ error: 'Method not allowed' }, 405);
      return get(req, url.pathname.slice(UPLOAD_PATH.length + 1));
    },
  };
}
