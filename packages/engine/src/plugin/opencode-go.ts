import type { Hooks, PluginInput } from "@origami/plugin"

/**
 * OpenCode GO turns cost nothing per token, so the catalogue must not price
 * them.
 *
 * WHAT IS WRONG WITHOUT THIS. GO is a FLAT-RATE subscription, but the shipped
 * models.dev catalogue is the gateway's public per-token price list and knows
 * nothing about that: `opencode-go/deepseek-v4-flash` is listed at 0.14 in /
 * 0.28 out, and three GO models carry a `tiers` block on top. A GO session
 * therefore accrued a spend figure nobody is billed — in the composer's cost
 * badge, in every per-turn total, and in the blended session spend. What a GO
 * user wants beside the model name is CONSUMPTION of the plan
 * (`acp/provider-usage.ts` reads /zen/go/v1/usage), not an invented price.
 *
 * SAME CORRECTION AS `plugin/xai.ts` AND `plugin/openai/codex.ts`, MINUS THE
 * CREDENTIAL GUARD. Those two providers are metered when the credential is an
 * API key and free only on an OAuth sign-in, so they check `ctx.auth?.type`.
 * GO has no metered mode at all — its API key IS the subscription — so the
 * correction is unconditional and `ctx` is not read.
 *
 * `cost` is REPLACED, NOT MERGED. `session/session.ts` prefers `cost.tiers` and
 * `cost.experimentalOver200K` over the base rates when the context is large
 * enough, so zeroing input/output/cache while leaving a tier in place would
 * keep charging exactly the long-context turns that cost the most. Building a
 * fresh cost object drops both.
 *
 * OPENCODE ZEN IS NOT TOUCHED. Zen is a different provider id (`opencode`), is
 * metered per token, and has no usage endpoint — its catalogue prices are
 * correct and must stay. The dispatch in `provider/provider.ts` applies this
 * hook only to `database[provider.id]`, so the id below is the whole guard.
 */
export async function OpencodeGoCostPlugin(_input: PluginInput): Promise<Hooks> {
  return {
    provider: {
      id: "opencode-go",
      async models(provider) {
        return Object.fromEntries(
          Object.entries(provider.models).map(([modelID, model]) => [
            modelID,
            {
              ...model,
              cost: {
                input: 0,
                output: 0,
                cache: { read: 0, write: 0 },
              },
            },
          ]),
        )
      },
    },
  }
}
