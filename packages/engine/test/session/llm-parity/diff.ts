/**
 * Normalisation and diffing for LLM runtime parity.
 *
 * Two runtimes that agree on meaning still disagree on incidentals: block ids
 * are minted differently, deltas are chunked differently, and provider
 * metadata is a passthrough of whatever the wire carried. `canonicalize`
 * removes the first and third (the strict view), `semantic` also removes the
 * second (the gate view). What survives both is what a consumer of the event
 * stream can actually observe.
 */

/** Stable JSON: object keys sorted at every depth, so views compare as strings. */
export const canonicalJson = (value: unknown): string => JSON.stringify(sortKeys(value))

const sortKeys = (value: unknown): unknown => {
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map(sortKeys)
  return Object.fromEntries(
    Object.entries(value)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, sortKeys(item)]),
  )
}

/** One event reduced to comparable data. */
export type EventView = Record<string, unknown>

/** Usage fields the gate compares. `undefined` on one side vs a number on the other is a difference. */
export const USAGE_FIELDS = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "reasoningTokens",
  "cacheReadInputTokens",
  "cacheWriteInputTokens",
  "nonCachedInputTokens",
] as const

const TEXT_TYPES = new Set(["text-start", "text-delta", "text-end"])
const REASONING_TYPES = new Set(["reasoning-start", "reasoning-delta", "reasoning-end"])
const DELTA_TYPES = new Set(["text-delta", "reasoning-delta", "tool-input-delta"])

/** Event shape this module needs. Structural so callers can pass `LLMEvent` or a hand-built view. */
export type EventLike = {
  readonly type: string
  readonly id?: unknown
  readonly usage?: unknown
  readonly providerMetadata?: unknown
}

/** Own enumerable properties of anything, or an empty record for a non-object. */
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value)) : {}

const plainObject = (value: object): EventView => {
  const out: EventView = {}
  for (const [key, item] of Object.entries(record(value))) {
    // providerMetadata is a raw provider passthrough — compared separately.
    if (key === "providerMetadata") continue
    if (item === undefined) continue
    out[key] = plain(item)
  }
  return out
}

const plain = (value: unknown): unknown => {
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map(plain)
  if (value instanceof Error) return { name: value.name, message: value.message }
  return plainObject(value)
}

/** Raw usage fields, `null` for absent — the strict view. */
const rawUsageView = (usage: unknown): Record<string, number | null> => {
  const source = record(usage)
  return Object.fromEntries(
    USAGE_FIELDS.map((field) => {
      const value = source[field]
      return [field, typeof value === "number" ? value : null]
    }),
  )
}

const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0)

/**
 * Usage as the engine CONSUMES it — the same arithmetic as `Session.getUsage`
 * (session.ts): absent means zero, non-cached input is derived, visible
 * output excludes reasoning. This is the gate view. The AI SDK fills absent
 * breakdown fields with 0 while `@origami/llm` leaves them undefined and
 * reports `nonCachedInputTokens` the engine never reads; neither is
 * observable past `getUsage`, and the strict view still shows the raw fields.
 */
const consumedUsageView = (usage: unknown): Record<string, number | null> => {
  const source = record(usage)
  const input = count(source["inputTokens"])
  const output = count(source["outputTokens"])
  const reasoning = count(source["reasoningTokens"])
  const cacheRead = count(source["cacheReadInputTokens"])
  const cacheWrite = count(source["cacheWriteInputTokens"])
  return {
    input: Math.max(0, input - cacheRead - cacheWrite),
    output: Math.max(0, output - reasoning),
    reasoning,
    cacheRead,
    cacheWrite,
    total: typeof source["totalTokens"] === "number" ? source["totalTokens"] : null,
  }
}

const asText = (value: unknown) => (typeof value === "string" ? value : "")

const renamer = (prefix: string) => {
  const seen = new Map<string, string>()
  return (id: string) => {
    const existing = seen.get(id)
    if (existing !== undefined) return existing
    const next = `${prefix}#${seen.size}`
    seen.set(id, next)
    return next
  }
}

/**
 * Strict view: providerMetadata stripped, text/reasoning block ids renamed by
 * first appearance. Tool-call ids stay verbatim — they are server-issued and
 * present in the cassette, so both runtimes must reproduce them exactly.
 */
const canonical = (events: ReadonlyArray<EventLike>, usageView: (usage: unknown) => EventView): EventView[] => {
  const text = renamer("text")
  const reasoning = renamer("reasoning")
  return events.map((event) => {
    const view = plainObject(event)
    if (TEXT_TYPES.has(event.type)) view["id"] = text(String(event.id))
    else if (REASONING_TYPES.has(event.type)) view["id"] = reasoning(String(event.id))
    if ("usage" in event) view["usage"] = usageView(event.usage)
    return view
  })
}

export const canonicalize = (events: ReadonlyArray<EventLike>): EventView[] => canonical(events, rawUsageView)

/** Only the providerMetadata of each event, positionally — the informational view. */
export const metadata = (events: ReadonlyArray<EventLike>): EventView[] =>
  events.map((event) => ({
    type: event.type,
    providerMetadata: plain(event.providerMetadata) ?? null,
  }))

/**
 * `tool-result.output` is the native tool runtime's structured echo of the
 * result; the engine reads only `result` (processor.ts `toolResultOutput`),
 * and the AI SDK adapter never sets `output`. Not observable, so not gated.
 */
const consumedToolResult = (view: EventView): EventView => {
  if (view["type"] !== "tool-result" || !("output" in view)) return view
  const { output: _output, ...rest } = view
  return rest
}

const coalesce = (views: ReadonlyArray<EventView>): EventView[] => {
  const out: EventView[] = []
  for (const raw of views) {
    const view = consumedToolResult(raw)
    const previous = out.at(-1)
    if (previous && DELTA_TYPES.has(asText(view["type"])) && previous["type"] === view["type"] && previous["id"] === view["id"]) {
      out[out.length - 1] = { ...previous, text: `${asText(previous["text"])}${asText(view["text"])}` }
      continue
    }
    out.push(view)
  }
  return out
}

/**
 * Gate view: ids canonical, consecutive same-block deltas joined (chunking is
 * not semantic), usage projected the way the engine consumes it.
 */
export const semantic = (events: ReadonlyArray<EventLike>): EventView[] =>
  coalesce(canonical(events, consumedUsageView))

export type Diff = {
  readonly aLength: number
  readonly bLength: number
  /** -1 when the two views are identical. */
  readonly firstDiffIndex: number
  readonly a?: EventView
  readonly b?: EventView
}

export const diff = (a: ReadonlyArray<EventView>, b: ReadonlyArray<EventView>): Diff => {
  const shared = Math.min(a.length, b.length)
  for (let index = 0; index < shared; index++) {
    if (canonicalJson(a[index]) !== canonicalJson(b[index]))
      return { aLength: a.length, bLength: b.length, firstDiffIndex: index, a: a[index], b: b[index] }
  }
  if (a.length !== b.length)
    return { aLength: a.length, bLength: b.length, firstDiffIndex: shared, a: a[shared], b: b[shared] }
  return { aLength: a.length, bLength: b.length, firstDiffIndex: -1 }
}

/** One-word summary for the PARITY report line. */
export const describe = (value: Diff) => (value.firstDiffIndex === -1 ? "equal" : `diff@${value.firstDiffIndex}`)

export * as LLMParityDiff from "./diff"
