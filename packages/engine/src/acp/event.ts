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
import { Effect } from "effect"
import { taskResults } from "@/session/task-result"
import { peerMessage } from "@/session/peer-message"
import { onTurnEnd, turnEndPayload, TURN_END_METHOD, type StopReason } from "@/session/turn-end"
import { ACPSession } from "./session"
import { ACPAncestor } from "./ancestor"
import { ACPPermission } from "./permission"
import { ACPQuestion } from "./question"
import { UsageService } from "./usage"
import { ShellTelemetry } from "@/origami/shell-telemetry"
import { partsToContentChunks, type ReplayPart } from "./content"
import { messageCreated } from "./run-steps"
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
type GlobalEventStream = {
  stream: AsyncIterable<GlobalEventEnvelope>
}
/** What the task tool writes through `ctx.metadata` (tool/task.ts `metadata`). */
type TaskToolMetadata = {
  sessionId?: unknown
  background?: unknown
  model?: { providerID?: unknown; modelID?: unknown }
}

export function start(input: {
  sdk: OrigamiClient
  connection: Connection
  session: ACPSession.Interface
  usage?: UsageService.Interface
}) {
  const subscription = new Subscription(input)
  subscription.start()
  return subscription
}

/**
 * Smallest gap between two mid-turn usage updates for one session. A long turn
 * finishes many steps, and each update costs a message fetch plus a session
 * list; 2s keeps the cost gauge visibly live without turning it into a poll.
 */
export const USAGE_THROTTLE_MS = 2000

/**
 * How many drops of one kind, for one session, pass before another line is
 * printed. A sub-agent whose ancestor is not registered produces a delta per
 * streamed token, so one line each would BE the flood - but a count that never
 * surfaces is the silence this exists to end.
 */
export const DROP_LOG_EVERY = 100

/** Per-chunk forwarding volume is only interesting when someone is measuring
 *  it, so it is opt-in; the drop lines above are not. */
const CHILD_CHUNK_DEBUG = process.env["ORIGAMI_ACP_CHILD_CHUNK"] === "1"

export class Subscription {
  private readonly abort = new AbortController()
  private readonly shellSnapshots = new Map<string, string>()
  private readonly toolStarts = new Set<string>()
  /** Events dropped because their originating session resolves to no
   *  registered ACP session, counted per session id (see `noteDrop`). */
  private readonly drops = new Map<string, number>()
  /** Bytes forwarded per child session — only filled when CHILD_CHUNK_DEBUG. */
  private readonly childBytes = new Map<string, number>()
  private readonly permission: ACPPermission.Handler
  private readonly question: ACPQuestion.Handler
  private readonly usageThrottle = UsageService.makeThrottle(USAGE_THROTTLE_MS)
  private started = false
  /** GOAL MODE sink (session/turn-end.ts). Released by `stop`, so a suite
   *  that builds several subscriptions does not leave dead ones listening. */
  private unsubscribeTurnEnd?: () => void

  constructor(
    private readonly input: {
      sdk: OrigamiClient
      connection: Connection
      session: ACPSession.Interface
      usage?: UsageService.Interface
      /** Injectable clock so throttle behaviour is testable without sleeping. */
      now?: () => number
    },
  ) {
    this.permission = new ACPPermission.Handler(input)
    this.question = new ACPQuestion.Handler(input)
  }

  start() {
    if (this.started) return
    this.started = true
    this.unsubscribeTurnEnd = onTurnEnd((verdict) => {
      void this.forwardTurnEnd(verdict)
    })
    this.run().catch(() => {
      if (this.abort.signal.aborted) return
    })
  }

  stop() {
    this.unsubscribeTurnEnd?.()
    this.unsubscribeTurnEnd = undefined
    this.abort.abort()
  }

  /**
   * GOAL MODE: forward one terminal verdict as `origami/turnEnd`.
   *
   * The verdict is produced in the session layer long after the ACP `prompt`
   * call for that turn returned, so it cannot ride the prompt response - it
   * arrives on the process-local channel instead (session/turn-end.ts explains
   * why that, and not a new public event type).
   *
   * Filtered on a REGISTERED session: the channel is process-wide, and a
   * verdict for a session this connection does not own is not this
   * connection's to announce. Best-effort throughout - a client with no
   * `extNotification`, or a send that rejects, must not surface as an error
   * anywhere, because nothing downstream depends on the badge arriving.
   */
  private async forwardTurnEnd(verdict: { sessionID: string; stopReason: StopReason }) {
    const send = this.input.connection.extNotification?.bind(this.input.connection)
    if (!send) return
    const registered = await Effect.runPromise(this.input.session.tryGet(verdict.sessionID)).catch(() => undefined)
    if (!registered) return
    await send(TURN_END_METHOD, turnEndPayload(verdict.stopReason)).catch(() => {})
  }

  async handle(event: Event) {
    // origami_change: detached shell telemetry is a fork-only EventV2 event.
    if ((event.type as string) === ShellTelemetry.Event.Updated.type) {
      return this.handleShellTelemetry(
        (event as unknown as { properties: EventV2.Data<typeof ShellTelemetry.Event.Updated> }).properties,
      )
    }
    switch (event.type) {
      case "permission.asked":
        this.permission.handle(event)
        return
      case "question.asked":
        this.question.handle(event)
        return
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

  private async handleShellTelemetry(data: EventV2.Data<typeof ShellTelemetry.Event.Updated>) {
    const session = await Effect.runPromise(this.input.session.tryGet(data.sessionId))
    if (!session) return
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

  // Assistant messages flagged summary:true (the /compact turn). Tracked from
  // message.updated - which is published (compaction.ts updateMessage) BEFORE
  // the summary's parts stream - so handlePartDelta can route those chunks into
  // a collapsed "Compaction Completed" marker instead of the live transcript,
  // and drop the summariser's reasoning scratchpad (the bulk of the old noise).
  private readonly summaryMessageIds = new Set<string>()
  private async handleMessageUpdated(event: EventMessageUpdated) {
    const info = event.properties.info
    if (info?.role === "assistant" && (info as { summary?: boolean }).summary === true && info.id) {
      this.summaryMessageIds.add(info.id)
    }
  }

  private readonly lastTitles = new Map<string, string>()
  // Newest session-row time_updated whose agent we've mode-synced, per session.
  // Since Session.setAgentModel became the single agent/model write path (Phase
  // 2a), the session.updated event carries the AUTHORITATIVE agent straight off
  // the projected session row — no reconstruction from user messages needed.
  // The global bus is still UNORDERED, so only an update at least as new as
  // this high-water mark may move the mode (a stale reordered row can't drag
  // it backwards).
  private readonly lastModeTimeUpdated = new Map<string, number>()
  /**
   * Push the engine's generated session title to the client the moment it
   * lands, via the ACP `session_info_update` notification. The client used to
   * poll `listSessions` to discover the title (racy, capped); this makes the
   * tab rename deterministic. `session.updated` fires on every session
   * mutation, so dedupe on the title to avoid re-emitting the same name.
   */
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

  /**
   * Push a session's STORED title on reconnect. `handleSessionUpdated` only
   * fires while a title is being written, so a chat reopened in a NEW engine
   * process never sees one - the title landed in a process that is gone. The
   * client was then left with no ACP-side answer for the tab name at all and
   * fell back to its own placeholder. Same notification and the same dedupe map
   * as the live path, so a later `session.updated` carrying the same title is
   * still a no-op.
   */
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
   *  selector — the AUTHORITATIVE mode sync (setAgentModel is the only agent
   *  write path, and every call lands here as session.updated). Ties accepted
   *  (>=): applying is idempotent via the modeId equality skip, and dropping a
   *  same-millisecond legitimate switch would be worse. */
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

  async replayMessage(message: SessionMessageResponse) {
    if (message.info.role !== "assistant" && message.info.role !== "user") return

    const cwd = message.info.role === "assistant" ? message.info.path?.cwd : undefined
    for (const part of message.parts) {
      await this.recordFetchedPart(message.info.sessionID, message, part)
      if (part.type === "tool") {
        await this.handleToolPart(message.info.sessionID, part, cwd ?? process.cwd())
        continue
      }
      // Replay settles the roster too. Without this a chat reopened after a
      // fan-out finished would rebuild every task card from history and, having
      // never seen the live marker, show its long-dead children as still out.
      if (part.type === "text") await this.taskResultMarkers(message.info.sessionID, part, messageCreated(message.info))
      await this.replayContentPart(message, part)
    }
  }

  private async replayContentPart(message: SessionMessageResponse, part: Part) {
    if (part.type !== "text" && part.type !== "file" && part.type !== "reasoning") return

    const sessionUpdate =
      part.type === "reasoning"
        ? "agent_thought_chunk"
        : message.info.role === "user"
          ? "user_message_chunk"
          : "agent_message_chunk"

    // A PEER's message replays as a user turn like any other, so without the
    // rider a reopened chat would render another agent's handoff as the human's
    // own words. Same key, same shape, live or replayed.
    const peer = peerMessage((part as { metadata?: unknown }).metadata)

    for (const chunk of partsToContentChunks([part as ReplayPart])) {
      await this.input.connection.sessionUpdate({
        sessionId: message.info.sessionID,
        update: {
          sessionUpdate,
          messageId: message.info.id,
          ...chunk,
          ...(peer ? { _meta: { origami_peer: peer } } : {}),
        },
      })
    }
  }

  private async run() {
    while (!this.abort.signal.aborted) {
      const events = (await this.input.sdk.global.event({
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
  // published under. A registered (client-created) session resolves to itself; a
  // sub-agent's session - which is never in the ACP store - resolves to its nearest
  // registered ancestor, and `childSessionId` marks the event as forwarded so the
  // client can attribute it. Cached per originating id INCLUDING negatives: this
  // sits on the delta hot path, and an uncached walk would fire one
  // sdk.session.get per streamed token of every sub-agent. A session that gains a
  // registration later keeps its cached miss - registration happens at
  // newSession/loadSession, always before any child of that session can stream.
  private readonly forwardTargets = new Map<string, string | null>()

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
   * A dropped event, said out loud.
   *
   * The two `if (!target) return` lines below are the whole of a session's
   * output going nowhere: no card, no stream, no cost, and - until this - no
   * trace either. A silent drop here is exactly how usage_update went missing
   * (see the same argument on the client's `unhandled sessionUpdate` warn), so
   * the first one of a kind for a session always prints, and every
   * DROP_LOG_EVERY-th after it carries the running total.
   *
   * stderr, never stdout: stdout is the JSON-RPC channel (ACPProfile.write
   * makes the same choice for the same reason).
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
    // A step-finish part is the engine's own "one model round trip is billed"
    // marker — the projector adds that step's cost onto the session row at the
    // same moment. Reporting usage here is what makes the client's gauge move
    // DURING a long turn instead of only when the prompt resolves. Child steps
    // count too: they resolve to the registered ancestor, so a subagent's spend
    // lands on the ACP session the client is actually watching.
    if (part.type === "step-finish") await this.usageUpdate(session)
    // A background sub-agent's result, injected into the PARENT as a synthetic
    // turn (never under a child id - the stamp only ever lands on the parent).
    if (part.type === "text" && !target.childSessionId) {
      await this.peerMessageChunk(session.id, part)
      await this.taskResultMarkers(session.id, part, Date.now())
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
    // Effect.exit, not Effect.ignore: sendUpdate's error channel is `never`, so
    // anything that goes wrong inside it arrives as a DEFECT, which `ignore`
    // re-raises. An unhandled one here would reject handlePartUpdated and drop
    // the rest of that event's work — a cost report must never cost a tool call.
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

    // A forwarded sub-agent delta: stream the child's PROSE only. Its reasoning is
    // dropped for the same reason the compaction summariser's is (below) - it is
    // scratchpad, and N sub-agents' scratchpads at once is the bulk of the noise
    // with none of the "what is it doing" signal that tool activity already gives.
    if (target.childSessionId) {
      if (metadata.partType === "text" && props.field === "text" && metadata.ignored !== true) {
        await this.childChunk(session.id, target.childSessionId, props.delta)
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
          // Rider (plain ACP clients ignore it): marks this chunk as the
          // /compact summary so the client collapses it into a "Compaction
          // Completed" marker instead of rendering a live assistant turn.
          ...(isCompaction ? { _meta: { origami_compaction: true } } : {}),
        },
      })
      return
    }

    if (metadata.partType === "reasoning" && props.field === "text") {
      // Drop the summariser's reasoning scratchpad entirely - it is not the
      // carried-forward content and was the bulk of the visible compaction noise.
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

  // `sessionId` is where the metadata is RECORDED (the registered ACP session);
  // `originSessionId`, when set, is the sub-agent session the message actually
  // lives in and therefore the one the engine must be queried with - asking for a
  // child's message under the parent's id just misses.
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

  /**
   * One line of a sub-agent's tool activity, forwarded as a tagged message chunk
   * rather than a real ACP `tool_call`. A forwarded tool_call would materialise a
   * top-level tool card in EVERY client - ten sub-agents' inner tools inlined into
   * the parent transcript is precisely the flood this is meant to avoid - whereas
   * the tagged chunk is one stream per child that the client can park under that
   * child's task card. VOLUME GUARD: one line per tool START (deduped on callID by
   * `toolStarts`) plus its error if it fails; running-update ticks (a long bash
   * re-emitting its output snapshot) are dropped for children entirely.
   */
  private async childToolActivity(sessionId: string, childSessionId: string, part: ToolPart) {
    if (part.state.status === "pending" || part.state.status === "running") {
      if (this.toolStarts.has(part.callID)) return
      this.toolStarts.add(part.callID)
      await this.childChunk(sessionId, childSessionId, `${childToolLine(part)}\n`)
      return
    }
    this.clearTool(part.callID)
    if (part.state.status === "error") {
      await this.childChunk(sessionId, childSessionId, `  ! ${part.state.error}\n`)
    }
  }

  private async childChunk(sessionId: string, childSessionId: string, text: string) {
    // Opt-in volume meter (ORIGAMI_ACP_CHILD_CHUNK=1). "Ten sub-agents are
    // flooding the parent" and "the drawer shows nothing" are both answered by
    // the same number - how many bytes actually left here, for which child -
    // and neither was measurable from outside the process.
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
        // Rider (plain ACP clients ignore it and render the chunk inline, which is
        // still strictly more than the nothing they see today): attributes this
        // chunk to the sub-agent session that produced it, so a client that knows
        // the key can stream it under that sub-agent's task card instead of
        // interleaving ten children into the parent's transcript.
        _meta: { origami_child_session: childSessionId },
      },
    })
  }

  /**
   * The end-of-life signal for a BACKGROUND sub-agent: one tagged update per
   * child settled by this injected turn (session/task-result.ts). Sent as a
   * chunk with EMPTY text, the same carrier `childChunk` uses - a plain ACP
   * client ignores the rider and renders nothing, while a client that knows the
   * key learns the child is done without parsing the `<task_result>` blob the
   * turn's text carries for the model.
   */
  /**
   * A message from ANOTHER AGENT, delivered into this session by tool/agents.ts.
   *
   * Live user parts are otherwise dropped here on purpose — the client typed
   * them and has already echoed them, so re-emitting would double every turn.
   * A peer message is the one user part nobody in this window typed, so it is
   * also the one that has to be emitted, and it carries the sender + reply
   * address as a rider so the client can badge it as agent-origin instead of
   * rendering it as its own human speaking.
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
   * `endedAt` is WHEN the child settled, and it is the only end a detached
   * sub-agent ever gets (its launcher's tool state ended back at spawn - see
   * `taskSpan`). LIVE it is now, because this marker is sent as the drainer
   * folds the result in. On REPLAY it is the injected turn's own created time,
   * the same instant `run-steps.ts` reads for the same purpose. Omitted rather
   * than guessed when a replayed message carries no time: a missing duration is
   * a blank, an invented one is a wrong number nobody can tell is wrong.
   */
  private async taskResultMarkers(sessionId: string, part: Part, endedAt?: number) {
    for (const entry of taskResults((part as { metadata?: unknown }).metadata)) {
      await this.input.connection.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "" },
          _meta: {
            origami_task_session: entry.sessionId,
            origami_task_state: entry.state,
            ...(endedAt === undefined ? {} : { origami_task_ended: endedAt }),
          },
        },
      })
    }
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

// origami_change: lifted out of the Subscription class unchanged so the
// sub-agent transcript (acp/subagent-transcript.ts) rides the SAME task
// metadata the live chat does. Two copies of this rider would drift, and the
// key it writes is the only one that names a grandchild session.
/**
 * The task tool stamps the child's session id into the tool part's metadata
 * (ctx.metadata) the moment the sub-agent session exists - long before the call
 * finishes. Ride it on EVERY task tool update so a client can match the forwarded
 * child stream (`_meta.origami_child_session`) to the card that spawned it.
 * `rawOutput` carries the same id but only on the COMPLETED update, which is the
 * whole live phase too late for a foreground sub-agent.
 *
 * Two more riders off the SAME metadata, both live from the first update:
 *  - `origami_task_background`: this child was DETACHED, so the call completing
 *    says only "spawned", never "finished". A client that retires its roster on
 *    the launcher's status alone drops the row while the child is still working;
 *    the honest end-of-life signal is the terminal marker `taskResultMarkers` sends.
 *  - `origami_task_model`: which model the child was actually routed to, which
 *    after a flock binding or a per-chat override is routinely NOT the parent's.
 *    Only the tool knows the resolution, so it has to ride rather than be guessed.
 */
export function withTaskSession<T extends { _meta?: { [key: string]: unknown } | null }>(update: T, part: ToolPart): T {
  if (part.tool !== "task") return update
  const metadata = (part.state as { metadata?: TaskToolMetadata }).metadata
  if (typeof metadata?.sessionId !== "string") return update
  const model = metadata.model
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
    },
  }
}

/**
 * WHEN the sub-agent ran, off the stored tool state — the only record of it
 * that survives the client being restarted.
 *
 * WHY IT HAS TO RIDE. A shell ages a running sub-agent from the moment its own
 * card appeared, which on a RELOAD is the moment of the reload: every row in a
 * reopened chat then reports a run of zero seconds. Nothing in the `session/load`
 * replay carries a time, so the shell has nothing else to age from - while the
 * engine has had `state.time` in the store the whole time.
 *
 * THE END IS DROPPED FOR A DETACHED CHILD, deliberately. A background spawn
 * RETURNS the instant the child is launched, so its tool state ends ~10ms after
 * it starts while the child works on for minutes - `run-steps.ts` measured a
 * real one at 12ms against a child's true 1_591_366ms. Reporting that as the
 * child's span is worse than reporting none. The honest end for a detached
 * child is the injected completion, which rides `taskResultMarkers` instead.
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

// "> bash: npm test" / "> read". Reuses pendingToolCall's title resolution (the
// only exported route to it) so a sub-agent's activity line reads the same as the
// card the parent's own call would get.
//
// Content-bearing tools (write/edit) get a path + preview instead: their own
// title is never set at pending/running time (the tool only returns a title on
// completion - see tool/write.ts, tool/edit.ts), so without this a child write
// forwarded nothing but the bare tool name, and the ~2,000 words it just put in
// a file were invisible to the parent transcript entirely.
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
 * "<path> — <opening slice>" for the tools whose ARGUMENTS carry what was
 * actually written - `write`'s `content` and `edit`'s `newString`, both
 * required non-optional strings in their own Parameters schema (tool/write.ts,
 * tool/edit.ts). Only the arguments are available at forward time (pending/
 * running, before the tool has run) - never the tool's output - so this is the
 * only honest source for "what did it write". A missing/wrong-typed field
 * means the input didn't parse the way the schema expects: return undefined so
 * `childToolLine` degrades to its pre-existing bare line rather than guessing.
 *
 * `apply_patch`/`patch` (tool/apply_patch.ts) is also content-bearing but
 * carries a multi-file unified-diff blob under one `patchText` - a materially
 * different shape (many paths, not one) that deserves its own preview logic,
 * not a bolt-on here. Left uncovered; registry.ts only offers it in place of
 * write/edit for a narrow band of gpt-* models anyway.
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
 * UTF-16 units - so a cut can never split a surrogate pair in two (same rule
 * `run-steps.ts`'s `preview` and `skills.ts`'s `contentPreview` apply).
 *
 * Sized against the flood this whole guard exists to prevent (see
 * `childToolActivity`'s doc comment, which itself uses ten as the illustrative
 * sub-agent count): ten concurrent children each starting a content-bearing
 * tool in the same instant add at most 10 * 200 = 2,000 code points to the
 * parent transcript in that one wave - about a fifth of the ~10,000+
 * characters a SINGLE 2,000-word file dump used to cost under the old
 * "forward everything" approach, and still one glance-able line each.
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
