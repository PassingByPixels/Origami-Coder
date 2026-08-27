import type { Part, SessionMessageResponse } from "@origami/sdk/v2"

/**
 * Per-run counts for the run index, computed by the `run_stats` ext method.
 *
 * BATCHED BY DESIGN: the index lists every past run at once, so it asks for the
 * whole page in ONE call rather than a round trip per row.
 *
 * COST: there is no cheaper source. The SDK's `Session` record (`@origami/sdk/v2`)
 * carries `time`, `cost` and `tokens` but NO message/tool/failure counts, so
 * every count here means reading that session's messages — the same
 * `session.messages` read `run_steps` does. One read per session, capped at
 * `MAX_SESSIONS`; a very long run pays for its own length. If a caller only
 * needs `durationMs` it should read the session record instead, not this.
 *
 * A value that could not be computed is OMITTED. Never zero — a blank cell is
 * honest, a fabricated `0 tool calls` is not.
 */

export type RunStat = {
  readonly sessionId: string
  readonly messages?: number
  readonly toolCalls?: number
  readonly failures?: number
  readonly durationMs?: number
  /**
   * Assistant messages — REQUESTS, not steps and not parts. The index needs it
   * to know whether a cache-hit rate is worth reading at all: two requests say
   * nothing about a session's caching, two hundred do.
   */
  readonly requests?: number
  /**
   * The session's own token totals, summed over its assistant messages. ADDITIVE
   * and OPTIONAL, and every member follows the same rule the per-step usage
   * does: an absent measurement is OMITTED, never zeroed. `cacheRead` absent
   * means the provider never reported cache tokens — most local servers do not —
   * which is a DIFFERENT fact from a cache that was never hit, and a consumer
   * must be able to tell them apart.
   */
  readonly tokens?: {
    readonly input: number
    readonly output: number
    readonly reasoning?: number
    readonly cacheRead?: number
    readonly cacheWrite?: number
  }
  /** Summed message cost. A genuine 0 (a local model) is KEPT, not dropped. */
  readonly cost?: number
}

export type RunStatsResult = {
  readonly stats: readonly RunStat[]
  /** True when the request named more sessions than `MAX_SESSIONS`; the extras are absent from `stats`. */
  readonly truncated: boolean
  /** How many session ids the caller asked about, before the cap. */
  readonly requested: number
}

/**
 * Hard cap on sessions per batch. The observed run index lists ~11; this leaves
 * generous headroom while keeping one call to a bounded number of reads.
 */
export const MAX_SESSIONS = 32

/** Tool parts count as one call each, whatever their state. */
function isToolPart(part: unknown): part is Extract<Part, { type: "tool" }> {
  return !!part && typeof part === "object" && (part as { type?: unknown }).type === "tool"
}

/**
 * What counts as a failure, stated so the number is readable:
 *  - a tool call that ended in `error` state, and
 *  - an assistant message carrying a message-level `error` (a context overflow
 *    or provider fault is recorded there, NOT raised, so leaving it out would
 *    under-report exactly the runs a user is scanning the index to find).
 * A `retry` part is deliberately NOT counted: a retry that then succeeded is
 * not a failed run, and the attempt that caused it is already counted above.
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

/**
 * Wall-clock span of the run: earliest message start to latest message end.
 * User messages only have `time.created`; assistant messages add
 * `time.completed`. Omitted when no usable timestamp survives — an
 * unmeasurable run reports no duration rather than a made-up one.
 */
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

type Spend = Pick<RunStat, "requests" | "tokens" | "cost">

/**
 * Requests and token totals over the ASSISTANT messages. Deliberately summed
 * from the stored messages rather than from the session row's running totals:
 * the row's shape is not guaranteed by the SDK's `Session` type, and this batch
 * has already paid for the message read.
 *
 * `input`/`output` are the only members always present once anything was
 * measured, because a message that recorded usage always carries both. Every
 * other member is omitted unless some message really reported it.
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
  for (const message of list) {
    const info = message.info as { role?: string; cost?: unknown; tokens?: Record<string, unknown> } | undefined
    if (info?.role !== "assistant") continue
    requests++
    cost = add(cost, info.cost)
    const tokens = info.tokens
    if (!finite(tokens?.["input"]) || !finite(tokens?.["output"])) continue
    measured++
    input += tokens["input"] as number
    output += tokens["output"] as number
    reasoning = add(reasoning, tokens["reasoning"])
    const cache = tokens["cache"] as Record<string, unknown> | undefined
    cacheRead = add(cacheRead, cache?.["read"])
    cacheWrite = add(cacheWrite, cache?.["write"])
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
        }),
    ...(cost === undefined ? {} : { cost }),
  }
}

/**
 * Stats for one session's messages. `messages` may legitimately be an EMPTY
 * run — that is a computed zero, not an unknown, so the counts are reported;
 * only the unmeasurable duration is dropped.
 */
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
