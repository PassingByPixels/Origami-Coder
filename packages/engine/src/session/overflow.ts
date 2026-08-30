import type { Config } from "@/config/config"
import { ConfigV1 } from "@origami/core/v1/config/config"
import { SessionV1 } from "@origami/core/v1/session"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import type { MessageV2 } from "./message-v2"
import type { CompactionThresholdOverride } from "./session"

const COMPACTION_BUFFER = 20_000

/** An UNKNOWN output limit may claim at most this fraction (1/N) of the window. */
const UNKNOWN_OUTPUT_RESERVE_DIVISOR = 4

/**
 * How much of the window to hold back for the model's next reply.
 *
 * `ProviderTransform.maxOutputTokens` answers a different question — "how many
 * tokens may this REQUEST emit" — and for a model that declares no output limit
 * it answers with the flat 32k default (`Math.min(0, 32000) || 32000`). That is
 * the right answer for the request and the wrong one for a RESERVATION: on a
 * 36096-token window it holds back 89% of the context, so `isOverflow` fired at
 * 4096 tokens, on every turn, and again on the summary the compaction had just
 * written. Eleven compaction streams in four minutes on one local model.
 *
 * So: a DECLARED output limit is still honoured verbatim — the model really can
 * emit that much, and under-reserving would overflow mid-generation. A missing
 * one (0, or negative — `Schema.Finite` permits both, and the config schema
 * makes `output` a required sibling of `context`, so every probed local model
 * is written as `output: 0`) is treated as unknown and capped proportionally.
 *
 * The cap only bites below `OUTPUT_TOKEN_MAX * UNKNOWN_OUTPUT_RESERVE_DIVISOR`
 * (128k): at or above that window `floor(context / 4) >= 32000`, so the result
 * is identical to before for every large model, declared limit or not.
 */
function outputReserve(model: Provider.Model, outputTokenMax?: number) {
  if (model.limit.output > 0) return ProviderTransform.maxOutputTokens(model, outputTokenMax)
  const ceiling = outputTokenMax ?? ProviderTransform.OUTPUT_TOKEN_MAX
  return Math.max(0, Math.min(ceiling, Math.floor(model.limit.context / UNKNOWN_OUTPUT_RESERVE_DIVISOR)))
}

export function usable(input: {
  cfg: ConfigV1.Info
  model: Provider.Model
  outputTokenMax?: number
  /** A per-session auto-compaction threshold (t-kgsdsw), authoritative over
   *  the cfg-derived reserve when present — see session.ts's own comment on
   *  `CompactionThresholdOverride` for why it carries a `kind`. */
  thresholdOverride?: CompactionThresholdOverride
}) {
  const context = input.model.limit.context
  if (context === 0) return 0

  if (input.thresholdOverride) {
    const raw =
      input.thresholdOverride.kind === "percent"
        ? context * input.thresholdOverride.value
        : input.thresholdOverride.value
    return Math.min(context, Math.max(0, Math.floor(raw)))
  }

  const reserved =
    input.cfg.compaction?.reserved ?? Math.min(COMPACTION_BUFFER, outputReserve(input.model, input.outputTokenMax))
  return input.model.limit.input
    ? Math.max(0, input.model.limit.input - reserved)
    : Math.max(0, context - outputReserve(input.model, input.outputTokenMax))
}

export function isOverflow(input: {
  cfg: ConfigV1.Info
  tokens: SessionV1.Assistant["tokens"]
  model: Provider.Model
  outputTokenMax?: number
  thresholdOverride?: CompactionThresholdOverride
}) {
  if (input.cfg.compaction?.auto === false) return false
  if (input.model.limit.context === 0) return false

  const count =
    input.tokens.total || input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write
  return count >= usable(input)
}
