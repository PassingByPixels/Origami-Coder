import type { Hooks, PluginInput } from "@origami/plugin"
import { applyCapabilityDefaults } from "./capabilityDefaults"
import { fetchAnthropicCatalog } from "./anthropic-catalog"

/**
 * The Anthropic provider's two missing halves: what the key is served, and what
 * those models can do.
 *
 * A plugin rather than a `custom()` entry: `custom()` loaders are skipped for a
 * provider the model DATABASE has never heard of and are handed no auth context,
 * which is the case that matters in a fork shipping no models.dev snapshot. The
 * `custom()` row keeps its beta headers.
 *
 * NO AUTH HOOK — this is an API-key provider, so the plugin cannot be a second
 * door to the credential.
 */
export async function AnthropicCatalogPlugin(_input: PluginInput): Promise<Hooks> {
  return {
    /** Every Claude id in origami.json that declared no capabilities gets the
     *  family's — see capabilityDefaults.ts. No `serves` test: the `anthropic`
     *  block has only one backend behind it, so every id in it is one this is true of. */
    async config(cfg) {
      applyCapabilityDefaults(cfg, "anthropic")
    },
    provider: {
      id: "anthropic",
      async discoverModels(ctx) {
        // Only an API key. An `oauth` credential for anthropic is a Claude
        // subscription sign-in, whose model list is not this endpoint's to answer,
        // and a bearer sent to a header expecting `x-api-key` would just 401.
        const auth = ctx.auth
        if (auth?.type !== "api" || !auth.key) return {}
        return fetchAnthropicCatalog({ apiKey: auth.key })
      },
    },
  }
}
