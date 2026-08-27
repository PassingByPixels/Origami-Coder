import { LayerNode } from "@origami/core/effect/layer-node"
import { PermissionV1 } from "@origami/core/v1/permission"
import { Image } from "@/image/image"
import { SessionV1 } from "@origami/core/v1/session"
import { Cause, Deferred, Effect, Exit, Layer, Context, Scope, Schema } from "effect"
import * as Stream from "effect/Stream"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Snapshot } from "@/snapshot"
import { Session } from "./session"
import { LLM } from "./llm"
import { MessageV2 } from "./message-v2"
import { isOverflow } from "./overflow"
import { PartID } from "./schema"
import type { SessionID } from "./schema"
import { SessionRetry } from "./retry"
import { SessionStreamDrop } from "./stream-drop"
import { SessionStatus } from "./status"
import { SessionSummary } from "./summary"
import type { Provider } from "@/provider/provider"
import { Question } from "@/question"
import { NamedError } from "@origami/core/util/error"
import { errorMessage } from "@/util/error"
import { isRecord } from "@/util/record"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@origami/core/database/database"
import { Usage, type LLMEvent } from "@origami/llm"

const DOOM_LOOP_THRESHOLD = 3
export type Result = "compact" | "stop" | "continue"

/**
 * The line the user reads when the provider stopped because the reply ran out
 * of output budget, not because it was done.
 *
 * It states the fact and leaves the next move to the person. The engine does
 * NOT write a "continue" turn on their behalf: a synthetic continuation is the
 * one repair this codebase refuses to make, because it puts words in the
 * user's mouth and bills a second full request for them.
 */
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
}

type Input = {
  assistantMessage: SessionV1.Assistant
  sessionID: SessionID
  model: Provider.Model
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
  blocked: boolean
  needsCompaction: boolean
  currentText: SessionV1.TextPart | undefined
  reasoningMap: Record<string, SessionV1.ReasoningPart>
  /**
   * Set once this step has committed to a tool call. Redoing a step re-sends
   * the identical request, so a tool that has already run could run twice —
   * harmless for a read, not harmless for a write or a shell command. Set at
   * `tool-call` rather than `tool-result` because a stream that dies between
   * the two leaves the tool mid-flight, and "we do not know" has to count as
   * "it ran".
   */
  toolCommitted: boolean
  /**
   * Set once the provider has NAMED how this step ended.
   *
   * `step-finish` is the only event that carries a finish reason, and a reason
   * of `"unknown"` is not one: both runtimes use that literal for "the body
   * stopped and never said". Tracked per attempt rather than read off
   * `assistantMessage.finish`, because the native runtime emits no
   * `step-finish` at all in that case and would leave the field simply unset —
   * the same silence wearing a different mask.
   */
  terminal: boolean
  /**
   * Set when a `step-finish` DID arrive and named the reason `"unknown"`.
   *
   * The strict complement of `terminal` for that one event, and not the same
   * fact: total silence sets neither, an unreadable reason sets this one. That
   * difference is what separates "the body died" from "the body finished and
   * the gateway spelled its stop reason in a way nothing maps" — which the AI
   * SDK path cannot distinguish any other way, because it synthesises the same
   * `step-finish(unknown)` for a novel reason and for a graceful finish-less
   * EOF alike.
   */
  sawUnknownFinish: boolean
  /**
   * Set once this attempt has committed NON-EMPTY model prose to the assistant
   * message.
   *
   * The second half of the unknown-finish decision. Prose means the attempt did
   * real, billed work worth carrying forward, so a redo would pay for the same
   * generation twice; no prose means there is nothing to carry, and the
   * stream-drop family's discard-and-redo is the sound repair. Counted from the
   * text events only, so an engine notice can never masquerade as model output.
   */
  proseCommitted: boolean
}

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
    const summary = yield* SessionSummary.Service
    const scope = yield* Scope.Scope
    const status = yield* SessionStatus.Service
    const image = yield* Image.Service
    const events = yield* EventV2Bridge.Service
    const database = yield* Database.Service

    const create = Effect.fn("SessionProcessor.create")(function* (input: Input) {
      // Pre-capture snapshot before the LLM stream starts. The AI SDK
      // may execute tools internally before emitting start-step events,
      // so capturing inside the event handler can be too late.
      const initialSnapshot = yield* snapshot.track()
      const ctx: ProcessorContext = {
        assistantMessage: input.assistantMessage,
        sessionID: input.sessionID,
        model: input.model,
        toolcalls: {},
        shouldBreak: false,
        snapshot: initialSnapshot,
        blocked: false,
        needsCompaction: false,
        currentText: undefined,
        reasoningMap: {},
        toolCommitted: false,
        terminal: false,
        sawUnknownFinish: false,
        proseCommitted: false,
      }
      let aborted = false

      const parse = (e: unknown) =>
        MessageV2.fromError(e, {
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
        const part = yield* session.updatePart(update(match.part))
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
        // DeniedError sits here beside the two refusals, and it is the one that
        // was missing. A rule-denied call is not a transient failure: nobody
        // was asked, nobody will be, and retrying is refused identically. Left
        // out of this branch it was an ordinary tool error, so the loop carried
        // on and a sub-agent spent its whole step budget re-calling a tool a
        // config line had closed — then finished with no text and handed its
        // parent an empty <task_result>.
        if (
          error instanceof PermissionV1.RejectedError ||
          error instanceof PermissionV1.DeniedError ||
          error instanceof Question.RejectedError
        ) {
          ctx.blocked = ctx.shouldBreak
          // A refused SUB-agent has to say so upwards. Its turn ends here with no
          // text, so tool/task.ts - which only inspects `info.error` - saw a clean
          // finish and handed the parent an EMPTY <task_result>: a refusal the
          // parent could neither see nor act on. Recording it on the assistant
          // message is what task.ts reads to render <task_error> with the reason,
          // so the parent can come back and ask the user what to do instead.
          //
          // Main sessions are deliberately untouched: the user did the refusing
          // and is looking at the denied tool card, so an error banner on top of
          // it would be noise. Gated on ctx.blocked as well as parentID, so
          // `experimental.continue_loop_on_deny` still means "carry on".
          if (ctx.blocked) {
            const info = yield* session.get(ctx.sessionID).pipe(Effect.orDie)
            if (info.parentID) {
              // WHO refused matters to the parent. A human saying no is a
              // decision to take back to them; a config rule saying no is a
              // setting to change. Both end the turn, and the parent has to be
              // able to tell them apart to say anything useful about it.
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
                    Effect.exit,
                  )
                : Effect.succeed(Exit.succeed<SessionV1.FilePart>(attachment)),
            )
            const omitted = normalized.filter(Exit.isFailure).length
            const attachments = normalized.filter(Exit.isSuccess).map((item) => item.value)
            const output = {
              ...rawOutput,
              output:
                omitted === 0
                  ? rawOutput.output
                  : `${rawOutput.output}\n\n[${omitted} image${omitted === 1 ? "" : "s"} omitted: could not be resized below the image size limit.]`,
              attachments: attachments.length ? attachments : undefined,
            }
            yield* completeToolCall(value.id, output)
            return
          }

          case "tool-error": {
            yield* failToolCall(value.id, value.error ?? new Error(value.message))
            return
          }

          case "provider-error":
            throw new Error(value.message)

          case "step-start":
            if (!ctx.snapshot) ctx.snapshot = yield* snapshot.track()
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
            yield* session.updatePart({
              id: PartID.ascending(),
              reason: value.reason,
              snapshot: completedSnapshot,
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "step-finish",
              tokens: usage.tokens,
              cost: usage.cost,
            })
            yield* session.updateMessage(ctx.assistantMessage)
            if (ctx.snapshot) {
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
            yield* summary
              .summarize({
                sessionID: ctx.sessionID,
                messageID: ctx.assistantMessage.parentID,
              })
              .pipe(Effect.ignore, Effect.forkIn(scope))
            if (!ctx.assistantMessage.summary) {
              // Per-chat threshold override (t-kgsdsw), same row read
              // compaction.ts's Service-level isOverflow does — best-effort,
              // never blocks the mid-stream overflow check on a missing row.
              const row = yield* session.get(ctx.sessionID).pipe(Effect.catch(() => Effect.succeed(undefined)))
              if (
                isOverflow({
                  cfg: yield* config.get(),
                  tokens: usage.tokens,
                  model: ctx.model,
                  thresholdOverride: row ? Session.compactionThreshold(row) : undefined,
                })
              ) {
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
              // The DROP stays — emitting into a block that was already closed
              // is fatal downstream, which is why the think-tag drain in
              // llm/ai-sdk.ts holds its characters rather than fabricating a
              // block id. But it must not be SILENT: this is the one mechanism
              // that could lose model output with no trace anywhere, so say
              // exactly what went and how much of it.
              yield* Effect.logWarning("dropped text-delta with no open text part", {
                sessionID: ctx.sessionID,
                messageID: ctx.assistantMessage.id,
                chars: value.text.length,
                text: value.text.slice(0, 200),
              })
              return
            }
            ctx.currentText.text += value.text
            // An EMPTY delta is a structural marker, not an answer, so it must
            // not buy the step a continuation.
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
            // whole text without ever sending a delta - the flag has to track
            // what LANDED on the message, not which event carried it.
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
       * create the part, publish the delta, then persist the text.
       *
       * The three steps are not ceremony. `updatePart` is what persists the line
       * and registers the part with the ACP bridge; `updatePartDelta` is what
       * puts it in front of the user, because a delta on an assistant text part
       * is the ONLY engine-written content the bridge forwards live
       * (`handlePartDelta`, acp/event.ts) — a whole-part text update with no peer
       * or task-result metadata is dropped by `handlePartUpdated` and would
       * appear only on a later history replay.
       */
      const notice = Effect.fn("SessionProcessor.notice")(function* (input: {
        text: string
        metadata: Record<string, string>
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
        ctx.shouldBreak = (yield* config.get()).experimental?.continue_loop_on_deny !== true

        return yield* Effect.gen(function* () {
          yield* Effect.gen(function* () {
            ctx.currentText = undefined
            ctx.reasoningMap = {}
            ctx.terminal = false
            ctx.sawUnknownFinish = false
            ctx.proseCommitted = false
            yield* status.set(ctx.sessionID, { type: "busy" })
            const stream = llm.stream(streamInput)

            yield* stream.pipe(
              Stream.tap((event) => handleEvent(event)),
              Stream.takeUntil(() => ctx.needsCompaction),
              Stream.runDrain,
            )

            // Nobody named how this step ended. What that costs depends on
            // whether the attempt produced anything, so the two cases split
            // here rather than sharing one verdict.
            //
            // A committed tool call is excluded from both because the defect
            // needs an IDENTICAL redo to exist: once a tool has run, the next
            // request carries its result and the loop is making real progress.
            if (!ctx.terminal && !ctx.toolCommitted && !ctx.blocked) {
              // Told nothing, and produced nothing to keep. Answering "continue"
              // here is what let the loop re-issue the identical request every
              // step to the agent's cap, billing each one, with nothing in the
              // transcript to explain the repetition. It is failed instead, into
              // the stream-drop family, so the same bounded budget, the same
              // notice and the same `canRedoStep` gate apply — and a turn that
              // stays silent through all of them ends as a named, visible error.
              if (!ctx.sawUnknownFinish || !ctx.proseCommitted) {
                return yield* Effect.fail(SessionStreamDrop.endedEarly())
              }
              // The other case: the body finished, said real words, and spelled
              // its stop reason in a way nothing maps. Nothing dropped, so there
              // is nothing to repair — a redo would re-bill the whole generation
              // and land on the same unreadable reason, because a gateway that
              // mangles it once mangles it every time. `finish` is left as
              // "unknown" and the LOOP decides whether to ask the model to carry
              // on; `session/prompt.ts` bounds how often it will.
            }

            // Told, and told the reply was cut short. The turn still ENDS here —
            // the loop's exit gate reads `length` as finished, and no synthetic
            // continuation is written — but the user is not left to guess why a
            // reply stops mid-sentence. Never on a summary: its parts are the
            // compaction text, and a notice folded in there would be quoted back
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
        updateToolCall,
        completeToolCall,
        process,
      } satisfies Handle
    })

    return Service.of({ create })
  }),
)

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
    SessionSummary.node,
    SessionStatus.node,
    Image.node,
    EventV2Bridge.node,
    Database.node,
  ],
})

export * as SessionProcessor from "./processor"
