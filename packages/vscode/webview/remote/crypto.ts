// Origami Remote — the phone half of the wire crypto.
//
// Implements `remote_wire_spec_v1.md` §"Keys and ids" and §"Frame" with
// WebCrypto only (no packages: this file is bundled into a static shell that
// runs on a phone browser, so every byte here must be platform-native).
//
// The desktop lane implements the SAME algorithm from the SAME spec text. The
// two were written independently and are proven to agree only by an end-to-end
// pairing; until then, a byte-level disagreement is the most likely failure
// mode and `sealFrame`/`openFrame` are deliberately kept as one small,
// readable pair so a reviewer can diff them against the spec line by line.

/** Frame header, in bytes, per the spec: version | role | seq(4) | nonce(12). */
export const HEADER_LEN = 18;
/** The relay closes a socket that carries a frame larger than this (close 4002). */
export const MAX_FRAME = 65536;
/** Byte 0. `1` = sealed with K (from Ks); `2` = sealed with K', the per-socket
 *  session key (wire v1.3). The AAD covers byte 0, so a v2 frame cannot be
 *  downgraded by flipping it — the tag fails. WHICH key a version names is not
 *  decided here: `sessionKey.ts` owns that, per socket. */
export const WIRE_V1 = 1;
export const WIRE_V2 = 2;

export const ROLE_DESKTOP = 1;
export const ROLE_PHONE = 2;

import { padFor, unpadFor } from './pad';

const te = new TextEncoder();

/** base64url (RFC 4648 §5) without padding — the QR fragment's alphabet. */
export function b64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** HKDF-SHA256 with an EMPTY salt, per the spec. Returns `len` bytes. */
async function hkdf(ks: Uint8Array, info: string, len: number): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey('raw', toBuffer(ks), 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: te.encode(info) },
    base,
    len * 8,
  );
  return new Uint8Array(bits);
}

/** WebCrypto wants an ArrayBuffer; a Uint8Array view may be a window onto a
 *  larger buffer, so hand it a copy of exactly the view's bytes. */
function toBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.slice().buffer as ArrayBuffer;
}

/** The AES-256-GCM key derived from the pairing secret. */
export async function deriveKey(ks: Uint8Array): Promise<CryptoKey> {
  const raw = await hkdf(ks, 'origami-remote/v1/key', 32);
  return crypto.subtle.importKey('raw', toBuffer(raw), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** The relay-visible room id. Derived from Ks, but nothing derives back. */
export async function deriveRid(ks: Uint8Array): Promise<string> {
  return b64urlEncode(await hkdf(ks, 'origami-remote/v1/rid', 16));
}

/** AAD = utf-8(rid) || header bytes 0..5 (version, role, seq). The nonce is
 *  NOT in the AAD — GCM already binds it — but the seq is, which is what makes
 *  a replayed frame from a different position fail to open rather than merely
 *  being noticed by the seq check. */
function aad(rid: string, header: Uint8Array): Uint8Array {
  const ridBytes = te.encode(rid);
  const out = new Uint8Array(ridBytes.length + 6);
  out.set(ridBytes, 0);
  out.set(header.subarray(0, 6), ridBytes.length);
  return out;
}

// PADDING MOVED to `pad.ts` (wire v1.3): a v2 frame pads to a §9 bucket and a
// v1 frame to a flat 1,024, so the rule became a decision. v1's own code went
// with it unchanged.

/** Seal one message into a wire frame. `seq` must strictly increase per sender.
 *  `version` picks the padding rule and is what tells the peer which key to
 *  open with; the CALLER owns the key that matches it (`sessionKey.ts`). */
export async function sealFrame(
  key: CryptoKey,
  rid: string,
  role: number,
  seq: number,
  message: unknown,
  version: number = WIRE_V1,
): Promise<Uint8Array> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const header = new Uint8Array(HEADER_LEN);
  header[0] = version;
  header[1] = role;
  new DataView(header.buffer).setUint32(2, seq, false);
  header.set(nonce, 6);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: toBuffer(nonce), additionalData: toBuffer(aad(rid, header)) },
      key,
      toBuffer(padFor(version, JSON.stringify(message))),
    ),
  );
  const frame = new Uint8Array(HEADER_LEN + ct.length);
  frame.set(header, 0);
  frame.set(ct, HEADER_LEN);
  return frame;
}

export interface OpenedFrame {
  role: number;
  seq: number;
  message: unknown;
  /** Byte 0 — which key opened it. The receiver rule in `sessionKey.ts`
   *  reads it, and it is checked BEFORE the key is chosen. */
  version: number;
}

/** Open one wire frame. Throws on an unknown version, a short frame, or a GCM
 *  failure (which covers a tampered header, a wrong rid, and a wrong key —
 *  they are indistinguishable to the receiver, and that is the point). The
 *  REPLAY rule (seq <= last seen) lives in the caller, which owns the per-role
 *  seq state; see `shim.ts`. */
export async function openFrame(key: CryptoKey, rid: string, frame: Uint8Array): Promise<OpenedFrame> {
  if (frame.length <= HEADER_LEN) throw new Error('remote: frame shorter than its header');
  const version = frame[0];
  if (version !== WIRE_V1 && version !== WIRE_V2) throw new Error(`remote: unknown frame version ${version}`);
  const header = frame.subarray(0, HEADER_LEN);
  const seq = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(2, false);
  const plain = new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: toBuffer(header.subarray(6, 18)),
        additionalData: toBuffer(aad(rid, header)),
      },
      key,
      toBuffer(frame.subarray(HEADER_LEN)),
    ),
  );
  return { role: header[1], seq, message: unpadFor(version, plain), version };
}
