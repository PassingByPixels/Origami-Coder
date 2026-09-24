// t-tc2itu, acceptance 2: a mid-stream 502 error frame must be retried inside
// the existing bounded retry ladder (session/retry.ts), not end the turn.
//
// The fixture below reproduces `openrouter · stealth/union-alpha: ERROR (code
// 502, 300 s into the stream)`, the exact message six log lines carried
// verbatim on 2026-09-17 (t-tauw49 B#11, `origami.log`, run ids b76f67c5,
// 721e5eac, ab13f327 among them). The message text is produced by THIS
// module's own `describe()`, so the `code 502` and elapsed-seconds fields it
// contains fix the fixture's shape: an uninformative sentence ("ERROR") and a
// `providerMetadata` payload whose `code` field is the numeric status.
import { describe, expect, it } from "bun:test"
import { SessionProviderErrorFrame } from "@/session/provider-error-frame"

const frame = (overrides: Partial<Parameters<typeof SessionProviderErrorFrame.describe>[0]> = {}) =>
  SessionProviderErrorFrame.describe({
    sentence: "ERROR",
    providerMetadata: { openrouter: { code: 502 } },
    providerID: "openrouter",
    modelID: "stealth/union-alpha",
    elapsedMs: 300_000,
    ...overrides,
  })

describe("SessionProviderErrorFrame.describe — a mid-stream 502", () => {
  // RED PROOF: on the unfixed module this asserted `false` — the uninformative
  // branch always set `isRetryable: false`, so `session/retry.ts`'s
  // `retryable()` (`!error.data.isRetryable && !(status >= 500)`) had no
  // status to fall back on and refused to retry a transient upstream fault.
  it("is retryable, with the payload's status carried onto the detail", () => {
    const described = frame()
    expect(described).toBeDefined()
    expect(described!.detail.isRetryable).toBe(true)
    expect(described!.detail.statusCode).toBe(502)
  })

  it("keeps the message the log actually recorded", () => {
    const described = frame()
    expect(described!.message).toBe("openrouter · stealth/union-alpha: ERROR (code 502, 300 s into the stream)")
  })

  it("reads 'overloaded' in the payload as a server failure too", () => {
    const described = frame({
      sentence: "error",
      providerMetadata: { anthropic: { type: "overloaded_error" } },
      elapsedMs: undefined,
    })
    expect(described!.detail.isRetryable).toBe(true)
    expect(described!.detail.statusCode).toBe(502)
  })
})

describe("SessionProviderErrorFrame.describe — unaffected classes", () => {
  it("still marks an ordinary 4xx uninformative frame as NOT retryable", () => {
    const described = frame({ providerMetadata: { openrouter: { code: 400 } } })
    expect(described!.detail.isRetryable).toBe(false)
    expect(described!.detail.statusCode).toBeUndefined()
  })

  it("still marks a frame with no payload code as NOT retryable", () => {
    const described = frame({ providerMetadata: undefined })
    expect(described!.detail.isRetryable).toBe(false)
    expect(described!.detail.statusCode).toBeUndefined()
  })

  it("still reads a mid-stream 429 as the rate-limit branch, unchanged", () => {
    const described = frame({ providerMetadata: { openrouter: { code: 429 } } })
    expect(described!.detail.statusCode).toBe(429)
    expect(described!.detail.isRetryable).toBe(true)
    expect(described!.detail.metadata).toEqual({ code: "rate_limit" })
  })

  it("still leaves an informative sentence bare (undefined) so the drop classifier keeps its words", () => {
    const described = frame({ sentence: "the model is warming up, please retry shortly" })
    expect(described).toBeUndefined()
  })
})
