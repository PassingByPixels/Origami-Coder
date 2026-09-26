import type { AgentSideConnection } from "@agentclientprotocol/sdk"
import type {
  Event,
  EventMessagePartDelta,
  EventMessagePartUpdated,
  EventMessageUpdated,
  EventSessionUpdated,
  OrigamiClient,
  Part,
  SessionMessageResponse,
  ToolPart,
} from "@origami/sdk/v2"
import { EventV2 } from "@origami/core/event"
import { GlobalBus } from "@/bus/global"
import { Effect } from "effect"
import { taskResults, taskTokensFromRow, TASK_TOKENS_KEY, type TaskTokens } from "@/session/task-result"
import { peerMessage } from "@/session/peer-message"
import { SessionStreamDrop } from "@/session/stream-drop"
import { onCacheState, CACHE_STATE_METHOD, type CacheStatePush } from "@/session/cache-state"
import { onTurnEnd, turnEndPayload, TURN_END_METHOD, type StopReason } from "@/session/turn-end"
import { SessionProviderQueue } from "@/session/provider-queue"
import { SubagentQuestion } from "@/session/subagent-question"
import { FlockStore } from "@/flock/store"
import { FlockWatch } from "@/flock/watch"
import { onArtifactChange, type ArtifactChange } from "@/artifact/events"
import { ACPArtifacts } from "./artifacts"
import { ACPFlock } from "./flock"
import { ACPSession } from "./session"
import { ACPAncestor } from "./ancestor"
import { ACPAgentTree } from "./agent-tree"
import { ACPPermission } from "./permission"
import { ACPQuestion } from "./question"
import { UsageService } from "./usage"
import { ShellTelemetry } from "@/origami/shell-telemetry"
import { SessionStatusEvent } from "@origami/schema/session-status-event"
import { partsToContentChunks, type ReplayPart } from "./content"
import { messageCreated } from "./run-steps"
import { RunStats } from "./run-stats"
import {
  duplicateRunningToolUpdate,
  errorToolUpdate,
  pendingToolCall,
  runningToolUpdate,
  shellOutputSnapshot,
  completedToolUpdate,
} from "./tool"

type Connection = Pick<AgentSideConnection, "sessionUpdate"> &
  Partial<Pick<AgentSideConnection, "requestPermission" | "writeTextFile" | "extNotification">>
type GlobalEventEnvelope = {
  payload?: Event
}
export type GlobalEventStream = {
  stream: AsyncIterable<GlobalEventEnvelope>
}
/** What the task tool writes through `ctx.metadata` (tool/task.ts `metadata`). */
type TaskToolMetadata = {
  sessionId?: unknown
  background?: unknown
  model?: { providerID?: unknown; modelID?: unknown }
} & { [TASK_TOKENS_KEY]?: unknown }

export function start(input: {
  sdk: OrigamiClient
  connection: Connection
  session: ACPSession.Interface
  usage?: UsageService.Interface
  /**
   * t-tc2rlo #8: how `run()` gets the global event stream, injectable so
   * production can hand it an in-process `GlobalBus` reader instead of the
   * default `sdk.global.event(...)`. Un-injected (every existing test), the
   * old HTTP-loopback path runs exactly as before — nothing about `handle()`
   * or the wire frames it produces changes either way. See
   * `globalBusEventSource` for the real one, wired in `acp/service.ts`.
   */
  events?: (options?: { signal?: AbortSignal }) => Promise<GlobalEventStream>
  /** t-z1xlfy: see the Subscription field of the same name. */
  roster?: (sessionId: string, cwd: string) => Promise<void>
}) {
  const subscription = new Subscription(input)
  subscription.start()
  return subscription
}

/**
 * t-tc2rlo #8. The production `events` source for `start()`: reads
 * `GlobalBus` directly, in-process, instead of `sdk.global.event()`. The old
 * path published each event through this engine's OWN `/global/event` SSE
 * handler (a JSON.stringify per client, over a loopback HTTP connection to
 * itself) and parsed it back out the other side — for every text delta, and
 * for every durable part/message update including a 73 MB session-summary row
 * or a multi-MB image part (about 90 ms per JSON pass on a row that size).
 * `GlobalBus` already carries the identical `{directory, project, workspace,
 * payload}` envelope the SSE handler forwards unfiltered — see
 * `handlers/global.ts` — so this is the same events, same order, same
 * content, with the stringify/HTTP/parse round trip removed.
 */
export function globalBusEventSource(options?: { signal?: AbortSignal }): Promise<GlobalEventStream> {
  const queue: GlobalEventEnvelope[] = []
  const waiters: Array<(value: GlobalEventEnvelope | undefined) => void> = []
  let closed = false
  const handler = (event: { payload?: unknown }) => {
    const envelope = event as GlobalEventEnvelope
    const waiter = waiters.shift()
    if (waiter) {
      waiter(envelope)
      return
    }
    queue.push(envelope)
  }
  const cleanup = () => {
    if (closed) return
    closed = true
    GlobalBus.off("event", handler)
    for (const waiter of waiters.splice(0)) waiter(undefined)
  }
  GlobalBus.on("event", handler)
  options?.signal?.addEventListener("abort", cleanup, { once: true })
  const stream: AsyncIterable<GlobalEventEnvelope> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<GlobalEventEnvelope>> {
          if (queue.length) return { value: queue.shift()!, done: false }
          if (closed) return { value: undefined, done: true }
          const value = await new Promise<GlobalEventEnvelope | undefined>((resolve) => waiters.push(resolve))
          if (value === undefined) return { value: undefined, done: true }
          return { value, done: false }
        },
        async return(): Promise<IteratorResult<GlobalEventEnvelope>> {
          cleanup()
          return { value: undefined, done: true }
        },
      }
    },
  }
  return Promise.resolve({ stream })
}

/** Smallest gap between two mid-turn usage updates for one session; each update costs a message
 *  fetch plus a session list. */
export const USAGE_THROTTLE_MS = 2000

/** How many drops of one kind, for one session, pass before another line is printed. */
export const DROP_LOG_EVERY = 100

/** ext-notification method for `handleSessionStatus`. Arrives at the client as
 *  `_origami/sessionStatus` (the Rust SDK prefixes ext method names on the wire). */
export const SESSION_STATUS_METHOD = "origami/sessionStatus"

/** Per-chunk forwarding volume is opt-in; the drop lines above are not. */
const CHILD_CHUNK_DEBUG = process.env["ORIGAMI_ACP_CHILD_CHUNK"] === "1"

/** t-gvz8t0. WHAT a forwarded sub-agent chunk is, when it is not the child's
 *  prose. Only `"reasoning"` is written today. An unmarked chunk keeps its old
 *  meaning exactly, so nothing that predates this rider changes behaviour. */
export const TASK_PART_KEY = "origami_task_part"

/** t-ucnjwp. The tag on every frame of a `history_page` replay (wire_contract.md 2.2). */
export const PAGE_KEY = "origami_page"

/**
 * t-ucnjwp. How a stored message is replayed.
 * - `spend`: where a task marker's rider comes from. Set by every restore and page
 *   path, so a replay reads the child's ROW, never its transcript.
 * - `page`: a `history_page` replay. Every frame is tagged with it, and the replay
 *   touches no live state (part metadata, tool starts, shell snapshots).
 */
export type ReplayOptions = {
  readonly spend?: (childSessionId: string) => Promise<RowTaskTokens | undefined>
  readonly page?: string
}

/** A rider read off a child's ROW: `steps` is absent until the row has a count, and
 *  `context` until the child's newest message has a measured step. */
export type RowTaskTokens = Omit<TaskTokens, "steps" | "context"> & Partial<Pick<TaskTokens, "steps" | "context">>

type Update = Parameters<Connection["sessionUpdate"]>[0]["update"]

/** Merge the page tag into an update's own `_meta`, keeping its other riders. */
function tagged(update: Update, page: string | undefined): Update {
  if (page === undefined) return update
  const meta = (update as { _meta?: Record<string, unknown> | null })._meta ?? {}
  return { ...update, _meta: { ...meta, [PAGE_KEY]: page } } as Update
}

export class Subscription {
  private readonly abort = new AbortController()
  private readonly shellSnapshots = new Map<string, string>()
  private readonly toolStarts = new Set<string>()
  /** Events dropped because their originating session resolves to no registered ACP session (see
   *  `noteDrop`). */
  private readonly drops = new Map<string, number>()
  /** Bytes forwarded per child session — only filled when CHILD_CHUNK_DEBUG. */
  private readonly childBytes = new Map<string, number>()
  private readonly permission: ACPPermission.Handler
  private readonly question: ACPQuestion.Handler
  private readonly usageThrottle = UsageService.makeThrottle(USAGE_THROTTLE_MS)
  private started = false
  /** GOAL MODE sink (session/turn-end.ts). Released by `stop`. */
  private unsubscribeTurnEnd?: () => void
  private unsubscribeCacheState?: () => void
  /** `flock.json` changed on disk (flock/watch.ts). Released the same way. */
  private unsubscribeFlock?: () => void
  /** A request is queued on a provider's cap (session/provider-queue.ts). */
  private unsubscribeProviderQueue?: () => void
  /** A version landed in the artifact store (artifact/events.ts). */
  private unsubscribeArtifacts?: () => void
  /** t-fijy8a F13. One forward at a time per session, so the pair cannot invert
   *  (see `forwardProviderQueue`). Dropped when the last one settles. */
  private readonly queueChains = new Map<string, Promise<void>>()
  /** The waiting line published for a session and not yet being sent. Still
   *  cancellable by its own `started` (see `forwardProviderQueue`). */
  private readonly queuePending = new Map<string, SessionProviderQueue.ProviderQueueEvent>()

  constructor(
    private readonly input: {
      sdk: OrigamiClient
      connection: Connection
      session: ACPSession.Interface
      usage?: UsageService.Interface
      /** Injectable clock so throttle behaviour is testable without sleeping. */
      now?: () => number
      /** t-tc2rlo #8: see `start()`'s field of the same name. */
      events?: (options?: { signal?: AbortSignal }) => Promise<GlobalEventStream>
      /** t-z1xlfy: read and send the chat's roster (acp/agent-tree.ts). Wired in acp/service.ts. */
      roster?: (sessionId: string, cwd: string) => Promise<void>
    },
  ) {
    this.permission = new ACPPermission.Handler(input)
    this.question = new ACPQuestion.Handler(input)
    this.rosterSend = input.roster ? new ACPAgentTree.RosterDebounce(input.roster) : undefined
  }
  /** t-z1xlfy. Coalesced roster sends; undefined when nothing is wired to read one. */
  private readonly rosterSend?: ACPAgentTree.RosterDebounce
  /** t-z1xlfy. Last status sent per descendant background job, so an output tick sends nothing. */
  private readonly backgroundSent = new Map<string, string>()

  start() {
    if (this.started) return
    this.started = true
    this.unsubscribeTurnEnd = onTurnEnd((verdict) => {
      void this.forwardTurnEnd(verdict)
    })
    this.unsubscribeCacheState = onCacheState((push) => {
      void this.forwardCacheState(push)
    })
    this.unsubscribeFlock = FlockWatch.onChanged(() => {
      void this.forwardFlockMailbox()
    })
    this.unsubscribeProviderQueue = SessionProviderQueue.onProviderQueue((event) => {
      void this.forwardProviderQueue(event)
    })
    this.unsubscribeArtifacts = onArtifactChange((change) => {
      void this.forwardArtifactChange(change)
    })
    this.run().catch(() => {
      if (this.abort.signal.aborted) return
    })
  }

  stop() {
    this.unsubscribeTurnEnd?.()
    this.unsubscribeTurnEnd = undefined
    this.unsubscribeCacheState?.()
    this.unsubscribeCacheState = undefined
    this.unsubscribeFlock?.()
    this.unsubscribeFlock = undefined
    this.unsubscribeProviderQueue?.()
    this.unsubscribeProviderQueue = undefined
    this.unsubscribeArtifacts?.()
    this.unsubscribeArtifacts = undefined
    this.queuePending.clear()
    this.queueChains.clear()
    this.rosterSend?.stop()
    this.abort.abort()
  }

  /**
   * The mailbox moved on disk, forwarded as `origami/flockMailbox`.
   *
   * Carries THE SAME OBJECT `flock_mailbox` returns, recomputed here because the
   * writer is usually another process. Not filtered on a session - a mailbox
   * belongs to the Origami, not a chat - and best-effort like the rest.
   */
  private async forwardFlockMailbox() {
    const send = this.input.connection.extNotification?.bind(this.input.connection)
    if (!send) return
    // NO FILE, NO READ. `Store.open()` MINTS an identity and writes one when there
    // is nothing to read, which would orphan every contact of a deleted flock.json.
    if (!FlockStore.exists()) return
    const payload = ((): ACPFlock.Mailbox | undefined => {
      try {
        return ACPFlock.mailbox()
      } catch {
        // A half-written file, or one this build cannot read; the watcher re-reads.
        return undefined
      }
    })()
    if (!payload) return
    await send(FlockWatch.FLOCK_MAILBOX_METHOD, {
      threads: payload.threads,
      waiting: payload.waiting,
      unread: payload.unread,
    }).catch(() => {})
  }

  /**
   * A version landed in the artifact store, forwarded as
   * `origami/artifactsChanged`.
   *
   * The change itself, not the list: the writer is usually a tool in THIS
   * process and the pane re-reads with `artifact_list` when it wants rows, so
   * sending a whole list here would be a second source of truth for the same
   * thing. Not filtered on a session — an artifact belongs to the Origami, not
   * a chat — and best-effort, like every other push on this connection.
   */
  private async forwardArtifactChange(change: ArtifactChange) {
    const send = this.input.connection.extNotification?.bind(this.input.connection)
    if (!send) return
    await send(ACPArtifacts.ARTIFACTS_CHANGED_METHOD, {
      artifactId: change.artifactId,
      ...(change.version === undefined ? {} : { version: change.version }),
      kind: change.kind,
      // Which chat made it. Every window hears every change; only the one
      // holding this session auto-opens a new artifact (t-s49986).
      ...(change.sessionID === undefined ? {} : { sessionID: change.sessionID }),
    }).catch(() => {})
  }

  /**
   * A sub-agent queued on a provider's concurrency cap, forwarded onto its
   * drawer row (t-52cxcw).
   *
   * The childChunk path is the ONLY live surface a queued child has: its
   * transcript row label is frozen at the pending frame and `session.status` is
   * not on the ACP wire. So this goes out as one tagged text line, which the
   * drawer picks up in `SubagentRow.activity` with no extension change.
   *
   * A PARENT's wait is deliberately not forwarded: `resolveTarget` returns no
   * `childSessionId` for it, and a bare "waiting for a provider slot" injected
   * into the main transcript would read as the assistant speaking.
   */
  private forwardProviderQueue(event: SessionProviderQueue.ProviderQueueEvent): Promise<void> {
    // t-fijy8a F13. TWO THINGS, both about the pair rather than either line.
    //
    // ORDER. Each forward reads the session tree before it sends, so two of
    // them raced and an inverted pair left a permanent "waiting" on a row that
    // had long since started (the tail is append-only — a stale line can only
    // be superseded, never erased). One promise chain per session makes the
    // second forward wait for the first.
    //
    // THE EMPTY PAIR. A wait is published the moment the queue looks full, and
    // the permit can be granted with no wait at all. There is nothing to report
    // then: if the `started` arrives while its `waiting` is still queued here,
    // both are dropped and the row says nothing rather than blinking.
    if (event.state.type === "started") {
      if (this.queuePending.delete(event.sessionID)) return Promise.resolve()
    } else {
      this.queuePending.set(event.sessionID, event)
    }
    const chain = (this.queueChains.get(event.sessionID) ?? Promise.resolve()).then(() =>
      this.sendProviderQueue(event),
    )
    this.queueChains.set(event.sessionID, chain)
    return chain.finally(() => {
      if (this.queueChains.get(event.sessionID) === chain) this.queueChains.delete(event.sessionID)
    })
  }

  private async sendProviderQueue(event: SessionProviderQueue.ProviderQueueEvent) {
    // A waiting line whose flag is gone was cancelled by its own `started`:
    // the permit was granted with no wait, so neither half is sent. Clearing
    // it here is also the point after which a `started` can no longer cancel
    // the pair — it queues behind this line instead.
    if (event.state.type === "waiting") {
      if (this.queuePending.get(event.sessionID) !== event) return
      this.queuePending.delete(event.sessionID)
    }
    const target = await this.resolveTarget(event.sessionID).catch(() => undefined)
    if (!target?.childSessionId) return
    const text =
      event.state.type === "waiting"
        ? SessionProviderQueue.waitingLine(event.state.ahead)
        : SessionProviderQueue.startedLine()
    await this.childChunk(target.session.id, target.childSessionId, text).catch(() => {})
  }

  /**
   * GOAL MODE: forward one terminal verdict as `origami/turnEnd`.
   *
   * The verdict is produced long after the ACP `prompt` call for that turn
   * returned, so it arrives on the process-local channel instead
   * (session/turn-end.ts). Filtered on a REGISTERED session, best-effort throughout.
   */
  private async forwardTurnEnd(verdict: { sessionID: string; stopReason: StopReason }) {
    const send = this.input.connection.extNotification?.bind(this.input.connection)
    if (!send) return
    const registered = await Effect.runPromise(this.input.session.tryGet(verdict.sessionID)).catch(() => undefined)
    if (!registered) return
    await send(TURN_END_METHOD, turnEndPayload(verdict.stopReason)).catch(() => {})
  }

  /**
   * Whether this session's prompt prefix is still cached, forwarded as
   * `origami/cacheState` (t-rylyhm).
   *
   * Carries its own session id, unlike `turnEnd`: the engine measures every
   * session it runs, including the children a fan-out started, and only the id
   * says which composer the answer belongs to. Filtered on a REGISTERED
   * session, best-effort throughout - a badge is never worth a failed turn.
   */
  private async forwardCacheState(push: CacheStatePush) {
    const send = this.input.connection.extNotification?.bind(this.input.connection)
    if (!send) return
    const registered = await Effect.runPromise(this.input.session.tryGet(push.sessionId)).catch(() => undefined)
    if (!registered) return
    await send(CACHE_STATE_METHOD, { ...push }).catch(() => {})
  }

  async handle(event: Event) {
    // origami_change: detached shell telemetry is a fork-only EventV2 event.
    if ((event.type as string) === ShellTelemetry.Event.Updated.type) {
      return this.handleShellTelemetry(
        (event as unknown as { properties: EventV2.Data<typeof ShellTelemetry.Event.Updated> }).properties,
      )
    }
    if ((event.type as string) === SessionStatusEvent.Status.type) {
      return this.handleSessionStatus((event as unknown as { properties?: unknown }).properties)
    }
    switch (event.type) {
      case "permission.asked":
        this.permission.handle(event)
        return
      case "question.asked":
        return this.handleQuestionAsked(event)
      case "message.updated":
        return this.handleMessageUpdated(event)
      case "message.part.updated":
        return this.handlePartUpdated(event)
      case "message.part.delta":
        return this.handlePartDelta(event)
      case "session.updated":
        return this.handleSessionUpdated(event)
    }
  }

  /**
   * Whether this session is RUNNING, forwarded as `origami/sessionStatus`.
   *
   * The client's only other start-of-turn signal is the `prompt()` call it made
   * itself, so a turn the ENGINE starts - an injected background task result, a
   * /loop run, a wakeup - would otherwise be invisible. Filtered on a REGISTERED
   * session, best-effort throughout.
   */
  private async handleSessionStatus(properties: unknown) {
    const send = this.input.connection.extNotification?.bind(this.input.connection)
    if (!send) return
    const data = (properties ?? {}) as { sessionID?: unknown; status?: { type?: unknown } }
    const sessionId = typeof data.sessionID === "string" ? data.sessionID : ""
    const status = typeof data.status?.type === "string" ? data.status.type : ""
    if (!sessionId || !status) return
    // Coalesced here and not earlier: an unregistered session must not seed the
    // map, and coalescing after the send would race.
    const registered = await Effect.runPromise(this.input.session.tryGet(sessionId)).catch(() => undefined)
    if (!registered) return this.descendantStatus(sessionId)
    if (this.lastStatus.get(sessionId) === status) return
    this.lastStatus.set(sessionId, status)
    // The LABEL, not the variant object: "idle means the chat is yours again,
    // anything else means it is still going" holds for an unknown variant too.
    await send(SESSION_STATUS_METHOD, { sessionId, status }).catch(() => {})
  }
  /** t-z1xlfy. A sub-agent at any depth started or stopped: its chat's roster is
   *  sent again, so the map learns parent and tier of every descendant. */
  private async descendantStatus(sessionId: string) {
    if (!this.rosterSend) return
    const target = await this.resolveTarget(sessionId).catch(() => undefined)
    if (!target?.childSessionId) return
    this.rosterSend.schedule(target.session.id, target.session.cwd)
  }

  /** Last label forwarded per session - see `handleSessionStatus`. */
  private readonly lastStatus = new Map<string, string>()

  private async handleShellTelemetry(data: EventV2.Data<typeof ShellTelemetry.Event.Updated>) {
    const session = await Effect.runPromise(this.input.session.tryGet(data.sessionId))
    if (!session) return this.descendantBackground(data)
    await this.input.connection.sessionUpdate({
      sessionId: data.sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: data.toolCallId,
        status: data.status === "running" ? "in_progress" : data.status === "completed" ? "completed" : "failed",
        ...(data.output
          ? { content: [{ type: "content", content: { type: "text", text: data.output } }] }
          : {}),
        rawOutput: {
          metadata: {
            background: data.state !== "foreground",
            state: data.state,
            status: data.status,
            startedAt: data.startedAt,
            ...(data.jobId ? { jobId: data.jobId } : {}),
            ...(data.lastOutputAt ? { lastOutputAt: data.lastOutputAt } : {}),
            ...(data.exit !== undefined ? { exit: data.exit } : {}),
          },
        },
        _meta: { origami_tool_name: "bash" },
      },
    }).catch(() => {})
  }

  /** t-z1xlfy. A sub-agent's background shell, on its chat as `origami/backgroundTask`.
   *  Sent on a status CHANGE only: a running shell publishes telemetry per output tick. */
  private async descendantBackground(data: EventV2.Data<typeof ShellTelemetry.Event.Updated>) {
    const send = this.input.connection.extNotification?.bind(this.input.connection)
    if (!send || data.state === "foreground") return
    const key = data.jobId || data.toolCallId
    if (this.backgroundSent.get(key) === data.status) return
    const target = await this.resolveTarget(data.sessionId).catch(() => undefined)
    if (!target?.childSessionId) return
    const task = ACPAgentTree.backgroundTaskOf(target.session.id, data.sessionId, data, this.input.now?.() ?? Date.now())
    if (!task) return
    if (task.status === "running") this.backgroundSent.set(key, task.status)
    else this.backgroundSent.delete(key)
    await send(ACPAgentTree.BACKGROUND_TASK_METHOD, { ...task }).catch(() => {})
  }

  // Assistant messages flagged summary:true (the /compact turn). Tracked from
  // message.updated - published (compaction.ts updateMessage) BEFORE the summary's
  // parts stream - so handlePartDelta can collapse those chunks into a marker.
  private readonly summaryMessageIds = new Set<string>()
  private async handleMessageUpdated(event: EventMessageUpdated) {
    const info = event.properties.info
    if (info?.role === "assistant" && (info as { summary?: boolean }).summary === true && info.id) {
      this.summaryMessageIds.add(info.id)
    }
  }

  private readonly lastTitles = new Map<string, string>()
  // Newest session-row time_updated whose agent we've mode-synced, per session.
  // The global bus is UNORDERED, so only an update at least as new as this
  // high-water mark may move the mode (a stale reordered row can't drag it back).
  private readonly lastModeTimeUpdated = new Map<string, number>()
  /** Push the engine's generated session title to the client via the ACP
   *  `session_info_update` notification. Deduped on the title - `session.updated`
   *  fires on every session mutation. */
  private async handleSessionUpdated(event: EventSessionUpdated) {
    const { sessionID, info } = event.properties
    if (!sessionID) return
    const title = typeof info?.title === "string" ? info.title.trim() : ""
    if (title && this.lastTitles.get(sessionID) !== title) {
      this.lastTitles.set(sessionID, title)
      await this.input.connection.sessionUpdate({
        sessionId: sessionID,
        update: {
          sessionUpdate: "session_info_update",
          title,
        },
      })
    }
    await this.syncModeFromSession(sessionID, info)
  }

  /** Push a session's STORED title on reconnect. `handleSessionUpdated` only
   *  fires while a title is being written, so a chat reopened in a NEW engine
   *  process never sees one. Same notification and dedupe map as the live path. */
  async replayTitle(sessionId: string, title: string) {
    const clean = title.trim()
    if (!clean || this.lastTitles.get(sessionId) === clean) return
    this.lastTitles.set(sessionId, clean)
    await this.input.connection.sessionUpdate({
      sessionId,
      update: { sessionUpdate: "session_info_update", title: clean },
    })
  }

  /** Mirror the session row's agent into ACPSession.modeId + the client's mode
   *  selector. Ties are accepted (>=): applying is idempotent via the modeId
   *  equality skip, and dropping a same-millisecond switch would be worse. */
  private async syncModeFromSession(sessionID: string, info: EventSessionUpdated["properties"]["info"]) {
    const agent = typeof info?.agent === "string" ? info.agent : undefined
    const timeUpdated = typeof info?.time?.updated === "number" ? info.time.updated : undefined
    if (!agent || timeUpdated === undefined) return
    const highwater = this.lastModeTimeUpdated.get(sessionID)
    if (highwater !== undefined && timeUpdated < highwater) return
    this.lastModeTimeUpdated.set(sessionID, timeUpdated)

    const session = await Effect.runPromise(this.input.session.tryGet(sessionID))
    if (!session || session.modeId === agent) return

    await Effect.runPromise(this.input.session.setMode(sessionID, agent).pipe(Effect.ignore))
    await this.input.connection
      .sessionUpdate({
        sessionId: sessionID,
        update: { sessionUpdate: "current_mode_update", currentModeId: agent },
      })
      .catch(() => {})
  }

  async replayMessage(message: SessionMessageResponse, options: ReplayOptions = {}) {
    if (message.info.role !== "assistant" && message.info.role !== "user") return

    const cwd = message.info.role === "assistant" ? message.info.path?.cwd : undefined
    for (const part of message.parts) {
      // t-ucnjwp: an older page is history the live turn must not see, so it records
      // no part metadata (the delta path fetches on a miss) and no tool state.
      if (options.page === undefined) await this.recordFetchedPart(message.info.sessionID, message, part)
      if (part.type === "tool") {
        if (options.page === undefined) await this.handleToolPart(message.info.sessionID, part, cwd ?? process.cwd())
        else await this.pageToolFrames(message.info.sessionID, part, cwd ?? process.cwd(), options.page)
        continue
      }
      // Replay settles the roster too: without it a chat reopened after a fan-out
      // would rebuild every task card and show its long-dead children as still out.
      if (part.type === "text") {
        await this.streamDropNotice(message.info.sessionID, part, options.page)
        await this.taskResultMarkers(
          message.info.sessionID,
          part,
          cwd ?? process.cwd(),
          messageCreated(message.info),
          options,
        )
      }
      await this.replayContentPart(message, part, options.page)
    }
  }

  /**
   * t-ucnjwp. A tool part of an OLDER page: the frames a first replay of it sends
   * (`tool_call`, then the settled or running update), built by the same builders as
   * `handleToolPart`, but without its bookkeeping - `toolStarts` and `shellSnapshots`
   * belong to the live turn, and an old page read during that turn must not move them.
   */
  private async pageToolFrames(sessionId: string, part: ToolPart, cwd: string, page: string) {
    const send = (update: Update) => this.input.connection.sessionUpdate({ sessionId, update: tagged(update, page) })
    const common = { toolCallId: part.callID, toolName: part.tool, cwd }
    await send({ sessionUpdate: "tool_call", ...withTaskSession(pendingToolCall({ ...common, state: part.state }), part) })
    switch (part.state.status) {
      case "running": {
        const output = part.tool === "bash" ? shellOutputSnapshot(part.state) : undefined
        await send({
          sessionUpdate: "tool_call_update",
          ...withTaskSession(runningToolUpdate({ ...common, state: part.state, output }), part),
        })
        return
      }
      case "completed":
        await send({
          sessionUpdate: "tool_call_update",
          ...withTaskSession(completedToolUpdate({ ...common, state: part.state }), part),
        })
        return
      case "error":
        await send({
          sessionUpdate: "tool_call_update",
          ...withTaskSession(errorToolUpdate({ ...common, state: part.state }), part),
        })
        return
    }
  }

  private async replayContentPart(message: SessionMessageResponse, part: Part, page?: string) {
    if (part.type !== "text" && part.type !== "file" && part.type !== "reasoning") return

    const sessionUpdate =
      part.type === "reasoning"
        ? "agent_thought_chunk"
        : message.info.role === "user"
          ? "user_message_chunk"
          : "agent_message_chunk"

    // A PEER's message replays as a user turn like any other, so without the rider
    // a reopened chat would render another agent's handoff as the human's own words.
    const peer = peerMessage((part as { metadata?: unknown }).metadata)

    for (const chunk of partsToContentChunks([part as ReplayPart])) {
      await this.input.connection.sessionUpdate({
        sessionId: message.info.sessionID,
        update: tagged(
          {
            sessionUpdate,
            messageId: message.info.id,
            ...chunk,
            ...(peer ? { _meta: { origami_peer: peer } } : {}),
          },
          page,
        ),
      })
    }
  }

  private async run() {
    // t-tc2rlo #8: default to the old sdk.global.event() (HTTP loopback SSE)
    // when no `events` source was injected, so every existing caller and test
    // keeps its exact current behaviour. Production wires `globalBusEventSource`
    // (acp/service.ts), which reads GlobalBus in-process instead.
    const source: (options?: { signal?: AbortSignal }) => Promise<GlobalEventStream> =
      this.input.events ?? ((options) => this.input.sdk.global.event(options) as unknown as Promise<GlobalEventStream>)
    while (!this.abort.signal.aborted) {
      const events = (await source({
        signal: this.abort.signal,
      })) as GlobalEventStream

      for await (const event of events.stream) {
        if (this.abort.signal.aborted) return
        if (!event.payload) continue
        await this.handle(event.payload).catch(() => {})
      }
      if (!this.abort.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }

  // Resolution of an ORIGINATING session id to the ACP session its events must be
  // published under: a registered session resolves to itself, a sub-agent to its
  // nearest registered ancestor. Cached INCLUDING negatives - this is the delta hot
  // path, and an uncached walk would fire one sdk.session.get per streamed token.
  private readonly forwardTargets = new Map<string, string | null>()

  /**
   * t-po041k. A QUESTION FROM A CHILD NEVER OPENS A DIALOG.
   *
   * `tool/question.ts` has already posted the question into the parent chat as
   * a peer-message envelope; the child is parked waiting for `question_reply`.
   * All that is left here is the row's own words, so the drawer does not show a
   * silent agent while its parent reads the question — the same channel and the
   * same reasoning as `sendProviderQueue`, which puts "waiting for a provider
   * slot" on a row for exactly this reason.
   *
   * The gate is `resolveTarget`, not a flag on the event: whether this session
   * has a window of its own is the only fact that decides who may be asked, and
   * it is the fact `resolveTarget` already answers. A child whose question was
   * NOT relayed (no parent chat open) is rejected by `tool/question.ts` before
   * it parks, so nothing reaches here that a dialog would have rescued.
   */
  private async handleQuestionAsked(event: Extract<Event, { type: "question.asked" }>) {
    const sessionID = event.properties.sessionID
    const askID = event.properties.id
    // t-tc2es2: a failed lookup falls through to the question handler, which
    // answers or rejects the ask; the cause is logged, never dropped.
    const target = await this.resolveTarget(sessionID).catch((cause) => {
      console.error(`[acp-event] question ${askID}: could not resolve session ${sessionID}: ${ACPPermission.describeCause(cause)}`)
      return undefined
    })
    if (target?.childSessionId) {
      await this.childChunk(target.session.id, target.childSessionId, SubagentQuestion.ASKING_LINE).catch((cause) =>
        console.error(`[acp-event] question ${askID}: the asking line was not sent: ${ACPPermission.describeCause(cause)}`),
      )
      return
    }
    this.question.handle(event)
  }

  private async resolveTarget(
    sessionId: string,
  ): Promise<{ session: ACPSession.Info; childSessionId?: string } | undefined> {
    const direct = await Effect.runPromise(this.input.session.tryGet(sessionId))
    if (direct) return { session: direct }

    const cached = this.forwardTargets.get(sessionId)
    if (cached === null) return undefined
    if (cached !== undefined) {
      const known = await Effect.runPromise(this.input.session.tryGet(cached))
      if (known) return { session: known, childSessionId: sessionId }
      this.forwardTargets.delete(sessionId)
      return undefined
    }

    const ancestor = await ACPAncestor.resolveRegisteredAncestor({
      sdk: this.input.sdk,
      session: this.input.session,
      sessionID: sessionId,
    })
    this.forwardTargets.set(sessionId, ancestor?.id ?? null)
    if (!ancestor) return undefined
    return { session: ancestor, childSessionId: sessionId }
  }

  /**
   * A dropped event, said out loud: a silent drop here is how usage_update once
   * went missing. The first drop of a kind for a session always prints, and every
   * DROP_LOG_EVERY-th after it carries the running total. stderr, never stdout -
   * stdout is the JSON-RPC channel.
   */
  private noteDrop(kind: string, sessionId: string) {
    const key = `${kind}:${sessionId}`
    const count = (this.drops.get(key) ?? 0) + 1
    this.drops.set(key, count)
    if (count !== 1 && count % DROP_LOG_EVERY !== 0) return
    console.error(`[acp-event] dropped ${kind} for unregistered session ${sessionId} (${count} so far)`)
  }

  private async handlePartUpdated(event: EventMessagePartUpdated) {
    const part = event.properties.part
    const sessionId = part.sessionID || event.properties.sessionID
    const target = await this.resolveTarget(sessionId)
    if (!target) return this.noteDrop("message.part.updated", sessionId)
    const session = target.session

    await Effect.runPromise(
      this.input.session.recordPartMetadata({
        sessionId: session.id,
        messageId: part.messageID,
        partId: part.id,
        partType: part.type,
        role: part.type === "reasoning" ? "assistant" : undefined,
        ignored: part.type === "text" ? part.ignored : undefined,
        toolCallId: part.type === "tool" ? part.callID : undefined,
        metadata: "metadata" in part ? part.metadata : undefined,
      }),
    )
    // A step-finish part is the engine's "one model round trip is billed" marker,
    // so reporting usage here is what moves the client's gauge DURING a long turn.
    // Child steps resolve to the registered ancestor, so their spend lands there too.
    if (part.type === "step-finish") {
      await this.usageUpdate(session)
      // t-dkkd2o. And, for a CHILD's step, that child's own running total.
      if (target.childSessionId) await this.childTokens(session.id, target.childSessionId, session.cwd, part)
    }
    // A background sub-agent's result, injected into the PARENT as a synthetic turn.
    if (part.type === "text" && !target.childSessionId) {
      await this.peerMessageChunk(session.id, part)
      await this.streamDropNotice(session.id, part)
      await this.taskResultMarkers(session.id, part, session.cwd, Date.now())
      return
    }
    if (part.type !== "tool") return
    if (target.childSessionId) {
      await this.childToolActivity(session.id, target.childSessionId, part)
      return
    }
    await this.handleToolPart(session.id, part, session.cwd)
  }

  /** Mid-turn usage report, at most one per session per USAGE_THROTTLE_MS. */
  private async usageUpdate(session: ACPSession.Info) {
    const usage = this.input.usage
    if (!usage) return
    const now = this.input.now?.() ?? Date.now()
    if (!this.usageThrottle.allow(session.id, now)) return
    // Effect.exit, not Effect.ignore: sendUpdate's error channel is `never`, so a
    // failure arrives as a DEFECT, which `ignore` re-raises and would drop the rest.
    await Effect.runPromise(
      usage
        .sendUpdate({ connection: this.input.connection, sessionID: session.id, directory: session.cwd })
        .pipe(Effect.exit),
    )
  }

  private async handlePartDelta(event: EventMessagePartDelta) {
    const props = event.properties
    const target = await this.resolveTarget(props.sessionID)
    if (!target) return this.noteDrop("message.part.delta", props.sessionID)
    const session = target.session

    const known = await Effect.runPromise(
      this.input.session.tryGetPartMetadata({
        sessionId: session.id,
        messageId: props.messageID,
        partId: props.partID,
      }),
    )
    const metadata =
      known?.role && known.partType
        ? known
        : await this.fetchPartMetadata(session.id, session.cwd, props.messageID, props.partID, target.childSessionId)
    if (metadata?.role !== "assistant") return

    // A forwarded sub-agent delta. Its PROSE goes over unmarked, as it always has.
    // Its REASONING now goes too (t-gvz8t0), marked `origami_task_part: reasoning`:
    // a thinking model can spend two minutes and 7k tokens of thought before its
    // first tool call, and the row showed nothing at all for it, which the owner
    // read as a stall. A receiver that ignores the marker sees no new prose — the
    // marker is what keeps it thought, never the child's reply.
    if (target.childSessionId) {
      if (props.field !== "text") return
      if (metadata.partType === "text" && metadata.ignored !== true) {
        await this.childChunk(session.id, target.childSessionId, props.delta)
      } else if (metadata.partType === "reasoning") {
        await this.childChunk(session.id, target.childSessionId, props.delta, "reasoning")
      }
      return
    }

    const isCompaction = this.summaryMessageIds.has(props.messageID)
    if (metadata.partType === "text" && props.field === "text" && metadata.ignored !== true) {
      await this.input.connection.sessionUpdate({
        sessionId: session.id,
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: props.messageID,
          content: {
            type: "text",
            text: props.delta,
          },
          // Rider (plain ACP clients ignore it): marks this chunk as the /compact
          // summary so the client collapses it into a "Compaction Completed" marker.
          ...(isCompaction ? { _meta: { origami_compaction: true } } : {}),
        },
      })
      return
    }

    if (metadata.partType === "reasoning" && props.field === "text") {
      // Drop the summariser's reasoning scratchpad - not the carried-forward content.
      if (isCompaction) return
      await this.input.connection.sessionUpdate({
        sessionId: session.id,
        update: {
          sessionUpdate: "agent_thought_chunk",
          messageId: props.messageID,
          content: {
            type: "text",
            text: props.delta,
          },
        },
      })
    }
  }

  // `sessionId` is where the metadata is RECORDED; `originSessionId`, when set, is
  // the sub-agent session the message lives in and must therefore be queried with.
  private async fetchPartMetadata(
    sessionId: string,
    cwd: string,
    messageId: string,
    partId: string,
    originSessionId?: string,
  ) {
    const message = await this.input.sdk.session
      .message(
        {
          sessionID: originSessionId ?? sessionId,
          messageID: messageId,
          directory: cwd,
        },
        { throwOnError: true },
      )
      .then((response) => response.data)
      .catch(() => undefined)
    if (!message) return

    const part = message.parts.find((item) => item.id === partId)
    if (!part) return
    return await this.recordFetchedPart(sessionId, message, part)
  }

  private async recordFetchedPart(sessionId: string, message: SessionMessageResponse, part: Part) {
    return await Effect.runPromise(
      this.input.session.recordPartMetadata({
        sessionId,
        messageId: part.messageID,
        partId: part.id,
        partType: part.type,
        role: message.info.role,
        ignored: part.type === "text" ? part.ignored : undefined,
        toolCallId: part.type === "tool" ? part.callID : undefined,
        metadata: "metadata" in part ? part.metadata : undefined,
      }),
    )
  }

  /** One line of a sub-agent's tool activity, forwarded as a tagged message chunk
   *  rather than a real ACP `tool_call` - a forwarded tool_call would materialise a
   *  top-level tool card in EVERY client. VOLUME GUARD: one line per tool START
   *  (deduped on callID by `toolStarts`) plus its error; running ticks are dropped. */
  private async childToolActivity(sessionId: string, childSessionId: string, part: ToolPart) {
    if (part.state.status === "pending" || part.state.status === "running") {
      // t-gyp8fj. NOT from a frame that carries no input yet. The PENDING part is
      // written the moment the model starts streaming the call's NAME, before one
      // argument byte has arrived (session/processor.ts `ensureToolCall` seeds
      // `input: {}`); the running frame is the first that carries the arguments.
      // This line is not only text: for `todowrite` it is the host's SIGNAL to go
      // and read the child's stored input, which is the only copy of the list
      // (packages/vscode/src/dashboard/subagentTodos.ts). Sent on the pending
      // frame, the read lands on `rawInput: {}`, the panel stores an empty list,
      // and the dedupe below means no second signal ever comes — which is how two
      // children wrote their todos and the panel showed no tabs at all. It also
      // made every child's line read `> bash` instead of `> bash: npm test`.
      if (!toolInputArrived(part)) return
      if (this.toolStarts.has(part.callID)) return
      this.toolStarts.add(part.callID)
      await this.childChunk(sessionId, childSessionId, `${childToolLine(part)}\n`)
      return
    }
    // A tool that settled without ever showing an input (a no-argument call, or one
    // rejected before it ran) still owes its one line: the settled part carries the
    // final input, so the line is emitted here rather than lost.
    const announced = this.toolStarts.has(part.callID)
    this.clearTool(part.callID)
    if (!announced) await this.childChunk(sessionId, childSessionId, `${childToolLine(part)}\n`)
    if (part.state.status === "error") {
      await this.childChunk(sessionId, childSessionId, `  ! ${part.state.error}\n`)
    }
  }

  /** `part` marks WHAT the chunk is. Omitted = the child's prose (and its tool
   *  activity lines), the only thing this channel used to carry. `"reasoning"`
   *  is the child's thought: same channel, same child rider, one extra key —
   *  a client that does not know the key renders it inline as before, and one
   *  that does draws it as thought and never as the child's reply. */
  private async childChunk(
    sessionId: string,
    childSessionId: string,
    text: string,
    part?: "reasoning",
  ) {
    // Opt-in volume meter (ORIGAMI_ACP_CHILD_CHUNK=1): how many bytes actually left
    // here, for which child - not measurable from outside the process.
    if (CHILD_CHUNK_DEBUG) {
      const total = (this.childBytes.get(childSessionId) ?? 0) + text.length
      this.childBytes.set(childSessionId, total)
      console.error(`[acp-event] child chunk ${childSessionId} +${text.length}b total=${total}b`)
    }
    await this.input.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
        // Rider (plain ACP clients ignore it and render the chunk inline):
        // attributes this chunk to the sub-agent session that produced it, so a
        // client that knows the key can stream it under that child's task card.
        _meta: { origami_child_session: childSessionId, ...(part ? { [TASK_PART_KEY]: part } : {}) },
      },
    })
  }

  /**
   * A message from ANOTHER AGENT, delivered into this session by tool/agents.ts.
   *
   * Live user parts are otherwise dropped here on purpose (the client typed them
   * and has already echoed them). A peer message is the one user part nobody in
   * this window typed, and it carries the sender + reply address as a rider so the
   * client can badge it as agent-origin.
   */
  private async peerMessageChunk(sessionId: string, part: Part) {
    const peer = peerMessage((part as { metadata?: unknown }).metadata)
    if (!peer || part.type !== "text") return
    await this.input.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "user_message_chunk",
        messageId: part.messageID,
        content: { type: "text", text: part.text },
        _meta: { origami_peer: peer },
      },
    })
  }

  /**
   * A dropped stream, as a STRUCTURED row rather than agent prose.
   *
   * The notice part carries no text at all - the whole notice is the rider - so
   * an empty `agent_message_chunk` is the frame, exactly as `taskResultMarkers`
   * does for a settled sub-agent. A client that does not know the key sees an
   * empty chunk and renders nothing, which is the honest degrade: the old text
   * form put the engine's words under the agent's name.
   *
   * Sent from BOTH the live part update and the history replay, so a reopened
   * chat shows the same card it showed while the drop was happening.
   */
  private async streamDropNotice(sessionId: string, part: Part, page?: string) {
    if (part.type !== "text") return
    const notice = SessionStreamDrop.readNotice((part as { metadata?: unknown }).metadata)
    if (!notice) return
    await this.input.connection.sessionUpdate({
      sessionId,
      update: tagged(
        {
          sessionUpdate: "agent_message_chunk",
          messageId: part.messageID,
          content: { type: "text", text: "" },
          _meta: { [SessionStreamDrop.NOTICE_KEY]: notice },
        },
        page,
      ),
    })
  }

  /** `endedAt` is WHEN the child settled, and the only end a detached sub-agent
   *  ever gets (its launcher's tool state ended back at spawn - see `taskSpan`).
   *  Omitted rather than guessed when a replayed message carries no time. */
  private async taskResultMarkers(
    sessionId: string,
    part: Part,
    cwd: string,
    endedAt?: number,
    options: ReplayOptions = {},
  ) {
    for (const entry of taskResults((part as { metadata?: unknown }).metadata)) {
      // t-dkkd2o. The SETTLED total rides the marker itself: the child's last
      // step-finish already reported one, but only this chunk is guaranteed to
      // be sent after the child stopped, and it is also what a REPLAY has.
      // t-ucnjwp: a replay passes `spend`, which reads the child's ROW; only the
      // live path still goes through `childSpend`.
      const tokens = options.spend
        ? await options.spend(entry.sessionId).catch(() => undefined)
        : await this.childSpend(entry.sessionId, cwd)
      await this.input.connection.sessionUpdate({
        sessionId,
        update: tagged(
          {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "" },
            _meta: {
              origami_task_session: entry.sessionId,
              origami_task_state: entry.state,
              ...(endedAt === undefined ? {} : { origami_task_ended: endedAt }),
              ...(tokens === undefined ? {} : { [TASK_TOKENS_KEY]: tokens }),
            },
          },
          options.page,
        ),
      })
    }
  }

  /**
   * t-dkkd2o. A sub-agent's spend so far, or undefined when NOTHING HAS BEEN
   * MEASURED YET - an unreadable row, or a child that has not been billed for
   * a step. The caller then sends no rider at all, so the last figure stands
   * rather than being overwritten with zeros, and a client that has never had
   * one prints nothing rather than claiming a spend of 0.
   *
   * t-ucndru (lazy loading L3, plan 5.3). Read from the child's session ROW:
   * the projector keeps its tokens, cost and `steps` from the same step-finish
   * parts `RunStats.stat` sums, so the figure is the old one. This used to read
   * the child's WHOLE transcript on every step - S steps of a T MB child read
   * about S x T / 2 MB. The row is read after the projector applied the step:
   * the projector writes inside the event's transaction, and the bus hears the
   * event only after that commit (core `event.ts` `publishEvent`).
   *
   * `context` is one step's figure and is not on the row. A live step passes
   * its step-finish `part` and the figure comes from it with no read. Without
   * one (a settled child's marker), it is ONE read of the child's newest
   * message (owner answer Q3, option i).
   *
   * `cwd` is the PARENT's directory, and that is the right one: the directory
   * selects the instance (server routing reads `directory`), and a sub-agent
   * session is created inside the parent's instance — `tool/task.ts` calls
   * `sessions.create({ parentID })` with no directory of its own, so a child
   * never lives in another instance's store.
   */
  private async childSpend(childSessionId: string, cwd: string, step?: Part) {
    // try/catch, not just a rejection handler: this is a best-effort rider on
    // somebody else's event, and a read that throws rather than rejects must
    // not take the step-finish handling around it down with it.
    let row: Parameters<typeof taskTokensFromRow>[0] | undefined
    try {
      row = await this.input.sdk.session
        .get({ sessionID: childSessionId, directory: cwd }, { throwOnError: true })
        .then((response) => response.data)
        .catch(() => undefined)
    } catch {
      return undefined
    }
    if (!row) return undefined
    // t-f6vig2. A child mid-first-step already HAS a row, zeroed.
    const spend = taskTokensFromRow(row)
    if (!spend) return undefined
    const context = RunStats.stepContext(step) ?? (await this.newestContext(childSessionId, cwd))
    return context === undefined ? spend : { ...spend, context }
  }

  /** t-ucndru. The `context` of a child's newest message: ONE message read,
   *  never the transcript. undefined when that message measured no step. */
  private async newestContext(childSessionId: string, cwd: string) {
    try {
      const newest = await this.input.sdk.session
        .messages({ sessionID: childSessionId, directory: cwd, limit: 1 }, { throwOnError: true })
        .then((response) => response.data)
        .catch(() => undefined)
      return newest ? RunStats.stat(childSessionId, newest).context : undefined
    } catch {
      return undefined
    }
  }

  /**
   * t-dkkd2o. A RUNNING sub-agent's counters, on the side channel its output
   * already uses.
   *
   * They cannot ride the launcher's tool call any more. A background task's
   * call completes the instant the child is SPAWNED, and `ctx.metadata` writes
   * after that reach nothing: session/tools.ts refuses a write to a call that
   * is not running, the processor drops a settled call from `ctx.toolcalls`,
   * and by the time the child takes its second step the parent turn that owned
   * both is over. The child's own step-finish still arrives here, and that is
   * the one moment the figure changed.
   *
   * An EMPTY chunk carrying only riders, like the terminal marker above: a
   * client that does not know the keys renders nothing, and one that does
   * reads the latest total (the extension's mergeTaskRiders keeps the newest).
   */
  private async childTokens(sessionId: string, childSessionId: string, cwd: string, step: Part) {
    const tokens = await this.childSpend(childSessionId, cwd, step)
    if (!tokens) return
    await this.input.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "" },
        _meta: { origami_task_session: childSessionId, [TASK_TOKENS_KEY]: tokens },
      },
    })
  }

  private async handleToolPart(sessionId: string, part: ToolPart, cwd: string) {
    await this.toolStart(sessionId, part, cwd)

    switch (part.state.status) {
      case "pending":
        this.shellSnapshots.delete(part.callID)
        return

      case "running":
        await this.runningTool(sessionId, part, cwd)
        return

      case "completed":
        this.clearTool(part.callID)
        await this.input.connection.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            ...withTaskSession(
              completedToolUpdate({
                toolCallId: part.callID,
                toolName: part.tool,
                state: part.state,
                cwd,
              }),
              part,
            ),
          },
        })
        return

      case "error":
        this.clearTool(part.callID)
        await this.input.connection.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            ...withTaskSession(
              errorToolUpdate({
                toolCallId: part.callID,
                toolName: part.tool,
                state: part.state,
                cwd,
              }),
              part,
            ),
          },
        })
        return
    }
  }

  private async runningTool(sessionId: string, part: ToolPart, cwd: string) {
    if (part.state.status !== "running") return

    const output = part.tool === "bash" ? shellOutputSnapshot(part.state) : undefined
    if (output !== undefined) {
      if (this.shellSnapshots.get(part.callID) === output) {
        await this.input.connection.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            ...withTaskSession(
              duplicateRunningToolUpdate({
                toolCallId: part.callID,
                toolName: part.tool,
                state: part.state,
                cwd,
              }),
              part,
            ),
          },
        })
        return
      }
      this.shellSnapshots.set(part.callID, output)
    }

    await this.input.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        ...withTaskSession(
          runningToolUpdate({
            toolCallId: part.callID,
            toolName: part.tool,
            state: part.state,
            output,
            cwd,
          }),
          part,
        ),
      },
    })
  }

  private async toolStart(sessionId: string, part: ToolPart, cwd: string) {
    if (this.toolStarts.has(part.callID)) return
    this.toolStarts.add(part.callID)
    await this.input.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        ...withTaskSession(
          pendingToolCall({
            toolCallId: part.callID,
            toolName: part.tool,
            state: part.state,
            cwd,
          }),
          part,
        ),
      },
    })
  }

  private clearTool(toolCallId: string) {
    this.toolStarts.delete(toolCallId)
    this.shellSnapshots.delete(toolCallId)
  }
}

// origami_change: lifted out of the Subscription class so the sub-agent
// transcript (acp/subagent-transcript.ts) rides the SAME task metadata.
/**
 * The task tool stamps the child's session id into the tool part's metadata the
 * moment the sub-agent session exists. Ride it on EVERY task tool update so a
 * client can match the forwarded child stream (`_meta.origami_child_session`) to
 * the card that spawned it; `rawOutput` carries the same id only on completion.
 *
 * Two more riders off the same metadata: `origami_task_background` (this child was
 * DETACHED, so the call completing says only "spawned", never "finished") and
 * `origami_task_model` (which model the child was actually routed to).
 */
export function withTaskSession<T extends { _meta?: { [key: string]: unknown } | null }>(update: T, part: ToolPart): T {
  if (part.tool !== "task") return update
  const metadata = (part.state as { metadata?: TaskToolMetadata }).metadata
  if (typeof metadata?.sessionId !== "string") return update
  const model = metadata.model
  const tokens = metadata[TASK_TOKENS_KEY]
  return {
    ...update,
    _meta: {
      ...(update._meta ?? {}),
      origami_task_session: metadata.sessionId,
      ...(metadata.background === true ? { origami_task_background: true } : {}),
      ...(typeof model?.providerID === "string" && typeof model?.modelID === "string"
        ? { origami_task_model: `${model.providerID}/${model.modelID}` }
        : {}),
      ...taskSpan(part.state, metadata.background === true),
      ...(tokens !== null && typeof tokens === "object" && !Array.isArray(tokens) ? { [TASK_TOKENS_KEY]: tokens } : {}),
    },
  }
}

/**
 * WHEN the sub-agent ran, off the stored tool state - the only record that
 * survives the client being restarted. A shell otherwise ages a running sub-agent
 * from the moment its card appeared, so every row in a reopened chat reports a run
 * of zero seconds. THE END IS DROPPED FOR A DETACHED CHILD: a background spawn
 * returns the instant the child is launched, so its tool state ends ~10ms after it
 * starts while the child works on for minutes; the honest end for one rides
 * `taskResultMarkers` instead.
 */
function taskSpan(state: ToolPart["state"], background: boolean) {
  const time = (state as { time?: { start?: unknown; end?: unknown } }).time
  const start = typeof time?.start === "number" && Number.isFinite(time.start) ? time.start : undefined
  const end = typeof time?.end === "number" && Number.isFinite(time.end) ? time.end : undefined
  return {
    ...(start === undefined ? {} : { origami_task_started: start }),
    ...(background || end === undefined ? {} : { origami_task_ended: end }),
  }
}

// "> bash: npm test" / "> read". Reuses pendingToolCall's title resolution so a
// sub-agent's activity line reads the same as the parent's own card.
// Content-bearing tools (write/edit) get a path + preview instead: their title is
// only set on completion, so without this a child write forwarded the bare name.
/** Has this tool part's INPUT landed? `{}` is the placeholder the processor seeds a
 *  pending part with, and is indistinguishable from a genuinely empty argument
 *  object — treated as "not yet", because the settled frame emits the line either
 *  way (`childToolActivity`), so the ambiguous case costs a later line, never a
 *  missing one. */
function toolInputArrived(part: ToolPart): boolean {
  const input = (part.state as { input?: unknown }).input
  return !!input && typeof input === "object" && Object.keys(input).length > 0
}

function childToolLine(part: ToolPart) {
  const snippet = childContentSnippet(part)
  if (snippet) return `> ${part.tool}: ${snippet}`

  const state = part.state as { input?: Record<string, unknown>; title?: string }
  const title = pendingToolCall({
    toolCallId: part.callID,
    toolName: part.tool,
    state: { input: state.input ?? {}, title: state.title },
  }).title
  return title && title !== part.tool ? `> ${part.tool}: ${title}` : `> ${part.tool}`
}

/**
 * "<path> - <opening slice>" for the tools whose ARGUMENTS carry what was actually
 * written - `write`'s `content` and `edit`'s `newString`. Only the arguments are
 * available at forward time (pending/running, before the tool has run), so this is
 * the only honest source. A missing/wrong-typed field means the input didn't parse
 * the way the schema expects: return undefined so `childToolLine` degrades to its
 * bare line rather than guessing.
 */
function childContentSnippet(part: ToolPart): string | undefined {
  const field = part.tool === "write" ? "content" : part.tool === "edit" ? "newString" : undefined
  if (!field) return undefined

  const input = part.state.input
  if (!input || typeof input !== "object") return undefined

  const filePath = (input as Record<string, unknown>).filePath
  const content = (input as Record<string, unknown>)[field]
  if (typeof filePath !== "string" || !filePath) return undefined
  if (typeof content !== "string") return undefined

  const snippet = childContentPreview(content)
  return snippet ? `${filePath} — ${snippet}` : filePath
}

/**
 * Hard cap on a child tool's content preview, counted in CODE POINTS - never
 * UTF-16 units - so a cut can never split a surrogate pair in two (the same rule
 * `run-steps.ts`'s `preview` and `skills.ts`'s `contentPreview` apply).
 */
const CHILD_CONTENT_PREVIEW_LIMIT = 200

function childContentPreview(text: string): string | undefined {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  const points = Array.from(trimmed)
  if (points.length <= CHILD_CONTENT_PREVIEW_LIMIT) return trimmed
  return `${points.slice(0, CHILD_CONTENT_PREVIEW_LIMIT - 1).join("")}…`
}

export * as ACPEvent from "./event"
