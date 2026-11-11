// Minimal TGA reader (types 2/3 uncompressed, 10/11 RLE; 8/24/32 bpp) → { width, height, channels, data }
// with rows top-down and channels in RGB(A) order, ready for sharp({ raw }).
import fs from 'node:fs';

export function readTga(file) {
  const b = fs.readFileSync(file);
  const idLen = b[0], cmapType = b[1], type = b[2];
  if (cmapType !== 0) throw new Error(`${file}: colour-mapped TGA not supported`);
  const width = b.readUInt16LE(12), height = b.readUInt16LE(14), bpp = b[16], desc = b[17];
  const bytes = bpp / 8;
  if (![1, 3, 4].includes(bytes)) throw new Error(`${file}: ${bpp} bpp not supported`);
  const rle = type === 10 || type === 11;
  if (![2, 3, 10, 11].includes(type)) throw new Error(`${file}: TGA type ${type} not supported`);
  const n = width * height;
  const src = Buffer.alloc(n * bytes);
  let p = 18 + idLen;
  if (!rle) b.copy(src, 0, p, p + n * bytes);
  else {
    let o = 0;
    while (o < n * bytes) {
      const h = b[p++];
      const count = (h & 0x7f) + 1;
      if (h & 0x80) {
        for (let i = 0; i < count; i++) b.copy(src, o + i * bytes, p, p + bytes);
        p += bytes;
      } else {
        b.copy(src, o, p, p + count * bytes);
        p += count * bytes;
      }
      o += count * bytes;
    }
  }
  const channels = bytes === 1 ? 1 : bytes;
  const data = Buffer.alloc(n * channels);
  const topDown = (desc & 0x20) !== 0;
  for (let y = 0; y < height; y++) {
    const sy = topDown ? y : height - 1 - y;
    for (let x = 0; x < width; x++) {
      const s = (sy * width + x) * bytes, d = (y * width + x) * channels;
      if (bytes === 1) data[d] = src[s];
      else {
        data[d] = src[s + 2]; data[d + 1] = src[s + 1]; data[d + 2] = src[s]; // BGR(A) → RGB(A)
        if (bytes === 4) data[d + 3] = src[s + 3];
      }
    }
  }
  return { width, height, channels, data };
}
