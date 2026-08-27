import { describe, expect, test } from "bun:test"
import { APICallError, LoadAPIKeyError } from "ai"
import { Effect } from "effect"
import { ModelV2 } from "@origami/core/model"
import { ProviderV2 } from "@origami/core/provider"
import { SessionV1 } from "@origami/core/v1/session"
import { FlockHealth } from "@/flock/health"
import type { FlockRouting } from "@/flock/routing"
import { ProviderError } from "@/provider/error"
import { MessageV2 } from "@/session/message-v2"
import { PartID, MessageID, SessionID } from "@/session/schema"
import { ProviderTest } from "../fake/provider"

const providerID = ProviderV2.ID.make("test")

const binding = (modelID: string): FlockRouting.Binding => ({
  providerID,
  modelID: ModelV2.ID.make(modelID),
})

const model = (modelID: string) => ProviderTest.model({ providerID, id: ModelV2.ID.make(modelID) })

/**
 * An `APICallError` the way the AI SDK builds one. Status-carrying failures come
 * back from `postToApi`; the status-less, retryable one is verbatim the shape
 * `handleFetchError` produces for a refused connection or a DNS failure
 * (@ai-sdk/provider-utils, "Cannot connect to API: ...", isRetryable: true).
 */
const api = (input: { statusCode?: number; isRetryable?: boolean; message?: string }) =>
  new APICallError({
    message: input.message ?? "boom",
    url: "https://example.invalid/v1/chat/completions",
    requestBodyValues: {},
    statusCode: input.statusCode,
    responseHeaders: {},
    isRetryable: input.isRetryable ?? false,
  })

/**
 * Every row feeds a REAL provider or transport failure through
 * `MessageV2.fromError` — the single funnel every LLM failure in this engine
 * passes through — and states both what it becomes and whether that counts as
 * binding sickness. Classifying the funnel's output rather than a hand-written
 * error object is the point: a shape that stops arriving, or starts arriving
 * differently, breaks this table instead of silently changing routing.
 */
const SHAPES: { case: string; raw: unknown; becomes: string; health: boolean }[] = [
  {
    case: "connection refused or DNS failure (no status, retryable)",
    raw: api({ message: "Cannot connect to API: fetch failed", isRetryable: true }),
    becomes: "APIError",
    health: true,
  },
  {
    case: "socket reset mid-response",
    raw: Object.assign(new Error("The socket connection was closed unexpectedly"), {
      code: "ECONNRESET",
      syscall: "read",
    }),
    becomes: "APIError",
    health: true,
  },
  {
    case: "response headers timed out",
    raw: new ProviderError.HeaderTimeoutError(10_000),
    becomes: "APIError",
    health: true,
  },
  {
    case: "response stream broke",
    raw: new ProviderError.ResponseStreamError("stream ended before finish"),
    becomes: "APIError",
    health: true,
  },
  { case: "HTTP 401", raw: api({ statusCode: 401 }), becomes: "APIError", health: true },
  { case: "HTTP 403", raw: api({ statusCode: 403 }), becomes: "APIError", health: true },
  { case: "HTTP 404", raw: api({ statusCode: 404 }), becomes: "APIError", health: true },
  { case: "HTTP 408", raw: api({ statusCode: 408 }), becomes: "APIError", health: true },
  { case: "HTTP 429", raw: api({ statusCode: 429 }), becomes: "APIError", health: true },
  { case: "HTTP 500", raw: api({ statusCode: 500 }), becomes: "APIError", health: true },
  { case: "HTTP 503", raw: api({ statusCode: 503 }), becomes: "APIError", health: true },
  {
    case: "no API key for this provider",
    raw: new LoadAPIKeyError({ message: "API key is missing" }),
    becomes: "ProviderAuthError",
    health: true,
  },
  // Below the line: a request the next binding would reject in exactly the same
  // way, or an outcome that is not a failure of the endpoint at all.
  { case: "HTTP 400", raw: api({ statusCode: 400 }), becomes: "APIError", health: false },
  { case: "HTTP 422", raw: api({ statusCode: 422 }), becomes: "APIError", health: false },
  {
    case: "HTTP 400 the SDK marked retryable anyway",
    raw: api({ statusCode: 400, isRetryable: true }),
    becomes: "APIError",
    health: false,
  },
  {
    case: "payload past the context window",
    raw: api({ statusCode: 413 }),
    becomes: "ContextOverflowError",
    health: false,
  },
  {
    case: "quota exhausted, reported in the stream",
    raw: {
      message: JSON.stringify({
        type: "error",
        error: { type: "insufficient_quota", code: "insufficient_quota", message: "You exceeded your quota" },
      }),
    },
    becomes: "APIError",
    health: false,
  },
  {
    case: "prompt the provider refused, reported in the stream",
    raw: {
      message: JSON.stringify({
        type: "error",
        error: { type: "invalid_request", code: "invalid_prompt", message: "Invalid prompt" },
      }),
    },
    becomes: "APIError",
    health: false,
  },
  {
    case: "user or engine cancelled the turn",
    raw: new DOMException("The operation was aborted", "AbortError"),
    becomes: "MessageAbortedError",
    health: false,
  },
  { case: "anything unrecognised", raw: new Error("kaboom"), becomes: "UnknownError", health: false },
]

describe("FlockHealth.isHealthClass", () => {
  for (const shape of SHAPES) {
    test(`${shape.case} -> ${shape.becomes}, ${shape.health ? "walks" : "surfaces"}`, () => {
      const error = MessageV2.fromError(shape.raw, { providerID })
      // Anchor the row to reality: if the funnel stops producing this shape the
      // classification below is being asserted about something that never
      // happens, which is worse than a wrong answer.
      expect(String(error.name)).toBe(shape.becomes)
      expect(FlockHealth.isHealthClass(error)).toBe(shape.health)
    })
  }

  test("a stream error the engine could not parse never walks", () => {
    const error = MessageV2.fromError({ nonsense: true }, { providerID })
    expect(error.name).toBe("UnknownError")
    expect(FlockHealth.isHealthClass(error)).toBe(false)
  })
})

const part = (input: { type: SessionV1.Part["type"]; text?: string }) =>
  ({
    id: PartID.ascending(),
    messageID: MessageID.ascending(),
    sessionID: SessionID.descending(),
    ...input,
  }) as unknown as SessionV1.Part

describe("FlockHealth.produced", () => {
  test("nothing written yet", () => {
    expect(FlockHealth.produced([])).toBe(false)
    expect(FlockHealth.produced([part({ type: "text", text: "" })])).toBe(false)
    expect(FlockHealth.produced([part({ type: "text", text: "   \n" })])).toBe(false)
    expect(FlockHealth.produced([part({ type: "step-start" })])).toBe(false)
  })

  test("text, reasoning or a tool call is output a retry would duplicate", () => {
    expect(FlockHealth.produced([part({ type: "text", text: "half an answer" })])).toBe(true)
    expect(FlockHealth.produced([part({ type: "reasoning", text: "thinking" })])).toBe(true)
    // A tool part counts even with nothing to show for it: the side effect on
    // the user's files has already happened.
    expect(FlockHealth.produced([part({ type: "tool" })])).toBe(true)
  })
})

/** A failure that walks, and one that does not, in the engine's own shapes. */
const sick = () => MessageV2.fromError(api({ statusCode: 429 }), { providerID })
const bad = () => MessageV2.fromError(api({ statusCode: 400 }), { providerID })

/** Runs a walk and records exactly which candidates were actually attempted. */
function run(input: {
  candidates: string[]
  present: string[]
  answer: (modelID: string, attempt: number) => FlockHealth.Trial<string>
}) {
  const attempted: string[] = []
  const provider = ProviderTest.registry(input.present.map(model))
  return FlockHealth.walk({
    candidates: input.candidates.map(binding),
    provider,
    attempt: (mdl) =>
      Effect.sync(() => {
        attempted.push(mdl.id)
        return input.answer(mdl.id, attempted.length)
      }),
  }).pipe(Effect.map((outcome) => ({ outcome, attempted })))
}

describe("FlockHealth.walk", () => {
  test("skips a candidate the provider registry does not have", async () => {
    const { outcome, attempted } = await Effect.runPromise(
      run({
        candidates: ["ghost", "spare"],
        present: ["spare"],
        answer: (id) => FlockHealth.ok(id),
      }),
    )
    expect(attempted).toEqual(["spare"])
    expect(outcome).toMatchObject({ kind: "ok", index: 1, value: "spare" })
  })

  test("walks past an unhealthy candidate onto the next", async () => {
    const { outcome, attempted } = await Effect.runPromise(
      run({
        candidates: ["primary", "spare"],
        present: ["primary", "spare"],
        answer: (id) => (id === "primary" ? FlockHealth.failed(sick(), false) : FlockHealth.ok(id)),
      }),
    )
    expect(attempted).toEqual(["primary", "spare"])
    expect(outcome).toMatchObject({ kind: "ok", value: "spare" })
  })

  test("stops on a failure the next binding would repeat", async () => {
    const { outcome, attempted } = await Effect.runPromise(
      run({
        candidates: ["primary", "spare"],
        present: ["primary", "spare"],
        answer: () => FlockHealth.failed(bad(), false),
      }),
    )
    // The whole point of the 400/422 rule: the spare is never spent reproducing
    // a request that is wrong everywhere.
    expect(attempted).toEqual(["primary"])
    expect(outcome).toMatchObject({ kind: "failed", index: 0 })
  })

  test("never walks after the attempt has already produced output", async () => {
    const { outcome, attempted } = await Effect.runPromise(
      run({
        candidates: ["primary", "spare"],
        present: ["primary", "spare"],
        // Sickness — but it arrived mid-stream, with output already in the
        // session. A second attempt would duplicate the output and the bill.
        answer: () => FlockHealth.failed(sick(), true),
      }),
    )
    expect(attempted).toEqual(["primary"])
    expect(outcome).toMatchObject({ kind: "failed", index: 0, failure: { produced: true } })
  })

  test("attempts each candidate at most once, so the bound is the chain length", async () => {
    const { outcome, attempted } = await Effect.runPromise(
      run({
        candidates: ["a", "b", "c"],
        present: ["a", "b", "c"],
        answer: () => FlockHealth.failed(sick(), false),
      }),
    )
    expect(attempted).toEqual(["a", "b", "c"])
    // Sick to the last: the final sickness is the answer, not an absence of one.
    expect(outcome).toMatchObject({ kind: "failed", index: 2 })
    if (outcome.kind === "failed") expect(outcome.binding.modelID).toBe(ModelV2.ID.make("c"))
  })

  test("a chain with nothing available at all spends nothing and defers (D10)", async () => {
    const { outcome, attempted } = await Effect.runPromise(
      run({
        candidates: ["ghost", "phantom"],
        present: [],
        answer: (id) => FlockHealth.ok(id),
      }),
    )
    expect(attempted).toEqual([])
    expect(outcome).toEqual({ kind: "exhausted" })
  })

  test("a candidate that ran counts, even when the ones after it are missing", async () => {
    const { outcome, attempted } = await Effect.runPromise(
      run({
        candidates: ["primary", "ghost"],
        present: ["primary"],
        answer: () => FlockHealth.failed(sick(), false),
      }),
    )
    // Not "exhausted": something really was spent and really did fail, and the
    // caller must not treat that as "Flock had no opinion".
    expect(attempted).toEqual(["primary"])
    expect(outcome).toMatchObject({ kind: "failed", index: 0 })
  })

  test("carries the failing attempt's own value back to the caller", async () => {
    const { outcome } = await Effect.runPromise(
      run({
        candidates: ["primary"],
        present: ["primary"],
        answer: (id) => FlockHealth.failed(bad(), false, `${id}-partial`),
      }),
    )
    expect(outcome).toMatchObject({ kind: "failed", failure: { value: "primary-partial" } })
  })
})
