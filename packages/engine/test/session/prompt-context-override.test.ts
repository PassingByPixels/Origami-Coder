import { describe, expect, it } from "bun:test"
import { ProviderV2 } from "@origami/core/provider"
import { ModelV2 } from "@origami/core/model"
import type { Provider } from "@/provider/provider"
import { applyContextOverride } from "@/session/prompt"

// t-lmqe0g: applyContextOverride is the single point a sub-agent's stored
// context-window override reaches the resolved model — the same object
// compaction/overflow and native-request both read. It is a pure leaf on
// purpose (see docs/WORKING_ON_ORIGAMI_CODER.md Part 4) so it is testable
// without standing up session/prompt.ts's full Effect service graph.

const model: Provider.Model = {
  id: ModelV2.ID.make("qwen3-30b"),
  providerID: ProviderV2.ID.make("lmstudio"),
  api: { id: "qwen3-30b", url: "http://127.0.0.1:1234/v1", npm: "@ai-sdk/openai-compatible" },
  name: "Qwen3 30B",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 32768, output: 4096 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
  variants: {},
}

describe("applyContextOverride", () => {
  it("replaces limit.context, keeping every other field (including limit.output)", () => {
    const result = applyContextOverride(model, 131072)
    expect(result.limit).toEqual({ context: 131072, output: 4096 })
    expect(result.id).toBe(model.id)
    expect(result.api).toEqual(model.api)
    expect(result.cost).toEqual(model.cost)
  })

  it("does not mutate the input model — the SAME object other sessions read", () => {
    const before = JSON.stringify(model)
    applyContextOverride(model, 131072)
    expect(JSON.stringify(model)).toBe(before)
    expect(model.limit.context).toBe(32768)
  })

  // The main path — the ordinary chat with no sub-agent override — never sets
  // contextOverride, so this identity return IS the regression guarantee.
  it("returns the SAME object (identity) when the override is undefined — main-model path unaffected", () => {
    expect(applyContextOverride(model, undefined)).toBe(model)
  })

  it("returns the SAME object for a zero or negative override — a corrupted value must not win", () => {
    expect(applyContextOverride(model, 0)).toBe(model)
    expect(applyContextOverride(model, -5)).toBe(model)
  })
})
