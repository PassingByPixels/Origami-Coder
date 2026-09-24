// Kg inside the welcome is sealed TO THE DESK THAT ASKED (t-sj32zl).
//
// The join frames are already sealed under the join key, but the join key
// derives from the pasted invite secret, and the ticket's threat is a LEAKED
// key. A holder of that key who takes the joiner's relay slot after the owner
// saw the right code, or who runs the relay, could open a welcome sealed with
// the join key alone. So the joiner sends an ephemeral ECDH P-256 public key in
// group/join, the inviter answers with its own ephemeral one, and Kg is sealed
// under a key only those two private keys can derive:
//
//   wrap = HKDF(ECDH(inviter eph, joiner eph) || secret, "origami-group/v2/welcome", 32)
//   box  = nonce(12) || AES-256-GCM(wrap, nonce, aad = utf8(joiner id), Kg)
//
// The joiner's public key is also inside the match code (groupCrypto.ts), so a
// relay that swapped it would show the owner two different codes.

import { asBuffer, b64urlDecode, b64urlEncode, hkdfBytes, NONCE_BYTES, open, randomBytes, seal, wc, type RemoteKey } from './crypto';
import { KG_BYTES } from './groupCrypto';

const LABEL = 'origami-group/v2/welcome';
const CURVE = { name: 'ECDH', namedCurve: 'P-256' } as const;
const TEXT = new TextEncoder();

export interface EphemeralKeys {
  /** Raw uncompressed P-256 point, 65 bytes. */
  pub: Uint8Array;
  priv: RemoteKey;
}

/** A fresh pair per join. Held in memory for one handshake, never stored. */
export async function ephemeralKeys(): Promise<EphemeralKeys> {
  const pair = (await wc().subtle.generateKey(CURVE, false, ['deriveBits'])) as { publicKey: RemoteKey; privateKey: RemoteKey };
  return { pub: new Uint8Array(await wc().subtle.exportKey('raw', pair.publicKey)), priv: pair.privateKey };
}

async function wrapKey(priv: RemoteKey, peerPub: Uint8Array, secret: Uint8Array): Promise<RemoteKey> {
  const peer = await wc().subtle.importKey('raw', asBuffer(peerPub), CURVE, false, []);
  const shared = new Uint8Array(await wc().subtle.deriveBits({ name: 'ECDH', public: peer }, priv, 256));
  const ikm = new Uint8Array(shared.length + secret.length);
  ikm.set(shared, 0);
  ikm.set(secret, shared.length);
  const raw = await hkdfBytes(ikm, LABEL, 32);
  return wc().subtle.importKey('raw', asBuffer(raw), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** Inviter side: the two welcome fields that carry Kg, `pub` and `box`. */
export async function sealKg(kg: Uint8Array, joinerPub: Uint8Array, joinerId: string, secret: Uint8Array): Promise<{ pub: string; box: string }> {
  const mine = await ephemeralKeys();
  const nonce = randomBytes(NONCE_BYTES);
  const ct = await seal(await wrapKey(mine.priv, joinerPub, secret), nonce, TEXT.encode(joinerId), kg);
  const box = new Uint8Array(NONCE_BYTES + ct.length);
  box.set(nonce, 0);
  box.set(ct, NONCE_BYTES);
  return { pub: b64urlEncode(mine.pub), box: b64urlEncode(box) };
}

/** Joiner side: Kg out of a welcome, or null for any fault. */
export async function openKg(msg: unknown, mine: EphemeralKeys, joinerId: string, secret: Uint8Array): Promise<Uint8Array | null> {
  const m = msg as { pub?: unknown; box?: unknown } | null;
  if (typeof m?.pub !== 'string' || typeof m.box !== 'string') return null;
  try {
    const box = b64urlDecode(m.box);
    const key = await wrapKey(mine.priv, b64urlDecode(m.pub), secret);
    const kg = await open(key, box.slice(0, NONCE_BYTES), TEXT.encode(joinerId), box.slice(NONCE_BYTES));
    return kg.length === KG_BYTES ? kg : null;
  } catch {
    return null;
  }
}

/** The joiner's public key off a group/join, or null. */
export function readJoinPub(msg: unknown): Uint8Array | null {
  const raw = (msg as { pub?: unknown } | null)?.pub;
  if (typeof raw !== 'string') return null;
  try {
    const pub = b64urlDecode(raw);
    return pub.length === 65 ? pub : null;
  } catch {
    return null;
  }
}
