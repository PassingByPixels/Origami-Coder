import { Effect, Schema } from "effect"
import { Route, type RouteDefaultsInput } from "../route/client"
import { Endpoint } from "../route/endpoint"
import { Framing } from "../route/framing"
import { Protocol } from "../route/protocol"
import { AuthOptions, type ProviderAuthOption } from "../route/auth-options"
import { LLMEvent, ProviderID, type ContentPart, type LLMRequest, type ModelID, type ProviderOptions } from "../schema"
import * as OpenAICompatibleProfiles from "./openai-compatible-profile"
import * as OpenAIChat from "../protocols/openai-chat"
import { isRecord } from "../protocols/shared"

export const profile = OpenAICompatibleProfiles.profiles.openrouter
export const id = ProviderID.make(profile.provider)
const ADAPTER = "openrouter"

export interface OpenRouterOptions {
  readonly [key: string]: unknown
  readonly usage?: boolean | Record<string, unknown>
  readonly reasoning?: Record<string, unknown>
  readonly promptCacheKey?: string
}

export type OpenRouterProviderOptionsInput = ProviderOptions & {
  readonly openrouter?: OpenRouterOptions
}

export type ModelOptions = Omit<RouteDefaultsInput, "providerOptions"> &
  ProviderAuthOption<"optional"> & {
    readonly baseURL?: string
    readonly providerOptions?: OpenRouterProviderOptionsInput
  }

// =============================================================================
// Reasoning Details
// =============================================================================
// OpenRouter carries reasoning TWICE: as the plain `reasoning` string and as
// `reasoning_details`, a list of provider-shaped entries. The list is the half
// a later turn has to replay - `@openrouter/ai-sdk-provider` sends it back on
// the assistant message and drops the plain string when it has no list to go
// with it. So the stream accumulates the entries and hands them to the
// consumer on `reasoning-end`, and the request lowering reads them back off
// the stored reasoning part. Everything in this section mirrors that package
// (`dist/index.mjs`: `convertToOpenRouterChatMessages` and the chat
// `doStream` transform); the shapes are the provider's, not ours.

/** One `reasoning_details` entry. Provider-shaped, so read field by field. */
type ReasoningDetail = Record<string, unknown>

const TEXT_DETAIL = "reasoning.text"
const SUMMARY_DETAIL = "reasoning.summary"
const ENCRYPTED_DETAIL = "reasoning.encrypted"
/** Formats whose text entry means nothing without the signature that signs it. */
const SIGNED_FORMATS = new Set(["anthropic-claude-v1", "google-gemini-v1"])
const DEFAULT_FORMAT = "anthropic-claude-v1"

const text = (value: unknown) => (typeof value === "string" ? value : undefined)

const detailList = (value: unknown): ReadonlyArray<ReasoningDetail> =>
  Array.isArray(value) ? value.filter(isRecord) : []

/** The `reasoning_details` this stream event carries, if any. */
const eventDetails = (event: unknown): ReadonlyArray<ReasoningDetail> => {
  if (!isRecord(event)) return []
  const choices = event["choices"]
  const choice = Array.isArray(choices) ? choices[0] : undefined
  if (!isRecord(choice) || !isRecord(choice["delta"])) return []
  return detailList(choice["delta"]["reasoning_details"])
}

/**
 * Fold one delta's entries into the accumulated list. Consecutive
 * `reasoning.text` entries MERGE into the one already at the tail - that is
 * how a turn streamed one word per frame becomes the single entry a replay
 * sends back - and the first entry's `format` and `index` survive the merge.
 * Any other entry type is appended whole.
 */
const accumulate = (
  accumulated: ReadonlyArray<ReasoningDetail>,
  incoming: ReadonlyArray<ReasoningDetail>,
): ReadonlyArray<ReasoningDetail> => {
  const out = [...accumulated]
  for (const detail of incoming) {
    const last = out.at(-1)
    if (detail["type"] === TEXT_DETAIL && last?.["type"] === TEXT_DETAIL) {
      out[out.length - 1] = {
        ...last,
        text: `${text(last["text"]) ?? ""}${text(detail["text"]) ?? ""}`,
        signature: text(last["signature"]) || text(detail["signature"]),
        format: text(last["format"]) || text(detail["format"]),
      }
      continue
    }
    out.push({ ...detail })
  }
  return out
}

/**
 * The first non-empty `reasoning_details` stored on this assistant turn.
 * Tool-call parts are searched BEFORE reasoning parts, the order
 * `findFirstReasoningDetails` uses, so a turn whose reasoning was attached to
 * the call it produced replays from there.
 */
const storedDetails = (content: ReadonlyArray<ContentPart>): ReadonlyArray<ReasoningDetail> | undefined => {
  for (const type of ["tool-call", "reasoning"] as const)
    for (const part of content) {
      if (part.type !== type) continue
      const openrouter = part.providerMetadata?.["openrouter"]
      const found = isRecord(openrouter) ? detailList(openrouter["reasoning_details"]) : []
      if (found.length > 0) return found
    }
  return undefined
}

/**
 * A text entry in a format that is only meaningful WITH its signature, and
 * without one, is dropped rather than sent: OpenRouter refuses the turn it
 * belongs to.
 */
const isReplayable = (detail: ReasoningDetail) => {
  if (detail["type"] !== TEXT_DETAIL) return true
  if (!SIGNED_FORMATS.has(text(detail["format"]) ?? DEFAULT_FORMAT)) return true
  return Boolean(text(detail["signature"]))
}

/** What makes two entries the same entry. An entry with no key is not replayable. */
const detailKey = (detail: ReasoningDetail): string | undefined => {
  if (detail["type"] === SUMMARY_DETAIL) return text(detail["summary"])
  if (detail["type"] === ENCRYPTED_DETAIL) return text(detail["id"]) ?? text(detail["data"])
  if (detail["type"] === TEXT_DETAIL) return text(detail["text"]) || text(detail["signature"])
  return undefined
}

/**
 * Drop entries this PROMPT has already sent. A multi-step tool loop stores the
 * same reasoning on every assistant turn it replays, and sending it twice
 * makes the model read its own thinking twice.
 */
const deduplicate = (seen: Set<string>, list: ReadonlyArray<ReasoningDetail>) => {
  const out: ReasoningDetail[] = []
  for (const detail of list) {
    const key = detailKey(detail)
    if (key === undefined || seen.has(key)) continue
    seen.add(key)
    out.push(detail)
  }
  return out
}

// =============================================================================
// Request Lowering
// =============================================================================
// The body is `OpenAIChat.protocol.body.from` plus the OpenRouter DIALECT: the
// same fields, in the shapes only OpenRouter's own package sends. Each rewrite
// below is one measured difference against `@openrouter/ai-sdk-provider`.
type ChatMessages = OpenAIChat.OpenAIChatBody["messages"]

const systemMessage = (message: Extract<ChatMessages[number], { readonly role: "system" }>) => ({
  // OpenRouter's own package always sends the system prompt as a text-part
  // ARRAY, because that is the only shape its cache-control marker can ride.
  ...message,
  content: [{ type: "text" as const, text: message.content }],
})

const assistantMessage = (
  message: Extract<ChatMessages[number], { readonly role: "assistant" }>,
  source: LLMRequest["messages"][number] | undefined,
  seen: Set<string>,
) => {
  // `reasoning_content` is the DeepSeek-style field the shared OpenAI Chat
  // lowering writes; OpenRouter reads `reasoning` + `reasoning_details`.
  const { reasoning_content: _content, reasoning: _reasoning, ...rest } = message
  const candidate = source ? storedDetails(source.content) : undefined
  const replayed = candidate ? deduplicate(seen, candidate.filter(isReplayable)) : undefined
  const reasoning = (source?.content ?? [])
    .filter((part) => part.type === "reasoning")
    .map((part) => part.text)
    .join("")
  return {
    ...rest,
    // The plain string only travels WITH the entries it summarises, exactly as
    // `@openrouter/ai-sdk-provider` sends it: on its own it is prose the model
    // cannot attribute to a step, and OpenRouter ignores it.
    ...(reasoning && replayed && replayed.length > 0 ? { reasoning } : {}),
    ...(replayed ? { reasoning_details: replayed } : {}),
  }
}

const lowerMessages = (request: LLMRequest, messages: ChatMessages) => {
  const names = new Map<string, string>()
  for (const message of request.messages)
    for (const part of message.content) if (part.type === "tool-result") names.set(part.id, part.name)
  // Assistant turns lower one-for-one (`lowerAssistantMessage` returns exactly
  // one message), so walking both lists in order pairs each wire message with
  // the request message it was built from.
  const assistants = request.messages.filter((message) => message.role === "assistant")
  const seen = new Set<string>()
  let next = 0
  return messages.map((message) => {
    if (message.role === "system") return systemMessage(message)
    // OpenRouter names the tool on the RESULT as well as on the call.
    if (message.role === "tool") {
      const name = names.get(message.tool_call_id)
      return name === undefined ? message : { ...message, name }
    }
    if (message.role !== "assistant") return message
    return assistantMessage(message, assistants[next++], seen)
  })
}

/**
 * The OpenRouter dialect message. It is every OpenAI Chat message shape PLUS
 * fields that union cannot express - text parts on a system message,
 * `reasoning` and `reasoning_details` on an assistant one, `name` on a tool
 * result - so the schema keeps what every message must have, a role, and lets
 * the rest ride. The structure underneath is still built, and still owned, by
 * `OpenAIChat.protocol.body.from`.
 */
const OpenRouterMessage = Schema.StructWithRest(Schema.Struct({ role: Schema.String }), [
  Schema.Record(Schema.String, Schema.Any),
])

const OpenRouterBody = Schema.StructWithRest(
  Schema.Struct({ ...OpenAIChat.bodyFields, messages: Schema.Array(OpenRouterMessage) }),
  [Schema.Record(Schema.String, Schema.Any)],
)
export type OpenRouterBody = Schema.Schema.Type<typeof OpenRouterBody>

const bodyOptions = (input: unknown) => {
  const openrouter = isRecord(input) ? input : {}
  return {
    ...(openrouter["usage"] === true
      ? { usage: { include: true } }
      : isRecord(openrouter["usage"])
        ? { usage: openrouter["usage"] }
        : {}),
    ...(isRecord(openrouter["reasoning"]) ? { reasoning: openrouter["reasoning"] } : {}),
    ...(typeof openrouter["promptCacheKey"] === "string" ? { prompt_cache_key: openrouter["promptCacheKey"] } : {}),
  }
}

const fromRequest = (request: LLMRequest) =>
  OpenAIChat.protocol.body.from(request).pipe(
    Effect.map((body) => {
      // `stream_options` is dropped, not renamed: OpenRouter reports usage on
      // the `usage` extra instead (`ProviderTransform.options` sets
      // `usage: { include: true }` for every `@openrouter/ai-sdk-provider`
      // model), and its own package sends `stream_options` only in the strict
      // OpenAI compatibility mode the engine never selects.
      const { stream_options: _usage, ...rest } = body
      return {
        ...rest,
        messages: lowerMessages(request, body.messages),
        ...bodyOptions(request.providerOptions?.["openrouter"]),
      } as OpenRouterBody
    }),
  )

// =============================================================================
// Stream Parsing
// =============================================================================
// The OpenAI Chat state machine reads the stream; this layer adds the two
// things OpenRouter's own reader does differently.
type InnerStep = typeof OpenAIChat.protocol.stream.step
type InnerState = Parameters<InnerStep>[0]
type InnerEvent = Parameters<InnerStep>[1]

/**
 * Content blocks are numbered PER RESPONSE. The OpenAI Chat machine names its
 * text and reasoning blocks with one constant each, so the two turns of a tool
 * loop hand the consumer the same block id twice; `@openrouter/ai-sdk-provider`
 * mints a fresh id on every response (`generateId()` for reasoning, the
 * response id for text) and a consumer that keys blocks across turns would
 * otherwise merge them.
 */
let responses = 0
const BLOCK_EVENTS = new Set([
  "reasoning-start",
  "reasoning-delta",
  "reasoning-end",
  "text-start",
  "text-delta",
  "text-end",
])

const inResponse = (event: LLMEvent, response: number): LLMEvent =>
  BLOCK_EVENTS.has(event.type)
    ? ({ ...event, id: `${(event as { readonly id: string }).id}-${response}` } as LLMEvent)
    : event

interface StreamState {
  readonly inner: InnerState
  readonly response: number
  readonly details: ReadonlyArray<ReasoningDetail>
  /**
   * A `reasoning-end` held back because the frame that triggered it opened a
   * TOOL CALL. `@openrouter/ai-sdk-provider` ends reasoning on content or at
   * the end of the stream and never on a tool delta, so the event travels
   * after the call it would otherwise have preceded.
   */
  readonly deferredReasoningEnd: LLMEvent | undefined
}

const isText = (event: LLMEvent) => event.type === "text-start" || event.type === "text-delta"

const step = (state: StreamState, event: InnerEvent) =>
  Effect.gen(function* () {
    const details = accumulate(state.details, eventDetails(event))
    const [inner, produced] = yield* OpenAIChat.protocol.stream.step(state.inner, event)
    // Held back only when the frame opened a tool call and carried no text: a
    // frame whose CONTENT ended reasoning ends it in place, as both readers do.
    const defer = produced.some((item) => item.type === "tool-input-start") && !produced.some(isText)
    const events: LLMEvent[] = []
    let deferred = state.deferredReasoningEnd
    for (const produce of produced) {
      const item = inResponse(produce, state.response)
      if (item.type === "reasoning-end") {
        // The entries the consumer replays on the next turn ride the END of
        // the block, where the whole list is known.
        const ended = LLMEvent.reasoningEnd({
          id: item.id,
          providerMetadata: { openrouter: { reasoning_details: details } },
        })
        if (defer) deferred = ended
        else events.push(ended)
        continue
      }
      // Text after a tool call closes reasoning first, before the text opens.
      if (deferred && item.type === "text-start") {
        events.push(deferred)
        deferred = undefined
      }
      events.push(item)
    }
    return [{ inner, response: state.response, details, deferredReasoningEnd: deferred }, events] as const
  })

const onHalt = (state: StreamState): ReadonlyArray<LLMEvent> => {
  const events = (OpenAIChat.protocol.stream.onHalt?.(state.inner) ?? []).map((event) =>
    inResponse(event, state.response),
  )
  return state.deferredReasoningEnd ? [state.deferredReasoningEnd, ...events] : events
}

export const protocol = Protocol.make({
  id: "openrouter-chat",
  body: {
    schema: OpenRouterBody,
    // The OpenRouter extras (`usage`, `reasoning`, `prompt_cache_key`, ...)
    // ride the open rest field; only the OpenAI Chat structure underneath is
    // owned.
    structure: OpenAIChat.protocol.body.structure,
    from: fromRequest,
  },
  stream: {
    event: OpenAIChat.protocol.stream.event,
    initial: (request) => ({
      inner: OpenAIChat.protocol.stream.initial(request),
      response: responses++,
      details: [],
      deferredReasoningEnd: undefined,
    }),
    step,
    onHalt,
  },
})

export const route = Route.make({
  id: ADAPTER,
  provider: profile.provider,
  protocol,
  endpoint: Endpoint.path("/chat/completions", { baseURL: profile.baseURL }),
  framing: Framing.sse,
})

export const routes = [route]

const configuredRoute = (input: ModelOptions) => {
  const { apiKey: _, auth: _auth, baseURL, ...rest } = input
  return route.with({
    ...rest,
    endpoint: { baseURL: baseURL ?? profile.baseURL },
    auth: AuthOptions.bearer(input, "OPENROUTER_API_KEY"),
  })
}

export const configure = (input: ModelOptions = {}) => {
  const route = configuredRoute(input)
  return {
    id,
    model: (modelID: string | ModelID) => route.model({ id: modelID }),
    configure,
  }
}

export const provider = configure()
export const model = provider.model
