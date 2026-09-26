// t-w2u5vf: closing a chat frees what this engine process holds for it.
//
// The soak (soak_0.4.175.md 3.10) measured 0.36-0.42 GB of heap kept after six
// big chats were closed. A heap snapshot named the holders: the per-session
// module stores (prompt capture's step history and captures, tool aging, the
// other request-memory stores). This file drives the real ACP `session/close`
// and reads each store back through its own public API: the closed chat and
// its idle sub-agents are gone from every store; a chat still open, a
// sub-agent still running and a sub-agent opened as its own chat keep theirs;
// rows queued and not yet written are kept.

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import type { AgentSideConnection, SessionNotification } from "@agentclientprotocol/sdk"
import type { OrigamiClient } from "@origami/sdk/v2"
import { ProviderV2 } from "@origami/core/provider"
import { ModelV2 } from "@origami/core/model"
import { Effect } from "effect"
import type { ModelMessage } from "ai"
import * as ACPService from "@/acp/service"
import { UsageService } from "@/acp/usage"
import type { ACPHistoryStore } from "@/acp/history-store"
import { EngineProcessMemory } from "@/engine-process-memory"
import type { Provider } from "@/provider/provider"
import { SessionCacheState, type CacheStatePush } from "@/session/cache-state"
import { SessionCacheWarm } from "@/session/cache-warm"
import { SessionDegrade } from "@/session/degrade"
import { SessionEffortTier } from "@/session/effort-tier"
import { SessionImageCap } from "@/session/image-cap"
import { SessionPromptCapture } from "@/session/prompt-capture"
import { SessionRequestMemoryRows } from "@/session/request-memory-rows"
import { SessionToolAging } from "@/session/tool-aging"
import { SessionWindowFit } from "@/session/window-fit"

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
        reasoning: false,
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
    },
  },
} as unknown as Provider.Info

/** Timers under test control, shared by the warm and the badge. */
function fakeClock() {
  let next = 1
  let now = 1_000_000
  const timers = new Map<number, { fn: () => void; at: number }>()
  return {
    clock: {
      now: () => now,
      setTimeout(fn: () => void, ms: number) {
        const id = next++
        timers.set(id, { fn, at: now + ms })
        return { id }
      },
      clearTimeout(handle: { id: unknown }) {
        timers.delete(handle.id as number)
      },
    },
    advance(ms: number) {
      now += ms
      for (const [id, t] of [...timers]) {
        if (t.at > now) continue
        timers.delete(id)
        t.fn()
      }
    },
  }
}

const anthropic = {
  id: "claude-sonnet-5",
  providerID: "anthropic",
  api: { npm: "@ai-sdk/anthropic", id: "claude-sonnet-5" },
} as unknown as Provider.Model

const messages: ModelMessage[] = [
  { role: "user", content: [{ type: "text", text: "hello" }] },
  { role: "assistant", content: [{ type: "text", text: "hi" }] },
]

/** Put one entry for `id` into every per-session store, through each store's own API. */
function fill(id: string, warms: string[]) {
  SessionToolAging.restore(id, [{ kind: "aging.rewrite", key: "prt_1", data: { output: "[aged]" } }])
  SessionDegrade.restore(id, [{ kind: "degrade", key: "temperature", data: true }])
  SessionImageCap.restore(id, [{ kind: "image_cap", key: "", data: 3 }])
  SessionWindowFit.restore(id, [{ kind: "window_fit", key: "", data: 1.5 }])
  SessionWindowFit.sent(id, 1000)
  SessionEffortTier.sent(id, "test/test-model", "high")
  SessionEffortTier.record(id, "test/test-model")
  SessionPromptCapture.draft(id, [SessionPromptCapture.part("memory", "remember this")])
  SessionPromptCapture.record({
    sessionID: id,
    capturedAt: new Date(1_000_000).toISOString(),
    model: "test/test-model",
    base: ["base"],
    finalSystem: ["system"],
    tools: {},
    messages,
  })
  SessionPromptCapture.markRewrite(id, "tool-aging")
  SessionCacheWarm.armed({
    sessionID: id,
    model: anthropic,
    options: {},
    messages,
    send: async () => void warms.push(id),
    env: {},
  })
  SessionCacheState.request({ sessionID: id, ttlSeconds: 300 })
  SessionCacheState.measured({ sessionID: id, cacheRead: 10 })
}

/** What each store holds for `id`, read through the stores' own APIs. */
function held(id: string) {
  return {
    aging: SessionToolAging.has(id),
    degrade: SessionDegrade.has(id),
    imageCap: SessionImageCap.has(id),
    windowFit: SessionWindowFit.has(id),
    effortTier: SessionEffortTier.lastTier(id, "test/test-model") !== undefined,
    effortDemoted: SessionEffortTier.isRecorded(id, "test/test-model"),
    capture: SessionPromptCapture.get(id) !== null,
    captureFacts: SessionPromptCapture.lastRequest(id) !== undefined,
    warmPending: SessionCacheWarm.pending(id),
  }
}

const ALL = {
  aging: true,
  degrade: true,
  imageCap: true,
  windowFit: true,
  effortTier: true,
  effortDemoted: true,
  capture: true,
  captureFacts: true,
  warmPending: true,
}
const NONE = Object.fromEntries(Object.keys(ALL).map((key) => [key, false])) as typeof ALL

function makeService(input: {
  created: string[]
  descendants: Record<string, string[]>
  running: string[]
  statusFails?: boolean
}) {
  let made = 0
  const sdk = {
    config: {
      providers: () => Promise.resolve({ data: { providers: [provider], default: { test: modelID } } }),
      get: () => Promise.resolve({ data: {} }),
      refresh: () => Promise.resolve({ data: true }),
    },
    app: {
      agents: () => Promise.resolve({ data: [{ name: "build", mode: "primary", permission: [], options: {} }] }),
      skills: () => Promise.resolve({ data: [] }),
    },
    command: { list: () => Promise.resolve({ data: [] }) },
    session: {
      create: () => Promise.resolve({ data: { id: input.created[made++] } }),
      get: () => Promise.resolve({ data: { id: "unused" } }),
      messages: () => Promise.resolve({ data: [] }),
      todo: () => Promise.resolve({ data: [] }),
      abort: () => Promise.resolve({ data: true }),
      status: () =>
        input.statusFails
          ? Promise.reject(new Error("status read failed"))
          : Promise.resolve({ data: Object.fromEntries(input.running.map((id) => [id, { type: "busy" }])) }),
    },
    mcp: { add: () => Promise.resolve({ data: {} }) },
  } as unknown as OrigamiClient
  const connection = {
    sessionUpdate: (_: SessionNotification) => Promise.resolve(),
    extNotification: () => Promise.resolve(),
  } as Pick<AgentSideConnection, "sessionUpdate" | "extNotification">
  const usage: UsageService.Interface = {
    buildUsage: UsageService.buildUsage,
    latestAssistantMessage: UsageService.latestAssistantMessage,
    totalSessionCost: UsageService.totalSessionCost,
    contextLimit: () => Effect.succeed(128000),
    sendUpdate: () => Effect.void,
  }
  const history: ACPHistoryStore.Reader = {
    countMessages: () => Promise.resolve(0),
    descendants: (sessionID) =>
      Promise.resolve({
        rows: (input.descendants[sessionID] ?? []).map((id) => ({ id }) as ACPHistoryStore.DescendantRow),
        truncated: false,
      }),
  }
  return ACPService.make({ sdk, connection, usage, history })
}

let timers: ReturnType<typeof fakeClock>
let badge: CacheStatePush[]

beforeEach(() => {
  EngineProcessMemory.resetForTest()
  timers = fakeClock()
  SessionCacheWarm.setClock(timers.clock)
  SessionCacheState.setClock(timers.clock)
  badge = []
  SessionCacheState.onCacheState((push) => badge.push(push))
})

afterEach(() => EngineProcessMemory.resetForTest())

describe("ACP session/close frees the closed chat's per-session memory", () => {
  it("the closed chat and its idle sub-agents lose every entry; open and running sessions keep theirs", async () => {
    const [chat, other, openChild] = ["ses_chat", "ses_other", "ses_child_open"]
    const [idleChild, grandChild, runningChild] = ["ses_child_idle", "ses_grandchild", "ses_child_running"]
    const service = makeService({
      created: [chat, other, openChild],
      descendants: { [chat]: [idleChild, grandChild, runningChild, openChild] },
      running: [runningChild],
    })
    for (const _ of [chat, other, openChild])
      await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))
    const warms: string[] = []
    const all = [chat, other, openChild, idleChild, grandChild, runningChild]
    for (const id of all) fill(id, warms)
    // A refusal learned in the closed chat and not yet written: the only copy.
    SessionRequestMemoryRows.stage(chat, [{ kind: "degrade", key: "top_p", data: true }])
    for (const id of all) expect(held(id)).toEqual(ALL)

    expect(await Effect.runPromise(service.closeSession({ sessionId: chat }))).toEqual({})

    expect(held(chat)).toEqual(NONE)
    expect(held(idleChild)).toEqual(NONE)
    expect(held(grandChild)).toEqual(NONE)
    expect(held(other)).toEqual(ALL)
    expect(held(runningChild)).toEqual(ALL)
    expect(held(openChild)).toEqual(ALL)
    expect(SessionRequestMemoryRows.peek(chat)).toEqual([{ kind: "degrade", key: "top_p", data: true }])

    // No timer of a freed session fires: no warm is sent for it, and its badge
    // does not go cold on expiry. The kept ones still do both.
    timers.advance(3_600_000)
    expect(warms.sort()).toEqual([other, openChild, runningChild].sort())
    const expired = badge.filter((push) => push.source === "expired").map((push) => push.sessionId)
    expect(expired.sort()).toEqual([other, openChild, runningChild].sort())
  })

  it("frees nothing when the session status cannot be read", async () => {
    const chat = "ses_chat"
    const service = makeService({ created: [chat], descendants: {}, running: [], statusFails: true })
    await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))
    fill(chat, [])

    await Effect.runPromise(service.closeSession({ sessionId: chat }))

    expect(held(chat)).toEqual(ALL)
  })

  it("frees nothing for a session id that is not open here", async () => {
    const service = makeService({ created: [], descendants: {}, running: [] })
    fill("ses_elsewhere", [])

    await Effect.runPromise(service.closeSession({ sessionId: "ses_elsewhere" }))

    expect(held("ses_elsewhere")).toEqual(ALL)
  })
})
