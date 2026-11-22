// Chat images and attached files go over plain HTTP (POST UPLOAD_PATH / FILE_UPLOAD_PATH, raw body), not the
// WebSocket: the prompt then only names them. Files (up to 50 MB) go through XMLHttpRequest, the one browser API that
// reports upload progress; the cookie and the page's Origin ride along like with fetch.
import { FILE_UPLOAD_PATH, fileUploadPath, MAX_FILE_UPLOAD_BYTES, MAX_UPLOAD_BYTES, UPLOAD_PATH, type FileRef, type ImageRef } from '../../../shared/protocol';
import { apiUrl } from './base';

export const UPLOAD_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

/** Where the browser shows an uploaded image (same auth as the page: the cookie rides along). This city's server:
 *  under /city/<id>/ when the page was opened through a hub. */
export function uploadUrl(id: string): string {
  return apiUrl(`${UPLOAD_PATH}/${encodeURIComponent(id)}`);
}

/** Where an attached file downloads from (always as a download, with its own name). */
export function fileUploadUrl(id: string): string {
  return apiUrl(fileUploadPath(id));
}

/** A string field of a JSON answer, if the text is JSON with one. */
function jsonField(text: string, key: string): string | undefined {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!v || typeof v !== 'object' || !(key in v)) return undefined;
  const field: unknown = (v as Record<string, unknown>)[key];
  return typeof field === 'string' ? field : undefined;
}

/** The server's sentence from an error answer, else a fallback with the status. */
function errorOf(status: number, text: string): string {
  const why = jsonField(text, 'error');
  if (why) return why;
  if (text.trim() && !text.trimStart().startsWith('<') && !text.trimStart().startsWith('{')) return text.trim().slice(0, 200);
  return status === 413 ? 'That file is too large.' : `Upload failed (HTTP ${status}).`;
}

/** An upload the server refused: its status and, for a name that is taken (409), what is in the way. */
export class UploadError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

/** POST a body with upload progress (0–1). Resolves with the parsed JSON answer; rejects with UploadError (the server's
 *  sentence), or an AbortError when `signal` aborts. */
export function postWithProgress<T>(url: string, body: Blob, contentType: string, onProgress?: (fraction: number) => void, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Upload cancelled', 'AbortError'));
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const settle = (fn: () => void) => {
      signal?.removeEventListener('abort', abort);
      fn();
    };
    xhr.open('POST', url);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Content-Type', contentType || 'application/octet-stream');
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable && ev.total > 0) onProgress?.(ev.loaded / ev.total);
    };
    xhr.onload = () =>
      settle(() => {
        if (xhr.status < 200 || xhr.status >= 300) {
          return reject(new UploadError(errorOf(xhr.status, xhr.responseText), xhr.status, jsonField(xhr.responseText, 'code')));
        }
        try {
          resolve(JSON.parse(xhr.responseText) as T);
        } catch {
          reject(new UploadError('The server sent an odd answer to the upload.', xhr.status));
        }
      });
    xhr.onerror = () => settle(() => reject(new UploadError('Could not reach the CAST server to upload the file.', 0)));
    xhr.onabort = () => settle(() => reject(new DOMException('Upload cancelled', 'AbortError')));
    signal?.addEventListener('abort', abort, { once: true });
    xhr.send(body);
  });
}

/** Upload one image; resolves with its ref, rejects with a sentence for the user. */
export async function uploadImage(blob: Blob, mimeType: string, signal?: AbortSignal): Promise<ImageRef> {
  if (!(UPLOAD_TYPES as readonly string[]).includes(mimeType)) throw new Error('Only PNG, JPEG, GIF and WebP images can be sent.');
  if (blob.size > MAX_UPLOAD_BYTES) throw new Error(`That image is too big (${Math.round(blob.size / 1048576)} MB; at most ${MAX_UPLOAD_BYTES / 1048576} MB).`);
  let res: Response;
  try {
    res = await fetch(apiUrl(UPLOAD_PATH), { method: 'POST', body: blob, headers: { 'Content-Type': mimeType }, credentials: 'same-origin', signal });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new Error('Could not reach the CAST server to upload the image.');
  }
  if (!res.ok) {
    let text = '';
    try {
      text = await res.text();
    } catch {
      /* no body */
    }
    throw new Error(errorOf(res.status, text));
  }
  const ref = (await res.json()) as Partial<ImageRef>;
  if (typeof ref?.id !== 'string' || typeof ref.mimeType !== 'string') throw new Error('The server sent an odd answer to the upload.');
  return { id: ref.id, mimeType: ref.mimeType };
}

/** Attach one file to a chat message: resolves with its ref, rejects with a sentence for the user. */
export async function uploadFile(file: File, onProgress?: (fraction: number) => void, signal?: AbortSignal): Promise<FileRef> {
  if (file.size > MAX_FILE_UPLOAD_BYTES) throw new Error(`“${file.name}” is too big (${Math.round(file.size / 1048576)} MB; at most ${MAX_FILE_UPLOAD_BYTES / 1048576} MB).`);
  const ref = await postWithProgress<Partial<FileRef>>(apiUrl(`${FILE_UPLOAD_PATH}?name=${encodeURIComponent(file.name || 'file')}`), file, 'application/octet-stream', onProgress, signal);
  if (typeof ref?.id !== 'string' || typeof ref.name !== 'string' || typeof ref.size !== 'number') throw new Error('The server sent an odd answer to the upload.');
  return { id: ref.id, name: ref.name, size: ref.size, mimeType: typeof ref.mimeType === 'string' ? ref.mimeType : 'application/octet-stream' };
}
