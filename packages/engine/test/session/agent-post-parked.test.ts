// t-w2txb2: the senders that go through `session/agent-post.ts` (a Flock reply,
// a sub-agent's question) reach a PARKED chat the same way send_message does:
// the prompt_async body is kept in the chat's mailbox, and the delivery counts.
//
// The live locator is stubbed to "no engine holds it", because that is the
// state a parked chat is in. The stand-in and the mailbox are real files under
// a scratch ORIGAMI_TEST_HOME.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { FlockDeliver } from "@/flock/deliver"
import { FlockStore } from "@/flock/store"
import { SubagentQuestion } from "@/session/subagent-question"

let home: string
let previousHome: string | undefined
const dirs: string[] = []

beforeEach(async () => {
  home = await fsp.mkdtemp(path.join(os.tmpdir(), "post-parked-"))
  previousHome = process.env.ORIGAMI_TEST_HOME
  process.env.ORIGAMI_TEST_HOME = home
})
afterEach(async () => {
  if (previousHome === undefined) delete process.env.ORIGAMI_TEST_HOME
  else process.env.ORIGAMI_TEST_HOME = previousHome
  await fsp.rm(home, { recursive: true, force: true })
})
afterAll(() => {
  for (const directory of dirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

async function park(sessionId: string) {
  const file = path.join(home, ".origami", "agents", "parked", `${sessionId}.json`)
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(
    file,
    JSON.stringify({
      version: 1,
      parked: true,
      name: "origami-coder",
      cwd: "/work",
      kind: "interactive",
      sessionId,
      hostPid: process.pid,
      parkedAt: Date.now(),
    }),
  )
}

async function mailbox(sessionId: string): Promise<Array<{ parts: Array<{ text: string }> }>> {
  const dir = path.join(home, ".origami", "agents", "mailbox", sessionId)
  const names = await fsp.readdir(dir).catch(() => [] as string[])
  return Promise.all(names.map(async (name) => JSON.parse(await fsp.readFile(path.join(dir, name), "utf8"))))
}

const nobodyLive = {
  locate: async () => undefined,
  post: async () => {
    throw new Error("a parked chat must not be POSTed to")
  },
}

describe("Flock reply into a parked chat", () => {
  test("is deposited in the chat's mailbox and the row is marked delivered", async () => {
    const tmp = () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "flock-parked-"))
      dirs.push(directory)
      return directory
    }
    const alice = FlockStore.Store.open({ directory: tmp(), name: "alice" })
    const bob = FlockStore.Store.open({ directory: tmp(), name: "bob" })
    alice.accept(bob.invite().invite)
    const contact = bob.identity().handle
    alice.openOut({
      id: "flq_1",
      contact,
      question: "which store?",
      origin: { sessionID: "ses_asleep", title: "chat" },
    })
    alice.settleOut("flq_1", { ok: true, text: "SQLite", tokens: 10, signatureOk: true })
    await park("ses_asleep")

    const outcome = await FlockDeliver.land(alice, alice.thread("flq_1")!, nobodyLive)

    expect(outcome).toEqual({ ok: true, sessionID: "ses_asleep" })
    const kept = await mailbox("ses_asleep")
    expect(kept).toHaveLength(1)
    expect(kept[0]!.parts[0]!.text).toBe(FlockDeliver.textFor(alice, alice.thread("flq_1")!))
    expect(alice.thread("flq_1")!.deliveredTo).toEqual(["ses_asleep"])
  })

  test("with no stand-in either, it is still refused and nothing is kept", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flock-parked-"))
    dirs.push(tmp)
    const alice = FlockStore.Store.open({ directory: tmp, name: "alice" })
    const bobDir = fs.mkdtempSync(path.join(os.tmpdir(), "flock-parked-"))
    dirs.push(bobDir)
    const bob = FlockStore.Store.open({ directory: bobDir, name: "bob" })
    alice.accept(bob.invite().invite)
    alice.openOut({
      id: "flq_2",
      contact: bob.identity().handle,
      question: "q",
      origin: { sessionID: "ses_gone", title: "c" },
    })
    alice.settleOut("flq_2", { ok: true, text: "a", tokens: 1, signatureOk: true })

    const outcome = await FlockDeliver.land(alice, alice.thread("flq_2")!, nobodyLive)

    expect(outcome.ok).toBe(false)
    expect(await mailbox("ses_gone")).toEqual([])
  })
})

describe("a sub-agent's question to a parked parent chat", () => {
  test("is deposited in the parent's mailbox and counts as delivered", async () => {
    await park("ses_parent")
    const input: SubagentQuestion.DeliverInput = {
      label: "Explore · T1 · look",
      sessionID: "ses_child",
      requestID: "que_1",
      questions: [{ question: "Which store?" }],
      ancestors: ["ses_parent"],
    }

    const outcome = await SubagentQuestion.deliver(input, nobodyLive)

    expect(outcome).toEqual({ ok: true, sessionID: "ses_parent" })
    const kept = await mailbox("ses_parent")
    expect(kept).toHaveLength(1)
    expect(kept[0]!.parts[0]!.text).toBe(SubagentQuestion.renderSubagentQuestion(input))
  })
})

// t-wdybz9 (review finding 2, second half): the sender read the live entry,
// then the engine parked and exited before the POST landed. The stand-in it
// left is the chat's address now; the message goes there instead of failing.
describe("a POST that fails because the chat parked in between", () => {
  const entry = {
    version: 1 as const,
    pid: 1,
    name: "origami-coder",
    cwd: "/work",
    httpBase: "http://127.0.0.1:9",
    kind: "interactive" as const,
    sessionIds: ["ses_moving"],
    lastSeen: Date.now(),
  }

  test("is kept in the stand-in's mailbox and counts as delivered", async () => {
    await park("ses_moving")
    const { AgentPost } = await import("@/session/agent-post")
    const body = JSON.stringify({ parts: [{ type: "text", text: "late" }] })

    const sent = await AgentPost.send(
      { sessionID: "ses_moving", body },
      { locate: async () => entry, post: async () => false },
    )

    expect(sent).toEqual({ ok: true, parked: true })
    expect((await mailbox("ses_moving")).map((item) => item.parts[0]!.text)).toEqual(["late"])
  })

  test("with no stand-in it is still a rejection, and nothing is kept", async () => {
    const { AgentPost } = await import("@/session/agent-post")
    const sent = await AgentPost.send(
      { sessionID: "ses_moving", body: "{}" },
      { locate: async () => entry, post: async () => false },
    )
    expect(sent).toEqual({ ok: false, reason: "rejected" })
    expect(await mailbox("ses_moving")).toEqual([])
  })
})
