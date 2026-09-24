import crypto from "node:crypto"

/**
 * Who an Origami is to another person's Origami. (Name collision, stated once:
 * `routing.ts` and `health.ts` in this directory are the PROVIDER FLEET, and
 * `@origami/core/util/flock` is a FILE LOCK. Neither relates to this feature.)
 *
 * TWO KEYPAIRS, NOT ONE. Ed25519 signs; X25519 agrees on the pair secret that
 * seals a frame. They cannot be the same key — `node:crypto` exposes no Ed25519
 * to X25519 birational conversion, and rolling one by hand is exactly the kind
 * of crypto nobody should hand-roll. An identity carries both, generated
 * together on first use, and an invite publishes both public halves.
 *
 * KEY ENCODING is base64 of DER (SPKI public, PKCS8 private) rather than the raw
 * 32 bytes, because DER is what `createPublicKey`/`createPrivateKey` round-trip
 * without hand-assembling an ASN.1 prefix.
 */

/** A DER keypair, base64. `privateKey` is PKCS8, `publicKey` is SPKI. */
export interface KeyPair {
  readonly publicKey: string
  readonly privateKey: string
}

/** The half of an identity that is safe to hand to someone else. */
export interface Public {
  /** `name@fingerprint`, the fingerprint in full. A LABEL — the KEY is the
   *  identity, and the label is FROZEN once minted: see {@link handleName}. */
  readonly handle: string
  /** THE DISPLAY NAME. The owner may change it; the handle does not follow. */
  readonly name: string
  /** Which brand sigil variant this owner shows as. See {@link ICON_DEFAULT}. */
  readonly icon: string
  /** base64 SPKI Ed25519. What signatures verify against. */
  readonly signPublicKey: string
  /** base64 SPKI X25519. What the pair secret is agreed with. */
  readonly boxPublicKey: string
}

/** An owner's own identity: both secret halves plus everything in {@link Public}. */
export interface Info extends Public {
  readonly sign: KeyPair
  readonly box: KeyPair
}

/** How many characters a base64url sha256 digest is: 32 bytes, no padding.
 *  Named so a caller can assert the size rather than re-deriving 43 from 32. */
export const FINGERPRINT_LENGTH = 43

/** How much of a fingerprint a LABEL shows. See {@link short}. */
export const SHORT_LENGTH = 8

/**
 * The hash a handle carries: THE WHOLE sha256 of the signing key, base64url, 43
 * characters. The full digest and not a short prefix, because the risk is not
 * two contacts colliding but a stranger ENUMERATING contact identifiers, and 32
 * bits is a few minutes of hashing.
 *
 * The handle is still only a LABEL. Every trust decision — contact lookup,
 * signature verification, envelope routing, revoke — is made against the full
 * PUBLIC KEY. `base64url` and not hex: 43 characters of label beats 64.
 */
export function fingerprint(signPublicKey: string): string {
  return crypto.createHash("sha256").update(signPublicKey).digest("base64url")
}

/**
 * The icon every owner shows as: a short id naming one of the brand sigil
 * variants the client draws, and NEVER an image.
 *
 * An icon rides in an invite and on every signed frame, so what arrives is a
 * value a STRANGER chose. A path, a URL or a data URI here would be a stranger
 * deciding what this Origami fetches or renders; the shape rule below refuses
 * all three, and anything refused or absent falls back to the crane. The engine
 * holds no list of variants on purpose: the drawings live in the client, which
 * draws its own fallback for an id it does not know.
 */
export const ICON_DEFAULT = "crane"

/** What an icon id may look like: lower case, short, and nothing that could be
 *  read as a path, a URL or a scheme. */
const ICON_SHAPE = /^[a-z][a-z0-9-]{0,23}$/

/** `value` when it is a usable icon id, else {@link ICON_DEFAULT}. */
export function normaliseIcon(value: unknown): string {
  return typeof value === "string" && ICON_SHAPE.test(value) ? value : ICON_DEFAULT
}

/** The NAME HALF of a handle, which is not the display name. A handle is minted
 *  once, from the name in force at the time, and never moves again: it is what
 *  the other side stored, what `find` matches, and what pending and answered ids
 *  are filed under. Anything that REBUILDS a handle rebuilds it from this. */
export function handleName(handle: string, fallback: string): string {
  const at = handle.lastIndexOf("@")
  return at > 0 ? handle.slice(0, at) : fallback
}

/** The LABEL form of a handle: `name@` plus the first {@link SHORT_LENGTH}
 *  characters of the fingerprint. For display only — NEVER for matching. A UI
 *  that shows this owes the reader the full handle on hover and on copy. */
export function short(handle: string): string {
  const at = handle.lastIndexOf("@")
  if (at < 0) return handle
  return handle.slice(0, at + 1) + handle.slice(at + 1, at + 1 + SHORT_LENGTH)
}

/** A fresh identity. Called once per install; the result belongs in `flock.json`. */
export function generate(name: string, icon?: string): Info {
  const sign = crypto.generateKeyPairSync("ed25519")
  const box = crypto.generateKeyPairSync("x25519")
  const signPublicKey = sign.publicKey.export({ type: "spki", format: "der" }).toString("base64")
  const boxPublicKey = box.publicKey.export({ type: "spki", format: "der" }).toString("base64")
  return {
    name,
    icon: normaliseIcon(icon),
    handle: `${name}@${fingerprint(signPublicKey)}`,
    signPublicKey,
    boxPublicKey,
    sign: {
      publicKey: signPublicKey,
      privateKey: sign.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
    },
    box: {
      publicKey: boxPublicKey,
      privateKey: box.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
    },
  }
}

/** The shareable half of an identity, with every secret dropped. */
export function toPublic(info: Info): Public {
  return {
    handle: info.handle,
    name: info.name,
    icon: normaliseIcon(info.icon),
    signPublicKey: info.signPublicKey,
    boxPublicKey: info.boxPublicKey,
  }
}

const publicKeyOf = (base64: string) =>
  crypto.createPublicKey({ key: Buffer.from(base64, "base64"), format: "der", type: "spki" })

const privateKeyOf = (base64: string) =>
  crypto.createPrivateKey({ key: Buffer.from(base64, "base64"), format: "der", type: "pkcs8" })

/** Ed25519 signature over `data`, base64. */
export function sign(data: Uint8Array, privateKey: string): string {
  return crypto.sign(null, data, privateKeyOf(privateKey)).toString("base64")
}

/** Whether `signature` is this signer's, over `data`. Returns false rather than
 *  throwing for a malformed key or signature: a caller checking a stranger's
 *  envelope must not be able to be crashed by one. */
export function verify(data: Uint8Array, signature: string, signPublicKey: string): boolean {
  try {
    return crypto.verify(null, data, publicKeyOf(signPublicKey), Buffer.from(signature, "base64"))
  } catch {
    return false
  }
}

/** The X25519 shared secret for one contact. Both sides compute the same 32
 *  bytes from their own private key and the other's public key; neither side's
 *  secret ever moves. {@link Envelope.derive} turns it into the sealing key and
 *  the relay's rendezvous id. */
export function pairSecret(input: { boxPrivateKey: string; peerBoxPublicKey: string }): Buffer {
  return crypto.diffieHellman({
    privateKey: privateKeyOf(input.boxPrivateKey),
    publicKey: publicKeyOf(input.peerBoxPublicKey),
  })
}

export * as FlockIdentity from "./identity"
