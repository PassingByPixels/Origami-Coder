/**
 * Fill in a provider's capabilities for config models that declared none.
 *
 * provider.ts resolves a capability as `declaration ?? the models.dev entry ??
 * false`, and an id typed into origami.json by hand — or written there by
 * picking a DISCOVERED row — has neither, so every capability lands on `false`
 * and an image is refused with "Cannot read image" before it reaches a backend
 * that would have taken it. A DECLARATION ALWAYS WINS: only `undefined` fields
 * are filled, or the vision pin "off" (absent modalities plus a pin) would be
 * unrepresentable. Three fields only — `tool_call` already defaults to `true`.
 */

/** A config model block, as `origami.json` holds it. Structural - this reads
 *  and fills a few optional fields and must not care about the rest. */
export type ConfigModel = Record<string, unknown>

export interface CapabilityDefaults {
  modalities: { input: string[]; output: string[] }
  attachment: boolean
  reasoning: boolean
}

const TEXT_IMAGE_PDF = { input: ["text", "image", "pdf"], output: ["text"] }
// Text is listed with the others on purpose: provider.ts reads text support from
// this same array, so `["image","pdf"]` would resolve a model that cannot take a prompt.
const TEXT_IMAGE = { input: ["text", "image"], output: ["text"] }

/**
 * What this fork assumes about a provider's models when nothing else says.
 *
 * Each entry is the INTERSECTION of what is true for every id the provider
 * currently serves, not the union — a capability stamped `true` for a model that
 * lacks it produces a control the endpoint then refuses.
 *
 *  - xai: images yes, PDFs NO (the API takes image_url parts only).
 *  - github-copilot: real capabilities from GitHub win; this is only the floor
 *    for a hand-typed id, and PDFs are not offered across Copilot's model set.
 */
export const CAPABILITY_DEFAULTS: Record<string, CapabilityDefaults> = {
  openai: { modalities: TEXT_IMAGE_PDF, attachment: true, reasoning: true },
  anthropic: { modalities: TEXT_IMAGE_PDF, attachment: true, reasoning: true },
  xai: { modalities: TEXT_IMAGE, attachment: true, reasoning: true },
  "github-copilot": { modalities: TEXT_IMAGE, attachment: true, reasoning: true },
}

/**
 * Stamp one provider's config models.
 *
 * `serves` is the caller's own "is this id mine" test — codex.ts has one because
 * the same `openai` block also backs an OpenAI PLATFORM key. A provider with no
 * such split passes nothing. LOAD-TIME and in memory: origami.json is never rewritten.
 */
export function applyCapabilityDefaults(
  cfg: unknown,
  providerID: string,
  serves?: (apiID: string, model: ConfigModel) => boolean,
): void {
  const defaults = CAPABILITY_DEFAULTS[providerID]
  if (!defaults) return
  const provider = (cfg as { provider?: Record<string, { models?: Record<string, ConfigModel> }> })?.provider
  const models = provider?.[providerID]?.models
  if (!models) return
  for (const [modelID, model] of Object.entries(models)) {
    if (!model || typeof model !== "object") continue
    const apiID = typeof model["id"] === "string" ? model["id"] : modelID
    if (serves && !serves(apiID, model)) continue
    if (model["modalities"] === undefined) model["modalities"] = { ...defaults.modalities }
    if (model["attachment"] === undefined) model["attachment"] = defaults.attachment
    if (model["reasoning"] === undefined) model["reasoning"] = defaults.reasoning
  }
}
