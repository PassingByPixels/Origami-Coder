import { afterEach, describe, expect, test } from "bun:test"
import fixture from "../fixtures/codex-models.json"
import {
  CODEX_MODELS_CLIENT_VERSION,
  catalogDefaultFirst,
  catalogEfforts,
  fetchCodexCatalog,
  mapCodexCatalog,
} from "../../src/plugin/openai/codexCatalog"
import { applyCodexCapabilityDefaults, matchesOauthNaming, servesOverOauth, setLiveServedModels } from "../../src/plugin/openai/codex"

afterEach(() => setLiveServedModels(undefined))

describe("codex catalog mapping", () => {
  const models = mapCodexCatalog(fixture)

  test("keeps only what the backend marks visible", () => {
    // gpt-reserve and codex-auto-review are `visibility: "hide"` — internal
    // rows that must never reach the picker.
    expect(Object.keys(models).sort()).toEqual(["gpt-5.5", "gpt-5.6-sol", "gpt-6-astra"])
  })

  test("the model the fork's own lists have never heard of comes through", () => {
    const astra = models["gpt-6-astra"]!
    expect(astra.name).toBe("GPT-6 Astra")
    expect(astra.api.id).toBe("gpt-6-astra")
    expect(astra.api.npm).toBe("@ai-sdk/openai")
  })

  test("context is the window this client may use, not the model's ceiling", () => {
    // gpt-6-astra: context_window 500k, max_context_window 1M. Sizing
    // compaction off the ceiling would let a turn run past what the backend
    // accepts, so the smaller of the two is the limit.
    expect(models["gpt-6-astra"]!.limit.context).toBe(500_000)
    // gpt-5.5 in the fixture omits context_window entirely — max_context_window
    // is the fallback, not the preference.
    expect(models["gpt-5.5"]!.limit.context).toBe(1_050_000)
  })

  test("effort levels come from the backend, past what the id tables know", () => {
    // transform.ts's OpenAI tables stop at `xhigh`. `max` and `ultra` exist only
    // because the account declared them.
    expect(new Set(Object.keys(models["gpt-6-astra"]!.variants ?? {}))).toEqual(
      new Set(["low", "medium", "high", "xhigh", "max", "ultra"]),
    )
    expect(models["gpt-6-astra"]!.variants?.["ultra"]).toMatchObject({ reasoningEffort: "ultra" })
  })

  test("the backend's OWN default leads the ladder (t-48ffvz)", () => {
    // The engine has no separate field for "the tier a chat starts on": the
    // unchosen default is `variants[0]` and the composer's effort button reads
    // the same first entry as its baseline. gpt-6-astra declares
    // `default_reasoning_level: "medium"`, so medium leads and the backend's
    // ranking follows it.
    expect(Object.keys(models["gpt-6-astra"]!.variants ?? {})).toEqual([
      "medium",
      "low",
      "high",
      "xhigh",
      "max",
      "ultra",
    ])
    expect(Object.keys(models["gpt-5.6-sol"]!.variants ?? {})).toEqual(["medium", "low", "high"])
  })

  test("a model with fewer levels gets exactly those, not the family's", () => {
    // gpt-5.5 declares no default, so the backend's order stands untouched.
    expect(Object.keys(models["gpt-5.5"]!.variants ?? {})).toEqual(["low", "high"])
  })

  test("a default the entry does not list is ignored rather than invented", () => {
    expect(
      catalogDefaultFirst({ supported_reasoning_levels: ["low", "high"], default_reasoning_level: "medium" }),
    ).toEqual(["low", "high"])
    expect(catalogDefaultFirst({ supported_reasoning_levels: ["low", "high"], default_reasoning_level: "high" })).toEqual(
      ["high", "low"],
    )
    expect(catalogDefaultFirst({})).toEqual([])
  })

  test("modalities follow the declaration, not the family", () => {
    expect(models["gpt-6-astra"]!.capabilities.input).toMatchObject({ text: true, image: true, pdf: true })
    // gpt-5.6-sol declares image but no pdf.
    expect(models["gpt-5.6-sol"]!.capabilities.input).toMatchObject({ text: true, image: true, pdf: false })
    expect(models["gpt-5.6-sol"]!.capabilities.attachment).toBe(true)
  })

  test("a subscription row is never priced", () => {
    for (const model of Object.values(models)) {
      expect(model.cost).toEqual({ input: 0, output: 0, cache: { read: 0, write: 0 } })
    }
  })

  test("priority orders the rows", () => {
    expect(Object.keys(models)).toEqual(["gpt-6-astra", "gpt-5.5", "gpt-5.6-sol"])
  })

  test("junk answers with nothing rather than half a catalogue", () => {
    expect(mapCodexCatalog(undefined)).toEqual({})
    expect(mapCodexCatalog({ models: "not an array" })).toEqual({})
    expect(mapCodexCatalog({ models: [null, { visibility: "list" }, { slug: "", visibility: "list" }] })).toEqual({})
  })

  test("reads a bare string level list as well as the object one", () => {
    expect(catalogEfforts({ supported_reasoning_levels: ["low", "high", "low"] })).toEqual(["low", "high"])
    expect(catalogEfforts({})).toEqual([])
  })
})

describe("codex catalog request", () => {
  test("sends a client version the endpoint will not filter everything out of", async () => {
    // The endpoint hides entries whose `minimal_client_version` is above the
    // version in the query string. This fork's own 0.4.x is below every
    // threshold in the fixture, so sending InstallationVersion would return an
    // EMPTY list and the whole feature would silently do nothing.
    expect(CODEX_MODELS_CLIENT_VERSION).toBe("0.200.0")
    let seen = ""
    const headers: Record<string, string> = {}
    await fetchCodexCatalog({
      accessToken: "test-token-not-a-real-credential",
      accountId: "acct-test",
      endpoint: "https://example.invalid/models",
      fetchImpl: (async (url: string, init: RequestInit) => {
        seen = String(url)
        Object.assign(headers, init.headers as Record<string, string>)
        return new Response(JSON.stringify(fixture), { status: 200 })
      }) as unknown as typeof fetch,
    })
    expect(seen).toBe("https://example.invalid/models?client_version=0.200.0")
    expect(headers["authorization"]).toBe("Bearer test-token-not-a-real-credential")
    expect(headers["ChatGPT-Account-Id"]).toBe("acct-test")
  })

  test("a 401 leaves the seed list standing", async () => {
    const result = await fetchCodexCatalog({
      accessToken: "stale",
      fetchImpl: (async () => new Response("", { status: 401 })) as unknown as typeof fetch,
    })
    expect(result).toEqual({})
  })

  test("no token means no request", async () => {
    let called = false
    await fetchCodexCatalog({
      accessToken: "",
      fetchImpl: (async () => {
        called = true
        return new Response("{}", { status: 200 })
      }) as unknown as typeof fetch,
    })
    expect(called).toBe(false)
  })
})

describe("servesOverOauth", () => {
  test("the account's live list keeps an id the name rule would strip", () => {
    // Without the live list this id has to survive on its name alone. Both
    // paths are asserted because the offline one is what a signed-out or
    // network-less session falls back to.
    setLiveServedModels(["gpt-6-astra", "gpt-5.6-sol"])
    expect(servesOverOauth("gpt-6-astra")).toBe(true)
  })

  test("a hidden id is still stripped even while a live list is held", () => {
    setLiveServedModels(["gpt-6-astra"])
    expect(servesOverOauth("gpt-reserve")).toBe(false)
    expect(servesOverOauth("codex-auto-review")).toBe(false)
  })

  test("a live listing overrules the hard gpt-5.6 refusal; without one it stands", () => {
    expect(servesOverOauth("gpt-5.6")).toBe(false)
    setLiveServedModels(["gpt-5.6"])
    expect(servesOverOauth("gpt-5.6")).toBe(true)
  })

  test("a live listing does NOT resurrect a model the backend refuses at inference", () => {
    setLiveServedModels(["gpt-5.5-pro"])
    expect(servesOverOauth("gpt-5.5-pro")).toBe(false)
  })

  test("offline, the widened name rule alone admits gpt-6-astra", () => {
    expect(servesOverOauth("gpt-6-astra")).toBe(true)
    expect(matchesOauthNaming("gpt-6-astra")).toBe(true)
  })

  test("the name rule still refuses everything it refused before", () => {
    expect(servesOverOauth("gpt-5.3-codex-spark")).toBe(false)
    expect(servesOverOauth("gpt-5.4")).toBe(true) // ALLOWED_MODELS
    expect(servesOverOauth("gpt-4o")).toBe(false)
    expect(servesOverOauth("codex-auto-review")).toBe(false)
    expect(servesOverOauth("gpt-5.5", "pro")).toBe(false)
  })

  test("a two-digit minor is no longer read as older than a one-digit one", () => {
    // parseFloat("5.10") is 5.1, which is BELOW 5.4 — the float comparison hid
    // every gpt-5.10+ id. The pair comparison does not.
    expect(matchesOauthNaming("gpt-5.10")).toBe(true)
    expect(matchesOauthNaming("gpt-5.4")).toBe(false)
    expect(matchesOauthNaming("gpt-7")).toBe(true)
  })
})

describe("capability defaults", () => {
  test("a hand-typed id that the backend serves stops resolving to all-false", () => {
    const cfg = { provider: { openai: { models: { "gpt-6-astra": {} as Record<string, unknown> } } } }
    applyCodexCapabilityDefaults(cfg)
    const model = cfg.provider.openai.models["gpt-6-astra"]!
    expect(model["modalities"]).toEqual({ input: ["text", "image", "pdf"], output: ["text"] })
    expect(model["attachment"]).toBe(true)
    expect(model["reasoning"]).toBe(true)
  })

  test("a declaration always wins", () => {
    const cfg = { provider: { openai: { models: { "gpt-6-astra": { attachment: false } as Record<string, unknown> } } } }
    applyCodexCapabilityDefaults(cfg)
    expect(cfg.provider.openai.models["gpt-6-astra"]!["attachment"]).toBe(false)
  })

  test("a platform-only id in the same block is left alone", () => {
    const cfg = { provider: { openai: { models: { "gpt-4o": {} as Record<string, unknown> } } } }
    applyCodexCapabilityDefaults(cfg)
    expect(cfg.provider.openai.models["gpt-4o"]!["attachment"]).toBeUndefined()
  })
})
