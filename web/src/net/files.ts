// Files of a person's folder, for the built-in viewer: one capability key per folder (files_key), the folder's
// listing (list_files) and every file's path (find_files). The key is the auth of GET FILES_PATH/<key>/<path…>, so
// <img>, <iframe> and "Open in new tab" can load a file and its relative CSS/JS/images.
import { fileUrl, type FileEntry, type FilesKey } from '../../../shared/protocol';
import type { Store } from '../core/types';
import { apiUrl } from './base';

/** Which folder: a house's folder, or a job's own copy of it (jobId: a job with Job.worktree). */
export interface FolderRef {
  projectId: string;
  jobId?: string;
}

export interface FileList {
  dir: string;
  entries: FileEntry[];
  truncated?: boolean;
}

export interface FoundFiles {
  paths: string[];
  truncated?: boolean;
}

/** Ask for a new key this long before the old one expires (an open page keeps working on the old one). */
const RENEW_BEFORE_MS = 10 * 60_000;
/** find_files without a query is cached this long (the palette and the viewer's search ask it on every open). */
const FIND_TTL_MS = 20_000;

export const folderId = (f: FolderRef): string => (f.jobId ? `${f.projectId}:${f.jobId}` : f.projectId);
export const sameFolder = (a: FolderRef | null | undefined, b: FolderRef | null | undefined): boolean =>
  !!a && !!b && a.projectId === b.projectId && (a.jobId ?? '') === (b.jobId ?? '');

interface KeyEntry {
  key?: FilesKey;
  pending?: Promise<FilesKey>;
}

const keys = new Map<string, KeyEntry>();
const found = new Map<string, { at: number; promise: Promise<FoundFiles> }>();
const watched = new WeakSet<Store>();

function watch(store: Store) {
  if (watched.has(store)) return;
  watched.add(store);
  // A new connection (server restart, new pairing token): mint fresh keys on next use. Pages already open keep the
  // URLs they have; they work until those keys expire (or the token changed).
  store.subscribe((_s, msg) => {
    if (msg?.t === 'hello') {
      keys.clear();
      found.clear();
    }
  });
}

function fresh(k: FilesKey | undefined, now = Date.now()): k is FilesKey {
  return !!k && k.expiresAt - now > RENEW_BEFORE_MS;
}

/** The folder's key when one is known and fresh (no request). */
export function cachedKey(f: FolderRef): FilesKey | null {
  const k = keys.get(folderId(f))?.key;
  return fresh(k) ? k : null;
}

/** The folder's key: the cached one, or a new one from the server (one request at a time per folder). */
export function filesKey(store: Store, f: FolderRef): Promise<FilesKey> {
  watch(store);
  const id = folderId(f);
  const entry = keys.get(id) ?? {};
  if (fresh(entry.key)) return Promise.resolve(entry.key);
  if (entry.pending) return entry.pending;
  const pending = store
    .request<FilesKey>(f.jobId ? { t: 'files_key', reqId: '', projectId: f.projectId, jobId: f.jobId } : { t: 'files_key', reqId: '', projectId: f.projectId })
    .then((key) => {
      if (!key || typeof key.base !== 'string') throw new Error('The server sent an odd answer for the file key.');
      // The server names its own path (/api/files/<key>/); through a hub this city lives under /city/<id>/. Every file
      // URL, the viewer's "is this link in the house" check and Open in new tab all start from this base.
      const local: FilesKey = { ...key, base: apiUrl(key.base) };
      keys.set(id, { key: local });
      return local;
    })
    .catch((err: Error) => {
      if (keys.get(id)?.pending === pending) keys.delete(id);
      throw err;
    });
  keys.set(id, { key: entry.key, pending });
  return pending;
}

/** A file's URL right away when the folder's key is known, else null. */
export function cachedFileUrl(f: FolderRef, path: string): string | null {
  const k = cachedKey(f);
  return k ? fileUrl(k.base, path) : null;
}

export async function fileUrlOf(store: Store, f: FolderRef, path: string): Promise<string> {
  return fileUrl((await filesKey(store, f)).base, path);
}

export function listFiles(store: Store, f: FolderRef, dir: string): Promise<FileList> {
  return store.request<FileList>({ t: 'list_files', reqId: '', projectId: f.projectId, ...(f.jobId ? { jobId: f.jobId } : {}), dir });
}

/** Every file's path in the folder (cached a few seconds; force: ask again). */
export function findFiles(store: Store, f: FolderRef, force = false): Promise<FoundFiles> {
  watch(store);
  const id = folderId(f);
  const hit = found.get(id);
  if (hit && !force && Date.now() - hit.at < FIND_TTL_MS) return hit.promise;
  const promise = store.request<FoundFiles>({ t: 'find_files', reqId: '', projectId: f.projectId, ...(f.jobId ? { jobId: f.jobId } : {}) });
  found.set(id, { at: Date.now(), promise });
  promise.catch(() => {
    if (found.get(id)?.promise === promise) found.delete(id);
  });
  return promise;
}

/** A file was written: the next find_files of its folder asks the server again. */
export function forgetFound(f: FolderRef) {
  found.delete(folderId(f));
}
