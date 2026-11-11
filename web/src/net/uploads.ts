// Chat images go over plain HTTP (POST UPLOAD_PATH, raw body), not the WebSocket: the prompt then only names them.
import { MAX_UPLOAD_BYTES, UPLOAD_PATH, type ImageRef } from '../../../shared/protocol';
import { apiUrl } from './base';

export const UPLOAD_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

/** Where the browser shows an uploaded image (same auth as the page: the cookie rides along). This city's server:
 *  under /city/<id>/ when the page was opened through a hub. */
export function uploadUrl(id: string): string {
  return apiUrl(`${UPLOAD_PATH}/${encodeURIComponent(id)}`);
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
    let why = '';
    try {
      const text = await res.text();
      try {
        why = (JSON.parse(text) as { error?: string }).error ?? '';
      } catch {
        why = text.trim().slice(0, 200);
      }
    } catch {
      /* no body */
    }
    throw new Error(why || `Upload failed (HTTP ${res.status}).`);
  }
  const ref = (await res.json()) as Partial<ImageRef>;
  if (typeof ref?.id !== 'string' || typeof ref.mimeType !== 'string') throw new Error('The server sent an odd answer to the upload.');
  return { id: ref.id, mimeType: ref.mimeType };
}
