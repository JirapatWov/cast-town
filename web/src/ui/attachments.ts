// Chat images on this side: shrink before upload (≤ 2000 px on the long side) and show one full size.
import type { ImageRef } from '../../../shared/protocol';
import { UPLOAD_TYPES } from '../net/uploads';
import { openUpload } from './file-viewer';
import type { Shell } from './shell';

const MAX_SIDE = 2000;
/** A PNG this small stays PNG (screenshots of text stay crisp); bigger opaque ones become JPEG. */
const SMALL_BYTES = 1_000_000;
const JPEG_QUALITY = 0.9;

export function isImageFile(f: { type: string }): boolean {
  return (UPLOAD_TYPES as readonly string[]).includes(f.type);
}

function hasAlpha(ctx: CanvasRenderingContext2D, w: number, hgt: number): boolean {
  const data = ctx.getImageData(0, 0, w, hgt).data;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 255) return true;
  return false;
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not shrink that image.'))), type, quality));
}

/** What gets uploaded: GIFs as they are (they may move); others at most MAX_SIDE px on the long side, PNG when they
 *  have transparency or are small, else JPEG 0.9. The original when shrinking wouldn't help. */
export async function shrinkImage(file: Blob): Promise<{ blob: Blob; mimeType: string }> {
  const type = file.type;
  if (type === 'image/gif') return { blob: file, mimeType: type };
  if (!isImageFile(file)) throw new Error('Only PNG, JPEG, GIF and WebP images can be sent.');
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    throw new Error('That file isn’t an image the browser can read.');
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  if (scale === 1 && (type === 'image/jpeg' || file.size <= SMALL_BYTES)) {
    bmp.close();
    return { blob: file, mimeType: type };
  }
  const w = Math.max(1, Math.round(bmp.width * scale));
  const hgt = Math.max(1, Math.round(bmp.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = hgt;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    bmp.close();
    return { blob: file, mimeType: type };
  }
  ctx.drawImage(bmp, 0, 0, w, hgt);
  bmp.close();
  const png = (type !== 'image/jpeg' && hasAlpha(ctx, w, hgt)) || (type === 'image/png' && file.size <= SMALL_BYTES);
  const blob = await toBlob(canvas, png ? 'image/png' : 'image/jpeg', png ? undefined : JPEG_QUALITY);
  if (scale === 1 && blob.size >= file.size) return { blob: file, mimeType: type };
  return { blob, mimeType: png ? 'image/png' : 'image/jpeg' };
}

/** One image full size (a chat bubble's thumbnail was clicked): in the built-in viewer. */
export function openImage(shell: Shell, ref: ImageRef, label = 'Image'): void {
  openUpload(shell, ref, label);
}
