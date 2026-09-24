import { LayerNode } from "@origami/core/effect/layer-node"
import { PermissionV1 } from "@origami/core/v1/permission"
import { Image } from "@/image/image"
import { SessionV1 } from "@origami/core/v1/session"
import { Cause, Deferred, Effect, Layer, Context, Scope, Schema } from "effect"
import * as Stream from "effect/Stream"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Snapshot } from "@/snapshot"
import { Session } from "./session"
import { LLM } from "./llm"
import { MessageV2 } from "./message-v2"
import { overflowCheck, fixedFloor } from "./overflow"
import { PartID } from "./schema"
import { SessionPromptCapture } from "./prompt-capture"
import { SessionWindowFit } from "./window-fit"
import { SessionCachePolicy } from "./cache-policy"
import type { SessionID } from "./schema"
import { SessionRetry } from "./retry"
import { SessionCacheState } from "./cache-state"
import { SessionStreamDrop } from "./stream-drop"
import { SessionStatus } from "./status"
import { Provider } from "@/provider/provider"
import { Question } from "@/question"
import { NamedError } from "@origami/core/util/error"
import { errorMessage } from "@/util/error"
import { ProviderError } from "@/provider/error"
import { SessionProviderErrorFrame } from "./provider-error-frame"
import { isRecord } from "@/util/record"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@origami/core/database/database"
import { Usage, type LLMEvent } from "@origami/llm"

const DOOM_LOOP_THRESHOLD = 3
export type Result = "compact" | "stop" | "continue"

/** The line the user reads when the provider stopped at its output budget, not
 *  because it was done. The engine does NOT write a "continue" turn on their
 *  behalf: a synthetic continuation is the one repair this codebase refuses. */
const TRUNCATED_NOTICE =
  "The model stopped at its output-token limit, so this reply is cut off. Ask it to carry on if you need the rest."

export interface Handle {
  readonly message: SessionV1.Assistant
  readonly updateToolCall: (
    toolCallID: string,
    update: (part: SessionV1.ToolPart) => SessionV1.ToolPart,
  ) => Effect.Effect<SessionV1.ToolPart | undefined>
  readonly completeToolCall: (
    toolCallID: string,
    output: {
      title: string
      metadata: Record<string, any>
      output: string
      attachments?: SessionV1.FilePart[]
    },
  ) => Effect.Effect<void>
  readonly process: (streamInput: LLM.StreamInput) => Effect.Effect<Result>
  /** t-tc20mj: the last `process` was refused as a context overflow, by the
   *  provider (`"provider"`) or by the request layer's own window check, which
   *  sent nothing (`"window"`). Undefined when it was not refused. */
  readonly overflowed?: "provider" | "window"
  /**
   * The tree the last step-finish recorded, when no step is open after it. The
   * next step of the SAME turn passes it back as `Input.snapshot`, so it does
   * not stage the worktree again to get the tree it already has.
   */
  readonly finishSnapshot?: () => string | undefined
}

type Input = {
  assistantMessage: SessionV1.Assistant
  sessionID: SessionID
  model: Provider.Model
  /**
   * The start snapshot, when the caller has one: the previous step's
   * `finishSnapshot()`, with nothing run between that step and this one.
   * Absent, the processor takes a new snapshot.
   */
  snapshot?: string
}

export interface Interface {
  readonly create: (input: Input) => Effect.Effect<Handle>
}

type ToolCall = {
  partID: SessionV1.ToolPart["id"]
  messageID: SessionV1.ToolPart["messageID"]
  sessionID: SessionV1.ToolPart["sessionID"]
  done: Deferred.Deferred<void>
}

interface ProcessorContext extends Input {
  toolcalls: Record<string, ToolCall>
  shouldBreak: boolean
  snapshot: string | undefined
  /** The tree of the last step-finish; the next step starts from it. */
  finished: string | undefined
  blocked: boolean
  needsCompaction: boolean
  /** t-tc20mj: see `Handle.overflowed`. */
  overflowed: "provider" | "window" | undefined
  currentText: SessionV1.TextPart | undefined
  reasoningMap: Record<string, SessionV1.ReasoningPart>
  /**
   * Set once this step has committed to a tool call. Redoing a step re-sends the
   * identical request, so a tool that already ran could run twice — harmless for
   * a read, not for a write or a shell command. Set at `tool-call` rather than
   * `tool-result` because a stream dying between the two leaves the tool
   * mid-flight, and "we do not know" has to count as "it ran".
   */
  toolCommitted: boolean
  /**
   * Set once the provider has NAMED how this step ended. `step-finish` is the
   * only event carrying a finish reason, and `"unknown"` is not one: both
   * runtimes use that literal for "the body stopped and never said". Tracked per
   * attempt rather than read off `assistantMessage.finish`, because the native
   * runtime emits no `step-finish` at all then and would leave the field unset.
   */
  terminal: boolean
  /**
   * Set when a `step-finish` DID arrive and named the reason `"unknown"`. The
   * strict complement of `terminal` for that one event, and not the same fact:
   * total silence sets neither. It is the only way to separate "the body died"
   * from "the body finished and its stop reason maps to nothing".
   */
  sawUnknownFinish: boolean
  /**
   * Set once this attempt has committed NON-EMPTY model prose. The second half
   * of the unknown-finish decision: prose means a redo would pay for the same
   * generation twice, no prose means discard-and-redo is sound. Counted from the
   * text events only, so an engine notice cannot masquerade as model output.
   */
  proseCommitted: boolean
  /**
   * When the CURRENT step's request began, as a wall clock reading. Set once
   * before the stream is drained, then at every `step-start` after the first.
   * The first step keeps the drain reading on purpose: its prefill is the whole
   * signal `ttftMs` exists to carry. Later steps take their own `step-start`,
   * because the gap before one is the engine running a tool, not the provider.
   */
  stepStartedAt: number | undefined
  /**
   * Milliseconds from `stepStartedAt` to the first content-bearing event of this
   * step, or undefined while the step has produced nothing. On a cache-blind
   * provider (one reporting no cache tokens) this is the only evidence a prefix
   * was reused: a hit is flat across steps, a miss climbs with the prompt.
   */
  ttftMs: number | undefined
  /**
   * Per part id, when that tool part was last written to the event journal. A
   * running tool rewrites its WHOLE part on every progress callback (a shell
   * streaming output, a sub-agent reporting a step), and journalling each one is
   * what made one measured session 424 MB of events for 7.1 MB of final parts.
   * Progress between the closing state and `JOURNAL_COALESCE_MS` is projected to
   * the part table and the UI without a journal row.
   */
  journalledAt: Record<string, number>
}

/**
 * The bound on coalescing. A tool that streams for a minute writes about twelve
 * journal rows instead of one per callback; a process that dies mid-tool loses at
 * most this much of that tool's progress FROM THE JOURNAL ONLY — the part table,
 * which is what the chat and every reader use, is written on every update as it
 * always was.
 */
const JOURNAL_COALESCE_MS = 5_000

/**
 * The events that count as the step having PRODUCED something. Deliberately not
 * `text-start`/`reasoning-start`: those are block openings a provider can emit
 * ahead of any generated token, so timing to them would measure the response
 * envelope rather than the model. `tool-input-start` is in, because a tool-only
 * step emits no text at all.
 */
const TTFT_CONTENT_EVENTS: ReadonlySet<string> = new Set([
  "text-delta",
  "reasoning-delta",
  "tool-input-start",
  "tool-input-delta",
  "tool-call",
])

type StreamEvent = LLMEvent

export class Service extends Context.Service<Service, Interface>()("@origami/SessionProcessor") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const session = yield* Session.Service
    const config = yield* Config.Service
    const snapshot = yield* Snapshot.Service
    const agents = yield* Agent.Service
    const llm = yield* LLM.Service
    const permission = yield* Permission.Service
    const plugin = yield* Plugin.Service
    const scope = yield* Scope.Scope
    const status = yield* SessionStatus.Service
    const image = yield* Image.Service
    const events = yield* EventV2Bridge.Service
    const database = yield* Database.Service
    const providers = yield* Provider.Service

    const create = Effect.fn("SessionProcessor.create")(function* (input: Input) {
      // Pre-capture before the stream starts: the AI SDK may execute tools
      // internally before emitting start-step, so the event handler is too late.
      const initialSnapshot = input.snapshot ?? (yield* snapshot.track())
      const ctx: ProcessorContext = {
        assistantMessage: input.assistantMessage,
        sessionID: input.sessionID,
        model: input.model,
        toolcalls: {},
        shouldBreak: false,
        snapshot: initialSnapshot,
        finished: undefined,
        blocked: false,
        needsCompaction: false,
        overflowed: undefined,
        currentText: undefined,
        reasoningMap: {},
        toolCommitted: false,
        terminal: false,
        sawUnknownFinish: false,
        proseCommitted: false,
        stepStartedAt: undefined,
        ttftMs: undefined,
        journalledAt: {},
      }
      let aborted = false

      // A ContextOverflowError INSTANCE is the request layer's own refusal
      // (session/window-fit.ts, t-tc20mj): already classified, nothing to read.
      const parse = (e: unknown) =>
        e instanceof SessionV1.ContextOverflowError
          ? e.toObject()
          : MessageV2.fromError(e, {
              providerID: input.model.providerID,
              aborted,
            })

      const settleToolCall = Effect.fn("SessionProcessor.settleToolCall")(function* (toolCallID: string) {
        const done = ctx.toolcalls[toolCallID]?.done
        delete ctx.toolcalls[toolCallID]
        if (done) yield* Deferred.succeed(done, undefined).pipe(Effect.ignore)
      })

      const readToolCall = Effect.fn("SessionProcessor.readToolCall")(function* (toolCallID: string) {
        const call = ctx.toolcalls[toolCallID]
        if (!call) return undefined
        const part = yield* session.getPart({
          partID: call.partID,
          messageID: call.messageID,
          sessionID: call.sessionID,
        })
        if (!part || part.type !== "tool") {
          delete ctx.toolcalls[toolCallID]
          return undefined
        }
        return { call, part }
      })

      const updateToolCall = Effect.fn("SessionProcessor.updateToolCall")(function* (
        toolCallID: string,
        update: (part: SessionV1.ToolPart) => SessionV1.ToolPart,
      ) {
        const match = yield* readToolCall(toolCallID)
        if (!match) return undefined
        const next = update(match.part)
        // An open part is still streaming: journal it only when the coalescing
        // window has run out. A closed one (completed, error) is the state the
        // journal has to carry, so it is always written.
        const now = Date.now()
        const open = next.state.status === "pending" || next.state.status === "running"
        const due = now - (ctx.journalledAt[next.id] ?? 0) >= JOURNAL_COALESCE_MS
        if (!open || due) ctx.journalledAt[next.id] = now
        const part = yield* session.updatePart(next, open && !due ? { journal: false } : undefined)
        ctx.toolcalls[toolCallID] = {
          ...match.call,
          partID: part.id,
          messageID: part.messageID,
          sessionID: part.sessionID,
        }
        return part
      })

      const completeToolCall = Effect.fn("SessionProcessor.completeToolCall")(function* (
        toolCallID: string,
        output: {
          title: string
          metadata: Record<string, any>
          output: string
          attachments?: SessionV1.FilePart[]
        },
      ) {
        const match = yield* readToolCall(toolCallID)
        if (!match || match.part.state.status !== "running") return
        yield* session.updatePart({
          ...match.part,
          state: {
            status: "completed",
            input: match.part.state.input,
            output: output.output,
            metadata: output.metadata,
            title: output.title,
            time: { start: match.part.state.time.start, end: Date.now() },
            attachments: output.attachments,
          },
        })
        yield* settleToolCall(toolCallID)
      })

      const failToolCall = Effect.fn("SessionProcessor.failToolCall")(function* (toolCallID: string, error: unknown) {
        const match = yield* readToolCall(toolCallID)
        if (!match || match.part.state.status !== "running") return false
        yield* session.updatePart({
          ...match.part,
          state: {
            status: "error",
            input: match.part.state.input,
            error: errorMessage(error),
            // Keep metadata streamed while running so failures retain progress detail (e.g. execute's child calls).
            metadata: match.part.state.metadata,
            time: { start: match.part.state.time.start, end: Date.now() },
          },
        })
        // DeniedError belongs beside the two refusals: a rule-denied call is not
        // transient — nobody was asked, and retrying is refused identically.
        if (
          error instanceof PermissionV1.RejectedError ||
          error instanceof PermissionV1.DeniedError ||
          error instanceof Question.RejectedError
        ) {
          ctx.blocked = ctx.shouldBreak
          // A refused SUB-agent has to say so upwards. Its turn ends with no
          // text, and tool/task.ts only inspects `info.error`, so recording the
          // refusal there is what makes task.ts render <task_error> instead of
          // an empty <task_result>. Main sessions are deliberately untouched —
          // the user did the refusing. Gated on ctx.blocked as well as parentID,
          // so `experimental.continue_loop_on_deny` still means "carry on".
          if (ctx.blocked) {
            const info = yield* session.get(ctx.sessionID).pipe(Effect.orDie)
            if (info.parentID) {
              // WHO refused matters: a human saying no is a decision to take
              // back to them, a config rule saying no is a setting to change.
              const cause =
                error instanceof PermissionV1.DeniedError
                  ? `a permission rule blocks the "${match.part.tool}" tool call. ${error.message}`
                  : error instanceof PermissionV1.RejectedError && error.reason
                    ? `the "${match.part.tool}" tool call was refused: ${error.reason}`
                    : `the user refused the "${match.part.tool}" tool call`
              ctx.assistantMessage.error ??= new NamedError.Unknown({
                message: `${Permission.DENIED_PREFIX}${cause}`,
              }).toObject()
            }
          }
        }
        yield* settleToolCall(toolCallID)
        return true
      })

      const finishReasoning = Effect.fn("SessionProcessor.finishReasoning")(function* (reasoningID: string) {
        if (!(reasoningID in ctx.reasoningMap)) return
        // oxlint-disable-next-line no-self-assign -- reactivity trigger
        ctx.reasoningMap[reasoningID].text = ctx.reasoningMap[reasoningID].text
        ctx.reasoningMap[reasoningID].time = { ...ctx.reasoningMap[reasoningID].time, end: Date.now() }
        yield* session.updatePart(ctx.reasoningMap[reasoningID])
        delete ctx.reasoningMap[reasoningID]
      })

      const ensureToolCall = Effect.fn("SessionProcessor.ensureToolCall")(function* (input: {
        id: string
        name: string
        providerExecuted?: boolean
      }) {
        const existing = yield* readToolCall(input.id)
        if (existing) {
          if (!input.providerExecuted || existing.part.metadata?.providerExecuted) return existing
          const part = yield* session.updatePart({
            ...existing.part,
            metadata: { ...existing.part.metadata, providerExecuted: true },
          })
          ctx.toolcalls[input.id] = {
            ...existing.call,
            partID: part.id,
            messageID: part.messageID,
            sessionID: part.sessionID,
          }
          return { call: ctx.toolcalls[input.id], part }
        }
        const part = yield* session.updatePart({
          id: PartID.ascending(),
          messageID: ctx.assistantMessage.id,
          sessionID: ctx.assistantMessage.sessionID,
          type: "tool",
          tool: input.name,
          callID: input.id,
          state: { status: "pending", input: {}, raw: "" },
          metadata: input.providerExecuted ? { providerExecuted: true } : undefined,
        } satisfies SessionV1.ToolPart)
        ctx.toolcalls[input.id] = {
          done: yield* Deferred.make<void>(),
          partID: part.id,
          messageID: part.messageID,
          sessionID: part.sessionID,
        }
        return { call: ctx.toolcalls[input.id], part }
      })

      const isFilePart = (value: unknown): value is SessionV1.FilePart => Schema.is(SessionV1.FilePart)(value)

      const toolResultOutput = (
        value: Extract<StreamEvent, { type: "tool-result" }>,
      ): { title: string; metadata: Record<string, any>; output: string; attachments?: SessionV1.FilePart[] } => {
        if (isRecord(value.result.value) && typeof value.result.value.output === "string") {
          return {
            title: typeof value.result.value.title === "string" ? value.result.value.title : value.name,
            metadata: isRecord(value.result.value.metadata) ? value.result.value.metadata : {},
            output: value.result.value.output,
            attachments: Array.isArray(value.result.value.attachments)
              ? value.result.value.attachments.filter(isFilePart)
              : undefined,
          }
        }
        return {
          title: value.name,
          metadata: value.result.type === "json" && isRecord(value.result.value) ? value.result.value : {},
          output:
            typeof value.result.value === "string" ? value.result.value : (JSON.stringify(value.result.value) ?? ""),
        }
      }

      const handleEvent = Effect.fnUntraced(function* (value: StreamEvent) {
        // First content of this step only: `ttftMs` is cleared at each
        // `step-start`. Clamped at zero against a clock that steps backwards.
        if (ctx.ttftMs === undefined && ctx.stepStartedAt !== undefined && TTFT_CONTENT_EVENTS.has(value.type)) {
          ctx.ttftMs = Math.max(0, Date.now() - ctx.stepStartedAt)
        }
        switch (value.type) {
          case "reasoning-start":
            if (value.id in ctx.reasoningMap) return
            ctx.reasoningMap[value.id] = {
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "reasoning",
              text: "",
              time: { start: Date.now() },
              metadata: value.providerMetadata,
            }
            yield* session.updatePart(ctx.reasoningMap[value.id])
            return

          case "reasoning-delta":
            // Match dev: silently drop orphan deltas (no preceding reasoning-start).
            if (!(value.id in ctx.reasoningMap)) return
            ctx.reasoningMap[value.id].text += value.text
            if (value.providerMetadata) ctx.reasoningMap[value.id].metadata = value.providerMetadata
            yield* session.updatePartDelta({
              sessionID: ctx.reasoningMap[value.id].sessionID,
              messageID: ctx.reasoningMap[value.id].messageID,
              partID: ctx.reasoningMap[value.id].id,
              field: "text",
              delta: value.text,
            })
            return

          case "reasoning-end":
            if (value.providerMetadata && value.id in ctx.reasoningMap) {
              ctx.reasoningMap[value.id].metadata = value.providerMetadata
            }
            yield* finishReasoning(value.id)
            return

          case "tool-input-start":
            if (ctx.assistantMessage.summary) {
              throw new Error(`Tool call not allowed while generating summary: ${value.name}`)
            }
            yield* ensureToolCall(value)
            return

          case "tool-input-delta":
            yield* ensureToolCall(value)
            return

          case "tool-input-end": {
            yield* ensureToolCall(value)
            return
          }

          case "tool-call": {
            if (ctx.assistantMessage.summary) {
              throw new Error(`Tool call not allowed while generating summary: ${value.name}`)
            }
            ctx.toolCommitted = true
            yield* ensureToolCall(value)
            const input = isRecord(value.input) ? value.input : { value: value.input }
            yield* updateToolCall(value.id, (match) => ({
              ...match,
              tool: value.name,
              state:
                match.state.status === "running"
                  ? { ...match.state, input }
                  : {
                      status: "running",
                      input,
                      time: { start: Date.now() },
                    },
              metadata: match.metadata?.providerExecuted
                ? { ...value.providerMetadata, providerExecuted: true }
                : value.providerMetadata,
            }))

            const parts = yield* MessageV2.parts(ctx.assistantMessage.id).pipe(
              Effect.provideService(Database.Service, database),
            )
            const recentParts = parts.slice(-DOOM_LOOP_THRESHOLD)

            if (
              recentParts.length !== DOOM_LOOP_THRESHOLD ||
              !recentParts.every(
                (part) =>
                  part.type === "tool" &&
                  part.tool === value.name &&
                  part.state.status !== "pending" &&
                  JSON.stringify(part.state.input) === JSON.stringify(input),
              )
            ) {
              return
            }

            const agent = yield* agents.get(ctx.assistantMessage.agent)
            yield* permission.ask({
              permission: "doom_loop",
              patterns: [value.name],
              sessionID: ctx.assistantMessage.sessionID,
              metadata: { tool: value.name, input },
              always: [value.name],
              ruleset: agent.permission,
            })
            return
          }

          case "tool-result": {
            const toolCall = yield* readToolCall(value.id)
            if (!toolCall && value.result.type === "error") return
            if (value.result.type === "error") {
              yield* failToolCall(value.id, value.result.value)
              return
            }
            const rawOutput = toolResultOutput(value)
            const normalized = yield* Effect.forEach(rawOutput.attachments ?? [], (attachment) =>
              attachment.mime.startsWith("image/")
                ? image.normalize(attachment).pipe(
                    Effect.catchIf(
                      (error) => error instanceof Image.ResizerUnavailableError,
                      () => Effect.succeed(attachment),
                    ),
                    Effect.map((file) => ({ ok: true as const, file })),
                    Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
                  )
                : Effect.succeed({ ok: true as const, file: attachment as SessionV1.FilePart }),
            )
            const refused = normalized.filter((item) => !item.ok)
            const attachments = normalized.flatMap((item) => (item.ok ? [item.file] : []))
            // The note is the ONLY thing the model learns about a picture it did
            // not get, so it names the limit — or it re-reads the file forever.
            const cap = Image.megabytes(yield* image.maxBase64Bytes)
            const output = {
              ...rawOutput,
              output:
                refused.length === 0
                  ? rawOutput.output
                  : `${rawOutput.output}\n\n[${refused.length} image${refused.length === 1 ? "" : "s"} omitted: could not be brought under the ${cap} limit this provider accepts. Ask for a smaller capture, a crop, or a lower resolution.]`,
              attachments: attachments.length ? attachments : undefined,
            }
            yield* completeToolCall(value.id, output)
            return
          }

          case "tool-error": {
            yield* failToolCall(value.id, value.error ?? new Error(value.message))
            return
          }

          case "provider-error": {
            // t-h8s3xg. The sentence stays BARE unless it says nothing: the
            // stream-drop classifier reads these words. `describe` returns
            // undefined for every frame that already stands on its own.
            const described = SessionProviderErrorFrame.describe({
              sentence: value.message,
              providerMetadata: value.providerMetadata,
              providerID: ctx.model.providerID,
              modelID: ctx.model.api.id,
              elapsedMs: ctx.stepStartedAt === undefined ? undefined : Date.now() - ctx.stepStartedAt,
            })
            if (described) throw new ProviderError.StreamFrameError(described.message, described.detail)
            throw new Error(value.message)
          }

          case "step-start":
            ctx.ttftMs = undefined
            // Step 0 keeps the reading taken before the drain - see
            // `stepStartedAt`. Every later step is its own request.
            if (value.index > 0) ctx.stepStartedAt = Date.now()
            // A later step in this stream starts from the tree the previous
            // step-finish recorded: nothing the step did can be missing from it.
            if (!ctx.snapshot) ctx.snapshot = ctx.finished ?? (yield* snapshot.track())
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.sessionID,
              snapshot: ctx.snapshot,
              type: "step-start",
            })
            return

          case "step-finish": {
            const completedSnapshot = yield* snapshot.track()
            ctx.finished = completedSnapshot
            yield* Effect.forEach(Object.keys(ctx.reasoningMap), finishReasoning)
            const usage = Session.getUsage({
              model: ctx.model,
              usage: value.usage ?? new Usage({}),
              metadata: value.providerMetadata,
            })
            // "unknown" is what both runtimes write when the body stopped
            // without a finish reason, so it does not count as being told.
            if (value.reason !== "unknown") ctx.terminal = true
            else ctx.sawUnknownFinish = true
            ctx.assistantMessage.finish = value.reason
            ctx.assistantMessage.cost += usage.cost
            ctx.assistantMessage.tokens = usage.tokens
            // t-tc20mj: the real prompt size, so the next request's estimate is
            // scaled to this endpoint's tokenizer (session/window-fit.ts).
            SessionWindowFit.observe(
              ctx.sessionID,
              usage.tokens.input + usage.tokens.cache.read + usage.tokens.cache.write,
            )
            // The cached prefix this step was sent, and how long the provider
            // took to say anything. Both are OMITTED rather than zeroed when
            // absent, so "no capture staged" reads apart from "prefix empty",
            // and "no content" from "the reply was instant".
            const prefix = SessionPromptCapture.prefixDigest(ctx.sessionID)
            // origami_change-start (t-rylleg: cache-loss cause)
            // WHY this step read nothing from the prefix cache, derived from
            // what the request layer measured about the request that produced
            // it. Absent on a cache-blind provider and on a request that staged
            // no capture, because an unmeasured cache is not a measured miss.
            const cache = cacheBlock({
              facts: SessionPromptCapture.lastRequest(ctx.sessionID),
              usage: value.usage,
              tokens: usage.tokens,
              model: ctx.model,
            })
            // origami_change-end
            yield* session.updatePart({
              id: PartID.ascending(),
              reason: value.reason,
              snapshot: completedSnapshot,
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "step-finish",
              tokens: usage.tokens,
              cost: usage.cost,
              ...(prefix
                ? {
                    prefix: {
                      system: prefix.system,
                      tools: prefix.tools,
                      ...(prefix.history === undefined ? {} : { history: prefix.history }),
                    },
                  }
                : {}),
              ...(cache ? { cache } : {}),
              ...(ctx.ttftMs === undefined ? {} : { ttftMs: ctx.ttftMs }),
            })
            yield* session.updateMessage(ctx.assistantMessage)
            // The composer's warm badge (t-rylyhm). The RAW count, not
            // `usage.tokens.cache.read`: `getUsage` floors an absent figure to
            // zero, and "the provider reported nothing" is a different fact
            // from "the provider reported a miss" - one is unmeasured, the
            // other is cold.
            SessionCacheState.measured({
              sessionID: ctx.sessionID,
              cacheRead: value.usage?.cacheReadInputTokens,
            })
            if (ctx.snapshot) {
              // The file list from the two trees, with no second add pass.
              // Without a finish tree the patch stages the worktree itself.
              const patch = yield* snapshot.patch(ctx.snapshot, completedSnapshot)
              if (patch.files.length) {
                yield* session.updatePart({
                  id: PartID.ascending(),
                  messageID: ctx.assistantMessage.id,
                  sessionID: ctx.sessionID,
                  type: "patch",
                  hash: patch.hash,
                  files: patch.files,
                })
              }
              ctx.snapshot = undefined
            }
            if (!ctx.assistantMessage.summary) {
              // Per-chat threshold override, the same row compaction.ts's
              // isOverflow reads — best-effort, never blocks on a missing row.
              const row = yield* session.get(ctx.sessionID).pipe(Effect.catch(() => Effect.succeed(undefined)))
              // The floor is passed HERE, not left to compaction.ts, because
              // this site fires on a live turn: a full window whose remainder is
              // nearly all fixed block must not buy a summary that removes a few
              // percent. See session/overflow.ts.
              const check = overflowCheck({
                cfg: yield* config.get(),
                tokens: usage.tokens,
                model: ctx.model,
                thresholdOverride: row ? Session.compactionThreshold(row) : undefined,
                floor: fixedFloor(ctx.sessionID),
              })
              if (check.gated)
                yield* Effect.logInfo("compaction held back: too little history to remove", {
                  "session.id": ctx.sessionID,
                  count: check.count,
                  floor: check.floor,
                  history: check.history,
                  required: check.required,
                  usable: check.usable,
                })
              if (check.overflow) {
                ctx.needsCompaction = true
              }
            }
            return
          }

          case "text-start":
            ctx.currentText = {
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "text",
              text: "",
              time: { start: Date.now() },
              metadata: value.providerMetadata,
            }
            yield* session.updatePart(ctx.currentText)
            return

          case "text-delta":
            if (!ctx.currentText) {
              // The DROP stays — emitting into an already-closed block is fatal
              // downstream. But it must not be silent: this is the one path
              // that could lose model output with no trace anywhere.
              yield* Effect.logWarning("dropped text-delta with no open text part", {
                sessionID: ctx.sessionID,
                messageID: ctx.assistantMessage.id,
                chars: value.text.length,
                text: value.text.slice(0, 200),
              })
              return
            }
            ctx.currentText.text += value.text
            // An EMPTY delta is a structural marker, not an answer.
            if (value.text.length > 0) ctx.proseCommitted = true
            if (value.providerMetadata) ctx.currentText.metadata = value.providerMetadata
            yield* session.updatePartDelta({
              sessionID: ctx.currentText.sessionID,
              messageID: ctx.currentText.messageID,
              partID: ctx.currentText.id,
              field: "text",
              delta: value.text,
            })
            return

          case "text-end":
            if (!ctx.currentText) return
            // oxlint-disable-next-line no-self-assign -- reactivity trigger
            ctx.currentText.text = ctx.currentText.text
            ctx.currentText.text = (yield* plugin.trigger(
              "experimental.text.complete",
              {
                sessionID: ctx.sessionID,
                messageID: ctx.assistantMessage.id,
                partID: ctx.currentText.id,
              },
              { text: ctx.currentText.text },
            )).text
            {
              const end = Date.now()
              ctx.currentText.time = { start: ctx.currentText.time?.start ?? end, end }
            }
            if (value.providerMetadata) ctx.currentText.metadata = value.providerMetadata
            // Read again at the close, for a runtime that delivers a block's
            // whole text with no delta: the flag tracks what LANDED, not which
            // event carried it.
            if (ctx.currentText.text.length > 0) ctx.proseCommitted = true
            yield* session.updatePart(ctx.currentText)
            ctx.currentText = undefined
            return

          case "finish":
            return
        }
      })

      const cleanup = Effect.fn("SessionProcessor.cleanup")(function* () {
        if (ctx.snapshot) {
          // A step ended without step-finish, so the worktree may be past the
          // last finish tree: the next step must take its own snapshot.
          ctx.finished = undefined
          const patch = yield* snapshot.patch(ctx.snapshot)
          if (patch.files.length) {
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.sessionID,
              type: "patch",
              hash: patch.hash,
              files: patch.files,
            })
          }
          ctx.snapshot = undefined
        }

        if (ctx.currentText) {
          const end = Date.now()
          ctx.currentText.time = { start: ctx.currentText.time?.start ?? end, end }
          yield* session.updatePart(ctx.currentText)
          ctx.currentText = undefined
        }

        for (const part of Object.values(ctx.reasoningMap)) {
          const end = Date.now()
          yield* session.updatePart({
            ...part,
            time: { start: part.time.start ?? end, end },
          })
        }
        ctx.reasoningMap = {}

        yield* Effect.forEach(
          Object.values(ctx.toolcalls),
          (call) => Deferred.await(call.done).pipe(Effect.timeout("250 millis"), Effect.ignore),
          { concurrency: "unbounded" },
        )

        for (const toolCallID of Object.keys(ctx.toolcalls)) {
          const match = yield* readToolCall(toolCallID)
          if (!match) continue
          const part = match.part
          const end = Date.now()
          const metadata = "metadata" in part.state && isRecord(part.state.metadata) ? part.state.metadata : {}
          yield* session.updatePart({
            ...part,
            state: {
              ...part.state,
              status: "error",
              error: "Tool execution aborted",
              metadata: { ...metadata, interrupted: true },
              time: { start: "time" in part.state ? part.state.time.start : end, end },
            },
          })
        }
        ctx.toolcalls = {}
        ctx.assistantMessage.time.completed = Date.now()
        yield* session.updateMessage(ctx.assistantMessage)
      })

      /**
       * The engine's own one line in the chat, streamed the way model prose is:
       * create the part, publish the delta, then persist the text. All three are
       * required. `updatePart` persists the line and registers the part with the
       * ACP bridge; `updatePartDelta` is what puts it in front of the user,
       * because a delta on an assistant text part is the ONLY engine-written
       * content the bridge forwards live — a whole-part text update with no peer
       * or task-result metadata is dropped by `handlePartUpdated` and appears
       * only on a later history replay.
       */
      const notice = Effect.fn("SessionProcessor.notice")(function* (input: {
        text: string
        metadata: Record<string, unknown>
      }) {
        const start = Date.now()
        const part: SessionV1.TextPart = {
          id: PartID.ascending(),
          messageID: ctx.assistantMessage.id,
          sessionID: ctx.assistantMessage.sessionID,
          type: "text",
          text: "",
          time: { start },
          // Keeps WHY the engine spoke in the stored transcript, not only in
          // the process-local session store the retry path reads.
          metadata: input.metadata,
        }
        yield* session.updatePart(part)
        // A STRUCTURED notice (stream drop) has no prose at all: its content is
        // the metadata rider, which `updatePart` alone carries to the bridge. A
        // delta of "" would only publish an empty chunk for a client to append.
        if (input.text)
          yield* session.updatePartDelta({
            sessionID: part.sessionID,
            messageID: part.messageID,
            partID: part.id,
            field: "text",
            delta: input.text,
          })
        yield* session.updatePart({ ...part, text: input.text, time: { start, end: Date.now() } })
      })

      const halt = Effect.fn("SessionProcessor.halt")(function* (e: unknown) {
        yield* Effect.logError("process", {
          "session.id": input.sessionID,
          messageID: input.assistantMessage.id,
          error: errorMessage(e),
          stack: e instanceof Error ? e.stack : undefined,
        })
        const error = parse(e)
        if (SessionV1.ContextOverflowError.isInstance(error)) {
          if ((yield* config.get()).compaction?.auto === false && !ctx.assistantMessage.summary) {
            ctx.assistantMessage.error = error
            ctx.assistantMessage.finish = "error"
            yield* events.publish(Session.Event.Error, { sessionID: ctx.sessionID, error })
            yield* status.set(ctx.sessionID, { type: "idle" })
            return
          }
          ctx.needsCompaction = true
          ctx.overflowed = e instanceof SessionV1.ContextOverflowError ? "window" : "provider"
          yield* events.publish(Session.Event.Error, { sessionID: ctx.sessionID, error })
          return
        }
        ctx.assistantMessage.error = error
        yield* events.publish(Session.Event.Error, {
          sessionID: ctx.assistantMessage.sessionID,
          error: ctx.assistantMessage.error,
        })
        yield* status.set(ctx.sessionID, { type: "idle" })
      })

      const process = Effect.fn("SessionProcessor.process")(function* (streamInput: LLM.StreamInput) {
        yield* Effect.logInfo("process", {
          "session.id": input.sessionID,
          messageID: input.assistantMessage.id,
        })
        ctx.needsCompaction = false
        ctx.overflowed = undefined
        ctx.shouldBreak = (yield* config.get()).experimental?.continue_loop_on_deny !== true

        return yield* Effect.gen(function* () {
          yield* Effect.gen(function* () {
            ctx.currentText = undefined
            ctx.reasoningMap = {}
            ctx.terminal = false
            ctx.sawUnknownFinish = false
            ctx.proseCommitted = false
            yield* status.set(ctx.sessionID, { type: "busy" })
            // The clock for the FIRST step's TTFT, taken here rather than at its
            // `step-start` so the send and prefill are inside the measurement.
            // Re-taken on a retry, which re-enters this block with a new request.
            ctx.stepStartedAt = Date.now()
            ctx.ttftMs = undefined
            const stream = llm.stream(streamInput)

            yield* stream.pipe(
              Stream.tap((event) => handleEvent(event)),
              Stream.takeUntil(() => ctx.needsCompaction),
              Stream.runDrain,
            )

            // Nobody named how this step ended. What that costs depends on
            // whether the attempt produced anything, so the two cases split here
            // rather than sharing one verdict. A committed tool call is excluded
            // from both because the defect needs an IDENTICAL redo to exist:
            // once a tool has run, the next request carries its result.
            if (!ctx.terminal && !ctx.toolCommitted && !ctx.blocked) {
              // Told nothing, and produced nothing to keep. Failed into the
              // stream-drop family so the same bounded budget, notice and
              // `canRedoStep` gate apply, rather than answering "continue" and
              // letting the loop re-issue the identical request to the cap.
              if (!ctx.sawUnknownFinish || !ctx.proseCommitted) {
                return yield* Effect.fail(SessionStreamDrop.endedEarly())
              }
              // The other case: the body finished, said real words, and spelled
              // its stop reason in a way nothing maps. Nothing was dropped, so a
              // redo would only re-bill it. `finish` stays "unknown" and the LOOP
              // decides whether to carry on; `session/prompt.ts` bounds that.
            }

            // origami_change-start (t-3kr4o4: empty terminal reply)
            // Told, told the reply was COMPLETE, and produced nothing at all.
            // The guard above cannot reach this one: it tests `!ctx.terminal`,
            // and a finish of "stop" IS terminal. Left alone, the loop's exit
            // gate reads a terminal reason with no tool parts and ends the turn
            // on an empty message; an empty reply is not a finished reply, so it
            // takes the same bounded discard-and-redo the silent case takes.
            //
            // Narrow on purpose. Only "stop": "length", "content-filter" and
            // "error" each already have a truthful surface, and a redo would
            // re-hit the same limit. Only with nothing committed: a tool call
            // means the loop is progressing, prose means a redo would re-bill a
            // real generation. Not on a summary: the retry notice would land
            // inside compaction text and be quoted back as history.
            if (
              ctx.terminal &&
              ctx.assistantMessage.finish === "stop" &&
              !ctx.proseCommitted &&
              !ctx.toolCommitted &&
              !ctx.blocked &&
              !ctx.assistantMessage.summary
            ) {
              return yield* Effect.fail(SessionStreamDrop.emptyReply())
            }
            // origami_change-end

            // Told, and told the reply was cut short. The turn still ENDS here
            // — the loop's exit gate reads `length` as finished and no synthetic
            // continuation is written — but the user is told why. Never on a
            // summary: a notice folded into compaction text would be quoted back
            // as history on the next compaction.
            if (ctx.assistantMessage.finish === "length" && !ctx.assistantMessage.summary) {
              yield* notice({ text: TRUNCATED_NOTICE, metadata: { origami_truncated: "length" } })
            }
          }).pipe(
            Effect.onInterrupt(() =>
              Effect.gen(function* () {
                aborted = true
                if (!ctx.assistantMessage.error) {
                  yield* halt(new DOMException("Aborted", "AbortError"))
                }
              }),
            ),
            Effect.catchCauseIf(
              (cause) => !Cause.hasInterruptsOnly(cause),
              (cause) => Effect.fail(Cause.squash(cause)),
            ),
            Effect.retry(
              SessionRetry.policy({
                provider: input.model.providerID,
                sessionID: ctx.sessionID,
                // What the tier-demotion branch needs and nothing more: which
                // model the turn is on and the ladder it offers, so a refused
                // tier can be stepped down instead of the whole knob dropped.
                model: {
                  providerID: input.model.providerID,
                  modelID: input.model.id,
                  tiers: Object.keys(input.model.variants ?? {}),
                },
                // A demotion changes the ladder the picker reads, and that
                // ladder is cached per directory — without this the struck-off
                // tier stays selectable until the next launch.
                invalidateProviders: () => providers.invalidate(),
                parse,
                notice,
                canRedoStep: () => !ctx.toolCommitted,
                set: (info) => {
                  return status.set(ctx.sessionID, {
                    type: "retry",
                    attempt: info.attempt,
                    message: info.message,
                    action: info.action,
                    next: info.next,
                  })
                },
              }),
            ),
            Effect.catch(halt),
            Effect.ensuring(cleanup()),
          )

          if (ctx.needsCompaction) return "compact"
          if (ctx.blocked || ctx.assistantMessage.error) return "stop"
          return "continue"
        })
      })

      return {
        get message() {
          return ctx.assistantMessage
        },
        get overflowed() {
          return ctx.overflowed
        },
        updateToolCall,
        completeToolCall,
        process,
        finishSnapshot: () => (ctx.snapshot === undefined ? ctx.finished : undefined),
      } satisfies Handle
    })

    return Service.of({ create })
  }),
)

// origami_change-start (t-rylleg: cache-loss cause)
/**
 * The `cache` block of one step-finish part, or undefined when the step's cache
 * was not measured at all.
 *
 * Two different silences, both of which must stay silent: a provider that
 * reports no cache tokens (`reportsCache`) is cache-BLIND, and a request that
 * staged no prompt capture (compaction, title generation) has no facts to
 * compare. Writing a cause for either would turn "nobody measured this" into
 * "the provider missed", which is the defect this whole block exists to end.
 *
 * On a HIT the facts are written and no cause is: a cause is the answer to
 * "why was this read cold", and there is no such question.
 */
function cacheBlock(input: {
  readonly facts: SessionPromptCapture.RequestFacts | undefined
  readonly usage: Usage | undefined
  readonly tokens: SessionV1.StepFinishPart["tokens"]
  readonly model: Provider.Model
}): SessionV1.StepFinishPart["cache"] {
  if (!input.facts) return undefined
  if (!input.usage || !SessionCachePolicy.reportsCache(input.usage)) return undefined
  const facts = input.facts
  const miss = input.tokens.cache.read === 0
  return {
    ...(miss
      ? {
          cause: SessionCachePolicy.cause({
            ...facts,
            // What the provider was asked to read: the whole prompt, cache
            // included, which is the size its minimum is measured against.
            prefillTokens: input.tokens.input + input.tokens.cache.read + input.tokens.cache.write,
            minimumTokens: SessionCachePolicy.minimumTokens({
              providerID: input.model.providerID,
              modelID: input.model.id,
            }),
          }),
        }
      : {}),
    ...(facts.preserved === undefined ? {} : { preserved: facts.preserved }),
    ...(facts.divergence ? { divergence: facts.divergence } : {}),
    ...(facts.idleMs === undefined ? {} : { idleMs: facts.idleMs }),
    ...(facts.ttlSeconds === undefined ? {} : { ttlSeconds: facts.ttlSeconds }),
    ...(facts.warmed === undefined ? {} : { warmed: facts.warmed }),
  }
}
// origami_change-end

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [
    Session.node,
    Config.node,
    Snapshot.node,
    Agent.node,
    LLM.node,
    Permission.node,
    Plugin.node,
    SessionStatus.node,
    Image.node,
    EventV2Bridge.node,
    Database.node,
    Provider.node,
  ],
})

export * as SessionProcessor from "./processor"
