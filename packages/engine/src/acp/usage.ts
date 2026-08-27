import type { AgentSideConnection, Usage } from "@agentclientprotocol/sdk"
import type { AssistantMessage as OrigamiAssistantMessage, Message } from "@origami/sdk/v2"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { makeGlobalNode, Node } from "@origami/core/effect/app-node"
import { LayerNode } from "@origami/core/effect/layer-node"
import { ProviderV2 } from "@origami/core/provider"
import { ModelV2 } from "@origami/core/model"
import { Provider } from "@/provider/provider"
import { Context, Effect, Layer, SynchronizedRef } from "effect"

export type AssistantTokenCost = Pick<OrigamiAssistantMessage, "cost" | "tokens">

export type AssistantMessage = AssistantTokenCost &
  Pick<OrigamiAssistantMessage, "role"> &
  Partial<Pick<OrigamiAssistantMessage, "providerID" | "modelID">>

export type SessionMessage = {
  readonly info: { readonly role: Message["role"] } | AssistantMessage
}

export type MessagesInput = {
  readonly sessionID: string
  readonly directory: string
}

/**
 * The fields of a session row this module needs. The engine's projector keeps
 * `cost`/`tokens` as RUNNING TOTALS per session (core/session/projector.ts
 * applyUsage adds each step-finish onto the row), and a subagent's spend lands
 * on the subagent's OWN row - never the parent's - so summing descendant rows
 * cannot double count the parent's messages.
 */
export type SessionRow = {
  readonly id: string
  readonly parentID?: string
  readonly cost?: number
  readonly tokens?: {
    readonly input: number
    readonly output: number
    /** Absent on a caller that never populates it (the subagent-rollup test
     *  fixtures, e.g.) - treated as zero, never as "unknown". */
    readonly cache?: {
      readonly read: number
      readonly write: number
    }
  }
}

/** Additive rollup of every descendant session's spend. */
export type SubagentTotals = {
  readonly cost: number
  readonly tokensInput: number
  readonly tokensOutput: number
}

export type SDK = {
  readonly session: {
    readonly messages: (
      parameters: { readonly sessionID: string; readonly directory: string },
      options: { readonly throwOnError: true },
    ) => Promise<{ readonly data?: readonly SessionMessage[] | null }>
    readonly list: (
      parameters: { readonly directory: string; readonly roots: false },
      options: { readonly throwOnError: true },
    ) => Promise<{ readonly data?: readonly SessionRow[] | null }>
  }
}

export interface MessageLoaderInterface {
  readonly messages: (input: MessagesInput) => Effect.Effect<readonly SessionMessage[], unknown>
  /**
   * Session rows for a directory, used for the subagent rollup. OPTIONAL: a
   * loader that cannot list sessions simply produces an update without the
   * rollup rather than failing the whole usage report.
   */
  readonly sessions?: (input: { readonly directory: string }) => Effect.Effect<readonly SessionRow[], unknown>
}

export interface ContextLimitLoaderInterface {
  readonly providers: (directory: string) => Effect.Effect<Record<ProviderV2.ID, Provider.Info>, unknown>
}

export type UsageConnection = Pick<AgentSideConnection, "sessionUpdate">

export interface Interface {
  readonly buildUsage: (message: AssistantTokenCost) => Usage
  readonly latestAssistantMessage: (messages: readonly SessionMessage[]) => AssistantMessage | undefined
  readonly totalSessionCost: (messages: readonly SessionMessage[]) => number
  readonly contextLimit: (input: {
    readonly directory: string
    readonly providerID: ProviderV2.ID
    readonly modelID: ModelV2.ID
  }) => Effect.Effect<number | undefined>
  readonly sendUpdate: (input: {
    readonly connection: UsageConnection
    readonly sessionID: string
    readonly directory: string
  }) => Effect.Effect<void>
}

export class MessageLoader extends Context.Service<MessageLoader, MessageLoaderInterface>()(
  "@origami/ACPUsageMessageLoader",
) {}

export class ContextLimitLoader extends Context.Service<ContextLimitLoader, ContextLimitLoaderInterface>()(
  "@origami/ACPUsageContextLimitLoader",
) {}

export class Service extends Context.Service<Service, Interface>()("@origami/ACPUsage") {}

export function messageLoaderFromSDK(sdk: SDK): MessageLoaderInterface {
  return MessageLoader.of({
    messages: (input) =>
      Effect.promise(() =>
        sdk.session
          .messages({ sessionID: input.sessionID, directory: input.directory }, { throwOnError: true })
          .then((response) => response.data ?? []),
      ),
    // roots:false so subagent sessions - which is the entire point of the
    // rollup - are in the listing at all.
    sessions: (input) =>
      Effect.promise(() =>
        sdk.session
          .list({ directory: input.directory, roots: false }, { throwOnError: true })
          .then((response) => response.data ?? []),
      ),
  })
}

export const messageLoaderLayer = (sdk: SDK) => Layer.succeed(MessageLoader, messageLoaderFromSDK(sdk))

export function buildUsage(message: AssistantTokenCost): Usage {
  const cachedReadTokens = message.tokens.cache.read
  const cachedWriteTokens = message.tokens.cache.write
  const thoughtTokens = message.tokens.reasoning

  return {
    inputTokens: message.tokens.input,
    outputTokens: message.tokens.output,
    totalTokens: message.tokens.input + message.tokens.output + thoughtTokens + cachedReadTokens + cachedWriteTokens,
    ...(thoughtTokens > 0 ? { thoughtTokens } : {}),
    ...(cachedReadTokens > 0 ? { cachedReadTokens } : {}),
    ...(cachedWriteTokens > 0 ? { cachedWriteTokens } : {}),
  }
}

export function latestAssistantMessage(messages: readonly SessionMessage[]): AssistantMessage | undefined {
  return messages
    .filter((message): message is { readonly info: AssistantMessage } => message.info.role === "assistant")
    .at(-1)?.info
}

export function totalSessionCost(messages: readonly SessionMessage[]): number {
  return messages
    .filter((message): message is { readonly info: AssistantMessage } => message.info.role === "assistant")
    .reduce((sum, message) => sum + message.info.cost, 0)
}

/**
 * Sum the spend of every session DESCENDED from `rootID` - the task tool's
 * children, their children, and so on - following `parentID`.
 *
 * Returns `undefined` when there are no descendants, so the caller OMITS the
 * field rather than publishing zeros: a client can then tell "this turn used no
 * subagents" from "subagents ran and cost nothing", which zeros would conflate.
 *
 * Cycle-safe (a corrupted parent link cannot spin) and root-exclusive (the
 * parent's own spend is already reported by the existing `cost` field, so
 * including it here would double count).
 */
export function subagentTotals(rows: readonly SessionRow[], rootID: string): SubagentTotals | undefined {
  const children = new Map<string, SessionRow[]>()
  for (const row of rows) {
    if (!row.parentID || row.id === rootID) continue
    const bucket = children.get(row.parentID)
    if (bucket) bucket.push(row)
    else children.set(row.parentID, [row])
  }

  const seen = new Set<string>([rootID])
  const queue = [rootID]
  let cost = 0
  let tokensInput = 0
  let tokensOutput = 0
  let found = false

  while (queue.length > 0) {
    const current = queue.shift()!
    for (const child of children.get(current) ?? []) {
      if (seen.has(child.id)) continue
      seen.add(child.id)
      queue.push(child.id)
      found = true
      cost += child.cost ?? 0
      tokensInput += child.tokens?.input ?? 0
      tokensOutput += child.tokens?.output ?? 0
    }
  }

  return found ? { cost, tokensInput, tokensOutput } : undefined
}

/** One session's (or a lifetime SUM across many) token accounting, for the
 *  `cache_stats` ext method. */
export type SessionCacheTokens = {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

function zeroCacheTokens(): SessionCacheTokens {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}

function cacheTokensOf(row: SessionRow | undefined): SessionCacheTokens {
  return {
    input: row?.tokens?.input ?? 0,
    output: row?.tokens?.output ?? 0,
    cacheRead: row?.tokens?.cache?.read ?? 0,
    cacheWrite: row?.tokens?.cache?.write ?? 0,
  }
}

/**
 * Cache-token accounting for the `cache_stats` ext method: THIS session's own
 * totals (its row - a running total the projector already keeps, same source
 * `subagentTotals` reads) alongside a LIFETIME sum over every row the caller
 * passed in. The caller reads with `roots: false` so a subagent's own cache
 * spend counts toward the lifetime the same way `sendUpdate`'s rollup already
 * includes it.
 *
 * Same defensive `?? 0` destructuring as `subagentTotals`, but FLAT rather than
 * a parent-scoped tree walk: every row counts once, there is no "root" to
 * exclude.
 */
export function cacheStatsFromRows(
  rows: readonly SessionRow[],
  sessionID: string,
): {
  readonly current: SessionCacheTokens | null
  readonly lifetime: SessionCacheTokens
  readonly sessionCount: number
} {
  const own = rows.find((row) => row.id === sessionID)
  const lifetime = rows.reduce<SessionCacheTokens>((sum, row) => {
    const t = cacheTokensOf(row)
    return {
      input: sum.input + t.input,
      output: sum.output + t.output,
      cacheRead: sum.cacheRead + t.cacheRead,
      cacheWrite: sum.cacheWrite + t.cacheWrite,
    }
  }, zeroCacheTokens())
  return { current: own ? cacheTokensOf(own) : null, lifetime, sessionCount: rows.length }
}

/**
 * Build the `usage_update` payload. Shared by both `sendUpdate`
 * implementations (the Effect layer below and ACP's SDK-backed one in
 * service.ts) so the two can never disagree about what the client is told.
 *
 * `used`/`size`/`cost` keep their existing meaning - the PARENT session alone -
 * because clients already render them as the context gauge and this session's
 * bill. The subagent rollup and the cache breakdown are both strictly ADDITIVE
 * and ride `_meta` (the ACP-sanctioned extension bag, since `UsageUpdate` has
 * no typed slot for either), leaving the client free to add them in, show them
 * separately, or ignore them.
 *
 * `cacheReadTokens`/`cacheWriteTokens` mirror `buildUsage`'s own cache fields -
 * same source (`message.tokens.cache`), same "omit rather than publish a
 * fabricated zero" rule, bundled as ONE `_meta.cache` object (never one field
 * present without the other) so a consumer never has to guess whether a
 * missing write means zero or unmeasured.
 */
export function buildUsageUpdate(input: {
  readonly used: number
  readonly size: number
  readonly cost: number
  readonly subagents?: SubagentTotals
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
}) {
  const cacheRead = input.cacheReadTokens ?? 0
  const cacheWrite = input.cacheWriteTokens ?? 0
  const meta = {
    ...(input.subagents ? { subagents: input.subagents } : {}),
    ...(cacheRead > 0 || cacheWrite > 0 ? { cache: { read: cacheRead, write: cacheWrite } } : {}),
  }
  return {
    sessionUpdate: "usage_update" as const,
    used: input.used,
    size: input.size,
    cost: { amount: input.cost, currency: "USD" },
    ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
  }
}

/**
 * Leading-edge rate limiter, keyed per session.
 *
 * `allow` returns true the FIRST time a key is seen and then at most once per
 * `intervalMs`. Leading-edge on purpose: the point of a mid-turn update is that
 * the gauge moves as soon as the first step finishes, so the first call must
 * never be the one that gets dropped. Time is injected rather than read from
 * `Date.now()` so throttle behaviour is testable without sleeping.
 */
export function makeThrottle(intervalMs: number) {
  const last = new Map<string, number>()
  return {
    allow(key: string, now: number): boolean {
      const previous = last.get(key)
      if (previous !== undefined && now - previous < intervalMs) return false
      last.set(key, now)
      return true
    },
    forget(key: string) {
      last.delete(key)
    },
  }
}

export function findContextLimit(
  providers: Record<ProviderV2.ID, Provider.Info>,
  providerID: ProviderV2.ID,
  modelID: ModelV2.ID,
): number | undefined {
  return providers[providerID]?.models[modelID]?.limit.context
}

export const contextLimitLoaderLayer = Layer.effect(
  ContextLimitLoader,
  Effect.gen(function* () {
    const store = yield* InstanceStore.Service
    const provider = yield* Provider.Service

    return ContextLimitLoader.of({
      providers: Effect.fn("ACPUsageContextLimitLoader.providers")(function* (directory) {
        const ctx = yield* store.load({ directory })
        return yield* Effect.gen(function* () {
          return yield* provider.list()
        }).pipe(Effect.provideService(InstanceRef, ctx))
      }),
    })
  }),
)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const messageLoader = yield* MessageLoader
    const contextLimitLoader = yield* ContextLimitLoader
    const limits = yield* SynchronizedRef.make(new Map<string, Effect.Effect<number | undefined>>())

    const cachedLimit = Effect.fnUntraced(function* (input: {
      readonly directory: string
      readonly providerID: ProviderV2.ID
      readonly modelID: ModelV2.ID
    }) {
      return yield* SynchronizedRef.modifyEffect(
        limits,
        Effect.fnUntraced(function* (items) {
          const key = `${input.directory}\u0000${input.providerID}\u0000${input.modelID}`
          const current = items.get(key)
          if (current) return [current, items] as const
          const next = yield* Effect.cached(
            contextLimitLoader.providers(input.directory).pipe(
              Effect.map((providers) => findContextLimit(providers, input.providerID, input.modelID)),
              Effect.catch((error) =>
                Effect.logError("failed to get providers for usage context limit", { error: error }).pipe(
                  Effect.as(undefined),
                ),
              ),
            ),
          )
          return [next, new Map(items).set(key, next)] as const
        }),
      )
    })

    const contextLimit = Effect.fn("ACPUsage.contextLimit")(function* (input: {
      readonly directory: string
      readonly providerID: ProviderV2.ID
      readonly modelID: ModelV2.ID
    }) {
      return yield* yield* cachedLimit(input)
    })

    const sendUpdate = Effect.fn("ACPUsage.sendUpdate")(function* (input: {
      readonly connection: UsageConnection
      readonly sessionID: string
      readonly directory: string
    }) {
      const messages = yield* messageLoader
        .messages({ sessionID: input.sessionID, directory: input.directory })
        .pipe(
          Effect.catch((error) =>
            Effect.logError("failed to fetch messages for usage update", { error: error }).pipe(Effect.as(undefined)),
          ),
        )
      if (!messages) return

      const message = latestAssistantMessage(messages)
      if (!message) return
      if (!message.providerID || !message.modelID) return

      // Skip the /compact summariser turn — its tokens describe reading the whole
      // pre-compaction history, so neither input (spikes the gauge) nor output
      // (omits the preserved tail + system/tools overhead) is honest. Compaction
      // reduction is lazy, so hold the gauge and let the NEXT real turn report
      // the true reduced footprint. (Mirror of service.ts makeUsageService.)
      if ((message as { summary?: boolean }).summary === true) return

      const size = yield* contextLimit({
        directory: input.directory,
        providerID: ProviderV2.ID.make(message.providerID),
        modelID: ModelV2.ID.make(message.modelID),
      })
      if (!size) return

      // A failed/absent session listing costs the rollup only - the gauge and
      // the parent's own cost still go out.
      const rows = messageLoader.sessions
        ? yield* messageLoader
            .sessions({ directory: input.directory })
            .pipe(Effect.catch(() => Effect.succeed([] as readonly SessionRow[])))
        : []

      yield* Effect.promise(() =>
        input.connection
          .sessionUpdate({
            sessionId: input.sessionID,
            update: buildUsageUpdate({
              used: message.tokens.input + message.tokens.cache.read,
              size,
              cost: totalSessionCost(messages),
              subagents: subagentTotals(rows, input.sessionID),
              cacheReadTokens: message.tokens.cache.read,
              cacheWriteTokens: message.tokens.cache.write,
            }),
          })
          .catch(() => {}),
      )
    })

    return Service.of({
      buildUsage,
      latestAssistantMessage,
      totalSessionCost,
      contextLimit,
      sendUpdate,
    })
  }),
)

export const messageLoaderNode = LayerNode.unbound(MessageLoader, Node.tags.values.global)

export const contextLimitLoaderNode = makeGlobalNode({
  service: ContextLimitLoader,
  layer: contextLimitLoaderLayer,
  deps: [Provider.node, InstanceStore.node],
})

export const node = makeGlobalNode({ service: Service, layer, deps: [messageLoaderNode, contextLimitLoaderNode] })

export * as UsageService from "./usage"
