import type { Message, Part, SessionMessageResponse } from "@origami/sdk/v2"
import type { ToolCall, ToolCallUpdate } from "@agentclientprotocol/sdk"
import { completedToolUpdate, errorToolUpdate, pendingToolCall, runningToolUpdate } from "./tool"
import { errorMessage } from "./run-steps"
import { withTaskSession } from "./event"

/**
 * Read-only projection of ONE sub-agent's stored session into the shape the live
 * chat already renders: the child's prose, and one settled `ToolCall` per tool it
 * ran. Used by the `subagent_transcript` ext method.
 *
 * EVERY projection comes from acp/tool.ts - the same functions the live chat's
 * cards are built from. Nothing is re-derived here: a duplicated projection would
 * drift, and a fix has to land in both at once. Nothing mutates.
 */

type ToolPart = Extract<Part, { type: "tool" }>

export type TranscriptText = {
  readonly type: "text"
  /** The chat renders a user turn and an agent turn differently, and a child's
   *  brief is a user turn, so the transcript has to say which this is. */
  readonly role: "user" | "assistant"
  /** Groups consecutive parts into one bubble, exactly as `messageId` does on
   *  the `agent_message_chunk` the live chat receives. */
  readonly messageId: string
  readonly text: string
  /** Present only when a cap cut this entry — see TEXT_LIMIT. */
  readonly truncated?: true
}

/** t-gvz8t0. The child's THOUGHT, kept apart from its prose by its own type so
 *  the panel can only ever draw it as a thought block. A reader who wants to
 *  know why a child spent two minutes on its first step has nowhere else to
 *  look — the tool cards beside it say what it did, never what it weighed. */
export type TranscriptReasoning = {
  readonly type: "reasoning"
  readonly messageId: string
  readonly text: string
  /** Present only when a cap cut this entry — see TEXT_LIMIT. */
  readonly truncated?: true
}

export type TranscriptTool = {
  readonly type: "tool"
  readonly messageId: string
  /** The card the chat would show once the tool settled: name (`_meta`), kind,
   *  status, title, locations and result content, in one object. */
  readonly toolCall: ToolCall
  readonly truncated?: true
}

/** A turn the MODEL CALL failed on. Without it a child that died to a rate limit
 *  stops mid-transcript, which reads as a child that finished and said nothing. */
export type TranscriptError = {
  readonly type: "error"
  readonly messageId: string
  readonly name: string
  readonly message: string
}

export type TranscriptEntry = TranscriptText | TranscriptReasoning | TranscriptTool | TranscriptError

export type SubagentTranscriptResult = {
  readonly sessionId: string
  /** False when the child's messages could not be read at all - an id that never
   *  existed, a session deleted since, or a store that refused. The three are not
   *  distinguishable here, so the panel gets an empty transcript it can draw. */
  readonly found: boolean
  /** True while the child has not settled. A partial transcript comes back either
   *  way - the entries are real - but it must never LOOK complete when it is not. */
  readonly running: boolean
  readonly entries: readonly TranscriptEntry[]
  /** True when at least one entry was cut, so the UI can say so too. */
  readonly truncated: boolean
  /** t-krxap7. True when stored messages OLDER than this page exist. Always false
   *  on an unpaged read, which by definition carries the whole session. */
  readonly hasMore?: boolean
  /** t-krxap7. Opaque `before` cursor for the block preceding this page. Absent
   *  when nothing older exists. Format is MessageV2's own cursor - encoded in
   *  acp/service.ts, never parsed here. */
  readonly cursor?: string
}

/** t-krxap7. One page of stored messages as delivered, and what lies before it.
 *  `kept` is the page to project; `oldest` names the first row of `kept`, which is
 *  the row the NEXT page must stop short of. */
export type PageSlice = {
  readonly kept: readonly SessionMessageResponse[]
  readonly hasMore: boolean
  readonly oldest?: { readonly id: string; readonly time: number }
}

/**
 * t-krxap7. Split an over-fetched page into the `limit` newest rows and the verdict
 * on whether older rows exist.
 *
 * The caller asks the store for `limit + 1` rows; the store answers OLDEST-FIRST
 * (`MessageV2.page` reverses its own descending read). So a reply longer than
 * `limit` proves an older block, and its extra row is the FRONT one, which is
 * dropped. The cursor is taken from the first row we keep, because the `before`
 * predicate selects rows strictly older than the row it names.
 *
 * A limit of zero or less is not a page; the caller must not have asked for one.
 */
export function pageSlice(messages: readonly SessionMessageResponse[], limit: number): PageSlice {
  const rows = messages ?? []
  if (limit <= 0) return { kept: rows, hasMore: false }
  const hasMore = rows.length > limit
  const kept = hasMore ? rows.slice(rows.length - limit) : rows
  const first = kept[0]?.info as { id?: unknown; time?: { created?: unknown } } | undefined
  const id = typeof first?.id === "string" ? first.id : undefined
  const time = typeof first?.time?.created === "number" ? first.time.created : undefined
  // No cursor without BOTH halves: a half-built cursor would decode-fail on the
  // next request and turn "there is more" into an error the reader cannot act on.
  return { kept, hasMore, ...(hasMore && id !== undefined && time !== undefined ? { oldest: { id, time } } : {}) }
}

/**
 * Cap on any single string this transcript carries, in code points. There is
 * deliberately NO cap on the number of entries: the part a reader wants is usually
 * the END of a run, so shipping a prefix is worse than a large payload. The engine
 * has already truncated tool output at 50 KiB upstream (tool/truncate.ts).
 */
export const TEXT_LIMIT = 20_000

/** Deepest nesting walked when capping. Stored parts are decoded JSON and so are
 *  acyclic; this guards a pathological metadata blob, not a cycle. */
const MAX_DEPTH = 8

type Cut = { any: boolean }

/** Truncate on code points so a cut never splits a surrogate pair into lone
 *  halves, the same rule run-steps' `preview` follows. */
function boundText(text: string, cut: Cut): string {
  const points = Array.from(text)
  if (points.length <= TEXT_LIMIT) return text
  cut.any = true
  return `${points.slice(0, TEXT_LIMIT - 1).join("")}…`
}

/** Cap every string reachable in a wire value. ONE rule over `content`, `rawInput`
 *  and `rawOutput` alike: a per-field cap only bounds the fields it was written
 *  for, and the megabyte then arrives through whichever one it was not. */
function bound(value: unknown, cut: Cut, depth = 0): unknown {
  if (typeof value === "string") return boundText(value, cut)
  if (depth >= MAX_DEPTH || !value || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map((item) => bound(item, cut, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) out[key] = bound(item, cut, depth + 1)
  return out
}

/** The overlay an ACP client applies when a `tool_call_update` lands on the
 *  `tool_call` it already holds: a named field REPLACES, an absent one is left
 *  alone. A null field is dropped rather than written, because `ToolCall` requires
 *  a real title and a client handed `null` renders nothing. */
function apply(base: ToolCall, update: ToolCallUpdate): ToolCall {
  return {
    ...base,
    ...(update.status ? { status: update.status } : {}),
    ...(update.title ? { title: update.title } : {}),
    ...(update.kind ? { kind: update.kind } : {}),
    ...(update.locations ? { locations: update.locations } : {}),
    ...(update.content ? { content: update.content } : {}),
    ...(update.rawInput !== undefined ? { rawInput: update.rawInput } : {}),
    ...(update.rawOutput !== undefined ? { rawOutput: update.rawOutput } : {}),
    ...(update._meta ? { _meta: { ...(base._meta ?? {}), ...update._meta } } : {}),
  }
}

/** A running or completed state carries its own title; pending and error do not. */
function statedTitle(state: unknown): { title?: string } {
  const title = (state as { title?: unknown })?.title
  return typeof title === "string" && title ? { title } : {}
}

/** The card this tool part would have become in the chat: the pending frame the
 *  engine sends first, with the terminal frame overlaid the way a client overlays
 *  it. A `pending` part never got a second frame, so it stays as the first one. */
function toolCall(part: ToolPart, cwd: string): ToolCall {
  const state = part.state
  const base = pendingToolCall({
    toolCallId: part.callID,
    toolName: part.tool,
    state: { input: state.input ?? {}, ...statedTitle(state) },
    cwd,
  })
  const common = { toolCallId: part.callID, toolName: part.tool, cwd }
  const update: ToolCallUpdate | undefined =
    state.status === "completed"
      ? completedToolUpdate({ ...common, state })
      : state.status === "error"
        ? errorToolUpdate({ ...common, state })
        : state.status === "running"
          ? runningToolUpdate({ ...common, state })
          : undefined
  // The task rider (`origami_task_session` and friends) is the only key that names
  // a GRANDCHILD's session; without it a `task` call here is a dead end.
  return withTaskSession(update ? apply(base, update) : base, part)
}

/** Every entry one stored message produces, in stored part order. */
function messageEntries(info: Message, parts: readonly Part[], cwd: string, cut: Cut): TranscriptEntry[] {
  const out: TranscriptEntry[] = []
  for (const part of parts ?? []) {
    if (!part || typeof part !== "object") continue

    if (part.type === "text") {
      // The same filter run-steps applies: a `synthetic` part is engine bookkeeping
      // (the injected <task_result> turns, the reminder blocks) and an `ignored` one
      // was kept off the reader's screen. Neither is something the child said.
      if (part.synthetic || part.ignored) continue
      const text = part.text ?? ""
      if (!text.trim()) continue
      const inner: Cut = { any: false }
      const bounded = boundText(text, inner)
      cut.any ||= inner.any
      out.push({
        type: "text",
        role: info.role === "user" ? "user" : "assistant",
        messageId: info.id,
        text: bounded,
        ...(inner.any ? { truncated: true as const } : {}),
      })
      continue
    }

    if (part.type === "tool") {
      const inner: Cut = { any: false }
      // `bound` only shortens strings — every key, array and shape survives —
      // so the value is still the ToolCall that went in.
      const call = bound(toolCall(part, cwd), inner) as ToolCall
      cut.any ||= inner.any
      out.push({ type: "tool", messageId: info.id, toolCall: call, ...(inner.any ? { truncated: true as const } : {}) })
      continue
    }

    // t-gvz8t0. Reasoning used to be dropped here, for the reason acp/event.ts
    // used to drop a sub-agent's live reasoning. Both now carry it: a child that
    // thinks for two minutes before its first tool call has an EMPTY transcript
    // under the old rule, which reads as a child that did nothing.
    if (part.type === "reasoning") {
      const text = part.text ?? ""
      if (!text.trim()) continue
      const inner: Cut = { any: false }
      const bounded = boundText(text, inner)
      cut.any ||= inner.any
      out.push({
        type: "reasoning",
        messageId: info.id,
        text: bounded,
        ...(inner.any ? { truncated: true as const } : {}),
      })
    }
  }

  if (info.role === "assistant") {
    const failure = errorMessage(info.error)
    if (failure) {
      out.push({
        type: "error",
        messageId: info.id,
        name: (info.error as { name?: string } | undefined)?.name ?? "Error",
        message: failure,
      })
    }
  }
  return out
}

/** A tool the child accepted but never settled — it is still holding one. */
function unsettledTool(messages: readonly SessionMessageResponse[]): boolean {
  for (const message of messages ?? []) {
    for (const part of message?.parts ?? []) {
      if (!part || typeof part !== "object" || part.type !== "tool") continue
      if (part.state.status === "pending" || part.state.status === "running") return true
    }
  }
  return false
}

/**
 * Has the child settled?
 *
 * `time.completed` on the last assistant message is the engine's OWN test
 * (session/prompt.ts stamps it on every exit, failures included); an unsettled tool
 * part says the same one level down. Every ambiguous case resolves toward "still
 * out": a child wrongly shown as running is a correctable annoyance, one wrongly
 * shown as finished is a child nobody is waiting for.
 */
function isRunning(messages: readonly SessionMessageResponse[]): boolean {
  if (unsettledTool(messages)) return true
  const last = [...(messages ?? [])].reverse().find((message) => message?.info?.role === "assistant")?.info
  if (!last) return true
  return (last as { time?: { completed?: unknown } }).time?.completed === undefined
}

/** A child whose messages could not be read: identified, and empty. */
export function missing(sessionId: string): SubagentTranscriptResult {
  return { sessionId, found: false, running: false, entries: [], truncated: false }
}

/**
 * Project one child session's stored messages into the chat's own shapes, in the
 * order the engine returned them.
 *
 * `cwd` is the directory the read was scoped to; a message's own recorded cwd wins,
 * because that is where the child's relative paths resolved.
 */
export function project(
  sessionId: string,
  messages: readonly SessionMessageResponse[],
  cwd?: string,
  /** t-krxap7. Present only on a paged read; the whole-transcript path passes
   *  nothing and the two page fields stay off the wire entirely. */
  page?: { readonly hasMore: boolean; readonly cursor?: string },
): SubagentTranscriptResult {
  const cut: Cut = { any: false }
  const entries: TranscriptEntry[] = []
  for (const message of messages ?? []) {
    const info = message?.info
    if (!info || (info.role !== "assistant" && info.role !== "user")) continue
    const at = (info as { path?: { cwd?: string } }).path?.cwd ?? cwd ?? process.cwd()
    entries.push(...messageEntries(info, message.parts ?? [], at, cut))
  }
  return {
    sessionId,
    found: true,
    running: isRunning(messages ?? []),
    entries,
    truncated: cut.any,
    ...(page ? { hasMore: page.hasMore, ...(page.cursor ? { cursor: page.cursor } : {}) } : {}),
  }
}

export * as SubagentTranscript from "./subagent-transcript"
