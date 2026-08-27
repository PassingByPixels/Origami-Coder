import type { Config } from "@/config/config"
import { ConfigV1 } from "@origami/core/v1/config/config"
import { SessionV1 } from "@origami/core/v1/session"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import type { MessageV2 } from "./message-v2"
import type { CompactionThresholdOverride } from "./session"

const COMPACTION_BUFFER = 20_000

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
    input.cfg.compaction?.reserved ??
    Math.min(COMPACTION_BUFFER, ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax))
  return input.model.limit.input
    ? Math.max(0, input.model.limit.input - reserved)
    : Math.max(0, context - ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax))
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
