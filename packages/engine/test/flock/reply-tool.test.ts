// ANSWERING A CONTACT FROM A CHAT — the other end of the delivered question.
//
// `flock_decide` + `flock_send` are the owner's two clicks in the Front Desk
// pane, and they run a caged child session that drafts. This is the route the
// owner asked for instead: the question is put into a real chat by
// `flock/deliver.ts`, the model asks the person what to do, and when they say
// answer, `flock_reply` is what puts it on the wire.
//
// TWO WHOLE ORIGAMIS over one loopback, as `mailbox.test.ts` does, because the
// claim worth making is not "the tool called something" — it is that the ASKER
// reads the answer on their own row, signed.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { FlockPeer } from "@/flock/peer"
import { FlockStore } from "@/flock/store"
import { FlockReplyTool, reply } from "@/tool/flock"
import { FlockTransport } from "@/flock/transport"

const dirs: string[] = []
const tmp = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "flock-reply-"))
  dirs.push(directory)
  return directory
}
afterAll(() => {
  for (const directory of dirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

const peers: FlockPeer.Peer[] = []
afterEach(() => {
  for (const peer of peers.splice(0)) peer.stop()
})

async function until(label: string, check: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (check()) return
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`)
    await Bun.sleep(2)
  }
}

/** Alice asks; Bob has NO front desk runner at all — the whole point of this
 *  route is that a person in a chat answers instead of a caged child session. */
function pair() {
  const transport = new FlockTransport.LoopbackTransport()
  const alice = FlockStore.Store.open({ directory: tmp(), name: "alice" })
  const bob = FlockStore.Store.open({ directory: tmp(), name: "bob" })
  alice.accept(bob.invite().invite)
  bob.accept(alice.invite().invite)

  const alicePeer = new FlockPeer.Peer(alice, transport)
  // A `Serve` that only files the row: no model, no draft, no auto-answer.
  const bobPeer = new FlockPeer.Peer(bob, transport, {
    ask: async ({ id, question }) => {
      bob.openIn({ id, contact: alice.identity().handle, question })
      return { deferred: true as const }
    },
    card: async () => {
      throw new Error("no card in this test")
    },
  })
  peers.push(alicePeer, bobPeer)
  alicePeer.start()
  bobPeer.start()
  return { alice, bob, alicePeer, bobPeer, bobHandle: bob.identity().handle }
}

describe("flock_reply", () => {
  test("is defined under the id the envelope tells the model to call", () => {
    expect(FlockReplyTool.id).toBe("flock_reply")
  })

  test("signs the answer onto the thread and the ASKER's row settles to answered", async () => {
    const { alice, bob, alicePeer, bobPeer, bobHandle } = pair()
    const sent = await alicePeer.post(bobHandle, "how does the tax refund work?")
    await until("bob's inbox row", () => bob.thread(sent.thread) !== undefined)

    const result = await reply(sent.thread, "  section 4 covers it  ", (frame) => bobPeer.reply(frame))

    expect(result.metadata).toEqual({ thread: sent.thread, sent: true })
    // The model is told it is done and told to stop, because there is nothing
    // to wait for: anything they say back lands in the mailbox, not here.
    expect(result.output).toContain("The answer is signed and on its way to them")
    expect(result.output).toContain("never in this chat")

    // BOB's row is closed...
    expect(bob.thread(sent.thread)!.state).toBe("answered")
    // ...and ALICE has the answer, trimmed, verified.
    await until("alice's settled row", () => alice.thread(sent.thread)?.state === "answered")
    expect(alice.thread(sent.thread)!.reply).toMatchObject({ text: "section 4 covers it", signatureOk: true })
  })

  test("an empty answer is refused and NOTHING goes on the wire", async () => {
    const calls: unknown[] = []
    const result = await reply("flq_1", "   ", async (frame) => void calls.push(frame))
    expect(calls).toEqual([])
    expect(result.metadata).toEqual({ thread: "flq_1", sent: false })
    expect(result.output).toContain("an answer with no text is not an answer")
  })

  // The holder validates the thread, and its sentence names the thread, the
  // state it is really in, or the contact who has since been revoked. Rewriting
  // it here would drop the only part the model can act on.
  test("a thread the holder refuses comes back as the holder's own sentence", async () => {
    const { bobPeer } = pair()
    // A thread id the model invented, or one that has aged out of the mailbox.
    const result = await reply("flq_invented", "here you go", (frame) => bobPeer.reply(frame))
    expect(result.metadata).toEqual({ thread: "flq_invented", sent: false })
    expect(result.output).toContain("The answer did NOT go out:")
    expect(result.output).toContain("flq_invented is not an inbound thread")
  })
})
