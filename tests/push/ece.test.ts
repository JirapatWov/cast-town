// Web Push message encryption (RFC 8291, aes128gcm) with node:crypto only: the RFC's own example byte for byte, a
// round trip, padding, the size limit, and a wrong auth secret.
import { describe, expect, test } from 'bun:test';
import { createECDH, randomBytes } from 'node:crypto';
import { decrypt, encrypt, MAX_PLAINTEXT } from '../../server/push/ece';

const b64 = (s: string) => Buffer.from(s, 'base64url');

// RFC 8291 Appendix A
const A = {
  plaintext: b64('V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24'),
  asPrivate: b64('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'),
  asPublic: b64('BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8'),
  uaPrivate: b64('q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94'),
  uaPublic: b64('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'),
  salt: b64('DGv6ra1nlYgDCS1FRnbzlw'),
  auth: b64('BTBZMqHH6r4Tts7J_aSIgg'),
  body: b64(
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
  ),
};

function uaKeys() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { priv: ecdh.getPrivateKey(), sub: { p256dh: ecdh.getPublicKey(), auth: randomBytes(16) } };
}

describe('RFC 8291 aes128gcm', () => {
  test('Appendix A: the same 144-byte body', () => {
    const body = encrypt(A.plaintext, { p256dh: A.uaPublic, auth: A.auth }, { salt: A.salt, asPrivateKey: A.asPrivate, pad: 0 });
    expect(body.length).toBe(144);
    expect(body.toString('base64url')).toBe(A.body.toString('base64url'));
    expect(decrypt(A.body, A.uaPrivate, A.auth).toString('utf8')).toBe('When I grow up, I want to be a watermelon');
  });

  test('the header: salt, rs 4096, the sender key', () => {
    const { sub } = uaKeys();
    const body = encrypt(Buffer.from('hi'), sub);
    expect(body.readUInt32BE(16)).toBe(4096);
    expect(body[20]).toBe(65);
    expect(body[21]).toBe(0x04);
  });

  test('a round trip with fresh keys, padded to a multiple of 64 bytes', () => {
    const { priv, sub } = uaKeys();
    for (const n of [0, 1, 63, 64, 200, 1000, MAX_PLAINTEXT]) {
      const msg = randomBytes(n);
      const body = encrypt(msg, sub);
      const record = body.length - 86 - 16; // header, tag
      expect(record % 64 === 0 || record === MAX_PLAINTEXT + 1).toBe(true);
      expect(body.length).toBeLessThanOrEqual(4096);
      expect(decrypt(body, priv, sub.auth).equals(msg)).toBe(true);
    }
  });

  test(`more than ${MAX_PLAINTEXT} bytes is refused`, () => {
    const { sub } = uaKeys();
    expect(MAX_PLAINTEXT).toBe(3993);
    expect(() => encrypt(randomBytes(MAX_PLAINTEXT + 1), sub)).toThrow();
  });

  test('a wrong auth secret does not decrypt', () => {
    const { priv, sub } = uaKeys();
    const body = encrypt(Buffer.from('secret'), sub);
    expect(() => decrypt(body, priv, randomBytes(16))).toThrow();
  });

  test('bad subscription keys are refused', () => {
    expect(() => encrypt(Buffer.from('x'), { p256dh: randomBytes(65), auth: randomBytes(16) })).toThrow();
    expect(() => encrypt(Buffer.from('x'), { p256dh: uaKeys().sub.p256dh, auth: randomBytes(8) })).toThrow();
  });
});
