// `cache_stats` — this session's prompt-cache token accounting plus a
// lifetime sum over session.list, for the Insights cache-hit-ratio card
// (t-kgtw47). The bugs worth catching: reading roots:true (which would drop a
// subagent's own cache spend from the lifetime), and a failed listing failing
// the whole call instead of degrading the way the usage_update rollup does.

import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import type { OrigamiClient } from "@origami/sdk/v2"
import * as ACPService from "@/acp/service"
import { Agent } from "@/acp/agent"

function listSdk(rows: unknown[], seen: unknown[], broken = false) {
  return {
    session: {
      list: (params: unknown) => {
        seen.push(params)
        if (broken) return Promise.reject(new Error("listing exploded"))
        return Promise.resolve({ data: rows })
      },
    },
  } as unknown as OrigamiClient
}

const row = (id: string, input: number, output: number, read: number, write: number) => ({
  id,
  tokens: { input, output, cache: { read, write } },
})

describe("cache_stats service method", () => {
  it("answers this session's own totals AND a lifetime sum, from ONE session.list call", async () => {
    const seen: unknown[] = []
    const service = ACPService.make({
      sdk: listSdk([row("ses_1", 100, 50, 10, 5), row("ses_2", 200, 80, 20, 0)], seen),
    })

    const result = await Effect.runPromise(service.cacheStats({ sessionId: "ses_1", cwd: "/workspace" }))

    expect(seen).toHaveLength(1)
    expect(result.sessionId).toBe("ses_1")
    expect(result.current).toEqual({ input: 100, output: 50, cacheRead: 10, cacheWrite: 5 })
    expect(result.lifetime).toEqual({ input: 300, output: 130, cacheRead: 30, cacheWrite: 5 })
    expect(result.sessionCount).toBe(2)
  })

  it("reads with roots:false, so a subagent's own cache spend is not dropped from the lifetime", async () => {
    const seen: unknown[] = []
    await Effect.runPromise(ACPService.make({ sdk: listSdk([], seen) }).cacheStats({ sessionId: "ses_1" }))

    expect(seen).toEqual([{ roots: false }])
  })

  it("scopes the read to the given directory, and omits it when none was supplied", async () => {
    const seen: unknown[] = []
    const sdk = listSdk([], seen)
    await Effect.runPromise(ACPService.make({ sdk }).cacheStats({ sessionId: "ses_1", cwd: "/workspace" }))
    await Effect.runPromise(ACPService.make({ sdk }).cacheStats({ sessionId: "ses_1" }))

    expect(seen).toEqual([
      { directory: "/workspace", roots: false },
      { roots: false },
    ])
  })

  it("a failed listing degrades to an empty answer instead of failing the call", async () => {
    const seen: unknown[] = []
    const result = await Effect.runPromise(
      ACPService.make({ sdk: listSdk([], seen, true) }).cacheStats({ sessionId: "ses_1" }),
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
