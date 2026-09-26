/**
 * Cache warming - keep a long session's prompt cache alive (t-ntmmvh).
 *
 * The engine already places cache breakpoints per request
 * (`provider/transform.ts` applyCaching, `@origami/llm` cache-policy), but
 * nothing refreshes them BETWEEN turns. A provider's ephemeral cache is
 * five minutes by default and one hour in the `ttl: "1h"` form, so an operator
 * who steps away pays a full cold read on the next message.
 *
 * So: when a real request finishes, arm a timer at 80% of that request's cache
 * TTL. If it fires, re-send the SAME prefix with one minimal trailing user
 * message and a single output token. The provider re-reads the cached prefix
 * and the clock starts again.
 *
 * WHY THE TIMER LIVES HERE and not in `packages/llm`: the provider layer sees
 * one request at a time and knows nothing about sessions, turns or compaction.
 * The three rules that make warming safe are all session facts -
 *
 *   - a real request CANCELS the pending warm (it refreshed the cache itself),
 *   - a COMPACTION throws the prefix away (`acpExtTypes.ts`), so no warm may
 *     fire until a real request has rebuilt it,
 *   - a session whose provider takes no inline cache hint is never warmed,
 *
 * - and none of them is visible from inside a single request.
 *
 * Plain module state and an injectable clock, the shape `turn-end.ts` uses: the
 * whole scheduler is then testable with fake timers and no provider at all.
 */
import type { ModelMessage } from "ai"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { SessionCachePolicy } from "./cache-policy"

/** The env var the VS Code shell writes when the setting is OFF. Mirrored in
 *  `vscode/src/cacheWarming.ts`, with a drift guard that reads THIS file. */
export const DISABLE_ENV = "ORIGAMI_DISABLE_CACHE_WARM"

/** Re-read at 80% of the TTL. Early enough to absorb a slow request and a
 *  retry, late enough that an hour-long cache costs 48 minutes of idle rather
 *  than a warm every few minutes. */
export const WARM_AT = 0.8

/**
 * The default ephemeral cache lifetime, in seconds. `applyCaching` stamps
 * `cacheControl: { type: "ephemeral" }` with no `ttl`, which is the provider's
 * five-minute form; the one-hour form is `ttl: "1h"` (cache-policy.ts maps
 * `CacheHint.ttlSeconds >= 3600` to it).
 */
export const TTL_DEFAULT_SECONDS = 300
export const TTL_1H_SECONDS = 3600

/**
 * The trailing message a warm adds. One character, so the request is the cached
 * prefix plus almost nothing. It is a USER message on purpose: an assistant
 * message would be read as a prefill, which providers refuse outright once
 * extended thinking is on.
 */
export const WARM_TEXT = "."

/** Two failures in a row and this session stops warming. A provider that
 *  refuses the minimal form (an extended-thinking model whose `max_tokens` must
 *  exceed the thinking budget, say) would otherwise refuse it every time. */
export const MAX_FAILURES = 2

/** Is warming on? ON by default - an exact `1`/`true` in the kill switch is the
 *  only thing that turns it off, matching the shell, which writes the variable
 *  only while the setting is off. */
export function enabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env[DISABLE_ENV]
  return !(raw === "1" || raw === "true")
}

/**
 * The cache TTL this request's prefix was written with, or undefined when no
 * window is DOCUMENTED for this provider - those sessions are never warmed,
 * because a warm against an unknown window is pure cost (t-rz0amv).
 *
 * Two kinds of cached prefix, and the second one has no breakpoint at all:
 *   - inline (Anthropic family): a `cacheControl` breakpoint the engine or the
 *     SDK stamps; the TTL is the one that breakpoint carries.
 *   - implicit (OpenAI Responses family): nothing is stamped; the prefix is
 *     identified by `prompt_cache_key` and its lifetime is published per model
 *     family (`ProviderTransform.openaiCacheSeconds`).
 *
 * Unwarmed, deliberately: OpenRouter (routes the next call to another upstream
 * and publishes no window), local servers (vLLM, LM Studio: the window is the
 * KV budget, not a clock), xAI, and OpenCode Go/Zen - their guide asks for a
 * stable `x-opencode-session` "so we can optimize routing and prompt caching"
 * (https://opencode.ai/docs/go/) but publishes no window to warm against.
 */
export function ttlSeconds(model: Provider.Model, options: Record<string, unknown>): number | undefined {
  // Two ways a prefix ends up cached, and they are mutually exclusive by
  // construction (`appliesInlineCaching` stands down when the SDK is doing it):
  //   1. the caller set `cacheControl` on an Anthropic-family package and the
  //      SDK places the breakpoints - the TTL is whatever that option says;
  //   2. the engine's own `applyCaching`, which stamps the plain ephemeral form.
  if (ProviderTransform.automaticAnthropicCaching(model, options)) {
    const control = options["cacheControl"]
    const ttl = control !== null && typeof control === "object" ? (control as Record<string, unknown>)["ttl"] : undefined
    return ttl === "1h" ? TTL_1H_SECONDS : TTL_DEFAULT_SECONDS
  }
  if (ProviderTransform.appliesInlineCaching(model, options)) return TTL_DEFAULT_SECONDS
  //   3. OpenAI's implicit prefix cache: no breakpoint, a published window per
  //      model family. The key that identifies the prefix (`promptCacheKey`) is
  //      switchable off per provider, and a warm without it cannot land on the
  //      same cache entry, so the switch gates the window too.
  if (options["promptCacheKey"] === undefined) return undefined
  return ProviderTransform.openaiCacheSeconds(model)
}

/**
 * origami_change (t-w2txb2): the LONGEST a prefix this request wrote can stay in
 * the provider's cache, in seconds, or undefined where the provider publishes no
 * window (local servers, DeepSeek, OpenRouter ... - cache-policy.ts). The upper
 * end of each published range: Anthropic's TTL is exact (5 min, or 1 h on the
 * opt-in form), OpenAI's is a range per family (transform.ts). The park guard
 * (elastic/idle.ts) stops an engine only after this has passed, so it errs long.
 */
export function lifeSeconds(model: Provider.Model, options: Record<string, unknown>): number | undefined {
  const window = SessionCachePolicy.windowSeconds({
    providerID: model.providerID,
    modelID: model.api.id,
    hintTtlSeconds: ttlSeconds(model, options),
  })
  if (window === undefined) return undefined
  const id = model.providerID.toLowerCase()
  // An OpenAI id of no known family keeps the longest published end, 24 h.
  if (id === "openai" || id === "azure") return ProviderTransform.openaiLongestCacheSeconds(model.api.id) ?? 86_400
  return window
}

/** Milliseconds from the last real request to its warm. */
export function warmDelayMs(ttl: number): number {
  return Math.round(ttl * WARM_AT * 1000)
}

/** What a warm needs to reproduce the prefix: exactly the request that was sent. */
export type WarmRequest = {
  readonly messages: ModelMessage[]
  readonly warm: true
}

/**
 * The warm request for a real one: the SAME messages, in the same order, with
 * the same inline cache markers, plus one minimal user message. Nothing is
 * rewritten and nothing is dropped - a warm that altered the prefix would miss
 * the cache it exists to refresh.
 */
export function warmRequest(messages: ReadonlyArray<ModelMessage>): WarmRequest {
  return {
    messages: [...messages, { role: "user", content: [{ type: "text", text: WARM_TEXT }] }],
    warm: true,
  }
}

export type TimerHandle = { readonly id: unknown }

export interface Clock {
  setTimeout(fn: () => void, ms: number): TimerHandle
  clearTimeout(handle: TimerHandle): void
}

const realClock: Clock = {
  setTimeout: (fn, ms) => {
    const id = setTimeout(fn, ms)
    // A pending warm must never hold the process open: it is an optimisation,
    // not work anyone is waiting for.
    ;(id as unknown as { unref?: () => void }).unref?.()
    return { id }
  },
  clearTimeout: (handle) => clearTimeout(handle.id as ReturnType<typeof setTimeout>),
}

let clock: Clock = realClock

/** Test seam. */
export function setClock(next: Clock | undefined): void {
  clock = next ?? realClock
}

type Entry = {
  timer: TimerHandle | undefined
  /** Set by a compaction, cleared by the next real request. */
  blocked: boolean
  failures: number
  /** Epoch ms of the last warm the provider ACCEPTED. Undefined until one
   *  succeeds - a warm that was armed, or that failed, refreshed nothing. */
  warmedAt: number | undefined
  /** origami_change (t-w2qlop): epoch ms the armed warm fires. Set with `timer`. */
  dueAt?: number
  /** origami_change (t-w2txb2): epoch ms of this session's last real request, and
   *  the longest life of the prefix it wrote (`lifeSeconds`; null = no published
   *  window). Set by every real request, warming on or off. */
  lastAt?: number
  life?: number | null
  /** origami_change (t-z6ytkw): the armed warm's whole stream input, for a park to
   *  hand over (elastic/park-warm.ts). Set and cleared with `timer`. */
  recipe?: () => unknown
}

const sessions = new Map<string, Entry>()
/** origami_change (t-w2qlop): epoch ms of the last real request, any session. */
let lastRequest: number | undefined

const entry = (sessionID: string): Entry => {
  const found = sessions.get(sessionID)
  if (found) return found
  const made: Entry = { timer: undefined, blocked: false, failures: 0, warmedAt: undefined }
  sessions.set(sessionID, made)
  return made
}

const clearTimer = (e: Entry): void => {
  if (e.timer === undefined) return
  clock.clearTimeout(e.timer)
  e.timer = undefined
  e.dueAt = undefined
  e.recipe = undefined
}

export type ArmInput = {
  readonly sessionID: string
  readonly model: Provider.Model
  /** The request options, as `LLMRequestPrep.prepare` resolved them. */
  readonly options: Record<string, unknown>
  readonly messages: ReadonlyArray<ModelMessage>
  /** Send the warm. Resolves when it finished; rejects when the provider
   *  refused it. The caller owns the transport; this module owns the clock. */
  readonly send: (request: WarmRequest) => Promise<void>
  /** Where the debug line goes. A warm is INVISIBLE everywhere else: it never
   *  reaches the transcript, the usage pills or the token totals, because the
   *  caller drains its stream instead of handing it to the session processor. */
  readonly log?: (message: string, fields: Record<string, unknown>) => void
  readonly env?: Record<string, string | undefined>
  /** origami_change (t-z6ytkw): the stream input this warm re-sends (all but the
   *  trailing message), for a park to persist. A woken engine sends it again. */
  readonly recipe?: () => unknown
}

/**
 * A real request just went out. Cancel any pending warm and arm the next one.
 *
 * Called for EVERY real request, which is what makes "cancelled by a real
 * request" fall out of the design rather than needing its own rule.
 */
export function armed(input: ArmInput): void {
  lastRequest = Date.now()
  const e = entry(input.sessionID)
  e.lastAt = lastRequest
  e.life = lifeSeconds(input.model, input.options) ?? null
  clearTimer(e)
  // A real request rebuilt the prefix, so whatever a compaction threw away is
  // back and the session is warmable again.
  e.blocked = false
  e.failures = 0
  if (!enabled(input.env)) return
  const ttl = ttlSeconds(input.model, input.options)
  if (ttl === undefined) return
  const messages = [...input.messages]
  const delay = warmDelayMs(ttl)

  const fire = () => {
    const current = sessions.get(input.sessionID)
    if (!current || current.timer === undefined) return
    current.timer = undefined
    current.dueAt = undefined
    current.recipe = undefined
    // Re-checked AT FIRE TIME, not only when armed: a compaction between the
    // two would otherwise send a warm against a prefix that no longer exists.
    if (current.blocked) return
    input.log?.("cache warm", {
      "session.id": input.sessionID,
      modelID: input.model.id,
      ttlSeconds: ttl,
      delayMs: delay,
    })
    void input
      .send(warmRequest(messages))
      .then(() => {
        const after = sessions.get(input.sessionID)
        if (!after) return
        after.failures = 0
        // The provider re-read the prefix, so the next request's gap is not the
        // idle it looks like. Recorded here rather than at arm time: only a warm
        // the provider ACCEPTED moved the clock.
        after.warmedAt = Date.now()
      })
      .catch((error) => {
        const after = sessions.get(input.sessionID)
        if (!after) return
        after.failures += 1
        input.log?.("cache warm failed", {
          "session.id": input.sessionID,
          failures: after.failures,
          error: error instanceof Error ? error.message : String(error),
        })
        // Give up on this session rather than refusing on a loop.
        if (after.failures >= MAX_FAILURES) after.blocked = true
      })
  }

  e.timer = clock.setTimeout(fire, delay)
  e.dueAt = Date.now() + delay
  e.recipe = input.recipe
}

/**
 * A compaction ran: the cached prefix is gone. No warm until a real request has
 * rebuilt it - `armed` is the only thing that clears this.
 */
export function compacted(sessionID: string): void {
  const e = entry(sessionID)
  clearTimer(e)
  e.blocked = true
}

/** The chat closed (t-w2u5vf): no warm for it. A pending timer holds the whole
 *  message array, so it is cancelled, not left to fire. */
export function evict(sessionID: string): void {
  const e = sessions.get(sessionID)
  if (e) clearTimer(e)
  sessions.delete(sessionID)
}

/** Test seam: module state is process-wide, so a suite needs a way back to zero. */
export function reset(): void {
  for (const e of sessions.values()) clearTimer(e)
  sessions.clear()
  lastRequest = undefined
  clock = realClock
}

/** When this session's last warm SUCCEEDED, or undefined if none has. Read by
 *  the request layer so a step-finish can say the gap before it was warmed. */
export function warmedAt(sessionID: string): number | undefined {
  return sessions.get(sessionID)?.warmedAt
}

/** origami_change (t-w2qlop): the sessions with a warm armed, and the earliest
 *  moment one fires. Read by the elastic idle report and the trim guard: a
 *  trim just before a warm pulls every page straight back in. */
export function pendingSessions(): string[] {
  return [...sessions.entries()].filter(([, e]) => e.timer !== undefined).map(([id]) => id)
}

export function nextDueAt(): number | undefined {
  let due: number | undefined
  for (const e of sessions.values()) {
    if (e.timer === undefined || e.dueAt === undefined) continue
    if (due === undefined || e.dueAt < due) due = e.dueAt
  }
  return due
}

/** origami_change (t-w2qlop): when the last real request went out, any session. */
export function lastRequestAt(): number | undefined {
  return lastRequest
}

/**
 * origami_change (t-w2txb2): the park guard's cache facts for this whole process.
 * `coldAt` = the epoch ms after which no prefix a session here wrote or warmed
 * can still be cached (each session: max(last real request, last accepted warm)
 * + its longest life). `untimed` = some session's provider publishes no window,
 * so no time makes its stop cache-neutral. Both absent when no real request went
 * out from this process.
 */
export function cacheLife(): { coldAt?: number; untimed?: true } {
  let coldAt: number | undefined
  let untimed = false
  for (const e of sessions.values()) {
    if (e.lastAt === undefined) continue
    if (e.life === null || e.life === undefined) {
      untimed = true
      continue
    }
    const at = Math.max(e.lastAt, e.warmedAt ?? 0) + e.life * 1000
    if (coldAt === undefined || at > coldAt) coldAt = at
  }
  return { ...(coldAt === undefined ? {} : { coldAt }), ...(untimed ? { untimed: true as const } : {}) }
}

/** origami_change (t-z6ytkw): the armed warms a park hands over: when each is due
 *  and its stream input. Only warms armed with a recipe. */
export function pendingWarms(): { sessionID: string; dueAt: number; recipe: () => unknown }[] {
  const out: { sessionID: string; dueAt: number; recipe: () => unknown }[] = []
  for (const [sessionID, e] of sessions)
    if (e.timer !== undefined && e.dueAt !== undefined && e.recipe) out.push({ sessionID, dueAt: e.dueAt, recipe: e.recipe })
  return out
}

/** origami_change (t-z6ytkw): did this process send a real request for the session?
 *  A woken engine that did has its own prefix and its own warm; the handed-over one is stale. */
export function requested(sessionID: string): boolean {
  return sessions.get(sessionID)?.lastAt !== undefined
}

/** origami_change (t-z6ytkw): the sessions this process sent a real request for. */
export function requestedSessions(): string[] {
  return [...sessions.entries()].filter(([, e]) => e.lastAt !== undefined).map(([id]) => id)
}

/** Whether a warm is pending. For tests and the debug log only. */
export function pending(sessionID: string): boolean {
  return sessions.get(sessionID)?.timer !== undefined
}

export * as SessionCacheWarm from "./cache-warm"
