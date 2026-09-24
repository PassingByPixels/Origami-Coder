// Origami Remote — the binary frame (wire spec v1, section "Frame").
//
//   byte 0      version: 1 = sealed with K (from Ks), 2 = sealed with K'
//   byte 1      role: 1 = desktop, 2 = phone
//   bytes 2..5  seq, uint32 big-endian, per sender, starts at 1, increasing
//   bytes 6..17 nonce, 12 random bytes
//   bytes 18..  AES-256-GCM ciphertext + 16-byte tag
//   AAD       = utf-8(rid) || bytes 0..5 of the header
//   plaintext = uint32 BE length || utf-8 JSON || zero pad (padBuckets.ts)
// The AAD covers byte 0, so a v2 frame cannot be downgraded to v1: the tag
// fails. A receiver rejects unknown version, seq <= the last seq seen from that
// role (replay), and GCM failure; WHICH key a version names is `frameCodec.ts`.

import { GCM_TAG_BYTES, NONCE_BYTES, open, randomBytes, seal, type RemoteKey } from './crypto';
import { MAX_V2_JSON_BYTES, PAD_BLOCK, padFor, unpadFor } from './padBuckets';

export const FRAME_VERSION = 1;
/** Wire v1.3: sealed with K', the session key both ends derive from the ECDH in
 *  the challenge. Only sent after the phone's signature over `ephPub` verified. */
export const FRAME_VERSION_V2 = 2;
export const ROLE_DESKTOP = 1;
export const ROLE_PHONE = 2;
export type Role = typeof ROLE_DESKTOP | typeof ROLE_PHONE;

export const HEADER_BYTES = 18;
/** The relay closes a socket that sends a bigger frame (4002): a hard ceiling. */
export const MAX_FRAME_BYTES = 65_536;
/** Largest plaintext under MAX_FRAME_BYTES, rounded DOWN to a whole pad block. */
export const MAX_PLAINTEXT_BYTES =
  Math.floor((MAX_FRAME_BYTES - HEADER_BYTES - GCM_TAG_BYTES) / PAD_BLOCK) * PAD_BLOCK;
/** ...and the largest single JSON message. Above this, split per chunk.ts. */
export const MAX_JSON_BYTES = MAX_PLAINTEXT_BYTES - 4;

/** The largest JSON a frame of `version` may carry; v2's §9 ceiling is lower. */
export function maxJsonFor(version: number): number {
  return version === FRAME_VERSION_V2 ? MAX_V2_JSON_BYTES : MAX_JSON_BYTES;
}

export type FrameRejection = 'short' | 'version' | 'role' | 'replay' | 'gcm' | 'padding';

/** Every rejection a receiver can make, as one named type. The `reason` is what
 *  the caller logs and what tells the AAD check from the replay check. */
export class FrameError extends Error {
  constructor(public readonly reason: FrameRejection, message: string, public readonly frame?: DecodedFrame) {
    super(message);
    this.name = 'FrameError';
  }
}

export interface DecodedFrame {
  role: Role;
  seq: number;
  json: string;
  /** Byte 0 — which key opened it. The codec's receiver rule reads it. */
  version: number;
}

function isRole(n: number): n is Role {
  return n === ROLE_DESKTOP || n === ROLE_PHONE;
}

/** AAD = utf-8 of the base64url rid, then the first SIX header bytes; the nonce
 *  is not covered because GCM already binds it as the IV. */
export function buildAad(rid: string, header: Uint8Array): Uint8Array {
  const ridBytes = new TextEncoder().encode(rid);
  const aad = new Uint8Array(ridBytes.length + 6);
  aad.set(ridBytes, 0);
  aad.set(header.subarray(0, 6), ridBytes.length);
  return aad;
}

/** Build one frame. `nonce` is injectable for tests; production uses 12 random bytes. */
export async function encodeFrame(
  key: RemoteKey,
  rid: string,
  role: Role,
  seq: number,
  json: string,
  nonce: Uint8Array = randomBytes(NONCE_BYTES),
  version: number = FRAME_VERSION,
): Promise<Uint8Array> {
  if (!Number.isInteger(seq) || seq < 1 || seq > 0xffff_ffff) {
    throw new FrameError('replay', `seq ${seq} is outside the uint32 range the header can carry`);
  }
  const header = new Uint8Array(HEADER_BYTES);
  header[0] = version;
  header[1] = role;
  new DataView(header.buffer).setUint32(2, seq, false);
  header.set(nonce, 6);
  const ct = await seal(key, nonce, buildAad(rid, header), padFor(version, json));
  const frame = new Uint8Array(HEADER_BYTES + ct.length);
  frame.set(header, 0);
  frame.set(ct, HEADER_BYTES);
  if (frame.length > MAX_FRAME_BYTES) {
    throw new FrameError('short', `frame is ${frame.length} bytes, over the ${MAX_FRAME_BYTES} relay cap`);
  }
  return frame;
}

/** Open one frame. Does NOT do the replay check nor decide which key a version
 *  byte names — use FrameCodec unless you want a stateless decode. */
export async function decodeFrame(key: RemoteKey, rid: string, frame: Uint8Array): Promise<DecodedFrame> {
  if (frame.length < HEADER_BYTES + GCM_TAG_BYTES) {
    throw new FrameError('short', `frame is ${frame.length} bytes, below the ${HEADER_BYTES + GCM_TAG_BYTES}-byte minimum`);
  }
  const version = frame[0]!;
  if (version !== FRAME_VERSION && version !== FRAME_VERSION_V2) {
    throw new FrameError('version', `unknown frame version ${version}`);
  }
  const role = frame[1]!;
  if (!isRole(role)) throw new FrameError('role', `unknown role ${role}`);
  const seq = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(2, false);
  const header = frame.subarray(0, HEADER_BYTES);
  const nonce = frame.subarray(6, HEADER_BYTES);
  let plaintext: Uint8Array;
  try {
    plaintext = await open(key, nonce, buildAad(rid, header), frame.subarray(HEADER_BYTES));
  } catch (e) {
    throw new FrameError('gcm', `frame failed authentication: ${e instanceof Error ? e.message : String(e)}`);
  }
  let json: string;
  try {
    json = unpadFor(version, plaintext);
  } catch (e) {
    throw new FrameError('padding', e instanceof Error ? e.message : String(e));
  }
  return { role, seq, json, version };
}
