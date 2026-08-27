import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import type { OrigamiClient, Part, SessionMessageResponse } from "@origami/sdk/v2"
import * as ACPService from "@/acp/service"
import { MAX_SESSIONS, plan, stat, unreadable } from "@/acp/run-stats"
import { Agent } from "@/acp/agent"

let partSeq = 0
function partIds(sessionID: string, messageID: string) {
  partSeq++
  return { id: `prt_${partSeq}`, sessionID, messageID }
}

function userMessage(sessionID: string, messageID: string, created: number): SessionMessageResponse {
  return {
    info: { id: messageID, sessionID, role: "user", time: { created }, agent: "build" },
    parts: [{ ...partIds(sessionID, messageID), type: "text", text: "go" }],
  } as unknown as SessionMessageResponse
}

function assistantMessage(
  sessionID: string,
  messageID: string,
  time: { created: number; completed?: number },
  parts: unknown[],
  overrides: Record<string, unknown> = {},
): SessionMessageResponse {
  return {
    info: {
      id: messageID,
      sessionID,
      role: "assistant",
      time,
      parentID: "msg_u1",
      modelID: "mod",
      providerID: "prov",
      mode: "build",
      agent: "build",
      path: { cwd: "/w", root: "/w" },
      cost: 0,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      ...overrides,
    },
    parts,
  } as unknown as SessionMessageResponse
}

function tool(sessionID: string, messageID: string, name: string, status: "completed" | "error" | "running"): Part {
  const state =
    status === "completed"
      ? { status, input: {}, output: "ok", title: name, metadata: {}, time: { start: 1, end: 2 } }
      : status === "error"
        ? { status, input: {}, error: "boom", time: { start: 1, end: 2 } }
        : { status, input: {}, title: name, time: { start: 1 } }
  return { ...partIds(sessionID, messageID), type: "tool", callID: `c_${name}`, tool: name, state } as unknown as Part
}

/** 2 messages, 3 tool calls, 1 of them failed, spanning 1_000 -> 4_000. */
function fixture(sessionID = "ses_a"): SessionMessageResponse[] {
  return [
    userMessage(sessionID, "msg_u1", 1_000),
    assistantMessage(sessionID, "msg_a1", { created: 1_200, completed: 4_000 }, [
      tool(sessionID, "msg_a1", "bash", "completed"),
      tool(sessionID, "msg_a1", "edit", "error"),
      tool(sessionID, "msg_a1", "read", "running"),
      { ...partIds(sessionID, "msg_a1"), type: "text", text: "done" },
    ]),
  ]
}

describe("run-stats counting", () => {
  it("counts messages, every tool call, the failed ones, and the wall-clock span", () => {
    expect(stat("ses_a", fixture())).toEqual({
      sessionId: "ses_a",
      messages: 2,
      toolCalls: 3,
      failures: 1,
      durationMs: 3_000,
      // The spend members are ADDITIVE; the fixture's one assistant message
      // records the default 1-in/1-out with a reported (zero) cache.
      requests: 1,
      tokens: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 0,
    })
  })

  it("counts a failed tool call as a call AND a failure, never one instead of the other", () => {
    const only = stat(
      "ses_a",
      [assistantMessage("ses_a", "msg_a1", { created: 1, completed: 2 }, [tool("ses_a", "msg_a1", "edit", "error")])],
    )
    expect(only.toolCalls).toBe(1)
    expect(only.failures).toBe(1)
  })

  it("counts a message-level failure the index would otherwise miss entirely", () => {
    // A context overflow is RECORDED on the assistant message, not raised as a
    // tool error — a run that died this way has zero failed tool calls.
    const overflowed = stat("ses_a", [
      assistantMessage(
        "ses_a",
        "msg_a1",
        { created: 1_000, completed: 2_000 },
        [tool("ses_a", "msg_a1", "bash", "completed")],
        { error: { name: "ContextOverflowError", data: { message: "too long" } } },
      ),
    ])

    expect(overflowed.failures).toBe(1)
    expect(overflowed.toolCalls).toBe(1)
  })

  it("does not count a still-running tool call as a failure", () => {
    const running = stat("ses_a", [
      assistantMessage("ses_a", "msg_a1", { created: 1, completed: 2 }, [tool("ses_a", "msg_a1", "bash", "running")]),
    ])
    expect(running.failures).toBe(0)
    expect(running.toolCalls).toBe(1)
  })

  it("reports a genuinely empty run as zero counts, but omits the duration it cannot measure", () => {
    const empty = stat("ses_empty", [])

    // `requests: 0` is a COMPUTED zero like the counts beside it; `tokens` is
    // absent because there was nothing to measure, which is not the same thing.
    expect(empty).toEqual({ sessionId: "ses_empty", messages: 0, toolCalls: 0, failures: 0, requests: 0 })
    expect(Object.keys(empty)).not.toContain("durationMs")
  })

  it("omits every count for a session it could not read rather than reporting zeros", () => {
    const blank = unreadable("ses_gone")

    expect(blank).toEqual({ sessionId: "ses_gone" })
    // A fabricated `0 tool calls` reads as "this run did nothing"; a blank does not.
    for (const key of ["messages", "toolCalls", "failures", "durationMs", "requests", "tokens", "cost"]) {
      expect(Object.keys(blank)).not.toContain(key)
    }
  })

  it("derives the span from the widest timestamps, not just the first and last message", () => {
    // Out-of-order records, and the max end lives on the MIDDLE message.
    const span = stat("ses_a", [
      assistantMessage("ses_a", "msg_a2", { created: 5_000, completed: 9_000 }, []),
      userMessage("ses_a", "msg_u1", 2_000),
      assistantMessage("ses_a", "msg_a3", { created: 6_000 }, []),
    ])
    expect(span.durationMs).toBe(7_000)
  })

  it("omits duration when no message carries a usable timestamp", () => {
    const undated = stat("ses_a", [
      { info: { id: "m", sessionID: "ses_a", role: "user", agent: "build" }, parts: [] },
    ] as unknown as SessionMessageResponse[])

    expect(undated.messages).toBe(1)
    expect(undated.durationMs).toBeUndefined()
  })

  it("ignores a malformed record instead of counting it or throwing", () => {
    const messy = stat("ses_a", [
      ...fixture(),
      undefined,
      { parts: [tool("ses_a", "msg_x", "bash", "completed")] },
    ] as unknown as SessionMessageResponse[])

    // The info-less record contributes neither a message nor its tool call.
    expect(messy.messages).toBe(2)
    expect(messy.toolCalls).toBe(3)
  })

  // The run index needs a session's CACHE HEALTH, and the cheapest honest
  // source is this batch: it has already read the messages.
  it("counts REQUESTS and totals the tokens over assistant messages only", () => {
    const s = stat("ses_a", [
      userMessage("ses_a", "msg_u1", 1_000),
      assistantMessage("ses_a", "msg_a1", { created: 1_100, completed: 2_000 }, [], {
        cost: 0.5,
        tokens: { input: 100, output: 10, reasoning: 3, cache: { read: 900, write: 5 } },
      }),
      assistantMessage("ses_a", "msg_a2", { created: 2_100, completed: 3_000 }, [], {
        cost: 0.25,
        tokens: { input: 200, output: 20, reasoning: 4, cache: { read: 1_800, write: 0 } },
      }),
    ])

    expect(s.requests).toBe(2)
    expect(s.tokens).toEqual({ input: 300, output: 30, reasoning: 7, cacheRead: 2_700, cacheWrite: 5 })
    expect(s.cost).toBe(0.75)
  })

  it("OMITS cache entirely for a provider that never reported it — 0 would read as a cold cache", () => {
    const s = stat("ses_a", [
      assistantMessage("ses_a", "msg_a1", { created: 1_000 }, [], { tokens: { input: 900, output: 90 } }),
    ])

    expect(s.tokens).toEqual({ input: 900, output: 90 })
    expect(Object.keys(s.tokens!).sort()).toEqual(["input", "output"])
    // The request still counted: it happened, and it was measured.
    expect(s.requests).toBe(1)
  })

  it("a REPORTED zero is kept — that provider measured, and cached nothing", () => {
    const s = stat("ses_a", [
      assistantMessage("ses_a", "msg_a1", { created: 1_000 }, [], {
        tokens: { input: 900, output: 90, cache: { read: 0, write: 0 } },
      }),
    ])
    expect(s.tokens?.cacheRead).toBe(0)
  })

  it("a session whose messages recorded NO usage reports requests but no tokens", () => {
    const s = stat("ses_a", [
      userMessage("ses_a", "msg_u1", 1_000),
      assistantMessage("ses_a", "msg_a1", { created: 1_100 }, [], { tokens: undefined, cost: undefined }),
    ])

    expect(s.requests).toBe(1)
    expect(s.tokens).toBeUndefined()
    expect(s.cost).toBeUndefined()
  })

  it("an empty run reports zero requests, and invents no token bag for them", () => {
    const s = stat("ses_a", [])
    expect(s.requests).toBe(0)
    expect(s.tokens).toBeUndefined()
  })
})

describe("run-stats batching", () => {
  it("caps the batch and says so rather than quietly reading a hundred sessions", () => {
    const ids = Array.from({ length: MAX_SESSIONS + 5 }, (_, i) => `ses_${i}`)
    const planned = plan(ids)

    expect(planned.ids).toHaveLength(MAX_SESSIONS)
    expect(planned.truncated).toBe(true)
    expect(planned.ids[0]).toBe("ses_0")
  })

  it("does not flag truncation for a batch that fits", () => {
    expect(plan(["a", "b"])).toEqual({ ids: ["a", "b"], truncated: false })
  })

  it("reads a repeated session id once", () => {
    expect(plan(["a", "b", "a", "", "b"]).ids).toEqual(["a", "b"])
  })
})

describe("run_stats service method", () => {
  function storeSdk(store: Record<string, SessionMessageResponse[]>, reads: string[], broken = new Set<string>()) {
    const forbid =
      (name: string) =>
      (...args: unknown[]) => {
        reads.push(`MUTATION:${name}`)
        void args
        return Promise.resolve({ data: {} })
      }
    return {
      session: {
        messages: (params: { sessionID: string }) => {
          reads.push(params.sessionID)
          if (broken.has(params.sessionID)) return Promise.reject(new Error("gone"))
          return Promise.resolve({ data: store[params.sessionID] ?? [] })
        },
        create: forbid("create"),
        get: forbid("get"),
        delete: forbid("delete"),
        prompt: forbid("prompt"),
      },
    } as unknown as OrigamiClient
  }

  it("answers a whole index page in ONE call, one read per session, mutating nothing", async () => {
    const reads: string[] = []
    const store = { ses_a: fixture("ses_a"), ses_b: fixture("ses_b") }
    const service = ACPService.make({ sdk: storeSdk(store, reads) })

    const result = await Effect.runPromise(
      service.runStats({ sessionIds: ["ses_a", "ses_b"], cwd: "/workspace" }),
    )

    expect(reads).toEqual(["ses_a", "ses_b"])
    expect(result.stats.map((item) => item.sessionId)).toEqual(["ses_a", "ses_b"])
    expect(result.stats[0]).toMatchObject({ messages: 2, toolCalls: 3, failures: 1, durationMs: 3_000 })
    expect(result.truncated).toBe(false)
    expect(result.requested).toBe(2)
  })

  it("returns one blank-but-identified row for an unreadable run instead of failing the page", async () => {
    const reads: string[] = []
    const service = ACPService.make({
      sdk: storeSdk({ ses_ok: fixture("ses_ok") }, reads, new Set(["ses_dead"])),
    })

    const result = await Effect.runPromise(service.runStats({ sessionIds: ["ses_dead", "ses_ok"] }))

    expect(result.stats[0]).toEqual({ sessionId: "ses_dead" })
    expect(result.stats[1]).toMatchObject({ sessionId: "ses_ok", toolCalls: 3 })
  })

  it("refuses to read past the cap and reports how many were asked for", async () => {
    const ids = Array.from({ length: MAX_SESSIONS + 8 }, (_, i) => `ses_${i}`)
    const reads: string[] = []
    const service = ACPService.make({ sdk: storeSdk({}, reads) })

    const result = await Effect.runPromise(service.runStats({ sessionIds: ids }))

    expect(reads).toHaveLength(MAX_SESSIONS)
    expect(result.stats).toHaveLength(MAX_SESSIONS)
    expect(result.truncated).toBe(true)
    expect(result.requested).toBe(ids.length)
  })

  it("returns an empty page for an empty request without touching the store", async () => {
    const reads: string[] = []
    const result = await Effect.runPromise(ACPService.make({ sdk: storeSdk({}, reads) }).runStats({ sessionIds: [] }))

    expect(reads).toEqual([])
    expect(result).toEqual({ stats: [], truncated: false, requested: 0 })
  })

  it("scopes reads to the given directory and omits it when none was supplied", async () => {
    const seen: unknown[] = []
    const sdk = {
      session: {
        messages: (params: unknown) => {
          seen.push(params)
          return Promise.resolve({ data: [] })
        },
      },
    } as unknown as OrigamiClient

    await Effect.runPromise(ACPService.make({ sdk }).runStats({ sessionIds: ["ses_a"], cwd: "/workspace" }))
    await Effect.runPromise(ACPService.make({ sdk }).runStats({ sessionIds: ["ses_a"] }))

    expect(seen).toEqual([{ directory: "/workspace", sessionID: "ses_a" }, { sessionID: "ses_a" }])
  })
})

describe("run_stats ext method dispatch", () => {
  const service = {
    runStats: (input: { sessionIds: readonly string[]; cwd?: string }) =>
      Effect.succeed({ stats: input.sessionIds.map((id) => ({ sessionId: id })), truncated: false, requested: 1 }),
  } as unknown as ACPService.Interface

  it("accepts the `_` wire prefix clients send for extension methods", async () => {
    const agent = new Agent(service)
    const prefixed = await agent.extMethod("_run_stats", { sessionIds: ["ses_a"] })
    const bare = await agent.extMethod("run_stats", { sessionIds: ["ses_a"] })
    expect(prefixed).toEqual(bare)
  })

  // Bad params throw SYNCHRONOUSLY, exactly as the existing `run_steps` case
  // does — the JSON-RPC layer turns that into an error response, so a client
  // never gets a plausible-looking empty page from a malformed request.
  it("rejects a request with no sessionIds array rather than silently returning nothing", () => {
    const agent = new Agent(service)
    expect(() => agent.extMethod("run_stats", {})).toThrow("Invalid params")
    expect(() => agent.extMethod("run_stats", { sessionIds: "ses_a" })).toThrow("Invalid params")
  })

  it("rejects a malformed id instead of dropping it and returning a short, misleading page", () => {
    const agent = new Agent(service)
    expect(() => agent.extMethod("run_stats", { sessionIds: ["ses_a", 42] })).toThrow("Invalid params")
    expect(() => agent.extMethod("run_stats", { sessionIds: ["ses_a", ""] })).toThrow("Invalid params")
  })

  it("passes cwd through and omits it when absent", async () => {
    const seen: (string | undefined)[] = []
    const tracking = {
      runStats: (input: { sessionIds: readonly string[]; cwd?: string }) => {
        seen.push(input.cwd)
        return Effect.succeed({ stats: [], truncated: false, requested: 0 })
      },
    } as unknown as ACPService.Interface
    const agent = new Agent(tracking)

    await agent.extMethod("run_stats", { sessionIds: ["a"], cwd: "/workspace" })
    await agent.extMethod("run_stats", { sessionIds: ["a"] })

    expect(seen).toEqual(["/workspace", undefined])
  })
})
