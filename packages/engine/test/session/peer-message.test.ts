import { beforeEach, describe, expect, test } from "bun:test"
import {
  claimPeerMessage,
  duplicatePeerPrompt,
  peerMessage,
  peerMessageId,
  peerMessageMetadata,
  resetPeerMessages,
  PEER_DEDUPE_WINDOW_MS,
} from "../../src/session/peer-message"

// The idempotency half of t-kgu05m. Round-3 UAT had the same probe arrive and be
// re-sent repeatedly, so both ends of a handoff need to be able to recognise a
// message they have already handled. The id is the shared vocabulary for that,
// which is why it is derived here rather than minted at random.

beforeEach(() => {
  resetPeerMessages()
})

describe("the id", () => {
  test("is the same message twice, and a different message once", () => {
    const base = { from: "a#ses_1", to: "b#ses_2", text: "schema is frozen" }

    expect(peerMessageId(base)).toBe(peerMessageId({ ...base }))
    expect(peerMessageId(base)).not.toBe(peerMessageId({ ...base, text: "schema is frozen." }))
    expect(peerMessageId(base)).not.toBe(peerMessageId({ ...base, to: "b#ses_3" }))
    expect(peerMessageId(base)).not.toBe(peerMessageId({ ...base, from: "a#ses_9" }))
  })

  test("survives the metadata round trip the wire actually uses", () => {
    const id = peerMessageId({ from: "a#ses_1", to: "b#ses_2", text: "hi" })
    const decoded = peerMessage(JSON.parse(JSON.stringify(peerMessageMetadata({ from: "a", replyTo: "a#ses_1", id }))))

    expect(decoded).toEqual({ from: "a", replyTo: "a#ses_1", id })
  })

  test("a rider written before ids existed still reads as a peer message", () => {
    // Fail-closed applies to the PROVENANCE, not to the id: dropping the badge
    // because an id is missing would render another agent's words as the user's.
    expect(peerMessage(peerMessageMetadata({ from: "a", replyTo: "a#ses_1" }))).toEqual({
      from: "a",
      replyTo: "a#ses_1",
    })
    expect(peerMessage({ origami_peer: { from: "a", replyTo: "a#ses_1", id: 7 } })?.id).toBeUndefined()
  })
})

describe("the delivered ledger", () => {
  test("the first claim wins and the second is refused", () => {
    expect(claimPeerMessage("ses_1", "abc")).toBe(true)
    expect(claimPeerMessage("ses_1", "abc")).toBe(false)
  })

  test("a claim is per SESSION — two chats each get the message once", () => {
    expect(claimPeerMessage("ses_1", "abc")).toBe(true)
    expect(claimPeerMessage("ses_2", "abc")).toBe(true)
  })

  test("the window expires, so an identical line is news again eventually", () => {
    const at = Date.now()
    expect(claimPeerMessage("ses_1", "abc", at)).toBe(true)
    expect(claimPeerMessage("ses_1", "abc", at + PEER_DEDUPE_WINDOW_MS)).toBe(false)
    expect(claimPeerMessage("ses_1", "abc", at + PEER_DEDUPE_WINDOW_MS + 1)).toBe(true)
  })
})

describe("the receiving injection path", () => {
  const peerPart = (id: string) => ({ metadata: peerMessageMetadata({ from: "a", replyTo: "a#ses_1", id }) })

  test("injects an id once and drops the repeat", () => {
    expect(duplicatePeerPrompt("ses_target", [peerPart("id-1")])).toBe(false)
    expect(duplicatePeerPrompt("ses_target", [peerPart("id-1")])).toBe(true)
    expect(duplicatePeerPrompt("ses_target", [peerPart("id-2")])).toBe(false)
  })

  test("an ordinary human turn is never a duplicate, however often it repeats", () => {
    // The guard is scoped to what this feature put on the wire. A person typing
    // "ok" twice must not have the second one swallowed.
    expect(duplicatePeerPrompt("ses_target", [{ metadata: undefined }, { metadata: { other: true } }])).toBe(false)
    expect(duplicatePeerPrompt("ses_target", [{ metadata: undefined }])).toBe(false)
    expect(duplicatePeerPrompt("ses_target", [])).toBe(false)
  })

  test("a prompt that is dropped claims nothing — the ledger cannot record what nobody saw", () => {
    expect(duplicatePeerPrompt("ses_target", [peerPart("seen")])).toBe(false)
    // Second part is the repeat, so the WHOLE prompt is dropped; the fresh id
    // in it must therefore still be deliverable on its own.
    expect(duplicatePeerPrompt("ses_target", [peerPart("fresh"), peerPart("seen")])).toBe(true)
    expect(duplicatePeerPrompt("ses_target", [peerPart("fresh")])).toBe(false)
  })
})
