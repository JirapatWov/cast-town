// The pairing QR code (Settings → Pair a phone): a well-formed SVG with the quiet zone, and the vendored encoder's
// output for a typical one-time link.
import { expect, test } from 'bun:test';
import { qrSvg } from '../../web/src/ui/qr';
import { qrcodegen } from '../../web/src/vendor/qrcodegen';

test('qrSvg draws the code with a 4-module quiet zone and an accessible label', () => {
  const link = 'https://cast.example.ts.net/?token=AbCdEfGhIjKlMnOpQrStUv';
  const qr = qrcodegen.QrCode.encodeText(link, qrcodegen.QrCode.Ecc.MEDIUM);
  const svg = qrSvg(link, { label: 'Pairing <code>' });
  expect(svg.startsWith('<svg')).toBe(true);
  expect(svg).toContain(`viewBox="0 0 ${qr.size + 8} ${qr.size + 8}"`);
  expect(svg).toContain('aria-label="Pairing code"'); // markup stripped from the label
  const modules = (svg.match(/h1v1h-1z/g) ?? []).length;
  let dark = 0;
  for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) if (qr.getModule(x, y)) dark++;
  expect(modules).toBe(dark);
  expect(svg).not.toContain(link); // the secret is only in the pattern, not as text in the page
});
