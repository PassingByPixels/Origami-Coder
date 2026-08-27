import { SessionV1 } from "@origami/core/v1/session"
import type { Err } from "./retry"

/**
 * Stream drop: the provider stream dying AFTER the request succeeded.
 *
 * The AI SDK retries `doStream` — the call that opens the stream — and nothing
 * else (`ai/dist/index.mjs`, `retry(() => recordSpan({ name:
 * "ai.streamText.doStream" ... }))`). Once headers land, every later failure is
 * forwarded as a `fullStream` part of type `error` and the SDK is finished with
 * it. `session/llm/ai-sdk.ts` turns that part into `Effect.fail(event.error)`,
 * so the raw value the provider package chose reaches `MessageV2.fromError`
 * with no HTTP status, no headers and no `APICallError` wrapper.
 *
 * That is why the family needs its own classifier. `@ai-sdk/openai-compatible`
 * enqueues `{ type: "error", error: chunk.value.error.message }` — a BARE
 * STRING — for any `{"error":{...}}` frame in the SSE body, discarding the
 * code. A bare sentence matches none of `SessionRetry.retryable`'s branches
 * (not an APIError, not JSON that parses to an object), so it fell through to
 * `NamedError.Unknown` and the turn died on a transport hiccup. The owner's
 * live failure read `Internal error: "Upstream idle timeout exceeded"` — the
 * quotes are `JSON.stringify` on that string.
 *
 * The whole family is transient by construction: the request was accepted, the
 * transport failed. Re-sending the identical request is the only sound repair —
 * see `DISCARD-AND-REDO` below.
 */

/**
 * Marker written into `APIError.metadata.code`, so the retry policy can tell a
 * dropped stream from a rate limit without re-parsing the message. Sits beside
 * the codes the other transport errors already write there (`ECONNRESET`,
 * `ProviderHeaderTimeoutError`, `ProviderResponseStreamError`).
 */
export const CODE = "stream_drop"

/**
 * DISCARD-AND-REDO, not continue-from-partial.
 *
 * `session/prompt.ts` builds `streamInput.messages` ONCE per step and hands the
 * same array to `handle.process`, so `Effect.retry` re-sends a byte-identical
 * request. The engine has no continuation mechanism at all: resuming from the
 * partial text would mean synthesising an assistant prefix or a "continue"
 * user turn, which is exactly the pattern that is banned. So a retry redoes
 * the step from the same context and the model starts the step again.
 *
 * The partial parts the failed attempt already persisted are LEFT IN PLACE.
 * Removing them is possible (`Session.removePart`) but not honest: a tool part
 * can record a side effect that really happened, and deleting the prose the
 * user already watched arrive would hide what the provider did. The retry
 * notice is written between the two, so the transcript reads as what it is —
 * a cut-off attempt, a stated retry, then the real answer.
 */

/**
 * Attempts spent on a dropped stream, and the pause between them.
 *
 * Deliberately tighter than `SessionRetry.RETRY_LIMIT_DEFAULT` (8). A 429 costs
 * nothing to repeat — the provider rejected the request before generating. A
 * dropped stream is the opposite: the prompt was accepted, processed and
 * BILLED, and every redo bills it again. Eight redos of a long-context step is
 * real money spent silently. Three attempts covers a transient hiccup; a fourth
 * failure means the route is genuinely unwell and the user should be told.
 *
 * The backoff is short for the same reason the ladder is: nothing is asking us
 * to wait. A rate limit names a wait; a severed socket does not, and a user
 * watching a stalled chat gains nothing from 30 seconds of silence.
 */
export const LIMIT_DEFAULT = 3
export const DELAY_BASE = 500
export const DELAY_MAX = 4000

export function limit() {
  const raw = Number.parseInt(process.env["ORIGAMI_STREAM_DROP_RETRY_LIMIT"] ?? "", 10)
  if (Number.isInteger(raw) && raw >= 0) return raw
  return LIMIT_DEFAULT
}

/** `attempt` is 1-based, matching `SessionRetry.delay`. */
export function delay(attempt: number) {
  return Math.min(DELAY_BASE * Math.pow(2, Math.max(0, attempt - 1)), DELAY_MAX)
}

/**
 * A stream that ran out of events without ever naming a finish reason, AND
 * left nothing behind worth keeping.
 *
 * The two runtimes spell the same silence differently. `@origami/llm`'s OpenAI
 * Chat protocol emits its whole finish lifecycle only `if (reason)`
 * (`protocols/openai-chat.ts`, `finishEvents`), so a body that ends with no
 * `finish_reason` produces NO `step-finish` at all and the assistant message
 * keeps an unset `finish`. The AI SDK path instead maps the missing reason to
 * the literal `"unknown"` (`llm/ai-sdk.ts`, `finishReason`). Both spellings
 * mean the same thing: nobody told us how this step ended.
 *
 * That fact alone does NOT decide the repair. `session/processor.ts` splits it
 * on a second one — whether the attempt committed prose. Prose plus an
 * unreadable reason is a finished generation with a mangled label, so the turn
 * is kept and the loop continues instead (upstream opencode 1.18.21's rule,
 * bounded in `session/prompt.ts` by `UNKNOWN_CONTINUE_LIMIT`). Only the silent
 * case reaches this error.
 *
 * It belongs to this family because for THAT case the cure is the family's own
 * — re-send the identical request, a bounded number of times, and say so. It is
 * carried as a `code` rather than as prose so the classifier reads it the way it
 * reads undici's `UND_ERR_*`, and so no provider sentence can collide with it.
 */
export const NO_FINISH_CODE = "stream_ended_early"

export function endedEarly() {
  return Object.assign(new Error("The provider stream ended with no finish reason."), { code: NO_FINISH_CODE })
}

/**
 * Every member is keyed on a message this engine has actually seen, or on a
 * code the runtime under it emits by name. Nothing here is inferred from what a
 * gateway "probably" says.
 *
 * The bar for membership is one question: could re-sending the identical
 * request plausibly succeed? A refusal, a bad key, a context overflow and a
 * content filter all answer no, and none of them can match these patterns.
 */
const PATTERNS: readonly { readonly re: RegExp; readonly why: string }[] = [
  {
    // The owner's live failure, 2026-08-21, openrouter/stealth/ox-alpha: a long
    // reasoning pause with no token emitted, so OpenRouter's gateway cut the
    // stream. Reaches us as the bare string "Upstream idle timeout exceeded".
    re: /\bidle timeout\b/i,
    why: "gateway idle timeout",
  },
  {
    // Node/undici socket faults. The engine already treats the top-level
    // `code === "ECONNRESET"` shape as retryable in `MessageV2.fromError`; these
    // are the same faults once a provider package has flattened them to text,
    // where that `code` check no longer reaches them.
    re: /\b(?:econnreset|econnaborted|etimedout|epipe|socket hang ?up|connection reset)\b/i,
    why: "socket reset",
  },
  {
    // The body ended before the response did. `ERR_STREAM_PREMATURE_CLOSE` is
    // Node's own name for it; `UND_ERR_*` are undici's.
    re: /\b(?:premature close|err_stream_premature_close|und_err_socket|und_err_body_timeout|und_err_headers_timeout)\b/i,
    why: "premature close",
  },
  {
    // undici raises `TypeError: terminated` (and `fetch failed`) when a body is
    // cut mid-flight. Anchored to the whole message: "terminated" as one word
    // inside a longer sentence is not evidence of a transport fault.
    re: /^\s*(?:terminated|fetch failed)\s*$/i,
    why: "connection terminated",
  },
  {
    // Gateway 5xx phrasing. `@ai-sdk/openai-compatible` throws the status code
    // away for mid-stream error frames, so the words are the only signal left —
    // `SessionRetry.retryable`'s `statusCode >= 500` branch never sees these.
    re: /\b(?:bad gateway|gateway time-?out|service unavailable|internal server error|upstream (?:error|connect error|request timeout))\b/i,
    why: "upstream server error",
  },
  {
    // Capacity, mid-stream. The APIError path already reads "Overloaded"; this
    // is the same condition arriving as a stream frame instead of a status.
    re: /\b(?:overloaded|temporarily unavailable|no instances available)\b/i,
    why: "provider overloaded",
  },
  {
    // The engine's own code, written by `endedEarly` above. `text()` reads an
    // Error's `code`, so this arrives the same way a socket fault's code does.
    re: new RegExp(`\\b${NO_FINISH_CODE}\\b`),
    why: "no finish reason",
  },
]

/** How deep to follow `cause` chains. undici nests the real code one level in. */
const DEPTH = 3

function text(value: unknown, depth = 0): string {
  if (depth > DEPTH || value === null || value === undefined) return ""
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (value instanceof Error) {
    return [value.name, value.message, text((value as { code?: unknown }).code, depth + 1), text(value.cause, depth + 1)]
      .filter(Boolean)
      .join(" ")
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>
    return [record["message"], record["code"], record["type"], record["reason"], record["cause"]]
      .map((entry) => text(entry, depth + 1))
      .filter(Boolean)
      .join(" ")
  }
  return ""
}

/**
 * The transient reason this value names, or undefined for anything else.
 *
 * Conservative on purpose, in both directions. A value it cannot read falls
 * through to the existing unknown-error path unchanged, and an aborted turn is
 * never a drop — the user cancelled, and undici reports a cancelled body with
 * the same vocabulary a severed one uses. `MessageV2.fromError` already makes
 * that distinction for `ZlibError`; this makes it for the same reason.
 */
export function detect(value: unknown, aborted?: boolean): { message: string; why: string } | undefined {
  if (aborted) return undefined
  const flat = text(value)
  if (!flat) return undefined
  const hit = PATTERNS.find((pattern) => pattern.re.test(flat))
  if (!hit) return undefined
  // The message the user reads is the provider's own sentence when there is
  // one, never the JSON blob `NamedError.Unknown` used to produce.
  const message = typeof value === "string" ? value : messageOf(value) || flat
  return { message: message.trim(), why: hit.why }
}

function messageOf(value: unknown): string {
  if (value instanceof Error) return value.message
  if (value && typeof value === "object") {
    const own = (value as Record<string, unknown>)["message"]
    if (typeof own === "string") return own
  }
  return ""
}

/** True when an already-classified error is a member of this family. */
export function isDrop(error: Err): boolean {
  if (!SessionV1.APIError.isInstance(error)) return false
  return error.data.metadata?.["code"] === CODE
}

/**
 * The one line the user reads in the chat, in place of a dead turn. `detail` is
 * the provider's own sentence, kept verbatim so the transcript records WHICH
 * gateway said what — the reason a drop happened is often the only clue the
 * user has about which route is unwell.
 */
export function notice(attempt: number, detail: string): string {
  return `Stream dropped (${detail}) — retrying, attempt ${attempt} of ${limit()}.`
}

export * as SessionStreamDrop from "./stream-drop"
