// THE MAILBOX: one thread per exchange, and nothing that blocks a turn.
//
// `peer.test.ts` proves the bytes and `frontdesk.test.ts` proves the decision.
// This file proves the SHAPE the owner works in: a question that is sent and
// returns at once, a question that arrives and waits for a person, an answer
// that lands as a row and touches no session, and a file that migrates from
// the two lists this replaced.
//
// TWO WHOLE ORIGAMIS OVER ONE LOOPBACK, as the peer tests do, because every
// claim here is about what the OTHER side sees: a decline with a reason is only
// a feature if the reason reaches the asker's row.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { FlockCard } from "@/flock/card"
import { FlockFrontDesk } from "@/flock/frontdesk"
import { FlockMailbox } from "@/flock/mailbox"
import { FlockPeer } from "@/flock/peer"
import { FlockPolicy } from "@/flock/policy"
import { FlockStore } from "@/flock/store"
import { FlockTransport } from "@/flock/transport"

const dirs: string[] = []
const tmp = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "flock-mail-"))
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

/** Poll rather than sleep a guessed duration: the frames cross in microtasks. */
async function until(label: string, check: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (check()) return
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`)
    await Bun.sleep(2)
  }
}

function card(store: FlockStore.Store): FlockPeer.Serve["card"] {
  return async () => {
    const identity = store.identity()
    return FlockCard.build({
      identity,
      specialties: [],
      policy: FlockPolicy.resolve({ config: { model: "test/fake" } }),
      signPrivateKey: identity.sign.privateKey,
    })
  }
}

/**
 * Alice asks; Bob's desk decides. Bob's `Serve` is the real `frontdesk.make`,
 * so "auto-answer off parks a row" is asserted through the code that ships and
 * not through a stub that agrees with it.
 */
function pair(input: { autoAnswer?: boolean; answer?: { text: string; tokens: number } } = {}) {
  const transport = new FlockTransport.LoopbackTransport()
  const alice = FlockStore.Store.open({ directory: tmp(), name: "alice" })
  const bob = FlockStore.Store.open({ directory: tmp(), name: "bob" })
  alice.accept(bob.invite().invite)
  bob.accept(alice.invite().invite, input.autoAnswer === undefined ? undefined : { autoAnswer: input.autoAnswer })

  const runner: FlockFrontDesk.Runner = async () => input.answer ?? { text: "the draft", tokens: 90 }
  const desk = FlockFrontDesk.make({ store: bob, config: { model: "test/fake" }, runner })
  const alicePeer = new FlockPeer.Peer(alice, transport)
  const bobPeer = new FlockPeer.Peer(bob, transport, { ask: desk.ask, card: card(bob) })
  peers.push(alicePeer, bobPeer)
  alicePeer.start()
  bobPeer.start()

  /** Bob's side of the mailbox, driven exactly as the pane drives it. */
  const bobDeps: FlockMailbox.Deps = {
    store: bob,
    config: { model: "test/fake" },
    runner,
    send: (frame) => bobPeer.reply(frame),
  }
  return { alice, bob, alicePeer, bobPeer, bobDeps, aliceHandle: alice.identity().handle, bobHandle: bob.identity().handle }
}

describe("flock_ask sends and returns", () => {
  test("the thread exists the moment post resolves, and no answer is waited for", async () => {
    const { alice, alicePeer, bobHandle } = pair()
    const started = Date.now()
    const sent = await alicePeer.post(bobHandle, "how does the tax refund work?")

    // The whole point: the caller is back with a receipt, not an answer. The
    // old `ask` sat here for up to sixty seconds.
    expect(Date.now() - started).toBeLessThan(2_000)
    const thread = alice.thread(sent.thread)
    expect(thread).toMatchObject({
      direction: "out",
      state: "sent",
      contact: bobHandle,
      unread: false,
    })
    expect(thread!.question.text).toBe("how does the tax refund work?")
    expect(thread!.reply).toBeUndefined()
  })

  test("a council is one thread per contact, not one broadcast", async () => {
    const { alice, alicePeer, bobHandle } = pair()
    const sent = await alicePeer.postMany([bobHandle, bobHandle], "same question")
    expect(sent.map((entry) => entry.contact)).toEqual([bobHandle, bobHandle])
    expect(new Set(sent.map((entry) => entry.thread)).size).toBe(2)
    expect(alice.mailbox().filter((thread) => thread.direction === "out")).toHaveLength(2)
  })

  test("a contact who is not in the flock gets a row-less error, not a thrown tool call", async () => {
    const { alicePeer } = pair()
    const sent = await alicePeer.postMany(["nobody@somewhere"], "?")
    expect(sent[0]!.thread).toBeUndefined()
    expect(sent[0]!.error).toContain("not in this flock")
  })
})

// THE CHAT THAT ASKED, recorded on the row and handed back when the answer
// lands. Everything past this point in the journey — finding that chat's
// engine, POSTing into it — is `deliver.test.ts`; what belongs here is that the
// mailbox carries the id at all and that the peer says when a row settles.
describe("a question remembers the chat it was asked from", () => {
  test("post files the origin, and a post without one files no origin at all", async () => {
    const { alice, alicePeer, bobHandle } = pair()
    const withOrigin = await alicePeer.post(bobHandle, "q1", undefined, { sessionID: "ses_7", title: "chat 3" })
    const without = await alicePeer.post(bobHandle, "q2")
    expect(alice.thread(withOrigin.thread)!.origin).toEqual({ sessionID: "ses_7", title: "chat 3" })
    expect(alice.thread(without.thread)!.origin).toBeUndefined()
  })

  test("a council gives every contact's thread the same origin", async () => {
    const { alice, alicePeer, bobHandle } = pair()
    const sent = await alicePeer.postMany([bobHandle, bobHandle], "same question", undefined, { sessionID: "ses_7" })
    for (const entry of sent) expect(alice.thread(entry.thread!)!.origin).toEqual({ sessionID: "ses_7" })
  })

  test("the peer announces a settled row, with the origin still on it", async () => {
    const { alice, alicePeer, bobHandle } = pair({ autoAnswer: true, answer: { text: "yes", tokens: 5 } })
    const landed: string[] = []
    alicePeer.onReplyLanded = (thread) => {
      // The hook is what `flock/service.ts` turns into a delivery. It must be
      // handed the row AFTER the store write, or the delivery would carry a
      // thread with no reply on it.
      expect(thread.reply?.text).toBe("yes")
      expect(thread.origin).toEqual({ sessionID: "ses_7" })
      landed.push(thread.id)
    }
    const sent = await alicePeer.post(bobHandle, "is it open?", undefined, { sessionID: "ses_7" })
    await until("the settled row", () => alice.thread(sent.thread)?.state === "answered")
    expect(landed).toEqual([sent.thread])
  })

  test("a file written before origins existed still loads, and its rows have none", () => {
    const directory = tmp()
    const store = FlockStore.Store.open({ directory, name: "alice" })
    const bob = FlockStore.Store.open({ directory: tmp(), name: "bob" })
    store.accept(bob.invite().invite)
    store.openOut({ id: "flq_old", contact: bob.identity().handle, question: "an old question" })
    // Re-read from disk: the field is optional on the way in as well as out.
    const reopened = FlockStore.Store.open({ directory })
    expect(reopened.thread("flq_old")).toMatchObject({ direction: "out", question: { text: "an old question" } })
    expect(reopened.thread("flq_old")!.origin).toBeUndefined()
  })
})

// A REFUSED DESK TURN. The toast the owner saw read "the front desk turn
// failed: APIError" — no model, no provider, no reason — and there was nothing
// in it to act on. Two things have to be true after it: the sentence names the
// model and repeats the provider's own words, and the row is usable again.
describe("when the front desk model refuses", () => {
  test("the failure names the model and carries the engine's own text", async () => {
    const { alicePeer, bobDeps, bobHandle } = pair()
    const sent = await alicePeer.post(bobHandle, "how does the tax refund work?")
    await until("bob's inbox row", () => bobDeps.store.thread(sent.thread) !== undefined)

    const refused = await FlockMailbox.decide(
      { ...bobDeps, runner: async () => { throw new Error("APIError: 429 rate limit exceeded") } },
      { thread: sent.thread, action: "answer" },
    )
    expect(refused.ok).toBe(false)
    const message = (refused as { message: string }).message
    expect(message).toContain("test/fake")
    expect(message).toContain("APIError: 429 rate limit exceeded")
  })

  test("the row goes back to PENDING and unread, so Answer works again", async () => {
    const { alicePeer, bob, bobDeps, bobHandle } = pair({ answer: { text: "second time lucky", tokens: 7 } })
    const sent = await alicePeer.post(bobHandle, "how does the tax refund work?")
    await until("bob's inbox row", () => bob.thread(sent.thread) !== undefined)

    await FlockMailbox.decide(
      { ...bobDeps, runner: async () => { throw new Error("APIError") } },
      { thread: sent.thread, action: "answer" },
    )
    // NOT stuck in `answering`: a row nobody can act on is the same question
    // lost, and the owner has no way to tell it apart from one still drafting.
    expect(bob.thread(sent.thread)).toMatchObject({ state: "pending", unread: true })

    // The retry is the same click, and it works.
    const retried = await FlockMailbox.decide(bobDeps, { thread: sent.thread, action: "answer" })
    expect(retried.ok).toBe(true)
    expect(bob.thread(sent.thread)).toMatchObject({ state: "answering" })
    expect(bob.thread(sent.thread)!.reply!.text).toBe("second time lucky")
  })

  test("a thrown non-Error still names the model rather than printing [object Object]", () => {
    expect(FlockMailbox.deskFailure("anthropic/claude-sonnet", { code: 500 })).toContain("anthropic/claude-sonnet")
    expect(FlockMailbox.deskFailure("anthropic/claude-sonnet", "")).toContain("no reason given")
  })
})

describe("an inbound question waits for the owner and then answers", () => {
  test("pending -> answering(draft) -> send -> answered, and the asker's row settles", async () => {
    const { alice, bob, alicePeer, bobDeps, bobHandle, aliceHandle } = pair({
      answer: { text: "section 4 covers it", tokens: 210 },
    })
    const sent = await alicePeer.post(bobHandle, "how does the tax refund work?")

    // BOB'S SIDE: a row waiting on a person, under the SAME id Alice holds.
    await until("bob's inbox row", () => bob.thread(sent.thread) !== undefined)
    expect(bob.thread(sent.thread)).toMatchObject({ direction: "in", state: "pending", contact: aliceHandle })
    // Nothing has gone back yet, so Alice is still `sent`.
    expect(alice.thread(sent.thread)!.state).toBe("sent")

    const decided = await FlockMailbox.decide(bobDeps, { thread: sent.thread, action: "answer" })
    expect(decided.ok).toBe(true)

    // A DRAFT, NOT A SEND. The row holds the answer and stays `answering`.
    const drafting = bob.thread(sent.thread)!
    expect(drafting.state).toBe("answering")
    expect(drafting.reply?.text).toBe("section 4 covers it")
    expect(alice.thread(sent.thread)!.state).toBe("sent")
    // The turn is paid for whether or not it is sent.
    expect(bob.spent(aliceHandle, FlockPolicy.day())).toBe(210)

    const posted = await FlockMailbox.send(bobDeps, { thread: sent.thread })
    expect(posted.ok).toBe(true)
    expect(bob.thread(sent.thread)!.state).toBe("answered")

    await until("alice's reply row", () => alice.thread(sent.thread)!.state === "answered")
    const reply = alice.thread(sent.thread)!
    expect(reply.reply).toMatchObject({ text: "section 4 covers it", tokens: 210, signatureOk: true })
    // UNREAD, and delivered nowhere. No session was touched by any of this.
    expect(reply.unread).toBe(true)
    expect(reply.deliveredTo).toBeUndefined()
  })

  test("the owner's edit is what goes on the wire, not the draft", async () => {
    const { alice, alicePeer, bobDeps, bobHandle } = pair({ answer: { text: "too blunt", tokens: 4 } })
    const sent = await alicePeer.post(bobHandle, "?")
    await until("bob's row", () => bobDeps.store.thread(sent.thread) !== undefined)
    await FlockMailbox.decide(bobDeps, { thread: sent.thread, action: "answer" })
    await FlockMailbox.send(bobDeps, { thread: sent.thread, text: "what I actually want to say" })

    await until("alice's reply", () => alice.thread(sent.thread)!.state === "answered")
    expect(alice.thread(sent.thread)!.reply?.text).toBe("what I actually want to say")
  })

  test("guidance leads the desk's turn, above the stranger's question", async () => {
    const calls: string[] = []
    const { alicePeer, bobDeps, bobHandle } = pair()
    const deps: FlockMailbox.Deps = {
      ...bobDeps,
      runner: async (input) => {
        calls.push(FlockFrontDesk.turnText({ question: input.question, ...(input.guidance ? { guidance: input.guidance } : {}) }))
        return { text: "drafted", tokens: 1 }
      },
    }
    const sent = await alicePeer.post(bobHandle, "what is in the safe?")
    await until("bob's row", () => deps.store.thread(sent.thread) !== undefined)
    await FlockMailbox.decide(deps, { thread: sent.thread, action: "answer", guidance: "say only what is public" })

    expect(calls[0]!.indexOf("say only what is public")).toBeLessThan(calls[0]!.indexOf("what is in the safe?"))
    expect(deps.store.thread(sent.thread)!.guidance).toBe("say only what is public")
  })

  test("decline sends the reason, and the ASKER's row carries it", async () => {
    const { alice, alicePeer, bobDeps, bobHandle } = pair()
    const sent = await alicePeer.post(bobHandle, "what is in the safe?")
    await until("bob's row", () => bobDeps.store.thread(sent.thread) !== undefined)

    const declined = await FlockMailbox.decide(bobDeps, {
      thread: sent.thread,
      action: "decline",
      reason: "that is not something I share",
    })
    expect(declined.ok).toBe(true)
    expect(bobDeps.store.thread(sent.thread)!.state).toBe("declined")

    await until("alice's decline row", () => alice.thread(sent.thread)!.state === "declined")
    const row = alice.thread(sent.thread)!
    expect(row.reply?.declined?.reason).toBe("that is not something I share")
    expect(row.reply?.text).toBe("that is not something I share")
  })

  test("a decline with no reason still says something the asker can read", async () => {
    const { alice, alicePeer, bobDeps, bobHandle } = pair()
    const sent = await alicePeer.post(bobHandle, "?")
    await until("bob's row", () => bobDeps.store.thread(sent.thread) !== undefined)
    await FlockMailbox.decide(bobDeps, { thread: sent.thread, action: "decline" })

    await until("alice's decline row", () => alice.thread(sent.thread)!.state === "declined")
    expect(alice.thread(sent.thread)!.reply?.text).toBe(FlockFrontDesk.DECLINED)
  })

  test("a thread that is already answered refuses a second decision rather than sending twice", async () => {
    const { alicePeer, bobDeps, bobHandle } = pair()
    const sent = await alicePeer.post(bobHandle, "?")
    await until("bob's row", () => bobDeps.store.thread(sent.thread) !== undefined)
    await FlockMailbox.decide(bobDeps, { thread: sent.thread, action: "decline" })

    const again = await FlockMailbox.decide(bobDeps, { thread: sent.thread, action: "answer" })
    expect(again).toEqual({ ok: false, message: `thread ${sent.thread} is declined, not pending or answering` })
  })

  test("sending an out thread is refused: an answer only ever goes back the way it came", async () => {
    const { alice, alicePeer, bobHandle } = pair()
    const sent = await alicePeer.post(bobHandle, "?")
    const deps: FlockMailbox.Deps = {
      store: alice,
      runner: async () => ({ text: "", tokens: 0 }),
      send: async () => {
        throw new Error("nothing should have been sent")
      },
    }
    const result = await FlockMailbox.send(deps, { thread: sent.thread })
    expect(result).toEqual({ ok: false, message: `thread ${sent.thread} is a question you asked, not one asked of you` })
  })
})

describe("the mailbox never blocks and never loses a row", () => {
  test("an answer arriving with no waiter is stored, and nothing throws", async () => {
    const { alice, bob, alicePeer, bobDeps, bobHandle } = pair()
    const sent = await alicePeer.post(bobHandle, "?")
    await until("bob's row", () => bob.thread(sent.thread) !== undefined)

    // The asking side has no in-flight request AT ALL under the new flow, which
    // is exactly the case that used to be "a late answer nobody is waiting on".
    let late: string | undefined
    alicePeer.onLateAnswer = (answer) => {
      late = answer.text
    }
    await FlockMailbox.decide(bobDeps, { thread: sent.thread, action: "answer" })
    await FlockMailbox.send(bobDeps, { thread: sent.thread })

    await until("the stored reply", () => alice.thread(sent.thread)!.state === "answered")
    expect(late).toBe("the draft")
    expect(alice.thread(sent.thread)!.reply?.text).toBe("the draft")
  })

  test("a sent thread expires after the retry window and stops being re-sent", () => {
    const store = FlockStore.Store.open({ directory: tmp(), name: "alice" })
    const bob = FlockStore.Store.open({ directory: tmp(), name: "bob" })
    const friend = store.accept(bob.invite().invite)
    const start = Date.parse("2026-09-02T00:00:00.000Z")
    store.openOut({ id: "q1", contact: friend.handle, question: "?" }, start)

    expect(store.pending(undefined, start + FlockStore.PENDING_TTL_MS - 1)).toHaveLength(1)
    expect(store.pending(undefined, start + FlockStore.PENDING_TTL_MS + 1)).toHaveLength(0)
    // Retired as a STATE, not deleted: the owner still sees that they asked and
    // that nobody ever answered.
    expect(store.thread("q1")!.state).toBe("expired")
  })

  test("the cap drops closed threads first, so a waiting question survives a busy hour", () => {
    const store = FlockStore.Store.open({ directory: tmp(), name: "alice" })
    const bob = FlockStore.Store.open({ directory: tmp(), name: "bob" })
    const friend = store.accept(bob.invite().invite)

    store.openIn({ id: "waiting", contact: friend.handle, question: "decide me" })
    for (let i = 0; i < FlockStore.MAILBOX_MAX + 20; i++) {
      store.openIn({ id: `done${i}`, contact: friend.handle, question: `q${i}` })
      store.settleIn({ id: `done${i}`, contact: friend.handle, ok: true, text: "ok", tokens: 1 })
    }

    expect(store.mailbox()).toHaveLength(FlockStore.MAILBOX_MAX)
    expect(store.thread("waiting")?.state).toBe("pending")
    // The oldest CLOSED rows went; the newest ones stayed.
    expect(store.thread("done0")).toBeUndefined()
    expect(store.thread(`done${FlockStore.MAILBOX_MAX + 19}`)).toBeDefined()
  })
})

describe("a file written before the mailbox", () => {
  test("its pending questions and its answered ids become threads, and the legacy keys go", () => {
    const directory = tmp()
    const seed = FlockStore.Store.open({ directory, name: "alice" })
    const bob = FlockStore.Store.open({ directory: tmp(), name: "bob" })
    const friend = seed.accept(bob.invite().invite)

    // Hand-written as an older build left it: the two lists this replaced.
    const file = path.join(directory, FlockStore.FILE)
    const data = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>
    fs.writeFileSync(
      file,
      JSON.stringify({
        ...data,
        pending: [
          {
            id: "old-out",
            handle: friend.handle,
            question: "still waiting",
            // Recent, so the migrated thread is inside the retry window: the
            // point of the fold is that a question in flight ACROSS the upgrade
            // is still re-sent, and one that had already timed out is not.
            at: new Date().toISOString(),
            expiresAt: Date.now() + 60_000,
          },
        ],
        answered: [
          { id: "old-in", from: friend.handle, ok: true, text: "already answered", tokens: 7, at: "2026-09-01T00:00:00.000Z" },
        ],
      }),
    )

    const reopened = FlockStore.Store.open({ directory })
    expect(reopened.thread("old-out")).toMatchObject({ direction: "out", state: "sent", contact: friend.handle })
    expect(reopened.thread("old-in")).toMatchObject({ direction: "in", state: "answered" })
    // The resend dedup still answers from the record, which is what the
    // `answered` ring existed for.
    expect(reopened.answeredFor("old-in")?.text).toBe("already answered")
    // And a question still in flight is still re-sendable.
    expect(reopened.pending()).toHaveLength(1)

    const onDisk = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>
    expect(onDisk["pending"]).toBeUndefined()
    expect(onDisk["answered"]).toBeUndefined()
    expect(Array.isArray(onDisk["mailbox"])).toBe(true)
  })

  test("a file already migrated is not rewritten again", () => {
    const directory = tmp()
    FlockStore.Store.open({ directory, name: "alice" })
    const file = path.join(directory, FlockStore.FILE)
    const before = fs.readFileSync(file, "utf8")
    FlockStore.Store.open({ directory })
    expect(fs.readFileSync(file, "utf8")).toBe(before)
  })
})
