import { Schema } from "effect"
import type { LLMRequest, ReasoningEffort, TextVerbosity as TextVerbosityValue } from "../../schema"
import { ReasoningEfforts, TextVerbosity } from "../../schema"

export const OpenAIReasoningEfforts = ReasoningEfforts.filter(
  (effort): effort is Exclude<ReasoningEffort, "max"> => effort !== "max",
)
export type OpenAIReasoningEffort = (typeof OpenAIReasoningEfforts)[number]

// Mirrors OpenAI's `ResponseIncludable` union from the official SDK. Keep this
// in lockstep with `openai-node/src/resources/responses/responses.ts`.
export const OpenAIResponseIncludables = [
  "file_search_call.results",
  "web_search_call.results",
  "web_search_call.action.sources",
  "message.input_image.image_url",
  "computer_call_output.output.image_url",
  "code_interpreter_call.outputs",
  "reasoning.encrypted_content",
  "message.output_text.logprobs",
] as const
export type OpenAIResponseIncludable = (typeof OpenAIResponseIncludables)[number]
export const OpenAIServiceTiers = ["auto", "default", "flex", "priority"] as const
export type OpenAIServiceTier = (typeof OpenAIServiceTiers)[number]
// `prompt_cache_retention` on the Responses API. `in_memory` is what the
// endpoint applies when the field is absent, so the engine only ever sends the
// other one; both are accepted because a model variant may set either.
export const OpenAIPromptCacheRetentions = ["in_memory", "24h"] as const
export type OpenAIPromptCacheRetention = (typeof OpenAIPromptCacheRetentions)[number]
// `reasoning.summary` on the Responses API. `auto` alone silently dropped every
// other value: the engine defaults to `auto`, but a model VARIANT may ask for
// `detailed`, and the AI SDK path sends whatever string it is given
// (`openaiResponsesProviderOptionsSchema` types it `z.string().nullish()`).
export const OpenAIReasoningSummaries = ["auto", "concise", "detailed"] as const
export type OpenAIReasoningSummary = (typeof OpenAIReasoningSummaries)[number]
// `reasoning.mode` / `reasoning.context` on the Responses API, mirrored from
// `@ai-sdk/openai`. The engine emits `reasoningMode` for a config model variant
// whose body carries `reasoning.mode` (provider.ts modeOptions).
export const OpenAIReasoningModes = ["standard", "pro"] as const
export type OpenAIReasoningMode = (typeof OpenAIReasoningModes)[number]
export const OpenAIReasoningContexts = ["auto", "current_turn", "all_turns"] as const
export type OpenAIReasoningContext = (typeof OpenAIReasoningContexts)[number]

const REASONING_EFFORTS = new Set<string>(ReasoningEfforts)
const OPENAI_REASONING_EFFORTS = new Set<string>(OpenAIReasoningEfforts)
const TEXT_VERBOSITY = new Set<string>(["low", "medium", "high"])
const INCLUDABLES = new Set<string>(OpenAIResponseIncludables)
const SERVICE_TIERS = new Set<string>(OpenAIServiceTiers)
const PROMPT_CACHE_RETENTIONS = new Set<string>(OpenAIPromptCacheRetentions)
const REASONING_SUMMARIES = new Set<string>(OpenAIReasoningSummaries)
const REASONING_MODES = new Set<string>(OpenAIReasoningModes)
const REASONING_CONTEXTS = new Set<string>(OpenAIReasoningContexts)

export const OpenAIReasoningEffort = Schema.Literals(OpenAIReasoningEfforts)
export const OpenAITextVerbosity = TextVerbosity
export const OpenAIResponseIncludable = Schema.Literals(OpenAIResponseIncludables)
export const OpenAIServiceTier = Schema.Literals(OpenAIServiceTiers)
export const OpenAIPromptCacheRetention = Schema.Literals(OpenAIPromptCacheRetentions)
export const OpenAIReasoningSummary = Schema.Literals(OpenAIReasoningSummaries)
export const OpenAIReasoningMode = Schema.Literals(OpenAIReasoningModes)
export const OpenAIReasoningContext = Schema.Literals(OpenAIReasoningContexts)

const isAnyReasoningEffort = (effort: unknown): effort is ReasoningEffort =>
  typeof effort === "string" && REASONING_EFFORTS.has(effort)

export const isReasoningEffort = (effort: unknown): effort is OpenAIReasoningEffort =>
  typeof effort === "string" && OPENAI_REASONING_EFFORTS.has(effort)

const isTextVerbosity = (value: unknown): value is TextVerbosityValue =>
  typeof value === "string" && TEXT_VERBOSITY.has(value)

const options = (request: LLMRequest) => request.providerOptions?.openai

export const store = (request: LLMRequest): boolean | undefined => {
  const value = options(request)?.store
  return typeof value === "boolean" ? value : undefined
}

export const reasoningEffort = (request: LLMRequest): ReasoningEffort | undefined => {
  const value = options(request)?.reasoningEffort
  return isAnyReasoningEffort(value) ? value : undefined
}

export const reasoningSummary = (request: LLMRequest): OpenAIReasoningSummary | undefined => {
  const value = options(request)?.reasoningSummary
  return typeof value === "string" && REASONING_SUMMARIES.has(value) ? (value as OpenAIReasoningSummary) : undefined
}

export const reasoningMode = (request: LLMRequest): OpenAIReasoningMode | undefined => {
  const value = options(request)?.reasoningMode
  return typeof value === "string" && REASONING_MODES.has(value) ? (value as OpenAIReasoningMode) : undefined
}

export const reasoningContext = (request: LLMRequest): OpenAIReasoningContext | undefined => {
  const value = options(request)?.reasoningContext
  return typeof value === "string" && REASONING_CONTEXTS.has(value) ? (value as OpenAIReasoningContext) : undefined
}

// Resolve the OpenAI Responses `include` field. Unknown includables are filtered
// out so a typo drops the entry instead of poisoning the wire body; an empty
// array returns undefined so the request body omits the field entirely.
export const include = (request: LLMRequest): ReadonlyArray<OpenAIResponseIncludable> | undefined => {
  const value = options(request)?.include
  if (!Array.isArray(value)) return undefined
  const filtered = value.filter((entry): entry is OpenAIResponseIncludable => INCLUDABLES.has(entry))
  return filtered.length > 0 ? filtered : undefined
}

export const promptCacheKey = (request: LLMRequest) => {
  const value = options(request)?.promptCacheKey
  return typeof value === "string" ? value : undefined
}

export const promptCacheRetention = (request: LLMRequest) => {
  const value = options(request)?.promptCacheRetention
  return typeof value === "string" && PROMPT_CACHE_RETENTIONS.has(value)
    ? (value as OpenAIPromptCacheRetention)
    : undefined
}

export const textVerbosity = (request: LLMRequest) => {
  const value = options(request)?.textVerbosity
  return isTextVerbosity(value) ? value : undefined
}

const positiveInteger = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined

/** Ceiling on the base64 bytes of ONE picture this endpoint is sent
 *  (`providerOptions.openai.maxImageBytes`). Overrides `MAX_IMAGE_BASE64_BYTES`
 *  in `openai-responses.ts`; see the constant there for why a ceiling exists. */
export const maxImageBytes = (request: LLMRequest) => positiveInteger(options(request)?.maxImageBytes)

/** Ceiling on the base64 bytes of ALL pictures in one request
 *  (`providerOptions.openai.maxRequestImageBytes`). Overrides
 *  `MAX_REQUEST_IMAGE_BASE64_BYTES` in `openai-responses.ts`. */
export const maxRequestImageBytes = (request: LLMRequest) => positiveInteger(options(request)?.maxRequestImageBytes)

export const serviceTier = (request: LLMRequest) => {
  const value = options(request)?.serviceTier
  return typeof value === "string" && SERVICE_TIERS.has(value) ? (value as OpenAIServiceTier) : undefined
}

export const instructions = (request: LLMRequest) => {
  const value = options(request)?.instructions
  return typeof value === "string" ? value : undefined
}

export * as OpenAIOptions from "./openai-options"
