import { describe, expect, test } from "bun:test"
import type { SessionNotification } from "@agentclientprotocol/sdk"
import { LayerNode } from "@origami/core/effect/layer-node"
import { ProviderV2 } from "@origami/core/provider"
import { ModelV2 } from "@origami/core/model"
import { UsageService } from "@/acp/usage"
import { Provider } from "@/provider/provider"
import { Effect, Layer } from "effect"
import { it } from "../lib/effect"

const assistant = (
  input: Partial<UsageService.AssistantMessage> & Pick<UsageService.AssistantMessage, "cost">,
): UsageService.SessionMessage => ({
  info: {
    role: "assistant",
    providerID: "anthropic",
    modelID: "claude-sonnet",
    tokens: {
      input: 10,
      output: 20,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    ...input,
  },
})

const user = (): UsageService.SessionMessage => ({
  info: { role: "user" },
})

const assistantWithoutProvider = (): UsageService.SessionMessage => ({
  info: {
    role: "assistant",
    modelID: "claude-sonnet",
    cost: 1,
    tokens: {
      input: 10,
      output: 20,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  },
})

const model = (providerID: ProviderV2.ID, modelID: ModelV2.ID, context: number): Provider.Model => ({
  id: modelID,
  providerID,
  api: {
    id: modelID,
    url: "https://example.com",
    npm: "@ai-sdk/openai-compatible",
  },
  name: modelID,
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
  cost: {
    input: 0,
    output: 0,
    cache: { read: 0, write: 0 },
  },
  limit: {
    context,
    output: 4096,
  },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
})

const providers = (context = 128_000): Record<ProviderV2.ID, Provider.Info> => {
  const providerID = ProviderV2.ID.make("anthropic")
  const modelID = ModelV2.ID.make("claude-sonnet")
  return {
    [providerID]: {
      id: providerID,
      name: "Anthropic",
      source: "config",
      env: [],
      options: {},
      models: {
        [modelID]: model(providerID, modelID, context),
      },
    },
  }
}

const fakeLayer = (input: {
  readonly messages?: Effect.Effect<readonly UsageService.SessionMessage[], unknown>
  readonly providers?: (directory: string) => Effect.Effect<Record<ProviderV2.ID, Provider.Info>, unknown>
  readonly sessions?: Effect.Effect<readonly UsageService.SessionRow[], unknown>
}) =>
  LayerNode.compile(UsageService.node, [
    [
      UsageService.messageLoaderNode,
      Layer.succeed(
        UsageService.MessageLoader,
        UsageService.MessageLoader.of({
          messages: () => input.messages ?? Effect.succeed([]),
          ...(input.sessions ? { sessions: () => input.sessions! } : {}),
        }),
      ),
    ],
    [
      UsageService.contextLimitLoaderNode,
      Layer.succeed(
        UsageService.ContextLimitLoader,
        UsageService.ContextLimitLoader.of({
          providers: input.providers ?? (() => Effect.succeed(providers())),
        }),
      ),
    ],
  ])

const connection = (updates: SessionNotification[]) => ({
  sessionUpdate(params: SessionNotification) {
    updates.push(params)
    return Promise.resolve()
  },
})

describe("acp usage", () => {
  test("builds ACP Usage from assistant token shape", () => {
    expect(
      UsageService.buildUsage({
        cost: 0.02,
        tokens: {
          input: 100,
          output: 40,
          reasoning: 7,
          cache: { read: 11, write: 13 },
        },
      }),
    ).toEqual({
      inputTokens: 100,
      outputTokens: 40,
      thoughtTokens: 7,
      cachedReadTokens: 11,
      cachedWriteTokens: 13,
      totalTokens: 171,
    })
  })

  test("omits optional token fields when they are zero", () => {
    expect(
      UsageService.buildUsage({
        cost: 0,
        tokens: {
          input: 3,
          output: 4,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      }),
    ).toEqual({
      inputTokens: 3,
      outputTokens: 4,
      totalTokens: 7,
    })
  })

  test("finds the latest assistant message", () => {
    expect(
      UsageService.latestAssistantMessage([assistant({ cost: 1, modelID: "older" }), user(), assistant({ cost: 2 })]),
    ).toMatchObject({ cost: 2 })
  })

  test("calculates total session cost from assistant messages", () => {
    expect(UsageService.totalSessionCost([assistant({ cost: 1.25 }), user(), assistant({ cost: 2.5 })])).toBe(3.75)
  })

  it.effect("loads context limits from providers and caches by directory/provider/model", () => {
    const calls: string[] = []
    return Effect.gen(function* () {
      const usage = yield* UsageService.Service
      const first = yield* usage.contextLimit({
        directory: "/workspace",
        providerID: ProviderV2.ID.make("anthropic"),
        modelID: ModelV2.ID.make("claude-sonnet"),
      })
      const second = yield* usage.contextLimit({
        directory: "/workspace",
        providerID: ProviderV2.ID.make("anthropic"),
        modelID: ModelV2.ID.make("claude-sonnet"),
      })

      expect(first).toBe(200_000)
      expect(second).toBe(200_000)
      expect(calls).toEqual(["/workspace"])
    }).pipe(
      Effect.provide(
        fakeLayer({
          providers: (directory) =>
            Effect.sync(() => {
              calls.push(directory)
              return providers(200_000)
            }),
        }),
      ),
    )
  })

  it.effect("sends ACP usage_update with context size and cumulative assistant cost", () => {
    const updates: SessionNotification[] = []
    return Effect.gen(function* () {
      const usage = yield* UsageService.Service
      yield* usage.sendUpdate({
        connection: connection(updates),
        sessionID: "ses_1",
        directory: "/workspace",
      })

      // The latest assistant message carries cache.read: 5 - threaded through
      // to _meta.cache alongside the parent-only used/size/cost fields.
      expect(updates).toEqual([
        {
          sessionId: "ses_1",
          update: {
            sessionUpdate: "usage_update",
            used: 15,
            size: 128_000,
            cost: { amount: 3, currency: "USD" },
            _meta: { cache: { read: 5, write: 0 } },
          },
        },
      ])
    }).pipe(
      Effect.provide(
        fakeLayer({
          messages: Effect.succeed([
            assistant({ cost: 1 }),
            assistant({
              cost: 2,
              tokens: {
                input: 10,
                output: 20,
                reasoning: 0,
                cache: { read: 5, write: 0 },
              },
            }),
          ]),
        }),
      ),
    )
  })

  describe("subagent rollup", () => {
    const row = (
      id: string,
      parentID: string | undefined,
      cost: number,
      input: number,
      output: number,
    ): UsageService.SessionRow => ({
      id,
      ...(parentID ? { parentID } : {}),
      cost,
      tokens: { input, output },
    })

    test("sums every descendant, not just direct children", () => {
      expect(
        UsageService.subagentTotals(
          [
            row("ses_root", undefined, 100, 1000, 1000),
            row("ses_child", "ses_root", 1, 10, 20),
            row("ses_grandchild", "ses_child", 2, 30, 40),
          ],
          "ses_root",
        ),
      ).toEqual({ cost: 3, tokensInput: 40, tokensOutput: 60 })
    })

    test("excludes the root's own spend — that is already the `cost` field, so counting it here would double", () => {
      const totals = UsageService.subagentTotals(
        [row("ses_root", undefined, 100, 1000, 1000), row("ses_child", "ses_root", 1, 10, 20)],
        "ses_root",
      )
      expect(totals).toEqual({ cost: 1, tokensInput: 10, tokensOutput: 20 })
    })

    test("ignores sessions belonging to a different parent", () => {
      expect(
        UsageService.subagentTotals(
          [row("ses_child", "ses_root", 1, 10, 20), row("ses_other", "ses_elsewhere", 9, 90, 90)],
          "ses_root",
        ),
      ).toEqual({ cost: 1, tokensInput: 10, tokensOutput: 20 })
    })

    test("returns undefined with no children, so the field is OMITTED rather than reported as zeros", () => {
      expect(UsageService.subagentTotals([row("ses_root", undefined, 5, 50, 50)], "ses_root")).toBeUndefined()
      expect(UsageService.subagentTotals([], "ses_root")).toBeUndefined()
    })

    test("survives a parent cycle instead of spinning", () => {
      const rows = [row("ses_a", "ses_b", 1, 1, 1), row("ses_b", "ses_a", 2, 2, 2)]
      expect(UsageService.subagentTotals(rows, "ses_a")).toEqual({ cost: 2, tokensInput: 2, tokensOutput: 2 })
    })

    test("tolerates rows with no cost/tokens at all", () => {
      expect(UsageService.subagentTotals([{ id: "ses_child", parentID: "ses_root" }], "ses_root")).toEqual({
        cost: 0,
        tokensInput: 0,
        tokensOutput: 0,
      })
    })

    test("buildUsageUpdate keeps the existing fields parent-only and rides _meta for the rollup", () => {
      expect(
        UsageService.buildUsageUpdate({
          used: 15,
          size: 128_000,
          cost: 3,
          subagents: { cost: 1, tokensInput: 10, tokensOutput: 20 },
        }),
      ).toEqual({
        sessionUpdate: "usage_update",
        used: 15,
        size: 128_000,
        cost: { amount: 3, currency: "USD" },
        _meta: { subagents: { cost: 1, tokensInput: 10, tokensOutput: 20 } },
      })
    })

    test("buildUsageUpdate omits _meta entirely when there are no subagents", () => {
      expect(UsageService.buildUsageUpdate({ used: 1, size: 2, cost: 3 })).toEqual({
        sessionUpdate: "usage_update",
        used: 1,
        size: 2,
        cost: { amount: 3, currency: "USD" },
      })
    })

    test("buildUsageUpdate rides cache read/write under _meta.cache, alongside subagents", () => {
      expect(
        UsageService.buildUsageUpdate({
          used: 15,
          size: 128_000,
          cost: 3,
          subagents: { cost: 1, tokensInput: 10, tokensOutput: 20 },
          cacheReadTokens: 11,
          cacheWriteTokens: 13,
        }),
      ).toEqual({
        sessionUpdate: "usage_update",
        used: 15,
        size: 128_000,
        cost: { amount: 3, currency: "USD" },
        _meta: {
          subagents: { cost: 1, tokensInput: 10, tokensOutput: 20 },
          cache: { read: 11, write: 13 },
        },
      })
    })

    test("buildUsageUpdate reports cache even with no subagents at all", () => {
      expect(UsageService.buildUsageUpdate({ used: 1, size: 2, cost: 3, cacheReadTokens: 4, cacheWriteTokens: 0 })).toEqual({
        sessionUpdate: "usage_update",
        used: 1,
        size: 2,
        cost: { amount: 3, currency: "USD" },
        _meta: { cache: { read: 4, write: 0 } },
      })
    })

    test("buildUsageUpdate omits _meta.cache when both read and write are zero", () => {
      const update = UsageService.buildUsageUpdate({
        used: 1,
        size: 2,
        cost: 3,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      })
      expect(update).toEqual({ sessionUpdate: "usage_update", used: 1, size: 2, cost: { amount: 3, currency: "USD" } })
      expect(update).not.toHaveProperty("_meta")
    })

    it.effect("child spend reaches the client in the usage_update", () => {
      const updates: SessionNotification[] = []
      return Effect.gen(function* () {
        const usage = yield* UsageService.Service
        yield* usage.sendUpdate({ connection: connection(updates), sessionID: "ses_1", directory: "/workspace" })

        expect(updates[0]?.update).toMatchObject({
          sessionUpdate: "usage_update",
          cost: { amount: 3, currency: "USD" },
          _meta: { subagents: { cost: 0.5, tokensInput: 70, tokensOutput: 90 } },
        })
      }).pipe(
        Effect.provide(
          fakeLayer({
            messages: Effect.succeed([assistant({ cost: 1 }), assistant({ cost: 2 })]),
            sessions: Effect.succeed([
              row("ses_1", undefined, 3, 999, 999),
              row("ses_kid", "ses_1", 0.25, 10, 20),
              row("ses_grandkid", "ses_kid", 0.25, 60, 70),
            ]),
          }),
        ),
      )
    })

    it.effect("a failed session listing costs the rollup only — the gauge still goes out", () => {
      const updates: SessionNotification[] = []
      return Effect.gen(function* () {
        const usage = yield* UsageService.Service
        yield* usage.sendUpdate({ connection: connection(updates), sessionID: "ses_1", directory: "/workspace" })

        expect(updates).toHaveLength(1)
        expect(updates[0]?.update).toMatchObject({ sessionUpdate: "usage_update", used: 10, size: 128_000 })
        expect(updates[0]?.update).not.toHaveProperty("_meta")
      }).pipe(
        Effect.provide(
          fakeLayer({
            messages: Effect.succeed([assistant({ cost: 1 })]),
            sessions: Effect.fail(new Error("listing exploded")),
          }),
        ),
      )
    })
  })

  describe("cacheStatsFromRows", () => {
    const cacheRow = (id: string, input: number, output: number, read: number, write: number): UsageService.SessionRow => ({
      id,
      tokens: { input, output, cache: { read, write } },
    })

    test("current is this session's own row; lifetime sums every row (flat, not a tree walk)", () => {
      const result = UsageService.cacheStatsFromRows(
        [cacheRow("ses_1", 100, 50, 10, 5), cacheRow("ses_2", 200, 80, 20, 0)],
        "ses_1",
      )
      expect(result.current).toEqual({ input: 100, output: 50, cacheRead: 10, cacheWrite: 5 })
      expect(result.lifetime).toEqual({ input: 300, output: 130, cacheRead: 30, cacheWrite: 5 })
      expect(result.sessionCount).toBe(2)
    })

    test("current is null when the session's own row is not in the listing, lifetime is still real", () => {
      const result = UsageService.cacheStatsFromRows([cacheRow("ses_other", 10, 10, 1, 1)], "ses_missing")
      expect(result.current).toBeNull()
      expect(result.lifetime).toEqual({ input: 10, output: 10, cacheRead: 1, cacheWrite: 1 })
      expect(result.sessionCount).toBe(1)
    })

    test("a subagent's spend counts toward the lifetime too — no parent-only exclusion here", () => {
      // Unlike subagentTotals, cacheStatsFromRows has no "root" to skip: every
      // row the caller passed (roots: false) is summed once.
      const result = UsageService.cacheStatsFromRows(
        [cacheRow("ses_root", 100, 100, 10, 10), cacheRow("ses_child", 20, 20, 2, 2)],
        "ses_root",
      )
      expect(result.lifetime).toEqual({ input: 120, output: 120, cacheRead: 12, cacheWrite: 12 })
    })

    test("tolerates rows with no tokens/cache field at all", () => {
      const result = UsageService.cacheStatsFromRows([{ id: "ses_bare" }], "ses_bare")
      expect(result.current).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
      expect(result.lifetime).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
    })

    test("an empty listing is a real (zero) lifetime, not null", () => {
      const result = UsageService.cacheStatsFromRows([], "ses_1")
      expect(result.current).toBeNull()
      expect(result.lifetime).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
      expect(result.sessionCount).toBe(0)
    })
  })

  describe("mid-turn throttle", () => {
    test("allows the FIRST call — a leading-edge gate, so the gauge moves on step one", () => {
      const throttle = UsageService.makeThrottle(2000)
      expect(throttle.allow("ses_1", 0)).toBe(true)
    })

    test("drops everything inside the window and allows again once it passes", () => {
      const throttle = UsageService.makeThrottle(2000)
      expect(throttle.allow("ses_1", 1_000)).toBe(true)
      expect(throttle.allow("ses_1", 1_500)).toBe(false)
      expect(throttle.allow("ses_1", 2_999)).toBe(false)
      expect(throttle.allow("ses_1", 3_000)).toBe(true)
      expect(throttle.allow("ses_1", 3_001)).toBe(false)
    })

    test("throttles per session — a busy session cannot starve a quiet one", () => {
      const throttle = UsageService.makeThrottle(2000)
      expect(throttle.allow("ses_1", 0)).toBe(true)
      expect(throttle.allow("ses_2", 0)).toBe(true)
      expect(throttle.allow("ses_1", 100)).toBe(false)
      expect(throttle.allow("ses_2", 100)).toBe(false)
    })
  })

  it.effect("skips usage update when messages cannot be fetched", () => {
    const updates: SessionNotification[] = []
    return Effect.gen(function* () {
      const usage = yield* UsageService.Service
      yield* usage.sendUpdate({
        connection: connection(updates),
        sessionID: "ses_1",
        directory: "/workspace",
      })

      expect(updates).toEqual([])
    }).pipe(Effect.provide(fakeLayer({ messages: Effect.fail(new Error("boom")) })))
  })

  it.effect("skips usage update when no assistant message exists", () => {
    const updates: SessionNotification[] = []
    return Effect.gen(function* () {
      const usage = yield* UsageService.Service
      yield* usage.sendUpdate({
        connection: connection(updates),
        sessionID: "ses_1",
        directory: "/workspace",
      })

      expect(updates).toEqual([])
    }).pipe(Effect.provide(fakeLayer({ messages: Effect.succeed([user()]) })))
  })

  it.effect("skips usage update when assistant message has no provider or model", () => {
    const updates: SessionNotification[] = []
    return Effect.gen(function* () {
      const usage = yield* UsageService.Service
      yield* usage.sendUpdate({
        connection: connection(updates),
        sessionID: "ses_1",
        directory: "/workspace",
      })

      expect(updates).toEqual([])
    }).pipe(
      Effect.provide(
        fakeLayer({
          messages: Effect.succeed([assistantWithoutProvider()]),
        }),
      ),
    )
  })

  it.effect("skips usage update when context size is unknown", () => {
    const updates: SessionNotification[] = []
    return Effect.gen(function* () {
      const usage = yield* UsageService.Service
      yield* usage.sendUpdate({
        connection: connection(updates),
        sessionID: "ses_1",
        directory: "/workspace",
      })

      expect(updates).toEqual([])
    }).pipe(
      Effect.provide(
        fakeLayer({
          messages: Effect.succeed([assistant({ cost: 1, providerID: "missing" })]),
        }),
      ),
    )
  })
})
