// Origami device group — the PAIRWISE keys two desks talk on.
//
// The phone lane derives everything from one Ks (crypto.ts). A group has many
// devices, so one secret per pair would be a key-exchange problem. Instead the
// group holds ONE secret Kg and every pair derives its own rid and key from Kg
// and the two device ids. Two desks therefore agree on a rid without ever
// telling each other anything, and a third desk that holds Kg still cannot join
// their socket: the relay allows one socket per role per rid and the pair's rid
// is not the one it derives for itself.
//
//   ikm  = Kg || utf8(lower id) || utf8(higher id)      -- sorted, so both ends agree
//   rid  = base64url(HKDF(ikm, "origami-group/v1/rid", 16))
//   key  = HKDF(ikm, "origami-group/v1/key", 32)        -> AES-256-GCM
//
// The LABEL IS A PARAMETER. A later lane (artifacts) derives a second rid over
// the same pair with its own label, and two lanes sharing a rid would put two
// sockets in one relay slot.
//
// Device ids are FIXED LENGTH. The ikm is a concatenation, so a variable-length
// id would let ("ab","c") and ("a","bc") produce the same bytes.

import { ROLE_DESKTOP, ROLE_PHONE, type Role } from './frame';
import { b64urlEncode, hkdfBytes, randomBytes, type RemoteKey, asBuffer, wc } from './crypto';

export const GROUP_LABEL_RID = 'origami-group/v1/rid';
export const GROUP_LABEL_KEY = 'origami-group/v1/key';

// THE JOIN RENDEZVOUS (t-sj32zl, v2). The key a joining desk pastes does NOT
// carry Kg. It carries a ONE-TIME invite secret, minted fresh for each invite
// and held only in memory, plus the inviter's id. The join rid and key derive
// from that secret, so every invite opens a new rendezvous and a used or old
// key names a rid nobody listens on. The inviter waits there as "desktop", the
// joiner connects as "phone" and says its id, the inviter's owner clicks
// Accept, and only then does Kg travel, inside the sealed welcome.
//
//   ikm   = secret || utf8(inviter id)
//   rid   = base64url(HKDF(ikm, "origami-group/v2/join-rid", 16))
//   key   = HKDF(ikm, "origami-group/v2/join-key", 32)       -> AES-256-GCM
//   match = HKDF(ikm || utf8(joiner id) || joiner pub, "origami-group/v2/match", 4) mod 10^6
export const GROUP_LABEL_JOIN_RID = 'origami-group/v2/join-rid';
export const GROUP_LABEL_JOIN_KEY = 'origami-group/v2/join-key';
export const GROUP_LABEL_MATCH = 'origami-group/v2/match';
export const INVITE_SECRET_BYTES = 16;

export const KG_BYTES = 32;
/** 8 random bytes = 11 base64url characters; collision within one household is
 *  not a real risk and the id is never a security boundary — Kg is. */
export const DEVICE_ID_BYTES = 8;
export const DEVICE_ID_CHARS = 11;

const TEXT = new TextEncoder();

export function generateKg(): Uint8Array {
  return randomBytes(KG_BYTES);
}

export function generateDeviceId(): string {
  return b64urlEncode(randomBytes(DEVICE_ID_BYTES));
}

export function isDeviceId(value: unknown): value is string {
  return typeof value === 'string' && value.length === DEVICE_ID_CHARS && /^[A-Za-z0-9_-]+$/.test(value);
}

/** The two ids in the one order both ends compute. Throws rather than guessing:
 *  a mis-sized id would silently derive a rid the peer never connects to. */
export function sortedPair(a: string, b: string): [string, string] {
  if (!isDeviceId(a) || !isDeviceId(b)) {
    throw new Error(`origami group: a device id must be ${DEVICE_ID_CHARS} base64url characters`);
  }
  if (a === b) throw new Error('origami group: a device cannot pair with itself');
  return a < b ? [a, b] : [b, a];
}

/** Kg || the sorted pair. Exported for the vectors in the tests. */
export function pairIkm(kg: Uint8Array, a: string, b: string): Uint8Array {
  const [low, high] = sortedPair(a, b);
  const ikm = new Uint8Array(kg.length + DEVICE_ID_CHARS * 2);
  ikm.set(kg, 0);
  ikm.set(TEXT.encode(low), kg.length);
  ikm.set(TEXT.encode(high), kg.length + DEVICE_ID_CHARS);
  return ikm;
}

/** The relay's whole view of one pair. `label` names the LANE, not the pair. */
export async function derivePairRid(
  kg: Uint8Array,
  a: string,
  b: string,
  label: string = GROUP_LABEL_RID,
): Promise<string> {
  return b64urlEncode(await hkdfBytes(pairIkm(kg, a, b), label, 16));
}

/** The pair's AES-256-GCM key. Non-extractable, like the phone lane's. */
export async function derivePairKey(
  kg: Uint8Array,
  a: string,
  b: string,
  label: string = GROUP_LABEL_KEY,
): Promise<RemoteKey> {
  const raw = await hkdfBytes(pairIkm(kg, a, b), label, 32);
  return wc().subtle.importKey('raw', asBuffer(raw), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export function generateInviteSecret(): Uint8Array {
  return randomBytes(INVITE_SECRET_BYTES);
}

/** secret || the ids, in the order given. One invitation, not a pair's channel. */
export function joinIkm(secret: Uint8Array, ...ids: string[]): Uint8Array {
  if (secret.length !== INVITE_SECRET_BYTES) throw new Error('origami group: an invite secret is 16 bytes');
  if (!ids.every(isDeviceId)) throw new Error(`origami group: a device id must be ${DEVICE_ID_CHARS} base64url characters`);
  const ikm = new Uint8Array(secret.length + DEVICE_ID_CHARS * ids.length);
  ikm.set(secret, 0);
  ids.forEach((id, i) => ikm.set(TEXT.encode(id), secret.length + DEVICE_ID_CHARS * i));
  return ikm;
}

export async function deriveJoinRid(secret: Uint8Array, inviterId: string): Promise<string> {
  return b64urlEncode(await hkdfBytes(joinIkm(secret, inviterId), GROUP_LABEL_JOIN_RID, 16));
}

export async function deriveJoinKey(secret: Uint8Array, inviterId: string): Promise<RemoteKey> {
  const raw = await hkdfBytes(joinIkm(secret, inviterId), GROUP_LABEL_JOIN_KEY, 32);
  return wc().subtle.importKey('raw', asBuffer(raw), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** The six digits BOTH desks show, "123 456". Both hold the secret, both ids
 *  and the joiner's ephemeral public key, so both compute it; a desk that
 *  joined with a copied key has another id and key, so other digits. */
export async function deriveMatchCode(secret: Uint8Array, inviterId: string, joinerId: string, joinerPub: Uint8Array): Promise<string> {
  const ids = joinIkm(secret, inviterId, joinerId);
  const ikm = new Uint8Array(ids.length + joinerPub.length);
  ikm.set(ids, 0);
  ikm.set(joinerPub, ids.length);
  const b = await hkdfBytes(ikm, GROUP_LABEL_MATCH, 4);
  const n = (((b[0]! << 24) >>> 0) + (b[1]! << 16) + (b[2]! << 8) + b[3]!) % 1_000_000;
  const digits = String(n).padStart(6, '0');
  return `${digits.slice(0, 3)} ${digits.slice(3)}`;
}

/** The relay knows two roles and nothing else, so the pair splits them by id
 *  order: the LOWER id is the desktop. Both ends compute the same answer from
 *  the same two strings, which is the point — nobody negotiates. */
export function pairRole(self: string, peer: string): Role {
  const [low] = sortedPair(self, peer);
  return low === self ? ROLE_DESKTOP : ROLE_PHONE;
}

/** The `?role=` the transport puts in the socket URL for that role. */
export function roleQuery(role: Role): 'desktop' | 'phone' {
  return role === ROLE_PHONE ? 'phone' : 'desktop';
}
