import { SessionV1 } from "@origami/core/v1/session"
import { describe, expect, test } from "bun:test"
import { ProviderV2 } from "@origami/core/provider"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionRetry } from "../../src/session/retry"
import { SessionStreamDrop } from "../../src/session/stream-drop"

// ---------------------------------------------------------------------------
// Fixtures
//
// Every value below is the shape this engine actually receives, not an invented
// one. The load-bearing fact is that `@ai-sdk/openai-compatible` (2.0.41,
// dist/index.mjs) answers an `{"error":{...}}` SSE frame with
// `controller.enqueue({ type: "error", error: chunk.value.error.message })` —
// so `session/llm/ai-sdk.ts` fails the stream with a BARE STRING, no status and
// no APICallError wrapper. The owner's live failure on
// `openrouter/stealth/ox-alpha` (openrouter block, npm
// "@ai-sdk/openai-compatible", baseURL https://openrouter.ai/api/v1) read
// `Internal error: "Upstream idle timeout exceeded"` — quotes included, because
// the old fallthrough JSON.stringify'd that string.
// ---------------------------------------------------------------------------

const IDLE = "Upstream idle timeout exceeded"
const provider = ProviderV2.ID.make("openrouter")
const parse = (value: unknown, aborted?: boolean) => MessageV2.fromError(value, { providerID: provider, aborted })

describe("stream drop classifier", () => {
  test("the owner's live failure: a bare gateway idle-timeout string", () => {
    const drop = SessionStreamDrop.detect(IDLE)
    expect(drop?.why).toBe("gateway idle timeout")
    // The user reads the provider's own sentence, not a JSON blob.
    expect(drop?.message).toBe(IDLE)
  })

  test.each([
    ["socket hang up", "socket reset"],
    ["read ECONNRESET", "socket reset"],
    ["Premature close", "premature close"],
    ["UND_ERR_SOCKET", "premature close"],
    ["terminated", "connection terminated"],
    ["fetch failed", "connection terminated"],
    ["502 Bad Gateway", "upstream server error"],
    ["Service Unavailable", "upstream server error"],
    ["Upstream connect error", "upstream server error"],
    ["Provider is Overloaded", "provider overloaded"],
  ])("classifies %p as %p", (message, why) => {
    expect(SessionStreamDrop.detect(message)?.why).toBe(why)
  })

  test("reads an Error's code and its nested cause, not only its message", () => {
    const cause = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" })
    expect(SessionStreamDrop.detect(new TypeError("fetch failed", { cause }))?.why).toBeDefined()
  })

  test("reads the object shape the OpenRouter package forwards verbatim", () => {
    expect(SessionStreamDrop.detect({ message: IDLE, code: 524 })?.message).toBe(IDLE)
  })

  // A classifier that says yes too often is worse than none: it spends the
  // budget, and the retries, on a failure that can never succeed.
  test.each([
    ["Incorrect API key provided"],
    ["Input exceeds context window of this model"],
    ["Quota exceeded. Check your plan and billing details."],
    ["The response was blocked by the provider's content filter"],
    ["Invalid reasoning effort: low"],
    ["reasoning effort budget exhausted"], // names a knob, refuses nothing
    ["The request was terminated by the user because it was wrong"], // "terminated" mid-sentence
  ])("does NOT classify %p", (message) => {
    expect(SessionStreamDrop.detect(message)).toBeUndefined()
  })

  test("an aborted turn is never a drop", () => {
    // undici reports a CANCELLED body with the same vocabulary a severed one
    // uses, so the only thing separating them is that the user pressed stop.
    expect(SessionStreamDrop.detect("terminated")).toBeDefined()
    expect(SessionStreamDrop.detect("terminated", true)).toBeUndefined()
  })

  test("an unreadable value falls through untouched", () => {
    expect(SessionStreamDrop.detect(undefined)).toBeUndefined()
    expect(SessionStreamDrop.detect({})).toBeUndefined()
  })

  test("a stream that ended without naming a finish reason joins the family", () => {
    const drop = SessionStreamDrop.detect(SessionStreamDrop.endedEarly())
    expect(drop?.why).toBe("no finish reason")
    // The user reads the sentence, never the internal code.
    expect(drop?.message).toBe("The provider stream ended with no finish reason.")
    expect(drop?.message).not.toContain(SessionStreamDrop.NO_FINISH_CODE)
  })

  test("the CODE is what classifies it, not the words - prose alone must not", () => {
    // A provider is free to write this sentence; only the engine writes the code.
    expect(SessionStreamDrop.detect("The provider stream ended with no finish reason.")).toBeUndefined()
    expect(SessionStreamDrop.detect({ message: "no finish reason was given" })).toBeUndefined()
  })

  test("a finish-less stream on an ABORTED turn is the user stopping, not a drop", () => {
    expect(SessionStreamDrop.detect(SessionStreamDrop.endedEarly(), true)).toBeUndefined()
  })
})

describe("stream drop typing and budget", () => {
  test("a dropped stream becomes a RETRYABLE APIError, not an UnknownError", () => {
    const error = parse(IDLE)
    expect(error.name).toBe("APIError")
    expect(SessionV1.APIError.isInstance(error)).toBe(true)
    if (!SessionV1.APIError.isInstance(error)) return
    expect(error.data.isRetryable).toBe(true)
    expect(error.data.metadata?.["code"]).toBe(SessionStreamDrop.CODE)
    // The message the user reads is the sentence, unquoted.
    expect(error.data.message).toBe(IDLE)
  })

  test("the same string when the user aborted stays an UnknownError", () => {
    expect(parse(IDLE, true).name).toBe("UnknownError")
  })

  test("retryable() reports the family so the tighter budget applies", () => {
    expect(SessionRetry.retryable(parse(IDLE), provider)).toEqual({ message: IDLE, kind: "stream-drop" })
  })

  test("a finish-less EOF spends the SAME tight budget, not the rate-limit ladder", () => {
    const error = parse(SessionStreamDrop.endedEarly())
    expect(SessionRetry.retryable(error, provider)?.kind).toBe("stream-drop")
    expect(SessionRetry.decide(SessionStreamDrop.LIMIT_DEFAULT, error, provider)).toBeDefined()
    expect(SessionRetry.decide(SessionStreamDrop.LIMIT_DEFAULT + 1, error, provider)).toBeUndefined()
  })

  test("the budget is bounded at LIMIT_DEFAULT, well below the rate-limit ladder", () => {
    const error = parse(IDLE)
    expect(SessionStreamDrop.LIMIT_DEFAULT).toBeLessThan(SessionRetry.RETRY_LIMIT_DEFAULT)
    expect(SessionRetry.decide(SessionStreamDrop.LIMIT_DEFAULT, error, provider)).toBeDefined()
    expect(SessionRetry.decide(SessionStreamDrop.LIMIT_DEFAULT + 1, error, provider)).toBeUndefined()
  })

  test("the backoff is short — a severed socket names no wait", () => {
    const error = parse(IDLE)
    if (!SessionV1.APIError.isInstance(error)) throw new Error("expected an APIError")
    const waits = [1, 2, 3].map((attempt) => SessionRetry.delay(attempt, error))
    expect(waits).toEqual([500, 1000, 2000])
    for (const wait of waits) expect(wait).toBeLessThan(SessionRetry.RETRY_INITIAL_DELAY * 2)
  })

  test("a rate limit still spends the long ladder, unchanged", () => {
    const error = new SessionV1.APIError({
      message: "Rate limit reached",
      isRetryable: true,
      statusCode: 429,
    }).toObject()
    expect(SessionRetry.retryable(error, provider)).toEqual({ message: "Rate limit reached" })
    expect(SessionRetry.delay(1, error)).toBe(SessionRetry.RETRY_INITIAL_DELAY)
    expect(SessionRetry.decide(SessionStreamDrop.LIMIT_DEFAULT + 1, error, provider)).toBeDefined()
  })
})
