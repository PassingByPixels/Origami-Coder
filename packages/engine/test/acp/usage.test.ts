import { describe, expect, test } from "bun:test"
import type { SessionNotification } from "@agentclientprotocol/sdk"
import { ProviderV2 } from "@origami/core/provider"
import { ModelV2 } from "@origami/core/model"
import type { OrigamiClient, Part } from "@origami/sdk/v2"
import { UsageService } from "@/acp/usage"
import type { ACPHistoryStore } from "@/acp/history-store"
import { Provider } from "@/provider/provider"
import { Effect } from "effect"

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

/**
 * Builds the sdk stub and calls `UsageService.makeUsageService` with it — the
 * EXACT function `acp/service.ts` falls back to when `ACPService.make` gets no
 * `usage` injected (`input.usage ?? UsageService.makeUsageService(input.sdk,
 * readCapture)`), which is what `acp/agent.ts` always does live. t-s93cw2: this
 * replaces a second, Effect-Context-service `sendUpdate`/`contextLimit` this file
 * used to build and inject via `fakeLayer` — a builder `ACPService.make` never
 * ran, so a passing test here proved nothing about the product.
 *
 * A rejected `messages`/`sessions` promise reproduces what the old fake layer's
 * `Effect.fail` did: `makeUsageService` wraps both sdk calls in `Effect.tryPromise`
 * and catches into the same "hold the gauge" fallback.
 */
function usageServiceFor(input: {
  readonly messages?: () => Promise<readonly UsageService.SessionMessage[]>
  readonly sessions?: () => Promise<readonly UsageService.SessionRow[]>
  /** The session's own row, which carries the running cost (t-u1j4jm). */
  readonly row?: UsageService.SessionRow | Error
  readonly providers?: (directory: string) => Promise<Record<ProviderV2.ID, Provider.Info>>
  /** Every messages read: the limit asked for and how many messages came back. */
  readonly reads?: Array<{ limit?: number; returned: number }>
}) {
  const sdk = {
    session: {
      // The endpoint's paging: `limit` newest messages, oldest first, with the
      // cursor to the older rest in `x-next-cursor` (handlers/session.ts).
      // Here the cursor is simply the index where the older rest ends.
      messages: (params: { limit?: number; before?: string }) =>
        (input.messages ? input.messages() : Promise.resolve([])).then((all) => {
          if (!params.limit) {
            input.reads?.push({ returned: all.length })
            return { data: all }
          }
          const end = params.before === undefined ? all.length : Number(params.before)
          const start = Math.max(0, end - params.limit)
          const headers = new Headers(start > 0 ? { "x-next-cursor": String(start) } : {})
          input.reads?.push({ limit: params.limit, returned: end - start })
          return { data: all.slice(start, end), response: { headers } }
        }),
      get: (params: { sessionID: string }) =>
        input.row instanceof Error
          ? Promise.reject(input.row)
          : Promise.resolve({ data: input.row ?? { id: params.sessionID, cost: 0 } }),
    },
    config: {
      providers: (params: { directory: string }) =>
        (input.providers ? input.providers(params.directory) : Promise.resolve(providers())).then((record) => ({
          data: { providers: Object.values(record) },
        })),
    },
  } as unknown as OrigamiClient
  // t-ucndru. The roll-up's rows come from the store's descendants read, not
  // `session.list`: `sessions` feeds that reader here, as the store would.
  const history = {
    descendants: () =>
      (input.sessions ? input.sessions() : Promise.resolve([])).then((rows) => ({
        rows: rows.map((row) => ({
          id: row.id,
          parentId: row.parentID,
          cost: row.cost ?? 0,
          tokens: { input: row.tokens?.input ?? 0, output: row.tokens?.output ?? 0 },
        })) as unknown as ACPHistoryStore.Descendants["rows"],
        truncated: false,
      })),
  }
  return UsageService.makeUsageService(sdk, () => null, history)
}

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

  // The multi-step under-report. `session/processor.ts` ASSIGNS
  // `message.tokens` at every step-finish rather than accumulating it, because
  // the context gauge and the overflow check both need "how full is the window
  // right now". Reporting that back to the client as the TURN's usage therefore
  // bills only the last call of a tool loop.
  const ids = (n: number) => ({ id: `prt_${n}`, sessionID: "ses_a", messageID: "msg_a1" })

  let stepSeq = 0
  const step = (input: {
    input: number
    output: number
    reasoning?: number
    read?: number
    write?: number
  }): Part =>
    ({
      ...ids(++stepSeq),
      type: "step-finish",
      reason: "tool-calls",
      cost: 0,
      tokens: {
        input: input.input,
        output: input.output,
        reasoning: input.reasoning ?? 0,
        cache: { read: input.read ?? 0, write: input.write ?? 0 },
      },
    }) as unknown as Part

  /** A step-finish that reported no usage at all — the "unmeasured" case. */
  const unmeasuredStep = (): Part =>
    ({ ...ids(++stepSeq), type: "step-finish", reason: "stop", cost: 0 }) as unknown as Part

  const text = (): Part => ({ ...ids(++stepSeq), type: "text", text: "thinking" }) as unknown as Part

  test("sums the step-finish parts of a turn rather than reporting its last step", () => {
    const usage = UsageService.buildUsage(
      // What the message says: the last step alone.
      { cost: 0.03, tokens: { input: 1_400, output: 70, reasoning: 7, cache: { read: 1_300, write: 0 } } },
      [
        text(),
        step({ input: 1_000, output: 50, reasoning: 5, read: 900, write: 10 }),
        step({ input: 1_400, output: 70, reasoning: 7, read: 1_300, write: 0 }),
      ],
    )

    expect(usage).toEqual({
      inputTokens: 2_400,
      outputTokens: 120,
      thoughtTokens: 12,
      cachedReadTokens: 2_200,
      cachedWriteTokens: 10,
      totalTokens: 4_742,
    })
  })

  test("falls back to the message totals when the turn carries no step-finish part", () => {
    // Older rows and foreign transcripts have none. A stale reading beats a
    // blank one; a fabricated zero would be worse than both.
    expect(
      UsageService.buildUsage(
        { cost: 0.01, tokens: { input: 100, output: 40, reasoning: 7, cache: { read: 11, write: 13 } } },
        [text()],
      ),
    ).toEqual({
      inputTokens: 100,
      outputTokens: 40,
      thoughtTokens: 7,
      cachedReadTokens: 11,
      cachedWriteTokens: 13,
      totalTokens: 171,
    })
  })

  test("a step that measured nothing is skipped, not counted as zero", () => {
    expect(
      UsageService.sumStepFinishTokens([
        unmeasuredStep(),
        step({ input: 300, output: 12 }),
      ]),
    ).toEqual({ input: 300, output: 12, reasoning: 0, cache: { read: 0, write: 0 } })
  })

  test("no usable step-finish part is UNDEFINED, so the caller can tell it from a zero turn", () => {
    expect(UsageService.sumStepFinishTokens(undefined)).toBeUndefined()
    expect(UsageService.sumStepFinishTokens([])).toBeUndefined()
    expect(UsageService.sumStepFinishTokens([unmeasuredStep()])).toBeUndefined()
  })

  test("finds the latest assistant message", () => {
    expect(
      UsageService.latestAssistantMessage([assistant({ cost: 1, modelID: "older" }), user(), assistant({ cost: 2 })]),
    ).toMatchObject({ cost: 2 })
  })

  test("calculates total session cost from assistant messages", () => {
    expect(UsageService.totalSessionCost([assistant({ cost: 1.25 }), user(), assistant({ cost: 2.5 })])).toBe(3.75)
  })

  test("loads context limits from providers and caches by directory/provider/model", async () => {
    const calls: string[] = []
    const usage = usageServiceFor({
      providers: (directory) => {
        calls.push(directory)
        return Promise.resolve(providers(200_000))
      },
    })

    const first = await Effect.runPromise(
      usage.contextLimit({
        directory: "/workspace",
        providerID: ProviderV2.ID.make("anthropic"),
        modelID: ModelV2.ID.make("claude-sonnet"),
      }),
    )
    const second = await Effect.runPromise(
      usage.contextLimit({
        directory: "/workspace",
        providerID: ProviderV2.ID.make("anthropic"),
        modelID: ModelV2.ID.make("claude-sonnet"),
      }),
    )

    expect(first).toBe(200_000)
    expect(second).toBe(200_000)
    expect(calls).toEqual(["/workspace"])
  })

  // t-tijhw6 (scout B #14). A failed providers read, or a read made before the
  // provider had started (so the model was not in the list), was kept as
  // "no limit" for the connection's lifetime: the context gauge never came
  // back. Only a found limit is kept; anything else is read again next time.
  test("a failed or empty context-limit read is not kept", async () => {
    const params = {
      directory: "/workspace",
      providerID: ProviderV2.ID.make("anthropic"),
      modelID: ModelV2.ID.make("claude-sonnet"),
    }
    const answers: Array<() => Promise<Record<ProviderV2.ID, Provider.Info>>> = [
      () => Promise.reject(new Error("engine unavailable")),
      () => Promise.resolve({} as Record<ProviderV2.ID, Provider.Info>),
      () => Promise.resolve(providers(200_000)),
    ]
    let calls = 0
    const usage = usageServiceFor({ providers: () => answers[calls++]!() })

    expect(await Effect.runPromise(usage.contextLimit(params))).toBeUndefined()
    expect(await Effect.runPromise(usage.contextLimit(params))).toBeUndefined()
    expect(await Effect.runPromise(usage.contextLimit(params))).toBe(200_000)
    // A found limit is kept.
    expect(await Effect.runPromise(usage.contextLimit(params))).toBe(200_000)
    expect(calls).toBe(3)
  })

  test("sends ACP usage_update with context size and the session row's cumulative cost", async () => {
    const updates: SessionNotification[] = []
    const usage = usageServiceFor({
      messages: () =>
        Promise.resolve([
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
      row: { id: "ses_1", cost: 3 },
    })

    await Effect.runPromise(
      usage.sendUpdate({
        connection: connection(updates),
        sessionID: "ses_1",
        directory: "/workspace",
      }),
    )

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

    test("child spend reaches the client in the usage_update", async () => {
      const updates: SessionNotification[] = []
      const usage = usageServiceFor({
        messages: () => Promise.resolve([assistant({ cost: 1 }), assistant({ cost: 2 })]),
        row: { id: "ses_1", cost: 3 },
        sessions: () =>
          Promise.resolve([
            row("ses_1", undefined, 3, 999, 999),
            row("ses_kid", "ses_1", 0.25, 10, 20),
            row("ses_grandkid", "ses_kid", 0.25, 60, 70),
          ]),
      })

      await Effect.runPromise(usage.sendUpdate({ connection: connection(updates), sessionID: "ses_1", directory: "/workspace" }))

      expect(updates[0]?.update).toMatchObject({
        sessionUpdate: "usage_update",
        cost: { amount: 3, currency: "USD" },
        _meta: { subagents: { cost: 0.5, tokensInput: 70, tokensOutput: 90 } },
      })
    })

    test("a failed descendants read costs the rollup only — the gauge still goes out", async () => {
      const updates: SessionNotification[] = []
      const usage = usageServiceFor({
        messages: () => Promise.resolve([assistant({ cost: 1 })]),
        sessions: () => Promise.reject(new Error("listing exploded")),
      })

      await Effect.runPromise(usage.sendUpdate({ connection: connection(updates), sessionID: "ses_1", directory: "/workspace" }))

      expect(updates).toHaveLength(1)
      expect(updates[0]?.update).toMatchObject({ sessionUpdate: "usage_update", used: 10, size: 128_000 })
      expect(updates[0]?.update).not.toHaveProperty("_meta")
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

  // t-u1j4jm. The whole-session read after every turn froze the engine for
  // seconds on a 150 MB session.
  describe("bounded read", () => {
    // 1,000 messages; the newest is an assistant whose input + cache.read = 10.
    const long = () => [
      ...Array.from({ length: 999 }, (_, i) => (i % 2 ? assistant({ cost: 1 }) : user())),
      assistant({ cost: 1, tokens: { input: 7, output: 1, reasoning: 0, cache: { read: 3, write: 0 } } }),
    ]

    test("a long session is read one newest message deep when that message is the assistant", async () => {
      const updates: SessionNotification[] = []
      const reads: Array<{ limit?: number; returned: number }> = []
      const usage = usageServiceFor({ messages: () => Promise.resolve(long()), row: { id: "ses_1", cost: 500 }, reads })

      await Effect.runPromise(usage.sendUpdate({ connection: connection(updates), sessionID: "ses_1", directory: "/workspace" }))

      expect(reads).toEqual([{ limit: 1, returned: 1 }])
      expect(updates[0]?.update).toMatchObject({ used: 10, cost: { amount: 500, currency: "USD" } })
    })

    test("newer user messages are walked past, back to the latest assistant", async () => {
      const updates: SessionNotification[] = []
      const reads: Array<{ limit?: number; returned: number }> = []
      const usage = usageServiceFor({ messages: () => Promise.resolve([...long(), user(), user()]), reads })

      await Effect.runPromise(usage.sendUpdate({ connection: connection(updates), sessionID: "ses_1", directory: "/workspace" }))

      expect(reads.every((read) => read.limit !== undefined)).toBe(true)
      expect(reads.reduce((sum, read) => sum + read.returned, 0)).toBe(3)
      expect(updates[0]?.update).toMatchObject({ used: 10 })
    })

    test("a failed session-row read sends nothing rather than a zero cost", async () => {
      const updates: SessionNotification[] = []
      const usage = usageServiceFor({ messages: () => Promise.resolve([assistant({ cost: 1 })]), row: new Error("gone") })

      await Effect.runPromise(usage.sendUpdate({ connection: connection(updates), sessionID: "ses_1", directory: "/workspace" }))

      expect(updates).toEqual([])
    })
  })

  test("skips usage update when messages cannot be fetched", async () => {
    const updates: SessionNotification[] = []
    const usage = usageServiceFor({ messages: () => Promise.reject(new Error("boom")) })

    await Effect.runPromise(
      usage.sendUpdate({ connection: connection(updates), sessionID: "ses_1", directory: "/workspace" }),
    )

    expect(updates).toEqual([])
  })

  test("skips usage update when no assistant message exists", async () => {
    const updates: SessionNotification[] = []
    const usage = usageServiceFor({ messages: () => Promise.resolve([user()]) })

    await Effect.runPromise(
      usage.sendUpdate({ connection: connection(updates), sessionID: "ses_1", directory: "/workspace" }),
    )

    expect(updates).toEqual([])
  })

  test("skips usage update when assistant message has no provider or model", async () => {
    const updates: SessionNotification[] = []
    const usage = usageServiceFor({ messages: () => Promise.resolve([assistantWithoutProvider()]) })

    await Effect.runPromise(
      usage.sendUpdate({ connection: connection(updates), sessionID: "ses_1", directory: "/workspace" }),
    )

    expect(updates).toEqual([])
  })

  test("skips usage update when context size is unknown", async () => {
    const updates: SessionNotification[] = []
    const usage = usageServiceFor({ messages: () => Promise.resolve([assistant({ cost: 1, providerID: "missing" })]) })

    await Effect.runPromise(
      usage.sendUpdate({ connection: connection(updates), sessionID: "ses_1", directory: "/workspace" }),
    )

    expect(updates).toEqual([])
  })
})
