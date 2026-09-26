// The wire. Two independent layers are asserted separately, because each one
// covers a case the other cannot:
//
//   SEALING says "one of the two of us wrote this" and hides it from the relay.
//   SIGNING says WHICH of us, and keeps saying it after the frame is gone.
//
// The frame's BYTE LAYOUT is asserted against remote_wire_spec_v1.md §Frame
// rather than against itself, because the point of copying that layout is that
// one relay can carry Origami Remote and Flock without telling them apart. A
// drift here is silent until the day a relay forwards for both.
import { describe, expect, test } from "bun:test"
import { FlockEnvelope } from "@/flock/envelope"
import { FlockIdentity } from "@/flock/identity"

const pair = () => {
  const alice = FlockIdentity.generate("alice")
  const bob = FlockIdentity.generate("bob")
  const aliceKeys = FlockEnvelope.derive(
    FlockIdentity.pairSecret({ boxPrivateKey: alice.box.privateKey, peerBoxPublicKey: bob.boxPublicKey }),
  )
  const bobKeys = FlockEnvelope.derive(
    FlockIdentity.pairSecret({ boxPrivateKey: bob.box.privateKey, peerBoxPublicKey: alice.boxPublicKey }),
  )
  return { alice, bob, aliceKeys, bobKeys }
}

describe("the pair secret", () => {
  test("both sides derive the same key and rid, and a third party derives neither", () => {
    const { alice, bob, aliceKeys, bobKeys } = pair()
    expect(bobKeys.key.toString("base64")).toBe(aliceKeys.key.toString("base64"))
    expect(bobKeys.rid).toBe(aliceKeys.rid)

    const mallory = FlockIdentity.generate("mallory")
    const malloryKeys = FlockEnvelope.derive(
      FlockIdentity.pairSecret({ boxPrivateKey: mallory.box.privateKey, peerBoxPublicKey: bob.boxPublicKey }),
    )
    expect(malloryKeys.rid).not.toBe(aliceKeys.rid)
    expect(malloryKeys.key.toString("base64")).not.toBe(aliceKeys.key.toString("base64"))
    expect(alice.handle).not.toBe(bob.handle)
  })

  test("the key and the rid are different derivations of the same secret", () => {
    const { aliceKeys } = pair()
    // The rid is published to a relay. If it were the key, or derivable from
    // it, the relay would hold the friendship's secret.
    expect(aliceKeys.key.toString("base64url")).not.toContain(aliceKeys.rid)
    expect(aliceKeys.rid).not.toContain(aliceKeys.key.toString("base64url"))
  })
})

describe("the frame", () => {
  test("round-trips a payload between the two sides", () => {
    const { aliceKeys, bobKeys } = pair()
    const frame = FlockEnvelope.seal({
      keys: aliceKeys,
      role: FlockEnvelope.ROLE_ASK,
      seq: 1,
      payload: { type: "flock/ask", question: "what does the tax form cover?" },
    })
    const opened = FlockEnvelope.open({ keys: bobKeys, frame })
    expect(opened.role).toBe(FlockEnvelope.ROLE_ASK)
    expect(opened.seq).toBe(1)
    expect(opened.payload).toEqual({ type: "flock/ask", question: "what does the tax form cover?" })
  })

  test("lays its header out exactly as the shared wire spec draws it", () => {
    const { aliceKeys } = pair()
    const frame = Buffer.from(
      FlockEnvelope.seal({ keys: aliceKeys, role: FlockEnvelope.ROLE_ANSWER, seq: 70_000, payload: { a: 1 } }),
    )
    expect(frame.readUInt8(0)).toBe(1) // version
    expect(frame.readUInt8(1)).toBe(FlockEnvelope.ROLE_ANSWER) // role
    expect(frame.readUInt32BE(2)).toBe(70_000) // seq, uint32 BE — past 16 bits on purpose
    // 18-byte header, then ciphertext + a 16-byte GCM tag, and the plaintext is
    // padded to a 1,024 multiple so a short question and a long one look alike.
    expect((frame.length - 18 - 16) % 1024).toBe(0)
  })

  test("pads a short and a long payload to the same size until the pad rolls over", () => {
    const { aliceKeys } = pair()
    const short = FlockEnvelope.seal({ keys: aliceKeys, role: 1, seq: 1, payload: { q: "hi" } })
    const longer = FlockEnvelope.seal({ keys: aliceKeys, role: 1, seq: 2, payload: { q: "x".repeat(200) } })
    // The whole point of the padding: a relay watching frame sizes learns
    // nothing about the length of the question inside.
    expect(longer.length).toBe(short.length)
  })

  test("refuses a tampered ciphertext", () => {
    const { aliceKeys, bobKeys } = pair()
    const frame = Buffer.from(FlockEnvelope.seal({ keys: aliceKeys, role: 1, seq: 1, payload: { q: "hi" } }))
    frame[30] = frame[30]! ^ 0xff
    expect(() => FlockEnvelope.open({ keys: bobKeys, frame })).toThrow(/authentication failed/)
  })

  test("refuses a frame whose header was edited, because the header is authenticated", () => {
    const { aliceKeys, bobKeys } = pair()
    const frame = Buffer.from(FlockEnvelope.seal({ keys: aliceKeys, role: 1, seq: 1, payload: { q: "hi" } }))
    // A relay flipping ask to answer, or renumbering a sequence, is the attack
    // the AAD over bytes 0..5 exists to stop.
    frame.writeUInt8(FlockEnvelope.ROLE_ANSWER, 1)
    expect(() => FlockEnvelope.open({ keys: bobKeys, frame })).toThrow(/authentication failed/)
  })

  test("refuses a frame sealed to a different friendship", () => {
    const { aliceKeys } = pair()
    const other = pair()
    const frame = FlockEnvelope.seal({ keys: aliceKeys, role: 1, seq: 1, payload: { q: "hi" } })
    expect(() => FlockEnvelope.open({ keys: other.bobKeys, frame })).toThrow(/authentication failed/)
  })

  test("refuses an unknown version and a truncated frame", () => {
    const { aliceKeys, bobKeys } = pair()
    const frame = Buffer.from(FlockEnvelope.seal({ keys: aliceKeys, role: 1, seq: 1, payload: { q: "hi" } }))
    const bumped = Buffer.from(frame)
    bumped.writeUInt8(2, 0)
    expect(() => FlockEnvelope.open({ keys: bobKeys, frame: bumped })).toThrow(/unknown version/)
    expect(() => FlockEnvelope.open({ keys: bobKeys, frame: frame.subarray(0, 20) })).toThrow(/shorter than/)
  })

  test("refuses a replayed sequence before it spends a decrypt on it", () => {
    const { aliceKeys, bobKeys } = pair()
    const frame = FlockEnvelope.seal({ keys: aliceKeys, role: 1, seq: 5, payload: { q: "hi" } })
    expect(FlockEnvelope.open({ keys: bobKeys, frame, lastSeq: 4 }).seq).toBe(5)
    expect(() => FlockEnvelope.open({ keys: bobKeys, frame, lastSeq: 5 })).toThrow(/replayed sequence/)
    expect(() => FlockEnvelope.open({ keys: bobKeys, frame, lastSeq: 9 })).toThrow(/replayed sequence/)
  })
})

describe("the signature inside the frame", () => {
  test("verifies against the signer's key and nothing else", () => {
    const alice = FlockIdentity.generate("alice")
    const bob = FlockIdentity.generate("bob")
    const signed = FlockEnvelope.signPayload({ type: "flock/ask", question: "who?" }, alice.sign.privateKey)

    expect(FlockEnvelope.verifyPayload(signed, alice.signPublicKey)).toBe(true)
    // The case a seal alone cannot catch: a revoked friend who kept the pair
    // secret still cannot produce this.
    expect(FlockEnvelope.verifyPayload(signed, bob.signPublicKey)).toBe(false)
  })

  test("fails when any field was edited, and when the signature is missing or junk", () => {
    const alice = FlockIdentity.generate("alice")
    const signed = FlockEnvelope.signPayload({ type: "flock/ask", question: "who?" }, alice.sign.privateKey)

    expect(FlockEnvelope.verifyPayload({ ...signed, question: "something else" }, alice.signPublicKey)).toBe(false)
    expect(FlockEnvelope.verifyPayload({ ...signed, extra: 1 } as never, alice.signPublicKey)).toBe(false)
    expect(FlockEnvelope.verifyPayload({ ...signed, sig: undefined } as never, alice.signPublicKey)).toBe(false)
    expect(FlockEnvelope.verifyPayload({ ...signed, sig: "not base64 !!" }, alice.signPublicKey)).toBe(false)
    // A malformed KEY must return false, not throw: the caller is checking a
    // stranger's envelope and must not be crashable by one.
    expect(FlockEnvelope.verifyPayload(signed, "not-a-key")).toBe(false)
  })

  test("survives a JSON round trip that reorders the keys", () => {
    const alice = FlockIdentity.generate("alice")
    const signed = FlockEnvelope.signPayload({ b: 2, a: 1, nested: { z: 1, y: [3, { q: 1, p: 2 }] } }, alice.sign.privateKey)
    // What actually happens on the wire, and the reason `canonical` exists:
    // insertion order is not preserved by anything, so the bytes signed have to
    // be order-independent at every depth.
    const reordered = JSON.parse(JSON.stringify({ nested: signed.nested, sig: signed.sig, a: signed.a, b: signed.b }))
    expect(FlockEnvelope.verifyPayload(reordered, alice.signPublicKey)).toBe(true)
  })
})
