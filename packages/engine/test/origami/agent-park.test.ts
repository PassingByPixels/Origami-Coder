// t-w2txb2: a PARKED chat stays addressable. The extension stops an idle
// chat's engine; before it does, `_elastic_park` leaves a stand-in file for
// each chat the engine published, so a peer message is kept in a mailbox and
// delivered when the chat's engine is started again.
//
// Real files under a scratch ORIGAMI_TEST_HOME, because the whole feature is a
// file protocol between processes that never run at the same time.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Agent } from "@/acp/agent"
import type * as ACPService from "@/acp/service"
import { AgentBroker } from "@/origami/agent-broker"
import { AgentMailbox } from "@/origami/agent-mailbox"
import { ElasticActivity } from "@/elastic/activity"

let home: string
const saved: Record<string, string | undefined> = {}
const KEYS = ["ORIGAMI_TEST_HOME", "ORIGAMI_AGENT_NAME", "ORIGAMI_CLIENT", "ORIGAMI_AGENT_PEERS", "ORIGAMI_AGENT_KIND"]

beforeEach(async () => {
  home = await fsp.mkdtemp(path.join(os.tmpdir(), "park-"))
  for (const key of KEYS) saved[key] = process.env[key]
  process.env.ORIGAMI_TEST_HOME = home
  process.env.ORIGAMI_AGENT_NAME = "sleeper"
  process.env.ORIGAMI_CLIENT = "acp"
  delete process.env.ORIGAMI_AGENT_PEERS
  delete process.env.ORIGAMI_AGENT_KIND
  AgentBroker.attachSessions(() => [])
})

afterEach(async () => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  await fsp.rm(home, { recursive: true, force: true })
})

const agentsDir = () => path.join(home, ".origami", "agents")
const standInFile = (id: string) => path.join(agentsDir(), "parked", `${id}.json`)
const mailboxDir = (id: string) => path.join(agentsDir(), "mailbox", id)
const exists = (file: string) =>
  fsp
    .stat(file)
    .then(() => true)
    .catch(() => false)

async function writeStandIn(input: { sessionId: string; hostPid: number; name?: string }) {
  const file = standInFile(input.sessionId)
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(
    file,
    JSON.stringify({
      version: 1,
      parked: true,
      name: input.name ?? "sleeper",
      cwd: "/work",
      kind: "interactive",
      sessionId: input.sessionId,
      hostPid: input.hostPid,
      parkedAt: Date.now(),
    }),
  )
}

describe("the folder names the extension mirrors", () => {
  test("are exported as relative names under agentsDir()", () => {
    expect(AgentBroker.PARKED_DIR).toBe("parked")
    expect(AgentBroker.MAILBOX_DIR).toBe("mailbox")
  })
})

describe("_elastic_park", () => {
  test("writes a stand-in for every published session and only those, and withdraws the live entry", async () => {
    AgentBroker.attachSessions(() => ["ses_a", "ses_b"])
    const broker = AgentBroker.start({ httpBase: "http://127.0.0.1:5555", cwd: "/work" })
    await AgentBroker.settled() // the queued heartbeat writes have landed
    expect(await exists(AgentBroker.entryPath(process.pid))).toBe(true)

    const result = await new Agent({} as unknown as ACPService.Interface).extMethod("_elastic_park", { hostPid: 4242 })

    expect(result).toEqual({ parked: true, sessionIds: ["ses_a", "ses_b"] })
    const names = (await fsp.readdir(path.join(agentsDir(), "parked"))).toSorted()
    expect(names).toEqual(["ses_a.json", "ses_b.json"])
    const written = JSON.parse(await fsp.readFile(standInFile("ses_a"), "utf8"))
    expect(written).toMatchObject({
      version: 1,
      parked: true,
      name: "sleeper",
      cwd: "/work",
      kind: "interactive",
      sessionId: "ses_a",
      hostPid: 4242,
    })
    expect(typeof written.parkedAt).toBe("number")
    // A live entry left behind would win every lookup and take a message into
    // an engine that is about to exit.
    await AgentBroker.settled() // the queued heartbeat writes have landed
    expect(await exists(AgentBroker.entryPath(process.pid))).toBe(false)
    await broker.stop()
  })

  test("hostPid defaults to the parent process", async () => {
    AgentBroker.attachSessions(() => ["ses_a"])
    const broker = AgentBroker.start({ httpBase: "http://127.0.0.1:5555", cwd: "/work" })
    await new Agent({} as unknown as ACPService.Interface).extMethod("elastic_park", {})
    expect(JSON.parse(await fsp.readFile(standInFile("ses_a"), "utf8")).hostPid).toBe(process.ppid)
    await broker.stop()
  })

  test("an engine that never registered writes nothing and answers an empty list", async () => {
    AgentBroker.attachSessions(() => ["ses_hidden"])
    const broker = AgentBroker.start({ httpBase: "http://127.0.0.1:5555", cwd: "/work", kind: "background" })

    const result = await new Agent({} as unknown as ACPService.Interface).extMethod("_elastic_park", {})

    expect(result).toEqual({ parked: true, sessionIds: [] })
    expect(await exists(path.join(agentsDir(), "parked"))).toBe(false)
    await broker.stop()
  })

  test("an engine with live work is not parked: nothing is written and the entry stays", async () => {
    // The atomic last check: an earlier idle report said parkable, then a
    // permission prompt opened. Stopping now would lose it.
    AgentBroker.attachSessions(() => ["ses_a"])
    const broker = AgentBroker.start({ httpBase: "http://127.0.0.1:5555", cwd: "/work" })
    const release = ElasticActivity.probe("permission-pending", () => new Set(["ses_a"]))
    try {
      const result = await new Agent({} as unknown as ACPService.Interface).extMethod("_elastic_park", {
        hostPid: 4242,
      })

      expect(result).toEqual({ parked: false, reasons: ["permission-pending"] })
      expect(await exists(path.join(agentsDir(), "parked"))).toBe(false)
      await AgentBroker.settled() // the queued heartbeat writes have landed
      expect(await exists(AgentBroker.entryPath(process.pid))).toBe(true)
    } finally {
      release()
      await broker.stop()
    }
  })

  test("a hostPid that is not a positive whole number is refused with invalid params", async () => {
    let code: number | undefined
    try {
      await new Agent({} as unknown as ACPService.Interface).extMethod("_elastic_park", { hostPid: "x" })
    } catch (error) {
      code = (error as { code?: number }).code
    }
    expect(code).toBe(-32602)
  })

  test("`allow` waives an armed cache warm (a finished Folds agent) and nothing else", async () => {
    // Owner decision: a finished Folds agent closes at completion; its cache warm
    // would keep the engine up for 80 % of the TTL for a chat nobody types in.
    AgentBroker.attachSessions(() => ["ses_a"])
    const broker = AgentBroker.start({ httpBase: "http://127.0.0.1:5555", cwd: "/work" })
    const { SessionCacheWarm } = await import("@/session/cache-warm")
    SessionCacheWarm.setClock({ setTimeout: () => ({ id: 1 }), clearTimeout: () => {} })
    SessionCacheWarm.armed({
      sessionID: "ses_a",
      model: { id: "claude", providerID: "anthropic", api: { npm: "@ai-sdk/anthropic", id: "claude" } } as never,
      options: {},
      messages: [],
      send: async () => {},
      env: {},
    })
    let asking = true
    const release = ElasticActivity.probe("question-pending", () => new Set(asking ? ["ses_a"] : []))
    try {
      const agent = new Agent({} as unknown as ACPService.Interface)
      // A question AND a warm: only the warm may be waived, and nothing else can be named.
      expect(await agent.extMethod("_elastic_park", { allow: ["warm-pending", "question-pending"] })).toEqual({
        parked: false,
        reasons: ["question-pending"],
      })
      asking = false
      expect(await agent.extMethod("_elastic_park", {})).toEqual({ parked: false, reasons: ["warm-pending"] })
      expect(await agent.extMethod("_elastic_park", { hostPid: 4242, allow: ["warm-pending"] })).toEqual({
        parked: true,
        sessionIds: ["ses_a"],
      })
    } finally {
      release()
      SessionCacheWarm.reset()
      await broker.stop()
    }
  })
})

describe("readParked", () => {
  test("keeps a stand-in whose host is alive, however old, and deletes one whose host is gone", async () => {
    const corpse = Bun.spawn({ cmd: [process.execPath, "-e", "0"], stdout: "ignore", stderr: "ignore" })
    await corpse.exited
    await writeStandIn({ sessionId: "ses_live", hostPid: process.pid })
    await writeStandIn({ sessionId: "ses_dead", hostPid: corpse.pid })

    // Hours later: a parked chat is not aged out by any clock.
    const found = await AgentBroker.readParked()

    expect(found.map((item) => item.sessionId)).toEqual(["ses_live"])
    expect(await exists(standInFile("ses_dead"))).toBe(false)
    expect(await exists(standInFile("ses_live"))).toBe(true)
  })

  test("a stand-in whose session id is not a safe file name is ignored", async () => {
    const file = path.join(agentsDir(), "parked", "evil.json")
    await fsp.mkdir(path.dirname(file), { recursive: true })
    await fsp.writeFile(
      file,
      JSON.stringify({
        version: 1,
        parked: true,
        name: "x",
        cwd: "/",
        kind: "interactive",
        sessionId: "../../x",
        hostPid: process.pid,
        parkedAt: 1,
      }),
    )
    expect(await AgentBroker.readParked()).toEqual([])
  })
})

describe("the mailbox", () => {
  test("drain admits each body in file order, deletes it only after admission, and keeps a failed one", async () => {
    await AgentMailbox.deposit("ses_x", JSON.stringify({ parts: [{ type: "text", text: "one" }] }), "m1")
    await Bun.sleep(5)
    await AgentMailbox.deposit("ses_x", JSON.stringify({ parts: [{ type: "text", text: "two" }] }), "m2")
    await Bun.sleep(5)
    await AgentMailbox.deposit("ses_x", JSON.stringify({ parts: [{ type: "text", text: "three" }] }), "m3")

    const admitted: string[] = []
    const first = await AgentMailbox.drain("ses_x", async (body) => {
      const text = (body.parts as { text: string }[])[0]!.text
      if (text === "two") throw new Error("engine said no")
      admitted.push(text)
    })

    expect(admitted).toEqual(["one", "three"])
    expect(first).toEqual({ admitted: 2, failed: 1 })
    const left = await fsp.readdir(mailboxDir("ses_x"))
    expect(left).toHaveLength(1)
    expect(left[0]).toEndWith("-m2.json")

    const second: string[] = []
    await AgentMailbox.drain("ses_x", async (body) => {
      second.push((body.parts as { text: string }[])[0]!.text)
    })
    expect(second).toEqual(["two"])
    expect(await fsp.readdir(mailboxDir("ses_x"))).toEqual([])
  })

  test("restore removes the stand-in before it drains", async () => {
    await writeStandIn({ sessionId: "ses_r", hostPid: process.pid })
    await AgentMailbox.deposit("ses_r", JSON.stringify({ parts: [] }))
    let standInAtAdmit: boolean | undefined
    const result = await AgentMailbox.restore(
      "ses_r",
      async () => {
        standInAtAdmit = await exists(standInFile("ses_r"))
      },
      { lateMs: 0 },
    )
    expect(result.admitted).toBe(1)
    expect(standInAtAdmit).toBe(false)
  })

  test("a message deposited just after restore drained is taken by the late pass", async () => {
    const admitted: unknown[] = []
    await AgentMailbox.restore("ses_late", async (body) => void admitted.push(body), { lateMs: 50 })
    // A sender that read the stand-in just before restore deleted it.
    await AgentMailbox.deposit("ses_late", JSON.stringify({ parts: [{ type: "text", text: "late" }] }))
    await Bun.sleep(150)
    expect(admitted).toHaveLength(1)
    expect(await fsp.readdir(mailboxDir("ses_late"))).toEqual([])
  })
})

// t-wdybz9 (review findings 1, 2, 6, 8, 10 + extension finding 3): park is
// two-phase and reversible. `_elastic_park` enters PARKING with no await after
// its idle check; `_elastic_unpark` makes the engine the live reader of its
// chats again and delivers what was kept while it was parked, once, in order.
describe("_elastic_unpark", () => {
  const agent = () => new Agent({} as unknown as ACPService.Interface)
  const texts = (bodies: Record<string, unknown>[]) => bodies.map((body) => (body.parts as { text: string }[])[0]!.text)
  const admitted: Array<{ sessionID: string; body: Record<string, unknown> }> = []
  beforeEach(() => {
    admitted.length = 0
    AgentMailbox.attachAdmitter((sessionID) => async (body) => void admitted.push({ sessionID, body }))
  })
  afterEach(() => AgentMailbox.attachAdmitter(undefined))

  test("the parking flag is set in the same tick as the idle check, before any file is written", async () => {
    AgentBroker.attachSessions(() => ["ses_a"])
    const broker = AgentBroker.start({ httpBase: "http://127.0.0.1:5555", cwd: "/work" })
    try {
      const pending = agent().extMethod("_elastic_park", { hostPid: 4242 })
      // No await between the call and this line: a prompt_async that lands now
      // must already see the engine as parking.
      expect(AgentBroker.parking()).toEqual(["ses_a"])
      await pending
      expect(AgentBroker.parking()).toEqual(["ses_a"])
    } finally {
      await agent().extMethod("_elastic_unpark", {})
      await broker.stop()
    }
  })

  test("a kept-up engine is live again: entry back, stand-ins gone, its own chat is POSTed to, not deposited", async () => {
    AgentBroker.attachSessions(() => ["ses_a", "ses_b"])
    const broker = AgentBroker.start({ httpBase: "http://127.0.0.1:5555", cwd: "/work" })
    try {
      await agent().extMethod("_elastic_park", { hostPid: process.pid })
      expect(AgentBroker.self()).toBeUndefined()

      const result = await agent().extMethod("_elastic_unpark", {})

      expect(result).toEqual({ unparked: true, delivered: 0 })
      expect(AgentBroker.parking()).toBeUndefined()
      await AgentBroker.settled()
      expect(await exists(AgentBroker.entryPath(process.pid))).toBe(true)
      expect(await exists(standInFile("ses_a"))).toBe(false)
      expect(await exists(standInFile("ses_b"))).toBe(false)
      // Review finding 1: this is the call that deposited into a mailbox nobody reads.
      const { AgentPost } = await import("@/session/agent-post")
      const posted: string[] = []
      const sent = await AgentPost.send(
        { sessionID: "ses_a", body: "{}" },
        { post: async ({ url }) => (posted.push(url), true) },
      )
      expect(sent).toEqual({ ok: true, parked: false })
      expect(posted).toEqual(["http://127.0.0.1:5555/session/ses_a/prompt_async"])
    } finally {
      await broker.stop()
    }
  })

  test("mail kept while parked is delivered in order, exactly once, and a second unpark delivers nothing", async () => {
    AgentBroker.attachSessions(() => ["ses_a"])
    const broker = AgentBroker.start({ httpBase: "http://127.0.0.1:5555", cwd: "/work" })
    try {
      await agent().extMethod("_elastic_park", { hostPid: process.pid })
      await AgentMailbox.deposit("ses_a", JSON.stringify({ parts: [{ type: "text", text: "one" }] }), "m1")
      await Bun.sleep(5)
      await AgentMailbox.deposit("ses_a", JSON.stringify({ parts: [{ type: "text", text: "two" }] }), "m2")

      expect(await agent().extMethod("_elastic_unpark", {})).toEqual({ unparked: true, delivered: 2 })
      expect(admitted.map((item) => item.sessionID)).toEqual(["ses_a", "ses_a"])
      expect(texts(admitted.map((item) => item.body))).toEqual(["one", "two"])
      expect(await fsp.readdir(mailboxDir("ses_a"))).toEqual([])

      expect(await agent().extMethod("_elastic_unpark", {})).toEqual({ unparked: true, delivered: 0 })
      expect(admitted).toHaveLength(2)
    } finally {
      await broker.stop()
    }
  })

  test("a park call while already parked answers the same sessions and writes nothing new", async () => {
    AgentBroker.attachSessions(() => ["ses_a"])
    const broker = AgentBroker.start({ httpBase: "http://127.0.0.1:5555", cwd: "/work" })
    try {
      expect(await agent().extMethod("_elastic_park", { hostPid: 4242 })).toEqual({
        parked: true,
        sessionIds: ["ses_a"],
      })
      expect(await agent().extMethod("_elastic_park", { hostPid: 4242 })).toEqual({
        parked: true,
        sessionIds: ["ses_a"],
      })
    } finally {
      await agent().extMethod("_elastic_unpark", {})
      await broker.stop()
    }
  })

  test("a park that fails part way leaves no stand-in, keeps the engine live and reports the failure", async () => {
    // Review finding 8: one stand-in cannot be written (a folder sits where
    // its file goes). The other one used to stay behind for a live engine.
    AgentBroker.attachSessions(() => ["ses_a", "ses_b"])
    const broker = AgentBroker.start({ httpBase: "http://127.0.0.1:5555", cwd: "/work" })
    await fsp.mkdir(path.join(standInFile("ses_b"), "blocker"), { recursive: true })
    try {
      let failed = false
      await agent()
        .extMethod("_elastic_park", { hostPid: process.pid })
        .catch(() => (failed = true))
      expect(failed).toBe(true)
      expect(await exists(standInFile("ses_a"))).toBe(false)
      expect(AgentBroker.parking()).toBeUndefined()
      expect(AgentBroker.self()?.sessionIds).toEqual(["ses_a", "ses_b"])
      await AgentBroker.settled()
      expect(await exists(AgentBroker.entryPath(process.pid))).toBe(true)
    } finally {
      await broker.stop()
    }
  })
})

describe("the mailbox, under two readers and a closed chat", () => {
  test("two drains at once admit each body exactly once", async () => {
    // Review finding 10's class: an admitted body that is still on disk is
    // admitted again by the next reader (the late drain, an unpark, a restore).
    for (const [i, text] of ["one", "two", "three"].entries()) {
      await AgentMailbox.deposit("ses_d", JSON.stringify({ parts: [{ type: "text", text }] }), `m${i}`)
      await Bun.sleep(3)
    }
    const seen: string[] = []
    const admit = async (body: Record<string, unknown>) => {
      await Bun.sleep(5)
      seen.push((body.parts as { text: string }[])[0]!.text)
    }
    const [a, b] = await Promise.all([AgentMailbox.drain("ses_d", admit), AgentMailbox.drain("ses_d", admit)])
    expect(seen.toSorted()).toEqual(["one", "three", "two"])
    expect(a.admitted + b.admitted).toBe(3)
    expect(await fsp.readdir(mailboxDir("ses_d"))).toEqual([])
  })

  test("a body admitted but not deleted (its claim stays) is never admitted again, and sweep removes it later", async () => {
    // Review finding 10: Windows can refuse the delete (antivirus holds the
    // file). The body is on disk, but the next restore, hours later in a new
    // process, must not start that turn a second time.
    const file = await AgentMailbox.deposit("ses_c", JSON.stringify({ parts: [{ type: "text", text: "x" }] }), "m1")
    await fsp.writeFile(file + AgentMailbox.CLAIM, "4242")
    const admitted: unknown[] = []

    const result = await AgentMailbox.drain("ses_c", async (body) => void admitted.push(body))

    expect(result).toEqual({ admitted: 0, failed: 0 })
    expect(admitted).toEqual([])
    const later = Date.now() + AgentMailbox.CLAIM_STALE_MS + 60_000
    expect((await AgentMailbox.sweep({ now: later })).removed).toBe(1)
    expect(await exists(file)).toBe(false)
    expect(await exists(file + AgentMailbox.CLAIM)).toBe(false)
  })

  test("a message for a chat that was closed while the sender wrote it is taken back and refused", async () => {
    // Review finding 6: the stand-in was there when the sender looked, and gone
    // (the chat closed) by the time the body was on disk.
    await writeStandIn({ sessionId: "ses_closed", hostPid: process.pid })
    const { AgentPost } = await import("@/session/agent-post")
    let looks = 0
    const sent = await AgentPost.send(
      { sessionID: "ses_closed", body: JSON.stringify({ parts: [] }) },
      {
        locate: async () => undefined,
        parked: async () => {
          looks++
          if (looks === 1) return (await AgentBroker.readParked()).find((item) => item.sessionId === "ses_closed")
          await AgentBroker.removeParked("ses_closed")
          return undefined
        },
      },
    )
    expect(sent).toEqual({ ok: false, reason: "unattached" })
    expect(await fsp.readdir(mailboxDir("ses_closed")).catch(() => [])).toEqual([])
  })

  test("sweep disposes of old mail no parked or live chat will read, and keeps the rest", async () => {
    const day = 24 * 60 * 60_000
    const now = Date.now()
    const put = async (id: string, at: number) => {
      await fsp.mkdir(mailboxDir(id), { recursive: true })
      await fsp.writeFile(path.join(mailboxDir(id), `${at}-m.json`), JSON.stringify({ parts: [] }))
    }
    await put("ses_orphan_old", now - 8 * day) // closed while parked, a week ago
    await put("ses_orphan_new", now - 60_000) // may still be loaded (a window reload)
    await put("ses_parked_old", now - 8 * day) // its host still runs: it will be woken
    await writeStandIn({ sessionId: "ses_parked_old", hostPid: process.pid })

    const result = await AgentMailbox.sweep({ now })

    expect(result.removed).toBe(1)
    expect(await exists(mailboxDir("ses_orphan_old"))).toBe(false)
    expect(await fsp.readdir(mailboxDir("ses_orphan_new"))).toHaveLength(1)
    expect(await fsp.readdir(mailboxDir("ses_parked_old"))).toHaveLength(1)
  })
})
