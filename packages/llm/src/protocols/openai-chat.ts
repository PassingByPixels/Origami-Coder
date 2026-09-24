import { Effect, Schema } from "effect"
import { Route } from "../route/client"
import { Auth } from "../route/auth"
import { Endpoint } from "../route/endpoint"
import { HttpTransport } from "../route/transport"
import { Protocol } from "../route/protocol"
import {
  LLMEvent,
  ReasoningEffort,
  Usage,
  type FinishReason,
  type JsonSchema,
  type LLMRequest,
  type MediaPart,
  type ProviderMetadata,
  type ReasoningPart,
  type TextPart,
  type ToolCallPart,
  type ToolDefinition,
  type ToolContent,
} from "../schema"
import { isContextOverflow } from "../provider-error"
import { isRecord, JsonObject, optionalArray, optionalNull, ProviderShared } from "./shared"
import { OpenAIOptions } from "./utils/openai-options"
import { Lifecycle } from "./utils/lifecycle"
import { ThinkTags } from "./utils/think-tags"
import { ToolSchemaProjection } from "./utils/tool-schema"
import { ToolStream } from "./utils/tool-stream"

const ADAPTER = "openai-chat"
const IMAGE_MIMES = new Set<string>(ProviderShared.IMAGE_MIMES)
export const DEFAULT_BASE_URL = "https://api.openai.com/v1"
export const PATH = "/chat/completions"

// Request Body Schema
// The body schema is the provider-native JSON body; `fromRequest` builds it from `LLMRequest`, then
// `Route.make` validates and encodes it.
const OpenAIChatFunction = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  parameters: JsonObject,
})

const OpenAIChatTool = Schema.Struct({
  type: Schema.tag("function"),
  function: OpenAIChatFunction,
})
type OpenAIChatTool = Schema.Schema.Type<typeof OpenAIChatTool>

const OpenAIChatAssistantToolCall = Schema.Struct({
  id: Schema.String,
  type: Schema.tag("function"),
  function: Schema.Struct({
    name: Schema.String,
    arguments: Schema.String,
  }),
})
type OpenAIChatAssistantToolCall = Schema.Schema.Type<typeof OpenAIChatAssistantToolCall>

const OpenAIChatUserContent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("image_url"),
    image_url: Schema.Struct({ url: Schema.String }),
  }),
])

const OpenAIChatMessage = Schema.Union([
  Schema.Struct({ role: Schema.Literal("system"), content: Schema.String }),
  Schema.Struct({
    role: Schema.Literal("user"),
    content: Schema.Union([Schema.String, Schema.Array(OpenAIChatUserContent)]),
  }),
  Schema.Struct({
    role: Schema.Literal("assistant"),
    content: Schema.NullOr(Schema.String),
    tool_calls: optionalArray(OpenAIChatAssistantToolCall),
    reasoning_content: Schema.optional(Schema.String),
    reasoning: Schema.optional(Schema.String),
  }),
  Schema.Struct({ role: Schema.Literal("tool"), tool_call_id: Schema.String, content: Schema.String }),
]).pipe(Schema.toTaggedUnion("role"))
type OpenAIChatMessage = Schema.Schema.Type<typeof OpenAIChatMessage>

const OpenAIChatToolChoice = Schema.Union([
  Schema.Literals(["auto", "none", "required"]),
  Schema.Struct({
    type: Schema.tag("function"),
    function: Schema.Struct({ name: Schema.String }),
  }),
])

export const bodyFields = {
  model: Schema.String,
  messages: Schema.Array(OpenAIChatMessage),
  tools: optionalArray(OpenAIChatTool),
  tool_choice: Schema.optional(OpenAIChatToolChoice),
  stream: Schema.Literal(true),
  stream_options: Schema.optional(Schema.Struct({ include_usage: Schema.Boolean })),
  store: Schema.optional(Schema.Boolean),
  reasoning_effort: Schema.optional(ReasoningEffort),
  // gpt-5's text-verbosity knob. Chat Completions takes it as a TOP-LEVEL
  // `verbosity`, where the Responses API takes it as `text.verbosity`.
  // Deliberately NOT in `bodyStructure`, so it stays overlayable — the
  // OpenAI-compatible lane reaches the same wire field via `http.body.verbosity`.
  verbosity: Schema.optional(OpenAIOptions.OpenAITextVerbosity),
  max_tokens: Schema.optional(Schema.Number),
  temperature: Schema.optional(Schema.Number),
  top_p: Schema.optional(Schema.Number),
  frequency_penalty: Schema.optional(Schema.Number),
  presence_penalty: Schema.optional(Schema.Number),
  seed: Schema.optional(Schema.Number),
  stop: optionalArray(Schema.String),
}
const OpenAIChatBody = Schema.Struct(bodyFields)
export type OpenAIChatBody = Schema.Schema.Type<typeof OpenAIChatBody>

// Structure, not knobs: every key here says WHAT is being asked. The sampling
// fields and the provider options (`store`, `reasoning_effort`) stay
// overlayable, so a configured value keeps winning.
export const bodyStructure = ["model", "messages", "tools", "tool_choice", "stream", "stream_options"] as const

// Streaming Event Schema
// One decoded SSE `data:` payload: `Framing.sse` splits the byte stream, then `Protocol.jsonEvent`
// decodes each string into this shape.
const OpenAIChatUsage = Schema.Struct({
  prompt_tokens: Schema.optional(Schema.Number),
  completion_tokens: Schema.optional(Schema.Number),
  total_tokens: Schema.optional(Schema.Number),
  prompt_tokens_details: optionalNull(
    Schema.Struct({
      cached_tokens: Schema.optional(Schema.Number),
    }),
  ),
  completion_tokens_details: optionalNull(
    Schema.Struct({
      reasoning_tokens: Schema.optional(Schema.Number),
    }),
  ),
})

const OpenAIChatToolCallDeltaFunction = Schema.Struct({
  name: optionalNull(Schema.String),
  arguments: optionalNull(Schema.String),
})

const OpenAIChatToolCallDelta = Schema.Struct({
  // Optional on purpose: some OpenAI-compatible servers (Google's compatibility
  // layer) omit the index. Resolved as `index ?? toolCalls.length`, as
  // `@ai-sdk/openai-compatible` does, so an index-less delta starts a FRESH call.
  index: optionalNull(Schema.Number),
  id: optionalNull(Schema.String),
  function: optionalNull(OpenAIChatToolCallDeltaFunction),
})
type OpenAIChatToolCallDelta = Schema.Schema.Type<typeof OpenAIChatToolCallDelta>

const OpenAIChatDelta = Schema.Struct({
  content: optionalNull(Schema.String),
  reasoning_content: optionalNull(Schema.String),
  reasoning: optionalNull(Schema.String),
  // OpenRouter's STRUCTURED reasoning channel, beside the plain `reasoning`
  // string. Never read here, but the OpenRouter dialect needs the raw entries to
  // rebuild the `reasoning_details` a later turn replays, and a field this schema
  // does not name is gone by then. `Unknown` on purpose: a stricter type would fail the stream.
  reasoning_details: optionalNull(Schema.Unknown),
  tool_calls: optionalNull(Schema.Array(OpenAIChatToolCallDelta)),
})

const OpenAIChatChoice = Schema.Struct({
  delta: optionalNull(OpenAIChatDelta),
  finish_reason: optionalNull(Schema.String),
})

// An error the provider reports INSIDE a 200 body. OpenRouter documents
// `{ error: { code: number; message: string; metadata?: object } }` and sends it
// for every failure after the response headers are committed. `code` is a number
// there and a string in its own streaming example, so both are accepted. `error`
// is usually the object below, but several compatible servers and proxies send a
// bare sentence (`{"error":"upstream is overloaded"}`), so that decodes too.
const OpenAIChatErrorObject = Schema.Struct({
  message: optionalNull(Schema.String),
  type: optionalNull(Schema.String),
  code: optionalNull(Schema.Union([Schema.String, Schema.Number])),
  metadata: optionalNull(Schema.Unknown),
})

const OpenAIChatErrorPayload = Schema.Union([OpenAIChatErrorObject, Schema.String])

// The event is a UNION, not one struct with two optional halves, so a chunk
// carrying NEITHER a readable `choices` array nor an `error` object still fails
// the stream — an unreadable chunk may have carried content.
//
// The error member comes FIRST because OpenRouter's mid-stream error frame
// carries `choices` too (`[{ delta: { content: "" }, finish_reason: "error" }]`);
// a choices-first union would decode it as an ordinary empty delta.
const OpenAIChatErrorEvent = Schema.Struct({
  error: OpenAIChatErrorPayload,
  choices: Schema.optional(Schema.Array(OpenAIChatChoice)),
  usage: optionalNull(OpenAIChatUsage),
  copilot_usage: optionalNull(ProviderShared.CopilotUsage),
})

const OpenAIChatChunkEvent = Schema.Struct({
  choices: Schema.Array(OpenAIChatChoice),
  usage: optionalNull(OpenAIChatUsage),
  // GitHub Copilot's billed amount, beside `usage` and outside it. See
  // `ProviderShared.CopilotUsage`; no other OpenAI Chat endpoint sends it.
  copilot_usage: optionalNull(ProviderShared.CopilotUsage),
})

const OpenAIChatEvent = Schema.Union([OpenAIChatErrorEvent, OpenAIChatChunkEvent])
type OpenAIChatEvent = Schema.Schema.Type<typeof OpenAIChatEvent>
type OpenAIChatUsageValue = Schema.Schema.Type<typeof OpenAIChatChunkEvent>["usage"]
type OpenAIChatErrorPayload = Schema.Schema.Type<typeof OpenAIChatErrorPayload>
type OpenAIChatRequestMessage = LLMRequest["messages"][number]

interface ParserState {
  readonly tools: ToolStream.State<number>
  readonly toolCallEvents: ReadonlyArray<LLMEvent>
  /** Stream indexes whose call was already emitted; later deltas for them are ignored. */
  readonly finishedTools: ReadonlySet<number>
  /** One past the highest tool-call index seen this turn — the slot an index-less
   *  delta lands in. Mirrors `toolCalls.length` in `@ai-sdk/openai-compatible`,
   *  which never removes entries, so a finished call keeps its slot. */
  readonly nextToolIndex: number
  readonly toolCallsEmitted: number
  readonly usage?: Usage
  readonly finishReason?: FinishReason
  readonly lifecycle: Lifecycle.State
  /** Carried scan state for ` thinking` spans leaked onto `delta.content`. */
  readonly think: ThinkTags.State
  /** True once a dedicated reasoning field (reasoning_content or reasoning) has
   *  been seen this turn. Think-tag reasoning segments are then suppressed, since
   *  vLLM emits the same thinking on BOTH channels. */
  readonly reasoningSeen: boolean
  /** Copilot's billed amount, kept from the last frame that carried one. */
  readonly copilot?: ProviderMetadata
}

// Request Lowering
// Lowering is the only place that knows how common LLM messages map onto the OpenAI Chat wire
// format; provider quirks stay here.
const lowerTool = (tool: ToolDefinition, inputSchema: JsonSchema): OpenAIChatTool => ({
  type: "function",
  function: {
    name: tool.name,
    description: tool.description,
    parameters: ToolSchemaProjection.openAI(inputSchema),
  },
})

const lowerToolChoice = (toolChoice: NonNullable<LLMRequest["toolChoice"]>) =>
  ProviderShared.matchToolChoice("OpenAI Chat", toolChoice, {
    auto: () => "auto" as const,
    none: () => "none" as const,
    required: () => "required" as const,
    tool: (name) => ({ type: "function" as const, function: { name } }),
  })

const lowerToolCall = (part: ToolCallPart): OpenAIChatAssistantToolCall => ({
  id: part.id,
  type: "function",
  function: {
    name: part.name,
    arguments: ProviderShared.encodeJson(part.input),
  },
})

const lowerMedia = Effect.fn("OpenAIChat.lowerMedia")(function* (part: MediaPart) {
  const media = yield* ProviderShared.validateMedia("OpenAI Chat", part, IMAGE_MIMES)
  return { type: "image_url" as const, image_url: { url: media.dataUrl } }
})

const decodeTextMedia = (part: MediaPart): string => {
  if (typeof part.data !== "string") return new TextDecoder().decode(part.data)
  const comma = part.data.startsWith("data:") ? part.data.indexOf(",") : -1
  const base64 = comma >= 0 ? part.data.slice(comma + 1) : part.data
  return Buffer.from(base64, "base64").toString("utf8")
}

const openAICompatibleReasoningContent = (native: unknown) =>
  isRecord(native) && typeof native.reasoning_content === "string" ? native.reasoning_content : undefined

const openAICompatibleReasoning = (native: unknown) =>
  isRecord(native) && typeof native.reasoning === "string" ? native.reasoning : undefined

const lowerUserMessage = Effect.fn("OpenAIChat.lowerUserMessage")(function* (message: OpenAIChatRequestMessage) {
  const content: Array<Schema.Schema.Type<typeof OpenAIChatUserContent>> = []
  for (const part of message.content) {
    if (part.type === "text") {
      content.push({ type: "text", text: part.text })
      continue
    }
    // A text document (an attached README, an MCP text resource) travels as its
    // own text, as `@ai-sdk/openai-compatible` sends it; Chat has no file slot.
    if (part.type === "media" && part.mediaType.toLowerCase().startsWith("text/")) {
      content.push({ type: "text", text: decodeTextMedia(part) })
      continue
    }
    if (part.type === "media") {
      content.push(yield* lowerMedia(part))
      continue
    }
    return yield* ProviderShared.unsupportedContent("OpenAI Chat", "user", ["text", "media"])
  }
  if (content.every((part) => part.type === "text"))
    return { role: "user" as const, content: content.map((part) => part.text).join("") }
  return { role: "user" as const, content }
})

const lowerAssistantMessage = Effect.fn("OpenAIChat.lowerAssistantMessage")(function* (
  message: OpenAIChatRequestMessage,
) {
  const content: TextPart[] = []
  const reasoning: ReasoningPart[] = []
  const toolCalls: OpenAIChatAssistantToolCall[] = []
  for (const part of message.content) {
    if (!ProviderShared.supportsContent(part, ["text", "reasoning", "tool-call"]))
      return yield* ProviderShared.unsupportedContent("OpenAI Chat", "assistant", ["text", "reasoning", "tool-call"])
    if (part.type === "text") {
      content.push(part)
      continue
    }
    if (part.type === "reasoning") {
      reasoning.push(part)
      continue
    }
    if (part.type === "tool-call") {
      toolCalls.push(lowerToolCall(part))
      continue
    }
  }
  // A stored turn may carry its reasoning OUT of band, under the provider's own field name
  // (`reasoning_content` for DeepSeek-style servers, `reasoning` for gpt-oss-style ones). Inline
  // reasoning parts win; otherwise each stored field goes back under its own name.
  const stored = message.native?.openaiCompatible
  return {
    role: "assistant" as const,
    // An empty assistant turn (tool calls only) goes out as "" rather than null:
    // OpenAI accepts either and some compatible servers reject the null.
    content: ProviderShared.joinText(content),
    tool_calls: toolCalls.length === 0 ? undefined : toolCalls,
    reasoning_content:
      reasoning.length > 0 ? reasoning.map((part) => part.text).join("") : openAICompatibleReasoningContent(stored),
    reasoning: reasoning.length > 0 ? undefined : openAICompatibleReasoning(stored),
  }
})

const lowerToolMessages = Effect.fn("OpenAIChat.lowerToolMessages")(function* (message: OpenAIChatRequestMessage) {
  const messages: OpenAIChatMessage[] = []
  const images: Array<Schema.Schema.Type<typeof OpenAIChatUserContent>> = []
  for (const part of message.content) {
    if (!ProviderShared.supportsContent(part, ["tool-result"]))
      return yield* ProviderShared.unsupportedContent("OpenAI Chat", "tool", ["tool-result"])
    if (part.result.type !== "content") {
      messages.push({ role: "tool", tool_call_id: part.id, content: ProviderShared.toolResultText(part) })
      continue
    }
    const content: ReadonlyArray<ToolContent> = part.result.value
    const text = content.filter((item) => item.type === "text").map((item) => item.text)
    messages.push({ role: "tool", tool_call_id: part.id, content: text.join("\n") })
    const files = content.filter((item) => item.type === "file")
    images.push(
      ...(yield* Effect.forEach(files, (item) =>
        lowerMedia({ type: "media", mediaType: item.mime, data: item.uri, filename: item.name }),
      )),
    )
  }
  return { messages, images }
})

const lowerMessage = Effect.fn("OpenAIChat.lowerMessage")(function* (message: OpenAIChatRequestMessage) {
  if (message.role === "user") return [yield* lowerUserMessage(message)]
  if (message.role === "assistant") return [yield* lowerAssistantMessage(message)]
  return (yield* lowerToolMessages(message)).messages
})

const lowerMessages = Effect.fn("OpenAIChat.lowerMessages")(function* (request: LLMRequest) {
  const system: OpenAIChatMessage[] =
    request.system.length === 0 ? [] : [{ role: "system", content: ProviderShared.joinText(request.system) }]
  const messages = [...system]
  const pendingImages: Array<Schema.Schema.Type<typeof OpenAIChatUserContent>> = []
  const flushImages = () => {
    if (pendingImages.length === 0) return
    messages.push({ role: "user", content: pendingImages.splice(0) })
  }
  for (const message of request.messages) {
    if (message.role === "system") {
      const part = yield* ProviderShared.wrappedSystemUpdate("OpenAI Chat", message)
      if (pendingImages.length > 0) {
        messages.push({ role: "user", content: [...pendingImages.splice(0), { type: "text", text: part.text }] })
        continue
      }
      const previous = messages.at(-1)
      if (previous?.role === "user" && typeof previous.content === "string")
        messages[messages.length - 1] = { role: "user", content: `${previous.content}\n${part.text}` }
      else if (previous?.role === "user" && Array.isArray(previous.content))
        messages[messages.length - 1] = {
          role: "user",
          content: [...previous.content, { type: "text", text: part.text }],
        }
      else messages.push({ role: "user", content: part.text })
      continue
    }
    if (message.role === "tool") {
      const lowered = yield* lowerToolMessages(message)
      messages.push(...lowered.messages)
      pendingImages.push(...lowered.images)
      continue
    }
    flushImages()
    messages.push(...(yield* lowerMessage(message)))
  }
  flushImages()
  return messages
})

const lowerOptions = Effect.fn("OpenAIChat.lowerOptions")(function* (request: LLMRequest) {
  const store = OpenAIOptions.store(request)
  // Every tier passes through, `max` included: OpenAI-compatible servers accept
  // tiers OpenAI's own endpoint does not, and the endpoint's 400 is the truth.
  const reasoningEffort = OpenAIOptions.reasoningEffort(request)
  const verbosity = OpenAIOptions.textVerbosity(request)
  return {
    ...(store !== undefined ? { store } : {}),
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    ...(verbosity ? { verbosity } : {}),
  }
})

const fromRequest = Effect.fn("OpenAIChat.fromRequest")(function* (request: LLMRequest) {
  // `fromRequest` returns the provider body only; `Route.make` composes endpoint, auth, framing,
  // validation and execution.
  const generation = request.generation
  const toolSchemaCompatibility = request.model.compatibility?.toolSchema
  return {
    model: request.model.id,
    messages: yield* lowerMessages(request),
    tools:
      request.tools.length === 0
        ? undefined
        : request.tools.map((tool) =>
            lowerTool(tool, ToolSchemaProjection.modelCompatibility(tool.inputSchema, toolSchemaCompatibility)),
          ),
    tool_choice: request.toolChoice ? yield* lowerToolChoice(request.toolChoice) : undefined,
    stream: true as const,
    stream_options: { include_usage: true },
    max_tokens: generation?.maxTokens,
    temperature: generation?.temperature,
    top_p: generation?.topP,
    frequency_penalty: generation?.frequencyPenalty,
    presence_penalty: generation?.presencePenalty,
    seed: generation?.seed,
    stop: generation?.stop,
    ...(yield* lowerOptions(request)),
  }
})

// Stream Parsing
// Streaming parsers are state machines: each event returns a new state plus the
// `LLMEvent`s it produced. Tool calls accumulate — OpenAI streams JSON arguments across deltas.
const mapFinishReason = (reason: string | null | undefined): FinishReason => {
  if (reason === "stop") return "stop"
  if (reason === "length") return "length"
  if (reason === "content_filter") return "content-filter"
  if (reason === "function_call" || reason === "tool_calls") return "tool-calls"
  return "unknown"
}

// OpenAI Chat reports `prompt_tokens` (inclusive total) with a `cached_tokens`
// subset, and `completion_tokens` (inclusive total) with a `reasoning_tokens`
// subset. Pass the totals through and derive the non-cached breakdown.
const mapUsage = (usage: OpenAIChatUsageValue): Usage | undefined => {
  if (!usage) return undefined
  const cached = usage.prompt_tokens_details?.cached_tokens
  const reasoning = usage.completion_tokens_details?.reasoning_tokens
  const nonCached = ProviderShared.subtractTokens(usage.prompt_tokens, cached)
  return new Usage({
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    nonCachedInputTokens: nonCached,
    cacheReadInputTokens: cached,
    reasoningTokens: reasoning,
    totalTokens: ProviderShared.totalTokens(usage.prompt_tokens, usage.completion_tokens, usage.total_tokens),
    providerMetadata: { openai: usage },
  })
}

const isJsonText = (text: string) => {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

// Route one scanned content segment into the lifecycle. A reasoning segment joins
// the same `reasoning-0` block `delta.reasoning_content` uses, so several think
// bursts in one turn produce one coherent stream; a text segment closes reasoning
// first. The two channels do NOT merge: `step` suppresses think-tag reasoning once
// the dedicated field has been used, because vLLM sends the same text on both.
const emitSegment = (
  lifecycle: Lifecycle.State,
  events: LLMEvent[],
  segment: ThinkTags.Segment,
): Lifecycle.State => {
  if (segment.kind === "reasoning") return Lifecycle.reasoningDelta(lifecycle, events, "reasoning-0", segment.text)
  return Lifecycle.textDelta(Lifecycle.reasoningEnd(lifecycle, events, "reasoning-0"), events, "text-0", segment.text)
}

/**
 * The provider's own sentence, kept BARE.
 *
 * `@ai-sdk/openai-compatible` hands the consumer `chunk.value.error.message` and
 * nothing else, and the engine's stream-drop classifier is written against
 * exactly those words. A `code: ` prefix — the shape `openai-responses` uses —
 * would change the sentence the user reads. The code is not lost: it travels in
 * `providerMetadata`.
 */
const providerErrorMessage = (error: OpenAIChatErrorPayload): string => {
  if (typeof error === "string") return error
  if (error.message) return error.message
  const code = error.code === null || error.code === undefined ? undefined : String(error.code)
  const type = error.type ?? undefined
  return type ?? code ?? "OpenAI Chat stream error"
}

/** True when this is a REPORT, not just a field named `error`. An empty sentence
 *  names nothing, and a provider that puts `"error": ""` on ordinary chunks would
 *  otherwise turn every one into a failed turn. (`"error": null` decodes as neither
 *  union member, so the frame is read as an ordinary chunk.) */
const isReportedError = (error: OpenAIChatErrorPayload | undefined): error is OpenAIChatErrorPayload =>
  error !== undefined && error !== ""

const providerError = (error: OpenAIChatErrorPayload) => {
  const message = providerErrorMessage(error)
  return LLMEvent.providerError({
    message,
    classification: isContextOverflow(message) ? "context-overflow" : undefined,
    // `providerMetadata` is keyed maps, so a bare-sentence error travels as
    // `{ message }` rather than being dropped.
    providerMetadata: { openai: typeof error === "string" ? { message: error } : error },
  })
}

const step = (state: ParserState, event: OpenAIChatEvent) =>
  Effect.gen(function* () {
    // An error the provider wrote INTO the body. The stream does not fail: the
    // failure is reported, delivered prose and usage stay delivered, and
    // `finishReason` becomes "error", matching `@ai-sdk/openai-compatible`.
    if ("error" in event && isReportedError(event.error))
      return [{
        ...state,
        usage: mapUsage(event.usage) ?? state.usage,
        copilot: ProviderShared.copilotMetadata(event.copilot_usage) ?? state.copilot,
        finishReason: "error" as const,
      }, [
        providerError(event.error),
      ]] as const

    const events: LLMEvent[] = []
    const usage = mapUsage(event.usage) ?? state.usage
    const choice = event.choices?.[0]
    const finishReason = choice?.finish_reason ? mapFinishReason(choice.finish_reason) : state.finishReason
    const delta = choice?.delta
    const toolDeltas = delta?.tool_calls ?? []
    let tools = state.tools

    let lifecycle = state.lifecycle
    let reasoningSeen = state.reasoningSeen

    if (delta?.reasoning_content) {
      reasoningSeen = true
      lifecycle = Lifecycle.reasoningDelta(lifecycle, events, "reasoning-0", delta.reasoning_content)
    } else if (delta?.reasoning) {
      reasoningSeen = true
      lifecycle = Lifecycle.reasoningDelta(lifecycle, events, "reasoning-0", delta.reasoning)
    }

    let think = state.think
    if (delta?.content) {
      const scanned = ThinkTags.scan(think, delta.content)
      think = scanned.state
      for (const segment of scanned.segments) {
        if (reasoningSeen && segment.kind === "reasoning") continue
        lifecycle = emitSegment(lifecycle, events, segment)
      }
    }

    if (toolDeltas.length) lifecycle = Lifecycle.reasoningEnd(lifecycle, events, "reasoning-0")

    let finishedTools = state.finishedTools
    let toolCallsEmitted = state.toolCallsEmitted
    let nextToolIndex = state.nextToolIndex
    for (const tool of toolDeltas) {
      // `index ?? nextToolIndex` is `@ai-sdk/openai-compatible`'s
      // `toolCallDelta.index ?? toolCalls.length`. A provided index always wins, so
      // two real calls can never merge; an absent one takes the next free slot. A
      // CONTINUATION delta that drops its index lands on an empty slot and fails.
      const index = tool.index ?? nextToolIndex
      nextToolIndex = Math.max(nextToolIndex, index + 1)
      if (finishedTools.has(index)) continue
      const result = ToolStream.appendOrStart(
        ADAPTER,
        tools,
        index,
        { id: tool.id ?? undefined, name: tool.function?.name ?? undefined, text: tool.function?.arguments ?? "" },
        "OpenAI Chat tool call delta is missing id or name",
      )
      if (ToolStream.isError(result)) return yield* result
      tools = result.tools
      if (result.events.length) lifecycle = Lifecycle.stepStart(lifecycle, events)
      events.push(...result.events)
      // The call is complete the moment its arguments parse: emit it NOW rather
      // than at the finish reason, so a stream that dies later has still announced it.
      if (!isJsonText(result.tool.input)) continue
      const done = yield* ToolStream.finish(ADAPTER, tools, index)
      tools = done.tools
      if (!done.events) continue
      events.push(...done.events)
      toolCallsEmitted += 1
      finishedTools = new Set([...finishedTools, index])
    }

    // Finalize accumulated tool inputs eagerly when finish_reason arrives so
    // JSON parse failures fail the stream at the boundary rather than at halt.
    const finished =
      finishReason !== undefined && state.finishReason === undefined && Object.keys(tools).length > 0
        ? yield* ToolStream.finishAll(ADAPTER, tools)
        : undefined

    return [
      {
        tools: finished?.tools ?? tools,
        toolCallEvents: finished?.events ?? state.toolCallEvents,
        finishedTools,
        nextToolIndex,
        toolCallsEmitted,
        usage,
        finishReason,
        lifecycle,
        think,
        reasoningSeen,
        copilot: ProviderShared.copilotMetadata(event.copilot_usage) ?? state.copilot,
      },
      events,
    ] as const
  })

const finishEvents = (state: ParserState): ReadonlyArray<LLMEvent> => {
  const events: LLMEvent[] = []
  // A held-back partial tag that never completed was ordinary content — emit it
  // before the stream closes rather than swallowing it.
  const tail = ThinkTags.flush(state.think)
  let lifecycle = tail ? emitSegment(state.lifecycle, events, tail) : state.lifecycle
  const hasToolCalls = state.toolCallEvents.length > 0 || state.toolCallsEmitted > 0
  const reason = state.finishReason === "stop" && hasToolCalls ? "tool-calls" : state.finishReason
  if (state.toolCallEvents.length) lifecycle = Lifecycle.stepStart(lifecycle, events)
  events.push(...state.toolCallEvents)
  // ALWAYS terminal, even when no choice ever carried a `finish_reason`. A body
  // that closes cleanly without one would otherwise leave the stream with no
  // `finish` AND no `text-end`, so the consumer's block never closed. "unknown"
  // is the parity value `@ai-sdk/openai-compatible` uses and the engine has a
  // documented recovery for it. `Lifecycle.finish` closes any open block first.
  Lifecycle.finish(lifecycle, events, {
    reason: reason ?? "unknown",
    usage: state.usage,
    providerMetadata: state.copilot,
  })
  return events
}

// Protocol And OpenAI Route
/** The OpenAI Chat protocol — request body construction, body schema, and the
 *  streaming-event state machine. Reused by every route that speaks OpenAI Chat
 *  over HTTP+SSE: native OpenAI, DeepSeek, TogetherAI, Cerebras, Baseten,
 *  Fireworks, DeepInfra, and (once added) Azure OpenAI Chat. */
export const protocol = Protocol.make({
  id: ADAPTER,
  body: {
    schema: OpenAIChatBody,
    structure: bodyStructure,
    from: fromRequest,
  },
  stream: {
    event: Protocol.jsonEvent(OpenAIChatEvent),
    initial: () => ({
      tools: ToolStream.empty<number>(),
      toolCallEvents: [],
      finishedTools: new Set<number>(),
      nextToolIndex: 0,
      toolCallsEmitted: 0,
      lifecycle: Lifecycle.initial(),
      think: ThinkTags.initial(),
      reasoningSeen: false,
    }),
    step,
    onHalt: finishEvents,
  },
})

export const httpTransport = HttpTransport.sseJson.with<OpenAIChatBody>()

export const route = Route.make({
  id: ADAPTER,
  provider: "openai",
  protocol,
  endpoint: Endpoint.path(PATH, { baseURL: DEFAULT_BASE_URL }),
  auth: Auth.none,
  transport: httpTransport,
})

export * as OpenAIChat from "./openai-chat"
