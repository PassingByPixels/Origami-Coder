import { Effect } from "effect"
import { AuthOptions, type ProviderAuthOption } from "../route/auth-options"
import { Auth } from "../route/auth"
import { Route, type RouteDefaultsInput } from "../route/client"
import { Endpoint } from "../route/endpoint"
import { Protocol } from "../route/protocol"
import { ProviderID, type LLMRequest, type ModelID, type ProviderOptions } from "../schema"
import * as OpenAIChat from "../protocols/openai-chat"
import * as OpenAIResponses from "../protocols/openai-responses"

export const id = ProviderID.make("github-copilot")

// GitHub Copilot has no canonical public URL — callers (origami, etc.) must
// supply `baseURL` explicitly.
export type ModelOptions = Omit<RouteDefaultsInput, "providerOptions"> &
  ProviderAuthOption<"optional"> & {
    readonly baseURL: string
    readonly endpoint?: "chat" | "responses"
    readonly providerOptions?: ProviderOptions
  }

export const shouldUseResponsesApi = (modelID: string | ModelID, endpoint?: ModelOptions["endpoint"]) => {
  if (endpoint) return endpoint === "responses"
  const model = String(modelID)
  const match = /^gpt-(\d+)/.exec(model)
  if (!match) return false
  return Number(match[1]) >= 5 && !model.startsWith("gpt-5-mini")
}

// =============================================================================
// Chat Dialect
// =============================================================================
// Copilot's `/chat/completions` is OpenAI Chat with two subtractions, both
// measured against the vendored provider the AI SDK path uses
// (`@origami/core` `github-copilot/chat/openai-compatible-chat-language-model.ts`):
//
//   `stream_options` — sent only in the strict compatibility mode
//     (`config.includeUsage`, chat model line 313) that `copilot-provider.ts`
//     never turns on. Copilot reports usage on the final frame regardless.
//   `store` — the model reads exactly four keys off the provider options
//     (`user`, `reasoningEffort`, `textVerbosity`, `thinking_budget`;
//     `openai-compatible-chat-options.ts`) and spreads the REST only from its
//     own `github-copilot` namespace, which the engine leaves empty. The
//     engine's `store: false` lives under `copilot`, so it never reaches the
//     wire on this endpoint.
//
// plus one rewrite: an assistant turn with tool calls and no text goes out as
// `content: null` (`convert-to-openai-compatible-chat-messages.ts` line 113,
// `text || null`), where the shared OpenAI Chat lowering sends `""`.
type ChatMessage = OpenAIChat.OpenAIChatBody["messages"][number]

const chatMessage = (message: ChatMessage): ChatMessage =>
  message.role === "assistant" && message.content === "" ? { ...message, content: null } : message

const chatBody = (request: LLMRequest) =>
  OpenAIChat.protocol.body.from(request).pipe(
    Effect.map((body) => {
      const { stream_options: _usage, store: _store, ...rest } = body
      return { ...rest, messages: body.messages.map(chatMessage) }
    }),
  )

const chatProtocol = Protocol.make({
  id: "copilot-chat",
  body: {
    schema: OpenAIChat.protocol.body.schema,
    structure: OpenAIChat.protocol.body.structure,
    from: chatBody,
  },
  // The response side is plain OpenAI Chat: the vendored model reads the same
  // frames, and the Copilot-only `copilot_usage` extra is already handled by
  // the shared parser.
  stream: OpenAIChat.protocol.stream,
})

const chatRoute = Route.make({
  id: "copilot-chat",
  provider: id,
  protocol: chatProtocol,
  endpoint: Endpoint.path(OpenAIChat.PATH, { baseURL: OpenAIChat.DEFAULT_BASE_URL }),
  auth: Auth.none,
  transport: OpenAIChat.httpTransport,
})

// =============================================================================
// Responses Dialect
// =============================================================================
// Copilot's `/responses` RE-ENCRYPTS the item id on every frame: the same
// output item arrives as a different `item_id` in `output_item.added`, in each
// `output_text.delta`, and again in `output_item.done`. The shared OpenAI
// Responses parser keys every block by that id, so verbatim it opens one text
// block per delta, never closes the reasoning block it opened, and fails a
// tool loop outright ("tool argument delta is missing its tool call").
//
// `output_index` is the field that IS stable, and it is what the vendored
// provider keys on (`github-copilot/responses/openai-responses-language-model.ts`
// line 836: "Track reasoning by output_index instead of item_id — GitHub
// Copilot rotates encrypted item IDs on every event"). So every event is
// rewritten to the id its `output_item.added` carried before the shared parser
// sees it; the parser is unchanged.
//
// The request side subtracts one item class. The shared lowering replays an
// id-less reasoning item for its encrypted state alone, because that is what
// `@ai-sdk/openai` does; the Copilot converter needs the item id and drops the
// part when it has none ("Non-OpenAI reasoning parts are not supported.
// Skipping reasoning part", `convert-to-openai-responses-input.ts` line 240),
// and the engine strips that id on every unstored turn. Copilot therefore sees
// no reasoning item at all on a replayed turn. Sending one may well be the
// better request — it is the state a stateless turn would otherwise lose — but
// it is not the request the AI SDK path makes, so the dialect matches it.
type ResponsesInput = OpenAIResponses.OpenAIResponsesBody["input"][number]

const isIdlessReasoning = (item: ResponsesInput) => "type" in item && item.type === "reasoning" && item.id === undefined

const responsesBody = (request: LLMRequest) =>
  OpenAIResponses.protocol.body
    .from(request)
    .pipe(Effect.map((body) => ({ ...body, input: body.input.filter((item) => !isIdlessReasoning(item)) })))

type ResponsesStep = typeof OpenAIResponses.protocol.stream.step
type ResponsesInnerState = Parameters<ResponsesStep>[0]
type ResponsesEvent = Parameters<ResponsesStep>[1]

interface ResponsesState {
  readonly inner: ResponsesInnerState
  /** The `output_item.added` id for each output index — the id the whole item keeps. */
  readonly items: Readonly<Record<number, string>>
}

const canonical = (state: ResponsesState, event: ResponsesEvent): readonly [ResponsesState, ResponsesEvent] => {
  const index = event.output_index
  if (index === undefined) return [state, event]
  if (event.type === "response.output_item.added") {
    const added = event.item?.id
    return added === undefined ? [state, event] : [{ ...state, items: { ...state.items, [index]: added } }, event]
  }
  const item = state.items[index]
  if (item === undefined) return [state, event]
  return [
    state,
    {
      ...event,
      ...(event.item_id === undefined ? {} : { item_id: item }),
      // Only the item's own id rotates. `call_id` is the stable tool-call id
      // the consumer and the next request both use, so it is left alone.
      ...(event.item === undefined ? {} : { item: { ...event.item, id: item } }),
    },
  ]
}

const responsesProtocol = Protocol.make({
  id: "copilot-responses",
  body: {
    schema: OpenAIResponses.protocol.body.schema,
    structure: OpenAIResponses.protocol.body.structure,
    from: responsesBody,
  },
  stream: {
    event: OpenAIResponses.protocol.stream.event,
    initial: (request: LLMRequest): ResponsesState => ({
      inner: OpenAIResponses.protocol.stream.initial(request),
      items: {},
    }),
    step: (state: ResponsesState, event: ResponsesEvent) =>
      Effect.gen(function* () {
        const [next, rewritten] = canonical(state, event)
        const [inner, events] = yield* OpenAIResponses.protocol.stream.step(next.inner, rewritten)
        return [{ ...next, inner }, events] as const
      }),
    terminal: OpenAIResponses.protocol.stream.terminal,
    onHalt: (state: ResponsesState) => OpenAIResponses.protocol.stream.onHalt?.(state.inner) ?? [],
  },
})

const responsesRoute = Route.make({
  id: "copilot-responses",
  provider: id,
  protocol: responsesProtocol,
  endpoint: Endpoint.path(OpenAIResponses.PATH, { baseURL: OpenAIResponses.DEFAULT_BASE_URL }),
  auth: Auth.none,
  transport: OpenAIResponses.httpTransport,
  defaults: { providerOptions: { openai: { store: false } } },
})

export const routes = [responsesRoute, chatRoute]

const defaults = (options: ModelOptions) => {
  const { apiKey: _, auth: _auth, baseURL: _baseURL, endpoint: _endpoint, ...rest } = options
  return rest
}

const configuredResponsesRoute = (options: ModelOptions) =>
  responsesRoute.with({
    ...defaults(options),
    endpoint: { baseURL: options.baseURL },
    auth: AuthOptions.bearer(options, []),
  })

const configuredChatRoute = (options: ModelOptions) =>
  chatRoute.with({
    ...defaults(options),
    endpoint: { baseURL: options.baseURL },
    auth: AuthOptions.bearer(options, []),
  })

export const configure = (options: ModelOptions) => {
  const responsesRoute = configuredResponsesRoute(options)
  const chatRoute = configuredChatRoute(options)
  // No facade-side OpenAI defaults. The vendored provider injects none of its
  // own — `store`, `reasoning`, `text.verbosity` and `include` all come from
  // the caller's provider options — so adding them here would put fields on
  // the wire the AI SDK path never sends (`include:
  // ["reasoning.encrypted_content"]` was exactly that).
  const responses = (modelID: string | ModelID) => responsesRoute.model({ id: modelID })
  const chat = (modelID: string | ModelID) => chatRoute.model({ id: modelID })
  return {
    id,
    model: (modelID: string | ModelID) =>
      shouldUseResponsesApi(modelID, options.endpoint) ? responses(modelID) : chat(modelID),
    responses,
    chat,
    configure,
  }
}

export const provider = {
  id,
  configure,
}
