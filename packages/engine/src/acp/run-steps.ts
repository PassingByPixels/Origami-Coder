import type { Message, Part, SessionMessageResponse } from "@origami/sdk/v2"

/**
 * Read-only projection of a stored run into an ordered, wire-safe step list.
 *
 * Used by the `run_steps` ext method so a shell can review a PAST run without
 * loading/resuming the session. Nothing here mutates: it only reads the
 * `{ info, parts }` records `session.messages` already returns.
 */

export type RunStepKind = "prompt" | "reply" | "tool" | "thinking" | "subagent" | "error"
export type RunStepStatus = "completed" | "error" | "running" | "pending"

export type RunStep = {
  readonly ordinal: number
  readonly kind: RunStepKind
  readonly tool?: string
  readonly title: string
  readonly status?: RunStepStatus
  readonly startedAt?: number
  readonly endedAt?: number
  readonly durationMs?: number
  /**
   * Usage for the assistant message this step belongs to. `input`/`output` are
   * unchanged: always paired, always present together.
   *
   * `reasoning` and `cache` are ADDITIVE and OPTIONAL — an absent one is
   * OMITTED, never zeroed, because a fabricated 0 reads as a measurement.
   * Cache-read is not folded into `input` on purpose: a cached turn can carry
   * a hundred times its `input` in cache, which is the whole difference
   * between an expensive turn and a cheap one.
   */
  readonly tokens?: {
    readonly input: number
    readonly output: number
    readonly reasoning?: number
    readonly cache?: { readonly read?: number; readonly write?: number }
  }
  /** The message's own cost. A genuine 0 (a local model) is KEPT, not dropped. */
  readonly cost?: number
  /**
   * True when the assistant message that produced this step recorded NO token
   * usage. A run total summed over the remaining steps is then an UNDERCOUNT,
   * and a consumer must SAY so rather than print a confident wrong number.
   * Emitted only when true, so absent means "this message's usage is here".
   */
  readonly usageMissing?: true
  readonly model?: string
  readonly agent?: string
  readonly preview?: string
  readonly error?: string
  /**
   * True when this subagent was spawned detached (`background: true`), so it ran
   * CONCURRENTLY with the steps that follow it instead of blocking them. Absent
   * on a foreground subagent and on every non-subagent step.
   */
  readonly background?: boolean
  /** Session the subagent ran in — the key that links a spawn to its own run. */
  readonly childSessionId?: string
  /**
   * Nesting level: absent/0 on the reviewed session's own steps, 1 on a
   * subagent's steps, 2 on a subagent's subagent. OPTIONAL by contract — a
   * consumer that ignores it still reads a correct flat run.
   */
  readonly depth?: number
  /** `ordinal` of the subagent step that spawned this one. Only set with `depth`. */
  readonly parentOrdinal?: number
}

export type RunStepsResult = {
  readonly steps: readonly RunStep[]
  readonly truncated: boolean
  readonly total: number
}

// There WAS a 500-step ceiling here. It was removed on 2026-08-03 by design: a
// review that silently drops everything after step 500 is worse than a large
// payload, because the part the reader wants is usually the end of the run. The
// payload growth is accepted; `preview` and PREVIEW_LIMIT keep each step small.
/** Hard cap on any single `preview` excerpt, counted in code points. */
export const PREVIEW_LIMIT = 400
/**
 * Deepest subagent nesting projected: 1 = a subagent's steps, 2 = its own
 * subagent's steps. Level 3 is dropped — the spawning step is still shown, just
 * not expanded. (The engine's own `subagent_depth` defaults to 1, so level 2 is
 * only reachable on a config that raises it.)
 */
export const MAX_SUBAGENT_DEPTH = 2
/**
 * Hard cap on how many child sessions a caller should FETCH to expand one run.
 * Each expansion is a separate `session.messages` read, so an unbounded fan-out
 * would turn one review into a hundred round trips.
 */
export const MAX_CHILD_SESSIONS = 32

/**
 * Tools whose call IS a subagent spawn. Only `task` exists in this fork's
 * registry (tool/task.ts `const id = "task"`); `task_stop`/`task_list` manage
 * existing tasks and stay ordinary tool steps.
 */
const SUBAGENT_TOOLS = new Set(["task"])

/**
 * Part types that carry run bookkeeping rather than a reviewable action.
 * Skipped deliberately — listing them explicitly is what lets a genuinely
 * UNKNOWN (future) part type fall through to a generic step instead.
 */
const STRUCTURAL_PARTS = new Set(["step-start", "step-finish", "snapshot", "patch", "agent", "compaction", "file"])

/** Truncate on code points so a cut never splits a surrogate pair into lone halves. */
function preview(text: string): string | undefined {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  const points = Array.from(trimmed)
  if (points.length <= PREVIEW_LIMIT) return trimmed
  return `${points.slice(0, PREVIEW_LIMIT - 1).join("")}…`
}

function timing(start?: number, end?: number) {
  const hasStart = typeof start === "number" && Number.isFinite(start)
  const hasEnd = typeof end === "number" && Number.isFinite(end)
  return {
    ...(hasStart ? { startedAt: start } : {}),
    ...(hasEnd ? { endedAt: end } : {}),
    ...(hasStart && hasEnd ? { durationMs: Math.max(0, end! - start!) } : {}),
  }
}

/** Assistant errors are NamedError-shaped: `{ name, data: { message? } }`.
 *  Exported for acp/subagent-transcript.ts, which has to read the same field
 *  off the same stored message — a second unwrap would drift from this one. */
export function errorMessage(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined
  const data = (error as { data?: unknown }).data
  if (data && typeof data === "object") {
    const message = (data as { message?: unknown }).message
    if (typeof message === "string" && message) return message
  }
  const name = (error as { name?: unknown }).name
  return typeof name === "string" && name ? name : undefined
}

function firstLine(text: string, fallback: string): string {
  const line = text.trim().split("\n", 1)[0]?.trim()
  if (!line) return fallback
  return line.length > 80 ? `${Array.from(line).slice(0, 79).join("")}…` : line
}

/** Epoch ms the message was created, on user and assistant messages alike.
 *  Exported for acp/event.ts, which stamps the SAME instant onto a replayed
 *  sub-agent's terminal marker — a second reader of `time.created` would be
 *  free to disagree about when a child finished. */
export function messageCreated(info: Message): number | undefined {
  const created = (info as { time?: { created?: unknown } }).time?.created
  return typeof created === "number" && Number.isFinite(created) ? created : undefined
}

/** `tool/task.ts` writes `background: true` into the SAME metadata as `sessionId`. */
function isBackground(part: Extract<Part, { type: "tool" }>): boolean {
  const metadata = (part.state as { metadata?: Record<string, unknown> } | undefined)?.metadata
  return metadata?.["background"] === true
}

/** A number we can actually report. Used for the NEW usage fields only —
 *  `input`/`output` keep the looser `typeof` gate they have always had. */
function finite(n: unknown): number | undefined {
  return typeof n === "number" && Number.isFinite(n) ? n : undefined
}

type Usage = Pick<RunStep, "tokens" | "cost" | "usageMissing">

/**
 * One assistant message's recorded usage, in the projected shape.
 *
 * Every optional field is included only when the store really holds it. When
 * the message recorded no token usage at all the result says `usageMissing`
 * instead of substituting zeros — the difference between "this turn was free"
 * and "we do not know what this turn cost" is the whole point.
 */
function messageUsage(info: Message): Usage {
  const tokens = (
    info as {
      tokens?: { input?: unknown; output?: unknown; reasoning?: unknown; cache?: { read?: unknown; write?: unknown } }
    }
  ).tokens
  const cost = finite((info as { cost?: unknown }).cost)
  const withCost = cost === undefined ? {} : { cost }
  if (!tokens || typeof tokens.input !== "number" || typeof tokens.output !== "number") {
    return { ...withCost, usageMissing: true }
  }
  const read = finite(tokens.cache?.read)
  const write = finite(tokens.cache?.write)
  const cache =
    read === undefined && write === undefined
      ? undefined
      : { ...(read === undefined ? {} : { read }), ...(write === undefined ? {} : { write }) }
  const reasoning = finite(tokens.reasoning)
  return {
    tokens: {
      input: tokens.input,
      output: tokens.output,
      ...(reasoning === undefined ? {} : { reasoning }),
      ...(cache === undefined ? {} : { cache }),
    },
    ...withCost,
  }
}

function modelLabel(info: Message): string | undefined {
  if (info.role === "assistant") {
    return info.providerID && info.modelID ? `${info.providerID}/${info.modelID}` : undefined
  }
  const model = info.model
  return model?.providerID && model?.modelID ? `${model.providerID}/${model.modelID}` : undefined
}

type Draft = Omit<RunStep, "ordinal">

function toolStep(part: Extract<Part, { type: "tool" }>): Draft {
  const state = part.state
  const subagent = SUBAGENT_TOOLS.has(part.tool)
  const kind: RunStepKind = subagent ? "subagent" : "tool"
  const child = subagent ? childSessionId(part) : undefined
  const detached = subagent && isBackground(part)
  const base = {
    kind,
    tool: part.tool,
    ...(child ? { childSessionId: child } : {}),
    ...(detached ? { background: true } : {}),
  }

  // A detached spawn RETURNS the instant the child is launched, so the engine
  // stores it `completed` with an end ~10ms after its start while the subagent
  // itself runs on for minutes. Reporting that as the subagent's own span is the
  // bug: a real stored run has a background task whose tool state says 12ms and
  // whose subagent actually took 1_591_366ms. So the spawn only ever carries the
  // START here; the true end is stitched on in `project` from the completion the
  // engine really injected, and stays ABSENT while the task is still running.
  if (detached && state.status === "completed") {
    return {
      ...base,
      title: state.title || part.tool,
      status: "running",
      ...timing(state.time?.start),
    }
  }

  if (state.status === "completed") {
    return {
      ...base,
      title: state.title || part.tool,
      status: "completed",
      ...timing(state.time?.start, state.time?.end),
      ...(preview(state.output ?? "") ? { preview: preview(state.output ?? "") } : {}),
    }
  }
  if (state.status === "error") {
    return {
      ...base,
      title: part.tool,
      status: "error",
      ...timing(state.time?.start, state.time?.end),
      ...(state.error ? { error: state.error } : {}),
    }
  }
  if (state.status === "running") {
    return {
      ...base,
      title: state.title || part.tool,
      status: "running",
      ...timing(state.time?.start),
    }
  }
  return { ...base, title: part.tool, status: "pending" }
}

/** Map one part to at most one step. Returns undefined for parts we skip. */
function partStep(info: Message, part: Part): Draft | undefined {
  switch (part.type) {
    case "text": {
      if (part.synthetic || part.ignored) return undefined
      const text = part.text ?? ""
      if (!text.trim()) return undefined
      const kind: RunStepKind = info.role === "user" ? "prompt" : "reply"
      return {
        kind,
        title: firstLine(text, kind === "prompt" ? "Prompt" : "Reply"),
        // A part-level start only exists for STREAMED (assistant) parts. A user
        // prompt is never streamed, so `part.time` is undefined on every one of
        // them — and a consumer that needs the whole run timed (the map's thread
        // axis) then fell back to list order on literally every real run, since
        // every run has a prompt. The owning message's created instant IS when
        // the prompt happened, so fall back to it — the same honest instant the
        // `subtask` case below already uses for the same reason.
        ...timing(part.time?.start ?? messageCreated(info), part.time?.end),
        ...(preview(text) ? { preview: preview(text) } : {}),
      }
    }
    case "reasoning": {
      const text = part.text ?? ""
      return {
        kind: "thinking",
        title: "Thinking",
        ...timing(part.time?.start ?? messageCreated(info), part.time?.end),
        ...(preview(text) ? { preview: preview(text) } : {}),
      }
    }
    case "tool":
      return toolStep(part)
    case "subtask":
      // A user-invoked subagent. `SubtaskPart` carries prompt/description/agent
      // and NOTHING else — no time, no status, no session id (schema/src/v1
      // session.ts) — so the only honest instant available is the moment its
      // owning message was created, i.e. when the user invoked it. No end and no
      // status are emitted because the store genuinely holds neither.
      return {
        kind: "subagent",
        title: part.description || part.agent || "Subagent",
        ...(part.agent ? { agent: part.agent } : {}),
        ...timing(messageCreated(info)),
        ...(preview(part.prompt ?? "") ? { preview: preview(part.prompt ?? "") } : {}),
      }
    case "retry":
      // Same story as an unstreamed text part: `RetryPart` carries no time of
      // its own, so without the owning message's instant a single retry made
      // the whole run untimeable.
      return {
        kind: "error",
        title: `Retry ${part.attempt}`,
        status: "error",
        ...timing(messageCreated(info)),
        ...(errorMessage(part.error) ? { error: errorMessage(part.error) } : {}),
      }
    default: {
      // Known bookkeeping parts are dropped on purpose; anything else is a part
      // type this build does not understand yet. Surface it as a generic step
      // rather than throwing — losing one step must never lose the whole run.
      const type = (part as { type?: unknown }).type
      if (typeof type === "string" && STRUCTURAL_PARTS.has(type)) return undefined
      return { kind: "tool", tool: typeof type === "string" ? type : "unknown", title: "Unrecognised step" }
    }
  }
}

/**
 * Session the `task` call spawned. The task tool records it itself —
 * `ctx.metadata({ metadata: { sessionId, parentSessionId, model, … } })` in
 * `tool/task.ts` — and the engine persists that on the tool part's state, for
 * running, completed AND error states alike (pinned by
 * `test/session/prompt.test.ts`'s "running subtask preserves metadata after
 * tool-call transition" and "failed subtask preserves metadata on error tool
 * state"). A `pending` state has no metadata yet, hence the optional chain.
 */
export function childSessionId(part: Part): string | undefined {
  if (!part || typeof part !== "object") return undefined
  if (part.type !== "tool" || !SUBAGENT_TOOLS.has(part.tool)) return undefined
  const id = (part.state as { metadata?: Record<string, unknown> } | undefined)?.metadata?.["sessionId"]
  return typeof id === "string" && id ? id : undefined
}

/**
 * Every child session these messages spawned, in call order, de-duplicated —
 * what a caller needs to fetch before `project` can expand them. Resuming a
 * task (`task_id`) reuses one session across several calls, so the same id can
 * appear more than once.
 */
export function childSessionIds(messages: readonly SessionMessageResponse[]): string[] {
  const seen = new Set<string>()
  for (const message of messages ?? []) {
    for (const part of message?.parts ?? []) {
      if (!part || typeof part !== "object") continue
      const id = childSessionId(part as Part)
      if (id) seen.add(id)
    }
  }
  return [...seen]
}

type Pending = { draft: Draft; child?: string }

/**
 * One message's drafts, already carrying that message's own model/agent/usage.
 * Decorating here rather than over a window of the shared list is what stops a
 * parent's model leaking onto the subagent steps spliced in after it.
 */
function messageDrafts(message: SessionMessageResponse): Pending[] {
  const info = message?.info
  if (!info) return []

  const out: Pending[] = []
  for (const part of message.parts ?? []) {
    if (!part || typeof part !== "object") continue
    const step = partStep(info, part as Part)
    if (!step) continue
    const child = childSessionId(part as Part)
    out.push({ draft: step, ...(child ? { child } : {}) })
  }

  const model = modelLabel(info)
  const agent = info.agent
  for (const entry of out) {
    entry.draft = {
      ...entry.draft,
      ...(model && !entry.draft.model ? { model } : {}),
      ...(agent && !entry.draft.agent ? { agent } : {}),
    }
  }

  if (info.role === "assistant") {
    const usage = messageUsage(info)
    // A request that produced NO reviewable part still ran, and was still
    // billed. Two real shapes do this, both measured in the local store: a
    // message whose only parts are `step-start`/`step-finish` — the provider
    // reported a tool call it never emitted a part for — and a `final_answer`
    // text part that came back empty. 2,665 of 33,718 stored assistant
    // messages are one of the two, carrying 25.9M tokens between them.
    //
    // Attaching usage to "the last step" therefore dropped it whenever there
    // was no step, and took `usageMissing` down with it: the run's total came
    // out SHORT and, worse, UNFLAGGED. One step for the turn is what keeps the
    // sum honest. Only a message that actually measured something earns one —
    // a request with neither parts nor usage is a non-event, and a marker for
    // it would be a node on the map standing for nothing.
    if (out.length === 0 && (usage.tokens !== undefined || usage.cost !== undefined)) {
      out.push({
        draft: {
          kind: "reply",
          title: "No output recorded",
          ...timing(messageCreated(info)),
          ...(model ? { model } : {}),
          ...(agent ? { agent } : {}),
        },
      })
    }
    // Usage is per assistant message, not per part. Attach it to the last
    // step that message produced so a UI totals a run by summing steps
    // instead of double-counting the same message on every one of its parts.
    const last = out.length - 1
    if (last >= 0) {
      out[last]!.draft = { ...out[last]!.draft, ...usage }
    }
    const failure = errorMessage(info.error)
    if (failure) {
      out.push({
        draft: {
          kind: "error",
          title: (info.error as { name?: string } | undefined)?.name ?? "Error",
          status: "error",
          error: failure,
          ...(model ? { model } : {}),
          ...(agent ? { agent } : {}),
        },
      })
    }
  }
  return out
}

/**
 * The marker `tool/task.ts` renders when a background subagent settles. Its
 * `renderOutput` opens every result with `<task id=… state=…>`; the drainer joins
 * a whole BATCH of them into one injected turn, so a single part can carry
 * several and this is matched globally rather than once.
 */
const TASK_RESULT = /<task id="([^"]+)" state="(completed|error)">/g

type Completion = { readonly at: number; readonly status: "completed" | "error" }

/**
 * When each background subagent actually finished, read off the results the
 * engine ALREADY injected back into its parent's stream — `inject`/`drain` in
 * `tool/task.ts` prompt the parent with a synthetic `<task_result>` turn. Nothing
 * is synthesised here: a task with no injected result simply has no entry, which
 * is what makes "still running" distinguishable from "finished".
 *
 * The instant comes from the owning MESSAGE (`info.time.created`) because the
 * injected text part itself is stored with no `time` at all — verified against a
 * real run, where that message lands 4-5ms after the child's own last assistant
 * message completed.
 */
function indexCompletions(messages: readonly SessionMessageResponse[], into: Map<string, Completion>) {
  for (const message of messages ?? []) {
    const info = message?.info
    if (!info) continue
    const at = messageCreated(info as Message)
    if (at === undefined) continue
    for (const part of message?.parts ?? []) {
      if (!part || typeof part !== "object") continue
      const text = part as { type?: unknown; synthetic?: unknown; text?: unknown }
      if (text.type !== "text" || text.synthetic !== true || typeof text.text !== "string") continue
      for (const [, child, status] of text.text.matchAll(TASK_RESULT)) {
        // First result wins: a resumed task can report more than once, and the
        // earliest is the one belonging to the spawn already projected.
        if (child && !into.has(child)) into.set(child, { at, status: status as Completion["status"] })
      }
    }
  }
}

type Collect = {
  readonly children: ReadonlyMap<string, readonly SessionMessageResponse[]> | undefined
  readonly visited: Set<string>
  readonly out: Draft[]
}

/**
 * Append these messages' steps to `out`, expanding any subagent step whose
 * child session was supplied, inline and immediately after it. The push order
 * IS the ordinal order — nothing is ever spliced in later — so a child's
 * ordinal is simply `out.length` at the moment its parent was pushed.
 */
function collect(ctx: Collect, messages: readonly SessionMessageResponse[], depth: number, parentOrdinal?: number) {
  const nest = depth > 0 ? { depth, ...(parentOrdinal === undefined ? {} : { parentOrdinal }) } : {}

  for (const message of messages ?? []) {
    for (const entry of messageDrafts(message)) {
      const ordinal = ctx.out.length
      ctx.out.push({ ...entry.draft, ...nest })

      if (!entry.child || depth >= MAX_SUBAGENT_DEPTH) continue
      // Guards a cycle (a resumed task pointing back up) and stops one child
      // being expanded twice when several calls resumed the same session.
      if (ctx.visited.has(entry.child)) continue
      const kids = ctx.children?.get(entry.child)
      if (!kids) continue
      ctx.visited.add(entry.child)
      collect(ctx, kids, depth + 1, ordinal)
    }
  }
}

/**
 * Project stored messages into ordered steps. Message order is preserved as
 * returned by the engine, parts in their stored order within each message.
 *
 * `ordinal` is the 0-based position in the run and `total` is how many steps
 * there were. Every step is returned, so `truncated` is always false; it stays
 * in the result because the wire shape is the contract.
 *
 * Pass `children` (child sessionID -> that session's messages, fetched by the
 * caller — see `childSessionIds`) to branch subagent runs into the same list:
 * their steps land directly after the spawning step, carrying `depth` and
 * `parentOrdinal`, and share the one contiguous ordinal sequence. A subagent
 * whose messages were NOT supplied still projects as a single step, exactly as
 * before — the map is the only thing that expands anything.
 */
export function project(
  messages: readonly SessionMessageResponse[],
  children?: ReadonlyMap<string, readonly SessionMessageResponse[]>,
): RunStepsResult {
  const drafts: Draft[] = []
  const visited = new Set<string>()
  // Seeded with the reviewed session so a child claiming to be its own parent
  // cannot re-enter the root.
  const root = messages?.[0]?.info?.sessionID
  if (root) visited.add(root)

  collect({ children, visited, out: drafts }, messages ?? [], 0)

  // Stitch each detached spawn to the completion the engine really recorded.
  // Done as a pass over the finished list, never by splicing, so `ordinal` stays
  // the one contiguous sequence `collect` produced.
  const completions = new Map<string, Completion>()
  indexCompletions(messages ?? [], completions)
  // A subagent can itself background a task, so its own stream carries results too.
  for (const list of children?.values() ?? []) indexCompletions(list, completions)

  for (let index = 0; index < drafts.length; index++) {
    const draft = drafts[index]!
    if (!draft.background || !draft.childSessionId) continue
    const done = completions.get(draft.childSessionId)
    if (!done) continue
    drafts[index] = {
      ...draft,
      status: done.status,
      endedAt: done.at,
      ...(typeof draft.startedAt === "number" ? { durationMs: Math.max(0, done.at - draft.startedAt) } : {}),
    }
  }

  const steps = drafts.map((draft, ordinal) => ({ ordinal, ...draft }))
  return { steps, truncated: false, total: drafts.length }
}

export * as RunSteps from "./run-steps"
