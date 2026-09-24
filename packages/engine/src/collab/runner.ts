import { Cause, Context, Effect, Exit, Fiber, Layer } from "effect"
import { LayerNode } from "@origami/core/effect/layer-node"
import { SessionRunCoordinator } from "@origami/core/session/run-coordinator"
import { PermissionV1 } from "@origami/core/v1/permission"
import { SessionV1 } from "@origami/core/v1/session"
import { CollabActivity } from "./activity"
import { CollabCouncil } from "./council"
import { CollabParallel } from "./parallel"
import { CollabRules } from "./rules"
import { CollabState } from "./collab-state"
import { CollabStore } from "./store"
import { CollabSystem } from "./collab-system"
import { Agent } from "@/agent/agent"
import { CollabSeal } from "./seal"
import { deriveSubagentSessionPermission } from "@/agent/subagent-permissions"
import { InstanceRef } from "@/effect/instance-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import type { InstanceContext } from "@/project/instance-context"
import { SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"

/**
 * Drives Collab turns.
 *
 * ONE turn at a time per COLLAB by default: a message that wakes several agents joins
 * them to the collab's FIFO queue in roster order, drained one at a time. Each turn's
 * envelope is built AT DRAIN TIME, so a later agent reads the earlier one's fresh reply
 * and can choose silence. A room may OPT OUT with `concurrency: N` (CollabParallel):
 * N workers share the one queue. A COUNCIL room (CollabCouncil) goes further - one
 * question to every member at once, each cut at the question, then ONE reconciles them.
 *
 * An `ask` nests INSIDE the caller's drain slot rather than joining the queue, or the
 * collab would deadlock against itself. Agents post only FINISHED messages: a partial
 * turn is not a contribution, and the fan-out it triggers cannot be taken back.
 */

/** Agent turns one human message buys before the room waits on a human again. */
export const LOOP_BREAKER_DEFAULT = 20

/** How many room messages ride under an ask or hand-off brief. */
export const BRIEF_HISTORY = 10

/**
 * What ONE claimed turn is, decided at claim time and unchanged for its life.
 *  - `ceiling` is the cut its envelope is read at: none for a serial turn, the DISPATCH
 *    MARK for a parallel one, the ROUND'S mark for a council opinion - which is what
 *    keeps a five-member council blind on a four-wide scheduler.
 *  - `round` is the council bookkeeping this turn belongs to, so a turn from a replaced
 *    round can be told from one of the live round.
 */
type TurnDispatch = {
  readonly ceiling?: number
  readonly round?: CollabCouncil.Dispatch
}

export type AgentState = "idle" | "queued" | "running"

export type AgentStatus = {
  readonly state: AgentState
  /** The last turn failure for this agent, kept until its next turn starts. */
  readonly lastError?: string
}

/** What one turn spent, as the ledger records it. */
export type Spend = {
  readonly model: string
  readonly tokensInput: number
  readonly tokensOutput: number
  readonly cost: number
}

export type TurnInput = {
  readonly collabId: string
  readonly agentSlug: string
  readonly sessionId: string
  /** The turn's whole context: system layers, room facts and tool handles. */
  readonly turn: CollabSystem.TurnContext
  /** The one synthetic user message: a brief, or the messages this agent missed. */
  readonly text: string
  /** Images riding that same synthetic user message, in the shape a chat prompt carries
   *  them. Present ONLY for an agent whose definition declared vision. */
  readonly images?: readonly SessionV1.FilePartInput[]
  /**
   * Run this turn READ-ONLY, whatever the definition says it may do.
   *
   * Set for both halves of a COUNCIL ROUND and anything a round turn asks for: a council
   * dispatches side by side, and two agents writing one file at once is corruption, not a
   * race a room can referee. A FLAG rather than a ruleset - what `CollabSeal.COUNCIL_SEAL`
   * composes against is the child session's live permission, which only the session-store
   * owner can read.
   */
  readonly sealed?: true
}

export type TurnOutcome = {
  /** The agent's final text. Empty is silence, which is a choice. */
  readonly text: string
  /** What its tools did, compacted for the room. */
  readonly trace?: readonly CollabStore.TraceEntry[]
  /** What it cost. Absent only when the caller cannot measure it. */
  readonly cost?: Spend
  /** Set when the turn stopped on its STEP CAP rather than on its own. The result reads
   *  perfectly normal otherwise, which is exactly the danger. */
  readonly stepCapped?: boolean
}

export type HopState = {
  /** null = the budget is OFF, so nothing ever counts against it. */
  readonly remaining: number | null
  readonly cap: number | null
}

export type Deps = {
  readonly store: CollabStore.Interface
  /** The agent's display label. Falls back to the slug when unknown. */
  readonly displayName: (agentSlug: string) => Effect.Effect<string, unknown>
  /** Create the agent's persistent child session and answer with its id. */
  readonly createSession: (input: { collab: CollabStore.Collab; agentSlug: string }) => Effect.Effect<string, unknown>
  /** Run ONE turn to completion and answer with what it produced. */
  readonly turn: (input: TurnInput) => Effect.Effect<TurnOutcome, unknown>
  /** The most recent message, with parts, in an agent's child session - read to derive
   *  `liveActivity`. Optional: a caller that never sets it up gets no activity, ever. */
  readonly latestMessage?: (sessionId: string) => Effect.Effect<SessionV1.WithParts | undefined, unknown>
  /** Whether this agent's DEFINITION declared that its model can see. Optional: unwired,
   *  every agent is blind, which is the safe default - a sighted agent that is really
   *  blind would be sent an attachment its provider rejects. */
  readonly vision?: (agentSlug: string) => Effect.Effect<boolean, unknown>
  /** Cancel whatever one agent's CHILD SESSION is doing. Used by `stopAgent`, which
   *  interrupts the runner's fiber - that stops the ROOM waiting, but the model call is
   *  the session layer's to end, and an orphan keeps burning tokens. Optional: without it
   *  a stop still frees the room. */
  readonly abort?: (sessionId: string) => Effect.Effect<void, unknown>
}

/** What one {@link Interface.stopAgent} actually did. Never a bare ok. */
export type StopAgentResult = {
  /** A turn was in flight for this agent and has been interrupted. */
  readonly interrupted: boolean
  /** This agent was waiting for a turn and has been taken out of the queue. */
  readonly dequeued: boolean
}

export interface Interface {
  readonly post: (input: {
    collabId: string
    text: string
    /** The agents this post addresses. Empty reaches the lead alone. */
    mentions?: readonly string[]
    /** A board move the human made. Absent is an ordinary room message. */
    kind?: CollabStore.MessageKind
    taskId?: string
    /** Images the human attached, as `data:` URLs. Validated by the caller. */
    images?: readonly string[]
  }) => Effect.Effect<CollabStore.Message>
  /** Per-agent turn status for one collab, keyed by slug. */
  readonly statuses: (collabId: string) => Effect.Effect<Map<string, AgentStatus>>
  /** The in-progress signals for every agent CURRENTLY RUNNING in this collab, keyed by
   *  slug. Idle, finished and failed all read the same way: missing, never stale. */
  readonly liveActivity: (collabId: string) => Effect.Effect<Map<string, LiveSignal>>
  /**
   * The last {@link CollabActivity.ACTIVITY_LOG_MAX} signals each agent produced, oldest
   * first, keyed by slug. An agent with nothing kept is missing from the map.
   *
   * Filled by {@link Interface.liveActivity}, so a turn that starts AND finishes between
   * two polls leaves nothing here; its tools are on the room message's trace instead.
   */
  readonly activityLog: (collabId: string) => Effect.Effect<Map<string, readonly CollabActivity.ActivityEntry[]>>
  /** What is left of this human message's hop budget. */
  readonly hopState: (collabId: string) => Effect.Effect<HopState>
  /** Stop a running collab: interrupt the drain, drop everything queued and spend the
   *  rest of the budget. The next human post buys a new one. */
  readonly stop: (collabId: string) => Effect.Effect<void>
  /**
   * Stop ONE agent and leave the room running: its turn in flight is interrupted, its
   * child session cancelled, and its slug alone comes out of the queue.
   *
   * NOT a room stop: the hop budget is untouched, and nothing is appended - a row saying
   * a control was pressed would reach every other agent as if a participant said it. An
   * agent running NESTED inside another's ask answers `interrupted: false`.
   */
  readonly stopAgent: (collabId: string, agentSlug: string) => Effect.Effect<StopAgentResult>
  /**
   * Correct ONE agent: a human message addressed to it alone, and its turn moved to the
   * FRONT of the queue so the correction lands before the work it corrects continues.
   *
   * A message, not a control - it goes into the log as an ordinary addressed human post
   * and buys a fresh hop budget. Nobody else is woken by it.
   */
  readonly redirect: (input: {
    collabId: string
    agentSlug: string
    text: string
  }) => Effect.Effect<CollabStore.Message>
  /** Remember which workspace a collab belongs to. Turns run detached from the request
   *  that triggered them, so the instance context has to be carried here. */
  readonly bind: (collabId: string, context: InstanceContext | undefined) => Effect.Effect<void>
  /** Resolves once no collab turn is running. For tests and shutdown checks. */
  readonly settle: Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@origami/Collab/Runner") {}

export function effectiveCap(cap: number | null | undefined): number {
  return cap ?? LOOP_BREAKER_DEFAULT
}

/** The budget one human message buys. A cap of 0 is OFF (overnight mode) and reports
 *  `null`, so a shell says "no budget" rather than showing a number that never moves.
 *  Anything below 0 is treated the same way. */
export function startingHops(cap: number | null | undefined): number | null {
  const limit = effectiveCap(cap)
  return limit <= 0 ? null : limit
}

/** True when the budget is spent and the room is waiting on a human. */
export function spent(hops: CollabSystem.Hops): boolean {
  return hops.remaining !== null && hops.remaining <= 0
}

/** Spend one hop, where a turn BEGINS - at the drain for a queued turn, inline for a
 *  nested ask. Charging at the start rather than at the enqueue is what makes the second
 *  gate real: a queued turn that never runs costs nothing, and `stop` can hold the whole
 *  queue by zeroing the budget. */
export function charge(hops: CollabSystem.Hops): void {
  if (hops.remaining !== null) hops.remaining -= 1
}

/**
 * Check and spend in ONE step. Answers whether the turn may run.
 *
 * Read-then-charge is not a budget once turns dispatch side by side: three turns that
 * each read "2 left" before any pays run three turns on two hops. Nothing suspends
 * between the read and the write here, whatever the dispatch width.
 */
export function tryCharge(hops: CollabSystem.Hops): boolean {
  if (hops.remaining === null) return true
  if (hops.remaining <= 0) return false
  hops.remaining -= 1
  return true
}

/** The one synthetic user message an ordinary turn receives: what it missed, and nothing
 *  else. The operating manual is SYSTEM material (see `systemLayers`) - standing rules
 *  delivered as a user message read as something a participant just said. The agent's OWN
 *  messages are left out; they are already its own assistant turns. */
export function envelope(input: {
  title: string
  agentSlug: string
  messages: readonly CollabStore.Message[]
}): string {
  const lines = envelopeWindow(input.agentSlug, input.messages).map((message) => `${message.authorId}: ${message.text}`)
  return [`[Collab: ${input.title}] New messages:`, ...lines].join("\n")
}

/** The messages an ENVELOPE renders: the batch minus the reader's own. Exported so the
 *  image sweep reads exactly the window the text does - an image counted off a message
 *  the envelope never rendered arrives with no line of context beside it. */
export function envelopeWindow(
  agentSlug: string,
  messages: readonly CollabStore.Message[],
): readonly CollabStore.Message[] {
  return messages.filter((message) => message.authorId !== agentSlug)
}

/** The messages a BRIEF renders under its heading: the last {@link BRIEF_HISTORY} of them. */
export function briefWindow(
  agentSlug: string,
  messages: readonly CollabStore.Message[],
): readonly CollabStore.Message[] {
  return envelopeWindow(agentSlug, messages).slice(-BRIEF_HISTORY)
}

/** Every image one window of room messages carries, oldest first. */
export function imagesOf(messages: readonly CollabStore.Message[]): string[] {
  return messages.flatMap((message) => [...(message.images ?? [])])
}

/** The mime a `data:` URL declares, or the safe generic when it declares none. The type
 *  ends at the FIRST `;` or `,`: a URL may carry its payload straight after the type, and
 *  reading to the `;` alone would swallow the payload into the mime. */
export function mimeOf(dataUrl: string): string {
  const head = dataUrl.slice("data:".length)
  const end = head.search(/[;,]/)
  const declared = end === -1 ? head : head.slice(0, end)
  return declared.includes("/") ? declared : "application/octet-stream"
}

/** One posted image as a prompt PART, in exactly the shape a chat prompt already carries
 *  an attachment (`ACPContent.contentBlockToParts`) - the request layer, the provider
 *  transforms and every recorded session already handle this one shape. */
export function imagePart(dataUrl: string): SessionV1.FilePartInput {
  return { type: "file", url: dataUrl, filename: "image", mime: mimeOf(dataUrl) }
}

/** What an agent that CANNOT see is told in place of the images. Silence would be worse:
 *  the room would discuss a picture it has no idea exists. Naming the way out - another
 *  participant can look - turns a dead end into a routable step. */
export function blindNote(count: number): string {
  return `[The human posted ${count} image(s) here that you cannot see. A participant whose model has vision can look and describe them.]`
}

/** The synthetic user message a turn actually receives, once the room's images are
 *  resolved against what the agent can see. No images: the text is returned unchanged. */
export function withImages(input: { text: string; images: readonly string[]; vision: boolean }): {
  text: string
  images?: readonly SessionV1.FilePartInput[]
} {
  if (input.images.length === 0) return { text: input.text }
  if (!input.vision) return { text: `${input.text}\n${blindNote(input.images.length)}` }
  return { text: input.text, images: input.images.map(imagePart) }
}

/**
 * The brief a tool wake carries: who is asking, for what, and what they want back -
 * PINNED above the room's recent history. Delivered as "messages you missed" an ask
 * arrived as one line among ten, and the target answered the room instead of the asker.
 *
 * `taskId` names the board row the ask or hand-off opened, or the target matches titles
 * against the board and may complete somebody else's task.
 */
export function brief(input: {
  title: string
  agentSlug: string
  from: string
  task: string
  context?: string
  expect?: string
  /** The auto-task this brief belongs to, when the caller opened one. */
  taskId?: string
  messages: readonly CollabStore.Message[]
}): string {
  const recent = briefWindow(input.agentSlug, input.messages).map((message) => `${message.authorId}: ${message.text}`)
  return [
    `[Collab: ${input.title}]`,
    `FROM: @${input.from}`,
    `TASK: ${input.task.trim()}`,
    ...(input.context?.trim() ? [`CONTEXT: ${input.context.trim()}`] : []),
    ...(input.expect?.trim() ? [`EXPECTED BACK: ${input.expect.trim()}`] : []),
    ...(input.taskId ? [`Board task: ${input.taskId}`] : []),
    "",
    "Recent room messages:",
    ...recent,
  ].join("\n")
}

/** The tools whose use means the target ROUTED the work itself this turn: `ask` returns
 *  to the target, `handoff` moves the baton on, `task_done` closes the board row by hand.
 *  The auto-return below must not make a second routing decision on top of one of these. */
export const ROUTING_TOOLS: ReadonlySet<string> = new Set(["ask", "handoff", "task_done"])

/** Marks a board result the RUNNER wrote, not the agent that owns the task. */
export const AUTO_RESULT_PREFIX = "[auto]"

/** The auto-result for a target that ended its turn with no text at all. */
export const AUTO_SILENT_RESULT = "(turn ended in silence)"

/**
 * Whether a finished turn moved its work somewhere the board can see.
 *
 * `done` deliberately does NOT count - it says "my turn is over", not "the work left my
 * hands" - so a hand-off target ending with done("finished it") must still auto-close.
 * A CALL THAT FAILED ROUTED NOTHING: a refused `task_done` left the work where it was,
 * and `traceOf` marks a refusal `error`, which is what tells the two apart.
 */
export function routed(input: { stop: CollabSystem.Stop; trace?: readonly CollabStore.TraceEntry[] }): boolean {
  if (input.stop.requested && input.stop.kind === "handoff") return true
  return (input.trace ?? []).some((entry) => ROUTING_TOOLS.has(entry.tool) && entry.status !== "error")
}

/** The SYSTEM layers one turn adds: the collab agent base prompt ABOVE the agent's
 *  persona, and the room state below it. Both are read fresh per turn, so a
 *  `collab-agent-base.md` edit or a roster change lands on the next turn with no restart. */
export function systemLayers(input: {
  title: string
  agentSlug: string
  displayName: string
  roster: readonly CollabState.RosterEntry[]
  lead: string | null
  objective: string | null
  hops: { remaining: number | null }
  tasks: readonly CollabState.TaskSummary[]
}): CollabSystem.Layers {
  return { base: CollabSystem.agentBase(), state: CollabState.roomState(input) }
}

/** The compact record of what one turn's tools did. */
export function traceOf(messages: readonly SessionV1.WithParts[]): CollabStore.TraceEntry[] {
  const entries: CollabStore.TraceEntry[] = []
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "tool") continue
      const state = part.state
      const title = "title" in state && typeof state.title === "string" ? state.title : undefined
      const input = "input" in state && state.input && typeof state.input === "object" ? state.input : undefined
      // The ARGUMENT first, and the tool's own title only as a fallback: the room wants
      // "read src/app.ts", and a title is often the tool's own name again.
      const first = input
        ? Object.values(input).find((value): value is string => typeof value === "string" && value.length > 0)
        : undefined
      // A REFUSED FLOCK TOOL IS A FAILED ONE. `refuse()` hands the model a plain-text
      // result rather than an error, so the part COMPLETES and every status check above
      // would call it "ok". The metadata flag is the only thing that separates them.
      const refused = "metadata" in state && state.metadata?.["refused"] === true
      entries.push({
        tool: part.tool,
        summary: first ?? title ?? "",
        status: state.status === "error" || refused ? "error" : "ok",
      })
    }
  }
  return entries
}

/** What one turn cost, summed over its STEP-FINISH parts. Not `Assistant.tokens`, which
 *  is last-write-wins per assistant message, and not one message either: a turn spans one
 *  assistant message per loop iteration, so a ten-step turn billed off the last message
 *  reports its final step alone. */
export function spendOf(messages: readonly SessionV1.WithParts[]) {
  let cost = 0
  let tokensInput = 0
  let tokensOutput = 0
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "step-finish") continue
      cost += part.cost
      tokensInput += part.tokens.input
      tokensOutput += part.tokens.output
    }
  }
  return { cost, tokensInput, tokensOutput }
}

/** The `collab_state` wire's `liveActivity`: one signal, while a turn runs. */
export type LiveActivity = CollabActivity.ActivitySignal

/** What one running agent shows the room this instant: the ONE-LINE signal a roster chip
 *  renders, and the whole reasoning so far, which the shell expands. Both are read from
 *  the same message on the same poll, and both are absent rather than stale. */
export type LiveSignal = {
  readonly activity?: LiveActivity
  readonly thought?: string
}

/** The wire's bound on `liveThought`. Far larger than one signal because it is a
 *  different thing: the chip shows the newest line, this shows the reasoning a human reads. */
export const LIVE_THOUGHT_MAX_CHARS = 4000

/** The one in-progress signal for a turn still running: the most recently written tool or
 *  reasoning part, found by walking the parts back to front. A tool call almost always
 *  follows the reasoning that led to it, so walking from the end prefers the tool without
 *  leaving a reasoning-only step showing a stale call. `undefined` once the turn's own
 *  assistant message is complete, and when there is nothing yet to show. */
export function liveActivityOf(message: SessionV1.WithParts | undefined): LiveActivity | undefined {
  if (!message) return undefined
  if (!inProgress(message)) return undefined
  for (let i = message.parts.length - 1; i >= 0; i--) {
    const part = message.parts[i]!
    if (part.type === "tool") return CollabActivity.toolActivity(part)
    if (part.type === "reasoning") return CollabActivity.thoughtActivity(part)
  }
  return undefined
}

/** The turn's own assistant message, still being written. The gate both signals share. */
function inProgress(message: SessionV1.WithParts): boolean {
  const info = message.info
  return info.role === "assistant" && info.time.completed === undefined
}

/** The WHOLE reasoning of a turn still running: every reasoning part of its assistant
 *  message, in order, joined. `liveActivityOf` answers "what is it doing right now";
 *  this answers "what has it been thinking", which one newest part would truncate. The
 *  TAIL is kept when it overruns, and it is absent, never stale. */
export function liveThoughtOf(message: SessionV1.WithParts | undefined): string | undefined {
  if (!message) return undefined
  if (!inProgress(message)) return undefined
  const parts: string[] = []
  for (const part of message.parts) {
    if (part.type !== "reasoning") continue
    const text = part.text.trim()
    if (text.length > 0) parts.push(text)
  }
  if (parts.length === 0) return undefined
  const joined = parts.join("\n")
  return joined.length > LIVE_THOUGHT_MAX_CHARS ? joined.slice(-LIVE_THOUGHT_MAX_CHARS) : joined
}

/**
 * The failure an UNPINNED participant's turn ends with: its definition names no model,
 * and its child session has none either.
 *
 * A CONDITION, not a crash. Left alone the turn falls through to `Provider.defaultModel`,
 * which on a machine with no provider dies as a defect naming neither the agent nor what
 * the human must do. Checked in the COLLAB path alone - the fallback is right for a chat.
 */
export function needsModelReason(agentSlug: string): string {
  return `@${agentSlug} has no model — pick one in its agent definition`
}

/** Whether an agent definition says its model can SEE. DECLARED, never detected:
 *  `vision: true` in the frontmatter, swept into `options` by the rule that carries
 *  `collab:`. A capability table here would need keeping in step with every provider. */
export function visionCapable(info: { options: Record<string, unknown> } | undefined): boolean {
  return Boolean(info?.options["vision"])
}

const keyOf = (collabId: string, agentSlug: string) => `${collabId}::${agentSlug}`

const reason = (cause: Cause.Cause<unknown>) => Cause.prettyErrors(cause)[0]?.message ?? "collab turn failed"

/** What the wake rules read off one stored message. Kind and address, never prose. */
const ruleMessage = (message: CollabStore.Message): CollabRules.Message => ({
  authorId: message.authorId,
  authorKind: message.authorKind,
  kind: message.kind,
  mentions: message.mentions,
})

export const make = (deps: Deps) =>
  Effect.gen(function* () {
    const status = new Map<string, AgentStatus>()
    const contexts = new Map<string, InstanceContext>()
    /** Per-collab FIFO of agents waiting for a turn. The serialization point. */
    const queues = new Map<string, string[]>()
    /** The fiber of each agent's TOP-LEVEL turn, only while that turn runs. */
    const inflight = new Map<string, Fiber.Fiber<void, unknown>>()
    /** The newest seq this runner has written to each collab: the DISPATCH MARK a
     *  parallel turn's envelope is cut at (see `turn`). `append` is the only writer here. */
    const highWater = new Map<string, number>()
    /** The open COUNCIL round of each collab, at most one at a time. A registry rather
     *  than a Map: a round is a state machine decidable with no runner - see `council.ts`. */
    const council = CollabCouncil.makeRegistry()
    /** Per-collab hop budget. Reset by a human post, spent by every agent turn. */
    const budgets = new Map<string, CollabSystem.Hops>()
    /** The cap each live budget was issued on, so a change to it is visible. */
    const issued = new Map<string, number | null>()

    /** The live budget for one collab, re-issued when the CAP changes: a budget of 6 left
     *  against a cap just moved to 2 reads as "6 of 2 remaining". The object is mutated
     *  rather than replaced, because nested turns hold the same handle. */
    const hopsOf = (collab: CollabStore.Collab): CollabSystem.Hops => {
      const cap = startingHops(collab.loopBreakerCap)
      const existing = budgets.get(collab.id)
      if (existing && issued.get(collab.id) === cap) return existing
      const next = existing ?? { remaining: cap }
      next.remaining = cap
      budgets.set(collab.id, next)
      issued.set(collab.id, cap)
      return next
    }

    /** Joins the queue, or does nothing when this agent is already waiting. */
    const enqueue = (collabId: string, agentSlug: string) => {
      const queue = queues.get(collabId)
      if (queue === undefined) {
        queues.set(collabId, [agentSlug])
        return
      }
      if (!queue.includes(agentSlug)) queue.push(agentSlug)
    }

    /** Take the next agent a worker may actually run: FIFO, minus anyone whose turn is
     *  already in flight. That skip is dead code in a serial room and the whole safety of a
     *  parallel one - an agent woken mid-turn would otherwise get a SECOND concurrent turn
     *  on its one child session. It keeps its place and is claimed on a later pass. */
    const claim = (collabId: string): string | undefined => {
      const queue = queues.get(collabId)
      if (queue === undefined) return undefined
      const index = queue.findIndex((agentSlug) => !inflight.has(keyOf(collabId, agentSlug)))
      if (index < 0) return undefined
      const next = queue.splice(index, 1)[0]
      if (queue.length === 0) queues.delete(collabId)
      return next
    }

    /** Rewrite one collab's queue, keeping the "an empty queue does not exist" invariant
     *  `dequeue` relies on. Both callers hand back a list built from the current one. */
    const requeue = (collabId: string, next: readonly string[]) => {
      if (next.length === 0) queues.delete(collabId)
      else queues.set(collabId, [...next])
    }

    const setStatus = (key: string, next: AgentStatus) => {
      status.set(key, next)
    }
    const lastErrorOf = (key: string) => status.get(key)?.lastError
    /** Idle, keeping whatever failure the chip is already showing. */
    const settleStatus = (key: string) => {
      const failure = lastErrorOf(key)
      setStatus(key, failure ? { state: "idle", lastError: failure } : { state: "idle" })
    }

    /** Turns interrupted by a PER-AGENT stop rather than by a room teardown. The drain
     *  cannot tell them apart from the exit alone - both are interrupt-only - and it has
     *  to: one means "carry on", the other "this drain is going away". */
    const stoppedAgents = new Set<string>()
    /** Per-agent retained activity, keyed like `status`. Never cleared by a turn ending. */
    const activity = new Map<string, readonly CollabActivity.ActivityEntry[]>()

    /** Runs `self` in the workspace the collab was bound to, if it has one. */
    const inCollab = <A, E, R>(collabId: string, self: Effect.Effect<A, E, R>) => {
      const context = contexts.get(collabId)
      return context === undefined ? self : self.pipe(Effect.provideService(InstanceRef, context))
    }

    const named = Effect.fnUntraced(function* (agentSlug: string) {
      const resolved = yield* deps.displayName(agentSlug).pipe(Effect.exit)
      return Exit.isSuccess(resolved) ? resolved.value : agentSlug
    })

    /** Whether this agent may be SHOWN images. A read that fails answers "no": telling a
     *  blind agent costs one sentence, sending an attachment to a blind model fails its turn. */
    const sighted = Effect.fnUntraced(function* (agentSlug: string) {
      const read = deps.vision
      if (!read) return false
      const resolved = yield* read(agentSlug).pipe(Effect.exit)
      return Exit.isSuccess(resolved) ? resolved.value : false
    })

    /** The ACTIVE roster with display names and sessions, in roster order. Read fresh on
     *  each use, so an add, a remove or a session created mid-turn lands on the next turn. */
    const roster: (collabId: string) => Effect.Effect<CollabSystem.RosterEntry[]> = Effect.fnUntraced(function* (
      collabId: string,
    ) {
      const entries: CollabSystem.RosterEntry[] = []
      for (const participant of yield* deps.store.participants(collabId)) {
        if (participant.removedAt !== undefined) continue
        entries.push({
          agentSlug: participant.agentSlug,
          displayName: yield* named(participant.agentSlug),
          sessionId: participant.sessionId,
        })
      }
      return entries
    })

    /** The agent's child session, created on first use. */
    const sessionFor: (collabId: string, agentSlug: string) => Effect.Effect<string, unknown> = Effect.fnUntraced(
      function* (collabId: string, agentSlug: string) {
        const participants = yield* deps.store.participants(collabId)
        const existing = participants.find((entry) => entry.agentSlug === agentSlug)?.sessionId
        if (existing) return existing
        const collab = yield* deps.store.get(collabId)
        if (!collab) return yield* Effect.fail(new Error(`collab not found: ${collabId}`))
        const sessionId = yield* deps.createSession({ collab, agentSlug })
        yield* deps.store.setParticipantSession(collabId, agentSlug, sessionId)
        return sessionId
      },
    )

    // The bindings below are mutually recursive - a reply fans out, which schedules a
    // turn, which appends a reply - so each carries an explicit type or TS infers `any`.

    /** Offer one appended message to every other active participant, joining the matching
     *  ones to the collab's queue in ROSTER order. The rules read the message's KIND and
     *  its structured address list, never its prose. */
    const fanout: (collab: CollabStore.Collab, message: CollabStore.Message) => Effect.Effect<void> = Effect.fnUntraced(
      function* (collab: CollabStore.Collab, message: CollabStore.Message) {
        const budget = hopsOf(collab)
        const active = yield* roster(collab.id)
        const flavor = CollabCouncil.flavorOf(collab.flavor)
        const task = message.taskId ? yield* deps.store.getTask(collab.id, message.taskId) : undefined
        // Who this message wakes, by the ONE rule stack. Read before anything is queued:
        // a council round is charged as a whole and cannot price itself until it knows how
        // many it is asking.
        const woken: string[] = []
        for (const subject of active) {
          if (subject.agentSlug === message.authorId) continue
          const decision = CollabRules.decide({
            subject,
            message: ruleMessage(message),
            roster: active,
            lead: collab.lead,
            flavor,
            ...(task ? { task: { createdBy: task.createdBy, owner: task.owner } } : {}),
          })
          if (decision === "reply") woken.push(subject.agentSlug)
        }

        // A COUNCIL ROUND is opened and paid for HERE, once, for all of it. Charging its
        // opinions one by one would let a budget run out mid-round, and a half-funded round
        // is a synthesis over a truncated council. See CollabCouncil's header.
        if (woken.length > 0 && CollabCouncil.opensRound(flavor, message)) {
          if (!tryCharge(budget)) return
          // A human who asks again mid-round has changed the question. The old round goes
          // into the record as far as it got, and the round id keeps its in-flight turns
          // off the new one.
          yield* recordRound(collab.id, council.abandon(collab.id))
          council.open({
            collabId: collab.id,
            ceiling: message.seq,
            members: woken,
            synthesizer: CollabCouncil.pickSynthesizer(woken, collab.lead)!,
          })
          yield* join(collab.id, woken)
          return
        }

        // The hop gate sits AFTER the rules on purpose: a spent budget must not schedule,
        // and must not advance anyone's last-seen marker, so the backlog is still context
        // for the turn the next human post releases.
        if (spent(budget)) return
        yield* join(collab.id, woken)
      },
    )

    /** Put agents in the queue and wake their drain ONCE. The drain loop empties the
     *  queue, so a wake per agent would only add drains that find nothing to do. */
    const join: (collabId: string, agentSlugs: readonly string[]) => Effect.Effect<void> = Effect.fnUntraced(
      function* (collabId: string, agentSlugs: readonly string[]) {
        if (agentSlugs.length === 0) return
        for (const agentSlug of agentSlugs) {
          const key = keyOf(collabId, agentSlug)
          const failure = lastErrorOf(key)
          setStatus(key, failure ? { state: "queued", lastError: failure } : { state: "queued" })
          enqueue(collabId, agentSlug)
        }
        yield* coordinator.wake(collabId)
      },
    )

    /** Write a round's own line into the room, or nothing when there is no round. Every
     *  path that ends a round comes here, because the one thing a council must never do is
     *  drop a member quietly. The row wakes nobody: its kind falls through to silence. */
    const recordRound: (collabId: string, round: CollabCouncil.Round | undefined) => Effect.Effect<void> =
      Effect.fnUntraced(function* (collabId: string, round: CollabCouncil.Round | undefined) {
        if (!round) return
        const names = new Map<string, string>()
        for (const agentSlug of round.members) names.set(agentSlug, yield* named(agentSlug))
        yield* append({
          collabId,
          authorId: CollabCouncil.RECORD_AUTHOR,
          authorKind: "agent",
          kind: "round",
          text: CollabCouncil.roundSummary(round, (agentSlug) => names.get(agentSlug) ?? agentSlug),
        })
      })

    /** Close the round if this settle was its last, and give the synthesizer the turn that
     *  reconciles it. `takeClosed` answers exactly one caller, so two workers finishing the
     *  last two opinions in the same instant produce one synthesis. It is queued the way a
     *  hand-off is, because no message in the room addresses it. */
    const closeRound: (collabId: string) => Effect.Effect<void> = Effect.fnUntraced(function* (collabId: string) {
      const round = council.takeClosed(collabId)
      if (!round) return
      yield* recordRound(collabId, round)
      yield* join(collabId, [round.synthesizer])
    })

    const append: (input: CollabStore.AppendInput) => Effect.Effect<CollabStore.Message> = Effect.fnUntraced(function* (
      input: CollabStore.AppendInput,
    ) {
      const message = yield* deps.store.appendMessage(input)
      // BEFORE the fan-out: the turns this message is about to schedule are dispatched at
      // this mark, and must be able to see the message that woke them.
      highWater.set(input.collabId, message.seq)
      const collab = yield* deps.store.get(input.collabId)
      if (!collab || collab.archivedAt !== undefined) return message
      // A human in the room buys the next budget. Reset BEFORE the fan-out, or the post
      // that releases a held stream is gated by the budget it just replaced.
      if (input.authorKind === "human") hopsOf(collab).remaining = startingHops(collab.loopBreakerCap)
      yield* fanout(collab, message)
      return message
    })

    /** One turn's whole context, including the handles its tools run on. */
    const turnContext = (input: {
      collab: CollabStore.Collab
      agentSlug: string
      displayName: string
      sessionId: string
      roster: readonly CollabSystem.RosterEntry[]
      askChain: readonly string[]
      hops: CollabSystem.Hops
      tasks: readonly CollabStore.Task[]
      /** Which half of a council round this turn is, when it is one. */
      council?: CollabCouncil.Phase
      /** Whether this turn is running READ-ONLY (`TurnInput.sealed`). Carried here for ONE
       *  reason: `ops.ask` starts another turn, and a sealed member that could hand the
       *  writing to an unsealed peer would have walked around the seal in one tool call. */
      sealed?: boolean
    }): CollabSystem.TurnContext => ({
      ...systemLayers({
        title: input.collab.title,
        agentSlug: input.agentSlug,
        displayName: input.displayName,
        roster: input.roster,
        lead: input.collab.lead,
        objective: input.collab.objective,
        hops: input.hops,
        tasks: input.tasks,
      }),
      collabId: input.collab.id,
      title: input.collab.title,
      agentSlug: input.agentSlug,
      sessionId: input.sessionId,
      lead: input.collab.lead,
      objective: input.collab.objective,
      roster: input.roster,
      askChain: input.askChain,
      hops: input.hops,
      stop: { requested: false, summary: "" },
      ...(input.council !== undefined ? { council: { phase: input.council } } : {}),
      ops: {
        store: deps.store,
        append: (next) => append(next),
        session: (agentSlug) => sessionFor(input.collab.id, agentSlug),
        ask: (request) => nested(input.collab.id, request, input.sealed === true),
        handoff: (agentSlug) => baton(input.collab.id, agentSlug),
      },
    })

    /** One ledger row per turn. Written even for a silent one: silence costs tokens. */
    const record = Effect.fnUntraced(function* (
      collabId: string,
      agentSlug: string,
      outcome: TurnOutcome,
      askedBy?: string,
    ) {
      const spend = outcome.cost
      if (!spend) return
      yield* deps.store.appendCost({
        collabId,
        agentSlug,
        model: spend.model,
        tokensInput: spend.tokensInput,
        tokensOutput: spend.tokensOutput,
        cost: spend.cost,
        ...(askedBy !== undefined ? { askedBy } : {}),
      })
    })

    /** Give an agent the baton: queue its turn and wake the drain it sits in. */
    const baton: (collabId: string, agentSlug: string) => Effect.Effect<void> = Effect.fnUntraced(function* (
      collabId: string,
      agentSlug: string,
    ) {
      const key = keyOf(collabId, agentSlug)
      const failure = lastErrorOf(key)
      setStatus(key, failure ? { state: "queued", lastError: failure } : { state: "queued" })
      enqueue(collabId, agentSlug)
      // `pendingWake` on the coordinator gives baton semantics for free: the wake lands on
      // the drain this turn already runs inside, so the target runs after it, not beside it.
      yield* coordinator.wake(collabId)
    })

    /**
     * Run ONE nested turn for an `ask`, inside the caller's drain slot. Nothing is
     * appended here - the ANSWER row is the asking tool's to write, because only it knows
     * whether the target said anything worth recording.
     *
     * `sealed` is the ASKER'S state: a read-only turn cannot buy a write by delegating it.
     */
    const nested: (
      collabId: string,
      request: CollabSystem.AskRequest,
      sealed?: boolean,
    ) => Effect.Effect<CollabSystem.AskOutcome> =
      Effect.fnUntraced(function* (collabId: string, request: CollabSystem.AskRequest, sealed = false) {
        const collab = yield* deps.store.get(collabId)
        if (!collab || collab.archivedAt !== undefined) {
          return { text: "", trace: [], error: "this collab is closed" }
        }
        const active = yield* roster(collabId)
        const subject = active.find((entry) => entry.agentSlug === request.target)
        if (!subject) return { text: "", trace: [], error: `@${request.target} is no longer in this collab` }

        const messages = yield* deps.store.listMessages(collabId)
        // The ask itself is the brief, so it must not also appear in the
        // history under it.
        const asked = messages.findLast(
          (message) => message.kind === "ask" && message.mentions.includes(request.target),
        )
        const history = asked ? messages.filter((message) => message.seq < asked.seq) : messages

        charge(request.hops)
        const key = keyOf(collabId, request.target)
        setStatus(key, { state: "running" })
        const tasks = yield* deps.store.listTasks(collabId)
        const context = turnContext({
          collab,
          agentSlug: request.target,
          displayName: subject.displayName,
          sessionId: request.sessionId,
          roster: active,
          askChain: request.askChain,
          hops: request.hops,
          tasks,
          ...(sealed ? { sealed: true } : {}),
        })
        // The history window the brief renders is also the window its images come from -
        // an ask carries whatever the room posted under it.
        const carried = withImages({
          text: brief({
            title: collab.title,
            agentSlug: request.target,
            from: request.from,
            task: request.task,
            ...(request.context !== undefined ? { context: request.context } : {}),
            ...(request.expect !== undefined ? { expect: request.expect } : {}),
            ...(request.taskId !== undefined ? { taskId: request.taskId } : {}),
            messages: history,
          }),
          images: imagesOf(briefWindow(request.target, history)),
          vision: yield* sighted(request.target),
        })
        const exit = yield* deps
          .turn({
            collabId,
            agentSlug: request.target,
            sessionId: request.sessionId,
            turn: context,
            text: carried.text,
            ...(carried.images ? { images: carried.images } : {}),
            ...(sealed ? { sealed: true as const } : {}),
          })
          .pipe(Effect.exit)

        if (Exit.isFailure(exit)) {
          const failure = reason(exit.cause)
          setStatus(key, { state: "idle", lastError: failure })
          yield* Effect.logError("Collab nested turn failed", exit.cause).pipe(Effect.annotateLogs({ collab: key }))
          return { text: "", trace: [], error: failure }
        }
        setStatus(key, { state: "idle" })
        const outcome = exit.value
        yield* record(collabId, request.target, outcome, request.from)
        const trace = outcome.trace ?? []
        if (outcome.stepCapped) return { text: "", trace, stepCapped: true }
        // A `done` summary IS the answer when the target chose to end that way.
        const stop = context.stop
        const text = stop.requested && stop.kind === "done" ? stop.summary : outcome.text
        return { text, trace }
      })

    /**
     * Close a hand-off's auto-task when its target never touched the board. `ask` returns
     * its answer by construction, but a hand-off target that simply talks and stops leaves
     * the task CLAIMED forever, and the issuer is never woken.
     *
     * The result is marked `[auto]` because the RUNNER wrote it, not the agent. The wake
     * rides the appended row through the `task_done` rule, so it is hop-gated.
     */
    const autoReturn = Effect.fnUntraced(function* (input: {
      collabId: string
      agentSlug: string
      taskId: string
      /** The target's final message text. Empty means it ended in silence. */
      text: string
      /** True when the turn made a routing call of its own - see `routed`. */
      routed: boolean
    }) {
      if (input.routed) return
      const task = yield* deps.store.getTask(input.collabId, input.taskId)
      // Still CLAIMED and still the target's: anything else means the board already moved,
      // and a second move on top of it is the double-fire.
      if (!task || task.state !== "claimed" || task.owner !== input.agentSlug) return
      const done = yield* deps.store.updateTask({
        collabId: input.collabId,
        taskId: input.taskId,
        action: "done",
        result: `${AUTO_RESULT_PREFIX} ${input.text.length > 0 ? input.text : AUTO_SILENT_RESULT}`,
      })
      yield* append({
        collabId: input.collabId,
        authorId: input.agentSlug,
        authorKind: "agent",
        kind: "task_done",
        text: `completed task: ${done.title}`,
        taskId: done.id,
      })
    })

    /**
     * One agent's turn.
     *
     * `ceiling` is the DISPATCH MARK, present only for a room running turns in parallel,
     * and it is where the VISIBILITY RULE lives: A TURN READS THE ROOM AS IT STOOD WHEN
     * IT WAS DISPATCHED. Anything a concurrent turn says while this one runs arrives on
     * its NEXT turn.
     * Clamping at the mark makes that a rule rather than a race: two turns dispatched in
     * the same pass are cut from the same log, and last-seen advances only to the mark. A
     * SERIAL room passes no mark and reads the whole log.
     */
    const turn: (collabId: string, agentSlug: string, dispatch?: TurnDispatch) => Effect.Effect<void, unknown> =
      Effect.fnUntraced(function* (collabId: string, agentSlug: string, dispatch: TurnDispatch = {}) {
        const ceiling = dispatch.ceiling
        // Set when this turn is half of a COUNCIL round. Its budget was taken at the door
        // for the whole round, so neither hop gate below applies to it.
        const phase = dispatch.round?.phase
        const collab = yield* deps.store.get(collabId)
        if (!collab || collab.archivedAt !== undefined) return
        const participant = (yield* deps.store.participants(collabId)).find(
          (entry) => entry.agentSlug === agentSlug && entry.removedAt === undefined,
        )
        if (!participant) return

        // The DRAIN gate. A turn queued before the budget ran out - or before a stop - must
        // not run on credit it no longer has, and must not advance last-seen either.
        const budget = hopsOf(collab)
        if (phase === undefined && spent(budget)) return

        // Read HERE, not when this agent joined the queue: everything the earlier agents
        // have said since is what lets a later agent stay silent. The ceiling cuts that
        // read at the DISPATCH MARK - see above.
        const messages = CollabParallel.visibleAtDispatch(yield* deps.store.listMessages(collabId), ceiling)
        const batch = messages.filter((message) => message.seq > participant.lastSeenSeq)
        const latest = batch.at(-1)
        if (!latest) return

        const active = yield* roster(collabId)
        const subject = active.find((entry) => entry.agentSlug === agentSlug) ?? {
          agentSlug,
          displayName: yield* named(agentSlug),
          sessionId: participant.sessionId,
        }

        // A hand-off is routed by the runner, not by the rule stack, so the rules say
        // "skip"; this is the other half. A SYNTHESIS is routed the same way - the opinions
        // it reconciles wake nobody.
        const handed = batch.findLast((message) => message.kind === "handoff" && message.mentions.includes(agentSlug))
        let replies = handed !== undefined || phase === "synthesis"
        for (const message of batch) {
          if (replies) break
          const task = message.taskId ? yield* deps.store.getTask(collabId, message.taskId) : undefined
          const decision = CollabRules.decide({
            subject,
            message: ruleMessage(message),
            roster: active,
            lead: collab.lead,
            flavor: CollabCouncil.flavorOf(collab.flavor),
            ...(task ? { task: { createdBy: task.createdBy, owner: task.owner } } : {}),
          })
          if (decision === "reply") replies = true
        }

        // Advanced before the turn, not after: a burst arriving DURING the turn is the next
        // batch, and re-reading from the old marker would send this batch a second time.
        yield* deps.store.setLastSeen(collabId, agentSlug, latest.seq)
        if (!replies) return

        // The turn is happening, so it costs a hop. Check-and-spend in one step: under
        // parallel dispatch every sibling turn has already passed the `spent` gate above.
        if (phase === undefined && !tryCharge(budget)) return
        const key = keyOf(collabId, agentSlug)
        setStatus(key, { state: "running" })
        const sessionId = yield* sessionFor(collabId, agentSlug)
        const tasks = yield* deps.store.listTasks(collabId)
        const context = turnContext({
          collab,
          agentSlug,
          displayName: subject.displayName,
          sessionId,
          roster: active,
          askChain: [],
          hops: budget,
          tasks,
          ...(phase !== undefined ? { council: phase, sealed: true } : {}),
        })
        // The window the text renders and the window the images come from are
        // the SAME one, so an image can never arrive without the line beside it.
        const history = handed ? messages.filter((message) => message.seq < handed.seq) : batch
        const carried = withImages({
          text:
            phase === "synthesis"
              ? CollabCouncil.synthesisEnvelope({ title: collab.title, messages: batch })
              : handed
                ? brief({
                    title: collab.title,
                    agentSlug,
                    from: handed.authorId,
                    task: handed.text,
                    ...(handed.taskId !== null ? { taskId: handed.taskId } : {}),
                    messages: history,
                  })
                : envelope({ title: collab.title, agentSlug, messages: batch }),
          // The synthesis window is the whole batch, not the batch minus the
          // reader: the record it reconciles includes its own opinion.
          images: imagesOf(
            phase === "synthesis" ? batch : handed ? briefWindow(agentSlug, history) : envelopeWindow(agentSlug, batch),
          ),
          vision: yield* sighted(agentSlug),
        })
        const outcome = yield* deps.turn({
          collabId,
          agentSlug,
          sessionId,
          turn: context,
          text: carried.text,
          ...(carried.images ? { images: carried.images } : {}),
          // BOTH halves of a round, and only a round. The seal is what lets a
          // room of workers be a council at all - see `CollabSeal.COUNCIL_SEAL`.
          ...(phase !== undefined ? { sealed: true as const } : {}),
        })
        yield* record(collabId, agentSlug, outcome)

        if (outcome.stepCapped) {
          // A truncated turn is not a contribution. Posting it would put half an
          // answer in the room, and every other agent would read it as a whole one.
          return yield* Effect.fail(new Error(`@${agentSlug} ran out of steps mid-turn`))
        }
        const stop = context.stop
        // A hand-off already said its piece in the room, and the baton is gone.
        if (stop.requested && stop.kind === "handoff") return
        // Empty is a CHOICE, not a failure: the rules tell agents that silence is
        // allowed, so an empty turn appends nothing and fans out nothing.
        const reply = (stop.requested && stop.kind === "done" ? stop.summary : outcome.text).trim()
        if (reply.length > 0) {
          const trace = outcome.trace ?? []
          yield* append({
            collabId,
            authorId: agentSlug,
            authorKind: "agent",
            text: reply,
            // A round turn's reply gets its own KIND so the room, the shell and the rule
            // stack can tell an independent position from conversation without reading it.
            ...(phase !== undefined ? { kind: phase === "opinion" ? ("opinion" as const) : ("synthesis" as const) } : {}),
            ...(trace.length > 0 ? { trace } : {}),
          })
          // Recorded HERE, where the reply landed, because this is the one place that knows
          // the member said something: the worker below cannot tell silence from speech.
          if (dispatch.round) council.settle(collabId, dispatch.round, agentSlug, "answered")
        }
        // AFTER the reply, so the room reads the answer before the board row that
        // reports it finished.
        if (handed?.taskId) {
          yield* autoReturn({
            collabId,
            agentSlug,
            taskId: handed.taskId,
            text: reply,
            routed: routed({ stop, ...(outcome.trace !== undefined ? { trace: outcome.trace } : {}) }),
          })
        }
      })

    /**
     * Empties one collab's queue, ONE turn at a time. A turn that fails is recorded and
     * the next agent still gets its turn: one broken provider must not silence the room.
     *
     * ONE worker IS the serial drain: a room at concurrency N runs N of these over the
     * same queue, and `claim` keeps them off each other's agents. A worker that finds
     * nothing CLAIMABLE ends without losing work - the queue outlives it.
     */
    const worker: (collabId: string, parallel: boolean) => Effect.Effect<void> = Effect.fnUntraced(function* (
      collabId: string,
      parallel: boolean,
    ) {
      while (true) {
        const agentSlug = claim(collabId)
        if (agentSlug === undefined) return
        const key = keyOf(collabId, agentSlug)
        // A COUNCIL turn brings its own cut - the ROUND'S, taken when the question was
        // asked. That is the whole of blind deliberation: a per-claim mark would let the
        // fourth member read the first's answer.
        const round = council.dispatchFor(collabId, agentSlug)
        // Otherwise the DISPATCH MARK, read the instant this turn is claimed and only for
        // a parallel room - see the visibility rule on `turn`.
        const dispatch: TurnDispatch = round
          ? { ...(round.ceiling !== undefined ? { ceiling: round.ceiling } : {}), round }
          : parallel && highWater.has(collabId)
            ? { ceiling: highWater.get(collabId)! }
            : {}
        // FORKED, not inline: `stopAgent` needs a handle on exactly this turn so it can end
        // one agent without taking the drain down. Joining it back immediately keeps the
        // serialization, and `startImmediately` keeps the turn beginning on this tick.
        const fiber = yield* Effect.forkChild(inCollab(collabId, turn(collabId, agentSlug, dispatch)), {
          startImmediately: true,
        })
        inflight.set(key, fiber)
        const exit = yield* Fiber.join(fiber).pipe(Effect.exit)
        inflight.delete(key)
        const broke = Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
        // EVERY round turn settles, whatever became of it, or a dead member holds the
        // council open. `settle` keeps the FIRST answer, so a recorded reply is not lost.
        if (round) {
          council.settle(collabId, round, agentSlug, broke ? "failed" : stoppedAgents.has(key) ? "stopped" : "silent")
          yield* closeRound(collabId)
        }
        if (broke) {
          // Nothing is appended on failure: a stack trace in the log would be a message
          // every other agent reads and reacts to. The error belongs on the agent's status.
          setStatus(key, { state: "idle", lastError: reason(exit.cause) })
          yield* Effect.logError("Collab turn failed", exit.cause).pipe(Effect.annotateLogs({ collab: key }))
          continue
        }
        setStatus(key, { state: "idle" })
        // A per-agent stop: only this turn was interrupted, so the queue behind
        // it is still the room's work and the drain carries on.
        if (stoppedAgents.delete(key)) continue
        // Interrupted otherwise: the whole drain is being torn down, so stop
        // rather than pull the next agent into a fiber that is already going away.
        if (Exit.isFailure(exit)) return
      }
    })

    /**
     * The room's SCHEDULER. Reads the width the room is set to and runs that many
     * workers over its one queue.
     *
     * The width is read once per drain, so a change lands on the next wave. A room at 1
     * runs the single worker DIRECTLY on this fiber: the serial path is the untouched one.
     */
    const drain: (collabId: string) => Effect.Effect<void> = Effect.fnUntraced(function* (collabId: string) {
      const collab = yield* deps.store.get(collabId)
      // A COUNCIL is wide by construction; its width is not a second control the human has
      // to find. The write hazard is answered on the TURN - every round turn runs read-only,
      // see `TurnInput.sealed` - rather than by refusing the flavor.
      const width = Math.max(
        CollabParallel.dispatchWidth(collab?.concurrency),
        CollabCouncil.dispatchWidth(collab?.flavor),
      )
      if (width <= 1) return yield* worker(collabId, false)
      yield* Effect.forEach(
        Array.from({ length: width }, (_, index) => index),
        () => worker(collabId, true),
        {
          concurrency: width,
          discard: true,
        },
      )
    })

    const coordinator: SessionRunCoordinator.Coordinator<string, never> = yield* SessionRunCoordinator.make<
      string,
      never
    >({ drain: (collabId: string) => drain(collabId) })

    const post = Effect.fn("Collab.post")(function* (input: {
      collabId: string
      text: string
      mentions?: readonly string[]
      kind?: CollabStore.MessageKind
      taskId?: string
      images?: readonly string[]
    }) {
      return yield* append({
        collabId: input.collabId,
        authorId: "user",
        authorKind: "human",
        text: input.text,
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        ...(input.mentions !== undefined ? { mentions: input.mentions } : {}),
        ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
        ...(input.images !== undefined ? { images: input.images } : {}),
      })
    })

    const statuses = Effect.fn("Collab.statuses")(function* (collabId: string) {
      const result = new Map<string, AgentStatus>()
      const prefix = `${collabId}::`
      for (const [key, value] of status) {
        if (key.startsWith(prefix)) result.set(key.slice(prefix.length), value)
      }
      return result
    })

    /** Reads live per-agent activity fresh on every call - it rides the same poll cadence
     *  `collab_state` already runs on, so nothing here is cached the way `status` is. */
    const liveActivity = Effect.fn("Collab.liveActivity")(function* (collabId: string) {
      const result = new Map<string, LiveSignal>()
      const read = deps.latestMessage
      if (!read) return result
      const prefix = `${collabId}::`
      const running: string[] = []
      for (const [key, value] of status) {
        if (value.state === "running" && key.startsWith(prefix)) running.push(key.slice(prefix.length))
      }
      if (running.length === 0) return result
      const participants = yield* deps.store.participants(collabId)
      for (const agentSlug of running) {
        const sessionId = participants.find((entry) => entry.agentSlug === agentSlug)?.sessionId
        if (!sessionId) continue
        // A read failure here must never break `collab_state`: liveActivity is a nicety
        // layered on `statuses`, so a broken read is absent plus one debug log, not a throw.
        const exit = yield* read(sessionId).pipe(Effect.exit)
        if (Exit.isFailure(exit)) {
          yield* Effect.logDebug("Collab live activity read failed").pipe(
            Effect.annotateLogs({ collab: collabId, agent: agentSlug }),
          )
          continue
        }
        // ONE read, three answers: the chip's line, the reasoning block and the retained
        // history all come off the same message, so a poll cannot mix two instants.
        const message = exit.value
        if (message) {
          const key = keyOf(collabId, agentSlug)
          activity.set(
            key,
            CollabActivity.mergeActivity(
              activity.get(key) ?? [],
              message.info.id,
              CollabActivity.turnActivity(message),
            ),
          )
        }
        const signal = liveActivityOf(message)
        const thought = liveThoughtOf(message)
        if (signal || thought) {
          result.set(agentSlug, {
            ...(signal ? { activity: signal } : {}),
            ...(thought ? { thought } : {}),
          })
        }
      }
      return result
    })

    const activityLog = Effect.fn("Collab.activityLog")(function* (collabId: string) {
      const result = new Map<string, readonly CollabActivity.ActivityEntry[]>()
      const prefix = `${collabId}::`
      for (const [key, entries] of activity) {
        if (key.startsWith(prefix) && entries.length > 0) result.set(key.slice(prefix.length), entries)
      }
      return result
    })

    const hopState = Effect.fn("Collab.hopState")(function* (collabId: string) {
      const collab = yield* deps.store.get(collabId)
      if (!collab) return { remaining: null, cap: null } satisfies HopState
      const budget = hopsOf(collab)
      const cap = startingHops(collab.loopBreakerCap)
      return { remaining: budget.remaining, cap } satisfies HopState
    })

    const stop = Effect.fn("Collab.stop")(function* (collabId: string) {
      // Order matters: drop the queue and spend the budget FIRST, so the drain being
      // interrupted cannot pull one more agent out on its way down. The ROUND goes with
      // them - a stopped room is quiet, so no synthesis runs over the opinions that landed.
      queues.delete(collabId)
      const abandoned = council.abandon(collabId)
      const collab = yield* deps.store.get(collabId)
      if (collab) hopsOf(collab).remaining = 0
      else budgets.set(collabId, { remaining: 0 })
      yield* coordinator.interrupt(collabId)
      const prefix = `${collabId}::`
      for (const [key, value] of status) {
        if (!key.startsWith(prefix)) continue
        if (value.state === "idle") continue
        settleStatus(key)
      }
      // ...but the record still says how far it got: a council that vanished mid-round
      // would leave three unanswered questions and no statement that anything was asked.
      yield* recordRound(collabId, abandoned)
    })

    const stopAgent = Effect.fn("Collab.stopAgent")(function* (collabId: string, agentSlug: string) {
      const queue = queues.get(collabId) ?? []
      const dequeued = queue.includes(agentSlug)
      // Only this slug. Everything else keeps its place, which is the whole
      // difference between this and `stop`.
      if (dequeued)
        requeue(
          collabId,
          queue.filter((slug) => slug !== agentSlug),
        )

      const key = keyOf(collabId, agentSlug)
      const fiber = inflight.get(key)
      if (!fiber) {
        // No drain will ever reach a dropped agent to put its chip back, and a roster stuck
        // on "queued" reads as work still coming. A "running" agent with no fiber of its
        // own is NESTED inside somebody's ask, and that path clears its status itself.
        if (status.get(key)?.state === "queued") settleStatus(key)
        // A council member stopped while still WAITING has no turn to interrupt and no
        // worker that will join it, so this is the only place its round can be told.
        if (dequeued) {
          const round = council.dispatchFor(collabId, agentSlug)
          if (round) {
            council.settle(collabId, round, agentSlug, "stopped")
            yield* closeRound(collabId)
          }
        }
        return { interrupted: false, dequeued } satisfies StopAgentResult
      }

      stoppedAgents.add(key)
      // The session FIRST. Interrupting the fiber frees the room immediately, and a request
      // left in flight would keep spending on a turn whose answer nobody will read.
      const abort = deps.abort
      if (abort) {
        const sessionId = (yield* deps.store.participants(collabId)).find(
          (entry) => entry.agentSlug === agentSlug,
        )?.sessionId
        if (sessionId) yield* abort(sessionId).pipe(Effect.exit)
      }
      yield* Fiber.interrupt(fiber)
      return { interrupted: true, dequeued } satisfies StopAgentResult
    })

    const redirect = Effect.fn("Collab.redirect")(function* (input: {
      collabId: string
      agentSlug: string
      text: string
    }) {
      const message = yield* append({
        collabId: input.collabId,
        authorId: "user",
        authorKind: "human",
        text: input.text,
        mentions: [input.agentSlug],
      })
      // AFTER the append, because the append is what put the target in the queue: promoting
      // first would be undone by the push that follows it. A turn already in flight holds
      // the drain until it ends, so nothing can overtake this.
      const queue = queues.get(input.collabId)
      if (queue?.includes(input.agentSlug)) {
        requeue(input.collabId, [input.agentSlug, ...queue.filter((slug) => slug !== input.agentSlug)])
      }
      return message
    })

    const bind = Effect.fn("Collab.bind")(function* (collabId: string, context: InstanceContext | undefined) {
      if (context) contexts.set(collabId, context)
    })

    const settle = Effect.gen(function* () {
      while ((yield* coordinator.active).size > 0) yield* Effect.sleep("5 millis")
    })

    return Service.of({
      post,
      statuses,
      liveActivity,
      activityLog,
      hopState,
      stop,
      stopAgent,
      redirect,
      bind,
      settle,
    })
  })

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const store = yield* CollabStore.Service
    const agents = yield* Agent.Service
    const sessions = yield* Session.Service
    const prompts = yield* SessionPrompt.Service
    const events = yield* EventV2Bridge.Service

    /**
     * Put one child session READ-ONLY for the length of a sealed turn, and answer with
     * the effect that puts it back.
     *
     * WHY THE SESSION ROW: the ruleset a tool call really evaluates is
     * `Permission.merge(agent.permission, live.permission)`, read fresh per call, and the
     * same pair decides which tools survive into the model's request at all. The session
     * half is the only channel that reaches both.
     *
     * PUT BACK because the seal belongs to the ROUND, not the room: a member with `edit`
     * keeps it in the discuss turns of the same collab. A CRASH IS SAFE - the row keeps
     * the seal, which is the strict direction. ONE WRITER AT A TIME by construction,
     * because the runner claims an agent before dispatching its turn.
     */
    const seal = Effect.fnUntraced(function* (input: {
      sealed: boolean
      sessionID: SessionID
      agentPermission: PermissionV1.Ruleset
    }) {
      if (!input.sealed) return Effect.void
      const session = yield* sessions.get(input.sessionID).pipe(Effect.catch(() => Effect.succeed(undefined)))
      // A session that cannot be READ cannot be restored either, and a restore built on a
      // guess would write an empty ruleset over the room seal. The prompt below needs the
      // same row and fails on it with a better message than anything here.
      if (!session) return Effect.void
      const before = session.permission ?? []
      yield* sessions.setPermission({
        sessionID: input.sessionID,
        permission: CollabSeal.sessionPermission({
          agentPermission: input.agentPermission,
          sessionPermission: before,
          seal: CollabSeal.COUNCIL_SEAL,
        }),
      })
      return sessions.setPermission({ sessionID: input.sessionID, permission: before })
    })

    return yield* make({
      store,
      // `get` is TYPED as always answering an Info but returns undefined for a
      // slug no definition backs. `named` already falls back to the slug, so
      // this changes no outcome - it just avoids raising a defect to get there.
      displayName: (agentSlug) => agents.get(agentSlug).pipe(Effect.map((info) => info?.description ?? agentSlug)),
      vision: (agentSlug) => agents.get(agentSlug).pipe(Effect.map(visionCapable)),
      createSession: Effect.fnUntraced(function* (input) {
        // Re-scan HERE so the agent's first turn runs on the definition as it is on disk
        // NOW, even when the file was written after the engine started. This runs once per
        // agent per collab, so it costs one directory scan per member, not one per turn.
        yield* agents.rescan()
        const info = yield* agents.get(input.agentSlug)
        // Refuse rather than dereference undefined: the definition can be gone
        // by the time the baton arrives. The runner records this on the agent's
        // status, where a human can see it, instead of taking the drain down.
        if (!info) return yield* Effect.fail(new Error(`no agent definition for ${input.agentSlug}`))
        // A collab agent has no parent session to inherit denies from, so the definition's
        // own block is the whole story. Deliberate: the defs are authored deny-by-default,
        // and inventing restrictions here would silently disagree with them.
        const derived = deriveSubagentSessionPermission({ parentSessionPermission: [], subagent: info })
        const session = yield* sessions.create({
          title: `${input.collab.title} — ${input.agentSlug}`,
          agent: input.agentSlug,
          // ...with ONE exception the definition does not get to overrule: the room seal.
          // A member that can spawn subagents routes around the shared stream the room
          // exists to be. `CollabSeal` closes that, and closes the peer broker with it,
          // taking the STRICTER of the two answers per tool so a seal rule can never reopen
          // a door the definition shut.
          permission: CollabSeal.sessionPermission({ agentPermission: info.permission, sessionPermission: derived }),
          // NO model. A bot pins one in its own definition or it has none, and an unpinned
          // bot is stopped by the turn gate below with a message that says exactly that.
        })
        return session.id
      }),
      latestMessage: Effect.fnUntraced(function* (sessionId: string) {
        const list = yield* sessions.messages({ sessionID: SessionID.make(sessionId), limit: 1 })
        return list.at(-1)
      }),
      // The same cancel a chat's stop button uses: a collab agent's child session is an
      // ordinary session, and inventing one would be a second way to stop a turn.
      abort: (sessionId: string) => prompts.cancel(SessionID.make(sessionId)),
      turn: Effect.fnUntraced(function* (input) {
        const sessionID = SessionID.make(input.sessionId)
        // The MODEL gate, ahead of everything else this turn does. Precedence in the prompt
        // path is agent.model ?? the session's ?? the provider default, and that last step
        // has no answer on a machine with no provider - see `needsModelReason`. Checked in
        // that order, minus the fallback.
        const definition = yield* agents.get(input.agentSlug)
        if (!definition?.model) {
          const session = yield* sessions.get(sessionID).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (!session?.model) return yield* Effect.fail(new Error(needsModelReason(input.agentSlug)))
        }
        const before = new Set(
          (yield* sessions.messages({ sessionID }).pipe(Effect.orDie)).map((message) => message.info.id),
        )
        // A step-cap stop is INVISIBLE in the result: the loop publishes an error event and
        // breaks, and the last assistant message still reads like a finished answer. A turn
        // cut off mid-thought would otherwise be posted to the room as a contribution.
        let capped = false
        const unsubscribe = yield* events.listen((event) =>
          Effect.sync(() => {
            if (event.type !== "session.error") return
            const data = event.data as { sessionID?: string } | undefined
            if (data?.sessionID !== input.sessionId) return
            capped = true
          }),
        )

        // THE ROUND SEAL, on the last line before the turn goes out and undone on the first
        // line after it comes back. Everything the prompt path reads - the tools, the
        // ruleset every tool call asks against - is read after this point, from the row.
        const unseal = yield* seal({
          sealed: input.sealed === true,
          sessionID,
          agentPermission: definition?.permission ?? [],
        })

        const result = yield* prompts
          .prompt({
            sessionID,
            agent: input.agentSlug,
            // No `model`: precedence is input.model ?? agent.model ?? current, and a collab
            // agent pins its model in its own definition. The images ride AFTER the text,
            // the same order a chat attachment arrives in.
            parts: [{ type: "text", text: input.text }, ...(input.images ?? [])],
          })
          // The turn's context, read by `LLMRequestPrep.prepare` for the system layers and
          // by the flock tools for everything else. Provided on the fiber rather than as
          // the prompt's own `system` field, which the request layer places LAST - below
          // the persona, where a base prompt cannot do its job.
          .pipe(
            Effect.provideService(CollabSystem.Turn, input.turn),
            Effect.ensuring(unsubscribe),
            Effect.ensuring(unseal),
          )

        // A turn can fail WITHOUT throwing - a context overflow is recorded on
        // the assistant message. Left unchecked it would read as an empty
        // reply, i.e. as the agent choosing silence.
        const failure = result.info.role === "assistant" ? result.info.error : undefined
        if (failure) return yield* Effect.fail(new Error(failure.name ?? "collab agent turn failed"))

        const fresh = (yield* sessions.messages({ sessionID }).pipe(Effect.orDie)).filter(
          (message) => !before.has(message.info.id),
        )
        const spend = spendOf(fresh)
        const model = fresh.findLast((message) => message.info.role === "assistant")?.info
        return {
          text: result.parts.findLast((part) => part.type === "text")?.text ?? "",
          trace: traceOf(fresh),
          ...(capped ? { stepCapped: true } : {}),
          ...(model && model.role === "assistant"
            ? {
                cost: {
                  model: `${model.providerID}/${model.modelID}`,
                  tokensInput: spend.tokensInput,
                  tokensOutput: spend.tokensOutput,
                  cost: spend.cost,
                },
              }
            : {}),
        } satisfies TurnOutcome
      }),
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [CollabStore.node, Agent.node, Session.node, SessionPrompt.node, EventV2Bridge.node],
})

export * as CollabRunner from "./runner"
