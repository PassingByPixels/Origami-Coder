// foreign-transcript.ts - origami_change. The PURE half of
// `session_append_foreign`: what a batch of messages from another harness turns
// into, in this session's own v1 message store.
//
// NOT A TURN. Nothing here runs a model, and nothing here may be PRICED: every
// assistant message is built with `cost: 0` and NO `step-finish` part - that part
// is the only thing the session projector adds to a session's running cost/token
// columns, so omitting it keeps a mirrored chat costing nothing. `run-stats.ts`
// skips these rows outright on `isForeign`.
//
// TOKENS ARE NOT COST. The counts ARE real - the foreign harness measured them -
// and they carry through, while the two things that make a row cost money, `cost`
// and the `step-finish` part, stay exactly as they were.
//
// THE INVARIANTS IT KEEPS, because the store's own shape demands them:
//   * an Assistant REQUIRES a `parentID` naming a user message; a batch whose
//     assistant has no user turn is dropped rather than parented to a guess.
//   * ids are handed IN (`nextMessageID`/`nextPartID`), so no clock, ULID or I/O.
//   * idempotency is by the FOREIGN id, `sourceMessageID`; a re-sync appends nothing.

import type { SessionV1 } from "@origami/core/v1/session"

/** The only harness this ships for. Kept as a value so the extension's own
 *  `CLAUDE_CODE_PROVIDER` and the pricing guard below cannot drift apart. */
export const CLAUDE_CODE = "claude-code"

/** One call's ceiling. A passthrough turn mirrors two messages, so this is
 *  three orders of magnitude of headroom and still bounds a malformed client. */
export const MAX_MESSAGES = 100

/** A tool the foreign harness ran, summarised. No input and no output: this is
 *  a record that the step happened, not a replay of it. */
export interface ForeignToolCall {
  readonly name: string
  readonly title?: string
  readonly status?: string
}

/** What the foreign harness MEASURED for this message. Optional: a client that
 *  cannot tell us falls back to zeros. Never a price - see the header. */
export interface ForeignTokens {
  readonly input?: number
  readonly output?: number
  readonly reasoning?: number
  readonly cacheRead?: number
  readonly cacheWrite?: number
}

/** One message as the client sends it. `id` is the FOREIGN harness's id. */
export interface ForeignMessage {
  readonly id: string
  readonly role: "user" | "assistant"
  readonly text: string
  readonly timestamp?: number
  readonly toolCalls?: readonly ForeignToolCall[]
  /** Assistant messages only; ignored on a user row, which has no usage. */
  readonly tokens?: ForeignTokens
}

export interface PlannedRow {
  readonly info: SessionV1.Info
  readonly parts: SessionV1.Part[]
}

export interface PlanInput {
  readonly sessionID: string
  readonly source: string
  readonly incoming: readonly ForeignMessage[]
  /** foreign id -> the engine message id it was stored as. Both halves are needed:
   *  the SET decides what to skip, the ID is what a later assistant parents to. */
  readonly stored: ReadonlyMap<string, string>
  /** The newest USER message already in the session, if any — what an assistant
   *  arriving without its own user line parents to. */
  readonly lastUserID?: string
  readonly path: { readonly cwd: string; readonly root: string }
  readonly agent: string
  readonly modelID: string
  readonly providerID: string
  readonly nextMessageID: () => string
  readonly nextPartID: () => string
  readonly now: () => number
}

export interface Plan {
  readonly rows: PlannedRow[]
  /** Messages skipped because this session already holds them, or because an
   *  assistant had no user turn to parent to. */
  readonly skipped: number
}

/** The batch, projected onto the store. Deterministic: same input, same rows. */
export function plan(input: PlanInput): Plan {
  const rows: PlannedRow[] = []
  let skipped = 0
  let lastUserID = input.lastUserID

  for (const message of input.incoming) {
    const already = input.stored.get(message.id)
    if (already !== undefined) {
      // Seen before. Still update the parent pointer: a re-sync that resends the
      // user line and a NEW assistant must parent to the stored user message.
      if (message.role === "user") lastUserID = already
      skipped++
      continue
    }
    if (message.role === "user") {
      const id = input.nextMessageID()
      rows.push(userRow(input, message, id))
      lastUserID = id
      continue
    }
    if (!lastUserID) {
      skipped++
      continue
    }
    rows.push(assistantRow(input, message, input.nextMessageID(), lastUserID))
  }

  return { rows, skipped }
}

function userRow(input: PlanInput, message: ForeignMessage, id: string): PlannedRow {
  const info = {
    id,
    sessionID: input.sessionID,
    role: "user",
    time: { created: message.timestamp ?? input.now() },
    agent: input.agent,
    model: { providerID: input.providerID, modelID: input.modelID },
    source: input.source,
    sourceMessageID: message.id,
  } as unknown as SessionV1.Info
  return { info, parts: textParts(input, id, message) }
}

function assistantRow(input: PlanInput, message: ForeignMessage, id: string, parentID: string): PlannedRow {
  const created = message.timestamp ?? input.now()
  const info = {
    id,
    sessionID: input.sessionID,
    role: "assistant",
    parentID,
    time: { created, completed: created },
    mode: input.agent,
    agent: input.agent,
    path: { cwd: input.path.cwd, root: input.path.root },
    modelID: input.modelID,
    providerID: input.providerID,
    // NOT a turn: see the header. `cost` is zero and there is no step-finish part,
    // which keeps the row unpriced. The TOKEN counts are the harness's own.
    cost: 0,
    tokens: tokensOf(message.tokens),
    source: input.source,
    sourceMessageID: message.id,
  } as unknown as SessionV1.Info
  const parts = textParts(input, id, message)
  message.toolCalls?.forEach((call, index) => parts.push(toolPart(input, id, call, created, index)))
  return { info, parts }
}

/**
 * The store's token shape, from whatever the client sent.
 *
 * Every member is CLAMPED to a finite count at or above zero: the numbers cross a
 * JSON-RPC boundary from another process, and a negative or NaN one would subtract
 * from the Labyrinth's totals. An absent measurement stays 0 - the store's shape
 * has no way to say "unmeasured".
 */
function tokensOf(tokens: ForeignTokens | undefined) {
  const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0)
  return {
    input: count(tokens?.input),
    output: count(tokens?.output),
    reasoning: count(tokens?.reasoning),
    cache: { read: count(tokens?.cacheRead), write: count(tokens?.cacheWrite) },
  }
}

function textParts(input: PlanInput, messageID: string, message: ForeignMessage): SessionV1.Part[] {
  const text = message.text ?? ""
  if (!text) return []
  return [
    {
      id: input.nextPartID(),
      messageID,
      sessionID: input.sessionID,
      type: "text",
      text,
    } as unknown as SessionV1.Part,
  ]
}

/**
 * A tool STEP, not a tool result. `input`/`output` are empty on purpose - the
 * mirror carries what the foreign harness showed the user, and inventing arguments
 * it never sent would put words in the tool's mouth. A failed call is stored as
 * `error` so the run-stats failure count is honest.
 *
 * THE INDEX IS LOAD-BEARING. A `<messageID>-<name>` callID COLLIDES the moment one
 * turn runs the same tool twice, and a reader that keys cards by callID then merges
 * the second call onto the first. The position in the turn is unique and stable.
 */
function toolPart(input: PlanInput, messageID: string, call: ForeignToolCall, time: number, index: number): SessionV1.Part {
  const base = {
    id: input.nextPartID(),
    messageID,
    sessionID: input.sessionID,
    type: "tool",
    callID: `${messageID}-${index}-${call.name}`,
    tool: call.name,
  }
  const state =
    call.status === "error"
      ? { status: "error", input: {}, error: call.title || call.name, time: { start: time, end: time } }
      : {
          status: "completed",
          input: {},
          output: "",
          title: call.title || call.name,
          metadata: {},
          time: { start: time, end: time },
        }
  return { ...base, state } as unknown as SessionV1.Part
}

/** Every foreign id this session already holds, and the engine id it holds it as.
 *  Read off the stored messages rather than kept in memory: the extension can be
 *  reloaded mid-chat, and a guard that dies with the window is not a guard. */
export function storedIds(messages: readonly { info: { id: string; sourceMessageID?: string } }[]) {
  const map = new Map<string, string>()
  for (const message of messages) {
    const foreign = message.info.sourceMessageID
    if (typeof foreign === "string" && foreign) map.set(foreign, message.info.id)
  }
  return map
}

/** The newest user message's id, for an assistant that arrives without one. */
export function lastUserID(messages: readonly { info: { id: string; role: string } }[]) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const info = messages[i]?.info
    if (info?.role === "user") return info.id
  }
  return undefined
}

/** True for a message this engine did NOT run. The pricing guard's whole rule:
 *  a mirrored turn is somebody else's spend and must total zero here. */
export function isForeign(info: unknown): boolean {
  if (typeof info !== "object" || info === null) return false
  const source = (info as { source?: unknown }).source
  return typeof source === "string" && source.length > 0
}

export * as ForeignTranscript from "./foreign-transcript"
