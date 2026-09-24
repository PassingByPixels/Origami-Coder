import type { Part, SessionMessageResponse } from "@origami/sdk/v2"
import { ForeignTranscript } from "./foreign-transcript" // origami_change: mirrored turns are unpriced

/**
 * Per-run counts for the run index, computed by the `run_stats` ext method.
 *
 * BATCHED BY DESIGN: the index lists every past run at once, so it asks for the
 * whole page in ONE call rather than a round trip per row. There is no cheaper
 * source - the SDK's `Session` record carries no message/tool/failure counts, so
 * every count means reading that session's messages, capped at `MAX_SESSIONS`.
 * A value that could not be computed is OMITTED, never zeroed.
 */

export type RunStat = {
  readonly sessionId: string
  readonly messages?: number
  readonly toolCalls?: number
  readonly failures?: number
  readonly durationMs?: number
  /** Assistant messages - REQUESTS, not steps and not parts. The index needs it to
   *  know whether a cache-hit rate is worth reading at all. */
  readonly requests?: number
  /** The session's own token totals, summed over its assistant messages. ADDITIVE
   *  and OPTIONAL: an absent measurement is OMITTED, never zeroed. `cacheRead`
   *  absent means the provider never reported cache tokens, which is a different
   *  fact from a cache that was never hit. */
  readonly tokens?: {
    readonly input: number
    readonly output: number
    readonly reasoning?: number
    readonly cacheRead?: number
    readonly cacheWrite?: number
  }
  /** Summed message cost. A genuine 0 (a local model) is KEPT, not dropped. */
  readonly cost?: number
  /** t-ffziaz. MEASURED STEPS - one per `step-finish` that reported a spend, so
   *  `tokens.input` divided by this is what one step of this run costs. Absent
   *  when nothing was measured. */
  readonly steps?: number
  /** t-ffziaz. The LAST measured step's context: everything that step sent the
   *  model, cached prefix included. This is the figure the main chat's pill
   *  shows, and it is the one number here that is NOT a sum - a run of 9 steps
   *  at 20k has a 180k `tokens.input` and a 20k `context`. Absent when nothing
   *  was measured. */
  readonly context?: number
}

export type RunStatsResult = {
  readonly stats: readonly RunStat[]
  /** True when the request named more sessions than `MAX_SESSIONS`; the extras are absent from `stats`. */
  readonly truncated: boolean
  /** How many session ids the caller asked about, before the cap. */
  readonly requested: number
}

/** Hard cap on sessions per batch. The observed run index lists ~11; this leaves
 *  generous headroom while keeping one call to a bounded number of reads. */
export const MAX_SESSIONS = 32

/** Tool parts count as one call each, whatever their state. */
function isToolPart(part: unknown): part is Extract<Part, { type: "tool" }> {
  return !!part && typeof part === "object" && (part as { type?: unknown }).type === "tool"
}

/**
 * What counts as a failure, stated so the number is readable:
 *  - a tool call that ended in `error` state, and
 *  - an assistant message carrying a message-level `error` (a context overflow or
 *    provider fault is recorded there, NOT raised).
 * A `retry` part is deliberately NOT counted: the attempt behind it is already in.
 */
function failureCount(message: SessionMessageResponse): number {
  let failures = 0
  for (const part of message?.parts ?? []) {
    if (isToolPart(part) && part.state?.status === "error") failures++
  }
  const info = message?.info
  if (info?.role === "assistant" && info.error) failures++
  return failures
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

/** Wall-clock span of the run: earliest message start to latest message end.
 *  Omitted when no usable timestamp survives, rather than made up. */
function durationMs(messages: readonly SessionMessageResponse[]): number | undefined {
  let first: number | undefined
  let last: number | undefined
  for (const message of messages) {
    const time = message?.info?.time as { created?: unknown; completed?: unknown } | undefined
    const start = time?.created
    const end = (time as { completed?: unknown } | undefined)?.completed
    if (finite(start)) {
      if (first === undefined || start < first) first = start
      if (last === undefined || start > last) last = start
    }
    if (finite(end)) {
      if (last === undefined || end > last) last = end
    }
  }
  if (first === undefined || last === undefined) return undefined
  return Math.max(0, last - first)
}

/** `a + b` where an absent side stays absent — 0 + unmeasured must not be 0. */
function add(a: number | undefined, b: unknown): number | undefined {
  if (!finite(b)) return a
  return (a ?? 0) + b
}

/** A step's `tokens`, read as "whatever is really there" rather than as typed. */
type TokenView = {
  readonly input?: unknown
  readonly output?: unknown
  readonly reasoning?: unknown
  readonly cache?: { readonly read?: unknown; readonly write?: unknown }
}

/**
 * t-ffziaz. What ONE step sent, cached prefix included - `input` is the
 * non-cached remainder (session/session.ts subtracts both cache halves), so a
 * step whose prefix came from cache would otherwise read as tiny. `undefined`
 * for a part that is not a step-finish with finite `input` and `output`.
 *
 * Exported for t-ucndru: a live child step takes its `context` from the part
 * its event carries, so the formula is shared rather than copied.
 */
export function stepContext(part: Part | undefined): number | undefined {
  if (!part || part.type !== "step-finish") return undefined
  const tokens: TokenView | undefined = part.tokens
  const input = tokens?.input
  if (!finite(input) || !finite(tokens?.output)) return undefined
  const read = tokens?.cache?.read
  const write = tokens?.cache?.write
  return input + (finite(read) ? read : 0) + (finite(write) ? write : 0)
}

/**
 * One assistant message's spend, summed over its `step-finish` parts.
 *
 * WHY NOT THE MESSAGE. `message.info.tokens` is ASSIGNED at every step-finish, not
 * accumulated (session/processor.ts), because the context gauge needs "how full is
 * the window now" rather than "what did this turn cost" - so it under-reports every
 * multi-step turn by every step but the last. `undefined` when there is no usable
 * step-finish part; the caller then falls back to the message level.
 */
function stepSpend(
  parts: readonly Part[] | undefined,
):
  | { readonly cost: number; readonly tokens: Record<string, unknown>; readonly steps: number; readonly context: number }
  | undefined {
  let found = false
  let cost = 0
  let input = 0
  let output = 0
  let steps = 0
  let context = 0
  let reasoning: number | undefined
  let cacheRead: number | undefined
  let cacheWrite: number | undefined
  for (const part of parts ?? []) {
    if (!part || part.type !== "step-finish") continue
    // Widened rather than asserted: the SDK type says every member is a number, but
    // these rows come off disk and an older or hand-edited one need not honour it.
    const tokens: TokenView | undefined = part.tokens
    // Same bar the message level uses: a step that never reported both input
    // and output measured nothing, so it contributes nothing rather than zeros.
    const stepInput = tokens?.input
    const stepOutput = tokens?.output
    if (!finite(stepInput) || !finite(stepOutput)) continue
    const stepCacheRead = tokens?.cache?.read
    const stepCacheWrite = tokens?.cache?.write
    found = true
    cost += finite(part.cost) ? part.cost : 0
    input += stepInput
    output += stepOutput
    steps++
    // Overwritten each step on purpose: only the last one survives.
    context = stepContext(part) ?? context
    reasoning = add(reasoning, tokens?.reasoning)
    cacheRead = add(cacheRead, stepCacheRead)
    cacheWrite = add(cacheWrite, stepCacheWrite)
  }
  if (!found) return undefined
  // `cache` is present only if some step reported at least one of its halves —
  // the same "absent means never measured" rule the message level follows.
  const cache =
    cacheRead === undefined && cacheWrite === undefined
      ? undefined
      : { read: cacheRead ?? 0, write: cacheWrite ?? 0 }
  return {
    cost,
    steps,
    context,
    tokens: {
      input,
      output,
      ...(reasoning === undefined ? {} : { reasoning }),
      ...(cache === undefined ? {} : { cache }),
    },
  }
}

type Spend = Pick<RunStat, "requests" | "tokens" | "cost" | "steps" | "context">

/**
 * Requests and token totals over the ASSISTANT messages. Summed from the stored
 * messages rather than the session row's running totals: the row's shape is not
 * guaranteed by the SDK's `Session` type, and this batch already paid for the read.
 * `input`/`output` are the only members always present once anything was measured.
 */
function spend(list: readonly SessionMessageResponse[]): Spend {
  let requests = 0
  let measured = 0
  let input = 0
  let output = 0
  let reasoning: number | undefined
  let cacheRead: number | undefined
  let cacheWrite: number | undefined
  let cost: number | undefined
  let steps = 0
  let context = 0
  for (const message of list) {
    const info = message.info as { role?: string; cost?: unknown; tokens?: Record<string, unknown> } | undefined
    if (info?.role !== "assistant") continue
    // origami_change: a MIRRORED turn is somebody else's spend. A passthrough
    // transcript copied in by session_append_foreign would otherwise report requests
    // this engine never made and a cache ratio over turns it never sent.
    if (ForeignTranscript.isForeign(info)) continue
    requests++
    // Per-step parts when the message has them, the message level otherwise.
    // See `stepSpend` for why the message level under-reports a tool loop.
    const stepped = stepSpend(message?.parts)
    cost = add(cost, stepped ? stepped.cost : info.cost)
    const tokens = stepped ? stepped.tokens : info.tokens
    if (!finite(tokens?.["input"]) || !finite(tokens?.["output"])) continue
    measured++
    input += tokens["input"] as number
    output += tokens["output"] as number
    reasoning = add(reasoning, tokens["reasoning"])
    const cache = tokens["cache"] as Record<string, unknown> | undefined
    cacheRead = add(cacheRead, cache?.["read"])
    cacheWrite = add(cacheWrite, cache?.["write"])
    // t-ffziaz. A message with no step-finish parts still cost ONE request, and
    // its message-level `tokens` is that one step - so it counts as a step and
    // its context replaces the previous one, exactly as a step part would.
    steps += stepped ? stepped.steps : 1
    context = stepped
      ? stepped.context
      : (tokens["input"] as number) +
        (finite(cache?.["read"]) ? (cache["read"] as number) : 0) +
        (finite(cache?.["write"]) ? (cache["write"] as number) : 0)
  }
  return {
    requests,
    ...(measured === 0
      ? {}
      : {
          tokens: {
            input,
            output,
            ...(reasoning === undefined ? {} : { reasoning }),
            ...(cacheRead === undefined ? {} : { cacheRead }),
            ...(cacheWrite === undefined ? {} : { cacheWrite }),
          },
          steps,
          context,
        }),
    ...(cost === undefined ? {} : { cost }),
  }
}

/** Stats for one session's messages. `messages` may legitimately be an EMPTY run -
 *  that is a computed zero, not an unknown, so only the duration is dropped. */
export function stat(sessionId: string, messages: readonly SessionMessageResponse[]): RunStat {
  const list = (messages ?? []).filter((message) => !!message?.info)
  let toolCalls = 0
  let failures = 0
  for (const message of list) {
    for (const part of message.parts ?? []) if (isToolPart(part)) toolCalls++
    failures += failureCount(message)
  }
  const span = durationMs(list)
  return {
    sessionId,
    messages: list.length,
    toolCalls,
    failures,
    ...(span === undefined ? {} : { durationMs: span }),
    ...spend(list),
  }
}

/** A session whose messages could not be read: identified, everything else omitted. */
export function unreadable(sessionId: string): RunStat {
  return { sessionId }
}

/** Session ids this batch will actually read, and whether any were dropped. */
export function plan(sessionIds: readonly string[]): { readonly ids: string[]; readonly truncated: boolean } {
  const unique: string[] = []
  const seen = new Set<string>()
  for (const id of sessionIds ?? []) {
    if (typeof id !== "string" || !id || seen.has(id)) continue
    seen.add(id)
    unique.push(id)
  }
  return { ids: unique.slice(0, MAX_SESSIONS), truncated: unique.length > MAX_SESSIONS }
}

export * as RunStats from "./run-stats"
