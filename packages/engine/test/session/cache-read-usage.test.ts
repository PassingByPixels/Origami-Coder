// A provider's cached prefix has to reach `tokens.cache.read`, whichever runtime
// carried the step.
//
// t-ffziaz: every step against the owner's vLLM lane records `cache.read = 0`
// although the server's own metrics report an 88% prefix-cache hit rate. The raw
// capture in `test/fixtures/vllm-usage-capture.md` shows why — that build never
// sends `prompt_tokens_details`, so there is nothing to read. These tests pin the
// hops the engine DOES own, so a silent regression in them can never be mistaken
// for the server's silence again.
//
// The AI SDK has moved this field twice (flat `cachedInputTokens`, then nested
// `inputTokenDetails.cacheReadTokens`), and a shape change reads as a clean zero
// rather than a crash. That is the bug class here: cache reads quietly vanishing.

import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Usage } from "@origami/llm"
import { LLMAISDK } from "@/session/llm/ai-sdk"
import { Session } from "@/session/session"
import type { Provider } from "@/provider/provider"

type AISDKAdapterEvent = Parameters<typeof LLMAISDK.toLLMEvents>[1]
// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- fixtures are narrower than AI SDK's full event union
const ev = (input: unknown) => input as AISDKAdapterEvent

/** The `finish-step` usage the AI SDK hands the adapter, as one step's Usage. */
const stepUsage = (usage: unknown) =>
  Effect.runPromise(
    LLMAISDK.toLLMEvents(LLMAISDK.adapterState(), ev({ type: "finish-step", finishReason: "stop", usage })).pipe(
      Effect.map((events) => {
        const finish = events.find((event) => event.type === "step-finish")
        if (!finish || finish.type !== "step-finish") throw new Error("no step-finish event")
        return finish.usage
      }),
    ),
  )

const model = {
  id: "Qwen/Qwen3.8-Flash-Next",
  providerID: "vllm",
  name: "Qwen3.8-Flash-Next",
  limit: { context: 262_144, output: 32_000 },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  capabilities: {
    toolcall: true,
    attachment: false,
    reasoning: true,
    temperature: true,
    input: { text: true, image: false, audio: false, video: false },
    output: { text: true, image: false, audio: false, video: false },
  },
  api: { npm: "@ai-sdk/openai-compatible" },
  options: {},
} as Provider.Model

describe("cache.read on the AI SDK runtime", () => {
  test("carries inputTokenDetails.cacheReadTokens through to cache.read", async () => {
    const usage = await stepUsage({
      inputTokens: 20_000,
      outputTokens: 120,
      totalTokens: 20_120,
      inputTokenDetails: { cacheReadTokens: 17_600 },
    })

    expect(usage?.cacheReadInputTokens).toBe(17_600)
    const tokens = Session.getUsage({ model, usage: new Usage(usage ?? {}) }).tokens
    expect(tokens.cache.read).toBe(17_600)
    // `inputTokens` is inclusive of the cached prefix, so the billable remainder
    // is what the step actually sent fresh.
    expect(tokens.input).toBe(2_400)
  })

  test("falls back to the flat cachedInputTokens the AI SDK used before the details block", async () => {
    const usage = await stepUsage({
      inputTokens: 20_000,
      outputTokens: 120,
      totalTokens: 20_120,
      cachedInputTokens: 17_600,
    })

    expect(usage?.cacheReadInputTokens).toBe(17_600)
    expect(Session.getUsage({ model, usage: new Usage(usage ?? {}) }).tokens.cache.read).toBe(17_600)
  })

  test("prefers the details block when both shapes arrive", async () => {
    const usage = await stepUsage({
      inputTokens: 20_000,
      outputTokens: 120,
      totalTokens: 20_120,
      cachedInputTokens: 1,
      inputTokenDetails: { cacheReadTokens: 17_600 },
    })

    expect(usage?.cacheReadInputTokens).toBe(17_600)
  })

  test("reports zero, not a crash, for the owner's vLLM shape with no cache fields", async () => {
    const usage = await stepUsage({ inputTokens: 20_000, outputTokens: 120, totalTokens: 20_120 })

    expect(usage?.cacheReadInputTokens).toBeUndefined()
    expect(Session.getUsage({ model, usage: new Usage(usage ?? {}) }).tokens.cache.read).toBe(0)
  })
})

describe("cache.read on the native runtime", () => {
  // `@origami/llm`'s openai-chat protocol maps `prompt_tokens_details.cached_tokens`
  // to `cacheReadInputTokens` (covered against a wire fixture in
  // packages/llm/test/provider/openai-chat.test.ts). This is the hop after it: the
  // Usage the native runtime emits, read into session tokens.
  test("reads a native Usage's cacheReadInputTokens into cache.read", () => {
    const tokens = Session.getUsage({
      model,
      usage: new Usage({
        inputTokens: 20_000,
        outputTokens: 120,
        nonCachedInputTokens: 2_400,
        cacheReadInputTokens: 17_600,
        totalTokens: 20_120,
      }),
    }).tokens

    expect(tokens.cache.read).toBe(17_600)
    expect(tokens.input).toBe(2_400)
  })
})
