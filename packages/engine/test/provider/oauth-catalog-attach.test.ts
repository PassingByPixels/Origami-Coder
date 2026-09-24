import { afterEach, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@origami/core/effect/layer-node"
import { ModelsDev } from "@origami/core/models-dev"
import { FSUtil } from "@origami/core/fs-util"
import { ProviderV2 } from "@origami/core/provider"
import { Auth, OAUTH_DUMMY_KEY } from "@/auth"
import { Config } from "@/config/config"
import { Env } from "../../src/env"
import { Plugin } from "../../src/plugin/index"
import { Provider } from "@/provider/provider"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

/**
 * THE LOAD-BEARING ASSUMPTION BEHIND OAUTH IN THE LAB PANE.
 *
 * This fork hard-disables the models.dev network fetch (`core/src/models-dev.ts`
 * — "FORK STRIP", `if (true) return {}`), so on a real install the provider
 * DATABASE is empty: nothing named `openai` or `xai` exists until a config
 * block declares it. `mergeProvider` (provider/provider.ts) returns EARLY when
 * `database[providerID]` is missing, so with no config block the plugin auth
 * loader's contribution is dropped on the floor and an OAuth credential buys
 * nothing at all.
 *
 * That is why the OAuth connection flow writes a provider block WITHOUT an
 * apiKey: the block is what makes the provider real, and the stored credential
 * is what makes it usable. If that stopped being true, the pane would light a
 * green pill for a provider the engine cannot resolve a single model on.
 *
 * The layer below replaces `ModelsDev` with the EMPTY database a real install
 * has — the shared test fixture (`test/tool/fixtures/models-api.json`) DOES
 * carry openai and xai, so testing against it would prove the opposite of what
 * ships.
 */

const emptyDatabase = Layer.mock(ModelsDev.Service)({
  get: () => Effect.succeed({}),
  refresh: () => Effect.void,
})

/** An auth store with exactly the credentials a test names — no disk, no env. */
const authWith = (entries: Record<string, Auth.Info>) =>
  Layer.mock(Auth.Service)({
    all: () => Effect.succeed(entries),
    get: (providerID: string) => Effect.succeed(entries[providerID]),
  })

/** A stored ChatGPT/SuperGrok OAuth credential, shaped as `auth.json` holds it. */
const oauth = (): Auth.Info => ({
  type: "oauth",
  access: "test-access-token",
  refresh: "test-refresh-token",
  expires: Date.now() + 3_600_000,
})

const providerLayer = (credentials: Record<string, Auth.Info>) =>
  LayerNode.compile(
    LayerNode.group([
      Provider.node,
      FSUtil.node,
      Env.node,
      Config.node,
      Auth.node,
      Plugin.node,
      ModelsDev.node,
      RuntimeFlags.node,
    ]),
    [
      [ModelsDev.node, emptyDatabase],
      [Auth.node, authWith(credentials)],
    ],
  )

afterEach(async () => {
  await disposeAllInstances()
})

const signedIn = testEffect(providerLayer({ openai: oauth(), xai: oauth() }))
const signedOut = testEffect(providerLayer({}))

const list = Provider.use.list()

/**
 * What the connection flow writes on a successful sign-in: npm package + the
 * model ids the plugin serves over the subscription backend, and NO
 * `options.apiKey`. `options: {}` is written verbatim by `writeModelConfig`
 * (it always sets the key), so it is here too rather than omitted.
 */
const OPENAI_OAUTH_CONFIG = {
  provider: {
    openai: {
      name: "OpenAI (ChatGPT)",
      npm: "@ai-sdk/openai",
      options: {},
      models: {
        "gpt-5.5": { name: "GPT-5.5", limit: { context: 1_050_000, output: 128_000 } },
        "gpt-5.4": { name: "GPT-5.4", limit: { context: 1_050_000, output: 128_000 } },
      },
    },
  },
}

const XAI_OAUTH_CONFIG = {
  provider: {
    xai: {
      name: "xAI (SuperGrok)",
      npm: "@ai-sdk/xai",
      options: {},
      models: {
        "grok-4.5": { name: "Grok 4.5", limit: { context: 500_000, output: 500_000 } },
      },
    },
  },
}

signedIn.instance(
  "empty models.dev + a config block + a stored OAuth credential => the openai plugin's loader is attached",
  Effect.gen(function* () {
    const providers = yield* list
    const openai = providers[ProviderV2.ID.openai]
    expect(openai, "openai must resolve from the config block alone").toBeDefined()
    expect(Object.keys(openai.models).sort()).toEqual(["gpt-5.4", "gpt-5.5"])
    // The plugin's `loader` returned these; nothing in the config did. The dummy
    // key is what stops the AI SDK bailing on "missing apiKey", and the fetch
    // wrapper is what actually injects the real bearer + routes to the ChatGPT
    // backend. Both present = the OAuth path is live.
    expect(openai.options["apiKey"]).toBe(OAUTH_DUMMY_KEY)
    expect(typeof openai.options["fetch"]).toBe("function")
  }),
  { config: OPENAI_OAUTH_CONFIG },
)

signedIn.instance(
  "the same holds for xai — the SuperGrok loader attaches to a config-declared provider",
  Effect.gen(function* () {
    const providers = yield* list
    const xai = providers[ProviderV2.ID.make("xai")]
    expect(xai, "xai must resolve from the config block alone").toBeDefined()
    expect(Object.keys(xai.models)).toEqual(["grok-4.5"])
    expect(xai.options["apiKey"]).toBe(OAUTH_DUMMY_KEY)
    expect(typeof xai.options["fetch"]).toBe("function")
  }),
  { config: XAI_OAUTH_CONFIG },
)

signedOut.instance(
  "without a credential the SAME config block resolves with no key — the credential, not the block, is the connection",
  Effect.gen(function* () {
    const providers = yield* list
    const openai = providers[ProviderV2.ID.openai]
    expect(openai, "the config block alone still declares the provider").toBeDefined()
    // No credential => the plugin auth loader loop `continue`s, so neither the
    // dummy key nor the fetch wrapper is contributed. This is the control: it
    // is what proves the assertions above come from the OAuth path and not from
    // the config block quietly carrying them.
    expect(openai.options["apiKey"]).toBeUndefined()
    expect(openai.options["fetch"]).toBeUndefined()
  }),
  { config: OPENAI_OAUTH_CONFIG },
)

signedIn.instance(
  "a leftover config apiKey does NOT displace the plugin's fetch wrapper",
  Effect.gen(function* () {
    const providers = yield* list
    const openai = providers[ProviderV2.ID.openai]
    expect(openai).toBeDefined()
    // The config re-apply pass runs AFTER the plugin auth loader, so a key the
    // user pasted into the API-key connection earlier wins the `apiKey` slot.
    // The wrapper survives that merge, and the wrapper is what strips the
    // caller's Authorization header and injects the OAuth bearer — so the OAuth
    // session, not the stale key, is what reaches the model. Recorded because
    // one provider id carries both connections, and the failure mode if this
    // ever flipped is silent: requests billed to a platform key.
    expect(openai.options["apiKey"]).toBe("sk-leftover-from-the-api-key-entry")
    expect(typeof openai.options["fetch"]).toBe("function")
  }),
  {
    config: {
      provider: {
        openai: {
          ...OPENAI_OAUTH_CONFIG.provider.openai,
          options: { apiKey: "sk-leftover-from-the-api-key-entry" },
        },
      },
    },
  },
)

signedIn.instance(
  "a stored credential WITHOUT a config block buys nothing — the empty database drops it",
  Effect.gen(function* () {
    const providers = yield* list
    expect(providers[ProviderV2.ID.openai]).toBeUndefined()
    expect(providers[ProviderV2.ID.make("xai")]).toBeUndefined()
  }),
)

/**
 * GITHUB COPILOT — the same proof, plus the one thing the other two do not do.
 *
 * openai and xai stop at "the loader attached". Copilot's plugin ALSO owns a
 * `provider.models` hook (plugin/github-copilot/models.ts's `CopilotModels.get`)
 * that replaces the config's model list with the account's live one, and that
 * hook only runs for a provider the DATABASE knows — the plugin loop in
 * provider/provider.ts reads `database[providerID]` and `continue`s when it is
 * missing, and it runs BEFORE the config extends the database. So with the
 * empty database a source-run engine has, the seed catalog is all there is; with
 * the models.dev snapshot the shipped binary bakes in (script/generate.ts), the
 * live list wins. BOTH are asserted, because the extension's seed catalog is
 * only defensible if the first one resolves at all.
 *
 * The credential path is stubbed at the FETCH boundary — no token, no network.
 */

const COPILOT_CONFIG = {
  provider: {
    "github-copilot": {
      name: "GitHub Copilot",
      npm: "@ai-sdk/github-copilot",
      options: {},
      models: {
        "gpt-4.1": {
          name: "GPT-4.1",
          limit: { context: 128_000, output: 16_384 },
          provider: { api: "https://api.githubcopilot.com" },
        },
        "gpt-5.4": {
          name: "GPT-5.4",
          limit: { context: 1_050_000, output: 128_000 },
          provider: { api: "https://api.githubcopilot.com" },
        },
      },
    },
  },
}

const copilotSignedIn = testEffect(providerLayer({ "github-copilot": oauth() }))

copilotSignedIn.instance(
  "an EMPTY database + the copilot config block + a credential => the provider resolves on its seed catalog alone",
  Effect.gen(function* () {
    const providers = yield* list
    const copilot = providers[ProviderV2.ID.make("github-copilot")]
    expect(copilot, "github-copilot must resolve from the config block alone").toBeDefined()
    expect(Object.keys(copilot.models).sort()).toEqual(["gpt-4.1", "gpt-5.4"])
    // The plugin's `loader` contributed the fetch wrapper, and that wrapper IS
    // the connection: it sets Authorization from the stored refresh token and
    // deletes any `authorization` / `x-api-key` the caller had built.
    //
    // NOTE THE DIFFERENCE FROM openai/xai, which is why this is asserted rather
    // than assumed. Those two contribute OAUTH_DUMMY_KEY (codex.ts:389) because
    // their SDKs bail on a missing apiKey. The Copilot loader contributes an
    // EMPTY string on purpose: the fork's copilot provider only builds an
    // Authorization header when `options.apiKey` is truthy
    // (core/src/github-copilot/copilot-provider.ts:62), so an empty key means
    // "do not build one" — exactly right when the wrapper overwrites it anyway.
    expect(copilot.options["apiKey"]).toBe("")
    expect(typeof copilot.options["fetch"]).toBe("function")
    // And the seed's OWN url survives: with no models.dev entry to fall back
    // on, `model.provider.api` is the only thing between this connection and
    // @ai-sdk/openai-compatible's default of https://api.openai.com/v1.
    expect(copilot.models["gpt-4.1"].api.url).toBe("https://api.githubcopilot.com")
  }),
  { config: COPILOT_CONFIG },
)

testEffect(providerLayer({}))
  .instance(
    "without a credential the block still declares the provider, but no bearer is attached",
    Effect.gen(function* () {
      const providers = yield* list
      const copilot = providers[ProviderV2.ID.make("github-copilot")]
      expect(copilot).toBeDefined()
      expect(copilot.options["apiKey"]).toBeUndefined()
      expect(copilot.options["fetch"]).toBeUndefined()
    }),
    { config: COPILOT_CONFIG },
  )

/**
 * The other half: a database that DOES know github-copilot, which is what the
 * shipped binary has (script/generate.ts inlines models.dev's api.json as the
 * ORIGAMI_MODELS_DEV define). Now the plugin's `provider.models` hook runs, and
 * the LIVE list — whatever GitHub says this account may use — replaces the seed.
 *
 * The fixture is the same api.json, so `github-copilot` here is the real entry
 * rather than a hand-built one that could satisfy the schema and nothing else.
 */
const copilotDatabase = Layer.mock(ModelsDev.Service)({
  get: () =>
    Effect.sync(() => {
      const all = require("../tool/fixtures/models-api.json") as Record<string, unknown>
      return { "github-copilot": all["github-copilot"] } as any
    }),
  refresh: () => Effect.void,
})

/** GitHub's /models answer, trimmed to the fields models.ts's schema reads. */
const COPILOT_MODELS_RESPONSE = {
  data: [
    {
      id: "gpt-4.1",
      name: "GPT-4.1 (live)",
      version: "gpt-4.1-2025-04-14",
      model_picker_enabled: true,
      supported_endpoints: ["/chat/completions"],
      capabilities: {
        family: "gpt-4.1",
        limits: { max_context_window_tokens: 128000, max_prompt_tokens: 111000, max_output_tokens: 16384 },
        supports: { tool_calls: true, streaming: true },
      },
    },
    {
      id: "claude-sonnet-5",
      name: "Claude Sonnet 5 (live)",
      version: "claude-sonnet-5-2026-06-30",
      // NOT in the picker: the hook must drop it, the way it drops the utility
      // models GitHub serves for title generation only.
      model_picker_enabled: false,
      supported_endpoints: ["/chat/completions"],
      capabilities: {
        family: "claude",
        limits: { max_context_window_tokens: 1000000, max_prompt_tokens: 900000, max_output_tokens: 128000 },
        supports: { tool_calls: true },
      },
    },
  ],
}

const copilotLive = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Provider.node,
      FSUtil.node,
      Env.node,
      Config.node,
      Auth.node,
      Plugin.node,
      ModelsDev.node,
      RuntimeFlags.node,
    ]),
    [
      [ModelsDev.node, copilotDatabase],
      [Auth.node, authWith({ "github-copilot": oauth() })],
    ],
  ),
)

copilotLive.instance(
  "with the models.dev snapshot present, the plugin's models() hook replaces the seed with GitHub's own picker list",
  Effect.gen(function* () {
    const real = globalThis.fetch
    const seen: string[] = []
    // Stubbed at the FETCH boundary: the plugin's hook is exercised for real —
    // schema decode, picker filter, url rewrite — with no token and no network.
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input?.url ?? String(input)
      seen.push(url)
      if (url.endsWith("/models")) {
        return new Response(JSON.stringify(COPILOT_MODELS_RESPONSE), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      return real(input, init)
    }) as typeof fetch

    try {
      const providers = yield* list
      const copilot = providers[ProviderV2.ID.make("github-copilot")]
      expect(copilot, "github-copilot must resolve").toBeDefined()
      // The hook ran: it asked GitHub's own base, carrying the stored bearer.
      expect(seen.some((u) => u === "https://api.githubcopilot.com/models")).toBe(true)

      // THE LIVE LIST IS UNIONED WITH THE SEED, NOT SUBSTITUTED FOR IT — the
      // thing this test was written believing the opposite of.
      //
      // The plugin hook runs FIRST and does replace `database[id].models`
      // wholesale (so claude-sonnet-5, served but `model_picker_enabled: false`,
      // is correctly dropped). But the config pass runs AFTER it and rebuilds
      // each declared model on top (provider/provider.ts, "extend database from
      // config"), so every SEED id comes back whether GitHub still serves it or
      // not — gpt-5.4 here is in the config and absent from GitHub's answer.
      //
      // CONSEQUENCE FOR THE EXTENSION, and why the seed is deliberately small:
      // a seed id is a PERMANENT picker row for that connection. A model the
      // account is not entitled to would sit there until the block is hand-
      // edited. See src/dashboard/copilotCatalog.ts.
      expect(Object.keys(copilot.models).sort()).toEqual(["gpt-4.1", "gpt-5.4"])
      // …and on an overlapping id the CONFIG's fields win: the live name is
      // "GPT-4.1 (live)" and the resolved model still reads "GPT-4.1".
      expect(copilot.models["gpt-4.1"].name).toBe("GPT-4.1")
      expect(copilot.models["gpt-4.1"].api.url).toBe("https://api.githubcopilot.com")
      expect(copilot.options["apiKey"]).toBe("")
    } finally {
      globalThis.fetch = real
    }
  }),
  { config: COPILOT_CONFIG },
)

/**
 * The SAME 200, with a body this plugin cannot use — the failure mode that
 * cost the owner every Claude and Gemini row his plan carries.
 *
 * `CopilotModels.get` prunes `existing` (the snapshot catalog) against the live
 * answer, so an answer that decodes but yields ZERO usable items deletes the
 * whole catalog and returns `{}`. That is not an error, so `copilot.ts`'s
 * `.catch` fallback never runs, and the resolved list is exactly the config
 * seed — indistinguishable, in the picker, from "your plan carries three GPT
 * models". `usable()` demands `max_prompt_tokens`, `max_output_tokens` AND
 * `supports.tool_calls`; one shape change at GitHub's end drops every row.
 *
 * An answer nothing survives is a FAILED read, not an entitlement of nothing,
 * so it must land on the same fallback a 500 does: the catalog the engine
 * already has, unioned with the seed.
 */
const COPILOT_UNUSABLE_RESPONSE = {
  data: [
    {
      id: "gpt-4.1",
      name: "GPT-4.1 (live)",
      version: "gpt-4.1-2025-04-14",
      model_picker_enabled: true,
      supported_endpoints: ["/chat/completions"],
      capabilities: {
        family: "gpt-4.1",
        // No `max_prompt_tokens` — `usable()` rejects it, silently.
        limits: { max_context_window_tokens: 128000, max_output_tokens: 16384 },
        supports: { tool_calls: true, streaming: true },
      },
    },
    {
      id: "claude-sonnet-5",
      name: "Claude Sonnet 5 (live)",
      version: "claude-sonnet-5-2026-06-30",
      model_picker_enabled: true,
      supported_endpoints: ["/chat/completions"],
      capabilities: {
        family: "claude",
        limits: { max_context_window_tokens: 1000000, max_output_tokens: 128000 },
        supports: { tool_calls: true },
      },
    },
  ],
}

copilotLive.instance(
  "a 200 whose entries are ALL unusable falls back to the known catalog — it never collapses to the seed",
  Effect.gen(function* () {
    const real = globalThis.fetch
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : (input?.url ?? String(input))
      if (url.endsWith("/models")) {
        return new Response(JSON.stringify(COPILOT_UNUSABLE_RESPONSE), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      return real(input, init)
    }) as typeof fetch

    try {
      const providers = yield* list
      const copilot = providers[ProviderV2.ID.make("github-copilot")]
      expect(copilot, "github-copilot must resolve").toBeDefined()
      const ids = Object.keys(copilot.models)
      // The seed still resolves...
      expect(ids).toContain("gpt-4.1")
      expect(ids).toContain("gpt-5.4")
      // ...and so does the rest of the catalog. This is the assertion that reds
      // on the collapse: the seed alone is two ids, and the snapshot carries the
      // Claude and Gemini rows the owner's plan actually serves.
      expect(ids).toContain("claude-sonnet-5")
      expect(ids).toContain("gemini-3.5-flash")
      expect(ids.length).toBeGreaterThan(10)
      // The fallback keeps the Copilot base url, exactly as the throwing path does.
      expect(copilot.models["claude-sonnet-5"].api.url).toBe("https://api.githubcopilot.com")
    } finally {
      globalThis.fetch = real
    }
  }),
  { config: COPILOT_CONFIG },
)

/**
 * A HAND-ADDED ChatGPT model — a name and nothing else — must not be a blind
 * model.
 *
 * How the owner's block gets that way: a new backend model (gpt-5.6-luna-fast)
 * is reachable over the subscription long before any catalog names it, so the
 * id is typed into origami.json by hand. `provider.ts`'s config pass then reads
 * `model.modalities?.input?.includes("image") ?? existingModel?... ?? false` —
 * and with no models.dev entry to inherit from there is no `existingModel`, so
 * the model resolves BLIND. `ProviderTransform.unsupportedParts` then replaces
 * the picture with "ERROR: Cannot read image" before it reaches a backend that
 * would have taken it (see provider/config-vision.test.ts for that chain).
 *
 * The ChatGPT backend's capabilities belong to the BACKEND, not to whoever
 * typed the id, so the plugin that serves the model is what fills them in —
 * `codex.ts`'s `config` hook, which runs before `cfg.provider` is read. The
 * owner's origami.json is never edited to make this work.
 *
 * A DECLARATION STILL WINS. gpt-5.4-mini below says text-only and stays
 * text-only: the operator knows what their endpoint takes, and a default that
 * overruled them would make the vision pin's "off" unrepresentable.
 */
const OPENAI_HAND_EDITED_CONFIG = {
  provider: {
    openai: {
      name: "ChatGpt",
      npm: "@ai-sdk/openai",
      options: {},
      models: {
        "gpt-5.6-luna-fast": { name: "gpt-5.6-luna-fast" },
        "gpt-5.4-mini": {
          name: "GPT-5.4 mini",
          modalities: { input: ["text" as const], output: ["text" as const] },
        },
        // NOT served over the ChatGPT backend (codex.ts's filter rejects 4.1),
        // so the plugin must leave it exactly as declared.
        "gpt-4.1": { name: "GPT-4.1" },
      },
    },
  },
}

signedIn.instance(
  "a ChatGPT model declared with nothing but a name takes the BACKEND's capabilities, not `false` for all of them",
  Effect.gen(function* () {
    const providers = yield* list
    const openai = providers[ProviderV2.ID.make("openai")]
    expect(openai, "openai must resolve").toBeDefined()

    const luna = openai.models["gpt-5.6-luna-fast"]
    expect(luna, "a hand-added id still resolves").toBeDefined()
    expect(luna.capabilities.input.image, "the ChatGPT backend takes images").toBe(true)
    expect(luna.capabilities.input.pdf, "and PDFs").toBe(true)
    expect(luna.capabilities.input.text).toBe(true)
    expect(luna.capabilities.attachment).toBe(true)
    expect(luna.capabilities.reasoning).toBe(true)
    // NOT stamped, deliberately: `toolcall` already defaults to true, and
    // `temperature` is the one field the ChatGPT backend and the OpenAI platform
    // API disagree on for these ids — the same config block serves both, and the
    // wire strips temperature anyway. See applyCodexCapabilityDefaults.
    expect(luna.capabilities.toolcall).toBe(true)
    expect(luna.capabilities.temperature).toBe(false)

    // A declaration is the operator's own statement about their endpoint.
    expect(openai.models["gpt-5.4-mini"].capabilities.input.image).toBe(false)

    // And a model this plugin does not serve over OAuth is left alone.
    expect(openai.models["gpt-4.1"].capabilities.input.image).toBe(false)
  }),
  { config: OPENAI_HAND_EDITED_CONFIG },
)
