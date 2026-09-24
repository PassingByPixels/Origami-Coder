import { LLMEvent } from "@origami/llm"
import { describe, expect, test } from "bun:test"
import { LLMParityDiff } from "./diff"

const sdkText = (id: string, chunks: ReadonlyArray<string>) => [
  LLMEvent.textStart({ id }),
  ...chunks.map((text) => LLMEvent.textDelta({ id, text })),
  LLMEvent.textEnd({ id }),
]

describe("llm parity diff", () => {
  test("renames block ids so differently minted text ids compare equal", () => {
    const aiSdk = sdkText("text-0", ["parity ", "check"])
    const native = sdkText("0", ["parity ", "check"])

    expect(LLMParityDiff.canonicalize(aiSdk).map((event) => event["id"])).toEqual(["text#0", "text#0", "text#0", "text#0"])
    expect(LLMParityDiff.diff(LLMParityDiff.canonicalize(aiSdk), LLMParityDiff.canonicalize(native)).firstDiffIndex).toBe(-1)
  })

  test("keeps two distinct blocks distinct after renaming", () => {
    const one = [...sdkText("a", ["x"]), ...sdkText("b", ["y"])]
    const two = [...sdkText("a", ["x"]), ...sdkText("a", ["y"])]

    expect(LLMParityDiff.canonicalize(one).map((event) => event["id"])).toContain("text#1")
    expect(LLMParityDiff.diff(LLMParityDiff.canonicalize(one), LLMParityDiff.canonicalize(two)).firstDiffIndex).not.toBe(-1)
  })

  test("chunking differences vanish in the semantic view but survive in the strict view", () => {
    const coarse = sdkText("text-0", ["parity check"])
    const fine = sdkText("text-0", ["par", "ity ", "check"])

    expect(LLMParityDiff.diff(LLMParityDiff.semantic(coarse), LLMParityDiff.semantic(fine)).firstDiffIndex).toBe(-1)
    expect(LLMParityDiff.diff(LLMParityDiff.canonicalize(coarse), LLMParityDiff.canonicalize(fine)).firstDiffIndex).toBe(1)
  })

  test("does not join deltas across a block boundary", () => {
    const joined = LLMParityDiff.semantic([...sdkText("a", ["x"]), ...sdkText("b", ["y"])])

    expect(joined.filter((event) => event["type"] === "text-delta").map((event) => event["text"])).toEqual(["x", "y"])
  })

  test("catches a differing tool-call input", () => {
    const call = (city: string) => [LLMEvent.toolCall({ id: "call_1", name: "get_weather", input: { city } })]
    const result = LLMParityDiff.diff(LLMParityDiff.semantic(call("Paris")), LLMParityDiff.semantic(call("Berlin")))

    expect(result.firstDiffIndex).toBe(0)
    expect(result.b).toMatchObject({ type: "tool-call", input: { city: "Berlin" } })
  })

  test("catches a tool-call id that differs, because server-issued ids are not renamed", () => {
    const left = [LLMEvent.toolCall({ id: "call_1", name: "get_weather", input: {} })]
    const right = [LLMEvent.toolCall({ id: "call_2", name: "get_weather", input: {} })]

    expect(LLMParityDiff.diff(LLMParityDiff.semantic(left), LLMParityDiff.semantic(right)).firstDiffIndex).toBe(0)
  })

  test("catches an undefined usage field against a number", () => {
    const withReasoning = [LLMEvent.finish({ reason: "stop", usage: { inputTokens: 10, outputTokens: 4, reasoningTokens: 2 } })]
    const without = [LLMEvent.finish({ reason: "stop", usage: { inputTokens: 10, outputTokens: 4 } })]
    const result = LLMParityDiff.diff(LLMParityDiff.semantic(withReasoning), LLMParityDiff.semantic(without))

    // The gate view is the consumed projection (absent = 0), the strict view
    // keeps the raw field.
    expect(result.firstDiffIndex).toBe(0)
    expect(result.a).toMatchObject({ usage: { reasoning: 2, output: 2 } })
    expect(result.b).toMatchObject({ usage: { reasoning: 0, output: 4 } })
    const strict = LLMParityDiff.diff(LLMParityDiff.canonicalize(withReasoning), LLMParityDiff.canonicalize(without))
    expect(strict.b).toMatchObject({ usage: { reasoningTokens: null } })
  })

  test("the gate view does not see an absent breakdown field as different from zero", () => {
    // What the two runtimes really emit for a server that reports no details:
    // the AI SDK fills 0, @origami/llm leaves undefined and adds a derived
    // field the engine never reads. Session.getUsage sees the same numbers.
    const aiSdk = [
      LLMEvent.finish({
        reason: "stop",
        usage: { inputTokens: 99, outputTokens: 33, totalTokens: 132, reasoningTokens: 0, cacheReadInputTokens: 0 },
      }),
    ]
    const native = [
      LLMEvent.finish({
        reason: "stop",
        usage: { inputTokens: 99, outputTokens: 33, totalTokens: 132, cacheReadInputTokens: 0, nonCachedInputTokens: 99 },
      }),
    ]
    expect(LLMParityDiff.diff(LLMParityDiff.semantic(aiSdk), LLMParityDiff.semantic(native)).firstDiffIndex).toBe(-1)
    expect(LLMParityDiff.diff(LLMParityDiff.canonicalize(aiSdk), LLMParityDiff.canonicalize(native)).firstDiffIndex).toBe(0)
  })

  test("ignores providerMetadata in the strict view and exposes it separately", () => {
    const bare = [LLMEvent.textDelta({ id: "text-0", text: "hi" })]
    const decorated = [LLMEvent.textDelta({ id: "text-0", text: "hi", providerMetadata: { openai: { itemId: "x" } } })]

    expect(LLMParityDiff.diff(LLMParityDiff.canonicalize(bare), LLMParityDiff.canonicalize(decorated)).firstDiffIndex).toBe(-1)
    expect(LLMParityDiff.diff(LLMParityDiff.metadata(bare), LLMParityDiff.metadata(decorated)).firstDiffIndex).toBe(0)
  })

  test("reports a length difference at the first missing index", () => {
    const short = sdkText("text-0", ["a"])
    const long = [...short, LLMEvent.finish({ reason: "stop" })]
    const result = LLMParityDiff.diff(LLMParityDiff.semantic(short), LLMParityDiff.semantic(long))

    expect(result).toMatchObject({ aLength: 3, bLength: 4, firstDiffIndex: 3 })
    expect(LLMParityDiff.describe(result)).toBe("diff@3")
  })

  test("canonicalJson sorts keys at every depth", () => {
    expect(LLMParityDiff.canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}')
  })

  test("the gate view ignores the native tool runtime's structured output echo, the strict view keeps it", () => {
    const result = { type: "json" as const, value: { temperature: 22 } }
    const aiSdk = [LLMEvent.toolResult({ id: "call_1", name: "get_weather", result })]
    const native = [
      LLMEvent.toolResult({
        id: "call_1",
        name: "get_weather",
        result,
        output: { structured: { temperature: 22 }, content: [] },
      }),
    ]
    expect(LLMParityDiff.diff(LLMParityDiff.semantic(aiSdk), LLMParityDiff.semantic(native)).firstDiffIndex).toBe(-1)
    expect(LLMParityDiff.diff(LLMParityDiff.canonicalize(aiSdk), LLMParityDiff.canonicalize(native)).firstDiffIndex).toBe(0)
  })
})
