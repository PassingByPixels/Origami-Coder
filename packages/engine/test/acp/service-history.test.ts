// t-ucnjwp (lazy loading L4): the bounded restore and the three history calls,
// driven through the ACP service over a fake store that honours `limit` and
// `before` the way `MessageV2.page` does (newest `limit` rows, oldest first; a
// cursor selects rows strictly older than the row it names).
//
// Wire shapes: reports/lazy_loading_plan_2026-09-24/wire_contract.md.
import { describe, expect, it } from "bun:test"
import type { OrigamiClient, SessionMessageResponse } from "@origami/sdk/v2"
import { ProviderV2 } from "@origami/core/provider"
import { ModelV2 } from "@origami/core/model"
import { Effect, Exit } from "effect"
import * as ACPService from "@/acp/service"
import { Agent } from "@/acp/agent"
import { ACPHistory } from "@/acp/history"
import type { ACPHistoryStore } from "@/acp/history-store"
import { MessageV2 } from "@/session/message-v2"
import { MessageID } from "@/session/schema"
import { taskResultsMetadata } from "@/session/task-result"
import type { Provider } from "@/provider/provider"

const providerID = ProviderV2.ID.make("test")
const modelID = ModelV2.ID.make("test-model")
const provider = {
  id: providerID,
  name: "Test",
  source: "config",
  env: [],
  options: {},
  models: {
    [modelID]: {
      id: modelID,
      providerID,
      api: { id: modelID, url: "https://example.com", npm: "@ai-sdk/openai-compatible" },
      name: "Test Model",
      family: "test",
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: false,
        toolcall: true,
        input: { text: true, audio: false, image: false, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: 128000, output: 4096 },
      status: "active",
      options: {},
      headers: {},
      release_date: "2026-01-01",
      variants: { default: {}, high: { reasoningEffort: "high" } },
    },
  },
} as unknown as Provider.Info

const CHAT = "ses_chat"
const id = (index: number) => `msg_${String(index).padStart(6, "0")}`

function message(sessionID: string, index: number, info: Record<string, unknown>, parts: unknown[]) {
  return {
    info: { id: id(index), sessionID, time: { created: 1_000 + index }, ...info },
    parts: parts.map((part, n) => ({ id: `prt_${index}_${n}`, sessionID, messageID: id(index), ...(part as object) })),
  } as unknown as SessionMessageResponse
}

const user = (index: number, text: string, model = true) =>
  message(CHAT, index, { role: "user", ...(model ? { model: { providerID: "test", modelID: "test-model" } } : {}) }, [
    { type: "text", text },
  ])
const assistant = (index: number, parts: unknown[], model = true) =>
  message(CHAT, index, { role: "assistant", ...(model ? { providerID: "test", modelID: "test-model" } : {}) }, parts)

/** A plain chat: user / assistant turns, `count` messages. */
function plainChat(count: number) {
  return Array.from({ length: count }, (_, index) =>
    index % 2 === 0 ? user(index, `question ${index}`) : assistant(index, [{ type: "text", text: `answer ${index}` }]),
  )
}

type Query = { sessionID: string; limit?: number; before?: string; returned: number }
type Event = { kind: "update"; update: Record<string, unknown>; sessionId: string } | { kind: "ext"; method: string; params: Record<string, unknown> }

function world(input: {
  store: Record<string, SessionMessageResponse[]>
  rows?: Record<string, Record<string, unknown>>
  status?: Record<string, { type: string }>
  history?: ACPHistoryStore.Reader
}) {
  const queries: Query[] = []
  const events: Event[] = []
  const sdk = {
    config: {
      providers: () => Promise.resolve({ data: { providers: [provider], default: { test: modelID } } }),
      get: () => Promise.resolve({ data: {} }),
    },
    app: { agents: () => Promise.resolve({ data: [{ name: "build", mode: "primary", permission: [], options: {} }, { name: "plan", mode: "primary", permission: [], options: {} }] }), skills: () => Promise.resolve({ data: [] }) },
    command: { list: () => Promise.resolve({ data: [] }) },
    session: {
      get: (params: { sessionID: string }) =>
        Promise.resolve({ data: input.rows?.[params.sessionID] ?? { id: params.sessionID, title: "A chat" } }),
      messages: (params: { sessionID: string; limit?: number; before?: string }) => {
        let rows = input.store[params.sessionID] ?? []
        if (params.before) {
          const at = MessageV2.cursor.decode(params.before)
          rows = rows.filter((row) => {
            const info = row.info as { id: string; time: { created: number } }
            return info.time.created < at.time || (info.time.created === at.time && info.id < at.id)
          })
        }
        const data = params.limit ? rows.slice(-params.limit) : rows
        queries.push({ sessionID: params.sessionID, limit: params.limit, before: params.before, returned: data.length })
        return Promise.resolve({ data })
      },
      todo: () => Promise.resolve({ data: [] }),
      status: () => Promise.resolve({ data: input.status ?? {} }),
      fork: () => Promise.resolve({ data: { id: "ses_fork", title: "A chat (fork #1)" } }),
    },
    mcp: { add: () => Promise.resolve({ data: {} }) },
  } as unknown as OrigamiClient
  const connection = {
    sessionUpdate: (notification: { sessionId: string; update: Record<string, unknown> }) => {
      events.push({ kind: "update", update: notification.update, sessionId: notification.sessionId })
      return Promise.resolve()
    },
    extNotification: (method: string, params: Record<string, unknown>) => {
      events.push({ kind: "ext", method, params })
      return Promise.resolve()
    },
  }
  const service = ACPService.make({ sdk, connection: connection as never, history: input.history })
  return { service, queries, events }
}

const counting = (store: Record<string, SessionMessageResponse[]>, rows: ACPHistoryStore.DescendantRow[] = []) =>
  ({
    countMessages: (sessionID: string) => Promise.resolve(store[sessionID]?.length ?? 0),
    descendants: () => Promise.resolve({ rows, truncated: false }),
  }) satisfies ACPHistoryStore.Reader

const updates = (events: Event[]) =>
  events.flatMap((event) => (event.kind === "update" ? [event.update] : []))
/** The frames of the message replay only: not the title or the command list. */
const replayFrames = (events: Event[]) =>
  updates(events).filter(
    (update) => update["sessionUpdate"] !== "session_info_update" && update["sessionUpdate"] !== "available_commands_update",
  )
const frameMessageIds = (frames: Record<string, unknown>[]) => [
  ...new Set(frames.flatMap((frame) => (typeof frame["messageId"] === "string" ? [frame["messageId"] as string] : []))),
]
const ext = (events: Event[], method: string) =>
  events.flatMap((event) => (event.kind === "ext" && event.method === method ? [event.params] : []))

const load = (service: ACPService.Interface, sessionId = CHAT) =>
  Effect.runPromise(service.loadSession({ cwd: "/workspace", sessionId, mcpServers: [] }))

describe("bounded restore (session/load)", () => {
  it("replays only the newest 50 messages and says where the older ones are", async () => {
    const store = { [CHAT]: plainChat(120) }
    const { service, queries, events } = world({ store, history: counting(store) })

    const response = await load(service)

    const chatQueries = queries.filter((query) => query.sessionID === CHAT)
    expect(chatQueries).toEqual([{ sessionID: CHAT, limit: 51, before: undefined, returned: 51 }])
    const newest = store[CHAT]!.slice(70).map((row) => row.info.id)
    expect(frameMessageIds(replayFrames(events))).toEqual(newest)

    const window = (response._meta as { origami_history: ACPHistory.HistoryWindow }).origami_history
    expect(window).toMatchObject({ sessionId: CHAT, hasMore: true, totalMessages: 120, messageIds: newest, capped: false })
    expect(MessageV2.cursor.decode(window.cursor!).id).toBe(MessageID.make(id(70)))
    expect(ext(events, "origami/historyWindow")).toEqual([window as never])
  })

  // The large-fixture check (ticket item 7): what a restore reads and sends does
  // not grow with the chat. 100 and 10,000 messages read the same rows.
  it("costs the same for 100 and 10,000 messages", async () => {
    const cost = async (count: number) => {
      const store = { [CHAT]: plainChat(count) }
      const { service, queries, events } = world({ store, history: counting(store) })
      await load(service)
      return {
        reads: queries.length,
        rows: queries.reduce((sum, query) => sum + query.returned, 0),
        frames: replayFrames(events).length,
      }
    }
    const small = await cost(100)
    const large = await cost(10_000)
    expect(large).toEqual(small)
    expect(large.rows).toBe(51)
  })

  // M5 at the service: the newest page has no model on any message, so the
  // restore walks one older page and lands where the whole-chat read landed.
  it("restores model, variant and mode like the whole-chat read when the newest messages carry no model", async () => {
    const chat = [
      message(CHAT, 0, { role: "user", model: { providerID: "test", modelID: "test-model", variant: "high" }, agent: "plan" }, [
        { type: "text", text: "plan it" },
      ]),
      ...Array.from({ length: 60 }, (_, n) => (n % 2 ? assistant(1 + n, [{ type: "text", text: "..." }], false) : user(1 + n, "go on", false))),
    ]
    const store = { [CHAT]: chat }
    const { service, queries } = world({ store, history: counting(store) })

    const response = await load(service)
    const option = (name: string) => response.configOptions?.find((item) => item.id === name)?.currentValue

    const whole = ACPHistory.restoreFromMessages(chat.map((row) => row.info as ACPHistory.MessageInfo))
    expect(whole).toMatchObject({ variant: "high", modeId: "plan" })
    expect(option("model")).toBe("test/test-model")
    expect(option("effort")).toBe(whole.variant)
    expect(option("mode")).toBe(whole.modeId)
    // Two bounded reads, never a whole-chat one.
    expect(queries.filter((query) => query.sessionID === CHAT).map((query) => query.limit)).toEqual([51, 51])
  })

  it("forks with the same bounded restore", async () => {
    const store = { ses_fork: plainChat(80) }
    const { service, queries } = world({ store, history: counting(store) })

    const response = await Effect.runPromise(service.forkSession({ cwd: "/workspace", sessionId: CHAT, mcpServers: [] }))

    expect(queries.filter((query) => query.sessionID === "ses_fork").map((query) => query.limit)).toEqual([51])
    expect((response._meta as { origami_history: ACPHistory.HistoryWindow }).origami_history).toMatchObject({
      sessionId: "ses_fork",
      hasMore: true,
      totalMessages: 80,
    })
  })

  // t-ugrezs M1: the page holds only task results and replies, so no loaded row is a
  // user row; the window must still carry the human's last message for the pin.
  it("puts the human's last message in the window when the newest page holds only synthetic results", async () => {
    const chat = [user(0, "Solid calls do 1 to 5 now"), assistant(1, [{ type: "text", text: "on it" }])]
    for (let index = 2; index < 80; index++) {
      chat.push(
        index % 2
          ? assistant(index, [{ type: "text", text: "ok" }])
          : message(CHAT, index, { role: "user", model: { providerID: "test", modelID: "test-model" } }, [
              { type: "text", text: `<task id="t${index}">done</task>`, synthetic: true },
            ]),
      )
    }
    const store = { [CHAT]: chat }
    const { service } = world({ store, history: counting(store) })

    const response = await load(service)

    const window = (response._meta as { origami_history: ACPHistory.HistoryWindow }).origami_history
    expect(window.latestUser).toEqual({ messageId: id(0), text: "Solid calls do 1 to 5 now" })
  })

  // t-ugrezs M2: a fork has no child sessions of its own; its task cards point at the
  // SOURCE chat's children, which 0.4.172's whole replay drew as 16 of 16 cards.
  // t-uhxos2: the source is found by the STORE's roster read (the durable fork link,
  // test/acp/fork-roster.test.ts); the service asks it for the fork's own id and sends
  // the answer addressed to the fork, on this connection and on any later one.
  it("gives a fork the source chat's roster, addressed to the fork", async () => {
    const store = { ses_fork: plainChat(80) }
    const asked: string[] = []
    const child = {
      id: "ses_child",
      parentId: CHAT,
      depth: 1,
      title: "child",
      agent: "explore",
      created: 5,
      updated: 5,
      tokens: { input: 10, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 0,
      steps: 1,
    } satisfies ACPHistoryStore.DescendantRow
    const history = {
      countMessages: (sessionID: string) => Promise.resolve(store[sessionID as "ses_fork"]?.length ?? 0),
      descendants: () => Promise.reject(new Error("the roster must be read through `roster`")),
      // The store's answer for the fork: its source's children (link read in the store).
      roster: (sessionID: string) => {
        asked.push(sessionID)
        return Promise.resolve({ rows: sessionID === "ses_fork" ? [child] : [], truncated: false })
      },
    } satisfies ACPHistoryStore.Reader
    const { service, events } = world({ store, history })

    await Effect.runPromise(service.forkSession({ cwd: "/workspace", sessionId: CHAT, mcpServers: [] }))

    const sent = ext(events, "origami/subagentRoster") as unknown as ACPHistory.SubagentRoster[]
    expect(sent).toHaveLength(1)
    expect(sent[0]!.sessionId).toBe("ses_fork")
    expect(sent[0]!.rows.map((row) => row.id)).toEqual(["ses_child"])
    expect(asked).toEqual(["ses_fork"])
    // The on-demand call for the fork answers the same rows.
    const again = await Effect.runPromise(service.subagentRoster({ sessionId: "ses_fork" }))
    expect(again).toEqual(sent[0]!)
  })
})

describe("sub-agent roster and task riders on a restore", () => {
  const rosterRow = (childId: string, created: number, tokens: number, steps: number | null) =>
    ({
      id: childId,
      parentId: CHAT,
      depth: 1,
      title: `child ${childId}`,
      agent: "explore",
      created,
      updated: created,
      tokens: { input: tokens, output: tokens / 10, reasoning: 0, cacheRead: 5, cacheWrite: 0 },
      cost: 0.25,
      steps,
    }) satisfies ACPHistoryStore.DescendantRow

  const childTranscript = (childId: string) =>
    Array.from({ length: 30 }, (_, n) =>
      message(childId, n, { role: "assistant", providerID: "test", modelID: "test-model" }, [
        { type: "step-finish", reason: "stop", cost: 0, tokens: { input: 100 + n, output: 5, reasoning: 0, cache: { read: 10, write: 1 } } },
      ]),
    )

  const marker = (index: number, childId: string) =>
    assistant(index, [{ type: "text", text: "", metadata: taskResultsMetadata([{ sessionId: childId, state: "completed" }]) }])

  it("sends one row per child, early children included, before the first frame, and reads no child transcript", async () => {
    const chat = plainChat(120)
    chat[5] = marker(5, "ses_early") // above the loaded page
    chat[118] = marker(118, "ses_late") // on the loaded page
    const store = { [CHAT]: chat, ses_early: childTranscript("ses_early"), ses_late: childTranscript("ses_late") }
    const rows = [rosterRow("ses_early", 10, 1000, 7), rosterRow("ses_late", 20, 2000, null)]
    const { service, queries, events } = world({
      store,
      history: counting(store, rows),
      status: { ses_late: { type: "busy" } },
    })

    await load(service)

    const rosterAt = events.findIndex((event) => event.kind === "ext" && event.method === "origami/subagentRoster")
    const firstFrame = events.findIndex(
      (event) => event.kind === "update" && typeof event.update["messageId"] === "string",
    )
    expect(rosterAt).toBeGreaterThanOrEqual(0)
    expect(rosterAt).toBeLessThan(firstFrame)
    const roster = ext(events, "origami/subagentRoster")[0] as unknown as ACPHistory.SubagentRoster
    expect(roster.rows.map((row) => [row.id, row.status, row.steps])).toEqual([
      ["ses_early", "idle", 7],
      ["ses_late", "running", null],
    ])
    // context = the newest child message's last step: input 129 + cache 10 + 1.
    expect(roster.rows[1]!.context).toBe(140)

    // The loaded marker's rider is the ROW's figure; `steps` is left out while null.
    const rider = updates(events).find(
      (update) => (update["_meta"] as Record<string, unknown> | undefined)?.["origami_task_session"] === "ses_late",
    )?.["_meta"] as Record<string, unknown>
    expect(rider["origami_task_tokens"]).toEqual({
      input: 2000,
      output: 200,
      reasoning: 0,
      cacheRead: 5,
      cacheWrite: 0,
      cost: 0.25,
      context: 140,
    })

    // ZERO child transcript reads: every child read is the one newest message.
    const childReads = queries.filter((query) => query.sessionID !== CHAT)
    expect(childReads.every((query) => query.limit === 1)).toBe(true)
    expect(childReads.length).toBeLessThanOrEqual(rows.length)
  })

  it("answers subagent_roster on demand with the same rows", async () => {
    const store = { [CHAT]: plainChat(4), ses_a: childTranscript("ses_a") }
    const { service } = world({ store, history: counting(store, [rosterRow("ses_a", 1, 300, 2)]) })
    const roster = await Effect.runPromise(service.subagentRoster({ sessionId: CHAT, cwd: "/workspace" }))
    expect(roster).toMatchObject({ sessionId: CHAT, truncated: false, rows: [{ id: "ses_a", steps: 2, status: "idle" }] })
  })

  it("still opens the chat, with no roster notification, when the roster read fails", async () => {
    const store = { [CHAT]: plainChat(4) }
    const history = {
      countMessages: () => Promise.resolve(4),
      descendants: () => Promise.reject(new Error("store busy")),
    }
    const { service, events } = world({ store, history })
    const response = await load(service)
    expect(response.configOptions).toBeDefined()
    expect(ext(events, "origami/subagentRoster")).toEqual([])
  })
})

describe("history_page", () => {
  it("walks the whole chat in tagged pages: every message once, oldest last, bounded reads", async () => {
    const store = { [CHAT]: plainChat(120) }
    const { service, queries, events } = world({ store, history: counting(store) })
    const response = await load(service)
    const window = (response._meta as { origami_history: ACPHistory.HistoryWindow }).origami_history

    const loaded: string[][] = [[...window.messageIds]]
    let cursor = window.cursor
    let replies = 0
    while (cursor) {
      const from = events.length
      const reply = await Effect.runPromise(service.historyPage({ sessionId: CHAT, before: cursor, pageId: `p${replies}` }))
      const frames = updates(events.slice(from))
      expect(frames.length).toBeGreaterThan(0)
      for (const frame of frames) expect((frame["_meta"] as Record<string, unknown>)["origami_page"]).toBe(`p${replies}`)
      expect(frameMessageIds(frames)).toEqual([...reply.messageIds])
      expect(reply).toMatchObject({ sessionId: CHAT, pageId: `p${replies}`, totalMessages: 120, messages: reply.messageIds.length })
      loaded.unshift([...reply.messageIds])
      cursor = reply.cursor
      expect(reply.hasMore).toBe(cursor !== null)
      replies++
    }
    expect(replies).toBe(2)
    expect(loaded.flat()).toEqual(store[CHAT]!.map((row) => row.info.id))
    for (const query of queries) expect(query.limit).toBeLessThanOrEqual(51)
  })

  // K4: one renderer. The same stored messages give the same frames by restore
  // and by page, apart from the page tag.
  it("sends the frames a restore sends, plus the tag", async () => {
    const chat = [
      user(0, "run it"),
      assistant(1, [
        { type: "reasoning", text: "thinking" },
        { type: "tool", callID: "call_ok", tool: "read", state: { status: "completed", input: { filePath: "/a" }, output: "body", title: "read a", metadata: {}, time: { start: 1, end: 2 } } },
        { type: "tool", callID: "call_bad", tool: "bash", state: { status: "error", input: { command: "x" }, error: "boom", time: { start: 1, end: 2 } } },
        { type: "text", text: "done" },
      ]),
    ]
    const store = { [CHAT]: chat }
    const { service, events } = world({ store, history: counting(store) })
    await load(service)
    const restored = replayFrames(events)
    const from = events.length
    await Effect.runPromise(service.historyPage({ sessionId: CHAT, pageId: "head" }))
    const paged = updates(events.slice(from)).map((frame) => {
      const { origami_page: tag, ...meta } = frame["_meta"] as Record<string, unknown>
      expect(tag).toBe("head")
      const { _meta: _dropped, ...rest } = frame
      return Object.keys(meta).length ? { ...rest, _meta: meta } : rest
    })
    expect(paged).toEqual(restored)
  })

  it("touches no live tool state: a running tool page read twice sends its tool_call twice", async () => {
    const running = { type: "tool", callID: "call_run", tool: "bash", state: { status: "running", input: { command: "sleep" }, time: { start: 1 } } }
    const store = { [CHAT]: [user(0, "go"), assistant(1, [running])] }
    const { service, events } = world({ store, history: counting(store) })
    await load(service)
    const from = events.length
    await Effect.runPromise(service.historyPage({ sessionId: CHAT, pageId: "a" }))
    await Effect.runPromise(service.historyPage({ sessionId: CHAT, pageId: "b" }))
    const calls = updates(events.slice(from)).filter((frame) => frame["sessionUpdate"] === "tool_call")
    expect(calls.map((frame) => (frame["_meta"] as Record<string, unknown>)["origami_page"])).toEqual(["a", "b"])
  })

  it("refuses a session that is not loaded on this connection", async () => {
    const store = { [CHAT]: plainChat(3) }
    const { service, events } = world({ store })
    const exit = await Effect.runPromiseExit(service.historyPage({ sessionId: CHAT }))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(events).toEqual([])
  })
})

describe("history_search", () => {
  it("finds hits newest first across pages, stops at the limit, and continues from its cursor", async () => {
    const chat = plainChat(120)
    for (const index of [3, 60, 110]) chat[index] = assistant(index, [{ type: "text", text: `found the Needle at ${index}` }])
    const store = { [CHAT]: chat }
    const { service, queries } = world({ store })

    const first = await Effect.runPromise(service.historySearch({ sessionId: CHAT, query: "needle", limit: 2, cwd: "/workspace" }))
    expect(first.hits.map((hit) => [hit.messageId, hit.fromEnd])).toEqual([
      [id(110), 9],
      [id(60), 59],
    ])
    expect(first.done).toBe(false)

    const rest = await Effect.runPromise(
      service.historySearch({ sessionId: CHAT, query: "needle", cursor: first.cursor!, cwd: "/workspace" }),
    )
    expect(rest.hits.map((hit) => [hit.messageId, hit.fromEnd])).toEqual([[id(3), 116]])
    expect(rest).toMatchObject({ done: true, cursor: null })
    expect(first.scanned + rest.scanned).toBe(120)
    for (const query of queries) expect(query.limit).toBe(51)
  })
})

describe("ext dispatch", () => {
  const spy = () => {
    const seen: unknown[] = []
    const agent = new Agent({
      historyPage: (input: unknown) => (seen.push(input), Effect.succeed({})),
      historySearch: (input: unknown) => (seen.push(input), Effect.succeed({})),
      subagentRoster: (input: unknown) => (seen.push(input), Effect.succeed({})),
    } as unknown as ACPService.Interface)
    return { agent, seen }
  }
  const cursor = MessageV2.cursor.encode({ id: "msg_1" as never, time: 1 })

  it("passes valid calls through, with or without the wire prefix", async () => {
    const { agent, seen } = spy()
    await agent.extMethod("_history_page", { sessionId: CHAT, before: cursor, limit: 10, pageId: "p1", cwd: "/w" })
    await agent.extMethod("history_search", { sessionId: CHAT, query: "x" })
    await agent.extMethod("_subagent_roster", { sessionId: CHAT })
    expect(seen).toEqual([
      { sessionId: CHAT, before: cursor, limit: 10, pageId: "p1", cwd: "/w" },
      { sessionId: CHAT, query: "x" },
      { sessionId: CHAT },
    ])
  })

  it("refuses bad values before any read", () => {
    const { agent, seen } = spy()
    for (const params of [
      {},
      { sessionId: CHAT, limit: 0 },
      { sessionId: CHAT, limit: 51 },
      { sessionId: CHAT, limit: 2.5 },
      { sessionId: CHAT, before: "junk" },
      { sessionId: CHAT, pageId: "" },
      { sessionId: CHAT, pageId: "x".repeat(129) },
    ]) {
      expect(() => agent.extMethod("_history_page", params), JSON.stringify(params)).toThrow()
    }
    for (const params of [
      { sessionId: CHAT },
      { sessionId: CHAT, query: "" },
      { sessionId: CHAT, query: "x".repeat(201) },
      { sessionId: CHAT, query: "x", limit: 201 },
      { sessionId: CHAT, query: "x", cursor: cursor },
    ]) {
      expect(() => agent.extMethod("_history_search", params), JSON.stringify(params)).toThrow()
    }
    expect(() => agent.extMethod("_subagent_roster", {})).toThrow()
    expect(seen).toEqual([])
  })
})
