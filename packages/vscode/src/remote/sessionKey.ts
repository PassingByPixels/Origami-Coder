// Origami Remote — THE SESSION KEY (wire v1.3, §2-§3).
//
// WHAT IT BUYS. Every v1 frame is sealed with `K = HKDF(Ks)`, and `Ks` is the
// thing a thief can copy; the relay's ring replays frames to anyone who can
// name the rid, so a copied `Ks` is a copied transcript. After the phone proves
// its enrolled Secure Enclave key, both ends derive a second key from an
// ECDH the thief cannot compute:
//   Z  = ECDH(ephPriv, devicePub)                 // desktop, here
//      = ECDH(devicePriv, ephPub)                 // phone, in the Enclave
//   K' = HKDF-SHA256(IKM = Z || Ks, salt = challenge,
//                    info = "origami-remote/v2/session-key", 32 bytes)
// `Ks` STAYS IN THE IKM, so K' is useless to someone who obtained Z without Ks;
// `challenge` as the salt binds K' to this socket. `ephPub` IS INSIDE THE
// SIGNATURE (deviceAuth.ts): without it a thief holding Ks swaps in his own
// ephemeral key and ends up sharing a key with the phone. §8.3, not optional.
// `ephPriv` is non-extractable; Z and the IKM are zeroed once HKDF has read
// them, and nothing here logs, persists or returns them.

import { asBuffer, b64urlEncode, randomBytes, wc, type RemoteKey } from './crypto';
import { CHALLENGE_BYTES, verifyChallengeShape, type EnrolledDevice, type SessionState } from './deviceAuth';
import { b64urlDecode } from './crypto';

export const SESSION_KEY_INFO = 'origami-remote/v2/session-key';
/** The 65-byte X9.63 uncompressed point (0x04 then X then Y). */
export const EPH_PUB_BYTES = 65;

const TEXT = new TextEncoder();
const P256 = { name: 'ECDH', namedCurve: 'P-256' } as const;

/** One socket's ephemeral half; the private key never leaves this object. */
export interface Ephemeral {
  privateKey: RemoteKey;
  /** Raw X9.63 bytes, ready for the challenge and for the signed payload. */
  pub: Uint8Array;
}

export async function newEphemeral(): Promise<Ephemeral> {
  const subtle = wc().subtle;
  const pair = await subtle.generateKey(P256, false, ['deriveBits']);
  const pub = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  return { privateKey: pair.privateKey, pub };
}

/** The peer's enrolled key as an ECDH public key. Throws on a non-P-256 point. */
async function importPeer(devicePub: Uint8Array): Promise<RemoteKey> {
  if (devicePub.length !== EPH_PUB_BYTES || devicePub[0] !== 0x04) {
    throw new Error(`origami remote: the device key is not a ${EPH_PUB_BYTES}-byte uncompressed point`);
  }
  return wc().subtle.importKey('raw', asBuffer(devicePub), P256, false, []);
}

/** The raw 32 bytes of K'. Exported ONLY so the interop vector can be pinned. */
export async function sessionKeyBytes(args: {
  ephPriv: RemoteKey;
  devicePub: Uint8Array;
  ks: Uint8Array;
  challenge: Uint8Array;
}): Promise<Uint8Array> {
  const subtle = wc().subtle;
  const peer = await importPeer(args.devicePub);
  const z = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: peer }, args.ephPriv, 256));
  const ikm = new Uint8Array(z.length + args.ks.length);
  ikm.set(z, 0);
  ikm.set(args.ks, z.length);
  try {
    return await hkdf(ikm, args.challenge);
  } finally {
    // The shared secret and the IKM are the two raw secrets on this heap; they
    // are dead the moment HKDF has read them.
    z.fill(0);
    ikm.fill(0);
  }
}

async function hkdf(ikm: Uint8Array, salt: Uint8Array): Promise<Uint8Array> {
  const subtle = wc().subtle;
  const base = await subtle.importKey('raw', asBuffer(ikm), 'HKDF', false, ['deriveBits']);
  const bits = await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: asBuffer(salt), info: TEXT.encode(SESSION_KEY_INFO) },
    base,
    256,
  );
  return new Uint8Array(bits);
}

/** K', as a NON-EXTRACTABLE AES-256-GCM key, so a later bug cannot leak it. */
export async function deriveSessionKey(args: {
  ephPriv: RemoteKey;
  devicePub: Uint8Array;
  ks: Uint8Array;
  challenge: Uint8Array;
}): Promise<RemoteKey> {
  const raw = await sessionKeyBytes(args);
  try {
    return await wc().subtle.importKey('raw', asBuffer(raw), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  } finally {
    raw.fill(0);
  }
}

// --------------------------------------------------------------------------
// THE PER-SOCKET EXCHANGE. `deviceSession.ts` owns WHEN the desktop asks; this
// owns the one socket's ephemeral half — challenge bytes, key pair, K' itself.

/** What a DeviceSession lends the exchange: the pairing secret K' derives from,
 *  and where K' goes (the frame codec). Both optional for tests. */
export interface SessionDeps {
  ks?: () => Uint8Array | null;
  /** `null` means "this socket is gone" — see FrameCodec.useSessionKey. */
  onSessionKey?: (key: RemoteKey | null) => void;
}

export interface ExchangeVerdict {
  ok: boolean;
  reason: string;
  /** K', present only when the phone answered v2 AND a device was enrolled. */
  key?: RemoteKey;
}

export class SessionExchange {
  private eph: Ephemeral | null = null;
  private challenge: Uint8Array | null = null;
  private state: SessionState = 'off';

  public get status(): SessionState { return this.state; }

  /** A new socket, or a verdict thrown away: a new challenge and ephemeral key.
   *  Dropping the old private key makes a ring-replayed v2 frame unopenable. */
  public reset(): void {
    this.eph = null;
    this.challenge = null;
    this.state = 'off';
  }

  /**
   * The `remote/challenge` body, §2.1. Minted ONCE per socket and returned
   * unchanged: a retry must re-send the SAME bytes or it races the first answer.
   */
  public async offer(): Promise<Record<string, unknown>> {
    this.challenge ??= randomBytes(CHALLENGE_BYTES);
    this.eph ??= await newEphemeral();
    return { type: 'remote/challenge', v: 2, challenge: b64urlEncode(this.challenge), ephPub: b64urlEncode(this.eph.pub) };
  }

  /**
   * One `remote/challenge-response`. Verifies the v2 bytes first and v1 only to
   * DETECT an old build; derives K' on a v2 answer from an enrolled key. A
   * keyless page stays on v1 — §5's "keyless is watch".
   */
  public async accept(args: {
    sig: string;
    pub: string;
    rid: string;
    /** The record on file, or null for a page that enrolled nothing. */
    enrolled: EnrolledDevice | null;
    ks: Uint8Array | null;
  }): Promise<ExchangeVerdict> {
    const challenge = this.challenge;
    const eph = this.eph;
    if (!challenge || !eph) return { ok: false, reason: 'no challenge is pending on this socket' };
    // The ENROLLED key when there is one, never merely the `pub` in the same
    // message: otherwise an attacker signs his own bytes with his own key.
    const pub = args.enrolled?.pub ?? args.pub;
    const { shape, reason } = await verifyChallengeShape({ challengeBytes: challenge, rid: args.rid, ephPub: eph.pub, sig: args.sig, pub });
    if (shape === null) return { ok: false, reason };
    if (shape === 'v1') {
      this.state = 'old-app';
      return { ok: true, reason };
    }
    // A page that enrolled nothing gets no K' at all (§5, "keyless is watch").
    if (!args.enrolled || !args.ks) return { ok: true, reason };
    const devicePub = b64urlDecode(args.enrolled.pub);
    const key = await deriveSessionKey({ ephPriv: eph.privateKey, devicePub, ks: args.ks, challenge });
    this.state = 'on';
    return { ok: true, reason, key };
  }
}
