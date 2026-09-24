// t-ucnjwp (lazy loading L4): the pure half of the bounded restore.
//
// The M5 check lives here: the newest-first page walk must give the SAME
// model/variant/mode as today's `restoreFromMessages` over the whole chat, for
// every shape of chat, including one whose newest page has no user message with
// a model. Fixtures carry the fields `restoreFromMessages` reads, in the stored
// message shape (`info.model` on a user row, `providerID`/`modelID` on an
// assistant row: session/message-v2.ts).
import { describe, expect, it } from "bun:test"
import type { SessionMessageResponse } from "@origami/sdk/v2"
import { ACPHistory } from "@/acp/history"
import { MessageV2 } from "@/session/message-v2"
import { MessageID } from "@/session/schema"
import { ProviderV2 } from "@origami/core/provider"
import { ModelV2 } from "@origami/core/model"

/** The branded ids the restore answers with, for `toEqual`. */
const modelOf = (providerID: string, modelID: string) => ({
  providerID: ProviderV2.ID.make(providerID),
  modelID: ModelV2.ID.make(modelID),
})

type Info = Record<string, unknown>

function message(index: number, info: Info, parts: unknown[] = []): SessionMessageResponse {
  return {
    info: { id: `msg_${String(index).padStart(6, "0")}`, sessionID: "ses_chat", time: { created: 1_000 + index }, ...info },
    parts,
  } as unknown as SessionMessageResponse
}

const models = ["a", "b", "c"]
const variants = [undefined, "low", "high"]
const agents = [undefined, "build", "plan"]

/** Deterministic pseudo-random chat, so a failure names a seed that reproduces it. */
function chat(seed: number, length: number): SessionMessageResponse[] {
  let state = seed
  const next = (n: number) => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
    return state % n
  }
  return Array.from({ length }, (_, index) => {
    const kind = next(5)
    const modelID = models[next(models.length)]
    const variant = variants[next(variants.length)]
    const agent = agents[next(agents.length)]
    if (kind === 0) return message(index, { role: "user", model: { providerID: "p", modelID, variant }, agent })
    if (kind === 1) return message(index, { role: "user", agent }) // a user row with NO model (peer message)
    if (kind === 2) return message(index, { role: "assistant", providerID: "p", modelID, variant, mode: agent })
    if (kind === 3) return message(index, { role: "assistant", providerID: "p", modelID, variant, agent })
    return message(index, { role: "assistant" }) // an assistant row with no model fields
  })
}

/** The walk as the service drives it: newest page first, one `limit + 1` read per page. */
function walk(all: SessionMessageResponse[], limit = ACPHistory.PAGE_SIZE) {
  const read = (before: string | null) => {
    const bound = before ? MessageV2.cursor.decode(before) : undefined
    const rows = bound ? all.filter((row) => (row.info as { time: { created: number } }).time.created < bound.time) : all
    return ACPHistory.cutPage(rows.slice(-(limit + 1)), limit, Number.POSITIVE_INFINITY)
  }
  const scan = ACPHistory.restoreScan()
  let pages = 1
  let page = read(null)
  let cursor = scan.visit(page.kept) ? null : page.cursor
  while (cursor) {
    pages++
    page = read(cursor)
    cursor = scan.visit(page.kept) ? null : page.cursor
  }
  return { ...scan.result(), pages }
}

const infos = (all: SessionMessageResponse[]) => all.map((row) => row.info as ACPHistory.MessageInfo)

describe("M5: the page walk restores what the whole-chat read restored", () => {
  it("equals restoreFromMessages(all) on 600 generated chats of 0..300 messages", () => {
    for (let seed = 1; seed <= 600; seed++) {
      const all = chat(seed, seed % 301)
      expect(walk(all).restored, `seed ${seed}`).toEqual(ACPHistory.restoreFromMessages(infos(all)))
    }
  })

  it("walks past a newest page with no model field on any message, to the older user row", () => {
    const all = [
      message(0, { role: "user", model: { providerID: "p", modelID: "old", variant: "high" }, agent: "plan" }),
      message(1, { role: "assistant", providerID: "p", modelID: "other", variant: "low", mode: "build" }),
      ...Array.from({ length: 60 }, (_, index) => message(2 + index, { role: index % 2 ? "assistant" : "user" })),
    ]
    const result = walk(all)
    expect(result.restored).toEqual(ACPHistory.restoreFromMessages(infos(all)))
    expect(result.restored).toEqual({ model: modelOf("p", "old"), variant: "high", modeId: "plan" })
    expect(result.pages).toBe(2)
  })

  it("does not stop at a NEWER assistant with a model while an older user row has one", () => {
    const all = [
      message(0, { role: "user", model: { providerID: "p", modelID: "user-pick", variant: "low" }, agent: "build" }),
      ...Array.from({ length: 70 }, (_, index) => message(1 + index, { role: "assistant", providerID: "p", modelID: "asst" })),
    ]
    expect(walk(all).restored).toMatchObject({ model: { modelID: "user-pick" }, variant: "low", modeId: "build" })
  })

  it("falls back to the newest assistant only when no user row anywhere has a model", () => {
    const all = [
      message(0, { role: "assistant", providerID: "p", modelID: "first", mode: "plan" }),
      ...Array.from({ length: 80 }, (_, index) => message(1 + index, { role: "user" })),
      message(81, { role: "assistant", providerID: "p", modelID: "newest", agent: "build" }),
    ]
    expect(walk(all).restored).toEqual({ model: modelOf("p", "newest"), variant: undefined, modeId: "build" })
  })

  // t-ugrezs: the usual chat's newest user row is the human's own message, with a model
  // AND text, which answers both the model walk and the pin.
  it("reads ONE page when the newest page has the human's message with a model (the usual chat)", () => {
    const all = chat(7, 5_000).map((row, index) =>
      index === 4_999
        ? message(index, { role: "user", model: { providerID: "p", modelID: "m" } }, [{ id: "q", type: "text", text: "next?" }])
        : row,
    )
    expect(walk(all).pages).toBe(1)
  })

  // t-ugrezs M1. The pinned question is what 0.4.172's webview pinned after a whole
  // replay: the LAST user row. A row is a text part the client draws as the human's:
  // not synthetic (replayed as audience ['assistant'], acpAudience.ts drops it) and
  // not a peer handoff (drawn as a peer row). An `ignored` part replays as audience
  // ['user'] and IS drawn, and every text part is its own row (ChatPane addMessage).
  it("pins the last text part the client draws as the human's", () => {
    const all = [
      message(0, { role: "user", model: { providerID: "p", modelID: "m" } }, [
        { id: "p1", type: "text", text: "fix the parser" },
        { id: "p2", type: "text", text: "and the lexer", ignored: true },
        { id: "p3", type: "text", text: "attachment prompt", synthetic: true },
      ]),
      message(1, { role: "assistant", providerID: "p", modelID: "m" }, [{ id: "p4", type: "text", text: "done" }]),
    ]
    expect(walk(all).latestUser).toEqual({ messageId: "msg_000000", text: "and the lexer" })
    expect(walk([]).latestUser).toBeNull()
  })

  // The smoke's two chats: the newest user rows with a model are background-task and
  // shell RESULTS (synthetic text: tool/task.ts, tool/shell/result.ts), and the
  // human's last message is on an older page.
  const human = (index: number, text: string) =>
    message(index, { role: "user", model: { providerID: "p", modelID: "human-pick" }, agent: "build" }, [
      { id: `h${index}`, type: "text", text },
    ])
  const result = (index: number) =>
    message(index, { role: "user", model: { providerID: "p", modelID: "result" }, agent: "build" }, [
      { id: `r${index}`, type: "text", text: `<task id="t${index}">done</task>`, synthetic: true },
    ])
  const reply = (index: number) =>
    message(index, { role: "assistant", providerID: "p", modelID: "m" }, [{ id: `a${index}`, type: "text", text: "ok" }])

  it("walks past synthetic task and shell results to the human's message on an older page", () => {
    const all = [human(0, "Solid calls do 1 to 5 now"), reply(1)]
    for (let index = 2; index < 122; index++) all.push(index % 2 ? reply(index) : result(index))
    const walked = walk(all)
    expect(walked.latestUser).toEqual({ messageId: "msg_000000", text: "Solid calls do 1 to 5 now" })
    // The model answer is unchanged: the newest user row with a model still wins.
    expect(walked.restored).toEqual(ACPHistory.restoreFromMessages(infos(all)))
    expect(walked.pages).toBe(3)
  })

  it("does not pin a peer agent's handoff", () => {
    const peer = message(3, { role: "user", model: { providerID: "p", modelID: "m" } }, [
      { id: "peer", type: "text", text: "from another agent", metadata: { origami_peer: { from: "ses_x", replyTo: "ses_x" } } },
    ])
    expect(walk([human(0, "my question"), reply(1), result(2), peer, reply(4)]).latestUser?.text).toBe("my question")
  })

  it("stays bounded when the chat has no human message: at most LATEST_USER_MAX_PAGES pages", () => {
    const all = Array.from({ length: 5_000 }, (_, index) => (index % 2 ? reply(index) : result(index)))
    const walked = walk(all)
    expect(walked.latestUser).toBeNull()
    expect(walked.pages).toBe(ACPHistory.LATEST_USER_MAX_PAGES)
    expect(walked.restored).toEqual(ACPHistory.restoreFromMessages(infos(all)))
  })
})

describe("cutPage", () => {
  const rows = (count: number, size = 10) =>
    Array.from({ length: count }, (_, index) => message(index, { role: "assistant" }, [{ id: `p${index}`, type: "text", text: "x".repeat(size) }]))

  it("keeps the newest 50 of 51 rows, says there is more, and points the cursor at the oldest kept", () => {
    const all = rows(51)
    const page = ACPHistory.cutPage(all, 50)
    expect(page.kept).toHaveLength(50)
    expect(page.kept[0]!.info.id).toBe("msg_000001")
    expect(page.hasMore).toBe(true)
    expect(page.capped).toBe(false)
    expect(MessageV2.cursor.decode(page.cursor!)).toEqual({ id: "msg_000001", time: 1_001 } as never)
  })

  it("says there is no more, with no cursor, for a chat of 50 or fewer", () => {
    expect(ACPHistory.cutPage(rows(50), 50)).toMatchObject({ hasMore: false, cursor: null, capped: false })
    expect(ACPHistory.cutPage([], 50)).toMatchObject({ kept: [], hasMore: false, cursor: null })
  })

  it("stops early at the byte cap, newest first, and still pages on from the oldest kept", () => {
    const all = rows(10, 1_000)
    const one = JSON.stringify(all[0]).length
    const page = ACPHistory.cutPage(all, 50, one * 3 + 10)
    expect(page.kept.map((row) => row.info.id)).toEqual(["msg_000007", "msg_000008", "msg_000009"])
    expect(page).toMatchObject({ hasMore: true, capped: true })
    expect(MessageV2.cursor.decode(page.cursor!).id).toBe(MessageID.make("msg_000007"))
  })

  it("keeps a single message larger than the cap, so a page is never empty", () => {
    const page = ACPHistory.cutPage(rows(3, 5_000), 50, 100)
    expect(page.kept.map((row) => row.info.id)).toEqual(["msg_000002"])
    expect(page).toMatchObject({ hasMore: true, capped: true })
  })
})

describe("global find over one message", () => {
  const hitIn = (parts: unknown[], query: string, role = "assistant") =>
    ACPHistory.searchMessage(message(3, { role }, parts), ACPHistory.searchPattern(query), 7)

  it("matches any case and reports where the match sits inside the snippet", () => {
    const text = `${"a".repeat(300)} The Parser failed ${"b".repeat(300)}`
    const [hit] = hitIn([{ id: "prt_1", type: "text", text }], "parser")
    expect(hit).toMatchObject({ messageId: "msg_000003", partId: "prt_1", kind: "text", fromEnd: 7, toolCallId: null })
    expect(hit!.snippet.length).toBeLessThanOrEqual(200)
    expect(hit!.snippet.slice(hit!.matchStart, hit!.matchStart + hit!.matchLength)).toBe("Parser")
  })

  it("reads the query as plain text, not a pattern", () => {
    expect(hitIn([{ id: "p", type: "text", text: "call foo(a.b) now" }], "foo(a.b)")).toHaveLength(1)
    expect(hitIn([{ id: "p", type: "text", text: "fooXa-b" }], "foo(a.b)")).toHaveLength(0)
  })

  it("covers tool title, output and error, and names the tool call", () => {
    const tool = {
      id: "prt_t",
      type: "tool",
      callID: "call_9",
      tool: "bash",
      state: { status: "error", input: {}, error: "ENOENT: missing config", time: { start: 1, end: 2 } },
    }
    expect(hitIn([tool], "enoent")).toMatchObject([{ kind: "tool", toolCallId: "call_9", partId: "prt_t" }])
  })

  it("skips an ignored text part and counts every match in a part", () => {
    expect(hitIn([{ id: "p", type: "text", text: "secret", ignored: true }], "secret")).toEqual([])
    expect(hitIn([{ id: "p", type: "text", text: "go go GO" }], "go")[0]!.matchesInPart).toBe(3)
  })

  it("round-trips a search cursor and refuses a forged one", () => {
    const b = MessageV2.cursor.encode({ id: "msg_1" as never, time: 5 })
    const cursor = ACPHistory.encodeSearchCursor({ b, n: 42 })
    expect(ACPHistory.decodeSearchCursor(cursor)).toEqual({ b, n: 42 })
    expect(ACPHistory.decodeSearchCursor("not-a-cursor")).toBeUndefined()
    expect(ACPHistory.decodeSearchCursor(ACPHistory.encodeSearchCursor({ b: "junk", n: 1 }))).toBeUndefined()
  })
})
