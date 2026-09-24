// Origami Remote: the phone's half of the session key.
//
// The desktop mints an ephemeral P-256 key per socket; this page signs it
// with the device key, does ECDH, and both ends derive
//
//   K' = HKDF-SHA256(IKM = Z || Ks, salt = challenge,
//                    info = "origami-remote/v2/session-key", 32 bytes)
//
// A thief holding only `Ks` cannot compute K', and every frame after the answer
// is sealed with it. The version is decided by `ephPub`'s presence, not by a
// capability flag: a shell or browser with no Secure Enclave device key signs
// the v1 shape instead. `WireKeys` tracks which version a socket is on, and a
// v1 frame after an accepted v2 one is a downgrade, not a straggler.

import { WIRE_V1, WIRE_V2, b64urlDecode, b64urlEncode, openFrame, sealFrame, type OpenedFrame } from './crypto';
import { native, signChallenge, type ChallengeResponse } from './native';

export const SESSION_KEY_INFO = 'origami-remote/v2/session-key';
/** Domain separator for the v2 signature, so it can't replay as a v1 one. */
const DEVICE_AUTH_V2_PREFIX = 'origami-remote/v2/device-auth';
/** Challenge is 32 random bytes, point is 65; anything else is a broken desktop. */
const CHALLENGE_LEN = 32;
const EPH_PUB_LEN = 65;

const te = new TextEncoder();

/** utf8(v2 domain) || challenge(32) || utf8(rid) || ephPub(65), raw bytes. */
export function deviceAuthPayloadV2(challenge: Uint8Array, rid: string, ephPub: Uint8Array): Uint8Array {
  const parts = [te.encode(DEVICE_AUTH_V2_PREFIX), challenge, te.encode(rid), ephPub];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** K' from the shared secret the shell computed. Non-extractable, and `z` is zeroed here. */
export async function deriveSessionKey(z: Uint8Array, ks: Uint8Array, challenge: Uint8Array): Promise<CryptoKey> {
  const ikm = new Uint8Array(z.length + ks.length);
  ikm.set(z, 0);
  ikm.set(ks, z.length);
  try {
    const base = await crypto.subtle.importKey('raw', ikm.slice().buffer as ArrayBuffer, 'HKDF', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: challenge.slice().buffer as ArrayBuffer, info: te.encode(SESSION_KEY_INFO) },
      base,
      256,
    );
    return await crypto.subtle.importKey('raw', bits, 'AES-GCM', false, ['encrypt', 'decrypt']);
  } finally {
    ikm.fill(0);
    z.fill(0);
  }
}

/** The v2 fields of a `remote/challenge`, or null (caller falls back to v1). */
export function readV2Challenge(msg: unknown): { challenge: Uint8Array; ephPub: Uint8Array } | null {
  const m = msg as { challenge?: unknown; ephPub?: unknown } | null | undefined;
  if (typeof m?.challenge !== 'string' || typeof m?.ephPub !== 'string') return null;
  try {
    const challenge = b64urlDecode(m.challenge);
    const ephPub = b64urlDecode(m.ephPub);
    if (challenge.length !== CHALLENGE_LEN || ephPub.length !== EPH_PUB_LEN || ephPub[0] !== 0x04) return null;
    return { challenge, ephPub };
  } catch {
    return null;
  }
}

export interface V2Answer {
  response: ChallengeResponse;
  key: CryptoKey;
}

/** Answers a v2 challenge, or undefined to fall back to v1. No biometric:
 *  a Face ID sheet on every reconnect would be an outage. */
export async function answerV2(msg: unknown, rid: string, ks: Uint8Array, fp?: string): Promise<V2Answer | undefined> {
  const shell = native();
  if (!shell?.deviceAuth) return undefined;
  const parsed = readV2Challenge(msg);
  if (!parsed) return undefined;
  try {
    const { sig, pub, z } = await shell.deviceAuth({
      challenge: b64urlEncode(parsed.challenge),
      rid,
      ephPub: b64urlEncode(parsed.ephPub),
    });
    const key = await deriveSessionKey(b64urlDecode(z), ks, parsed.challenge);
    // v2 answer has v: 2, a distinct shape, so it can't be misread as v1.
    return { response: { type: 'remote/challenge-response', v: 2, sig, pub, fp }, key };
  } catch (err: unknown) {
    // A refusing shell must not take the socket down; v1 is still open.
    console.warn('[remote] the shell refused the v2 device-auth', err);
    return undefined;
  }
}

/** One socket's keys; the transport seals and opens through this, not a bare CryptoKey. */
export class WireKeys {
  private session: CryptoKey | null = null;
  private sealV2 = false;
  private peerOnV2 = false;

  constructor(private readonly key: CryptoKey, public readonly rid: string) {}

  /** For the pane and the tests: is this socket sealing with K'? */
  public get sessionOn(): boolean { return this.sealV2; }

/** New socket, new challenge and ephemeral key: this page's K' is dead too. */
  public reset(): void {
    this.session = null;
    this.sealV2 = false;
    this.peerOnV2 = false;
  }

/** K' exists: open v2 frames from now on. Called before the answer is on
 *  the wire, since the desktop's first v2 frame can arrive first. */
  public opened(key: CryptoKey): void {
    this.session = key;
  }

/** Seals with K' from now on, called once the response has left the wire. */
  public sealing(): void {
    if (this.session) this.sealV2 = true;
  }

  public seal(role: number, seq: number, message: unknown): Promise<Uint8Array> {
    const version = this.sealV2 ? WIRE_V2 : WIRE_V1;
    return sealFrame(this.sealV2 && this.session ? this.session : this.key, this.rid, role, seq, message, version);
  }

/** Receiver rule decided before crypto runs, so a downgrade is named, not a GCM failure. */
  public async open(frame: Uint8Array): Promise<OpenedFrame> {
    const version = frame[0];
    if (version === WIRE_V2 && !this.session) throw new Error('remote: a version 2 frame arrived before this socket derived a session key');
    if (version === WIRE_V1 && this.peerOnV2) throw new Error('remote: a version 1 frame arrived after the desktop had switched to the session key');
    const opened = await openFrame(version === WIRE_V2 && this.session ? this.session : this.key, this.rid, frame);
    if (opened.version === WIRE_V2) this.peerOnV2 = true;
    return opened;
  }
}

/** Answers one `remote/challenge`, whichever shape, and switches the socket
 *  over. K' may open as soon as it exists, but seals only once the response
 *  is on the wire. No `ephPub` or shell agreement falls back to v1. */
export async function handleChallenge(
  msg: unknown,
  d: { keys: WireKeys; ks: Uint8Array; fp?: string; send: (msg: unknown) => Promise<void> },
): Promise<void> {
  const v2 = await answerV2(msg, d.keys.rid, d.ks, d.fp);
  if (v2) {
    d.keys.opened(v2.key);
    await d.send(v2.response);
    d.keys.sealing();
    return;
  }
  const res = await signChallenge(msg, d.keys.rid, d.fp);
  if (res) await d.send(res);
}
