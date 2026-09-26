import { Effect, Schema } from "effect"
import { Route } from "../route/client"
import { Auth } from "../route/auth"
import { Endpoint } from "../route/endpoint"
import { Framing } from "../route/framing"
import { Protocol } from "../route/protocol"
import {
  LLMEvent,
  Usage,
  type FinishReason,
  type JsonSchema,
  type LLMRequest,
  type MediaPart,
  type ProviderMetadata,
  type TextPart,
  type ToolCallPart,
  type ToolDefinition,
  type ToolContent,
} from "../schema"
import { JsonObject, optionalArray, ProviderShared } from "./shared"
import { GeminiToolSchema } from "./utils/gemini-tool-schema"
import { Lifecycle } from "./utils/lifecycle"
import { ToolSchemaProjection } from "./utils/tool-schema"

const ADAPTER = "gemini"
const MEDIA_MIMES = new Set<string>(ProviderShared.MEDIA_MIMES)
export const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"

// Request Body Schema
const GeminiTextPart = Schema.Struct({
  text: Schema.String,
  thought: Schema.optional(Schema.Boolean),
  thoughtSignature: Schema.optional(Schema.String),
})

const GeminiInlineDataPart = Schema.Struct({
  inlineData: Schema.Struct({
    mimeType: Schema.String,
    data: Schema.String,
  }),
})

const GeminiFunctionCallPart = Schema.Struct({
  functionCall: Schema.Struct({
    name: Schema.String,
    args: Schema.Unknown,
  }),
  thoughtSignature: Schema.optional(Schema.String),
})

const GeminiFunctionResponsePart = Schema.Struct({
  functionResponse: Schema.Struct({
    name: Schema.String,
    response: Schema.Unknown,
  }),
})

const GeminiContentPart = Schema.Union([
  GeminiTextPart,
  GeminiInlineDataPart,
  GeminiFunctionCallPart,
  GeminiFunctionResponsePart,
])

const GeminiContent = Schema.Struct({
  role: Schema.Literals(["user", "model"]),
  parts: Schema.Array(GeminiContentPart),
})
type GeminiContent = Schema.Schema.Type<typeof GeminiContent>

const GeminiSystemInstruction = Schema.Struct({
  parts: Schema.Array(Schema.Struct({ text: Schema.String })),
})

const GeminiFunctionDeclaration = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  parameters: Schema.optional(JsonObject),
})

const GeminiTool = Schema.Struct({
  functionDeclarations: Schema.Array(GeminiFunctionDeclaration),
})

const GeminiToolConfig = Schema.Struct({
  functionCallingConfig: Schema.Struct({
    mode: Schema.Literals(["AUTO", "NONE", "ANY"]),
    allowedFunctionNames: optionalArray(Schema.String),
  }),
})

const GeminiThinkingConfig = Schema.Struct({
  thinkingBudget: Schema.optional(Schema.Number),
  includeThoughts: Schema.optional(Schema.Boolean),
})

const GeminiGenerationConfig = Schema.Struct({
  maxOutputTokens: Schema.optional(Schema.Number),
  temperature: Schema.optional(Schema.Number),
  topP: Schema.optional(Schema.Number),
  topK: Schema.optional(Schema.Number),
  stopSequences: optionalArray(Schema.String),
  thinkingConfig: Schema.optional(GeminiThinkingConfig),
})

const GeminiBodyFields = {
  contents: Schema.Array(GeminiContent),
  systemInstruction: Schema.optional(GeminiSystemInstruction),
  tools: optionalArray(GeminiTool),
  toolConfig: Schema.optional(GeminiToolConfig),
  generationConfig: Schema.optional(GeminiGenerationConfig),
}
const GeminiBody = Schema.Struct(GeminiBodyFields)
export type GeminiBody = Schema.Schema.Type<typeof GeminiBody>

const GeminiUsage = Schema.Struct({
  cachedContentTokenCount: Schema.optional(Schema.Number),
  thoughtsTokenCount: Schema.optional(Schema.Number),
  promptTokenCount: Schema.optional(Schema.Number),
  candidatesTokenCount: Schema.optional(Schema.Number),
  totalTokenCount: Schema.optional(Schema.Number),
})
type GeminiUsage = Schema.Schema.Type<typeof GeminiUsage>

const GeminiCandidate = Schema.Struct({
  content: Schema.optional(GeminiContent),
  finishReason: Schema.optional(Schema.String),
})

const GeminiEvent = Schema.Struct({
  candidates: optionalArray(GeminiCandidate),
  usageMetadata: Schema.optional(GeminiUsage),
})
type GeminiEvent = Schema.Schema.Type<typeof GeminiEvent>

interface ParserState {
  readonly finishReason?: string
  readonly hasToolCalls: boolean
  readonly nextToolCallId: number
  readonly usage?: Usage
  readonly lifecycle: Lifecycle.State
  readonly reasoningSignature?: string
}

// Tool Schema Conversion
// Tool-schema conversion has two concerns, applied in order:
//
// 1. Sanitize — fix authoring mistakes Gemini rejects: integer/number enums
//    (must be strings), `required` naming a missing property, untyped arrays
//    (`items` must be present), and `properties`/`required` on non-object scalars.
// 2. Project — lossy map to Gemini's dialect, propagating only an allowlisted set
//    of keys; anything else (`additionalProperties`, `$ref`) is silently dropped.
//
// The implementation lives in `utils/gemini-tool-schema`.

// Request Lowering
const lowerTool = (tool: ToolDefinition, inputSchema: JsonSchema) => ({
  name: tool.name,
  description: tool.description,
  parameters: GeminiToolSchema.convert(inputSchema),
})

const lowerToolConfig = (toolChoice: NonNullable<LLMRequest["toolChoice"]>) =>
  ProviderShared.matchToolChoice("Gemini", toolChoice, {
    auto: () => ({ functionCallingConfig: { mode: "AUTO" as const } }),
    none: () => ({ functionCallingConfig: { mode: "NONE" as const } }),
    required: () => ({ functionCallingConfig: { mode: "ANY" as const } }),
    tool: (name) => ({ functionCallingConfig: { mode: "ANY" as const, allowedFunctionNames: [name] } }),
  })

// t-vs5p1y: the lowering functions that run once per message or part are
// untraced. A named span copies the fiber's whole context, and a big chat's
// request lowers 1,400-2,800 messages per step. Request-level spans stay.
const lowerUserPart = Effect.fnUntraced(function* (part: TextPart | MediaPart) {
  if (part.type === "text") return { text: part.text }
  const media = yield* ProviderShared.validateMedia("Gemini", part, MEDIA_MIMES)
  return { inlineData: { mimeType: media.mime, data: media.base64 } }
})

const googleMetadata = (metadata: Record<string, unknown>): ProviderMetadata => ({ google: metadata })

const thoughtSignature = (providerMetadata: ProviderMetadata | undefined) => {
  const google = providerMetadata?.google
  return ProviderShared.isRecord(google) && typeof google.thoughtSignature === "string"
    ? google.thoughtSignature
    : undefined
}

const lowerToolCall = (part: ToolCallPart) => ({
  functionCall: { name: part.name, args: part.input },
  thoughtSignature: thoughtSignature(part.providerMetadata),
})

const lowerMessages = Effect.fn("Gemini.lowerMessages")(function* (request: LLMRequest) {
  const contents: GeminiContent[] = []

  for (const message of request.messages) {
    if (message.role === "system") {
      const part = yield* ProviderShared.wrappedSystemUpdate("Gemini", message)
      const previous = contents.at(-1)
      if (previous?.role === "user")
        contents[contents.length - 1] = { role: "user", parts: [...previous.parts, { text: part.text }] }
      else contents.push({ role: "user", parts: [{ text: part.text }] })
      continue
    }

    if (message.role === "user") {
      const parts: Array<Schema.Schema.Type<typeof GeminiContentPart>> = []
      for (const part of message.content) {
        if (!ProviderShared.supportsContent(part, ["text", "media"]))
          return yield* ProviderShared.unsupportedContent("Gemini", "user", ["text", "media"])
        parts.push(yield* lowerUserPart(part))
      }
      contents.push({ role: "user", parts })
      continue
    }

    if (message.role === "assistant") {
      const parts: Array<Schema.Schema.Type<typeof GeminiContentPart>> = []
      for (const part of message.content) {
        if (!ProviderShared.supportsContent(part, ["text", "reasoning", "tool-call"]))
          return yield* ProviderShared.unsupportedContent("Gemini", "assistant", ["text", "reasoning", "tool-call"])
        if (part.type === "text") {
          parts.push({ text: part.text })
          continue
        }
        if (part.type === "reasoning") {
          parts.push({ text: part.text, thought: true, thoughtSignature: thoughtSignature(part.providerMetadata) })
          continue
        }
        if (part.type === "tool-call") {
          parts.push(lowerToolCall(part))
          continue
        }
      }
      contents.push({ role: "model", parts })
      continue
    }

    const parts: Array<Schema.Schema.Type<typeof GeminiContentPart>> = []
    for (const part of message.content) {
      if (!ProviderShared.supportsContent(part, ["tool-result"]))
        return yield* ProviderShared.unsupportedContent("Gemini", "tool", ["tool-result"])
      if (part.result.type !== "content") {
        parts.push({
          functionResponse: {
            name: part.name,
            response: {
              name: part.name,
              content: ProviderShared.toolResultText(part),
            },
          },
        })
        continue
      }
      const content: ReadonlyArray<ToolContent> = part.result.value
      const text = content.filter((item) => item.type === "text").map((item) => item.text)
      parts.push({
        functionResponse: {
          name: part.name,
          response: {
            name: part.name,
            content: text.join("\n"),
          },
        },
      })
      for (const item of content) {
        if (item.type === "text") continue
        const media = yield* ProviderShared.validateToolFile("Gemini", item, MEDIA_MIMES)
        parts.push({ inlineData: { mimeType: media.mime, data: media.base64 } })
      }
    }
    contents.push({ role: "user", parts })
  }

  return contents
})

const geminiOptions = (request: LLMRequest) => request.providerOptions?.gemini

const thinkingConfig = (request: LLMRequest) => {
  const value = geminiOptions(request)?.thinkingConfig
  if (!ProviderShared.isRecord(value)) return undefined
  const result = {
    thinkingBudget: typeof value.thinkingBudget === "number" ? value.thinkingBudget : undefined,
    includeThoughts: typeof value.includeThoughts === "boolean" ? value.includeThoughts : undefined,
  }
  return Object.values(result).some((item) => item !== undefined) ? result : undefined
}

const fromRequest = Effect.fn("Gemini.fromRequest")(function* (request: LLMRequest) {
  const toolsEnabled = request.tools.length > 0 && request.toolChoice?.type !== "none"
  const generation = request.generation
  const toolSchemaCompatibility = request.model.compatibility?.toolSchema
  const generationConfig = {
    maxOutputTokens: generation?.maxTokens,
    temperature: generation?.temperature,
    topP: generation?.topP,
    topK: generation?.topK,
    stopSequences: generation?.stop,
    thinkingConfig: thinkingConfig(request),
  }

  return {
    contents: yield* lowerMessages(request),
    systemInstruction:
      request.system.length === 0 ? undefined : { parts: [{ text: ProviderShared.joinText(request.system) }] },
    tools: toolsEnabled
      ? [
          {
            functionDeclarations: request.tools.map((tool) =>
              lowerTool(tool, ToolSchemaProjection.modelCompatibility(tool.inputSchema, toolSchemaCompatibility)),
            ),
          },
        ]
      : undefined,
    toolConfig: toolsEnabled && request.toolChoice ? yield* lowerToolConfig(request.toolChoice) : undefined,
    generationConfig: Object.values(generationConfig).some((value) => value !== undefined)
      ? generationConfig
      : undefined,
  }
})

// Stream Parsing
// Gemini reports `promptTokenCount` (inclusive total) with a
// `cachedContentTokenCount` subset. `candidatesTokenCount` is *exclusive* of
// `thoughtsTokenCount`, so the two are summed for the inclusive `outputTokens`.
const mapUsage = (usage: GeminiUsage | undefined) => {
  if (!usage) return undefined
  const cached = usage.cachedContentTokenCount
  const nonCached = ProviderShared.subtractTokens(usage.promptTokenCount, cached)
  // Only compute the total when the visible component is reported; otherwise we
  // would fabricate an inclusive number from a partial breakdown.
  const outputTokens =
    usage.candidatesTokenCount !== undefined ? usage.candidatesTokenCount + (usage.thoughtsTokenCount ?? 0) : undefined
  return new Usage({
    inputTokens: usage.promptTokenCount,
    outputTokens,
    nonCachedInputTokens: nonCached,
    cacheReadInputTokens: cached,
    reasoningTokens: usage.thoughtsTokenCount,
    totalTokens: ProviderShared.totalTokens(usage.promptTokenCount, outputTokens, usage.totalTokenCount),
    providerMetadata: { google: usage },
  })
}

const mapFinishReason = (finishReason: string | undefined, hasToolCalls: boolean): FinishReason => {
  if (finishReason === "STOP") return hasToolCalls ? "tool-calls" : "stop"
  if (finishReason === "MAX_TOKENS") return "length"
  if (
    finishReason === "IMAGE_SAFETY" ||
    finishReason === "RECITATION" ||
    finishReason === "SAFETY" ||
    finishReason === "BLOCKLIST" ||
    finishReason === "PROHIBITED_CONTENT" ||
    finishReason === "SPII"
  )
    return "content-filter"
  if (finishReason === "MALFORMED_FUNCTION_CALL") return "error"
  return "unknown"
}

const finish = (state: ParserState): ReadonlyArray<LLMEvent> =>
  state.finishReason || state.usage
    ? (() => {
        const events: LLMEvent[] = []
        const lifecycle = state.reasoningSignature
          ? Lifecycle.reasoningEnd(
              state.lifecycle,
              events,
              "reasoning-0",
              googleMetadata({ thoughtSignature: state.reasoningSignature }),
            )
          : state.lifecycle
        Lifecycle.finish(lifecycle, events, {
          reason: mapFinishReason(state.finishReason, state.hasToolCalls),
          usage: state.usage,
        })
        return events
      })()
    : []

const step = (state: ParserState, event: GeminiEvent) => {
  const nextState = {
    ...state,
    usage: event.usageMetadata ? (mapUsage(event.usageMetadata) ?? state.usage) : state.usage,
  }
  const candidate = event.candidates?.[0]
  if (!candidate?.content)
    return Effect.succeed([
      { ...nextState, finishReason: candidate?.finishReason ?? nextState.finishReason },
      [],
    ] as const)

  const events: LLMEvent[] = []
  let hasToolCalls = nextState.hasToolCalls
  let lifecycle = nextState.lifecycle
  let nextToolCallId = nextState.nextToolCallId
  let reasoningSignature = nextState.reasoningSignature

  for (const part of candidate.content.parts) {
    if ("thoughtSignature" in part && part.thoughtSignature && "thought" in part && part.thought)
      reasoningSignature = part.thoughtSignature
    if ("text" in part && part.text.length > 0) {
      if (part.thought) {
        lifecycle = Lifecycle.reasoningDelta(
          lifecycle,
          events,
          "reasoning-0",
          part.text,
          part.thoughtSignature ? googleMetadata({ thoughtSignature: part.thoughtSignature }) : undefined,
        )
        continue
      }
      lifecycle = Lifecycle.reasoningEnd(
        lifecycle,
        events,
        "reasoning-0",
        reasoningSignature ? googleMetadata({ thoughtSignature: reasoningSignature }) : undefined,
      )
      lifecycle = Lifecycle.textDelta(lifecycle, events, "text-0", part.text)
      continue
    }

    if ("functionCall" in part) {
      const input = part.functionCall.args
      const id = `tool_${nextToolCallId++}`
      lifecycle = Lifecycle.reasoningEnd(
        lifecycle,
        events,
        "reasoning-0",
        reasoningSignature ? googleMetadata({ thoughtSignature: reasoningSignature }) : undefined,
      )
      lifecycle = Lifecycle.stepStart(lifecycle, events)
      events.push(
        LLMEvent.toolCall({
          id,
          name: part.functionCall.name,
          input,
          providerMetadata: part.thoughtSignature
            ? googleMetadata({ thoughtSignature: part.thoughtSignature })
            : undefined,
        }),
      )
      hasToolCalls = true
    }
  }

  return Effect.succeed([
    {
      ...nextState,
      hasToolCalls,
      lifecycle,
      nextToolCallId,
      reasoningSignature,
      finishReason: candidate.finishReason ?? nextState.finishReason,
    },
    events,
  ] as const)
}

// Protocol And Gemini Route
/** The Gemini protocol — request body construction, body schema, and the
 *  streaming-event state machine. Used by Google AI Studio Gemini and (once
 *  registered) Vertex Gemini. */
export const protocol = Protocol.make({
  id: ADAPTER,
  body: {
    schema: GeminiBody,
    // Gemini nests every sampling knob inside `generationConfig`, so the
    // container itself is structure and the knobs travel via `generation`.
    structure: ["contents", "systemInstruction", "tools", "toolConfig", "generationConfig"],
    from: fromRequest,
  },
  stream: {
    event: Protocol.jsonEvent(GeminiEvent),
    initial: () => ({ hasToolCalls: false, nextToolCallId: 0, lifecycle: Lifecycle.initial() }),
    step,
    onHalt: finish,
  },
})

export const route = Route.make({
  id: ADAPTER,
  provider: "google",
  protocol,
  // Gemini's path embeds the model id and pins SSE framing at the URL level.
  endpoint: Endpoint.path(({ request }) => `/models/${request.model.id}:streamGenerateContent?alt=sse`, {
    baseURL: DEFAULT_BASE_URL,
  }),
  auth: Auth.none,
  framing: Framing.sse,
})

export * as Gemini from "./gemini"
