import type { Message, Part, SessionMessageResponse } from "@origami/sdk/v2"

/**
 * Read-only projection of a stored run into an ordered, wire-safe step list.
 * Used by the `run_steps` ext method so a shell can review a PAST run without
 * loading/resuming the session. Nothing here mutates.
 */

export type RunStepKind = "prompt" | "reply" | "tool" | "thinking" | "subagent" | "compaction" | "error"
export type RunStepStatus = "completed" | "error" | "running" | "pending"

/** Why a compaction ran, read off the compaction PART's own two booleans
 *  (`auto`, `overflow` - schema/src/v1/session.ts CompactionPart). `unknown` keeps
 *  a stored part that carries neither from degrading to a wrong answer. */
export type CompactionTrigger = "auto" | "manual" | "overflow" | "unknown"

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
   * always paired and always present. `reasoning` and `cache` are ADDITIVE and
   * OPTIONAL - an absent one is OMITTED, never zeroed, because a fabricated 0
   * reads as a measurement. Cache-read is not folded into `input` on purpose: a
   * cached turn can carry a hundred times its `input` in cache.
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
   * Why THIS step read nothing from the provider's prefix cache, as the ENGINE
   * recorded it on the step-finish part (session/cache-policy.ts). A viewer no
   * longer derives a cause: absent means the engine measured none, and the
   * reason is either a cache-blind provider or a run recorded before 0.4.160.
   * A hit carries the facts with NO `cause`.
   */
  readonly cache?: RunStepCache
  /** The prefix digests this step was sent, as stored. `history` is absent on a
   *  run recorded before the digest existed. */
  readonly prefix?: { readonly system: string; readonly tools: string; readonly history?: string }
  /** True when the assistant message that produced this step recorded NO token
   *  usage, so a run total summed over the remaining steps is an UNDERCOUNT and a
   *  consumer must say so. Emitted only when true. */
  readonly usageMissing?: true
  readonly model?: string
  readonly agent?: string
  readonly preview?: string
  readonly error?: string
  /** Only on a `compaction` step. Every member but `trigger` is OPTIONAL and is
   *  OMITTED when the store does not hold it - 0 for either would read as a
   *  measurement. */
  readonly compaction?: {
    readonly trigger: CompactionTrigger
    /** The last billed prompt before the compaction — how big the run got. */
    readonly contextBefore?: number
    /** Output tokens the summary message itself cost. */
    readonly summaryTokens?: number
  }
  /** True when this subagent was spawned detached (`background: true`), so it ran
   *  CONCURRENTLY with the steps that follow it. Absent otherwise. */
  readonly background?: boolean
  /** Session the subagent ran in — the key that links a spawn to its own run. */
  readonly childSessionId?: string
  /** Nesting level: absent/0 on the reviewed session's own steps, 1 on a subagent's,
   *  2 on a subagent's subagent. OPTIONAL by contract. */
  readonly depth?: number
  /** `ordinal` of the subagent step that spawned this one. Only set with `depth`. */
  readonly parentOrdinal?: number
}

/** One cause per miss, in the engine's fixed precedence - see
 *  `session/cache-policy.ts`, which is where it is derived. */
export type RunStepCacheCause =
  | "cold"
  | "model"
  | "compaction"
  | "idle"
  | "system"
  | "tools"
  | "history"
  | "provider"
  | "small"

export type RunStepCache = {
  readonly cause?: RunStepCacheCause
  readonly preserved?: boolean
  readonly divergence?: {
    readonly message: number
    readonly role: string
    readonly offset: number
    readonly source?: "tool-aging" | "reminder" | "plugin" | "unknown"
  }
  readonly idleMs?: number
  readonly ttlSeconds?: number
  readonly warmed?: boolean
}

export type RunStepsResult = {
  readonly steps: readonly RunStep[]
  readonly truncated: boolean
  readonly total: number
}

/** Hard cap on any single `preview` excerpt, counted in code points. */
export const PREVIEW_LIMIT = 400
/** Deepest subagent nesting projected: 1 = a subagent's steps, 2 = its own
 *  subagent's steps. Level 3 is dropped - the spawning step is still shown, just
 *  not expanded. */
export const MAX_SUBAGENT_DEPTH = 2
/** Hard cap on how many child sessions a caller should FETCH to expand one run.
 *  Each expansion is a separate `session.messages` read, so an unbounded fan-out
 *  would turn one review into a hundred round trips. */
export const MAX_CHILD_SESSIONS = 32

/** Tools whose call IS a subagent spawn. Only `task` exists in this fork's registry
 *  (tool/task.ts); `task_stop`/`task_list` manage existing tasks and stay ordinary
 *  tool steps. */
const SUBAGENT_TOOLS = new Set(["task"])

/**
 * Part types that carry run bookkeeping rather than a reviewable action. Listing
 * them explicitly lets a genuinely UNKNOWN (future) part type fall through to a
 * generic step instead. `compaction` is deliberately NOT here - it throws the
 * prompt cache away, so a review that drops it shows the cost with no cause.
 */
const STRUCTURAL_PARTS = new Set(["step-start", "step-finish", "snapshot", "patch", "agent", "file"])

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
 *  Exported for acp/subagent-transcript.ts so a second unwrap cannot drift. */
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
 *  sub-agent's terminal marker. */
export function messageCreated(info: Message): number | undefined {
  const created = (info as { time?: { created?: unknown } }).time?.created
  return typeof created === "number" && Number.isFinite(created) ? created : undefined
}

/** `tool/task.ts` writes `background: true` into the SAME metadata as `sessionId`. */
function isBackground(part: Extract<Part, { type: "tool" }>): boolean {
  const metadata = (part.state as { metadata?: Record<string, unknown> } | undefined)?.metadata
  return metadata?.["background"] === true
}

/** A number we can actually report. Used for the NEW usage fields only - `input`/`output` keep
 *  their looser gate. */
function finite(n: unknown): number | undefined {
  return typeof n === "number" && Number.isFinite(n) ? n : undefined
}

type Usage = Pick<RunStep, "tokens" | "cost" | "usageMissing">

/**
 * One assistant message's recorded usage, in the projected shape. Every optional
 * field is included only when the store really holds it; a message that recorded
 * no token usage says `usageMissing` rather than substituting zeros.
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

const CACHE_CAUSES = new Set<string>([
  "cold",
  "model",
  "compaction",
  "idle",
  "system",
  "tools",
  "history",
  "provider",
  "small",
])
const DIVERGENCE_SOURCES = new Set<string>(["tool-aging", "reminder", "plugin", "unknown"])

/** What one stored `step-finish` part says about its cached prefix, in the
 *  projected shape. Read defensively: these rows outlive the build that wrote
 *  them, and an unrecognised cause is dropped rather than passed on as a label
 *  no reader has a sentence for. Undefined when the part carries neither. */
function stepCacheFacts(part: unknown): Pick<RunStep, "cache" | "prefix"> | undefined {
  const raw = part as {
    cache?: {
      cause?: unknown
      preserved?: unknown
      divergence?: { message?: unknown; role?: unknown; offset?: unknown; source?: unknown }
      idleMs?: unknown
      ttlSeconds?: unknown
      warmed?: unknown
    }
    prefix?: { system?: unknown; tools?: unknown; history?: unknown }
  }
  const digests =
    typeof raw.prefix?.system === "string" && typeof raw.prefix.tools === "string"
      ? {
          system: raw.prefix.system,
          tools: raw.prefix.tools,
          ...(typeof raw.prefix.history === "string" ? { history: raw.prefix.history } : {}),
        }
      : undefined
  const divergence = raw.cache?.divergence
  const cache = raw.cache
    ? {
        ...(cacheCause(raw.cache.cause) ? { cause: cacheCause(raw.cache.cause) } : {}),
        ...(typeof raw.cache.preserved === "boolean" ? { preserved: raw.cache.preserved } : {}),
        ...(divergence && finite(divergence.message) !== undefined && finite(divergence.offset) !== undefined
          ? {
              divergence: {
                message: divergence.message as number,
                role: typeof divergence.role === "string" ? divergence.role : "unknown",
                ...(typeof divergence.source === "string" && DIVERGENCE_SOURCES.has(divergence.source)
                  ? { source: divergence.source as NonNullable<RunStepCache["divergence"]>["source"] }
                  : {}),
                offset: divergence.offset as number,
              },
            }
          : {}),
        ...(finite(raw.cache.idleMs) === undefined ? {} : { idleMs: raw.cache.idleMs as number }),
        ...(finite(raw.cache.ttlSeconds) === undefined ? {} : { ttlSeconds: raw.cache.ttlSeconds as number }),
        ...(typeof raw.cache.warmed === "boolean" ? { warmed: raw.cache.warmed } : {}),
      }
    : undefined
  if (!cache && !digests) return undefined
  return { ...(cache ? { cache } : {}), ...(digests ? { prefix: digests } : {}) }
}

/** A cause this build has a sentence for, or undefined. */
function cacheCause(value: unknown): RunStepCacheCause | undefined {
  if (typeof value !== "string" || !CACHE_CAUSES.has(value)) return undefined
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- guarded by CACHE_CAUSES above
  return value as RunStepCacheCause
}

function modelLabel(info: Message): string | undefined {
  if (info.role === "assistant") {
    return info.providerID && info.modelID ? `${info.providerID}/${info.modelID}` : undefined
  }
  const model = info.model
  return model?.providerID && model?.modelID ? `${model.providerID}/${model.modelID}` : undefined
}

type Draft = Omit<RunStep, "ordinal">

/** What a compaction can say beyond its own trigger. Both members optional. */
type CompactionFact = { readonly contextBefore?: number; readonly summaryTokens?: number }

/** `session/compaction.ts` `create` writes `auto` always and `overflow` only on the
 *  media-overflow path, so overflow OUTRANKS auto: an overflow compaction is also
 *  an automatic one, and the narrower fact is the useful one. */
function compactionTrigger(part: Extract<Part, { type: "compaction" }>): CompactionTrigger {
  if (part.overflow === true) return "overflow"
  if (part.auto === true) return "auto"
  if (part.auto === false) return "manual"
  return "unknown"
}

/**
 * What each compaction in ONE session's messages can say about itself beyond its
 * trigger, keyed by the id of the message that carries the compaction part.
 * CONTEXT BEFORE is the last BILLED prompt before the compaction - nothing in the
 * store records the context window itself. THE SUMMARY is the assistant message
 * whose `parentID` is that compaction message and whose `summary` flag is set; its
 * `input` is deliberately NOT counted as a billed prompt because the summary
 * re-reads the whole PRE-compaction history.
 */
function compactionFacts(messages: readonly SessionMessageResponse[]): Map<string, CompactionFact> {
  const out = new Map<string, CompactionFact>()
  let billed: number | undefined
  for (const message of messages ?? []) {
    const info = message?.info
    if (!info) continue
    if ((message.parts ?? []).some((part) => (part as { type?: unknown } | null)?.type === "compaction")) {
      out.set(info.id, billed === undefined ? {} : { contextBefore: billed })
      continue
    }
    if (info.role !== "assistant") continue
    const tokens = (info as { tokens?: { input?: unknown; output?: unknown } }).tokens
    const parent = (info as { summary?: unknown }).summary === true ? info.parentID : undefined
    if (parent !== undefined && out.has(parent)) {
      const summaryTokens = finite(tokens?.output)
      if (summaryTokens !== undefined) out.set(parent, { ...out.get(parent)!, summaryTokens })
      continue
    }
    const input = finite(tokens?.input)
    if (input !== undefined && input > 0) billed = input
  }
  return out
}

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
  // stores it `completed` with an end ~10ms after its start while the subagent runs
  // on for minutes. The spawn therefore carries only the START here; the true end is
  // stitched on in `project`, and stays ABSENT while the task is still running.
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

/** Map one part to at most one step. Returns undefined for parts we skip. `fact` is
 *  this MESSAGE's compaction fact, which only a compaction part uses. */
function partStep(info: Message, part: Part, fact?: CompactionFact): Draft | undefined {
  switch (part.type) {
    case "text": {
      if (part.synthetic || part.ignored) return undefined
      const text = part.text ?? ""
      if (!text.trim()) return undefined
      const kind: RunStepKind = info.role === "user" ? "prompt" : "reply"
      return {
        kind,
        title: firstLine(text, kind === "prompt" ? "Prompt" : "Reply"),
        // A part-level start only exists for STREAMED (assistant) parts, so
        // `part.time` is undefined on every user prompt. The owning message's
        // created instant IS when the prompt happened, so fall back to it.
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
      // A user-invoked subagent. `SubtaskPart` carries prompt/description/agent and
      // NOTHING else - no time, no status, no session id - so the only honest
      // instant is the moment its owning message was created.
      return {
        kind: "subagent",
        title: part.description || part.agent || "Subagent",
        ...(part.agent ? { agent: part.agent } : {}),
        ...timing(messageCreated(info)),
        ...(preview(part.prompt ?? "") ? { preview: preview(part.prompt ?? "") } : {}),
      }
    case "compaction":
      // The engine writes this part onto a user message of its OWN making
      // (session/compaction.ts `create`), and the part carries no time of its own.
      return {
        kind: "compaction",
        title: "Context compacted",
        ...timing(messageCreated(info)),
        compaction: { trigger: compactionTrigger(part), ...(fact ?? {}) },
      }
    case "retry":
      // Same story as an unstreamed text part: `RetryPart` carries no time of its
      // own, so without the owning message's instant a retry makes a run untimeable.
      return {
        kind: "error",
        title: `Retry ${part.attempt}`,
        status: "error",
        ...timing(messageCreated(info)),
        ...(errorMessage(part.error) ? { error: errorMessage(part.error) } : {}),
      }
    default: {
      // Known bookkeeping parts are dropped on purpose; anything else is a part type
      // this build does not understand yet. Surface it rather than throwing.
      const type = (part as { type?: unknown }).type
      if (typeof type === "string" && STRUCTURAL_PARTS.has(type)) return undefined
      return { kind: "tool", tool: typeof type === "string" ? type : "unknown", title: "Unrecognised step" }
    }
  }
}

/** Session the `task` call spawned. The task tool records it itself via
 *  `ctx.metadata` in `tool/task.ts`, and the engine persists it on the tool part's
 *  state for running, completed AND error states. A `pending` state has none yet. */
export function childSessionId(part: Part): string | undefined {
  if (!part || typeof part !== "object") return undefined
  if (part.type !== "tool" || !SUBAGENT_TOOLS.has(part.tool)) return undefined
  const id = (part.state as { metadata?: Record<string, unknown> } | undefined)?.metadata?.["sessionId"]
  return typeof id === "string" && id ? id : undefined
}

/** Every child session these messages spawned, in call order, de-duplicated - what a
 *  caller needs to fetch before `project` can expand them. Resuming a task
 *  (`task_id`) reuses one session across calls, so an id can appear more than once. */
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

/** One message's drafts, already carrying that message's own model/agent/usage.
 *  Decorating here stops a parent's model leaking onto subagent steps spliced in. */
function messageDrafts(message: SessionMessageResponse, fact?: CompactionFact): Pending[] {
  const info = message?.info
  if (!info) return []

  const out: Pending[] = []
  // A `step-finish` part ENDS one model step, so its cached-prefix facts belong
  // to the last step this message produced BEFORE it - the reply or tool call of
  // that same model step, which is also where `tokens` lands on a single-step
  // message. `closed` is how far the previous step-finish already claimed, so a
  // message with several of them puts each step's cause on its own step.
  let closed = 0
  let orphan: Pick<RunStep, "cache" | "prefix"> | undefined
  for (const part of message.parts ?? []) {
    if (!part || typeof part !== "object") continue
    if ((part as { type?: unknown }).type === "step-finish") {
      const facts = stepCacheFacts(part)
      if (!facts) continue
      // A step that produced no reviewable part at all: held for the synthetic
      // step below rather than stamped onto a neighbouring step's row.
      if (out.length === closed) orphan = facts
      if (out.length > closed) {
        out[out.length - 1]!.draft = { ...out[out.length - 1]!.draft, ...facts }
        closed = out.length
      }
      continue
    }
    const step = partStep(info, part as Part, fact)
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
    // A request that produced NO reviewable part still ran, and was still billed:
    // a message whose only parts are `step-start`/`step-finish`, or a `final_answer`
    // text part that came back empty. Attaching usage to "the last step" dropped it
    // whenever there was no step, and took `usageMissing` with it - the run's total
    // came out SHORT and UNFLAGGED. One step for the turn keeps the sum honest.
    if (out.length === 0 && (usage.tokens !== undefined || usage.cost !== undefined)) {
      out.push({
        draft: {
          kind: "reply",
          title: "No output recorded",
          ...timing(messageCreated(info)),
          ...(model ? { model } : {}),
          ...(agent ? { agent } : {}),
          ...(orphan ?? {}),
        },
      })
    }
    // Usage is per assistant message, not per part. Attach it to the last step that
    // message produced so a UI totals a run without double-counting.
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

/** The marker `tool/task.ts` renders when a background subagent settles. The drainer
 *  joins a whole BATCH of them into one injected turn, so a single part can carry
 *  several and this is matched globally rather than once. */
const TASK_RESULT = /<task id="([^"]+)" state="(completed|error)">/g

type Completion = { readonly at: number; readonly status: "completed" | "error" }

/**
 * When each background subagent actually finished, read off the results the engine
 * ALREADY injected back into its parent's stream (`inject`/`drain` in `tool/task.ts`).
 * Nothing is synthesised here: a task with no injected result has no entry, which is
 * what makes "still running" distinguishable from "finished". The instant comes from
 * the owning MESSAGE (`info.time.created`) because the injected text part itself is
 * stored with no `time` at all.
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

/** Append these messages' steps to `out`, expanding any subagent step whose child
 *  session was supplied, inline and immediately after it. The push order IS the
 *  ordinal order, so a child's ordinal is `out.length` when its parent was pushed. */
function collect(ctx: Collect, messages: readonly SessionMessageResponse[], depth: number, parentOrdinal?: number) {
  const nest = depth > 0 ? { depth, ...(parentOrdinal === undefined ? {} : { parentOrdinal }) } : {}
  // Per LIST, never across lists: a sub-agent's compaction reads its own
  // session's billed prompts, not its parent's.
  const facts = compactionFacts(messages ?? [])

  for (const message of messages ?? []) {
    for (const entry of messageDrafts(message, facts.get(message?.info?.id ?? ""))) {
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
 * Project stored messages into ordered steps, preserving message and part order.
 * `ordinal` is the 0-based position in the run and `total` is how many steps there
 * were. Every step is returned, so `truncated` is always false; it stays in the
 * result because the wire shape is the contract.
 *
 * Pass `children` (child sessionID -> that session's messages, see
 * `childSessionIds`) to branch subagent runs into the same list: their steps land
 * directly after the spawning step with `depth`/`parentOrdinal`, sharing the one
 * contiguous ordinal sequence. A subagent whose messages were NOT supplied still
 * projects as a single step.
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

  // Stitch each detached spawn to the completion the engine really recorded. Done as
  // a pass over the finished list so `ordinal` stays the sequence `collect` produced.
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
