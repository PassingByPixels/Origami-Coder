import type { NamedError } from "@origami/core/util/error"
import { SessionV1 } from "@origami/core/v1/session"
import { Cause, Clock, Duration, Effect, Schedule } from "effect"
import { MessageV2 } from "./message-v2"
import { SessionDegrade } from "./degrade"
import { SessionStreamDrop } from "./stream-drop"
import { iife } from "@/util/iife"
import { isRecord } from "@/util/record"

export type Err = ReturnType<NamedError["toObject"]>

export type Retryable = {
  message: string
  /**
   * Which budget this error spends. A dropped stream gets its own, much
   * tighter one: the prompt was already accepted and billed, so a redo is not
   * free the way repeating a rejected request is. See `SessionStreamDrop`.
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

// Hard ceiling on retry attempts per turn. Without one, a persistently
// retryable error (a provider that answers 429/5xx forever) retries without
// end — with capped backoff that is an infinite silent loop, the same
// hang-shape the provider fetch hardening exists to prevent. When the cap is
// hit the underlying provider error propagates and surfaces to the user.
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
    // A severed stream names no wait and asks for none. The ladder below exists
    // to obey a provider that is telling us to slow down; nothing is telling us
    // anything here, and a user is watching a stalled chat.
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
          // convert seconds to milliseconds
          return cap(Math.ceil(parsedSeconds * 1000))
        }
        // Try parsing as HTTP date format
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
  // context overflow errors should not be retried
  if (SessionV1.ContextOverflowError.isInstance(error)) return undefined
  // A credential rejection is not transient. Some providers mark 401/403 as
  // retryable anyway (and openai's own 404 override forces isRetryable true),
  // which would spend the full backoff ladder before the user is told the one
  // thing they need to know.
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

  // Check for rate limit patterns in plain text error messages
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
  parse: (error: unknown) => Err
  set: (input: { attempt: number; message: string; action?: Retryable["action"]; next: number }) => Effect.Effect<void>
  /** Puts one line in front of the user, in the chat, before the retry. */
  notice: (input: { text: string; metadata: Record<string, string> }) => Effect.Effect<void>
  /**
   * Whether a dropped stream may be redone right now. Redoing a step re-sends
   * the identical request, so a tool that already RAN in the failed attempt
   * could run a second time — fine for a read, not fine for a write. The
   * processor answers false once the step has committed to a tool call.
   */
  canRedoStep?: () => boolean
}) {
  return Schedule.fromStepWithMetadata(
    Effect.succeed((meta: Schedule.InputMetadata<unknown>) => {
      const error = opts.parse(meta.input)
      // Knob rejection: the endpoint named a request field it will not take.
      // Repeating the identical request cannot change that answer, so drop the
      // field and try once more instead of spending the backoff ladder.
      const knob = SessionDegrade.detect(error)
      if (knob) {
        // Already dropped and refused again: the field was not the cause. Let
        // the error out so its text reaches the user.
        if (SessionDegrade.isRecorded(opts.sessionID, knob)) return Cause.done(meta.attempt)
        return Effect.gen(function* () {
          SessionDegrade.record(opts.sessionID, knob)
          yield* opts.notice({ text: SessionDegrade.notice(knob), metadata: { origami_degraded: knob.label } })
          // No backoff: the next request is a DIFFERENT one, not a repeat.
          return [meta.attempt, Duration.millis(0)] as [number, Duration.Duration]
        })
      }
      const retry = decide(meta.attempt, error, opts.provider)
      if (!retry) return Cause.done(meta.attempt)
      // A dropped stream is redone, not resumed. If the failed attempt already
      // ran a tool, redoing it could run that tool again, so the drop is let
      // out with its own message instead of being retried behind the user's
      // back. Every other family reaches this point unchanged.
      if (retry.kind === "stream-drop" && opts.canRedoStep?.() === false) return Cause.done(meta.attempt)
      return Effect.gen(function* () {
        const wait = delay(meta.attempt, SessionV1.APIError.isInstance(error) ? error : undefined)
        const now = yield* Clock.currentTimeMillis
        yield* opts.set({
          attempt: meta.attempt,
          message: retry.message,
          action: retry.action,
          next: now + wait,
        })
        // A dropped stream is the one retry the user MUST see. It happens after
        // prose has already arrived, so without a line in the transcript the
        // chat simply repeats itself with no explanation. The `retry` status
        // event above is not enough on its own — no client renders it today.
        if (retry.kind === "stream-drop") {
          yield* opts.notice({
            text: SessionStreamDrop.notice(meta.attempt, retry.message),
            metadata: { origami_retry: String(meta.attempt) },
          })
        }
        return [meta.attempt, Duration.millis(wait)] as [number, Duration.Duration]
      })
    }),
  )
}

export * as SessionRetry from "./retry"
