import type { JsonSchema, LLMRequest, ProviderMetadata } from "@origami/llm"
import { CacheHint, LLM, Message, SystemPart, ToolCallPart, ToolDefinition, ToolResultPart } from "@origami/llm"
import {
  Alibaba,
  AmazonBedrock,
  Anthropic,
  Azure,
  Cerebras,
  ClaudeSubscription as ClaudeSubscriptionFacade,
  DeepInfra,
  GitHubCopilot,
  Google,
  Groq,
  Mistral,
  OpenAI,
  OpenAICompatible,
  OpenRouter,
  Perplexity,
  TogetherAI,
  V0,
  Venice,
  XAI,
} from "@origami/llm/providers"
import { Auth } from "@origami/llm/route"
import type { ModelMessage } from "ai"
import type { Provider } from "@/provider/provider"
import { isRecord } from "@/util/record"
import { LLMNativeRoute } from "./native-route"
import { ClaudeSubscription } from "@/provider/claude-subscription"

type ToolInput = {
  readonly description?: string
  readonly inputSchema?: unknown
}

export type RequestInput = {
  readonly model: Provider.Model
  readonly apiKey?: string
  readonly baseURL?: string
  readonly system?: readonly string[]
  readonly messages: readonly ModelMessage[]
  readonly tools?: Record<string, ToolInput>
  readonly toolChoice?: "auto" | "required" | "none"
  readonly temperature?: number
  readonly topP?: number
  readonly topK?: number
  readonly frequencyPenalty?: number
  readonly maxOutputTokens?: number
  readonly providerOptions?: LLMRequest["providerOptions"]
  /** Free-form body fields overlaid on the protocol body (OpenAI-compatible extras). */
  readonly http?: { readonly body: Record<string, unknown> }
  readonly headers?: Record<string, string>
}

const providerMetadata = (value: unknown): ProviderMetadata | undefined => {
  if (!isRecord(value)) return undefined
  const result = Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1])),
  )
  return Object.keys(result).length === 0 ? undefined : result
}

// Stored AI SDK parts historically kept provider-owned continuation metadata in
// `providerOptions`; native parts now use `providerMetadata` directly.
const partProviderMetadata = (part: Record<string, unknown>) =>
  providerMetadata(part.providerMetadata) ?? providerMetadata(part.providerOptions)

// `ProviderTransform.applyCaching` is the only thing that decides Anthropic
// cache breakpoints on the AI SDK path: it stamps
// `providerOptions.anthropic.cacheControl` on the first two system messages and
// the last two non-system messages (message-level for anthropic-family provider
// ids, content-part-level otherwise), and never on tools. Translate those markers
// here so the native path places the same breakpoints, and pin `cache: "none"` on
// the request so the AUTO shape does not add any the engine did not ask for.
const cacheHint = (options: unknown): CacheHint | undefined => {
  if (!isRecord(options)) return undefined
  const anthropic = options.anthropic
  if (!isRecord(anthropic)) return undefined
  const control = anthropic.cacheControl ?? anthropic.cache_control
  if (!isRecord(control) || control.type !== "ephemeral") return undefined
  return control.ttl === "1h"
    ? new CacheHint({ type: "ephemeral", ttlSeconds: 3600 })
    : new CacheHint({ type: "ephemeral" })
}

const textPart = (part: Record<string, unknown>) => ({
  type: "text" as const,
  text: typeof part.text === "string" ? part.text : "",
  cache: cacheHint(part.providerOptions),
  providerMetadata: partProviderMetadata(part),
})

const mediaPart = (part: Record<string, unknown>) => {
  if (typeof part.data !== "string" && !(part.data instanceof Uint8Array))
    throw new Error("Native LLM request adapter only supports file parts with string or Uint8Array data")
  return {
    type: "media" as const,
    mediaType: typeof part.mediaType === "string" ? part.mediaType : "application/octet-stream",
    data: part.data,
    filename: typeof part.filename === "string" ? part.filename : undefined,
  }
}

const toolResult = (part: Record<string, unknown>) => {
  const output = isRecord(part.output) ? part.output : { type: "json", value: part.output }
  const type = output.type === "text" ? "text" : output.type === "error-text" ? "error" : "json"
  return ToolResultPart.make({
    id: typeof part.toolCallId === "string" ? part.toolCallId : "",
    name: typeof part.toolName === "string" ? part.toolName : "",
    result: "value" in output ? output.value : output,
    resultType: type,
    providerExecuted: typeof part.providerExecuted === "boolean" ? part.providerExecuted : undefined,
    cache: cacheHint(part.providerOptions),
    providerMetadata: partProviderMetadata(part),
  })
}

const contentPart = (part: unknown) => {
  if (!isRecord(part)) throw new Error("Native LLM request adapter only supports object content parts")
  if (part.type === "text") return textPart(part)
  if (part.type === "file") return mediaPart(part)
  if (part.type === "reasoning")
    return {
      type: "reasoning" as const,
      text: typeof part.text === "string" ? part.text : "",
      providerMetadata: partProviderMetadata(part),
    }
  if (part.type === "tool-call")
    return ToolCallPart.make({
      id: typeof part.toolCallId === "string" ? part.toolCallId : "",
      name: typeof part.toolName === "string" ? part.toolName : "",
      input: part.input,
      providerExecuted: typeof part.providerExecuted === "boolean" ? part.providerExecuted : undefined,
      providerMetadata: partProviderMetadata(part),
    })
  if (part.type === "tool-result") return toolResult(part)
  throw new Error(`Native LLM request adapter does not support ${String(part.type)} content parts`)
}

const content = (value: ModelMessage["content"]) =>
  typeof value === "string" ? [{ type: "text" as const, text: value }] : value.map(contentPart)

// `ProviderTransform.message` moves an OpenAI-compatible assistant turn's
// reasoning out of its content parts into `providerOptions.openaiCompatible`,
// which is where `@ai-sdk/openai-compatible` reads it back onto the wire; the
// native OpenAI Chat lowering reads the same record from
// `native.openaiCompatible`. `anthropic` is surfaced for the same reason:
// `anthropic-messages` reads `native.anthropic.cacheControl` and puts
// `cache_control` on the message's last wire block, which covers the blocks the
// canonical schema cannot hint directly (`tool_use` has no `cache` field).
const native = (message: ModelMessage) => {
  if (!isRecord(message.providerOptions)) return undefined
  const compatible = message.providerOptions.openaiCompatible
  const anthropic = message.providerOptions.anthropic
  return {
    providerOptions: message.providerOptions,
    ...(isRecord(compatible) ? { openaiCompatible: compatible } : {}),
    ...(isRecord(anthropic) ? { anthropic } : {}),
  }
}

const systemPart = (message: ModelMessage & { readonly role: "system" }) => {
  const part = SystemPart.make(message.content)
  const cache = cacheHint(message.providerOptions)
  return cache ? { ...part, cache } : part
}

const messages = (input: readonly ModelMessage[]) => {
  const system = input.flatMap((message) => (message.role === "system" ? [systemPart(message)] : []))
  const messages = input.flatMap((message) => {
    if (message.role === "system") return []
    return [
      Message.make({
        role: message.role,
        content: content(message.content),
        native: native(message),
      }),
    ]
  })
  return { system, messages }
}

const schema = (value: unknown): JsonSchema => {
  if (!isRecord(value)) return { type: "object", properties: {} }
  if (isRecord(value.jsonSchema)) return value.jsonSchema
  return value
}

const tools = (input: Record<string, ToolInput> | undefined): ToolDefinition[] =>
  Object.entries(input ?? {}).map(([name, item]) =>
    ToolDefinition.make({
      name,
      description: item.description ?? "",
      inputSchema: schema(item.inputSchema),
    }),
  )

const generation = (input: RequestInput) => {
  const result = {
    temperature: input.temperature,
    topP: input.topP,
    topK: input.topK,
    frequencyPenalty: input.frequencyPenalty,
    maxTokens: input.maxOutputTokens,
  }
  return Object.values(result).some((value) => value !== undefined) ? result : undefined
}

const baseURL = (input: Provider.Model | RequestInput) =>
  "model" in input ? (input.baseURL ?? (input.model.api.url || undefined)) : input.api.url || undefined

/**
 * The endpoint GitHub said this Copilot model serves, when it said one.
 *
 * `plugin/github-copilot/models.ts` writes `api.endpoint` from `/models`; it is
 * not on the `Model` schema, and the AI SDK path reads it the same untyped way.
 * `messages` never reaches here — those rows are declared `@ai-sdk/anthropic`.
 */
const copilotEndpoint = (model: Provider.Model): "chat" | "responses" | undefined => {
  const value = (model.api as { readonly endpoint?: unknown }).endpoint
  return value === "chat" || value === "responses" ? value : undefined
}

const requireBaseURL = (model: Provider.Model, url: string | undefined) => {
  if (url) return url
  throw new Error(`Native LLM request adapter requires a base URL for ${model.providerID}/${model.id}`)
}

export const model = (input: Provider.Model | RequestInput, headers?: Record<string, string>) => {
  const model = "model" in input ? input.model : input
  const url = baseURL(input)
  const options = {
    apiKey: "model" in input && input.apiKey ? input.apiKey : undefined,
    ...(url ? { baseURL: url } : {}),
    headers: Object.keys({ ...model.headers, ...headers }).length === 0 ? undefined : { ...model.headers, ...headers },
    limits: {
      context: model.limit.context,
      output: model.limit.output,
    },
  }
  if (model.api.npm === ClaudeSubscription.NPM) {
    // The CLI holds the credential: no key, no base URL, no headers reach it.
    // Gate B (native-runtime `statusWithFetch`) already refused an unready CLI.
    const ready = ClaudeSubscription.readiness()
    if (ready.type !== "ready") throw new Error(ready.reason)
    return ClaudeSubscriptionFacade.configure({ command: ready.command, limits: options.limits }).model(model.api.id)
  }
  if (model.api.npm === "@ai-sdk/openai") return OpenAI.configure(options).responses(model.api.id)
  // The AI SDK path builds xAI models with `sdk.responses(id)` (provider.ts
  // `custom().xai`), so native takes the Responses route too, not the Chat one
  // the facade also exposes. An unset baseURL falls back to https://api.x.ai/v1.
  if (model.api.npm === "@ai-sdk/xai") return XAI.configure(options).responses(model.api.id)
  if (model.api.npm === "@ai-sdk/azure")
    return Azure.configure({ ...options, baseURL: requireBaseURL(model, url) }).responses(model.api.id)
  // GitHub Copilot's Claude rows: `@ai-sdk/anthropic` pointed at Copilot's
  // `/v1/messages` shim. Copilot stores no api key, and the Anthropic route's
  // default auth would fail the request on the missing key before the plugin's
  // signing fetch is ever called. `Auth.none` lets the signer be the credential.
  if (model.api.npm === "@ai-sdk/anthropic" && LLMNativeRoute.isCopilotProvider(model) && !options.apiKey) {
    const { apiKey: _unused, ...rest } = options
    return Anthropic.configure({ ...rest, auth: Auth.none }).model(model.api.id)
  }
  if (model.api.npm === "@ai-sdk/anthropic") return Anthropic.configure(options).model(model.api.id)
  if (model.api.npm === "@ai-sdk/google") return Google.configure(options).model(model.api.id)
  if (model.api.npm === "@ai-sdk/amazon-bedrock") return AmazonBedrock.configure(options).model(model.api.id)
  if (model.api.npm === "@ai-sdk/openai-compatible") {
    const { apiKey, ...rest } = options
    const compatible = { ...rest, provider: String(model.providerID), baseURL: requireBaseURL(model, url) }
    // A keyless local endpoint gets NO Authorization header, matching the AI
    // SDK path; the facade's default would fail the request on a missing key.
    const facade = apiKey
      ? OpenAICompatible.configure({ ...compatible, apiKey })
      : OpenAICompatible.configure({ ...compatible, auth: Auth.none })
    return facade.model(model.api.id)
  }
  if (model.api.npm === "@ai-sdk/github-copilot") {
    const { apiKey, ...rest } = options
    // Copilot's OAuth loader stores no key; the plugin's signing fetch sets
    // `Authorization` on every call, so `Auth.none` lets the request be built
    // without one. A configured key (a PAT-style setup) is still honoured.
    const copilot = {
      ...rest,
      baseURL: requireBaseURL(model, url),
      // Absent an endpoint from `models.ts`, the facade falls back to the same
      // gpt-5 rule the AI SDK path uses.
      ...(copilotEndpoint(model) ? { endpoint: copilotEndpoint(model) } : {}),
    }
    const facade = apiKey
      ? GitHubCopilot.configure({ ...copilot, apiKey })
      : GitHubCopilot.configure({ ...copilot, auth: Auth.none })
    return facade.model(model.api.id)
  }
  if (model.api.npm === "@openrouter/ai-sdk-provider") return OpenRouter.configure(options).model(model.api.id)
  // The small-provider facades are all an OpenAI Chat Completions dialect, so
  // each takes the same options object with no apiKey/auth stripping — every one
  // of them takes an optional apiKey.
  if (model.api.npm === "@ai-sdk/mistral") return Mistral.configure(options).model(model.api.id)
  if (model.api.npm === "@ai-sdk/groq") return Groq.configure(options).model(model.api.id)
  if (model.api.npm === "@ai-sdk/cerebras") return Cerebras.configure(options).model(model.api.id)
  if (model.api.npm === "@ai-sdk/deepinfra") return DeepInfra.configure(options).model(model.api.id)
  if (model.api.npm === "@ai-sdk/togetherai") return TogetherAI.configure(options).model(model.api.id)
  if (model.api.npm === "@ai-sdk/perplexity") return Perplexity.configure(options).model(model.api.id)
  if (model.api.npm === "@ai-sdk/alibaba") return Alibaba.configure(options).model(model.api.id)
  if (model.api.npm === "venice-ai-sdk-provider") return Venice.configure(options).model(model.api.id)
  if (model.api.npm === "@ai-sdk/vercel") return V0.configure(options).model(model.api.id)
  throw new Error(`Native LLM request adapter does not support provider package ${model.api.npm}`)
}

export const request = (input: RequestInput) => {
  const converted = messages(input.messages)
  // This is the only native adapter boundary that should construct canonical
  // @origami/llm request objects from origami's session/AI SDK-shaped data.
  return LLM.request({
    model: model(input, input.headers),
    system: [...(input.system ?? []).map(SystemPart.make), ...converted.system],
    messages: converted.messages,
    tools: tools(input.tools),
    toolChoice: input.toolChoice,
    generation: generation(input),
    // The engine already placed every breakpoint above; AUTO would add a third
    // set (last tool + last system + latest user message) the AI SDK never sends.
    cache: "none",
    providerOptions: input.providerOptions,
    http: input.http,
  })
}

export * as LLMNative from "./native-request"
