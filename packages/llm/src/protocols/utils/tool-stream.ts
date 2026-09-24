import { Effect } from "effect"
import { LLMError, LLMEvent, type ProviderMetadata, type ToolCall } from "../../schema"
import { eventError, readToolInput, type ToolAccumulator } from "../shared"

type StreamKey = string | number

/** One pending streamed tool call. Providers emit the tool identity and JSON
 *  argument text across separate chunks; `input` is the raw JSON string collected
 *  so far, not the parsed object. */
export interface PendingTool extends ToolAccumulator {
  readonly providerExecuted?: boolean
  readonly providerMetadata?: ProviderMetadata
}

/**
 * Sparse parser state keyed by the provider's stream-local tool identifier.
 *
 * Not the final tool-call id (`call_...`): OpenAI Chat / Anthropic / Bedrock use
 * numeric content indexes while OpenAI Responses uses string `item_id`s.
 */
export type State<K extends StreamKey> = Partial<Record<K, PendingTool>>

/** Result of adding argument text to one pending tool call. Returns both the next
 *  `tools` state and the updated `tool`, since parsers often need the id/name at
 *  once. `events` holds lifecycle and delta events; metadata-only deltas emit none. */
export interface AppendOutcome<K extends StreamKey> {
  readonly tools: State<K>
  readonly tool: PendingTool
  readonly events: ReadonlyArray<LLMEvent>
}

/** Create empty accumulator state for one provider stream. */
export const empty = <K extends StreamKey>(): State<K> => ({})

const withTool = <K extends StreamKey>(tools: State<K>, key: K, tool: PendingTool): State<K> => {
  return { ...tools, [key]: tool }
}

const withoutTool = <K extends StreamKey>(tools: State<K>, key: K): State<K> => {
  const next = { ...tools }
  delete next[key]
  return next
}

const inputStart = (tool: PendingTool) =>
  LLMEvent.toolInputStart({
    id: tool.id,
    name: tool.name,
    providerMetadata: tool.providerMetadata,
  })

const inputDelta = (tool: PendingTool, text: string) =>
  LLMEvent.toolInputDelta({
    id: tool.id,
    name: tool.name,
    text,
  })

/**
 * Build the public `tool-call` event for one finished call.
 *
 * Unreadable arguments do NOT fail the stream. The provider announced a call; the
 * honest report is that call, marked `invalid`, carrying the raw text the model
 * sent — the finish reason, the usage and every sibling call that did parse still
 * reach the consumer.
 */
const toolCall = (route: string, tool: PendingTool, inputOverride?: string): ToolCall => {
  const raw = inputOverride ?? tool.input
  const read = readToolInput(route, tool.name, raw)
  return LLMEvent.toolCall({
    id: tool.id,
    name: tool.name,
    input: read.ok ? read.input : raw,
    invalid: read.ok ? undefined : true,
    error: read.ok ? undefined : read.error,
    providerExecuted: tool.providerExecuted ? true : undefined,
    providerMetadata: tool.providerMetadata,
  })
}

/** Store the updated tool and produce the optional public delta event. */
const appendTool = <K extends StreamKey>(
  tools: State<K>,
  key: K,
  tool: PendingTool,
  text: string,
): AppendOutcome<K> => {
  const events: LLMEvent[] = []
  if (!tools[key]) events.push(inputStart(tool))
  if (text.length > 0) events.push(inputDelta(tool, text))
  return {
    tools: withTool(tools, key, tool),
    tool,
    events,
  }
}

export const isError = <K extends StreamKey>(result: AppendOutcome<K> | LLMError): result is LLMError =>
  result instanceof LLMError

/** Register a tool call whose start event arrived before any argument deltas. Used
 *  by Anthropic `content_block_start`, Bedrock `contentBlockStart`, OpenAI Responses. */
export const start = <K extends StreamKey>(
  tools: State<K>,
  key: K,
  tool: Omit<PendingTool, "input"> & { readonly input?: string },
) => withTool(tools, key, { ...tool, input: tool.input ?? "" })

/** Append a streamed argument delta, starting the tool if the provider encodes
 *  identity on the first delta instead of a separate start event. OpenAI Chat has
 *  this shape: `tool_calls[].index` is the key and `id`/`name` may appear only there. */
export const appendOrStart = <K extends StreamKey>(
  route: string,
  tools: State<K>,
  key: K,
  delta: { readonly id?: string; readonly name?: string; readonly text: string },
  missingToolMessage: string,
): AppendOutcome<K> | LLMError => {
  const current = tools[key]
  const id = delta.id ?? current?.id
  const name = delta.name ?? current?.name
  if (!id || !name) return eventError(route, missingToolMessage)

  const tool = {
    id,
    name,
    input: `${current?.input ?? ""}${delta.text}`,
    providerExecuted: current?.providerExecuted,
    providerMetadata: current?.providerMetadata,
  }
  if (current && delta.text.length === 0 && current.id === id && current.name === name)
    return { tools, tool: current, events: [] }
  return appendTool(tools, key, tool, delta.text)
}

/** Append argument text to a tool that must already have been started, keeping
 *  protocols honest when their grammar promises a start event first. */
export const appendExisting = <K extends StreamKey>(
  route: string,
  tools: State<K>,
  key: K,
  text: string,
  missingToolMessage: string,
): AppendOutcome<K> | LLMError => {
  const current = tools[key]
  if (!current) return eventError(route, missingToolMessage)
  if (text.length === 0) return { tools, tool: current, events: [] }
  return appendTool(tools, key, { ...current, input: `${current.input}${text}` }, text)
}

/** Shared body of `finish` / `finishWithInput`: pop one call and close it. */
const finishOne = <K extends StreamKey>(route: string, tools: State<K>, key: K, inputOverride?: string) => {
  const tool = tools[key]
  if (!tool) return { tools }
  return {
    tools: withoutTool(tools, key),
    events: [
      LLMEvent.toolInputEnd({ id: tool.id, name: tool.name, providerMetadata: tool.providerMetadata }),
      toolCall(route, tool, inputOverride),
    ],
  }
}

/** Finalize one pending tool call: read the raw JSON, remove it from state, return
 *  the optional `tool-call` event. A missing key is a no-op (non-tool stop events). */
export const finish = <K extends StreamKey>(route: string, tools: State<K>, key: K) =>
  Effect.succeed(finishOne(route, tools, key))

/** Finalize one pending tool call with an authoritative final input string: OpenAI
 *  Responses repeats the completed arguments on `output_item.done`, and that wins. */
export const finishWithInput = <K extends StreamKey>(route: string, tools: State<K>, key: K, input: string) =>
  Effect.succeed(finishOne(route, tools, key, input))

/** Finalize every pending tool call at once. OpenAI Chat emits no per-tool stop
 *  events, so all accumulated calls finish on a terminal `finish_reason`. */
export const finishAll = <K extends StreamKey>(route: string, tools: State<K>) => {
  const pending = Object.values<PendingTool | undefined>(tools).filter(
    (tool): tool is PendingTool => tool !== undefined,
  )
  return Effect.succeed({
    tools: empty<K>(),
    events: pending.flatMap((tool) => [
      LLMEvent.toolInputEnd({ id: tool.id, name: tool.name, providerMetadata: tool.providerMetadata }),
      toolCall(route, tool),
    ]),
  })
}

export * as ToolStream from "./tool-stream"
