import type { AgentSideConnection, Usage } from "@agentclientprotocol/sdk"
import type {
  AssistantMessage as OrigamiAssistantMessage,
  Message,
  OrigamiClient,
  Part,
} from "@origami/sdk/v2"
import { ProviderV2 } from "@origami/core/provider"
import { ModelV2 } from "@origami/core/model"
import { Provider } from "@/provider/provider"
import { Effect } from "effect"
import { ACPComposition } from "./composition"
import { SessionPromptCapture } from "@/session/prompt-capture"
import type { ACPHistoryStore } from "./history-store"

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

/** The fields of a session row this module needs. The engine's projector keeps
 *  `cost`/`tokens` as RUNNING TOTALS per session, and a subagent's spend lands on
 *  the subagent's OWN row, so summing descendant rows cannot double count. */
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

export type UsageConnection = Pick<AgentSideConnection, "sessionUpdate">

export interface Interface {
  readonly buildUsage: (message: AssistantTokenCost, parts?: readonly Part[]) => Usage
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

/**
 * A turn's tokens, summed over the assistant message's `step-finish` parts.
 *
 * WHY NOT THE MESSAGE. `message.tokens` is ASSIGNED at every step-finish rather
 * than accumulated (session/processor.ts), because the context gauge needs "how
 * full is the window right now". Read as a turn total it reports only the LAST
 * step, which under-reports every tool loop. `undefined` when no part carried a
 * usable measurement; the caller falls back to the message level.
 */
export function sumStepFinishTokens(parts: readonly Part[] | undefined): AssistantTokenCost["tokens"] | undefined {
  let found = false
  let input = 0
  let output = 0
  let reasoning = 0
  let cacheRead = 0
  let cacheWrite = 0
  for (const part of parts ?? []) {
    if (!part || part.type !== "step-finish") continue
    // Widened rather than asserted: the SDK type says every member is a number,
    // but these rows come off disk and an older one need not honour it.
    const tokens: TokenView | undefined = part.tokens
    // A step that reported neither input nor output measured nothing, so it
    // contributes nothing rather than a fabricated zero.
    const stepInput = tokens?.input
    const stepOutput = tokens?.output
    if (!finiteNumber(stepInput) || !finiteNumber(stepOutput)) continue
    found = true
    input += stepInput
    output += stepOutput
    const stepReasoning = tokens?.reasoning
    if (finiteNumber(stepReasoning)) reasoning += stepReasoning
    const read = tokens?.cache?.read
    const write = tokens?.cache?.write
    if (finiteNumber(read)) cacheRead += read
    if (finiteNumber(write)) cacheWrite += write
  }
  if (!found) return undefined
  return { input, output, reasoning, cache: { read: cacheRead, write: cacheWrite } }
}

/** A step's `tokens`, read as "whatever is really there" rather than as typed. */
type TokenView = {
  readonly input?: unknown
  readonly output?: unknown
  readonly reasoning?: unknown
  readonly cache?: { readonly read?: unknown; readonly write?: unknown }
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

/**
 * The ACP `usage` payload for one assistant turn. `parts` is the message's own
 * parts when the caller has them: given, the token counts are summed per step;
 * omitted, the message-level totals are used, which under-report a multi-step turn.
 */
export function buildUsage(message: AssistantTokenCost, parts?: readonly Part[]): Usage {
  const tokens = sumStepFinishTokens(parts) ?? message.tokens
  const cachedReadTokens = tokens.cache.read
  const cachedWriteTokens = tokens.cache.write
  const thoughtTokens = tokens.reasoning

  return {
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    totalTokens: tokens.input + tokens.output + thoughtTokens + cachedReadTokens + cachedWriteTokens,
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
 * Returns `undefined` when there are no descendants, so the caller OMITS the field
 * rather than publishing zeros: a client can then tell "this turn used no
 * subagents" from "subagents ran and cost nothing". Cycle-safe and root-exclusive
 * (the parent's own spend is already reported by `cost`).
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
 * totals (its row - the running total the projector keeps, the same source
 * `subagentTotals` reads) alongside a LIFETIME sum over every row the caller passed
 * in. The caller reads with `roots: false` so a subagent's own cache spend counts
 * toward the lifetime.
 *
 * FLAT rather than a parent-scoped tree walk: every row counts once, no root to
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
 * Build the `usage_update` payload. The one place that shapes the wire frame -
 * `makeUsageService.sendUpdate` below calls this and nothing else does (t-s93cw2:
 * a second, unreachable `sendUpdate` used to build its own copy of this shape).
 *
 * `used`/`size`/`cost` keep their existing meaning - the PARENT session alone. The
 * subagent rollup and the cache breakdown are strictly ADDITIVE and ride `_meta`,
 * the ACP-sanctioned extension bag, since `UsageUpdate` has no typed slot for
 * either. `cacheReadTokens`/`cacheWriteTokens` mirror `buildUsage`'s cache fields
 * and are bundled as ONE `_meta.cache` object, so a consumer never has to guess
 * whether a missing write means zero or unmeasured.
 */
export function buildUsageUpdate(input: {
  readonly used: number
  readonly size: number
  readonly cost: number
  readonly subagents?: SubagentTotals
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  /** What `used` is made of, when this session has a prompt capture to read it
   *  from. Omitted rather than guessed - a client with no composition keeps
   *  whatever it showed before. */
  readonly composition?: ACPComposition.ContextComposition | undefined
}) {
  const cacheRead = input.cacheReadTokens ?? 0
  const cacheWrite = input.cacheWriteTokens ?? 0
  const meta = {
    ...(input.subagents ? { subagents: input.subagents } : {}),
    ...(input.composition ? { composition: input.composition } : {}),
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
 * Leading-edge rate limiter, keyed per session. `allow` returns true the FIRST time
 * a key is seen and then at most once per `intervalMs`. Leading-edge on purpose:
 * the point of a mid-turn update is that the gauge moves as soon as the first step
 * finishes. Time is injected so throttle behaviour is testable without sleeping.
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

/**
 * The ONE `Interface` builder. `acp/agent.ts` constructs `ACPService.make` with no
 * `usage` injected, so this is what runs live - it is the sole source of every
 * usage_update the product sends (t-s93cw2; before this, `acp/usage.ts` also built
 * a second, Effect-Context-service version of `sendUpdate`/`contextLimit` that
 * `ACPService.make` never received, so the breakdown card the OTHER builder
 * populated shipped in 0.4.158 without ever sending data - t-s8ikm2).
 *
 * `readCapture` is injectable (defaults to `SessionPromptCapture.get`, see
 * `service.ts`) so a test needs no engine. `contextLimit` caches a found limit
 * per directory/provider/model for the lifetime of this instance, plain and
 * uncoordinated - one instance per connection, so nothing else can race it.
 */
/** Messages per newest-first page when `sendUpdate` looks for the latest
 *  assistant message. After a turn, and during one, the newest message IS that
 *  assistant, so one page of one message is the usual whole read. */
const TAIL_PAGE = 1

export function makeUsageService(
  sdk: OrigamiClient,
  readCapture: (sessionID: string) => SessionPromptCapture.Capture | null,
  /** t-ucndru. The store reader for the subagent roll-up. Absent = no roll-up. */
  history?: Pick<ACPHistoryStore.Reader, "descendants">,
): Interface {
  const limits = new Map<string, Promise<number | undefined>>()

  const contextLimit: Interface["contextLimit"] = Effect.fn("ACP.usage.contextLimit")(function* (params) {
    const key = `${params.directory}\u0000${params.providerID}\u0000${params.modelID}`
    const current = limits.get(key)
    if (current) return yield* Effect.promise(() => current)

    const next = sdk.config
      .providers({ directory: params.directory }, { throwOnError: true })
      .then((response) => {
        const providers = Object.fromEntries(
          (response.data?.providers ?? []).map((provider) => [provider.id, provider]),
        ) as Record<ProviderV2.ID, Provider.Info>
        return findContextLimit(providers, params.providerID, params.modelID)
      })
      .catch(() => undefined)
      .then((limit) => {
        // Only a found limit is kept (t-tijhw6). A failed read, or one made
        // before the provider started, is read again on the next call.
        if (limit === undefined && limits.get(key) === next) limits.delete(key)
        return limit
      })
    limits.set(key, next)
    return yield* Effect.promise(() => next)
  })

  // t-u1j4jm. The gauge needs the newest assistant message and the session's
  // total cost, never the whole transcript: a full read of a 150 MB session
  // froze the engine's one JS thread for seconds after every turn. So the
  // messages are read newest first, TAIL_PAGE at a time, up to the first
  // assistant (the same message `latestAssistantMessage` finds in a full read),
  // and the cost comes from the session row, whose `cost` the projector keeps
  // as the running sum of the same step-finish costs the messages carry
  // (core/session/projector.ts `applyUsage`; a removed message subtracts).
  const latestAssistant = async (params: MessagesInput) => {
    let before: string | undefined
    while (true) {
      const response = await sdk.session.messages(
        { sessionID: params.sessionID, directory: params.directory, limit: TAIL_PAGE, ...(before ? { before } : {}) },
        { throwOnError: true },
      )
      const page = (response.data ?? []) as readonly SessionMessage[]
      const found = latestAssistantMessage(page)
      if (found) return found
      const next = response.response?.headers.get("x-next-cursor")
      if (page.length === 0 || !next) return undefined
      before = next
    }
  }

  const sendUpdate: Interface["sendUpdate"] = Effect.fn("ACP.usage.sendUpdate")(function* (params) {
    const read = yield* Effect.tryPromise({
      try: () => latestAssistant(params).then((message) => ({ message })),
      catch: (error) => error,
    }).pipe(
      Effect.catch((error) =>
        Effect.logError("failed to fetch messages for usage update", { error: error }).pipe(Effect.as(undefined)),
      ),
    )
    if (!read) return

    const message = read.message
    if (!message?.providerID || !message.modelID) return

    // Skip the /compact summariser turn: its input describes reading the WHOLE
    // pre-compaction history and would spike the gauge, while output alone under-reports.
    // Compaction reduction is lazy anyway, so hold the gauge and let the NEXT real turn
    // report the true reduced footprint.
    if ((message as { summary?: boolean }).summary === true) return

    const size = yield* contextLimit({
      directory: params.directory,
      providerID: ProviderV2.ID.make(message.providerID),
      modelID: ModelV2.ID.make(message.modelID),
    })
    if (!size) return

    const own = yield* Effect.tryPromise({
      try: () =>
        sdk.session
          .get({ sessionID: params.sessionID, directory: params.directory }, { throwOnError: true })
          .then((response) => response.data as SessionRow | undefined),
      catch: (error) => error,
    }).pipe(
      Effect.catch((error) =>
        Effect.logError("failed to fetch the session for usage update", { error: error }).pipe(Effect.as(undefined)),
      ),
    )
    if (!own) return

    // Subagent rollup, over EVERY descendant row: those rows already carry running
    // cost/token totals. t-ucndru: one recursive store read with no limit, not
    // `session.list`, which stops at the 100 newest rows, so an older child fell out
    // of the sum. A failed read costs the rollup only - the gauge and the parent's
    // own cost still go out.
    const rows = history
      ? yield* Effect.tryPromise(() => history.descendants(params.sessionID, null)).pipe(
          Effect.map((tree) =>
            tree.rows.map(
              (row): SessionRow => ({
                id: row.id,
                parentID: row.parentId,
                cost: row.cost,
                tokens: { input: row.tokens.input, output: row.tokens.output },
              }),
            ),
          ),
          Effect.catch(() => Effect.succeed([] as readonly SessionRow[])),
        )
      : []

    yield* Effect.promise(() =>
      params.connection
        .sessionUpdate({
          sessionId: params.sessionID,
          update: buildUsageUpdate({
            used: message.tokens.input + message.tokens.cache.read,
            size,
            cost: own.cost ?? 0,
            subagents: subagentTotals(rows, params.sessionID),
            cacheReadTokens: message.tokens.cache.read,
            cacheWriteTokens: message.tokens.cache.write,
            composition: ACPComposition.contextComposition({
              capture: readCapture(params.sessionID),
              used: message.tokens.input + message.tokens.cache.read,
            }),
          }),
        })
        .catch(() => {}),
    )
  })

  return {
    buildUsage,
    latestAssistantMessage,
    totalSessionCost,
    contextLimit,
    sendUpdate,
  }
}

export * as UsageService from "./usage"
