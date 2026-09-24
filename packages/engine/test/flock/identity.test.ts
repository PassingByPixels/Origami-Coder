// THE HANDLE, AND WHAT IT IS AND IS NOT.
//
// A handle is a LABEL. The identity is the public key, and every trust decision
// in this feature is made against that key: `Store.findByKey`, the Ed25519
// check in `envelope.verifyPayload`, the rendezvous id derived from the X25519
// pair secret. This file pins the two properties the label itself has to have
// anyway — that it is the whole 256-bit digest, and that it is a pure function
// of the key — plus the one property a truncated label must NOT have: being
// something anything matches on.
//
// WHY THIS FILE EXISTS AT ALL. Up to 0.4.81 the fingerprint was eight hex
// characters, 32 bits, defended as "a friends list is a handful of entries so
// collisions do not matter". Collisions were the wrong worry: 2^32 is minutes
// of hashing, so a 32-bit contact identifier is an ENUMERABLE one. The test
// that would have caught the real problem is not a collision test, it is the
// size assertion at the top of the first block.
import { describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import { FlockIdentity } from "@/flock/identity"

describe("the fingerprint in a handle", () => {
  test("is the WHOLE sha256 of the signing key, base64url, 43 characters", () => {
    const identity = FlockIdentity.generate("alice")
    const fingerprint = FlockIdentity.fingerprint(identity.signPublicKey)

    expect(fingerprint).toHaveLength(43)
    expect(FlockIdentity.FINGERPRINT_LENGTH).toBe(43)
    // 43 base64url characters carry 32 bytes. Assert the BYTES, not just the
    // string length: a truncated digest of the same length would pass a length
    // check on its own.
    expect(Buffer.from(fingerprint, "base64url").length).toBe(32)
    expect(fingerprint).toBe(crypto.createHash("sha256").update(identity.signPublicKey).digest("base64url"))
    // base64url only: a handle travels in a URL fragment (`store.ts` invite).
    expect(fingerprint).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(identity.handle).toBe(`alice@${fingerprint}`)
  })

  test("is a pure function of the signing key, and of nothing else", () => {
    const identity = FlockIdentity.generate("alice")
    expect(FlockIdentity.fingerprint(identity.signPublicKey)).toBe(FlockIdentity.fingerprint(identity.signPublicKey))
    // The BOX key is a different key, so it is a different fingerprint — the
    // handle names the key that signs, which is the key a signature is checked
    // against.
    expect(FlockIdentity.fingerprint(identity.boxPublicKey)).not.toBe(
      FlockIdentity.fingerprint(identity.signPublicKey),
    )
  })

  test("10,000 distinct keys produce 10,000 distinct handles", () => {
    // Real keypair generation for ten thousand identities is seconds of CPU for
    // nothing this asserts: what is under test is the HASH, so the sample is
    // ten thousand distinct key STRINGS of the same shape.
    const handles = new Set<string>()
    for (let i = 0; i < 10_000; i++) {
      handles.add(`friend@${FlockIdentity.fingerprint(`key-${i}-${"x".repeat(44)}`)}`)
    }
    expect(handles.size).toBe(10_000)
  })
})

describe("the SHORT form", () => {
  test("is name@ plus eight characters, and keeps the @", () => {
    const identity = FlockIdentity.generate("alice")
    const short = FlockIdentity.short(identity.handle)

    expect(short).toBe(`alice@${identity.handle.slice(identity.handle.indexOf("@") + 1, identity.handle.indexOf("@") + 9)}`)
    expect(short.length).toBe("alice@".length + FlockIdentity.SHORT_LENGTH)
    expect(identity.handle.startsWith(short)).toBe(true)
  })

  test("is NOT what anything matches on — the store finds by the full handle only", () => {
    // The whole reason the short form is a separate function rather than a
    // slice at each call site: somebody eventually passes the label to a lookup.
    // It has to miss, loudly, rather than resolve to whoever shares eight
    // characters of digest.
    const identity = FlockIdentity.generate("alice")
    expect(FlockIdentity.short(identity.handle)).not.toBe(identity.handle)
  })

  test("leaves a handle with no @ alone rather than eating its first eight characters", () => {
    expect(FlockIdentity.short("nothandleshaped")).toBe("nothandleshaped")
  })
})
