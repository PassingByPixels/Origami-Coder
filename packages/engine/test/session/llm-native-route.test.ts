import { describe, expect, test } from "bun:test"
import { LLMNativeRoute } from "@/session/llm/native-route"

const model = (npm: string) => ({ api: { id: "m", url: "", npm } })

describe("session.llm-native.route", () => {
  test("derives the family from the provider package", () => {
    expect(LLMNativeRoute.family("@ai-sdk/openai-compatible")).toBe("openai-compatible")
    expect(LLMNativeRoute.family("@ai-sdk/openai")).toBe("openai")
    expect(LLMNativeRoute.family("@ai-sdk/anthropic")).toBe("anthropic")
    expect(LLMNativeRoute.family("@ai-sdk/xai")).toBe("xai")
    expect(LLMNativeRoute.family("unknown-provider-package")).toBe("other")
  })

  test("the nine small-provider facades are each their own family, npm-mapped and off by default", () => {
    const byNpm: ReadonlyArray<readonly [string, LLMNativeRoute.Family]> = [
      ["@ai-sdk/mistral", "mistral"],
      ["@ai-sdk/groq", "groq"],
      ["@ai-sdk/cerebras", "cerebras"],
      ["@ai-sdk/deepinfra", "deepinfra"],
      ["@ai-sdk/togetherai", "togetherai"],
      ["@ai-sdk/perplexity", "perplexity"],
      ["@ai-sdk/alibaba", "alibaba"],
      ["venice-ai-sdk-provider", "venice"],
      ["@ai-sdk/vercel", "v0"],
    ]
    const off = { experimentalNativeLlm: false, nativeLlmFamilies: "" }
    for (const [npm, family] of byNpm) {
      expect(LLMNativeRoute.family(npm)).toBe(family)
      expect(LLMNativeRoute.DEFAULTS[family]).toBe(false)
      expect(LLMNativeRoute.enabled(model(npm), off)).toBe(false)
    }
    // ORIGAMI_NATIVE_LLM_FAMILIES=mistral turns ONLY mistral on.
    const mistralOn = { experimentalNativeLlm: false, nativeLlmFamilies: "mistral" }
    expect(LLMNativeRoute.enabled(model("@ai-sdk/mistral"), mistralOn)).toBe(true)
    expect(LLMNativeRoute.enabled(model("@ai-sdk/groq"), mistralOn)).toBe(false)
  })

  test("an explicit family list overrides the defaults", () => {
    const flags = (nativeLlmFamilies: string) => ({ experimentalNativeLlm: false, nativeLlmFamilies })
    expect(LLMNativeRoute.enabled(model("@ai-sdk/openai-compatible"), flags("none"))).toBe(false)
    expect(LLMNativeRoute.enabled(model("@ai-sdk/xai"), flags("all"))).toBe(true)
    expect(LLMNativeRoute.enabled(model("@ai-sdk/anthropic"), flags("anthropic, google"))).toBe(true)
    expect(LLMNativeRoute.enabled(model("@ai-sdk/openai-compatible"), flags("anthropic"))).toBe(false)
    // xai is its own family now: naming it turns ONLY it on.
    expect(LLMNativeRoute.enabled(model("@ai-sdk/xai"), flags("xai"))).toBe(true)
    expect(LLMNativeRoute.enabled(model("@ai-sdk/openai"), flags("xai"))).toBe(false)
    expect(LLMNativeRoute.enabled(model("@ai-sdk/xai"), flags("none"))).toBe(false)
    // The legacy flag still wins over an explicit "none".
    expect(LLMNativeRoute.enabled(model("@ai-sdk/xai"), { experimentalNativeLlm: true, nativeLlmFamilies: "none" })).toBe(
      true,
    )
  })

  test("phase 3 defaults: OpenAI-compatible, OpenAI, Anthropic, OpenRouter, xAI and Copilot on, every other family off", () => {
    const off = { experimentalNativeLlm: false, nativeLlmFamilies: "" }
    expect(LLMNativeRoute.enabled(model("@ai-sdk/openai-compatible"), off)).toBe(true)
    expect(LLMNativeRoute.enabled(model("@ai-sdk/openai"), off)).toBe(true)
    expect(LLMNativeRoute.enabled(model("@ai-sdk/anthropic"), off)).toBe(true)
    expect(LLMNativeRoute.enabled(model("@openrouter/ai-sdk-provider"), off)).toBe(true)
    expect(LLMNativeRoute.enabled(model("@ai-sdk/google"), off)).toBe(false)
    expect(LLMNativeRoute.enabled(model("@ai-sdk/amazon-bedrock"), off)).toBe(false)
    expect(LLMNativeRoute.enabled(model("@ai-sdk/xai"), off)).toBe(true)
    expect(LLMNativeRoute.enabled(model("@ai-sdk/github-copilot"), off)).toBe(true)
    // The families that are ON, named rather than counted.
    expect(
      Object.entries(LLMNativeRoute.DEFAULTS)
        .filter(([, on]) => on)
        .map(([family]) => family)
        .toSorted(),
    ).toEqual(["anthropic", "copilot", "openai", "openai-compatible", "openrouter", "xai"])
    // The family list still turns it back off.
    expect(LLMNativeRoute.enabled(model("@ai-sdk/openai"), { ...off, nativeLlmFamilies: "openai-compatible" })).toBe(false)
  })

  test("the experimental flag still forces every family on", () => {
    const on = { experimentalNativeLlm: true, nativeLlmFamilies: "" }
    expect(LLMNativeRoute.enabled(model("@ai-sdk/openai"), on)).toBe(true)
    expect(LLMNativeRoute.enabled(model("@ai-sdk/xai"), on)).toBe(true)
  })
})
