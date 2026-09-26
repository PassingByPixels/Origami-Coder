import { Effect, Schema } from "effect"
import { Route } from "../route/client"
import { Auth } from "../route/auth"
import { Endpoint } from "../route/endpoint"
import { Framing } from "../route/framing"
import { Protocol } from "../route/protocol"
import {
  LLMEvent,
  Usage,
  CacheHint,
  type FinishReason,
  type JsonSchema,
  type LLMRequest,
  type MediaPart,
  type ProviderMetadata,
  type ToolCallPart,
  type ToolDefinition,
  type ToolContent,
  type ToolResultPart,
} from "../schema"
import { JsonObject, optionalArray, optionalNull, ProviderShared } from "./shared"
import { isContextOverflow } from "../provider-error"
import * as Cache from "./utils/cache"
import { Lifecycle } from "./utils/lifecycle"
import { ToolSchemaProjection } from "./utils/tool-schema"
import { ToolStream } from "./utils/tool-stream"

const ADAPTER = "anthropic-messages"
export const DEFAULT_BASE_URL = "https://api.anthropic.com/v1"
export const PATH = "/messages"

// Request Body Schema
const AnthropicCacheControl = Schema.Struct({
  type: Schema.tag("ephemeral"),
  ttl: Schema.optional(Schema.Literals(["5m", "1h"])),
})
type AnthropicCacheControl = Schema.Schema.Type<typeof AnthropicCacheControl>

const AnthropicTextBlock = Schema.Struct({
  type: Schema.tag("text"),
  text: Schema.String,
  cache_control: Schema.optional(AnthropicCacheControl),
})
type AnthropicTextBlock = Schema.Schema.Type<typeof AnthropicTextBlock>

const AnthropicImageBlock = Schema.Struct({
  type: Schema.tag("image"),
  source: Schema.Struct({
    type: Schema.tag("base64"),
    media_type: Schema.String,
    data: Schema.String,
  }),
  cache_control: Schema.optional(AnthropicCacheControl),
})
type AnthropicImageBlock = Schema.Schema.Type<typeof AnthropicImageBlock>

const AnthropicThinkingBlock = Schema.Struct({
  type: Schema.tag("thinking"),
  thinking: Schema.String,
  signature: Schema.optional(Schema.String),
  cache_control: Schema.optional(AnthropicCacheControl),
})

const AnthropicToolUseBlock = Schema.Struct({
  type: Schema.tag("tool_use"),
  id: Schema.String,
  name: Schema.String,
  input: Schema.Unknown,
  cache_control: Schema.optional(AnthropicCacheControl),
})
type AnthropicToolUseBlock = Schema.Schema.Type<typeof AnthropicToolUseBlock>

const AnthropicServerToolUseBlock = Schema.Struct({
  type: Schema.tag("server_tool_use"),
  id: Schema.String,
  name: Schema.String,
  input: Schema.Unknown,
  cache_control: Schema.optional(AnthropicCacheControl),
})
type AnthropicServerToolUseBlock = Schema.Schema.Type<typeof AnthropicServerToolUseBlock>

// Server tool result blocks: web_search_tool_result, code_execution_tool_result, and
// web_fetch_tool_result. The provider executes the tool and inlines the structured result
// — no client tool_result round-trip; `content` is round-tripped as opaque JSON.
const AnthropicServerToolResultType = Schema.Literals([
  "web_search_tool_result",
  "code_execution_tool_result",
  "web_fetch_tool_result",
])
type AnthropicServerToolResultType = Schema.Schema.Type<typeof AnthropicServerToolResultType>

const AnthropicServerToolResultBlock = Schema.Struct({
  type: AnthropicServerToolResultType,
  tool_use_id: Schema.String,
  content: Schema.Unknown,
  cache_control: Schema.optional(AnthropicCacheControl),
})
type AnthropicServerToolResultBlock = Schema.Schema.Type<typeof AnthropicServerToolResultBlock>

// Anthropic accepts either a plain string or an ordered array of text/image
// blocks inside `tool_result.content`. The array form is required when a tool
// returns image bytes, so they go in as image inputs instead of base64 in the prompt.
const AnthropicToolResultContent = Schema.Union([AnthropicTextBlock, AnthropicImageBlock])

const AnthropicToolResultBlock = Schema.Struct({
  type: Schema.tag("tool_result"),
  tool_use_id: Schema.String,
  content: Schema.Union([Schema.String, Schema.Array(AnthropicToolResultContent)]),
  is_error: Schema.optional(Schema.Boolean),
  cache_control: Schema.optional(AnthropicCacheControl),
})

const AnthropicUserBlock = Schema.Union([AnthropicTextBlock, AnthropicImageBlock, AnthropicToolResultBlock])
type AnthropicUserBlock = Schema.Schema.Type<typeof AnthropicUserBlock>
const AnthropicAssistantBlock = Schema.Union([
  AnthropicTextBlock,
  AnthropicThinkingBlock,
  AnthropicToolUseBlock,
  AnthropicServerToolUseBlock,
  AnthropicServerToolResultBlock,
])
type AnthropicAssistantBlock = Schema.Schema.Type<typeof AnthropicAssistantBlock>
type AnthropicToolResultBlock = Schema.Schema.Type<typeof AnthropicToolResultBlock>

const AnthropicMessage = Schema.Union([
  Schema.Struct({ role: Schema.Literal("user"), content: Schema.Array(AnthropicUserBlock) }),
  Schema.Struct({ role: Schema.Literal("assistant"), content: Schema.Array(AnthropicAssistantBlock) }),
  Schema.Struct({ role: Schema.Literal("system"), content: Schema.Array(AnthropicTextBlock) }),
]).pipe(Schema.toTaggedUnion("role"))
type AnthropicMessage = Schema.Schema.Type<typeof AnthropicMessage>

const AnthropicTool = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  input_schema: JsonObject,
  cache_control: Schema.optional(AnthropicCacheControl),
  eager_input_streaming: Schema.optional(Schema.Boolean),
})
type AnthropicTool = Schema.Schema.Type<typeof AnthropicTool>

const AnthropicToolChoice = Schema.Union([
  Schema.Struct({ type: Schema.Literals(["auto", "any"]) }),
  Schema.Struct({ type: Schema.tag("tool"), name: Schema.String }),
])

const AnthropicThinking = Schema.Struct({
  type: Schema.tag("enabled"),
  budget_tokens: Schema.Number,
})

const AnthropicBodyFields = {
  model: Schema.String,
  system: optionalArray(AnthropicTextBlock),
  messages: Schema.Array(AnthropicMessage),
  tools: optionalArray(AnthropicTool),
  tool_choice: Schema.optional(AnthropicToolChoice),
  stream: Schema.Literal(true),
  max_tokens: Schema.Number,
  temperature: Schema.optional(Schema.Number),
  top_p: Schema.optional(Schema.Number),
  top_k: Schema.optional(Schema.Number),
  stop_sequences: optionalArray(Schema.String),
  thinking: Schema.optional(AnthropicThinking),
}
const AnthropicMessagesBody = Schema.Struct(AnthropicBodyFields)
export type AnthropicMessagesBody = Schema.Schema.Type<typeof AnthropicMessagesBody>

const AnthropicUsage = Schema.Struct({
  input_tokens: Schema.optional(Schema.Number),
  output_tokens: Schema.optional(Schema.Number),
  cache_creation_input_tokens: optionalNull(Schema.Number),
  cache_read_input_tokens: optionalNull(Schema.Number),
})
type AnthropicUsage = Schema.Schema.Type<typeof AnthropicUsage>

const AnthropicStreamBlock = Schema.Struct({
  type: Schema.String,
  id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  thinking: Schema.optional(Schema.String),
  signature: Schema.optional(Schema.String),
  input: Schema.optional(Schema.Unknown),
  // *_tool_result blocks arrive whole as content_block_start (no streaming delta),
  // with the structured payload in `content` and the server_tool_use id in `tool_use_id`.
  tool_use_id: Schema.optional(Schema.String),
  content: Schema.optional(Schema.Unknown),
})

const AnthropicStreamDelta = Schema.Struct({
  type: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  thinking: Schema.optional(Schema.String),
  partial_json: Schema.optional(Schema.String),
  signature: Schema.optional(Schema.String),
  stop_reason: optionalNull(Schema.String),
  stop_sequence: optionalNull(Schema.String),
})

const AnthropicEvent = Schema.Struct({
  type: Schema.String,
  index: Schema.optional(Schema.Number),
  message: Schema.optional(Schema.Struct({ usage: Schema.optional(AnthropicUsage) })),
  content_block: Schema.optional(AnthropicStreamBlock),
  delta: Schema.optional(AnthropicStreamDelta),
  usage: Schema.optional(AnthropicUsage),
  // GitHub Copilot serves Claude over a `/v1/messages` shim and puts its billed
  // amount at the top level of `message_delta`, outside `usage`. Anthropic never sends it.
  copilot_usage: optionalNull(ProviderShared.CopilotUsage),
  // `type` and `message` are both required per Anthropic's spec, but proxies and
  // gateway translations occasionally drop one; optional so a partial payload still parses.
  error: Schema.optional(
    Schema.Struct({ type: Schema.optional(Schema.String), message: Schema.optional(Schema.String) }),
  ),
})
type AnthropicEvent = Schema.Schema.Type<typeof AnthropicEvent>

interface ParserState {
  readonly tools: ToolStream.State<number>
  readonly usage?: Usage
  readonly lifecycle: Lifecycle.State
}

const invalid = ProviderShared.invalidRequest

// Request Lowering
// Anthropic accepts at most 4 explicit cache_control breakpoints per request,
// across `tools`, `system`, and `messages`. Beyond the cap the API returns a
// 400, so lowering counts emitted markers and silently drops any that exceed it.
const ANTHROPIC_BREAKPOINT_CAP = 4

const EPHEMERAL_5M = { type: "ephemeral" as const }
const EPHEMERAL_1H = { type: "ephemeral" as const, ttl: "1h" as const }

const cacheControl = (breakpoints: Cache.Breakpoints, cache: CacheHint | undefined) => {
  if (cache?.type !== "ephemeral" && cache?.type !== "persistent") return undefined
  if (breakpoints.remaining <= 0) {
    breakpoints.dropped += 1
    return undefined
  }
  breakpoints.remaining -= 1
  return Cache.ttlBucket(cache.ttlSeconds) === "1h" ? EPHEMERAL_1H : EPHEMERAL_5M
}

// A caller that decides its own breakpoints marks WHOLE messages rather than individual parts.
// `@ai-sdk/anthropic` reads that marker off the message and puts `cache_control` on the message's
// LAST content block, with a part-level marker taking precedence. It arrives on
// `Message.native.anthropic.cacheControl`; `cache_control` is an accepted alias.
const messageCacheHint = (message: LLMRequest["messages"][number]): CacheHint | undefined => {
  const anthropic = message.native?.anthropic
  if (!ProviderShared.isRecord(anthropic)) return undefined
  const control = anthropic.cacheControl ?? anthropic.cache_control
  if (!ProviderShared.isRecord(control) || control.type !== "ephemeral") return undefined
  return control.ttl === "1h"
    ? new CacheHint({ type: "ephemeral", ttlSeconds: 3600 })
    : new CacheHint({ type: "ephemeral" })
}

// Apply a message-level hint to the last block, leaving an explicit part-level
// marker in place. Spends a breakpoint only when it actually writes one.
const withMessageCache = <Block extends { readonly cache_control?: AnthropicCacheControl }>(
  blocks: Block[],
  hint: CacheHint | undefined,
  breakpoints: Cache.Breakpoints,
): Block[] => {
  if (!hint || blocks.length === 0) return blocks
  const last = blocks[blocks.length - 1]!
  if (last.cache_control !== undefined) return blocks
  const control = cacheControl(breakpoints, hint)
  if (!control) return blocks
  blocks[blocks.length - 1] = { ...last, cache_control: control }
  return blocks
}

const anthropicMetadata = (metadata: Record<string, unknown>): ProviderMetadata => ({ anthropic: metadata })

const signatureFromMetadata = (metadata: ProviderMetadata | undefined): string | undefined => {
  const anthropic = metadata?.anthropic
  if (!ProviderShared.isRecord(anthropic)) return undefined
  return typeof anthropic.signature === "string" ? anthropic.signature : undefined
}

// Fine-grained (eager) streaming of tool-call inputs. This adapter always sends
// `stream: true`, so it is on by default for every function tool, matching
// `@ai-sdk/anthropic`. Opt out with `providerOptions.anthropic.toolStreaming: false`,
// or per tool with `ToolDefinition.native.anthropic.eagerInputStreaming: false`.
const requestEagerInputStreaming = (request: LLMRequest) => {
  const value = request.providerOptions?.anthropic?.toolStreaming
  return typeof value === "boolean" ? value : true
}

const toolEagerInputStreaming = (tool: ToolDefinition, fallback: boolean) => {
  const anthropic = tool.native?.anthropic
  if (!ProviderShared.isRecord(anthropic)) return fallback
  return typeof anthropic.eagerInputStreaming === "boolean" ? anthropic.eagerInputStreaming : fallback
}

const lowerTool = (
  breakpoints: Cache.Breakpoints,
  tool: ToolDefinition,
  inputSchema: JsonSchema,
  eagerInputStreaming: boolean,
): AnthropicTool => ({
  name: tool.name,
  description: tool.description,
  input_schema: inputSchema,
  cache_control: cacheControl(breakpoints, tool.cache),
  ...(toolEagerInputStreaming(tool, eagerInputStreaming) ? { eager_input_streaming: true as const } : {}),
})

const lowerToolChoice = (toolChoice: NonNullable<LLMRequest["toolChoice"]>) =>
  ProviderShared.matchToolChoice("Anthropic Messages", toolChoice, {
    auto: () => ({ type: "auto" as const }),
    none: () => undefined,
    required: () => ({ type: "any" as const }),
    tool: (name) => ({ type: "tool" as const, name }),
  })

const lowerToolCall = (part: ToolCallPart): AnthropicToolUseBlock => ({
  type: "tool_use",
  id: part.id,
  name: part.name,
  input: part.input,
})

const lowerServerToolCall = (part: ToolCallPart): AnthropicServerToolUseBlock => ({
  type: "server_tool_use",
  id: part.id,
  name: part.name,
  input: part.input,
})

// Server tool result blocks are typed by name. Anthropic ships three today;
// the block content is the provider's structured payload, round-tripped as-is.
const serverToolResultType = (name: string): AnthropicServerToolResultType | undefined => {
  if (name === "web_search") return "web_search_tool_result"
  if (name === "code_execution") return "code_execution_tool_result"
  if (name === "web_fetch") return "web_fetch_tool_result"
  return undefined
}

// t-vs5p1y: the lowering functions that run once per message or part are
// untraced. A named span copies the fiber's whole context, and a big chat's
// request lowers 1,400-2,800 messages per step. Request-level spans stay.
const lowerServerToolResult = Effect.fnUntraced(function* (part: ToolResultPart) {
  const wireType = serverToolResultType(part.name)
  if (!wireType)
    return yield* invalid(`Anthropic Messages does not know how to round-trip server tool result for ${part.name}`)
  return { type: wireType, tool_use_id: part.id, content: part.result.value } satisfies AnthropicServerToolResultBlock
})

const lowerImage = Effect.fnUntraced(function* (part: MediaPart) {
  const media = yield* ProviderShared.validateMedia(
    "Anthropic Messages",
    part,
    new Set<string>(ProviderShared.IMAGE_MIMES),
  )
  return {
    type: "image" as const,
    source: {
      type: "base64" as const,
      media_type: media.mime,
      data: media.base64,
    },
  } satisfies AnthropicImageBlock
})

// Tool results may carry structured text/images. Keep media as provider-native
// content instead of JSON-stringifying base64 into a prompt string.
const lowerToolResultContentItem = Effect.fnUntraced(function* (
  item: ToolContent,
) {
  if (item.type === "text") return { type: "text" as const, text: item.text } satisfies AnthropicTextBlock
  const media = yield* ProviderShared.validateToolFile(
    "Anthropic Messages",
    item,
    new Set<string>(ProviderShared.IMAGE_MIMES),
  )
  return {
    type: "image" as const,
    source: {
      type: "base64" as const,
      media_type: media.mime,
      data: media.base64,
    },
  } satisfies AnthropicImageBlock
})

const lowerToolResultContent = Effect.fnUntraced(function* (part: ToolResultPart) {
  // Text/json/error results stay a string, as existing cassettes and providers expect.
  if (part.result.type !== "content") return ProviderShared.toolResultText(part)
  // Preserve the narrowed array element type when compiled through a consumer package.
  const content: ReadonlyArray<ToolContent> = part.result.value
  return yield* Effect.forEach(content, lowerToolResultContentItem)
})

// Mid-conversation system messages are a native Claude API feature only for
// Opus 4.8. Other models use the visible wrapped-user fallback instead of a role they reject.
const supportsNativeSystemUpdates = (request: LLMRequest) => String(request.model.id) === "claude-opus-4-8"

const endsInServerToolUse = (message: LLMRequest["messages"][number]) => {
  const last = message.content.at(-1)
  return message.role === "assistant" && last?.type === "tool-call" && last.providerExecuted === true
}

const canUseNativeSystemUpdate = (messages: LLMRequest["messages"], index: number) => {
  const previous = messages[index - 1]
  const next = messages[index + 1]
  return (
    previous !== undefined &&
    previous.role !== "system" &&
    (previous.role === "user" || previous.role === "tool" || endsInServerToolUse(previous)) &&
    next?.role !== "system" &&
    (next === undefined || next.role === "assistant")
  )
}

const splitsLocalToolResults = (messages: LLMRequest["messages"], index: number) => {
  const pending = new Set<string>()
  for (const message of messages.slice(0, index)) {
    for (const part of message.content) {
      if (message.role === "assistant" && part.type === "tool-call" && part.providerExecuted !== true)
        pending.add(part.id)
      if (message.role === "tool" && part.type === "tool-result") pending.delete(part.id)
    }
  }
  return pending.size > 0
}

const lowerNativeSystemUpdate = Effect.fnUntraced(function* (
  message: LLMRequest["messages"][number],
  breakpoints: Cache.Breakpoints,
) {
  const content = yield* ProviderShared.systemUpdateText("Anthropic Messages", message)
  return {
    role: "system" as const,
    content: content.map((part) => ({
      type: "text" as const,
      text: part.text,
      cache_control: cacheControl(breakpoints, part.cache),
    })),
  }
})

const lowerMessages = Effect.fn("AnthropicMessages.lowerMessages")(function* (
  request: LLMRequest,
  breakpoints: Cache.Breakpoints,
) {
  const messages: AnthropicMessage[] = []

  for (const [index, message] of request.messages.entries()) {
    if (message.role === "system") {
      if (splitsLocalToolResults(request.messages, index))
        return yield* invalid("Anthropic Messages system updates cannot split a local tool call from its tool result")
      if (supportsNativeSystemUpdates(request) && canUseNativeSystemUpdate(request.messages, index)) {
        messages.push(yield* lowerNativeSystemUpdate(message, breakpoints))
        continue
      }
      const part = yield* ProviderShared.wrappedSystemUpdate("Anthropic Messages", message)
      const block = { type: "text" as const, text: part.text, cache_control: cacheControl(breakpoints, part.cache) }
      const previous = messages.at(-1)
      if (previous?.role === "user")
        messages[messages.length - 1] = { role: "user", content: [...previous.content, block] }
      else messages.push({ role: "user", content: [block] })
      continue
    }

    if (message.role === "user") {
      const content: AnthropicUserBlock[] = []
      for (const part of message.content) {
        if (part.type === "text") {
          content.push({ type: "text", text: part.text, cache_control: cacheControl(breakpoints, part.cache) })
          continue
        }
        if (part.type === "media") {
          content.push(yield* lowerImage(part))
          continue
        }
        return yield* ProviderShared.unsupportedContent("Anthropic Messages", "user", ["text", "media"])
      }
      messages.push({ role: "user", content: withMessageCache(content, messageCacheHint(message), breakpoints) })
      continue
    }

    if (message.role === "assistant") {
      const content: AnthropicAssistantBlock[] = []
      for (const part of message.content) {
        if (part.type === "text") {
          content.push({ type: "text", text: part.text, cache_control: cacheControl(breakpoints, part.cache) })
          continue
        }
        if (part.type === "reasoning") {
          content.push({
            type: "thinking",
            thinking: part.text,
            signature: part.encrypted ?? signatureFromMetadata(part.providerMetadata),
          })
          continue
        }
        if (part.type === "tool-call") {
          content.push(part.providerExecuted ? lowerServerToolCall(part) : lowerToolCall(part))
          continue
        }
        if (part.type === "tool-result" && part.providerExecuted) {
          content.push(yield* lowerServerToolResult(part))
          continue
        }
        return yield* invalid(
          `Anthropic Messages assistant messages only support text, reasoning, and tool-call content for now`,
        )
      }
      messages.push({
        role: "assistant",
        content: withMessageCache(content, messageCacheHint(message), breakpoints),
      })
      continue
    }

    const content: AnthropicToolResultBlock[] = []
    for (const part of message.content) {
      if (!ProviderShared.supportsContent(part, ["tool-result"]))
        return yield* ProviderShared.unsupportedContent("Anthropic Messages", "tool", ["tool-result"])
      content.push({
        type: "tool_result",
        tool_use_id: part.id,
        content: yield* lowerToolResultContent(part),
        is_error: part.result.type === "error" ? true : undefined,
        cache_control: cacheControl(breakpoints, part.cache),
      })
    }
    messages.push({ role: "user", content: withMessageCache(content, messageCacheHint(message), breakpoints) })
  }

  return messages
})

const anthropicOptions = (request: LLMRequest) => request.providerOptions?.anthropic

const lowerThinking = Effect.fn("AnthropicMessages.lowerThinking")(function* (request: LLMRequest) {
  const thinking = anthropicOptions(request)?.thinking
  if (!ProviderShared.isRecord(thinking) || thinking.type !== "enabled") return undefined
  const budget =
    typeof thinking.budgetTokens === "number"
      ? thinking.budgetTokens
      : typeof thinking.budget_tokens === "number"
        ? thinking.budget_tokens
        : undefined
  if (budget === undefined) return yield* invalid("Anthropic thinking provider option requires budgetTokens")
  return { type: "enabled" as const, budget_tokens: budget }
})

const fromRequest = Effect.fn("AnthropicMessages.fromRequest")(function* (request: LLMRequest) {
  const toolChoice = request.toolChoice ? yield* lowerToolChoice(request.toolChoice) : undefined
  const generation = request.generation
  const toolSchemaCompatibility = request.model.compatibility?.toolSchema
  const outputLimit = request.model.defaults?.limits?.output ?? request.model.route.defaults.limits?.output ?? 4096
  // Allocate the 4-breakpoint budget in invalidation order: tools → system →
  // messages. Tools live highest in the cache hierarchy, so tool hints are kept first.
  const breakpoints = Cache.newBreakpoints(ANTHROPIC_BREAKPOINT_CAP)
  const eagerInputStreaming = requestEagerInputStreaming(request)
  const tools =
    request.tools.length === 0 || request.toolChoice?.type === "none"
      ? undefined
      : request.tools.map((tool) =>
          lowerTool(
            breakpoints,
            tool,
            ToolSchemaProjection.modelCompatibility(tool.inputSchema, toolSchemaCompatibility),
            eagerInputStreaming,
          ),
        )
  const system =
    request.system.length === 0
      ? undefined
      : request.system.map((part) => ({
          type: "text" as const,
          text: part.text,
          cache_control: cacheControl(breakpoints, part.cache),
        }))
  const messages = yield* lowerMessages(request, breakpoints)
  if (breakpoints.dropped > 0) {
    yield* Effect.logWarning(
      `Anthropic Messages: dropped ${breakpoints.dropped} cache breakpoint(s); the API allows at most ${ANTHROPIC_BREAKPOINT_CAP} per request.`,
    )
  }
  const thinking = yield* lowerThinking(request)
  // With extended thinking on, the Messages API refuses `temperature`, `top_p`
  // and `top_k` (HTTP 400), and `max_tokens` must cover the thinking budget as
  // well as the visible answer. `@ai-sdk/anthropic` does the same.
  const sampling = thinking
    ? {}
    : { temperature: generation?.temperature, top_p: generation?.topP, top_k: generation?.topK }
  return {
    model: request.model.id,
    system,
    messages,
    tools,
    tool_choice: toolChoice,
    stream: true as const,
    max_tokens: (generation?.maxTokens ?? outputLimit) + (thinking?.budget_tokens ?? 0),
    ...sampling,
    stop_sequences: generation?.stop,
    thinking,
  }
})

// Stream Parsing
const mapFinishReason = (reason: string | null | undefined): FinishReason => {
  if (reason === "end_turn" || reason === "stop_sequence" || reason === "pause_turn") return "stop"
  if (reason === "max_tokens") return "length"
  if (reason === "tool_use") return "tool-calls"
  if (reason === "refusal") return "content-filter"
  return "unknown"
}

// Anthropic reports the non-overlapping breakdown natively: `input_tokens` is
// the *non-cached* count, with cache reads and writes as separate fields, summed
// here for the inclusive `inputTokens`. Thinking tokens are not broken out —
// they bill inside `output_tokens`, so `reasoningTokens` stays `undefined`.
const mapUsage = (usage: AnthropicUsage | undefined): Usage | undefined => {
  if (!usage) return undefined
  const nonCached = usage.input_tokens
  const cacheRead = usage.cache_read_input_tokens ?? undefined
  const cacheWrite = usage.cache_creation_input_tokens ?? undefined
  const inputTokens = ProviderShared.sumTokens(nonCached, cacheRead, cacheWrite)
  return new Usage({
    inputTokens,
    outputTokens: usage.output_tokens,
    nonCachedInputTokens: nonCached,
    cacheReadInputTokens: cacheRead,
    cacheWriteInputTokens: cacheWrite,
    totalTokens: ProviderShared.totalTokens(inputTokens, usage.output_tokens, undefined),
    providerMetadata: { anthropic: usage },
  })
}

// Anthropic emits usage on `message_start` and again on `message_delta`; the
// final delta is authoritative. Right-biased merge, with `inputTokens`
// recomputed from the merged breakdown to stay consistent.
const mergeUsage = (left: Usage | undefined, right: Usage | undefined) => {
  if (!left) return right
  if (!right) return left
  const nonCachedInputTokens = right.nonCachedInputTokens ?? left.nonCachedInputTokens
  const cacheReadInputTokens = right.cacheReadInputTokens ?? left.cacheReadInputTokens
  const cacheWriteInputTokens = right.cacheWriteInputTokens ?? left.cacheWriteInputTokens
  const inputTokens = ProviderShared.sumTokens(nonCachedInputTokens, cacheReadInputTokens, cacheWriteInputTokens)
  const outputTokens = right.outputTokens ?? left.outputTokens
  return new Usage({
    inputTokens,
    outputTokens,
    nonCachedInputTokens,
    cacheReadInputTokens,
    cacheWriteInputTokens,
    totalTokens: ProviderShared.totalTokens(inputTokens, outputTokens, undefined),
    providerMetadata: {
      anthropic: {
        ...left.providerMetadata?.["anthropic"],
        ...right.providerMetadata?.["anthropic"],
      },
    },
  })
}

// Server tool result blocks come whole in `content_block_start` (no streaming
// delta sequence) and convert to a `tool-result` event with
// `providerExecuted: true`; `result.value` carries the structured payload.
const SERVER_TOOL_RESULT_NAMES: Record<AnthropicServerToolResultType, string> = {
  web_search_tool_result: "web_search",
  code_execution_tool_result: "code_execution",
  web_fetch_tool_result: "web_fetch",
}

const isServerToolResultType = (type: string): type is AnthropicServerToolResultType => type in SERVER_TOOL_RESULT_NAMES

const serverToolResultEvent = (block: NonNullable<AnthropicEvent["content_block"]>): LLMEvent | undefined => {
  if (!block.type || !isServerToolResultType(block.type)) return undefined
  const errorPayload =
    typeof block.content === "object" && block.content !== null && "type" in block.content
      ? String((block.content as Record<string, unknown>).type)
      : ""
  const isError = errorPayload.endsWith("_tool_result_error")
  return LLMEvent.toolResult({
    id: block.tool_use_id ?? "",
    name: SERVER_TOOL_RESULT_NAMES[block.type],
    result: isError ? { type: "error", value: block.content } : { type: "json", value: block.content },
    providerExecuted: true,
    providerMetadata: anthropicMetadata({ blockType: block.type }),
  })
}

type StepResult = readonly [ParserState, ReadonlyArray<LLMEvent>]

const NO_EVENTS: StepResult["1"] = []

const onMessageStart = (state: ParserState, event: AnthropicEvent): StepResult => {
  const usage = mapUsage(event.message?.usage)
  return [usage ? { ...state, usage: mergeUsage(state.usage, usage) } : state, NO_EVENTS]
}

const onContentBlockStart = (state: ParserState, event: AnthropicEvent): StepResult => {
  const block = event.content_block
  if (!block) return [state, NO_EVENTS]

  if ((block.type === "tool_use" || block.type === "server_tool_use") && event.index !== undefined) {
    const events: LLMEvent[] = []
    const lifecycle = Lifecycle.stepStart(state.lifecycle, events)
    return [
      {
        ...state,
        lifecycle,
        tools: ToolStream.start(state.tools, event.index, {
          id: block.id ?? String(event.index),
          name: block.name ?? "",
          providerExecuted: block.type === "server_tool_use",
        }),
      },
      [...events, LLMEvent.toolInputStart({ id: block.id ?? String(event.index), name: block.name ?? "" })],
    ]
  }

  if (block.type === "text" && block.text) {
    const events: LLMEvent[] = []
    return [
      { ...state, lifecycle: Lifecycle.textDelta(state.lifecycle, events, `text-${event.index ?? 0}`, block.text) },
      events,
    ]
  }

  if (block.type === "thinking" && block.thinking) {
    const events: LLMEvent[] = []
    return [
      {
        ...state,
        lifecycle: Lifecycle.reasoningDelta(state.lifecycle, events, `reasoning-${event.index ?? 0}`, block.thinking),
      },
      events,
    ]
  }

  const result = serverToolResultEvent(block)
  if (!result) return [state, NO_EVENTS]
  const events: LLMEvent[] = []
  return [{ ...state, lifecycle: Lifecycle.stepStart(state.lifecycle, events) }, [...events, result]]
}

const onContentBlockDelta = Effect.fn("AnthropicMessages.onContentBlockDelta")(function* (
  state: ParserState,
  event: AnthropicEvent,
) {
  const delta = event.delta

  if (delta?.type === "text_delta" && delta.text) {
    const events: LLMEvent[] = []
    return [
      { ...state, lifecycle: Lifecycle.textDelta(state.lifecycle, events, `text-${event.index ?? 0}`, delta.text) },
      events,
    ] satisfies StepResult
  }

  if (delta?.type === "thinking_delta" && delta.thinking) {
    const events: LLMEvent[] = []
    return [
      {
        ...state,
        lifecycle: Lifecycle.reasoningDelta(state.lifecycle, events, `reasoning-${event.index ?? 0}`, delta.thinking),
      },
      events,
    ] satisfies StepResult
  }

  if (delta?.type === "signature_delta" && delta.signature) {
    const events: LLMEvent[] = []
    return [
      {
        ...state,
        lifecycle: Lifecycle.reasoningEnd(
          state.lifecycle,
          events,
          `reasoning-${event.index ?? 0}`,
          anthropicMetadata({ signature: delta.signature }),
        ),
      },
      events,
    ] satisfies StepResult
  }

  if (delta?.type === "input_json_delta" && event.index !== undefined) {
    if (!delta.partial_json) return [state, NO_EVENTS] satisfies StepResult
    const result = ToolStream.appendExisting(
      ADAPTER,
      state.tools,
      event.index,
      delta.partial_json,
      "Anthropic Messages tool argument delta is missing its tool call",
    )
    if (ToolStream.isError(result)) return yield* result
    const events: LLMEvent[] = []
    const lifecycle = result.events.length ? Lifecycle.stepStart(state.lifecycle, events) : state.lifecycle
    events.push(...result.events)
    return [{ ...state, lifecycle, tools: result.tools }, events] satisfies StepResult
  }

  return [state, NO_EVENTS] satisfies StepResult
})

const onContentBlockStop = Effect.fn("AnthropicMessages.onContentBlockStop")(function* (
  state: ParserState,
  event: AnthropicEvent,
) {
  if (event.index === undefined) return [state, NO_EVENTS] satisfies StepResult
  const result = yield* ToolStream.finish(ADAPTER, state.tools, event.index)
  const events: LLMEvent[] = []
  const resultEvents = result.events ?? []
  const lifecycle = resultEvents.length
    ? Lifecycle.stepStart(state.lifecycle, events)
    : Lifecycle.reasoningEnd(
        Lifecycle.textEnd(state.lifecycle, events, `text-${event.index}`),
        events,
        `reasoning-${event.index}`,
      )
  events.push(...resultEvents)
  return [{ ...state, lifecycle, tools: result.tools }, events] satisfies StepResult
})

const onMessageDelta = (state: ParserState, event: AnthropicEvent): StepResult => {
  const usage = mergeUsage(state.usage, mapUsage(event.usage))
  const events: LLMEvent[] = []
  const lifecycle = Lifecycle.finish(state.lifecycle, events, {
    reason: mapFinishReason(event.delta?.stop_reason),
    usage,
    providerMetadata: ProviderShared.withCopilotMetadata(
      event.delta?.stop_sequence ? anthropicMetadata({ stopSequence: event.delta.stop_sequence }) : undefined,
      ProviderShared.copilotMetadata(event.copilot_usage),
    ),
  })
  return [{ ...state, lifecycle, usage }, events]
}

// Prefix `error.type` so overloads, rate limits, and quota errors are visible
// even when the provider message is generic or empty.
const providerErrorMessage = (event: AnthropicEvent): string => {
  const type = event.error?.type
  const message = event.error?.message
  if (type && message) return `${type}: ${message}`
  return message || type || "Anthropic Messages stream error"
}

const onError = (state: ParserState, event: AnthropicEvent): StepResult => [
  state,
  [
    LLMEvent.providerError({
      message: providerErrorMessage(event),
      classification: isContextOverflow(event.error?.message ?? "") ? "context-overflow" : undefined,
    }),
  ],
]

const step = (state: ParserState, event: AnthropicEvent) => {
  if (event.type === "message_start") return Effect.succeed(onMessageStart(state, event))
  if (event.type === "content_block_start") return Effect.succeed(onContentBlockStart(state, event))
  if (event.type === "content_block_delta") return onContentBlockDelta(state, event)
  if (event.type === "content_block_stop") return onContentBlockStop(state, event)
  if (event.type === "message_delta") return Effect.succeed(onMessageDelta(state, event))
  if (event.type === "error") return Effect.succeed(onError(state, event))
  return Effect.succeed<StepResult>([state, NO_EVENTS])
}

// Protocol And Anthropic Route
/** The Anthropic Messages protocol — request body construction, body schema,
 *  and the streaming-event state machine. Used by native Anthropic Cloud and
 *  (once registered) Vertex Anthropic / Bedrock-hosted Anthropic passthrough. */
/**
 * A body that ended without `message_stop` still ends the turn.
 *
 * Same shape and reason as `openai-responses.ts` `unfinished`: a body that stops
 * before its terminal event leaves the stream with no `finish` and no `text-end`,
 * so the consumer's block never closes. "unknown" is what `@ai-sdk/anthropic`
 * reports at its flush, and `session/processor.ts` recovers from that value.
 * `stepStarted` is the exact "not yet finished" signal.
 */
const unfinished = (state: ParserState): ReadonlyArray<LLMEvent> => {
  if (!state.lifecycle.stepStarted) return []
  const events: LLMEvent[] = []
  Lifecycle.finish(state.lifecycle, events, { reason: "unknown" })
  return events
}

export const protocol = Protocol.make({
  id: ADAPTER,
  body: {
    schema: AnthropicMessagesBody,
    // `max_tokens` is NOT structure: the Messages API requires it, so the
    // protocol always writes a default, but it stays a knob a configured value
    // wins. `system`, `tools`, `tool_choice`, `thinking` are owned only when carried.
    structure: ["model", "system", "messages", "tools", "tool_choice", "stream", "thinking"],
    from: fromRequest,
  },
  stream: {
    event: Protocol.jsonEvent(AnthropicEvent),
    initial: () => ({ tools: ToolStream.empty<number>(), lifecycle: Lifecycle.initial() }),
    step,
    onHalt: unfinished,
  },
})

export const route = Route.make({
  id: ADAPTER,
  provider: "anthropic",
  protocol,
  endpoint: Endpoint.path(PATH, { baseURL: DEFAULT_BASE_URL }),
  auth: Auth.none,
  framing: Framing.sse,
  headers: () => ({ "anthropic-version": "2023-06-01" }),
})

export * as AnthropicMessages from "./anthropic-messages"
