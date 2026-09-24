// Cache-loss causes (t-rylleg) — the engine names the cause, nobody guesses.
//
// Half of the measured cache losses over 30 days had NO cause anything could
// derive: same model, same system and tool digests, a sub-second gap. The
// missing fact was always the same one — whether the array about to be sent was
// byte-identical to the last one — and only the request layer holds it.
//
// What these tests pin, in the order a wrong answer would hurt:
//   1. the precedence. One cause per miss, and the order is fixed. A miss that
//      is BOTH idle and tool-changed must say `tools`, or two readers of the
//      same run reach different conclusions.
//   2. "no published window" really means no claim. A local vLLM lane that
//      evicted its KV cache after an hour must say `provider`, never `idle` —
//      `idle` would send the owner to a TTL the provider never promised.
//   3. absent is not zero. A cache-blind provider (LM Studio, sglang, most vLLM
//      builds) reports no cache tokens at all, and its steps must carry no
//      `cache` block rather than a fabricated "the provider missed".
//   4. the two engine-side rewriters name themselves. Tool aging and a reminder
//      pushed into an already-sent message are the only things in this codebase
//      that rewrite sent bytes; a divergence that neither claims is `unknown`.

import { beforeEach, describe, expect, test } from "bun:test"
import { SessionCachePolicy } from "@/session/cache-policy"
import { SessionPromptCapture } from "@/session/prompt-capture"

beforeEach(() => SessionPromptCapture.reset())

/** A clean hit-shaped fact set: nothing changed, nothing is stale. */
const steady: SessionCachePolicy.Facts = {
  first: false,
  compacted: false,
  modelChanged: false,
  systemChanged: false,
  toolsChanged: false,
  preserved: true,
}

describe("the provider window table", () => {
  test("Anthropic publishes five minutes, and an hour when the request asked for one", () => {
    expect(SessionCachePolicy.windowSeconds({ providerID: "anthropic" })).toBe(300)
    expect(SessionCachePolicy.windowSeconds({ providerID: "anthropic", hintTtlSeconds: 3600 })).toBe(3600)
    // The 5-minute hint is the same window the table already holds.
    expect(SessionCachePolicy.windowSeconds({ providerID: "anthropic", hintTtlSeconds: 300 })).toBe(300)
  })

  // t-rz0amv: OpenAI publishes the window per model FAMILY, so the id decides.
  // 30 minutes on gpt-5.6+ ("eligible for reuse for 30 minutes after its most
  // recent write or reuse") and on the extended-retention families the engine
  // asks `prompt_cache_retention: "24h"` for; 5 minutes, the low end of "around
  // 5 to 10 minutes of inactivity", on every other family.
  test("OpenAI and Azure publish a window per model family", () => {
    expect(SessionCachePolicy.windowSeconds({ providerID: "openai", modelID: "gpt-5.6" })).toBe(1800)
    expect(SessionCachePolicy.windowSeconds({ providerID: "openai", modelID: "gpt-4o" })).toBe(300)
    expect(SessionCachePolicy.windowSeconds({ providerID: "openai", modelID: "gpt-5.1-codex-max" })).toBe(1800)
    expect(SessionCachePolicy.windowSeconds({ providerID: "azure", modelID: "gpt-5.2" })).toBe(1800)
    expect(SessionCachePolicy.windowSeconds({ providerID: "azure", modelID: "gpt-4.1-mini" })).toBe(1800)
  })

  test("without a model id OpenAI keeps the shortest window any of its models publishes", () => {
    expect(SessionCachePolicy.windowSeconds({ providerID: "openai" })).toBe(300)
    expect(SessionCachePolicy.windowSeconds({ providerID: "azure" })).toBe(300)
    // An id of no OpenAI family falls back to the same floor rather than none:
    // the provider still caches, we just cannot name the family.
    expect(SessionCachePolicy.windowSeconds({ providerID: "openai", modelID: "o3-mini" })).toBe(300)
  })

  test("a provider that publishes no window gets none, whatever hint the request carried", () => {
    for (const providerID of [
      "openrouter",
      "google",
      "vllm",
      "lmstudio",
      "ollama",
      "llamacpp",
      "sglang",
      "spark",
      "spark2",
      "opencode-go",
      "opencode-zen",
      "deepseek",
      "xai",
      "github-copilot",
      "a-provider-this-build-never-heard-of",
    ]) {
      expect(SessionCachePolicy.windowSeconds({ providerID })).toBeUndefined()
      expect(SessionCachePolicy.windowSeconds({ providerID, hintTtlSeconds: 3600 })).toBeUndefined()
      // A model id never creates a window for a provider that publishes none.
      expect(SessionCachePolicy.windowSeconds({ providerID, modelID: "gpt-5.6" })).toBeUndefined()
    }
  })

  test("the minimum cacheable prefix is published for two families and nobody else", () => {
    expect(SessionCachePolicy.minimumTokens({ providerID: "anthropic", modelID: "claude-sonnet-5" })).toBe(1024)
    expect(SessionCachePolicy.minimumTokens({ providerID: "anthropic", modelID: "claude-haiku-4-5" })).toBe(2048)
    expect(SessionCachePolicy.minimumTokens({ providerID: "openai", modelID: "gpt-5.6" })).toBe(1024)
    expect(SessionCachePolicy.minimumTokens({ providerID: "vllm", modelID: "GLM-5.3-Flash-EXL3" })).toBeUndefined()
    expect(SessionCachePolicy.minimumTokens({ providerID: "openrouter", modelID: "anything" })).toBeUndefined()
  })
})

describe("one cause per miss, in a fixed precedence", () => {
  test("every cause is reachable", () => {
    expect(SessionCachePolicy.cause({ ...steady, first: true })).toBe("cold")
    expect(SessionCachePolicy.cause({ ...steady, compacted: true })).toBe("compaction")
    expect(SessionCachePolicy.cause({ ...steady, modelChanged: true })).toBe("model")
    expect(SessionCachePolicy.cause({ ...steady, systemChanged: true })).toBe("system")
    expect(SessionCachePolicy.cause({ ...steady, toolsChanged: true })).toBe("tools")
    expect(SessionCachePolicy.cause({ ...steady, preserved: false })).toBe("history")
    expect(SessionCachePolicy.cause({ ...steady, idleMs: 400_000, ttlSeconds: 300 })).toBe("idle")
    expect(SessionCachePolicy.cause({ ...steady, prefillTokens: 900, minimumTokens: 1024 })).toBe("small")
    expect(SessionCachePolicy.cause(steady)).toBe("provider")
  })

  test("cold > compaction > model > system > tools > history > idle > small > provider", () => {
    // Each row turns ON one more fact than the row below it and must still
    // answer the HIGHER cause: the whole point of a single cause is that two
    // readers of one row cannot disagree.
    const all = {
      compacted: true,
      modelChanged: true,
      systemChanged: true,
      toolsChanged: true,
      preserved: false,
      idleMs: 4_000_000,
      ttlSeconds: 300,
      prefillTokens: 10,
      minimumTokens: 1024,
    }
    expect(SessionCachePolicy.cause({ ...all, first: true })).toBe("cold")
    expect(SessionCachePolicy.cause({ ...all, first: false })).toBe("compaction")
    expect(SessionCachePolicy.cause({ ...all, first: false, compacted: false })).toBe("model")
    expect(SessionCachePolicy.cause({ ...all, first: false, compacted: false, modelChanged: false })).toBe("system")
    expect(
      SessionCachePolicy.cause({
        ...all,
        first: false,
        compacted: false,
        modelChanged: false,
        systemChanged: false,
      }),
    ).toBe("tools")
    expect(
      SessionCachePolicy.cause({
        ...all,
        first: false,
        compacted: false,
        modelChanged: false,
        systemChanged: false,
        toolsChanged: false,
      }),
    ).toBe("history")
    expect(
      SessionCachePolicy.cause({
        ...all,
        first: false,
        compacted: false,
        modelChanged: false,
        systemChanged: false,
        toolsChanged: false,
        preserved: true,
      }),
    ).toBe("idle")
    expect(
      SessionCachePolicy.cause({
        ...all,
        first: false,
        compacted: false,
        modelChanged: false,
        systemChanged: false,
        toolsChanged: false,
        preserved: true,
        idleMs: 1,
      }),
    ).toBe("small")
    expect(
      SessionCachePolicy.cause({
        ...all,
        first: false,
        compacted: false,
        modelChanged: false,
        systemChanged: false,
        toolsChanged: false,
        preserved: true,
        idleMs: 1,
        prefillTokens: 100_000,
      }),
    ).toBe("provider")
  })

  test("a provider with no published window can never be blamed for going idle", () => {
    // The vLLM lane in the measurement: 34% of its mid-turn steps miss at ~100k
    // context, hours can pass, and the server promises nothing about eviction.
    expect(SessionCachePolicy.cause({ ...steady, idleMs: 8 * 3_600_000 })).toBe("provider")
  })

  test("a gap INSIDE the window is not idle, and the boundary itself is not either", () => {
    expect(SessionCachePolicy.cause({ ...steady, idleMs: 299_999, ttlSeconds: 300 })).toBe("provider")
    expect(SessionCachePolicy.cause({ ...steady, idleMs: 300_000, ttlSeconds: 300 })).toBe("provider")
    expect(SessionCachePolicy.cause({ ...steady, idleMs: 300_001, ttlSeconds: 300 })).toBe("idle")
  })

  test("`small` needs a published minimum: an unmeasured prefill claims nothing", () => {
    expect(SessionCachePolicy.cause({ ...steady, prefillTokens: 10 })).toBe("provider")
    expect(SessionCachePolicy.cause({ ...steady, minimumTokens: 1024 })).toBe("provider")
    expect(SessionCachePolicy.cause({ ...steady, prefillTokens: 1024, minimumTokens: 1024 })).toBe("provider")
  })
})

describe("a cache-blind provider is not a provider that missed", () => {
  test("usage carrying neither cache field reports no cache at all", () => {
    expect(SessionCachePolicy.reportsCache({})).toBe(false)
    expect(SessionCachePolicy.reportsCache({ cacheReadInputTokens: undefined })).toBe(false)
  })

  test("a reported ZERO is a measurement and stays one", () => {
    expect(SessionCachePolicy.reportsCache({ cacheReadInputTokens: 0 })).toBe(true)
    expect(SessionCachePolicy.reportsCache({ cacheWriteInputTokens: 0 })).toBe(true)
  })
})

/** One prepared request, the way the request layer records it. */
function request(input: {
  sessionID?: string
  at: string
  model?: string
  system?: string
  tools?: Record<string, { description: string; inputSchema: unknown }>
  messages?: { role: "user" | "assistant"; content: string }[]
  ttlSeconds?: number
  warmedAt?: number
}) {
  const sessionID = input.sessionID ?? "ses_cause"
  SessionPromptCapture.draft(sessionID, [SessionPromptCapture.part("env", input.system ?? "system text")])
  SessionPromptCapture.record({
    sessionID,
    capturedAt: input.at,
    model: input.model ?? "anthropic/claude-sonnet-5",
    base: ["base"],
    finalSystem: [input.system ?? "system text"],
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the capture reads description and schema only
    tools: (input.tools ?? {}) as never,
    messages: input.messages ?? [{ role: "user", content: "hello" }],
    ...(input.ttlSeconds === undefined ? {} : { ttlSeconds: input.ttlSeconds }),
    ...(input.warmedAt === undefined ? {} : { warmedAt: input.warmedAt }),
  })
  return SessionPromptCapture.lastRequest(sessionID)
}

describe("the request layer measures the facts the cause is derived from", () => {
  test("a session's first request is cold, and carries no gap it cannot measure", () => {
    const facts = request({ at: "2026-09-22T10:00:00.000Z" })

    expect(facts?.first).toBe(true)
    expect(facts?.idleMs).toBeUndefined()
    expect(facts?.preserved).toBeUndefined()
    expect(SessionCachePolicy.cause({ ...facts! })).toBe("cold")
  })

  test("an appended message preserves the prefix; the gap is measured either way", () => {
    request({ at: "2026-09-22T10:00:00.000Z" })
    const facts = request({
      at: "2026-09-22T10:07:00.000Z",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ],
      ttlSeconds: 300,
    })

    expect(facts?.first).toBe(false)
    expect(facts?.preserved).toBe(true)
    expect(facts?.idleMs).toBe(420_000)
    expect(facts?.divergence).toBeUndefined()
    // Seven minutes on a five-minute window: the prefix held, the clock did not.
    expect(SessionCachePolicy.cause({ ...facts! })).toBe("idle")
  })

  test("a rewritten message that was already sent is a `history` miss, with the offset", () => {
    request({ at: "2026-09-22T10:00:00.000Z", messages: [{ role: "user", content: "hello" }] })
    const facts = request({
      at: "2026-09-22T10:00:01.000Z",
      messages: [
        { role: "user", content: "hello, rewritten" },
        { role: "assistant", content: "hi" },
      ],
    })

    expect(facts?.preserved).toBe(false)
    expect(facts?.divergence?.message).toBe(0)
    expect(facts?.divergence?.role).toBe("user")
    expect(facts?.divergence?.offset).toBeGreaterThan(0)
    expect(SessionCachePolicy.cause({ ...facts! })).toBe("history")
  })

  test("the model, the system text and the tool block each move their own fact", () => {
    request({ at: "2026-09-22T10:00:00.000Z" })
    expect(request({ at: "2026-09-22T10:00:01.000Z", model: "openai/gpt-5.6" })?.modelChanged).toBe(true)
    expect(request({ at: "2026-09-22T10:00:02.000Z", system: "different" })?.systemChanged).toBe(true)

    const tools = request({
      at: "2026-09-22T10:00:03.000Z",
      system: "different",
      tools: { grep: { description: "Search files", inputSchema: { type: "object" } } },
    })
    expect(tools?.toolsChanged).toBe(true)
    expect(tools?.systemChanged).toBe(false)
  })

  test("the history digest is the third half of the prefix: it moves when the array does", () => {
    const one = request({ at: "2026-09-22T10:00:00.000Z", messages: [{ role: "user", content: "hello" }] })
    const two = request({ at: "2026-09-22T10:00:01.000Z", messages: [{ role: "user", content: "hello" }] })
    const three = request({ at: "2026-09-22T10:00:02.000Z", messages: [{ role: "user", content: "other" }] })

    expect(one?.prefix.history).toMatch(/^[0-9a-f]{16}$/)
    expect(two?.prefix.history).toBe(one!.prefix.history!)
    expect(three?.prefix.history).not.toBe(one!.prefix.history)
    // The two halves that did NOT move must not be dragged along by it.
    expect(three?.prefix.system).toBe(one!.prefix.system)
  })

  test("a request that hands over no array records no history digest rather than an empty one", () => {
    SessionPromptCapture.draft("ses_nomsg", [SessionPromptCapture.part("env", "system text")])
    SessionPromptCapture.record({
      sessionID: "ses_nomsg",
      capturedAt: "2026-09-22T10:00:00.000Z",
      model: "anthropic/claude-sonnet-5",
      base: ["base"],
      finalSystem: ["system text"],
      tools: {},
    })

    expect(SessionPromptCapture.lastRequest("ses_nomsg")?.prefix.history).toBeUndefined()
  })

  test("a compaction owns the next miss, whatever the diff then reports", () => {
    request({ at: "2026-09-22T10:00:00.000Z" })
    SessionPromptCapture.markCompacted("ses_cause")
    const after = request({
      at: "2026-09-22T10:00:30.000Z",
      messages: [{ role: "user", content: "a summary of the conversation so far" }],
    })

    expect(after?.compacted).toBe(true)
    expect(after?.preserved).toBe(false)
    expect(SessionCachePolicy.cause({ ...after! })).toBe("compaction")

    // Consumed once: the request after it is not still blaming the compaction.
    const next = request({ at: "2026-09-22T10:00:40.000Z" })
    expect(next?.compacted).toBe(false)
  })

  test("a warm inside the gap is recorded, so a long gap is not read as neglect", () => {
    request({ at: "2026-09-22T10:00:00.000Z" })
    const warmed = request({
      at: "2026-09-22T10:10:00.000Z",
      warmedAt: Date.parse("2026-09-22T10:04:00.000Z"),
      messages: [{ role: "user", content: "hello" }],
    })

    expect(warmed?.warmed).toBe(true)
    // A warm that happened BEFORE the previous request refreshed nothing since.
    expect(request({ at: "2026-09-22T10:20:00.000Z", warmedAt: Date.parse("2026-09-22T10:04:00.000Z") })?.warmed).toBe(
      false,
    )
  })
})

describe("the engine's own rewriters name themselves", () => {
  test("tool aging is recorded as the source of the divergence it caused", () => {
    request({ at: "2026-09-22T10:00:00.000Z", messages: [{ role: "user", content: "hello" }] })
    SessionPromptCapture.markRewrite("ses_cause", "tool-aging")
    const facts = request({
      at: "2026-09-22T10:00:01.000Z",
      messages: [{ role: "user", content: "[aged out]" }],
    })

    expect(facts?.divergence?.source).toBe("tool-aging")
  })

  test("a reminder pushed into a sent message is recorded as a reminder", () => {
    request({ at: "2026-09-22T10:00:00.000Z", messages: [{ role: "user", content: "hello" }] })
    SessionPromptCapture.markRewrite("ses_cause", "reminder")

    expect(
      request({ at: "2026-09-22T10:00:01.000Z", messages: [{ role: "user", content: "hello\n<reminder>" }] })
        ?.divergence?.source,
    ).toBe("reminder")
  })

  test("a mark is spent by ONE request, so a later divergence is not attributed to it", () => {
    request({ at: "2026-09-22T10:00:00.000Z", messages: [{ role: "user", content: "hello" }] })
    SessionPromptCapture.markRewrite("ses_cause", "tool-aging")
    request({ at: "2026-09-22T10:00:01.000Z", messages: [{ role: "user", content: "aged" }] })

    expect(
      request({ at: "2026-09-22T10:00:02.000Z", messages: [{ role: "user", content: "changed again" }] })?.divergence
        ?.source,
    ).toBe("unknown")
  })

  test("the system text moving while the engine's own blocks hold still is the plugin hook", () => {
    // `finalSystem` is what the plugin transform returned; the staged labeled
    // parts are what the engine built. Same blocks in, different text out.
    const sessionID = "ses_plugin"
    const draftAndRecord = (at: string, finalSystem: string, content: string) => {
      SessionPromptCapture.draft(sessionID, [SessionPromptCapture.part("env", "engine block")])
      SessionPromptCapture.record({
        sessionID,
        capturedAt: at,
        model: "anthropic/claude-sonnet-5",
        base: ["base"],
        finalSystem: [finalSystem],
        tools: {},
        messages: [{ role: "user", content }],
      })
      return SessionPromptCapture.lastRequest(sessionID)
    }

    draftAndRecord("2026-09-22T10:00:00.000Z", "engine block", "hello")
    const facts = draftAndRecord("2026-09-22T10:00:01.000Z", "engine block + plugin text", "rewritten")

    expect(facts?.systemChanged).toBe(true)
    expect(facts?.divergence?.source).toBe("plugin")
  })
})
