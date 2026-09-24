import { SessionPromptCapture } from "@/session/prompt-capture"

/**
 * What the model's prompt is made of, for the client's context gauge.
 *
 * The numbers are an ATTRIBUTION of one measured total, not four measurements.
 * The provider reports a single prompt-token count (`used` = input + cache read);
 * it never says how that total divides. So the split is built from the engine's
 * own prompt capture — the record of what was actually sent, after the plugin
 * transform — and the parts are scaled to land on `used` exactly. A reader that
 * adds the parts up gets the same number the gauge shows.
 *
 * `estimated` is always true and `method` names the estimator, so a client can
 * never present these as provider-reported figures.
 */
export type ContextComposition = {
  /** The final system text, after the plugin transform. */
  readonly systemPrompt: number
  /** Every offered tool's description plus its JSON schema. */
  readonly tools: number
  /**
   * Everything else in the prompt: the conversation, and with it the text of any
   * attached file, because an attachment is expanded into the message that reads
   * it and the capture cannot tell the two apart. Reported as one part rather
   * than split into a guessed `attachedFiles`.
   */
  readonly conversation: number
  readonly estimated: true
  readonly method: string
}

export const METHOD =
  "chars/4 of the captured system prompt and tool block, scaled to the model's reported prompt tokens; conversation is the remainder"

/** The shape `contextComposition` reads. A capture, or anything shaped like one. */
export type CaptureLike = Pick<SessionPromptCapture.Capture, "finalSystem" | "tools">

/** The fixed block's two halves, straight off the capture. */
export function fixedParts(capture: CaptureLike): { readonly systemPrompt: number; readonly tools: number } {
  const systemPrompt = capture.finalSystem.reduce((sum, item) => sum + item.tokensApprox, 0)
  const toolChars = capture.tools.reduce((sum, item) => sum + item.descriptionChars + item.schemaBytes, 0)
  return { systemPrompt, tools: SessionPromptCapture.estimateTokens(toolChars) }
}

/**
 * Attribute `used` across the parts of the last prepared request.
 *
 * Undefined — never a guess — when there is no capture (the session has sent no
 * turn) or when `used` is not a positive number.
 *
 * The fixed block is an estimate and `used` is a measurement, so the two can
 * disagree. When the estimate fits, the conversation takes the remainder. When it
 * does not — a small first turn, a provider counting images, a cache read that
 * lands short — the two fixed parts are scaled down proportionally to fill `used`
 * and the conversation is zero. Either way the three parts sum to `used`, because
 * a breakdown that does not add up to the gauge is worse than no breakdown.
 */
export function contextComposition(input: {
  readonly capture: CaptureLike | null | undefined
  readonly used: number
}): ContextComposition | undefined {
  if (!input.capture) return undefined
  if (!Number.isFinite(input.used) || input.used <= 0) return undefined
  const used = Math.floor(input.used)
  const fixed = fixedParts(input.capture)
  const total = fixed.systemPrompt + fixed.tools
  if (total <= used) {
    return {
      systemPrompt: fixed.systemPrompt,
      tools: fixed.tools,
      conversation: used - total,
      estimated: true,
      method: METHOD,
    }
  }
  // Over budget: keep the ratio, give the rounding remainder to the system
  // prompt, so the pair still sums to `used` with no negative part.
  const tools = total === 0 ? 0 : Math.floor((fixed.tools / total) * used)
  return {
    systemPrompt: used - tools,
    tools,
    conversation: 0,
    estimated: true,
    method: METHOD,
  }
}

export * as ACPComposition from "./composition"
