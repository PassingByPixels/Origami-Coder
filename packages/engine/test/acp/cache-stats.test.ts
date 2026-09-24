// `cache_stats` — this session's prompt-cache token accounting plus a
// lifetime sum over every session of its project, for the Insights
// cache-hit-ratio card (t-kgtw47). The bugs worth catching: dropping a
// subagent's own cache spend from the lifetime, and a failed read failing the
// whole call instead of degrading the way the usage_update rollup does.
//
// t-ucndru: the rows come from the store (`ACPHistoryStore.projectTokens`, no
// limit), not `session.list`, which stopped at the 100 newest rows. The limit
// itself is tested against a real store in usage-descendants.test.ts.

import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import type { OrigamiClient } from "@origami/sdk/v2"
import * as ACPService from "@/acp/service"
import { Agent } from "@/acp/agent"
import type { ACPHistoryStore } from "@/acp/history-store"

function storeReader(rows: unknown[], seen: unknown[], broken = false) {
  return {
    countMessages: () => Promise.resolve(0),
    descendants: () => Promise.resolve({ rows: [], truncated: false }),
    projectTokens: (sessionID: string, directory?: string) => {
      seen.push({ sessionID, ...(directory ? { directory } : {}) })
      if (broken) return Promise.reject(new Error("store busy"))
      return Promise.resolve(rows as never)
    },
  } satisfies ACPHistoryStore.Reader
}

const sdk = {} as unknown as OrigamiClient

const row = (id: string, input: number, output: number, read: number, write: number) => ({
  id,
  tokens: { input, output, cache: { read, write } },
})

describe("cache_stats service method", () => {
  it("answers this session's own totals AND a lifetime sum, from ONE store read", async () => {
    const seen: unknown[] = []
    const service = ACPService.make({
      sdk,
      history: storeReader([row("ses_1", 100, 50, 10, 5), row("ses_2", 200, 80, 20, 0)], seen),
    })

    const result = await Effect.runPromise(service.cacheStats({ sessionId: "ses_1", cwd: "/workspace" }))

    expect(seen).toHaveLength(1)
    expect(result.sessionId).toBe("ses_1")
    expect(result.current).toEqual({ input: 100, output: 50, cacheRead: 10, cacheWrite: 5 })
    expect(result.lifetime).toEqual({ input: 300, output: 130, cacheRead: 30, cacheWrite: 5 })
    expect(result.sessionCount).toBe(2)
  })

  it("scopes the read to the session, and to the given directory only when one was supplied", async () => {
    const seen: unknown[] = []
    const history = storeReader([], seen)
    await Effect.runPromise(ACPService.make({ sdk, history }).cacheStats({ sessionId: "ses_1", cwd: "/workspace" }))
    await Effect.runPromise(ACPService.make({ sdk, history }).cacheStats({ sessionId: "ses_1" }))

    expect(seen).toEqual([{ sessionID: "ses_1", directory: "/workspace" }, { sessionID: "ses_1" }])
  })

  it("a failed read degrades to an empty answer instead of failing the call", async () => {
    const seen: unknown[] = []
    const result = await Effect.runPromise(
      ACPService.make({ sdk, history: storeReader([], seen, true) }).cacheStats({ sessionId: "ses_1" }),
    )

    expect(result).toEqual({
      sessionId: "ses_1",
      current: null,
      lifetime: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      sessionCount: 0,
    })
  })
})

describe("cache_stats ext dispatch", () => {
  const service = {
    cacheStats: (input: { sessionId: string; cwd?: string }) =>
      Effect.succeed({
        sessionId: input.sessionId,
        current: null,
        lifetime: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        sessionCount: 0,
      }),
  } as unknown as ACPService.Interface

  it("accepts the `_` wire prefix clients put on extension methods", async () => {
    const agent = new Agent(service)

    const prefixed = await agent.extMethod("_cache_stats", { sessionId: "ses_1" })
    const bare = await agent.extMethod("cache_stats", { sessionId: "ses_1" })

    expect(prefixed).toEqual(bare)
    expect(prefixed).toMatchObject({ sessionId: "ses_1" })
  })

  it("refuses a call with no sessionId rather than answering about some other chat", () => {
    const agent = new Agent(service)

    expect(() => agent.extMethod("_cache_stats", {})).toThrow()
    expect(() => agent.extMethod("_cache_stats", { sessionId: 7 })).toThrow()
  })
})
