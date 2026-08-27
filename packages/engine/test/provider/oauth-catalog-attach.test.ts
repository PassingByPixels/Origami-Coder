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
