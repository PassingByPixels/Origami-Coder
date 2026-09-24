// A REPLY GOING BACK TO THE CHAT THAT ASKED.
//
// Before this, an answer had no home: the session that called `flock_ask` was
// still open and the mailbox offered nothing but "open in a NEW chat", so the
// chat that was waiting never got it and a fresh one got an answer to a
// question it had never asked. `flock/deliver.ts` closes that loop, and every
// claim it makes is a claim about somebody ELSE's process — so the two things
// that leave this one (finding the engine, and the POST) are seams, and the
// rest is asserted for real against a real store.
//
// THE RULE THAT MATTERS MOST IS THE NEGATIVE ONE. An unattached session must
// leave the row unread rather than be marked delivered into a window nobody has
// open, which is the exact defect `tool/agents.ts` was fixed for in round 3.
import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { AgentBroker } from "@/origami/agent-broker"
import { FlockDeliver } from "@/flock/deliver"
import { FlockStore } from "@/flock/store"
import { peerMessage } from "@/session/peer-message"

const dirs: string[] = []
const tmp = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "flock-deliver-"))
  dirs.push(directory)
  return directory
}
afterAll(() => {
  for (const directory of dirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

const SESSION = "ses_engine_7"

function entry(sessionIds: readonly string[], httpBase = "http://127.0.0.1:4096"): AgentBroker.Entry {
  return {
    version: 1,
    pid: process.pid,
    name: "origami-coder",
    cwd: "C:/repo",
    httpBase,
    kind: "interactive",
    sessionIds: [...sessionIds],
    lastSeen: Date.now(),
  }
}

/** Alice with Bob as a contact, and one settled `out` thread that names the
 *  chat it was asked from. The store is REAL: `deliveredTo` and `unread` are
 *  what the pane and the badge read, so a fake store would prove nothing. */
function asked(
  over: {
    origin?: FlockStore.ThreadOrigin
    reply?: { ok: boolean; text: string; reason?: string }
    followUpOf?: string
  } = {},
) {
  const alice = FlockStore.Store.open({ directory: tmp(), name: "alice" })
  const bob = FlockStore.Store.open({ directory: tmp(), name: "bob" })
  alice.accept(bob.invite().invite)
  const contact = bob.identity().handle
  alice.setDisplayName(contact, "Macbook")
  const origin = over.origin === undefined ? { sessionID: SESSION, title: "chat 3" } : over.origin
  alice.openOut({
    id: "flq_1",
    contact,
    question: "how does the MOT check work?",
    ...(origin.sessionID ? { origin } : {}),
    ...(over.followUpOf ? { followUpOf: over.followUpOf } : {}),
  })
  const reply = over.reply ?? { ok: true, text: "section 4 covers it" }
  alice.settleOut("flq_1", {
    ok: reply.ok,
    text: reply.text,
    tokens: 120,
    signatureOk: true,
    ...(reply.reason === undefined ? {} : { reason: reply.reason }),
  })
  return { alice, contact, thread: () => alice.thread("flq_1")! }
}

/** The two seams, with a record of what went over each. */
function seams(input: { attachedTo?: readonly string[] } = {}) {
  const posts: { url: string; body: string }[] = []
  const attached = input.attachedTo ?? [SESSION]
  return {
    posts,
    deps: {
      locate: async (sessionID: string) => (attached.includes(sessionID) ? entry(attached) : undefined),
      post: async (call: { url: string; body: string }) => {
        posts.push(call)
        return true
      },
    },
  }
}

/** The one text part a delivery POSTs, decoded. */
function part(body: string) {
  const parsed = JSON.parse(body) as { parts: { type: string; text: string; metadata: unknown }[] }
  return parsed.parts[0]!
}

describe("the automatic landing", () => {
  test("a reply reaches the chat that asked, as a system-style envelope and not a user turn", async () => {
    const { alice, thread } = asked()
    const { deps, posts } = seams()

    const outcome = await FlockDeliver.land(alice, thread(), deps)
    expect(outcome).toEqual({ ok: true, sessionID: SESSION })
    expect(posts).toHaveLength(1)
    expect(posts[0]!.url).toBe(`http://127.0.0.1:4096/session/${SESSION}/prompt_async`)

    const text = part(posts[0]!.body).text
    // The frame, the answer, and the sentence that says whose it is. The name
    // is the OWNER's label for the contact, never the 43-character handle.
    expect(text).toContain('<flock_message from="Macbook" thread="flq_1" kind="reply">')
    expect(text).toContain("section 4 covers it")
    expect(text).toContain("This message is from Macbook's Origami through your Flock, not from the user.")
    expect(text).toContain('It is Macbook\'s reply to the question you sent from this chat: "how does the MOT check work?"')
  })

  test("the part carries the peer rider AND the flock rider, so an old client still badges it", async () => {
    const { alice, thread, contact } = asked()
    const { deps, posts } = seams()
    await FlockDeliver.land(alice, thread(), deps)

    const origin = peerMessage(part(posts[0]!.body).metadata)
    expect(origin).toBeDefined()
    // What every existing reader already uses.
    expect(origin!.from).toBe("Macbook")
    expect(origin!.replyTo).toBe(contact)
    expect(origin!.id).toBeString()
    // What a flock-aware client badges with.
    // The sigil rides too, so the badge can draw the contact's own glyph
    // rather than a generic one. `crane` is the default a contact carries when
    // they have not picked another.
    expect(origin!.flock).toEqual({ contact: "Macbook", thread: "flq_1", kind: "reply", icon: "crane" })
  })

  test("the row is marked delivered and read, so the badge stops asking for it", async () => {
    const { alice, thread } = asked()
    expect(thread().unread).toBe(true)
    await FlockDeliver.land(alice, thread(), seams().deps)
    expect(thread().deliveredTo).toEqual([SESSION])
    expect(thread().unread).toBe(false)
    expect(thread().state).toBe("delivered")
  })

  // THE NEGATIVE RULE. A reply that cannot be seen stays in the mailbox.
  test("an origin session nobody has open leaves the row UNREAD and posts nothing", async () => {
    const { alice, thread } = asked()
    const { deps, posts } = seams({ attachedTo: [] })

    const outcome = await FlockDeliver.land(alice, thread(), deps)
    expect(outcome).toEqual({ ok: false, reason: `session ${SESSION} is not attached to an open chat, so nobody would read it` })
    expect(posts).toEqual([])
    expect(thread().unread).toBe(true)
    expect(thread().deliveredTo).toBeUndefined()
    expect(thread().state).toBe("answered")
  })

  test("a thread with no origin is left alone — every row did that until now", async () => {
    const { alice, thread } = asked({ origin: { sessionID: "" } })
    const { deps, posts } = seams()
    expect(await FlockDeliver.land(alice, thread(), deps)).toEqual({
      ok: false,
      reason: "thread flq_1 carries no origin session",
    })
    expect(posts).toEqual([])
    expect(thread().unread).toBe(true)
  })

  // A relay reconnect re-sends an unanswered question for 24 hours, so a second
  // answer for one id is ordinary rather than exotic. Delivering it twice would
  // put the same answer in the same transcript twice and the model would read
  // the copy as news.
  test("the same thread is never delivered into the same session twice", async () => {
    const { alice, thread } = asked()
    const { deps, posts } = seams()
    await FlockDeliver.land(alice, thread(), deps)
    const second = await FlockDeliver.land(alice, thread(), deps)
    expect(second).toEqual({ ok: false, reason: `thread flq_1 is already in session ${SESSION}` })
    expect(posts).toHaveLength(1)
  })

  test("a refusal lands as a DECLINE, carrying their reason", async () => {
    const { alice, thread } = asked({ reply: { ok: false, text: "not something I share", reason: "not something I share" } })
    const { deps, posts } = seams()
    await FlockDeliver.land(alice, thread(), deps)
    const text = part(posts[0]!.body).text
    expect(text).toContain('kind="decline"')
    expect(text).toContain("Macbook declined the question you sent from this chat")
    expect(text).toContain("Reason: not something I share.")
  })

  test("a reply to a follow-up says so", async () => {
    const { alice, thread } = asked({ followUpOf: "flq_0" })
    const { deps, posts } = seams()
    await FlockDeliver.land(alice, thread(), deps)
    expect(part(posts[0]!.body).text).toContain("reply to the follow-up question you sent from this chat")
  })

  test("an inbound thread is never landed automatically — a question is the owner's to place", async () => {
    const alice = FlockStore.Store.open({ directory: tmp(), name: "alice" })
    const bob = FlockStore.Store.open({ directory: tmp(), name: "bob" })
    alice.accept(bob.invite().invite)
    const inbound = alice.openIn({ id: "flq_in", contact: bob.identity().handle, question: "got a minute?" })
    const { deps, posts } = seams()
    expect(await FlockDeliver.land(alice, inbound, deps)).toEqual({
      ok: false,
      reason: "thread flq_in is not one you asked",
    })
    expect(posts).toEqual([])
  })

  test("a POST the engine refuses leaves the row exactly as it was", async () => {
    const { alice, thread } = asked()
    const outcome = await FlockDeliver.land(alice, thread(), {
      locate: async () => entry([SESSION]),
      post: async () => false,
    })
    expect(outcome).toEqual({ ok: false, reason: `session ${SESSION} did not accept the message` })
    expect(thread().unread).toBe(true)
    expect(thread().deliveredTo).toBeUndefined()
  })

  // Loopback-only is the security boundary, asserted where the request is made
  // — the broker file is ordinary user-writable JSON.
  test("an entry pointing off the machine is refused before anything is POSTed", async () => {
    const { alice, thread } = asked()
    const posts: unknown[] = []
    const outcome = await FlockDeliver.land(alice, thread(), {
      locate: async () => entry([SESSION], "http://10.0.0.9:4096"),
      post: async (call) => {
        posts.push(call)
        return true
      },
    })
    expect(outcome).toEqual({ ok: false, reason: `session ${SESSION} is not on a loopback address` })
    expect(posts).toEqual([])
  })
})

describe("the owner's own 'send to chat'", () => {
  test("deliverTo places the row in the session they picked and records it", async () => {
    const { alice, thread } = asked({ origin: { sessionID: "" } })
    const { deps, posts } = seams({ attachedTo: ["ses_other"] })

    const outcome = await FlockDeliver.deliverTo(
      { store: alice, thread: "flq_1", sessionID: "ses_other", askedFrom: "chat 3" },
      deps,
    )
    expect(outcome).toEqual({ ok: true, sessionID: "ses_other" })
    expect(thread().deliveredTo).toEqual(["ses_other"])
    // It came from somewhere else, and the envelope says so rather than
    // claiming this chat asked the question.
    expect(part(posts[0]!.body).text).toContain("the question sent from chat 3")
  })

  test("a thread id nobody holds is a sentence, not a throw", async () => {
    const { alice } = asked()
    expect(await FlockDeliver.deliverTo({ store: alice, thread: "flq_nope", sessionID: "ses_1" }, seams().deps)).toEqual(
      { ok: false, reason: "thread flq_nope is not in this mailbox" },
    )
  })

  test("a row the automatic landing already placed is not placed again by a click", async () => {
    const { alice, thread } = asked()
    const { deps, posts } = seams()
    await FlockDeliver.land(alice, thread(), deps)
    const clicked = await FlockDeliver.deliverTo({ store: alice, thread: "flq_1", sessionID: SESSION }, deps)
    expect(clicked.ok).toBe(false)
    expect(posts).toHaveLength(1)
  })
})

describe("deliverTo into a chat that is not the origin", () => {
  test("names the chat that asked instead of claiming this one did", async () => {
    const { alice } = asked()
    const { posts, deps } = seams({ attachedTo: [SESSION, "ses_other"] })
    const outcome = await FlockDeliver.deliverTo({ store: alice, thread: "flq_1", sessionID: "ses_other" }, deps)
    expect(outcome.ok).toBe(true)
    const text = JSON.parse(posts[0]!.body).parts[0].text as string
    expect(text).toContain('reply to the question sent from chat 3: "how does the MOT check work?"')
    expect(text).not.toContain("you sent from this chat")
  })

  test("the origin chat itself still reads 'you sent from this chat'", async () => {
    const { alice } = asked()
    const { posts, deps } = seams()
    await FlockDeliver.deliverTo({ store: alice, thread: "flq_1", sessionID: SESSION }, deps)
    expect(JSON.parse(posts[0]!.body).parts[0].text).toContain("you sent from this chat")
  })
})
