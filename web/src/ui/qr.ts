// A QR code as an inline SVG (dark modules on white, with the 4-module quiet zone scanners expect), drawn from the
// vendored qrcodegen (web/src/vendor/qrcodegen.ts, MIT).
import { qrcodegen } from '../vendor/qrcodegen';

export function qrSvg(text: string, opts: { label?: string; border?: number } = {}): string {
  const qr = qrcodegen.QrCode.encodeText(text, qrcodegen.QrCode.Ecc.MEDIUM);
  const border = opts.border ?? 4;
  const size = qr.size + border * 2;
  let path = '';
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) if (qr.getModule(x, y)) path += `M${x + border},${y + border}h1v1h-1z`;
  }
  const label = (opts.label ?? 'QR code').replace(/[<>&"]/g, '');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="${label}"><rect width="100%" height="100%" fill="#fff"/><path d="${path}" fill="#111"/></svg>`;
}
