// Message Encryption for Web Push (RFC 8291) in the aes128gcm content coding (RFC 8188), with node:crypto only.
//
// The push service (Apple's, Google's, Mozilla's) only ever sees ciphertext: the key comes from an ECDH between a
// fresh key of ours and the browser's subscription key (p256dh), mixed with the subscription's auth secret.
//   IKM   = HKDF(salt = auth, ECDH(as_priv, ua_pub), "WebPush: info\0" || ua_pub || as_pub, 32)
//   CEK   = HKDF(salt, IKM, "Content-Encoding: aes128gcm\0", 16)
//   NONCE = HKDF(salt, IKM, "Content-Encoding: nonce\0", 12)
//   body  = salt(16) || rs(4) = 4096 || idlen(1) = 65 || as_pub(65) || AES-128-GCM(plaintext || 0x02 || 0x00…) || tag
// One record. The plaintext is padded with zeros to a multiple of 64 bytes, so the push service can't tell one
// notification from another by its exact length.
import { createCipheriv, createDecipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto';

const RS = 4096;
const HEADER = 16 + 4 + 1 + 65;
const TAG = 16;
/** The most a single 4096-byte body can carry (4096 − header − tag − the delimiter). */
export const MAX_PLAINTEXT = RS - HEADER - TAG - 1;
const PAD_BLOCK = 64;

export interface SubscriptionKeys {
  /** The browser's P-256 public key, uncompressed (65 bytes, 0x04 || x || y). */
  p256dh: Uint8Array;
  /** The subscription's auth secret (16 bytes). */
  auth: Uint8Array;
}

function keys(ecdhSecret: Buffer, auth: Uint8Array, uaPublic: Uint8Array, asPublic: Uint8Array, salt: Uint8Array) {
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', ecdhSecret, auth, info, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  return { cek, nonce };
}

export interface EncryptOptions {
  /** Test vectors only: a fixed salt and sender key. */
  salt?: Uint8Array;
  asPrivateKey?: Uint8Array;
  /** Pad the record to a multiple of this many bytes (0: no padding, as in the RFC's example). */
  pad?: number;
}

/** The request body for one push message to `sub`. Throws for bad subscription keys or a too-long message. */
export function encrypt(plaintext: Uint8Array, sub: SubscriptionKeys, o: EncryptOptions = {}): Buffer {
  if (plaintext.length > MAX_PLAINTEXT) throw new Error(`push message too long (${plaintext.length} > ${MAX_PLAINTEXT} bytes)`);
  if (sub.p256dh.length !== 65 || sub.p256dh[0] !== 0x04) throw new Error('bad subscription key');
  if (sub.auth.length !== 16) throw new Error('bad subscription auth secret');
  const ecdh = createECDH('prime256v1');
  if (o.asPrivateKey) ecdh.setPrivateKey(Buffer.from(o.asPrivateKey));
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(Buffer.from(sub.p256dh)); // throws for a point not on the curve
  const salt = o.salt ? Buffer.from(o.salt) : randomBytes(16);
  const { cek, nonce } = keys(secret, sub.auth, sub.p256dh, asPublic, salt);

  const block = o.pad ?? PAD_BLOCK;
  let recordLen = plaintext.length + 1;
  if (block > 0) recordLen = Math.min(Math.ceil(recordLen / block) * block, MAX_PLAINTEXT + 1);
  const record = Buffer.alloc(recordLen); // zeros: the padding
  Buffer.from(plaintext).copy(record);
  record[plaintext.length] = 0x02; // last (only) record

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(HEADER);
  salt.copy(header, 0);
  header.writeUInt32BE(RS, 16);
  header[20] = 65;
  asPublic.copy(header, 21);
  return Buffer.concat([header, ct]);
}

/** The browser's side (tests and the fake push service): the plaintext of one single-record body. */
export function decrypt(body: Uint8Array, uaPrivateKey: Uint8Array, auth: Uint8Array): Buffer {
  const b = Buffer.from(body);
  if (b.length < HEADER + TAG + 1) throw new Error('too short');
  const salt = b.subarray(0, 16);
  const idlen = b[20]!;
  if (idlen !== 65) throw new Error('unexpected key id');
  const asPublic = b.subarray(21, 21 + idlen);
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(Buffer.from(uaPrivateKey));
  const uaPublic = ecdh.getPublicKey();
  const { cek, nonce } = keys(ecdh.computeSecret(asPublic), auth, uaPublic, asPublic, salt);
  const ct = b.subarray(HEADER);
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ct.subarray(ct.length - TAG));
  const record = Buffer.concat([decipher.update(ct.subarray(0, ct.length - TAG)), decipher.final()]);
  let end = record.length - 1;
  while (end >= 0 && record[end] === 0) end--;
  if (end < 0 || record[end] !== 0x02) throw new Error('bad padding');
  return record.subarray(0, end);
}
