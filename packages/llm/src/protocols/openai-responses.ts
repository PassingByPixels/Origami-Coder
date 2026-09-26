import { Effect, Schema } from "effect"
import { Route } from "../route/client"
import { Auth } from "../route/auth"
import { Endpoint } from "../route/endpoint"
import { HttpTransport, WebSocketTransport } from "../route/transport"
import { Protocol } from "../route/protocol"
import {
  LLMEvent,
  Usage,
  type FinishReason,
  type JsonSchema,
  type LLMRequest,
  type ProviderMetadata,
  type ReasoningPart,
  type TextPart,
  type ToolCallPart,
  type ToolDefinition,
  type ToolContent,
  type ToolResultPart,
} from "../schema"
import { JsonObject, optionalArray, optionalNull, ProviderShared } from "./shared"
import { isContextOverflow } from "../provider-error"
import { OpenAIOptions } from "./utils/openai-options"
import { Lifecycle } from "./utils/lifecycle"
import { ToolSchemaProjection } from "./utils/tool-schema"
import { ToolStream } from "./utils/tool-stream"

const ADAPTER = "openai-responses"
export const DEFAULT_BASE_URL = "https://api.openai.com/v1"
export const PATH = "/responses"

// Request Body Schema
const OpenAIResponsesInputText = Schema.Struct({
  type: Schema.tag("input_text"),
  text: Schema.String,
})
const OpenAIResponsesInputImage = Schema.Struct({
  type: Schema.tag("input_image"),
  image_url: Schema.String,
})
const OpenAIResponsesInputContent = Schema.Union([OpenAIResponsesInputText, OpenAIResponsesInputImage])
type OpenAIResponsesInputContent = Schema.Schema.Type<typeof OpenAIResponsesInputContent>

const OpenAIResponsesOutputText = Schema.Struct({
  type: Schema.tag("output_text"),
  text: Schema.String,
})

const OpenAIResponsesReasoningSummaryText = Schema.Struct({
  type: Schema.tag("summary_text"),
  text: Schema.String,
})

// `status` is only ever sent on the xAI route: `@ai-sdk/xai` stamps
// `status: "completed"` on replayed reasoning and function_call items; `@ai-sdk/openai` sends
// neither field.
const OpenAIResponsesReasoningItem = Schema.Struct({
  type: Schema.tag("reasoning"),
  id: Schema.optionalKey(Schema.String),
  summary: Schema.Array(OpenAIResponsesReasoningSummaryText),
  status: Schema.optionalKey(Schema.String),
  encrypted_content: optionalNull(Schema.String),
})

const OpenAIResponsesItemReference = Schema.Struct({
  type: Schema.tag("item_reference"),
  id: Schema.String,
})

// `function_call_output.output` accepts a plain string or an ordered array of
// content items, so tools can return images as well as text.
// https://platform.openai.com/docs/api-reference/responses/object
const OpenAIResponsesFunctionCallOutputContent = Schema.Union([OpenAIResponsesInputText, OpenAIResponsesInputImage])

const OpenAIResponsesFunctionCallOutput = Schema.Union([
  Schema.String,
  Schema.Array(OpenAIResponsesFunctionCallOutputContent),
])

const OpenAIResponsesInputItem = Schema.Union([
  Schema.Struct({ role: Schema.tag("system"), content: Schema.String }),
  Schema.Struct({ role: Schema.tag("developer"), content: Schema.String }),
  Schema.Struct({ role: Schema.tag("user"), content: Schema.Array(OpenAIResponsesInputContent) }),
  Schema.Struct({ role: Schema.tag("assistant"), content: Schema.Array(OpenAIResponsesOutputText) }),
  OpenAIResponsesReasoningItem,
  OpenAIResponsesItemReference,
  Schema.Struct({
    type: Schema.tag("function_call"),
    id: Schema.optionalKey(Schema.String),
    call_id: Schema.String,
    name: Schema.String,
    arguments: Schema.String,
    status: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    type: Schema.tag("function_call_output"),
    call_id: Schema.String,
    output: OpenAIResponsesFunctionCallOutput,
  }),
])
type OpenAIResponsesInputItem = Schema.Schema.Type<typeof OpenAIResponsesInputItem>

// Mutable counterpart of the schema reasoning item so `lowerMessages` can fold
// multiple streamed summary parts into the same item before flushing.
type OpenAIResponsesReasoningInput = {
  type: "reasoning"
  id?: string
  summary: Array<{ type: "summary_text"; text: string }>
  status?: string
  encrypted_content?: string | null
}
type OpenAIResponsesReasoningReplay = Omit<OpenAIResponsesReasoningInput, "id">

const OpenAIResponsesTool = Schema.Struct({
  type: Schema.tag("function"),
  name: Schema.String,
  description: Schema.String,
  parameters: JsonObject,
  strict: Schema.optional(Schema.Boolean),
})
type OpenAIResponsesTool = Schema.Schema.Type<typeof OpenAIResponsesTool>

const OpenAIResponsesToolChoice = Schema.Union([
  Schema.Literals(["auto", "none", "required"]),
  Schema.Struct({ type: Schema.tag("function"), name: Schema.String }),
])

// Shared between the HTTP body and the WebSocket `response.create` message.
// The HTTP body adds `stream: true`; the WebSocket message adds `type: "response.create"`.
const OpenAIResponsesCoreFields = {
  model: Schema.String,
  input: Schema.Array(OpenAIResponsesInputItem),
  instructions: Schema.optional(Schema.String),
  tools: optionalArray(OpenAIResponsesTool),
  tool_choice: Schema.optional(OpenAIResponsesToolChoice),
  store: Schema.optional(Schema.Boolean),
  service_tier: Schema.optional(OpenAIOptions.OpenAIServiceTier),
  prompt_cache_key: Schema.optional(Schema.String),
  prompt_cache_retention: Schema.optional(OpenAIOptions.OpenAIPromptCacheRetention),
  include: optionalArray(OpenAIOptions.OpenAIResponseIncludable),
  reasoning: Schema.optional(
    Schema.Struct({
      effort: Schema.optional(OpenAIOptions.OpenAIReasoningEffort),
      summary: Schema.optional(OpenAIOptions.OpenAIReasoningSummary),
      mode: Schema.optional(OpenAIOptions.OpenAIReasoningMode),
      context: Schema.optional(OpenAIOptions.OpenAIReasoningContext),
    }),
  ),
  text: Schema.optional(
    Schema.Struct({
      verbosity: Schema.optional(OpenAIOptions.OpenAITextVerbosity),
    }),
  ),
  max_output_tokens: Schema.optional(Schema.Number),
  temperature: Schema.optional(Schema.Number),
  top_p: Schema.optional(Schema.Number),
}

const OpenAIResponsesBody = Schema.Struct({
  ...OpenAIResponsesCoreFields,
  stream: Schema.Literal(true),
})
export type OpenAIResponsesBody = Schema.Schema.Type<typeof OpenAIResponsesBody>

const OpenAIResponsesWebSocketMessage = Schema.StructWithRest(
  Schema.Struct({
    type: Schema.tag("response.create"),
    ...OpenAIResponsesCoreFields,
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
)
type OpenAIResponsesWebSocketMessage = Schema.Schema.Type<typeof OpenAIResponsesWebSocketMessage>
const encodeWebSocketMessage = Schema.encodeSync(Schema.fromJsonString(OpenAIResponsesWebSocketMessage))

const OpenAIResponsesUsage = Schema.Struct({
  input_tokens: Schema.optional(Schema.Number),
  input_tokens_details: optionalNull(Schema.Struct({ cached_tokens: Schema.optional(Schema.Number) })),
  output_tokens: Schema.optional(Schema.Number),
  output_tokens_details: optionalNull(Schema.Struct({ reasoning_tokens: Schema.optional(Schema.Number) })),
  total_tokens: Schema.optional(Schema.Number),
})
type OpenAIResponsesUsage = Schema.Schema.Type<typeof OpenAIResponsesUsage>

const OpenAIResponsesStreamItem = Schema.Struct({
  type: Schema.String,
  id: Schema.optional(Schema.String),
  call_id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  arguments: Schema.optional(Schema.String),
  // Hosted (provider-executed) tool fields. Each hosted item carries its own
  // subset; capturing them generically avoids a per-tool schema.
  status: Schema.optional(Schema.String),
  action: Schema.optional(Schema.Unknown),
  queries: Schema.optional(Schema.Unknown),
  results: Schema.optional(Schema.Unknown),
  code: Schema.optional(Schema.String),
  container_id: Schema.optional(Schema.String),
  outputs: Schema.optional(Schema.Unknown),
  server_label: Schema.optional(Schema.String),
  output: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Unknown),
  encrypted_content: optionalNull(Schema.String),
})
type OpenAIResponsesStreamItem = Schema.Schema.Type<typeof OpenAIResponsesStreamItem>

// Responses surfaces provider failures in two shapes: the streaming `error`
// event carries `{ type: "error", code, message, param, sequence_number }` at
// the top level, `response.failed` carries the same under `response.error`.
const OpenAIResponsesErrorPayload = Schema.Struct({
  code: optionalNull(Schema.String),
  message: optionalNull(Schema.String),
  param: optionalNull(Schema.String),
})

// `StructWithRest`, not a plain `Struct`: an undeclared key is KEPT at decode.
// `providerError` prints the whole event when the backend named no reason, and
// a struct that dropped unknown keys would print `{"type":"error"}`.
const OpenAIResponsesEvent = Schema.StructWithRest(
  Schema.Struct({
    type: Schema.String,
    delta: Schema.optional(Schema.String),
    item_id: Schema.optional(Schema.String),
    // Position of the item this event belongs to. Unused here, but a dialect
    // whose `item_id` is not stable across events (GitHub Copilot re-encrypts it
    // per frame) needs it to key one item, so it is decoded rather than dropped.
    output_index: Schema.optional(Schema.Number),
    summary_index: Schema.optional(Schema.Number),
    item: Schema.optional(OpenAIResponsesStreamItem),
    response: Schema.optional(
      Schema.StructWithRest(
        Schema.Struct({
          id: Schema.optional(Schema.String),
          service_tier: optionalNull(Schema.String),
          incomplete_details: optionalNull(Schema.Struct({ reason: Schema.String })),
          usage: optionalNull(OpenAIResponsesUsage),
          // GitHub Copilot's billed amount, beside `usage` and outside it. See
          // `ProviderShared.CopilotUsage`; no other Responses endpoint sends it.
          copilot_usage: optionalNull(ProviderShared.CopilotUsage),
          error: optionalNull(OpenAIResponsesErrorPayload),
        }),
        [Schema.Record(Schema.String, Schema.Unknown)],
      ),
    ),
    // The spec puts an error event's code/message/param at the TOP level; the
    // ChatGPT (codex) backend and several proxies nest the same three inside an
    // `error` envelope instead. Read both, in this order.
    error: optionalNull(OpenAIResponsesErrorPayload),
    code: Schema.optional(Schema.String),
    message: Schema.optional(Schema.String),
    param: Schema.optional(Schema.String),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
)
type OpenAIResponsesEvent = Schema.Schema.Type<typeof OpenAIResponsesEvent>

interface ParserState {
  readonly tools: ToolStream.State<string>
  readonly hasFunctionCall: boolean
  readonly lifecycle: Lifecycle.State
  readonly reasoningItems: Readonly<Record<string, ReasoningStreamItem>>
  readonly store: boolean | undefined
  /** Namespace every emitted `providerMetadata` block is keyed under. */
  readonly metadataKey: string
}

type ReasoningSummaryStatus = "active" | "can-conclude" | "concluded"

interface ReasoningStreamItem {
  readonly encryptedContent: string | null | undefined
  // Keyed by OpenAI's numeric `summary_index`; JS coerces the key to a string.
  readonly summaryParts: Readonly<Record<number, ReasoningSummaryStatus>>
}

const invalid = ProviderShared.invalidRequest

// OpenAI's reasoning families, mirrored from `@ai-sdk/openai`. Two wire
// behaviours hang off it: the system prompt goes in as `developer`, and
// `temperature`/`top_p` are dropped. Keyed on the model id alone, so an xAI
// model routed through this protocol (grok-*) never matches and keeps `system`.
const isReasoningModel = (id: string) =>
  id.startsWith("o1") || id.startsWith("o3") || id.startsWith("o4-mini") || (id.startsWith("gpt-5") && !id.startsWith("gpt-5-chat"))

// The gpt-5.1+ point releases accept the sampling knobs again, but only with
// reasoning switched off (`supportsNonReasoningParameters` in the same file).
const NON_REASONING_PARAMETER_MODELS = ["gpt-5.1", "gpt-5.2", "gpt-5.3", "gpt-5.4", "gpt-5.5", "gpt-5.6"]
const supportsNonReasoningParameters = (id: string) =>
  NON_REASONING_PARAMETER_MODELS.some((prefix) => id.startsWith(prefix))

// Request Lowering
// xAI speaks this same wire, but `@ai-sdk/xai` lowers a few items differently.
// Keyed on the ROUTE's provider id, so the openai and azure bodies are untouched.
const isXAI = (request: LLMRequest) => request.model.provider === "xai"

// `@ai-sdk/xai` strips every `additionalProperties: false` from a tool schema
// before sending it.
const withoutClosedObjects = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutClosedObjects)
  if (!ProviderShared.isRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry) => !(entry[0] === "additionalProperties" && entry[1] === false))
      .map((entry) => [entry[0], withoutClosedObjects(entry[1])]),
  )
}

const lowerToolParameters = (inputSchema: JsonSchema, xai: boolean): JsonSchema => {
  const parameters = ToolSchemaProjection.openAI(inputSchema)
  if (!xai) return parameters
  const stripped = withoutClosedObjects(parameters)
  return ProviderShared.isRecord(stripped) ? stripped : parameters
}

const lowerTool = (tool: ToolDefinition, inputSchema: JsonSchema, xai: boolean): OpenAIResponsesTool => ({
  type: "function",
  name: tool.name,
  description: tool.description,
  parameters: lowerToolParameters(inputSchema, xai),
  // TODO: Read this from OpenAI-specific tool options so direct LLM callers can opt into strict
  // schemas. `@ai-sdk/xai` emits `strict` only when the tool carries one, which an AI SDK function
  // tool never does.
  ...(xai ? {} : { strict: false }),
})

const lowerToolChoice = (toolChoice: NonNullable<LLMRequest["toolChoice"]>) =>
  ProviderShared.matchToolChoice("OpenAI Responses", toolChoice, {
    auto: () => "auto" as const,
    none: () => "none" as const,
    required: () => "required" as const,
    tool: (name) => ({ type: "function" as const, name }),
  })

// Continuation metadata is namespaced by the SDK that produced it: `@ai-sdk/xai`
// writes `xai`, `@ai-sdk/openai` writes `openai`. Persisted parts carry
// whichever key was current when stored, so replay reads both.
const responsesMetadata = (part: {
  readonly providerMetadata?: ProviderMetadata
}): Record<string, unknown> | undefined => {
  const xai = part.providerMetadata?.xai
  if (ProviderShared.isRecord(xai)) return xai
  const openai = part.providerMetadata?.openai
  return ProviderShared.isRecord(openai) ? openai : undefined
}

const metadataItemID = (part: { readonly providerMetadata?: ProviderMetadata }) => {
  const itemId = responsesMetadata(part)?.itemId
  return typeof itemId === "string" && itemId.length > 0 ? itemId : undefined
}

const lowerToolCall = (part: ToolCallPart, xai: boolean): OpenAIResponsesInputItem => ({
  type: "function_call",
  // `@ai-sdk/xai` replays a call with its item id (falling back to the call id)
  // and `status: "completed"`; `@ai-sdk/openai` sends neither field.
  ...(xai ? { id: metadataItemID(part) ?? part.id } : {}),
  call_id: part.id,
  name: part.name,
  arguments: ProviderShared.encodeJson(part.input),
  ...(xai ? { status: "completed" } : {}),
})

// `@ai-sdk/xai` replays a reasoning item verbatim (id, summary, `status: "completed"`,
// `encrypted_content` when it is a string). It never emits `item_reference` and never merges parts
// sharing an item id, so it stays out of `lowerMessages`' OpenAI folding.
const lowerXAIReasoning = (part: ReasoningPart): OpenAIResponsesReasoningInput | undefined => {
  const metadata = responsesMetadata(part)
  const itemId = metadataItemID(part)
  const encryptedContent =
    typeof metadata?.reasoningEncryptedContent === "string" ? metadata.reasoningEncryptedContent : undefined
  if (itemId === undefined && encryptedContent === undefined) return undefined
  return {
    type: "reasoning",
    id: itemId ?? "",
    summary: part.text.length > 0 ? [{ type: "summary_text", text: part.text }] : [],
    status: "completed",
    ...(encryptedContent === undefined ? {} : { encrypted_content: encryptedContent }),
  }
}

const lowerReasoning = (part: ReasoningPart): OpenAIResponsesReasoningInput | undefined => {
  const metadata = responsesMetadata(part)
  if (metadata === undefined) return undefined
  const itemId = metadataItemID(part)
  const encryptedContent =
    typeof metadata.reasoningEncryptedContent === "string"
      ? metadata.reasoningEncryptedContent
      : metadata.reasoningEncryptedContent === null
        ? null
        : undefined
  // `ProviderTransform.message` strips the item id when the turn is not stored,
  // so a replayable item can arrive with encrypted state and no id; without
  // encrypted state there is nothing to replay, so the part is dropped.
  if (itemId === undefined && typeof encryptedContent !== "string") return undefined
  return {
    type: "reasoning",
    ...(itemId === undefined ? {} : { id: itemId }),
    summary: part.text.length > 0 ? [{ type: "summary_text", text: part.text }] : [],
    encrypted_content: encryptedContent,
  }
}

const hostedToolItemID = (part: ToolResultPart) => metadataItemID(part)

// t-vs5p1y: the lowering functions that run once per message or part are
// untraced. A named span copies the fiber's whole context, and a big chat's
// request lowers 1,400-2,800 messages per step. Request-level spans stay.
const lowerUserContent = Effect.fnUntraced(function* (
  part: LLMRequest["messages"][number]["content"][number],
) {
  if (part.type === "text") return { type: "input_text" as const, text: part.text }
  if (part.type === "media") {
    const media = yield* ProviderShared.validateMedia(
      "OpenAI Responses",
      part,
      new Set<string>(ProviderShared.IMAGE_MIMES),
    )
    return { type: "input_image" as const, image_url: media.dataUrl }
  }
  return yield* ProviderShared.unsupportedContent("OpenAI Responses", "user", ["text", "media"])
})

// Tool results may carry structured text/images. Keep media as provider-native
// content instead of JSON-stringifying base64 into a prompt string.
const lowerToolResultContentItem = Effect.fnUntraced(function* (
  item: ToolContent,
) {
  if (item.type === "text") return { type: "input_text" as const, text: item.text }
  const media = yield* ProviderShared.validateToolFile(
    "OpenAI Responses",
    item,
    new Set<string>(ProviderShared.IMAGE_MIMES),
  )
  return { type: "input_image" as const, image_url: media.dataUrl }
})

const lowerToolResultOutput = Effect.fnUntraced(function* (part: ToolResultPart) {
  // Text/json/error results encode as a plain string, as existing cassettes and providers expect.
  if (part.result.type !== "content") return ProviderShared.toolResultText(part)
  // Preserve the narrowed array element type when compiled through a consumer package.
  const content: ReadonlyArray<ToolContent> = part.result.value
  return yield* Effect.forEach(content, lowerToolResultContentItem)
})

// Image Budget
/**
 * Ceilings on the PICTURE BYTES one request may carry, counted as base64 —
 * the bytes that go on the wire. A single oversized image otherwise poisons a
 * session permanently: the engine's recent-image window bounds the COUNT of
 * pictures, never their size, so an oversized one is never evicted and every
 * replay resends it. The numbers are a floor, not a vendor limit, and can be
 * raised per provider (`providerOptions.openai.maxImageBytes` /
 * `.maxRequestImageBytes`). A dropped picture is REPLACED, never silently
 * removed: a model that asked to look at something and got nothing back would
 * ask again, forever.
 */
export const MAX_IMAGE_BASE64_BYTES = 2 * 1024 * 1024
export const MAX_REQUEST_IMAGE_BASE64_BYTES = 6 * 1024 * 1024

// The note is read by a MODEL, which acts on it, so the size must be a number
// it can use. Below a megabyte "0.0 MB" says nothing; hence the KB branch.
const sizeText = (bytes: number) =>
  bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`

const oversizeNote = (bytes: number, cap: number) =>
  `[image omitted: ${sizeText(bytes)} exceeds the ${sizeText(cap)} per-image limit for this provider; ask for a smaller capture]`

const budgetNote = (bytes: number, budget: number) =>
  `[image omitted: ${sizeText(bytes)}; this request's images exceed the ${sizeText(budget)} total limit for this provider, and the oldest were dropped first]`

/** The base64 payload of a `data:<mime>;base64,<payload>` URL. */
const imageBase64Bytes = (imageUrl: string) => {
  const comma = imageUrl.indexOf(",")
  return comma < 0 ? imageUrl.length : imageUrl.length - comma - 1
}

type LoweredImage = { readonly bytes: number; readonly omit: (note: string) => void }

/** Every lowered picture in the order it will be SENT, each with the means to
 *  replace itself with a note. Pictures live in two places: a user message's
 *  content array, and the array form of a `function_call_output`. */
const loweredImages = (input: ReadonlyArray<OpenAIResponsesInputItem>): LoweredImage[] => {
  const images: LoweredImage[] = []
  const scan = (content: Array<{ readonly type: string; readonly image_url?: string; readonly text?: string }>) => {
    content.forEach((item, index) => {
      if (item.type !== "input_image" || typeof item.image_url !== "string") return
      images.push({
        bytes: imageBase64Bytes(item.image_url),
        omit: (note) => {
          content[index] = { type: "input_text", text: note }
        },
      })
    })
  }
  for (const item of input) {
    if ("role" in item && item.role === "user" && Array.isArray(item.content)) scan(item.content as never)
    else if ("type" in item && item.type === "function_call_output" && Array.isArray(item.output))
      scan(item.output as never)
  }
  return images
}

/**
 * Apply both ceilings, in place, to the lowered input.
 *
 * Order matters: the per-image cap first, then the per-request budget OLDEST
 * FIRST — newest is what the model is looking at now. It runs on the REPLAYED
 * input, not only on what this turn added, which un-poisons a session that
 * already stored an oversized picture.
 */
const applyImageBudget = (input: ReadonlyArray<OpenAIResponsesInputItem>, request: LLMRequest) => {
  const cap = OpenAIOptions.maxImageBytes(request) ?? MAX_IMAGE_BASE64_BYTES
  const budget = OpenAIOptions.maxRequestImageBytes(request) ?? MAX_REQUEST_IMAGE_BASE64_BYTES
  const images = loweredImages(input)
  const kept: LoweredImage[] = []
  for (const image of images) {
    if (image.bytes > cap) image.omit(oversizeNote(image.bytes, cap))
    else kept.push(image)
  }
  let total = kept.reduce((sum, image) => sum + image.bytes, 0)
  for (const image of kept) {
    if (total <= budget) break
    image.omit(budgetNote(image.bytes, budget))
    total -= image.bytes
  }
  return input
}

const lowerMessages = Effect.fn("OpenAIResponses.lowerMessages")(function* (request: LLMRequest) {
  const systemText = ProviderShared.joinText(request.system)
  const system: OpenAIResponsesInputItem[] =
    request.system.length === 0
      ? []
      : isReasoningModel(request.model.id)
        ? [{ role: "developer", content: systemText }]
        : [{ role: "system", content: systemText }]
  const input: OpenAIResponsesInputItem[] = [...system]
  const store = OpenAIOptions.store(request)
  const xai = isXAI(request)

  for (const message of request.messages) {
    if (message.role === "system") {
      const part = yield* ProviderShared.wrappedSystemUpdate("OpenAI Responses", message)
      const previous = input.at(-1)
      if (previous && "role" in previous && previous.role === "user")
        input[input.length - 1] = {
          role: "user",
          content: [...previous.content, { type: "input_text", text: part.text }],
        }
      else input.push({ role: "user", content: [{ type: "input_text", text: part.text }] })
      continue
    }

    if (message.role === "user") {
      input.push({ role: "user", content: yield* Effect.forEach(message.content, lowerUserContent) })
      continue
    }

    if (message.role === "assistant") {
      const content: TextPart[] = []
      const reasoningItems: Record<string, OpenAIResponsesReasoningReplay> = {}
      const reasoningReferences = new Set<string>()
      const hostedToolReferences = new Set<string>()
      const flushText = () => {
        if (content.length === 0) return
        input.push({ role: "assistant", content: content.map((part) => ({ type: "output_text", text: part.text })) })
        content.splice(0, content.length)
      }
      for (const part of message.content) {
        if (part.type === "text") {
          content.push(part)
          continue
        }
        if (part.type === "reasoning") {
          flushText()
          if (xai) {
            const reasoning = lowerXAIReasoning(part)
            if (reasoning) input.push(reasoning)
            continue
          }
          const reasoning = lowerReasoning(part)
          if (!reasoning) continue
          // An id-less item cannot be referenced or merged: there is no key to
          // merge on. `@ai-sdk/openai` pushes each one as its own input item.
          if (reasoning.id === undefined) {
            const { id: _id, ...replay } = reasoning
            input.push(replay)
            continue
          }
          if (store !== false) {
            if (!reasoningReferences.has(reasoning.id)) input.push({ type: "item_reference", id: reasoning.id })
            reasoningReferences.add(reasoning.id)
            continue
          }
          const existing = reasoningItems[reasoning.id]
          if (existing) {
            existing.summary.push(...reasoning.summary)
            if (typeof reasoning.encrypted_content === "string")
              existing.encrypted_content = reasoning.encrypted_content
            continue
          }
          const replay = {
            type: reasoning.type,
            summary: reasoning.summary,
            encrypted_content: reasoning.encrypted_content,
          }
          reasoningItems[reasoning.id] = replay
          input.push(replay)
          continue
        }
        if (part.type === "tool-call") {
          flushText()
          if (part.providerExecuted === true) continue
          input.push(lowerToolCall(part, xai))
          continue
        }
        if (part.type === "tool-result" && part.providerExecuted === true) {
          flushText()
          const itemID = hostedToolItemID(part)
          if (store !== false && itemID && !hostedToolReferences.has(itemID))
            input.push({ type: "item_reference", id: itemID })
          if (itemID) hostedToolReferences.add(itemID)
          continue
        }
        return yield* ProviderShared.unsupportedContent("OpenAI Responses", "assistant", [
          "text",
          "reasoning",
          "tool-call",
          "tool-result",
        ])
      }
      flushText()
      continue
    }

    for (const part of message.content) {
      if (!ProviderShared.supportsContent(part, ["tool-result"]))
        return yield* ProviderShared.unsupportedContent("OpenAI Responses", "tool", ["tool-result"])
      input.push({
        type: "function_call_output",
        call_id: part.id,
        output: yield* lowerToolResultOutput(part),
      })
    }
  }

  // With store:false, OpenAI only accepts previous reasoning items when the
  // complete item has encrypted state, which may arrive only on the last
  // summary block — so filter after they have been joined. xAI has no such rule.
  return applyImageBudget(
    store === false && !xai
      ? input.filter(
          (item) => !("type" in item) || item.type !== "reasoning" || typeof item.encrypted_content === "string",
        )
      : input,
    request,
  )
})

const lowerOptions = Effect.fn("OpenAIResponses.lowerOptions")(function* (request: LLMRequest) {
  const store = OpenAIOptions.store(request)
  const promptCacheKey = OpenAIOptions.promptCacheKey(request)
  const promptCacheRetention = OpenAIOptions.promptCacheRetention(request)
  const effort = OpenAIOptions.reasoningEffort(request)
  if (effort && !OpenAIOptions.isReasoningEffort(effort))
    return yield* invalid(`OpenAI Responses does not support reasoning effort ${effort}`)
  const summary = OpenAIOptions.reasoningSummary(request)
  const mode = OpenAIOptions.reasoningMode(request)
  const context = OpenAIOptions.reasoningContext(request)
  // `@ai-sdk/openai` emits the reasoning block only on a reasoning model;
  // `@ai-sdk/xai` has no such rule and keeps it whenever an option is set.
  const reasoning =
    (isXAI(request) || isReasoningModel(request.model.id)) && (effort || summary || mode || context)
      ? { effort, summary, mode, context }
      : undefined
  const include = OpenAIOptions.include(request)
  const verbosity = OpenAIOptions.textVerbosity(request)
  const instructions = OpenAIOptions.instructions(request)
  const serviceTier = OpenAIOptions.serviceTier(request)
  return {
    ...(instructions ? { instructions } : {}),
    ...(store !== undefined ? { store } : {}),
    ...(promptCacheKey ? { prompt_cache_key: promptCacheKey } : {}),
    ...(promptCacheRetention ? { prompt_cache_retention: promptCacheRetention } : {}),
    ...(include ? { include } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(verbosity ? { text: { verbosity } } : {}),
    ...(serviceTier ? { service_tier: serviceTier } : {}),
  }
})

const fromRequest = Effect.fn("OpenAIResponses.fromRequest")(function* (request: LLMRequest) {
  const generation = request.generation
  const options = yield* lowerOptions(request)
  const toolSchemaCompatibility = request.model.compatibility?.toolSchema
  // OpenAI rejects the sampling knobs on a reasoning model, unless reasoning is
  // switched off on a model that accepts them without it.
  const dropSampling =
    isReasoningModel(request.model.id) &&
    !(OpenAIOptions.reasoningEffort(request) === "none" && supportsNonReasoningParameters(request.model.id))
  return {
    model: request.model.id,
    input: yield* lowerMessages(request),
    tools:
      request.tools.length === 0
        ? undefined
        : request.tools.map((tool) =>
            lowerTool(
              tool,
              ToolSchemaProjection.modelCompatibility(tool.inputSchema, toolSchemaCompatibility),
              isXAI(request),
            ),
          ),
    tool_choice: request.toolChoice ? yield* lowerToolChoice(request.toolChoice) : undefined,
    stream: true as const,
    max_output_tokens: generation?.maxTokens,
    temperature: dropSampling ? undefined : generation?.temperature,
    top_p: dropSampling ? undefined : generation?.topP,
    ...options,
  }
})

// Stream Parsing
// Responses reports `input_tokens` (inclusive total) with a `cached_tokens`
// subset, and `output_tokens` (inclusive total) with a `reasoning_tokens`
// subset. Pass the totals through and derive the non-cached breakdown.
const mapUsage = (state: ParserState, usage: OpenAIResponsesUsage | null | undefined) => {
  if (!usage) return undefined
  const cached = usage.input_tokens_details?.cached_tokens
  const reasoning = usage.output_tokens_details?.reasoning_tokens
  const nonCached = ProviderShared.subtractTokens(usage.input_tokens, cached)
  return new Usage({
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    nonCachedInputTokens: nonCached,
    cacheReadInputTokens: cached,
    reasoningTokens: reasoning,
    totalTokens: ProviderShared.totalTokens(usage.input_tokens, usage.output_tokens, usage.total_tokens),
    providerMetadata: metadataFor(state, usage),
  })
}

const mapFinishReason = (event: OpenAIResponsesEvent, hasFunctionCall: boolean): FinishReason => {
  const reason = event.response?.incomplete_details?.reason
  if (reason === undefined || reason === null) return hasFunctionCall ? "tool-calls" : "stop"
  if (reason === "max_output_tokens") return "length"
  if (reason === "content_filter") return "content-filter"
  return hasFunctionCall ? "tool-calls" : "unknown"
}

// `@ai-sdk/xai` namespaces stream metadata under `xai`, `@ai-sdk/openai` under
// `openai`. Persisted parts carry the key into the store, so `responsesMetadata` reads both.
const metadataFor = (state: ParserState, metadata: Record<string, unknown>): ProviderMetadata => ({
  [state.metadataKey]: metadata,
})

// Hosted (provider-executed) tool items ship typed input + status + result in
// one item. They surface as a `tool-call` + `tool-result` pair differentiated
// only by `providerExecuted: true`. One record per item type: the name we
// surface plus an `input` extractor; falling back to `{}` keeps unknown tools observable.
const HOSTED_TOOLS = {
  web_search_call: { name: "web_search", input: (item) => item.action ?? {} },
  web_search_preview_call: { name: "web_search_preview", input: (item) => item.action ?? {} },
  file_search_call: { name: "file_search", input: (item) => ({ queries: item.queries ?? [] }) },
  code_interpreter_call: {
    name: "code_interpreter",
    input: (item) => ({ code: item.code, container_id: item.container_id }),
  },
  computer_use_call: { name: "computer_use", input: (item) => item.action ?? {} },
  image_generation_call: { name: "image_generation", input: () => ({}) },
  mcp_call: {
    name: "mcp",
    input: (item) => ({ server_label: item.server_label, name: item.name, arguments: item.arguments }),
  },
  local_shell_call: { name: "local_shell", input: (item) => item.action ?? {} },
} as const satisfies Record<
  string,
  { readonly name: string; readonly input: (item: OpenAIResponsesStreamItem) => unknown }
>

type HostedToolType = keyof typeof HOSTED_TOOLS

const isHostedToolItem = (
  item: OpenAIResponsesStreamItem,
): item is OpenAIResponsesStreamItem & { type: HostedToolType; id: string } =>
  item.type in HOSTED_TOOLS && typeof item.id === "string" && item.id.length > 0

const isReasoningItem = (
  item: OpenAIResponsesStreamItem,
): item is OpenAIResponsesStreamItem & { type: "reasoning"; id: string } =>
  item.type === "reasoning" && typeof item.id === "string" && item.id.length > 0

// Round-trip the full item as the structured result so consumers can extract
// outputs / sources / status without re-decoding.
const hostedToolResult = (item: OpenAIResponsesStreamItem) => {
  const isError = typeof item.error !== "undefined" && item.error !== null
  return isError ? { type: "error" as const, value: item.error } : { type: "json" as const, value: item }
}

const hostedToolEvents = (
  state: ParserState,
  item: OpenAIResponsesStreamItem & { type: HostedToolType; id: string },
): ReadonlyArray<LLMEvent> => {
  const tool = HOSTED_TOOLS[item.type]
  const providerMetadata = metadataFor(state, { itemId: item.id })
  return [
    LLMEvent.toolCall({
      id: item.id,
      name: tool.name,
      input: tool.input(item),
      providerExecuted: true,
      providerMetadata,
    }),
    LLMEvent.toolResult({
      id: item.id,
      name: tool.name,
      result: hostedToolResult(item),
      providerExecuted: true,
      providerMetadata,
    }),
  ]
}

type StepResult = readonly [ParserState, ReadonlyArray<LLMEvent>]

const NO_EVENTS: StepResult["1"] = []

// `response.completed`/`response.incomplete` finish cleanly; `response.failed`
// is a hard failure. All three end the stream — one set keeps `step` and the
// protocol's `terminal` predicate in sync.
const TERMINAL_TYPES = new Set(["response.completed", "response.incomplete", "response.failed"])

const onOutputTextDelta = (state: ParserState, event: OpenAIResponsesEvent): StepResult => {
  if (!event.delta) return [state, NO_EVENTS]
  const events: LLMEvent[] = []
  return [
    { ...state, lifecycle: Lifecycle.textDelta(state.lifecycle, events, event.item_id ?? "text-0", event.delta) },
    events,
  ]
}

const onReasoningDelta = (state: ParserState, event: OpenAIResponsesEvent): StepResult => {
  if (!event.delta) return [state, NO_EVENTS]
  const events: LLMEvent[] = []
  const itemID = event.item_id ?? "reasoning-0"
  const id =
    event.summary_index !== undefined || state.reasoningItems[itemID] ? `${itemID}:${event.summary_index ?? 0}` : itemID
  return [
    {
      ...state,
      lifecycle: Lifecycle.reasoningDelta(state.lifecycle, events, id, event.delta),
    },
    events,
  ]
}

const onReasoningDone = (state: ParserState, _event: OpenAIResponsesEvent): StepResult => [state, NO_EVENTS]

const reasoningMetadata = (state: ParserState, item: OpenAIResponsesStreamItem & { id: string }) =>
  metadataFor(state, { itemId: item.id, reasoningEncryptedContent: item.encrypted_content ?? null })

// OpenAI Responses streams reasoning items in a stable order:
//   `output_item.added` (reasoning) →
//     `reasoning_summary_part.added` (index=0) →
//     `reasoning_summary_text.delta` →
//     `reasoning_summary_part.done` (index=0) →
//     (repeat for index>0) →
//   `output_item.done` (reasoning).
// The handlers rely on this ordering; out-of-order events are best-effort.
const onOutputItemAdded = (state: ParserState, event: OpenAIResponsesEvent): StepResult => {
  const item = event.item
  if (item && isReasoningItem(item)) {
    const events: LLMEvent[] = []
    return [
      {
        ...state,
        lifecycle: Lifecycle.reasoningStart(state.lifecycle, events, `${item.id}:0`, reasoningMetadata(state, item)),
        reasoningItems: {
          ...state.reasoningItems,
          [item.id]: { encryptedContent: item.encrypted_content, summaryParts: { 0: "active" } },
        },
      },
      events,
    ]
  }
  if (item?.type !== "function_call" || !item.id) return [state, NO_EVENTS]
  const providerMetadata = metadataFor(state, { itemId: item.id })
  const events: LLMEvent[] = []
  const lifecycle = Lifecycle.stepStart(state.lifecycle, events)
  return [
    {
      ...state,
      lifecycle,
      hasFunctionCall: state.hasFunctionCall,
      tools: ToolStream.start(state.tools, item.id, {
        id: item.call_id ?? item.id,
        name: item.name ?? "",
        input: item.arguments ?? "",
        providerMetadata,
      }),
    },
    [...events, LLMEvent.toolInputStart({ id: item.call_id ?? item.id, name: item.name ?? "", providerMetadata })],
  ]
}

const onReasoningSummaryPartAdded = (state: ParserState, event: OpenAIResponsesEvent): StepResult => {
  if (!event.item_id || event.summary_index === undefined) return [state, NO_EVENTS]
  const item = state.reasoningItems[event.item_id] ?? { encryptedContent: undefined, summaryParts: {} }
  if (event.summary_index === 0) {
    if (state.reasoningItems[event.item_id]) return [state, NO_EVENTS]
    const events: LLMEvent[] = []
    return [
      {
        ...state,
        lifecycle: Lifecycle.reasoningStart(
          state.lifecycle,
          events,
          `${event.item_id}:0`,
          metadataFor(state, { itemId: event.item_id, reasoningEncryptedContent: null }),
        ),
        reasoningItems: {
          ...state.reasoningItems,
          [event.item_id]: { ...item, summaryParts: { 0: "active" } },
        },
      },
      events,
    ]
  }

  const events: LLMEvent[] = []
  const closed = Object.entries(item.summaryParts)
    .filter((entry) => entry[1] === "can-conclude")
    .reduce(
      (lifecycle, entry) =>
        Lifecycle.reasoningEnd(
          lifecycle,
          events,
          `${event.item_id}:${entry[0]}`,
          metadataFor(state, { itemId: event.item_id }),
        ),
      state.lifecycle,
    )
  return [
    {
      ...state,
      lifecycle: Lifecycle.reasoningStart(
        closed,
        events,
        `${event.item_id}:${event.summary_index}`,
        metadataFor(state, { itemId: event.item_id, reasoningEncryptedContent: item.encryptedContent ?? null }),
      ),
      reasoningItems: {
        ...state.reasoningItems,
        [event.item_id]: {
          ...item,
          summaryParts: {
            ...Object.fromEntries(
              Object.entries(item.summaryParts).map((entry) =>
                entry[1] === "can-conclude" ? [entry[0], "concluded" as const] : entry,
              ),
            ),
            [event.summary_index]: "active",
          },
        },
      },
    },
    events,
  ]
}

const onReasoningSummaryPartDone = (state: ParserState, event: OpenAIResponsesEvent): StepResult => {
  if (!event.item_id || event.summary_index === undefined) return [state, NO_EVENTS]
  const item = state.reasoningItems[event.item_id]
  if (!item) return [state, NO_EVENTS]
  const events: LLMEvent[] = []
  return [
    {
      ...state,
      lifecycle:
        state.store !== false
          ? Lifecycle.reasoningEnd(
              state.lifecycle,
              events,
              `${event.item_id}:${event.summary_index}`,
              metadataFor(state, { itemId: event.item_id }),
            )
          : state.lifecycle,
      reasoningItems: {
        ...state.reasoningItems,
        [event.item_id]: {
          ...item,
          summaryParts: {
            ...item.summaryParts,
            [event.summary_index]: state.store !== false ? "concluded" : "can-conclude",
          },
        },
      },
    },
    events,
  ]
}

const onFunctionCallArgumentsDelta = Effect.fn("OpenAIResponses.onFunctionCallArgumentsDelta")(function* (
  state: ParserState,
  event: OpenAIResponsesEvent,
) {
  if (!event.item_id || !event.delta) return [state, NO_EVENTS] satisfies StepResult
  const result = ToolStream.appendExisting(
    ADAPTER,
    state.tools,
    event.item_id,
    event.delta,
    "OpenAI Responses tool argument delta is missing its tool call",
  )
  if (ToolStream.isError(result)) return yield* result
  const events: LLMEvent[] = []
  const lifecycle = result.events.length ? Lifecycle.stepStart(state.lifecycle, events) : state.lifecycle
  events.push(...result.events)
  return [{ ...state, lifecycle, tools: result.tools }, events] satisfies StepResult
})

const onOutputItemDone = Effect.fn("OpenAIResponses.onOutputItemDone")(function* (
  state: ParserState,
  event: OpenAIResponsesEvent,
) {
  const item = event.item
  if (!item) return [state, NO_EVENTS] satisfies StepResult

  if (item.type === "function_call") {
    if (!item.id || !item.call_id || !item.name) return [state, NO_EVENTS] satisfies StepResult
    const tools = state.tools[item.id]
      ? state.tools
      : ToolStream.start(state.tools, item.id, { id: item.call_id, name: item.name })
    const result =
      item.arguments === undefined
        ? yield* ToolStream.finish(ADAPTER, tools, item.id)
        : yield* ToolStream.finishWithInput(ADAPTER, tools, item.id, item.arguments)
    const events: LLMEvent[] = []
    const resultEvents = result.events ?? []
    const lifecycle = resultEvents.length ? Lifecycle.stepStart(state.lifecycle, events) : state.lifecycle
    events.push(...resultEvents)
    return [
      {
        ...state,
        lifecycle,
        hasFunctionCall: resultEvents.some(LLMEvent.is.toolCall) ? true : state.hasFunctionCall,
        tools: result.tools,
      },
      events,
    ] satisfies StepResult
  }

  if (isHostedToolItem(item)) {
    const events: LLMEvent[] = []
    const lifecycle = Lifecycle.stepStart(state.lifecycle, events)
    events.push(...hostedToolEvents(state, item))
    return [{ ...state, lifecycle }, events] satisfies StepResult
  }

  if (isReasoningItem(item)) {
    const events: LLMEvent[] = []
    const providerMetadata = reasoningMetadata(state, item)
    const reasoningItem = state.reasoningItems[item.id]
    if (reasoningItem) {
      const lifecycle = Object.entries(reasoningItem.summaryParts)
        .filter((entry) => entry[1] === "active" || entry[1] === "can-conclude")
        .reduce(
          (lifecycle, entry) => Lifecycle.reasoningEnd(lifecycle, events, `${item.id}:${entry[0]}`, providerMetadata),
          state.lifecycle,
        )
      const { [item.id]: _removed, ...reasoningItems } = state.reasoningItems
      return [{ ...state, lifecycle, reasoningItems }, events] satisfies StepResult
    }
    if (!state.lifecycle.reasoning.has(item.id)) {
      const lifecycle = Lifecycle.stepStart(state.lifecycle, events)
      events.push(LLMEvent.reasoningStart({ id: item.id, providerMetadata }))
      events.push(LLMEvent.reasoningEnd({ id: item.id, providerMetadata }))
      return [{ ...state, lifecycle }, events] satisfies StepResult
    }
    return [
      { ...state, lifecycle: Lifecycle.reasoningEnd(state.lifecycle, events, item.id, providerMetadata) },
      events,
    ] satisfies StepResult
  }

  return [state, NO_EVENTS] satisfies StepResult
})

const onResponseFinish = (state: ParserState, event: OpenAIResponsesEvent): StepResult => {
  const events: LLMEvent[] = []
  const lifecycle = Lifecycle.finish(state.lifecycle, events, {
    reason: mapFinishReason(event, state.hasFunctionCall),
    usage: mapUsage(state, event.response?.usage),
    providerMetadata: ProviderShared.withCopilotMetadata(
      event.response?.id || event.response?.service_tier
        ? metadataFor(state, {
            responseId: event.response.id,
            serviceTier: event.response.service_tier,
          })
        : undefined,
      ProviderShared.copilotMetadata(event.response?.copilot_usage),
    ),
  })
  return [{ ...state, lifecycle }, events]
}

/** The three places a Responses error names itself, in the order the codex
 *  client reads them: the top level (the spec's shape), a `response.error`
 *  envelope (`response.failed`, and proxies that bubble an HTTP error as an
 *  SSE frame), and a bare `error` envelope (the ChatGPT/codex backend).
 *  When both code and message are present the code is prefixed, so a rate
 *  limit is distinguishable from a generic stream drop. */
const errorPayloads = (event: OpenAIResponsesEvent) => [event, event.response?.error, event.error]

const errorField = (event: OpenAIResponsesEvent, field: "message" | "code") => {
  for (const payload of errorPayloads(event)) {
    const value = payload?.[field]
    if (value) return value
  }
  return undefined
}

/** Redacted so a raw dump can never put a credential in a transcript or a log. */
const SECRET_FIELD = /("(?:[^"]*(?:authorization|api[-_]?key|token|secret|credential|signature|key)[^"]*)"\s*:\s*)"[^"]*"/gi
const RAW_EVENT_LIMIT = 300

/**
 * The whole event, redacted and capped — the LAST resort, used only when the
 * backend named neither a message nor a code. A reason nobody can read is
 * worth less than an ugly one they can.
 */
const rawEventText = (event: OpenAIResponsesEvent) => {
  const json = JSON.stringify(event).replace(SECRET_FIELD, `$1"<redacted>"`)
  return json.length <= RAW_EVENT_LIMIT ? json : `${json.slice(0, RAW_EVENT_LIMIT)}…`
}

const providerErrorMessage = (event: OpenAIResponsesEvent, fallback: string): string => {
  const message = errorField(event, "message")
  const code = errorField(event, "code")
  if (message && code) return `${code}: ${message}`
  if (message || code) return message || code!
  return `${fallback}: ${rawEventText(event)}`
}

const providerError = (event: OpenAIResponsesEvent, fallback: string) => {
  const code = errorField(event, "code")
  const message = providerErrorMessage(event, fallback)
  return LLMEvent.providerError({
    message,
    classification: code === "context_length_exceeded" || isContextOverflow(message) ? "context-overflow" : undefined,
  })
}

/** Emit the provider error, and — when the backend named no reason — write the
 *  same raw frame to the log at WARN. The transcript line is for the user; the
 *  log line is the only trace a burst that recovered on retry leaves. */
const providerErrorStep = (state: ParserState, event: OpenAIResponsesEvent, fallback: string) => {
  const error = providerError(event, fallback)
  const named = errorField(event, "message") || errorField(event, "code")
  const step: StepResult = [state, [error]]
  if (named) return Effect.succeed(step)
  return Effect.logWarning(`${fallback}; the backend named no reason`, { event: rawEventText(event) }).pipe(
    Effect.as(step),
  )
}

const onResponseFailed = (state: ParserState, event: OpenAIResponsesEvent) =>
  providerErrorStep(state, event, "OpenAI Responses response failed")

const onError = (state: ParserState, event: OpenAIResponsesEvent) =>
  providerErrorStep(state, event, "OpenAI Responses stream error")

const step = (state: ParserState, event: OpenAIResponsesEvent) => {
  if (event.type === "response.output_text.delta") return Effect.succeed(onOutputTextDelta(state, event))
  if (
    event.type === "response.reasoning_text.delta" ||
    event.type === "response.reasoning_summary.delta" ||
    event.type === "response.reasoning_summary_text.delta"
  )
    return Effect.succeed(onReasoningDelta(state, event))
  if (
    event.type === "response.reasoning_text.done" ||
    event.type === "response.reasoning_summary.done" ||
    event.type === "response.reasoning_summary_text.done"
  )
    return Effect.succeed(onReasoningDone(state, event))
  if (event.type === "response.reasoning_summary_part.added")
    return Effect.succeed(onReasoningSummaryPartAdded(state, event))
  if (event.type === "response.reasoning_summary_part.done")
    return Effect.succeed(onReasoningSummaryPartDone(state, event))
  if (event.type === "response.output_item.added") return Effect.succeed(onOutputItemAdded(state, event))
  if (event.type === "response.function_call_arguments.delta") return onFunctionCallArgumentsDelta(state, event)
  if (event.type === "response.output_item.done") return onOutputItemDone(state, event)
  if (event.type === "response.completed" || event.type === "response.incomplete")
    return Effect.succeed(onResponseFinish(state, event))
  if (event.type === "response.failed") return onResponseFailed(state, event)
  if (event.type === "error") return onError(state, event)
  return Effect.succeed<StepResult>([state, NO_EVENTS])
}

// Protocol And OpenAI Route
/**
 * A body that ended without its terminal event still ends the turn.
 *
 * `response.completed` / `response.failed` is where this protocol emits its
 * finish; a body that stops before one leaves the stream with no `finish` and
 * no `text-end`, so the consumer's block never closes. Finishing with reason
 * "unknown" matches `@ai-sdk/openai` and the engine's recovery for that value.
 *
 * `stepStarted` is the exact "not yet finished" signal: `Lifecycle.finish`
 * sets it false and clears every open block, and a terminal event also ends
 * the stream, so nothing can re-open it. A body that produced NO events leaves
 * it false and gets nothing.
 */
const unfinished = (state: ParserState): ReadonlyArray<LLMEvent> => {
  if (!state.lifecycle.stepStarted) return []
  const events: LLMEvent[] = []
  Lifecycle.finish(state.lifecycle, events, { reason: "unknown" })
  return events
}

/** The OpenAI Responses protocol — request body construction, body schema, and
 *  the streaming-event state machine. Used by native OpenAI and Azure. */
export const protocol = Protocol.make({
  id: ADAPTER,
  body: {
    schema: OpenAIResponsesBody,
    structure: ["model", "input", "instructions", "tools", "tool_choice", "stream"],
    from: fromRequest,
  },
  stream: {
    event: Protocol.jsonEvent(OpenAIResponsesEvent),
    initial: (request) => ({
      hasFunctionCall: false,
      tools: ToolStream.empty<string>(),
      lifecycle: Lifecycle.initial(),
      reasoningItems: {},
      store: OpenAIOptions.store(request),
      metadataKey: isXAI(request) ? "xai" : "openai",
    }),
    step,
    terminal: (event) => TERMINAL_TYPES.has(event.type),
    onHalt: unfinished,
  },
})

const endpoint = Endpoint.path<OpenAIResponsesBody>(PATH, { baseURL: DEFAULT_BASE_URL })
const auth = Auth.none

export const httpTransport = HttpTransport.sseJson.with<OpenAIResponsesBody>()

export const route = Route.make({
  id: ADAPTER,
  provider: "openai",
  protocol,
  endpoint,
  auth,
  transport: httpTransport,
  defaults: { providerOptions: { openai: { store: false } } },
})

const decodeWebSocketMessage = ProviderShared.validateWith(Schema.decodeUnknownEffect(OpenAIResponsesWebSocketMessage))

const webSocketMessage = (body: OpenAIResponsesBody | Record<string, unknown>) =>
  Effect.gen(function* () {
    if (!ProviderShared.isRecord(body))
      return yield* ProviderShared.invalidRequest("OpenAI Responses WebSocket body must be a JSON object")
    const { stream: _stream, ...message } = body
    return yield* decodeWebSocketMessage({ ...message, type: "response.create" })
  })

export const webSocketTransport = WebSocketTransport.jsonTransport.with<
  OpenAIResponsesBody,
  OpenAIResponsesWebSocketMessage
>({
  toMessage: webSocketMessage,
  encodeMessage: encodeWebSocketMessage,
})

export const webSocketRoute = Route.make({
  id: `${ADAPTER}-websocket`,
  provider: "openai",
  protocol,
  endpoint,
  auth,
  transport: webSocketTransport,
  defaults: { providerOptions: { openai: { store: false } } },
})

export * as OpenAIResponses from "./openai-responses"
