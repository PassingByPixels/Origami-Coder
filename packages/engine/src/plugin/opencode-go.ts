import type { Hooks, PluginInput } from "@origami/plugin"

/**
 * OpenCode GO turns cost nothing per token, so the catalogue must not price them.
 *
 * GO is a FLAT-RATE subscription, but the shipped models.dev catalogue is the
 * gateway's public per-token price list and knows nothing about that, so a GO
 * session accrued a spend figure nobody is billed.
 *
 * Unlike `plugin/xai.ts` and `plugin/openai/codex.ts` there is no credential
 * guard: GO has no metered mode — its API key IS the subscription.
 *
 * `cost` is REPLACED, NOT MERGED. `session/session.ts` prefers `cost.tiers` and
 * `cost.experimentalOver200K` over the base rates on a large context, so zeroing
 * the base while leaving a tier would keep charging the most expensive turns.
 * OpenCode Zen (`opencode`) is a different, metered provider and is not touched.
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
