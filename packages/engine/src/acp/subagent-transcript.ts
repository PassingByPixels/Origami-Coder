import type { Message, Part, SessionMessageResponse } from "@origami/sdk/v2"
import type { ToolCall, ToolCallUpdate } from "@agentclientprotocol/sdk"
import { completedToolUpdate, errorToolUpdate, pendingToolCall, runningToolUpdate } from "./tool"
import { errorMessage } from "./run-steps"
import { withTaskSession } from "./event"

/**
 * Read-only projection of ONE sub-agent's stored session into the shape the
 * live chat already renders: the child's prose, and one settled `ToolCall` per
 * tool it ran.
 *
 * Used by the `subagent_transcript` ext method so the shell's sub-agent panel
 * can draw a child the way the Chat panel draws a session, instead of the flat
 * forwarded log string `childChunk` (acp/event.ts) hands it today.
 *
 * EVERY projection comes from acp/tool.ts — the same functions the live chat's
 * cards are built from. Nothing is re-derived here on purpose: a duplicated
 * projection drifts, and the sub-agent view would slowly stop matching the
 * chat. It is also what makes a fix land in both at once — apply_patch's real
 * path and one-line title are inherited, not copied.
 *
 * Nothing mutates: only the `{ info, parts }` records `session.messages`
 * already returns are read.
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

export type TranscriptTool = {
  readonly type: "tool"
  readonly messageId: string
  /** The card the chat would show once the tool settled: name (`_meta`), kind,
   *  status, title, locations and result content, in one object. */
  readonly toolCall: ToolCall
  readonly truncated?: true
}

/**
 * A turn the MODEL CALL failed on. Emitted because without it a child that
 * died to a rate limit or an abort simply stops mid-transcript, which reads as
 * a child that finished and said nothing — the one thing this must never do.
 */
export type TranscriptError = {
  readonly type: "error"
  readonly messageId: string
  readonly name: string
  readonly message: string
}

export type TranscriptEntry = TranscriptText | TranscriptTool | TranscriptError

export type SubagentTranscriptResult = {
  readonly sessionId: string
  /**
   * False when the child's messages could not be read at all — an id that
   * never existed, a session deleted since, or a store that refused. The three
   * are not distinguishable here (`session.messages` rejects the same way for
   * each) and the panel's job is to render, not to diagnose: it gets an empty
   * transcript it can draw rather than an error that kills it.
   */
  readonly found: boolean
  /**
   * True while the child has not settled. A partial transcript comes back
   * either way — the entries in it are real — but it must never LOOK complete
   * when it is not.
   */
  readonly running: boolean
  readonly entries: readonly TranscriptEntry[]
  /** True when at least one entry was cut, so the UI can say so too. */
  readonly truncated: boolean
}

/**
 * Cap on any single string this transcript carries, in code points.
 *
 * There is deliberately NO cap on the number of entries. That is the position
 * run-steps settled on when its MAX_STEPS ceiling was removed: the part a
 * reader wants is usually the END of a run, so shipping a prefix is worse than
 * shipping a large payload. The bound is per string instead, which is enough
 * because the engine has already truncated tool output at 50 KiB upstream
 * (tool/truncate.ts MAX_BYTES) before any of it reached the store — what is
 * left to cut here is a write/edit payload and a read's display text. The
 * result is a transcript strictly SMALLER than what the main chat already
 * holds for the same session, since the chat rendered every one of these bytes
 * live and uncut.
 */
export const TEXT_LIMIT = 20_000

/**
 * Deepest nesting walked when capping. Stored parts are decoded JSON and so
 * are acyclic; this guards a pathological metadata blob, not a cycle. Deeper
 * values are left uncut — that is not where the bulk lives.
 */
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

/**
 * Cap every string reachable in a wire value. ONE rule over `content`,
 * `rawInput` and `rawOutput` alike, rather than a cap per field: a per-field
 * cap only bounds the fields it was written for, and the megabyte then arrives
 * through whichever one it was not — a `read`'s `metadata.display.text`, an
 * `edit`'s `newString`. That is how a bound becomes decorative.
 */
function bound(value: unknown, cut: Cut, depth = 0): unknown {
  if (typeof value === "string") return boundText(value, cut)
  if (depth >= MAX_DEPTH || !value || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map((item) => bound(item, cut, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) out[key] = bound(item, cut, depth + 1)
  return out
}

/**
 * The overlay an ACP client applies when a `tool_call_update` lands on the
 * `tool_call` it already holds: a named field REPLACES, an absent one is left
 * alone. Reproducing it is what collapses a stored tool part into the single
 * card the chat ends up showing, instead of the three frames it saw arrive.
 * A null field is dropped rather than written, because `ToolCall` requires a
 * real title and a client handed `null` renders nothing.
 */
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

/**
 * The card this tool part would have become in the chat: the pending frame the
 * engine sends first (kind, locations, rawInput, the `origami_tool_name`
 * rider), with the terminal frame overlaid the way a client overlays it. A
 * `pending` part never got a second frame, so it stays as the first one — the
 * honest record of a call the child accepted and never started.
 */
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
  // The task rider (`origami_task_session` and friends) rides every task card
  // the chat gets, and is the only key that names a GRANDCHILD's session.
  // Without it a `task` call inside a sub-agent transcript is a dead end — the
  // same flat-log problem this method exists to remove, one level down.
  return withTaskSession(update ? apply(base, update) : base, part)
}

/** Every entry one stored message produces, in stored part order. */
function messageEntries(info: Message, parts: readonly Part[], cwd: string, cut: Cut): TranscriptEntry[] {
  const out: TranscriptEntry[] = []
  for (const part of parts ?? []) {
    if (!part || typeof part !== "object") continue

    if (part.type === "text") {
      // The same filter run-steps applies to a stored run: a `synthetic` part
      // is engine bookkeeping (the injected <task_result> turns, the reminder
      // blocks) and an `ignored` one was deliberately kept off the reader's
      // screen. Neither is something the child said.
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

    // Reasoning is dropped for the reason acp/event.ts already drops a
    // sub-agent's: it is scratchpad, it is the bulk of the volume, and the
    // tool cards beside it already answer "what was it doing".
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
 * `time.completed` on the last assistant message is the engine's OWN test —
 * session/prompt.ts stamps it on every exit including the failed ones, and its
 * comment names a message with neither an error nor a completed time as
 * "indistinguishable from a turn still in flight". An unsettled tool part says
 * the same thing one level down.
 *
 * A child with no assistant message at all — spawned, nothing written back yet
 * — counts as running. Every ambiguous case resolves toward "still out" on
 * purpose: a child wrongly shown as running is a visible, correctable
 * annoyance; one wrongly shown as finished is a child nobody is waiting for.
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
 * Project one child session's stored messages into the chat's own shapes.
 * Message order is preserved as the engine returned it, parts in their stored
 * order within each message.
 *
 * `cwd` is the directory the read was scoped to; a message's own recorded cwd
 * wins over it, because that is where the child's relative paths resolved.
 */
export function project(
  sessionId: string,
  messages: readonly SessionMessageResponse[],
  cwd?: string,
): SubagentTranscriptResult {
  const cut: Cut = { any: false }
  const entries: TranscriptEntry[] = []
  for (const message of messages ?? []) {
    const info = message?.info
    if (!info || (info.role !== "assistant" && info.role !== "user")) continue
    const at = (info as { path?: { cwd?: string } }).path?.cwd ?? cwd ?? process.cwd()
    entries.push(...messageEntries(info, message.parts ?? [], at, cut))
  }
  return { sessionId, found: true, running: isRunning(messages ?? []), entries, truncated: cut.any }
}

export * as SubagentTranscript from "./subagent-transcript"
