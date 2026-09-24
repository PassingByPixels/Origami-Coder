import { afterEach, describe, expect, test } from "bun:test"
import type { PluginInput } from "@origami/plugin"
import fixture from "../fixtures/codex-models.json"
import { fetchXaiCatalog, isXaiChatModel, mapXaiCatalog, xaiDisplayName } from "../../src/plugin/xai-catalog"
import { fetchAnthropicCatalog, mapAnthropicCatalog } from "../../src/plugin/anthropic-catalog"
import { AnthropicCatalogPlugin } from "../../src/plugin/anthropic"
import { XaiAuthPlugin } from "../../src/plugin/xai"
import { CodexAuthPlugin, servesOverOauth, setLiveServedModels } from "../../src/plugin/openai/codex"
import { applyCapabilityDefaults } from "../../src/plugin/capabilityDefaults"

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
  setLiveServedModels(undefined)
})

/** No network and no credential: every request in this file is answered from
 *  memory. `NEVER` is what a leaked real call would hit. */
function stubFetch(handler: (url: string, init: RequestInit) => Response) {
  const seen: Array<{ url: string; init: RequestInit }> = []
  globalThis.fetch = (async (url: unknown, init: RequestInit = {}) => {
    seen.push({ url: String(url), init })
    return handler(String(url), init)
  }) as unknown as typeof fetch
  return seen
}

const XAI_PAYLOAD = {
  data: [
    { id: "grok-4.5", input_modalities: ["text", "image"], output_modalities: ["text"] },
    { id: "grok-5-mini" },
    { id: "grok-2-image", input_modalities: ["text"], output_modalities: ["image"] },
    { id: "grok-imagine-video" },
  ],
}

describe("xai catalog", () => {
  test("image and video models never become picker rows", () => {
    const models = mapXaiCatalog(XAI_PAYLOAD)
    expect(Object.keys(models).sort()).toEqual(["grok-4.5", "grok-5-mini"])
  })

  test("a declared output modality decides it, the id rule only stands in", () => {
    // grok-2-image is excluded by its DECLARATION (outputs an image), which is
    // the check that keeps working when xAI names its next generator something
    // that does not say "image".
    expect(isXaiChatModel({ id: "grok-2-image", output_modalities: ["image"] })).toBe(false)
    expect(isXaiChatModel({ id: "grok-next-canvas", output_modalities: ["text"] })).toBe(true)
    // No declaration at all — the id rule.
    expect(isXaiChatModel({ id: "grok-imagine-video" })).toBe(false)
    expect(isXaiChatModel({ id: "grok-5-mini" })).toBe(true)
  })

  test("a row carries a usable context window rather than zero", () => {
    // limit.context = 0 would make session overflow compact against nothing.
    expect(mapXaiCatalog(XAI_PAYLOAD)["grok-5-mini"]!.limit.context).toBe(256_000)
  })

  test("a raw id is given a readable name", () => {
    expect(xaiDisplayName("grok-4.5")).toBe("Grok 4.5")
    expect(mapXaiCatalog(XAI_PAYLOAD)["grok-5-mini"]!.name).toBe("Grok 5 Mini")
  })

  test("variants are left to provider.ts — xAI publishes no effort list here", () => {
    expect(mapXaiCatalog(XAI_PAYLOAD)["grok-4.5"]!.variants).toBeUndefined()
  })

  test("the request carries the bearer, and a non-200 adds nothing", async () => {
    const seen = stubFetch(() => new Response(JSON.stringify(XAI_PAYLOAD), { status: 200 }))
    const models = await fetchXaiCatalog({ accessToken: "test-token-not-a-real-credential" })
    expect(seen[0]!.url).toBe("https://api.x.ai/v1/models")
    expect((seen[0]!.init.headers as Record<string, string>)["authorization"]).toBe(
      "Bearer test-token-not-a-real-credential",
    )
    expect(Object.keys(models).length).toBe(2)

    stubFetch(() => new Response("", { status: 403 }))
    expect(await fetchXaiCatalog({ accessToken: "tier-too-low" })).toEqual({})
  })

  test("the plugin asks with whichever credential is held, and with none it does not ask", async () => {
    const hooks = await XaiAuthPlugin({} as PluginInput)
    const seen = stubFetch(() => new Response(JSON.stringify(XAI_PAYLOAD), { status: 200 }))

    await hooks.provider!.discoverModels!({ auth: { type: "oauth", access: "a", refresh: "r", expires: 0 } as never })
    await hooks.provider!.discoverModels!({ auth: { type: "api", key: "k" } as never })
    expect(seen.length).toBe(2)

    expect(await hooks.provider!.discoverModels!({})).toEqual({})
    expect(seen.length).toBe(2)
  })
})

describe("anthropic catalog", () => {
  const page1 = {
    data: [
      { id: "claude-opus-4-7", display_name: "Claude Opus 4.7", type: "model" },
      { id: "not-a-model", display_name: "Something else", type: "batch" },
    ],
    has_more: true,
    last_id: "claude-opus-4-7",
  }
  const page2 = {
    data: [{ id: "claude-sonnet-5", display_name: "Claude Sonnet 5", type: "model" }],
    has_more: false,
    last_id: "claude-sonnet-5",
  }

  test("maps id and display name, and skips a row that is not a model", () => {
    const models = mapAnthropicCatalog(page1)
    expect(Object.keys(models)).toEqual(["claude-opus-4-7"])
    expect(models["claude-opus-4-7"]!.name).toBe("Claude Opus 4.7")
    expect(models["claude-opus-4-7"]!.api.npm).toBe("@ai-sdk/anthropic")
  })

  test("follows has_more with after_id and merges the pages", async () => {
    const seen = stubFetch((url) =>
      url.includes("after_id")
        ? new Response(JSON.stringify(page2), { status: 200 })
        : new Response(JSON.stringify(page1), { status: 200 }),
    )
    const models = await fetchAnthropicCatalog({ apiKey: "sk-test-not-a-real-key" })
    expect(Object.keys(models).sort()).toEqual(["claude-opus-4-7", "claude-sonnet-5"])
    expect(seen[1]!.url).toBe("https://api.anthropic.com/v1/models?after_id=claude-opus-4-7")
    const headers = seen[0]!.init.headers as Record<string, string>
    expect(headers["x-api-key"]).toBe("sk-test-not-a-real-key")
    expect(headers["anthropic-version"]).toBe("2023-06-01")
  })

  test("a has_more that never advances stops instead of looping forever", async () => {
    const seen = stubFetch(
      () => new Response(JSON.stringify({ data: [], has_more: true, last_id: undefined }), { status: 200 }),
    )
    await fetchAnthropicCatalog({ apiKey: "sk-test-not-a-real-key" })
    expect(seen.length).toBe(1)
  })

  test("a 401 adds nothing, and an oauth credential is not sent to this endpoint", async () => {
    stubFetch(() => new Response("", { status: 401 }))
    expect(await fetchAnthropicCatalog({ apiKey: "bad" })).toEqual({})

    const hooks = await AnthropicCatalogPlugin({} as PluginInput)
    const seen = stubFetch(() => new Response(JSON.stringify(page2), { status: 200 }))
    expect(
      await hooks.provider!.discoverModels!({ auth: { type: "oauth", access: "a", refresh: "r", expires: 0 } as never }),
    ).toEqual({})
    expect(seen.length).toBe(0)
  })
})

describe("codex discoverModels hook", () => {
  test("returns the live rows AND arms the filter that would otherwise strip them", async () => {
    const hooks = await CodexAuthPlugin({ client: {} } as unknown as PluginInput)
    stubFetch(() => new Response(JSON.stringify(fixture), { status: 200 }))
    const models = await hooks.provider!.discoverModels!({
      auth: { type: "oauth", access: "test-token", refresh: "r", expires: 0, accountId: "acct" } as never,
    })
    expect(Object.keys(models).sort()).toEqual(["gpt-5.5", "gpt-5.6-sol", "gpt-6-astra"])
    // The hook recorded the list, so a later provider-list build keeps the id
    // when the user writes it into origami.json by picking it.
    expect(servesOverOauth("gpt-6-astra")).toBe(true)
    expect(servesOverOauth("gpt-reserve")).toBe(false)
  })

  test("an empty answer is NOT recorded as 'this account serves nothing'", async () => {
    const hooks = await CodexAuthPlugin({ client: {} } as unknown as PluginInput)
    stubFetch(() => new Response("", { status: 401 }))
    expect(
      await hooks.provider!.discoverModels!({
        auth: { type: "oauth", access: "stale", refresh: "r", expires: 0 } as never,
      }),
    ).toEqual({})
    // Still the offline rule, not "nothing is served".
    expect(servesOverOauth("gpt-5.5")).toBe(true)
  })

  test("an api-key credential is never sent to the subscription endpoint", async () => {
    const hooks = await CodexAuthPlugin({ client: {} } as unknown as PluginInput)
    const seen = stubFetch(() => new Response("{}", { status: 200 }))
    expect(await hooks.provider!.discoverModels!({ auth: { type: "api", key: "sk-platform" } as never })).toEqual({})
    expect(seen.length).toBe(0)
  })
})

describe("shared capability defaults", () => {
  test("every provider with live discovery has a floor, and it is not all-false", () => {
    for (const id of ["openai", "anthropic", "xai", "github-copilot"]) {
      const cfg = { provider: { [id]: { models: { "some-new-id": {} as Record<string, unknown> } } } }
      applyCapabilityDefaults(cfg, id)
      const model = cfg.provider[id]!.models["some-new-id"]!
      expect(model["attachment"], id).toBe(true)
      expect(model["reasoning"], id).toBe(true)
      expect((model["modalities"] as { input: string[] }).input, id).toContain("text")
    }
  })

  test("xai claims images but not PDFs — the API takes image parts only", () => {
    const cfg = { provider: { xai: { models: { "grok-9": {} as Record<string, unknown> } } } }
    applyCapabilityDefaults(cfg, "xai")
    expect((cfg.provider.xai.models["grok-9"]!["modalities"] as { input: string[] }).input).toEqual(["text", "image"])
  })

  test("a provider with no entry is left completely alone", () => {
    const cfg = { provider: { ollama: { models: { llama: {} as Record<string, unknown> } } } }
    applyCapabilityDefaults(cfg, "ollama")
    expect(cfg.provider.ollama.models["llama"]).toEqual({})
  })
})
