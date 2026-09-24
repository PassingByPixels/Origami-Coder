import type { Config } from "@/config/config"
import { ConfigV1 } from "@origami/core/v1/config/config"
import { SessionV1 } from "@origami/core/v1/session"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import type { MessageV2 } from "./message-v2"
import type { CompactionThresholdOverride } from "./session"
import { SessionPromptCapture } from "./prompt-capture"

const COMPACTION_BUFFER = 20_000

/**
 * The least removable history that makes a compaction worth running. Compaction
 * only deletes conversation, and the fixed block (system prompt plus tool schemas)
 * can dominate the window, so on a small conversation a summary costs a whole
 * generation and can even grow the context. Hence a two-part trigger: the window
 * must be full (`usable()`) and enough history must sit under the floor.
 */
export const MIN_COMPACTABLE_HISTORY = 8_000

const MIN_PRESERVE_RECENT_TOKENS = 2_000
const MAX_PRESERVE_RECENT_TOKENS = 8_000

/**
 * How many tokens of the newest turns compaction keeps verbatim. Lives here
 * because the trigger needs it too: a compaction preserving a tail of B tokens
 * cannot remove less than that again, so history under 2xB is not worth it.
 */
export function preserveRecentBudget(input: {
  cfg: ConfigV1.Info
  model: Provider.Model
  outputTokenMax?: number
  thresholdOverride?: CompactionThresholdOverride
}) {
  return (
    input.cfg.compaction?.preserve_recent_tokens ??
    Math.min(MAX_PRESERVE_RECENT_TOKENS, Math.max(MIN_PRESERVE_RECENT_TOKENS, Math.floor(usable(input) * 0.25)))
  )
}

/**
 * The session's fixed block in tokens — what compaction can never remove. Read
 * from the engine's own prompt capture, not re-derived: a re-derivation reports
 * what the engine intended to send, which a plugin transform can make false. Zero
 * before the first turn, degrading the gate to "is there 8k of anything to remove".
 */
export function fixedFloor(sessionID: string | undefined): number {
  if (!sessionID) return 0
  const capture = SessionPromptCapture.get(sessionID)
  if (!capture) return 0
  const system = capture.finalSystem.reduce((sum, item) => sum + item.tokensApprox, 0)
  const toolChars = capture.tools.reduce((sum, item) => sum + item.descriptionChars + item.schemaBytes, 0)
  return system + SessionPromptCapture.estimateTokens(toolChars)
}

/** An UNKNOWN output limit may claim at most this fraction (1/N) of the window. */
const UNKNOWN_OUTPUT_RESERVE_DIVISOR = 4

/**
 * How much of the window to hold back for the model's next reply.
 *
 * `ProviderTransform.maxOutputTokens` answers a different question — how many
 * tokens this request may emit — and falls back to a flat 32k when a model
 * declares no output limit, which as a reservation can hold back most of a small
 * window and make `isOverflow` fire every turn. So a declared limit is honoured
 * verbatim (under-reserving would overflow mid-generation) and a missing one
 * (0 or negative; every probed local model is written `output: 0`) is capped
 * proportionally. The cap only bites below 128k, since above it
 * `floor(context / 4) >= 32000` anyway.
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
  /** A per-session auto-compaction threshold, authoritative over the cfg-derived
   *  reserve when present. */
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

export type OverflowCheck = {
  /** Whether auto-compaction should fire. */
  readonly overflow: boolean
  /** True when the window is full but the history gate held compaction back. */
  readonly gated: boolean
  readonly count: number
  readonly floor: number
  readonly history: number
  readonly usable: number
  /** The history the gate demanded — `max(MIN_COMPACTABLE_HISTORY, 2 x tail)`. */
  readonly required: number
}

export type OverflowInput = {
  cfg: ConfigV1.Info
  tokens: SessionV1.Assistant["tokens"]
  model: Provider.Model
  outputTokenMax?: number
  thresholdOverride?: CompactionThresholdOverride
  /**
   * The session's fixed block, from `fixedFloor`. Zero when a caller has none: the
   * gate then measures the whole count as history, which can only let a compaction
   * through, never hold one back on a floor it did not measure.
   */
  floor?: number
}

/**
 * The full trigger decision, numbers included, so a caller can log why a full
 * window did not compact. `isOverflow` narrows this to its boolean.
 */
export function overflowCheck(input: OverflowInput): OverflowCheck {
  const count =
    input.tokens.total || input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write
  const limit = usable(input)
  const floor = Math.min(Math.max(0, input.floor ?? 0), count)
  const history = count - floor
  const required = Math.max(MIN_COMPACTABLE_HISTORY, 2 * preserveRecentBudget(input))
  const empty = { overflow: false, gated: false, count, floor, history, usable: limit, required }

  if (input.cfg.compaction?.auto === false) return empty
  if (input.model.limit.context === 0) return empty
  if (count < limit) return empty
  if (history < required) return { ...empty, gated: true }
  return { ...empty, overflow: true }
}

export function isOverflow(input: OverflowInput) {
  return overflowCheck(input).overflow
}
