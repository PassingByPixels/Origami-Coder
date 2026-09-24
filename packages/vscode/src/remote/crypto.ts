// Origami Remote — key material and sealed-payload crypto (wire spec v1).
//
// WebCrypto ONLY, through `globalThis.crypto.subtle`, so the remote lane ships
// with zero npm dependencies. Every export here is a leaf: no sockets, no
// timers, no vscode import. The spec's words and where each is implemented:
//   Ks   = 32 random bytes                        -> generateKs()
//   key  = HKDF-SHA256(Ks, "", ".../key", 32)     -> deriveKey()
//   rid  = base64url(HKDF(Ks, "", ".../rid", 16)) -> deriveRid()
//   plaintext = uint32 BE len || JSON || zero pad -> padBuckets.ts

import type { webcrypto } from 'node:crypto';

/** The AES-GCM key handle. `lib` is ES2022 with no DOM, so ambient `CryptoKey`
 *  is a value not a type here; Node's webcrypto namespace supplies the type. */
export type RemoteKey = webcrypto.CryptoKey;

export interface WebCryptoLike {
  getRandomValues<T extends ArrayBufferView>(array: T): T;
  subtle: webcrypto.SubtleCrypto;
}

export const KS_BYTES = 32;
export const NONCE_BYTES = 12;
export const GCM_TAG_BYTES = 16;

const HKDF_INFO_KEY = 'origami-remote/v1/key';
const HKDF_INFO_RID = 'origami-remote/v1/rid';

const TEXT = new TextEncoder();

/** The one place the ambient WebCrypto is reached. A missing `subtle` is a
 *  named failure rather than a TypeError deep inside seal(). */
export function wc(): WebCryptoLike {
  const c = (globalThis as { crypto?: WebCryptoLike }).crypto;
  if (!c || !c.subtle) {
    throw new Error('origami remote: WebCrypto (globalThis.crypto.subtle) is unavailable');
  }
  return c;
}

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  wc().getRandomValues(out);
  return out;
}

/** Fresh pairing secret. Key and rid derive from it, so revoke = forget Ks. */
export function generateKs(): Uint8Array {
  return randomBytes(KS_BYTES);
}

const B64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** base64url, unpadded, hand-rolled — `btoa` is not in every extension host. */
export function b64urlEncode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    const n = (b0 << 16) | (b1 << 8) | b2;
    out += B64URL_ALPHABET[(n >>> 18) & 63];
    out += B64URL_ALPHABET[(n >>> 12) & 63];
    if (i + 1 < bytes.length) out += B64URL_ALPHABET[(n >>> 6) & 63];
    if (i + 2 < bytes.length) out += B64URL_ALPHABET[n & 63];
  }
  return out;
}

export function b64urlDecode(text: string): Uint8Array {
  const clean = text.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 6) / 8));
  let acc = 0;
  let bits = 0;
  let w = 0;
  for (const ch of clean) {
    const v = B64URL_ALPHABET.indexOf(ch);
    if (v < 0) throw new Error(`origami remote: bad base64url character ${JSON.stringify(ch)}`);
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[w++] = (acc >>> bits) & 0xff;
    }
  }
  return out.subarray(0, w);
}

/** HKDF-SHA256 with an EMPTY salt, exactly as the spec writes it. The device
 *  group derives over a LONGER ikm (Kg plus two device ids) and with its own
 *  labels, so the primitive is exported and `hkdf` below is the phone lane's
 *  one-secret shorthand for it. */
export async function hkdfBytes(ikm: Uint8Array, info: string, lenBytes: number): Promise<Uint8Array> {
  return hkdf(ikm, info, lenBytes);
}

/** HKDF-SHA256 with an EMPTY salt, exactly as the spec writes it. */
async function hkdf(ks: Uint8Array, info: string, lenBytes: number): Promise<Uint8Array> {
  const subtle = wc().subtle;
  const ikm = await subtle.importKey('raw', asBuffer(ks), 'HKDF', false, ['deriveBits']);
  const bits = await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: TEXT.encode(info) },
    ikm,
    lenBytes * 8,
  );
  return new Uint8Array(bits);
}

/** The AES-256-GCM frame key. Non-extractable, so a later bug cannot leak it. */
export async function deriveKey(ks: Uint8Array): Promise<RemoteKey> {
  const raw = await hkdf(ks, HKDF_INFO_KEY, 32);
  return wc().subtle.importKey('raw', asBuffer(raw), { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

/** The relay's whole view of a pairing: 16 bytes of HKDF, nothing derives back to Ks. */
export async function deriveRid(ks: Uint8Array): Promise<string> {
  return b64urlEncode(await hkdf(ks, HKDF_INFO_RID, 16));
}

/** AES-256-GCM. `nonce` is the frame's 12 random bytes; `aad` is rid + header,
 *  so a frame cannot be replayed onto a different pairing, role or seq. */
export async function seal(
  key: RemoteKey,
  nonce: Uint8Array,
  aad: Uint8Array,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const ct = await wc().subtle.encrypt(
    { name: 'AES-GCM', iv: asBuffer(nonce), additionalData: asBuffer(aad), tagLength: GCM_TAG_BYTES * 8 },
    key,
    asBuffer(plaintext),
  );
  return new Uint8Array(ct);
}

/** Inverse of seal(). Throws on a wrong key, a tampered ciphertext or
 *  MISMATCHED AAD — the last is what binds a frame to its header. */
export async function open(
  key: RemoteKey,
  nonce: Uint8Array,
  aad: Uint8Array,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  const pt = await wc().subtle.decrypt(
    { name: 'AES-GCM', iv: asBuffer(nonce), additionalData: asBuffer(aad), tagLength: GCM_TAG_BYTES * 8 },
    key,
    asBuffer(ciphertext),
  );
  return new Uint8Array(pt);
}

/** WebCrypto wants an ArrayBuffer-backed view; a Uint8Array over a LARGER
 *  buffer must be copied out or the extra bytes ride along. */
export function asBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}
