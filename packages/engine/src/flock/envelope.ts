import crypto from "node:crypto"
import { FlockIdentity } from "./identity"

/**
 * SIGN, THEN SEAL. The frame layout is `remote_wire_spec_v1.md` §Frame, byte for
 * byte, so one relay carries both Origami Remote and Flock as opaque bytes.
 *
 *   byte 0      version = 1
 *   byte 1      role: 1 = ask, 2 = answer (Remote reads the same byte as
 *               desktop/phone: the meaning is per-feature, the position is not)
 *   bytes 2..5  seq, uint32 big-endian, per sender, starts at 1, increasing
 *   bytes 6..17 nonce, 12 random bytes
 *   bytes 18..  AES-256-GCM ciphertext + 16-byte tag
 *
 *   AAD       = rid (utf-8 of the base64url string) || bytes 0..5 of the header
 *   plaintext = uint32 BE length || utf-8 JSON || zero pad to a 1,024 multiple
 *
 * BOTH LAYERS ARE LOAD-BEARING. The seal proves a holder of the pair secret wrote
 * the frame — "one of the two of us"; the Ed25519 signature INSIDE the plaintext
 * proves WHICH one and survives being copied out, so a stored answer stays
 * attributable. Verifying only the seal would let a revoked friend who kept the
 * secret keep talking: the case `Store.revoke` + `verifyPayload` close together.
 */

export const VERSION = 1
export const ROLE_ASK = 1
export const ROLE_ANSWER = 2
const HEADER = 18
const NONCE = 12
const PAD = 1024
/** Wire-spec cap. A frame over this is refused rather than truncated. */
export const MAX_FRAME = 65_536

export interface Keys {
  /** AES-256-GCM key for this friendship. */
  readonly key: Buffer
  /** base64url rendezvous id. The only thing a relay ever learns. */
  readonly rid: string
}

/** The sealing key and the rendezvous id, from the X25519 pair secret. Distinct `info`
 *  strings so the id can go to a relay without weakening the key, and a `flock/` namespace
 *  so a box running both features cannot derive one from the other. */
export function derive(sharedSecret: Buffer): Keys {
  const key = Buffer.from(crypto.hkdfSync("sha256", sharedSecret, Buffer.alloc(0), "origami-flock/v1/key", 32))
  const rid = Buffer.from(crypto.hkdfSync("sha256", sharedSecret, Buffer.alloc(0), "origami-flock/v1/rid", 16))
  return { key, rid: rid.toString("base64url") }
}

/** JSON with object keys sorted at every depth, so the bytes a signer signed are
 *  the bytes a verifier rebuilds. `JSON.stringify` preserves insertion order, and
 *  an envelope that crosses a transport as JSON has no guarantee of keeping it. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`
}

/** A payload plus the signature over its canonical form, minus `sig` itself. */
export type Signed<T> = T & { sig: string }

export function signPayload<T extends object>(payload: T, signPrivateKey: string): Signed<T> {
  const sig = FlockIdentity.sign(Buffer.from(canonical(payload), "utf8"), signPrivateKey)
  return { ...payload, sig }
}

/** Whether `signed` was written by the holder of `signPublicKey`. `sig` is stripped before
 *  the canonical form is rebuilt, so the check is independent of where it was carried. */
export function verifyPayload<T extends object>(signed: Signed<T>, signPublicKey: string): boolean {
  const { sig, ...rest } = signed as Signed<Record<string, unknown>>
  if (typeof sig !== "string") return false
  return FlockIdentity.verify(Buffer.from(canonical(rest), "utf8"), sig, signPublicKey)
}

export function seal(input: { keys: Keys; role: number; seq: number; payload: unknown }): Uint8Array {
  const json = Buffer.from(JSON.stringify(input.payload), "utf8")
  const bodyLength = 4 + json.length
  const padded = Buffer.alloc(Math.ceil(bodyLength / PAD) * PAD)
  padded.writeUInt32BE(json.length, 0)
  json.copy(padded, 4)

  const header = Buffer.alloc(HEADER)
  header.writeUInt8(VERSION, 0)
  header.writeUInt8(input.role, 1)
  header.writeUInt32BE(input.seq, 2)
  const nonce = crypto.randomBytes(NONCE)
  nonce.copy(header, 6)

  const aad = Buffer.concat([Buffer.from(input.keys.rid, "utf8"), header.subarray(0, 6)])
  const cipher = crypto.createCipheriv("aes-256-gcm", input.keys.key, nonce)
  cipher.setAAD(aad)
  const frame = Buffer.concat([header, cipher.update(padded), cipher.final(), cipher.getAuthTag()])
  if (frame.length > MAX_FRAME) throw new Error(`flock frame is ${frame.length} bytes, over the ${MAX_FRAME} cap`)
  return frame
}

export interface Opened {
  readonly role: number
  readonly seq: number
  readonly payload: unknown
}

/** Raised for every reason a frame is not accepted. One class: the caller drops
 *  it either way, and naming WHICH check failed is free help for someone probing. */
export class FrameError extends Error {
  constructor(reason: string) {
    super(`flock frame rejected: ${reason}`)
    this.name = "FlockFrameError"
  }
}

/** The reverse of {@link seal}. `lastSeq` is the highest sequence already accepted from
 *  this sender; a frame at or below it is a replay, refused before the tag is checked. */
export function open(input: { keys: Keys; frame: Uint8Array; lastSeq?: number }): Opened {
  const frame = Buffer.from(input.frame.buffer, input.frame.byteOffset, input.frame.byteLength)
  if (frame.length > MAX_FRAME) throw new FrameError("over the size cap")
  if (frame.length < HEADER + 16) throw new FrameError("shorter than a header and a tag")
  if (frame.readUInt8(0) !== VERSION) throw new FrameError("unknown version")
  const role = frame.readUInt8(1)
  const seq = frame.readUInt32BE(2)
  if (input.lastSeq !== undefined && seq <= input.lastSeq) throw new FrameError("replayed sequence")

  const nonce = frame.subarray(6, HEADER)
  const tag = frame.subarray(frame.length - 16)
  const body = frame.subarray(HEADER, frame.length - 16)
  const aad = Buffer.concat([Buffer.from(input.keys.rid, "utf8"), frame.subarray(0, 6)])

  let padded: Buffer
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", input.keys.key, nonce)
    decipher.setAAD(aad)
    decipher.setAuthTag(tag)
    padded = Buffer.concat([decipher.update(body), decipher.final()])
  } catch {
    throw new FrameError("authentication failed")
  }

  if (padded.length < 4) throw new FrameError("truncated plaintext")
  const length = padded.readUInt32BE(0)
  if (length > padded.length - 4) throw new FrameError("declared length overruns the plaintext")
  try {
    return { role, seq, payload: JSON.parse(padded.subarray(4, 4 + length).toString("utf8")) }
  } catch {
    throw new FrameError("plaintext is not JSON")
  }
}

export * as FlockEnvelope from "./envelope"
