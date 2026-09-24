// Origami Remote — SIGNED AUTHORITY: the bytes the phone signs whenever it
// grants something, and the one verifier that checks them. `deviceAuth.ts`
// proves WHO is on the socket; this proves a particular GRANT was made by that
// enrolled key on a nonce the desktop minted for it — a replayed frame would
// otherwise be approving things. Each payload starts with its own domain so a
// signature can never be reinterpreted as another kind of statement:
//   device-auth  utf8("origami-remote/v1/device-auth") || challenge(32) || utf8(rid)
//   approve      utf8("origami-remote/v1/approve")  || approvalNonce || utf8(toolCallId) || utf8(optionId)
//   set-mode     utf8("origami-remote/v1/set-mode") || nonce(32)     || utf8(sessionId) || utf8(mode)
// The nonce is the RAW DECODED BYTES, not its base64url text.

import type { webcrypto } from 'node:crypto';
import { b64urlDecode } from './crypto';

export const APPROVE_DOMAIN = 'origami-remote/v1/approve';
export const SET_MODE_DOMAIN = 'origami-remote/v1/set-mode';
/** Per ask. The spec's floor is 16; there is no reason to send fewer. */
export const APPROVAL_NONCE_BYTES = 16;
/** Per set-mode request, the same width as the device-auth challenge. */
export const MODE_NONCE_BYTES = 32;
/** The 65-byte X9.63 uncompressed point (0x04 then X then Y). */
export const PUB_BYTES = 65;
/** Raw r,s — the IEEE P1363 form WebCrypto produces and verifies. No DER. */
export const SIG_BYTES = 64;

const TEXT = new TextEncoder();

/** utf8(domain) || nonce bytes || utf8(each remaining field, in order). */
export function authorityPayload(domain: string, nonce: Uint8Array, fields: readonly string[]): Uint8Array {
  const parts = [TEXT.encode(domain), nonce, ...fields.map((f) => TEXT.encode(f))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** An approval of ONE option on ONE tool call, on ONE nonce. */
export function approvePayload(nonce: Uint8Array, toolCallId: string, optionId: string): Uint8Array {
  return authorityPayload(APPROVE_DOMAIN, nonce, [toolCallId, optionId]);
}

/** A switch of ONE session into ONE mode, on ONE challenge nonce. */
export function setModePayload(nonce: Uint8Array, sessionId: string, mode: string): Uint8Array {
  return authorityPayload(SET_MODE_DOMAIN, nonce, [sessionId, mode]);
}

export interface SignatureVerdict {
  ok: boolean;
  reason: string;
}

function subtle(): webcrypto.SubtleCrypto {
  const c = (globalThis as { crypto?: { subtle?: webcrypto.SubtleCrypto } }).crypto;
  if (!c?.subtle) throw new Error('origami remote: WebCrypto (globalThis.crypto.subtle) is unavailable');
  return c.subtle;
}

/** Verify one ECDSA P-256 / SHA-256 signature over `payload`. NEVER throws: a
 *  malformed pub or sig is an INVALID verdict with a reason, so the caller
 *  keeps the reason the owner needs on the status line. */
export async function verifyOver(payload: Uint8Array, sig: string, pub: string): Promise<SignatureVerdict> {
  let pubBytes: Uint8Array;
  let sigBytes: Uint8Array;
  try {
    pubBytes = b64urlDecode(pub);
    sigBytes = b64urlDecode(sig);
  } catch (e) {
    return { ok: false, reason: `bad base64url: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (pubBytes.length !== PUB_BYTES) {
    return { ok: false, reason: `the public key is ${pubBytes.length} bytes, want a ${PUB_BYTES}-byte uncompressed point` };
  }
  if (pubBytes[0] !== 0x04) {
    return { ok: false, reason: 'the public key does not start with 0x04, so it is not an uncompressed point' };
  }
  if (sigBytes.length !== SIG_BYTES) {
    return { ok: false, reason: `the signature is ${sigBytes.length} bytes, want ${SIG_BYTES}` };
  }
  try {
    const key = await subtle().importKey('raw', pubBytes, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const ok = await subtle().verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sigBytes, payload);
    return ok ? { ok: true, reason: 'verified' } : { ok: false, reason: 'the signature did not verify' };
  } catch (e) {
    return { ok: false, reason: `the public key did not import as a P-256 point: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** The grant path's extra rule: the signature must be made by the key the
 *  desktop ENROLLED, never the key carried in the same message — otherwise an
 *  attacker signs his own bytes with his own key and every check passes. */
export async function verifyByEnrolled(args: {
  payload: Uint8Array;
  sig: unknown;
  pub: unknown;
  enrolledPub: string | null;
}): Promise<SignatureVerdict> {
  if (!args.enrolledPub) return { ok: false, reason: 'no device is enrolled, so nothing can be signed for' };
  if (typeof args.sig !== 'string' || typeof args.pub !== 'string') return { ok: false, reason: 'the message carries no signature' };
  if (args.pub !== args.enrolledPub) return { ok: false, reason: 'a key that is not the enrolled device' };
  return verifyOver(args.payload, args.sig, args.pub);
}
