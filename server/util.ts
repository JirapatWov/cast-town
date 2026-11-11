// Small shared helpers for the server core.
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, sep } from 'node:path';

/** An error whose message is safe and friendly enough to show in the UI (ack.error / toast). */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserError';
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Write a file atomically: write a sibling temp file, then rename over the target. Private (0600) unless told
 *  otherwise: everything CAST writes this way lives in its data folder (chats, jobs, the town), which is the owner's. */
export function writeFileAtomic(path: string, data: string | Uint8Array, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now().toString(36)}`;
  writeFileSync(tmp, data, { mode });
  renameSync(tmp, path);
}

/** A request body as text, at most `max` bytes: null when it is larger. Stops reading as soon as it is over, so a
 *  body without Content-Length (chunked) can't make the server hold more than `max` bytes of it. */
export async function readTextCapped(req: Request, max: number): Promise<string | null> {
  const declared = Number(req.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > max) return null;
  if (!req.body) return '';
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      void reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  return Buffer.concat(parts).toString('utf8');
}

/** True when `child` is `parent` itself or lies inside it (both must be absolute and normalized). */
export function isInside(parent: string, child: string): boolean {
  if (child === parent) return true;
  const base = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(base);
}

/** ASCII slug for folder names and project ids. Returns '' when nothing usable is left (e.g. Thai-only names). */
export function slugify(s: string, max = 48): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
}

/** Returns `base`, or `base-2`, `base-3`, … — the first candidate for which `taken` is false. */
export function uniqueName(base: string, taken: (candidate: string) => boolean): string {
  if (!taken(base)) return base;
  for (let n = 2; ; n++) {
    const c = `${base}-${n}`;
    if (!taken(c)) return c;
  }
}

/** A base no real request has: a `next` path must resolve against it without leaving it. */
export const PROBE_ORIGIN = 'http://cast.invalid';
const NEXT_MAX = 2048;

/** The same-origin path a login link lands on: '/' when none is given, null when `raw` is not a plain path of this
 *  server (an absolute URL, `//host`, a backslash, control characters or spaces, too long). Any `token` in it is
 *  dropped (the link sets its own). */
export function safeNext(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return '/';
  if (typeof raw !== 'string' || raw.length > NEXT_MAX) return null;
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return null;
  if (/[\u0000- \u007f]/.test(raw)) return null;
  let u: URL;
  try {
    u = new URL(raw, PROBE_ORIGIN);
  } catch {
    return null;
  }
  // (`/..//host` normalizes to `//host`, which a browser would read as another server)
  if (u.origin !== PROBE_ORIGIN || u.pathname.startsWith('//')) return null;
  u.searchParams.delete('token');
  return `${u.pathname}${u.search}${u.hash}`;
}

export function log(scope: string, ...args: unknown[]): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${scope.padEnd(6)}`, ...args);
}
