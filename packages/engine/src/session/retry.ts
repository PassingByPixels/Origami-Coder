import type { NamedError } from "@origami/core/util/error"
import { SessionV1 } from "@origami/core/v1/session"
import { Cause, Clock, Duration, Effect, Schedule } from "effect"
import { MessageV2 } from "./message-v2"
import { SessionDegrade } from "./degrade"
import { SessionEffortTier } from "./effort-tier"
import { ProviderEffortDemotion } from "@/provider/effort-demotion"
import { SessionImageCap } from "./image-cap"
import { SessionStreamDrop } from "./stream-drop"
import { SessionUsageLimit } from "./usage-limit"
import { iife } from "@/util/iife"
import { isRecord } from "@/util/record"

export type Err = ReturnType<NamedError["toObject"]>

export type Retryable = {
  message: string
  /**
   * Which budget this error spends. A dropped stream gets its own, much tighter
   * one: the prompt was already accepted and billed, so a redo is not free the
   * way repeating a rejected request is. See `SessionStreamDrop`.
   */
  kind?: "stream-drop"
  action?: {
    reason: string
    provider: string
    title: string
    message: string
    label: string
    link?: string
  }
}

export const RETRY_INITIAL_DELAY = 2000
export const RETRY_BACKOFF_FACTOR = 2
export const RETRY_MAX_DELAY_NO_HEADERS = 30_000 // 30 seconds
export const RETRY_MAX_DELAY = 2_147_483_647 // max 32-bit signed integer for setTimeout

// Hard ceiling on retry attempts per turn. Without one, a provider that answers
// 429/5xx forever retries without end, which with capped backoff is an infinite
// silent loop. When the cap is hit the provider error surfaces to the user.
export const RETRY_LIMIT_DEFAULT = 8
export function retryLimit() {
  const raw = Number.parseInt(process.env["ORIGAMI_SESSION_RETRY_LIMIT"] ?? "", 10)
  if (Number.isInteger(raw) && raw >= 0) return raw
  return RETRY_LIMIT_DEFAULT
}

/** The full per-attempt retry decision: the error must be retryable AND the
 *  attempt must be within the hard limit for its family. `attempt` is 1-based. */
export function decide(attempt: number, error: Err, provider: string): Retryable | undefined {
  const retry = retryable(error, provider)
  if (!retry) return undefined
  if (attempt > (retry.kind === "stream-drop" ? SessionStreamDrop.limit() : retryLimit())) return undefined
  return retry
}

function cap(ms: number) {
  return Math.min(ms, RETRY_MAX_DELAY)
}

export function delay(attempt: number, error?: SessionV1.APIError) {
  if (error) {
    // A severed stream names no wait and asks for none: the ladder below exists
    // to obey a provider telling us to slow down, and nothing is saying that here.
    if (SessionStreamDrop.isDrop(error)) return SessionStreamDrop.delay(attempt)
    const headers = error.data.responseHeaders
    if (headers) {
      const retryAfterMs = headers["retry-after-ms"]
      if (retryAfterMs) {
        const parsedMs = Number.parseFloat(retryAfterMs)
        if (!Number.isNaN(parsedMs)) {
          return cap(parsedMs)
        }
      }

      const retryAfter = headers["retry-after"]
      if (retryAfter) {
        const parsedSeconds = Number.parseFloat(retryAfter)
        if (!Number.isNaN(parsedSeconds)) {
          return cap(Math.ceil(parsedSeconds * 1000))
        }
        const parsed = Date.parse(retryAfter) - Date.now()
        if (!Number.isNaN(parsed) && parsed > 0) {
          return cap(Math.ceil(parsed))
        }
      }

      return cap(RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1))
    }
  }

  return cap(Math.min(RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1), RETRY_MAX_DELAY_NO_HEADERS))
}

export function retryable(error: Err, provider: string) {
  if (SessionV1.ContextOverflowError.isInstance(error)) return undefined
  // A credential rejection is not transient, but some providers mark 401/403
  // retryable anyway, which would spend the ladder before the user is told.
  if (SessionDegrade.isAuth(error)) return undefined
  if (SessionV1.APIError.isInstance(error)) {
    const status = error.data.statusCode
    // 5xx errors are transient server failures and should always be retried,
    // even when the provider SDK doesn't explicitly mark them as retryable.
    if (!error.data.isRetryable && !(status !== undefined && status >= 500)) return undefined
    const message = error.data.message.includes("Overloaded") ? "Provider is overloaded" : error.data.message
    if (SessionStreamDrop.isDrop(error)) return { message, kind: "stream-drop" } satisfies Retryable
    return { message } satisfies Retryable
  }

  const msg = isRecord(error.data) ? error.data.message : undefined
  if (typeof msg === "string") {
    const lower = msg.toLowerCase()
    if (
      lower.includes("rate increased too quickly") ||
      lower.includes("rate limit") ||
      lower.includes("too many requests")
    ) {
      return { message: msg }
    }
  }

  const json = parseJSON(msg)
  if (!json || typeof json !== "object") return undefined
  const code = typeof json.code === "string" ? json.code : ""

  if (json.type === "error" && json.error?.type === "too_many_requests") {
    return { message: "Too Many Requests" }
  }
  if (code.includes("exhausted") || code.includes("unavailable")) {
    return { message: "Provider is overloaded" }
  }
  if (json.type === "error" && typeof json.error?.code === "string" && json.error.code.includes("rate_limit")) {
    return { message: "Rate Limited" }
  }
  return undefined
}

function parseJSON(value: unknown) {
  return iife(() => {
    try {
      if (typeof value !== "string") return undefined
      return JSON.parse(value)
    } catch {
      return undefined
    }
  })
}

export function policy(opts: {
  provider: string
  sessionID: string
  /**
   * The model this turn runs on and the effort tiers it offers. Only the
   * tier-demotion branch reads it; optional so a caller with no model skips it.
   */
  model?: { providerID: string; modelID: string; tiers: readonly string[] }
  /** Rebuild the provider list, so a demoted tier leaves the effort menu now
   *  rather than at the next launch. Optional for the same reason as `model`. */
  invalidateProviders?: () => Effect.Effect<void>
  parse: (error: unknown) => Err
  set: (input: { attempt: number; message: string; action?: Retryable["action"]; next: number }) => Effect.Effect<void>
  /** Puts one row in front of the user, in the chat, before the retry. `text` is
   *  empty for a STRUCTURED notice (stream drop), whose whole content is the
   *  `metadata` rider the client draws a card from. */
  notice: (input: { text: string; metadata: Record<string, unknown> }) => Effect.Effect<void>
  /**
   * Whether a dropped stream may be redone right now. Redoing a step re-sends the
   * identical request, so a tool that already ran could run a second time; the
   * processor answers false once the step has committed to a tool call.
   */
  canRedoStep?: () => boolean
}) {
  return Schedule.fromStepWithMetadata(
    Effect.succeed((meta: Schedule.InputMetadata<unknown>) => {
      const error = opts.parse(meta.input)
      // Tier rejection: the endpoint takes `reasoning_effort` and refuses this
      // value, so one step down the ladder is a different request worth exactly
      // one immediate retry, and the tier is struck off this model for good
      // (`provider/effort-demotion.ts`). Ordered above the knob branch because a
      // tier rejection also names the field, and dropping the field would throw
      // the user's choice away; what this branch declines falls through unchanged.
      const model = opts.model
      if (model) {
        const modelKey = SessionEffortTier.key(model.providerID, model.modelID)
        const tier = SessionEffortTier.lastTier(opts.sessionID, modelKey)
        if (SessionEffortTier.isRejected(error, tier) && tier) {
          const available = ProviderEffortDemotion.ladder(model.providerID, model.modelID, model.tiers)
          const next = ProviderEffortDemotion.below(tier, available)
          // Demoted once already and refused again: the tier was not the cause,
          // so let the provider's own words out instead of walking the ladder.
          if (next !== undefined && SessionEffortTier.isRecorded(opts.sessionID, modelKey))
            return Cause.done(meta.attempt)
          // Nothing weaker to fall back to: this is not a demotion, it is the
          // knob branch's problem. Fall through.
          if (next !== undefined) {
            return Effect.gen(function* () {
              SessionEffortTier.record(opts.sessionID, modelKey)
              ProviderEffortDemotion.record(model.providerID, model.modelID, tier)
              if (opts.invalidateProviders) yield* opts.invalidateProviders()
              yield* Effect.logInfo("reasoning effort demoted", {
                "session.id": opts.sessionID,
                providerID: model.providerID,
                modelID: model.modelID,
                from: tier,
                to: next,
                reason: "the model refused the tier",
              })
              yield* opts.notice({
                text: SessionEffortTier.notice(tier, next),
                metadata: { origami_effort_demoted: tier },
              })
              // No backoff: the next request carries a different tier.
              return [meta.attempt, Duration.millis(0)] as [number, Duration.Duration]
            })
          }
        }
      }
      // Knob rejection: the endpoint named a request field it will not take, and
      // repeating the identical request cannot change that. Drop it and try once.
      const knob = SessionDegrade.detect(error)
      if (knob) {
        // Dropped once already and refused again: the field was not the cause.
        if (SessionDegrade.isRecorded(opts.sessionID, knob)) return Cause.done(meta.attempt)
        return Effect.gen(function* () {
          SessionDegrade.record(opts.sessionID, knob)
          yield* opts.notice({ text: SessionDegrade.notice(knob), metadata: { origami_degraded: knob.label } })
          // No backoff: the next request is a different one, not a repeat.
          return [meta.attempt, Duration.millis(0)] as [number, Duration.Duration]
        })
      }
      // Image cap: the endpoint named how many pictures one prompt may carry. The
      // identical payload can never be accepted, so this class must never reach
      // `decide` — a provider that marks it retryable would otherwise spend the
      // whole ladder re-sending the same images.
      const cap = SessionImageCap.detect(error)
      if (cap !== undefined) {
        // Capped once already and refused again: the count was not the cause.
        if (SessionImageCap.isRecorded(opts.sessionID, cap)) return Cause.done(meta.attempt)
        return Effect.gen(function* () {
          SessionImageCap.record(opts.sessionID, cap)
          yield* opts.notice({ text: SessionImageCap.notice(cap), metadata: { origami_image_cap: String(cap) } })
          // No backoff: the next request carries fewer images.
          return [meta.attempt, Duration.millis(0)] as [number, Duration.Duration]
        })
      }
      // Usage window spent: a 429 that names its own reset. No repeat can succeed
      // inside the window, so say when it comes back and let the error out at once.
      const limit = SessionUsageLimit.detect(error)
      if (limit) {
        return Effect.gen(function* () {
          yield* opts.notice({
            text: SessionUsageLimit.notice(limit, opts.provider),
            metadata: { origami_usage_limit: String(limit.resetsInSeconds ?? "") },
          })
          return yield* Cause.done(meta.attempt)
        })
      }
      const retry = decide(meta.attempt, error, opts.provider)
      // The END of a dropped-stream ladder, by either road: the budget is spent
      // (`decide` returns nothing), or the failed attempt already committed a tool
      // call so a redo could run it twice. Both used to fall out silently, leaving
      // the chat holding a row that says "retrying" for ever. `stopped` is what
      // closes that card and offers the turn again.
      if (!retry || (retry.kind === "stream-drop" && opts.canRedoStep?.() === false)) {
        // `isDrop` only holds for an APIError, which is where the detail lives.
        if (!SessionStreamDrop.isDrop(error) || !SessionV1.APIError.isInstance(error))
          return Cause.done(meta.attempt)
        const detail = error.data.message
        return Effect.gen(function* () {
          yield* opts.notice({ text: "", metadata: streamDropNotice("stopped", meta.attempt, detail) })
          return yield* Cause.done(meta.attempt)
        })
      }
      return Effect.gen(function* () {
        const wait = delay(meta.attempt, SessionV1.APIError.isInstance(error) ? error : undefined)
        const now = yield* Clock.currentTimeMillis
        yield* opts.set({
          attempt: meta.attempt,
          message: retry.message,
          action: retry.action,
          next: now + wait,
        })
        // A dropped stream is the one retry the user must see: it happens after
        // prose has already arrived, so without a transcript line the chat repeats
        // itself with no explanation, and no client renders the `retry` status
        // event above. The log line is so a run of drops that all recovered on
        // retry still leaves a trace in origami.log.
        if (retry.kind === "stream-drop") {
          yield* Effect.logWarning("stream dropped; retrying the step", {
            provider: opts.provider,
            attempt: meta.attempt,
            message: retry.message,
          })
          yield* opts.notice({
            text: "",
            metadata: streamDropNotice("retrying", meta.attempt, retry.message),
          })
        }
        return [meta.attempt, Duration.millis(wait)] as [number, Duration.Duration]
      })
    }),
  )
}

/** One notice rider, under the key the ACP bridge and the client both read. */
function streamDropNotice(kind: "retrying" | "stopped", attempt: number, detail: string) {
  return {
    origami_retry: String(attempt),
    [SessionStreamDrop.NOTICE_KEY]: SessionStreamDrop.notice(kind, attempt, detail),
  }
}

export * as SessionRetry from "./retry"
