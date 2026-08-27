import { LayerNode } from "@origami/core/effect/layer-node"
import { PermissionV1 } from "@origami/core/v1/permission"
import path from "path"
import { SessionV1 } from "@origami/core/v1/session"
import os from "os"
import { SessionID, MessageID, PartID } from "./schema"
import { MessageV2 } from "./message-v2"
import { SessionRevert } from "./revert"
import { Session } from "./session"
import { Todo } from "./todo"
import { substituteTodos, TODOS_PLACEHOLDER } from "./command-todos"
import { Agent } from "../agent/agent"
import { AgentBot } from "../agent/bot"
import { AgentBotMemory } from "../agent/bot-memory"
import { CollabSystem } from "@/collab/collab-system"
import { FlockTools } from "@/collab/flock-tools"
import { SessionVision } from "./vision"
import { VisionRequest } from "@/tool/vision-request"
import { FlockHealth } from "@/flock/health"
import { FlockRouting } from "@/flock/routing"
import { Provider } from "@/provider/provider"

import { type Tool as AITool, type ModelMessage, tool, jsonSchema } from "ai"
import type { JSONSchema7 } from "@ai-sdk/provider"
import { SessionCompaction } from "./compaction"
import { SystemPrompt } from "./system"
import { Instruction } from "./instruction"
import { Plugin } from "../plugin"
import { MAX_STEPS_PROMPT } from "@origami/core/session/runner/max-steps"
import { ToolRegistry } from "@/tool/registry"
import { ToolSearch } from "@/tool/tool-search"
import { MCP } from "../mcp"
import { LSP } from "@/lsp/lsp"
import { ulid } from "ulid"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { CrossSpawnSpawner } from "@origami/core/cross-spawn-spawner"
import * as Stream from "effect/Stream"
import { Command } from "../command"
import { pathToFileURL, fileURLToPath } from "url"
import { Config } from "@/config/config"
import { ConfigMarkdown } from "@/config/markdown"
import { SessionSummary } from "./summary"
import { NamedError } from "@origami/core/util/error"
import { SessionProcessor } from "./processor"
import { Tool } from "@/tool/tool"
import { Permission } from "@/permission"
import { SessionStatus } from "./status"
import { LLM } from "./llm"
import { Shell } from "@origami/core/shell"
import { ShellID } from "@/tool/shell/id"
import { FSUtil } from "@origami/core/fs-util"
import { Truncate } from "@/tool/truncate"
import { Interject } from "@/origami/interject" // origami_change
import { Image } from "@/image/image"
import { decodeDataUrl } from "@/util/data-url"
import { Process } from "@/util/process"
import { Cause, Effect, Exit, Latch, Layer, Option, Scope, Context, Schema, Types } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { TaskTool, type TaskPromptOps } from "@/tool/task"
import { SessionGoal } from "./goal"
import { SessionRunState } from "./run-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@origami/core/database/database"
import { ModelV2 } from "@origami/core/model"
import { ProviderV2 } from "@origami/core/provider"
import { eq } from "drizzle-orm"
import { SessionTable } from "@origami/core/session/sql"
import { SessionReminders } from "./reminders"
import { SessionPromptCapture } from "./prompt-capture"
import { SessionTools } from "./tools"
import { LLMEvent } from "@origami/llm"

// @ts-ignore
globalThis.AI_SDK_LOG_WARNINGS = false

/**
 * Applies a per-turn CONTEXT-WINDOW override (t-lmqe0g — a sub-agent model
 * override's stored context length, carried onto this turn's user message by
 * task.ts) on top of a resolved model, the same way the main path applies a
 * model's own configured `limit.context`: it feeds compaction/overflow's
 * budget math and the (inert - no provider driver reads it) outbound
 * `limits.context`. Non-mutating — `model` is the SHARED provider-registry
 * object other sessions read too — and undefined/non-positive returns the
 * SAME object, which is what proves the main path (no caller ever sets
 * `contextOverride`) is byte-for-byte unaffected.
 */
export function applyContextOverride(model: Provider.Model, contextOverride: number | undefined): Provider.Model {
  if (!contextOverride || contextOverride <= 0) return model
  return { ...model, limit: { ...model.limit, context: contextOverride } }
}

const decodeMessageInfo = Schema.decodeUnknownExit(SessionV1.Info)
const decodeMessagePart = Schema.decodeUnknownExit(SessionV1.Part)
const MAX_MCP_RESOURCE_BLOB_BYTES = 10 * 1024 * 1024
const SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES = new Set([
  "application/pdf",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
])

const STRUCTURED_OUTPUT_DESCRIPTION = `Use this tool to return your final response in the requested structured format.

IMPORTANT:
- You MUST call this tool exactly once at the end of your response
- The input must be valid JSON matching the required schema
- Complete all necessary research and tool calls BEFORE calling this tool
- This tool provides your final answer - no further actions are taken after calling it`

const STRUCTURED_OUTPUT_SYSTEM_PROMPT = `IMPORTANT: The user has requested structured output. You MUST use the StructuredOutput tool to provide your final response. Do NOT respond with plain text - you MUST call the StructuredOutput tool with your answer formatted according to the schema.`

// Absolute per-turn ceiling on agentic steps when the agent sets no explicit
// `steps` budget. Last-resort backstop for a degenerate loop that never
// terminates - e.g. a model that keeps emitting DIFFERENT tool calls (so the
// per-message doom-loop detector never fires), or an "unknown" finish.
// Deliberately generous (well above the ~150 steps a genuinely large single
// turn reaches) so it never truncates honest work: an attended user has the
// Stop button - this exists so an UNATTENDED runaway (background sub-agent,
// overnight run) stops on its own instead of looping+compacting forever.
// Per-agent `steps` overrides it, and this now enforces that budget as a hard
// cap - the old nudge-only code never did.
const DEFAULT_MAX_STEPS = 500

// origami_change-start (bounded unknown-continue)
/**
 * Consecutive unreadable stop reasons the loop will carry on through before it
 * calls the turn complete.
 *
 * A finish of "unknown" means the provider ended a reply and nothing could map
 * how — so the exit gate cannot tell "it is done" from "it was cut off", and
 * the processor has already established the reply carried real prose (see
 * `session/processor.ts`, the drain-end route). Continuing lets the model
 * finish, or say it was already finished, which is the cheap and honest move
 * ONCE. It is not the cheap move forever: a gateway that mangles the reason
 * mangles it on every reply, and upstream opencode 1.18.21's unbounded version
 * of this rule spends the whole agent step budget discovering that. Two
 * continues is enough to distinguish a one-off from a broken route.
 */
const UNKNOWN_CONTINUE_LIMIT = 2

/** Metadata key that marks the line below as the engine's, not the model's. */
const UNKNOWN_FINISH_KEY = "origami_unknown_finish"

/**
 * The line the user reads when the bound is reached. It states the fact and
 * leaves the next move to the person - the engine does NOT write a continuation
 * turn on their behalf.
 */
const UNKNOWN_FINISH_NOTICE =
  "The provider kept ending replies without a recognised stop reason, so this reply is treated as complete. Ask it to carry on if you need more."
// origami_change-end

function mcpResourceBase64Size(value: string) {
  const trimmed = value.replace(/\s/g, "")
  const padding = trimmed.endsWith("==") ? 2 : trimmed.endsWith("=") ? 1 : 0
  return Math.max(0, Math.floor((trimmed.length * 3) / 4) - padding)
}

function formatMcpResourceBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`
  return `${Math.ceil(value / (1024 * 1024))} MB`
}

function isOrphanedInterruptedTool(part: SessionV1.ToolPart) {
  // cleanup() marks abandoned tool_use blocks this way after retries/aborts.
  // They are not pending work and must not trigger an assistant-prefill request.
  return part.state.status === "error" && part.state.metadata?.interrupted === true
}

// origami_change-start (interject): a message pushed INTO a running turn.
export type InterjectInput = { readonly sessionID: SessionID; readonly text: string }
/** `busy` = a turn was running and will pick this up; `promoted` = how many
 *  blocking foreground shells were handed to the background to get there. */
export type InterjectResult = { readonly messageID: MessageID; readonly busy: boolean; readonly promoted: number }
// origami_change-end

export interface Interface {
  readonly cancel: (sessionID: SessionID, spareDetached?: boolean) => Effect.Effect<void>
  readonly prompt: (input: PromptInput) => Effect.Effect<SessionV1.WithParts, Image.Error>
  readonly loop: (input: LoopInput) => Effect.Effect<SessionV1.WithParts>
  readonly interject: (input: InterjectInput) => Effect.Effect<InterjectResult> // origami_change
  readonly shell: (input: ShellInput) => Effect.Effect<SessionV1.WithParts, Session.BusyError>
  readonly command: (input: CommandInput) => Effect.Effect<SessionV1.WithParts, Image.Error>
  readonly resolvePromptParts: (template: string) => Effect.Effect<PromptInput["parts"]>
}

export class Service extends Context.Service<Service, Interface>()("@origami/SessionPrompt") {}

/**
 * Stands between the conversation and the trailing block on the one step where
 * they would otherwise put two `user` turns side by side.
 *
 * A separate assistant message rather than a fold - see
 * `withTrailingInjections`. Its text is the framing the fold never gave the
 * model: what follows is not something the user typed. Deliberately says
 * "context" and names nothing more specific, because the block below it holds
 * whatever this step has - the memory index, a reminder, both or one. The
 * engine already appends a synthetic assistant message of its own on the last
 * step (`MAX_STEPS_PROMPT`), so this is an established shape here, not a new one.
 */
export const TRAILING_INJECTION_SEPARATOR =
  "<engine-note>The next message is not from the user. It is context the engine appends to this agent's requests.</engine-note>"

/**
 * THE TRAILING LANE. Everything the engine adds to a request beyond the system
 * prompt and the conversation itself goes here, in ONE message after the last
 * one the model has already seen, and nowhere else.
 *
 * WHAT GOES IN IT. Two kinds, and they are here for the same reason:
 *   - the MEMORY index, which the `remember` tool rewrites mid-conversation;
 *   - the in-memory REMINDERS (`session/reminders.ts`), recomputed every step
 *     from live state - the stored todo list, a wait or poll streak.
 * Both are prompt content that can differ between two steps of one turn. The
 * plan-mode briefs are NOT here: those are persisted into the transcript on
 * entry, so they are conversation and they hold still.
 *
 * WHY THE TAIL. A prefix cache is an exact match from byte 0, so any byte the
 * engine rewrites inside content it has already sent throws away everything
 * after it. Delivered last, this block sits past every breakpoint: it can
 * change on every single step and cost only itself.
 *
 * WHY NOT INSIDE THE LAST USER MESSAGE, which is where both of these used to
 * live. A sub-agent has ONE user message for its entire life (tool/task.ts
 * prompts once), so that message IS the head of its conversation. Two measured
 * failures, both on the real prompt loop:
 *   - MEMORY, folded in on step 1 and absent from step 2: on a local model the
 *     head diverged at message index 1, byte 7277 of 8307, as the user message
 *     dropped from 880 bytes to 493. One rewrite, whole body re-billed.
 *   - REMINDERS, pushed onto that same message: `WAIT_LOOP_STREAK` fires at 3
 *     and 6 and is silent at 4 and 5, so a `task_list` poll loop rewrote the
 *     head on 4 of 8 requests; and a stored todo list edited mid-turn rewrote
 *     it again (294 bytes -> 335) with no tool call involved at all.
 * Anthropic's `groupIntoBlocks` merges adjacent user turns, so `user, user`
 * behaves exactly like a fold there - no provider can keep either shape.
 *
 * WHY THE SEPARATOR. The first step of a turn ends on the user's own message,
 * and a second user message after it is not portable: `@ai-sdk/google`'s
 * `convertToGoogleGenerativeAIMessages` pushes one `contents` entry per message,
 * so Gemini would receive `user, user`, which its multi-turn contract does not
 * promise to accept. One synthetic assistant note breaks the adjacency without
 * touching a byte of the conversation.
 *
 * ORDER IS PINNED: memory first, then the reminders in the order
 * `SessionReminders.apply` emits them. Reference material above, the
 * time-sensitive instruction closest to the generation point - and, more to the
 * point, the same order every time, so two steps with the same state produce
 * the same bytes.
 */
export function withTrailingInjections(
  messages: readonly ModelMessage[],
  memoryParts: readonly { readonly text: string }[],
  reminders: readonly string[] = [],
): ModelMessage[] {
  const blocks = [...memoryParts.map((entry) => entry.text), ...reminders]
  if (blocks.length === 0) return [...messages]
  const separator: ModelMessage[] =
    messages[messages.length - 1]?.role === "user"
      ? [{ role: "assistant", content: TRAILING_INJECTION_SEPARATOR }]
      : []
  return [...messages, ...separator, { role: "user", content: blocks.join("\n\n") }]
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const status = yield* SessionStatus.Service
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const provider = yield* Provider.Service
    const processor = yield* SessionProcessor.Service
    const compaction = yield* SessionCompaction.Service
    const plugin = yield* Plugin.Service
    const commands = yield* Command.Service
    const config = yield* Config.Service
    const todo = yield* Todo.Service
    const permission = yield* Permission.Service
    const fsys = yield* FSUtil.Service
    const mcp = yield* MCP.Service
    const lsp = yield* LSP.Service
    const registry = yield* ToolRegistry.Service
    const toolSearch = yield* ToolSearch.Service
    const truncate = yield* Truncate.Service
    const image = yield* Image.Service
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const scope = yield* Scope.Scope
    const instruction = yield* Instruction.Service
    const state = yield* SessionRunState.Service
    const revert = yield* SessionRevert.Service
    const summary = yield* SessionSummary.Service
    const sys = yield* SystemPrompt.Service
    const llm = yield* LLM.Service
    const flock = yield* FlockRouting.Service
    const events = yield* EventV2Bridge.Service
    const flags = yield* RuntimeFlags.Service
    const database = yield* Database.Service
    const interjections = yield* Interject.Service // origami_change
    const { db } = database
    const ops = Effect.fn("SessionPrompt.ops")(function* () {
      return {
        cancel: (sessionID: SessionID) => cancel(sessionID),
        resolvePromptParts: (template: string) => resolvePromptParts(template),
        prompt: (input: PromptInput) => prompt(input).pipe(Effect.catch(Effect.die)),
        // Whether a prompt to this session would start work of its own.
        // `SessionRunState.ensureRunning` JOINS a run already in flight and
        // DISCARDS the new work, so a caller that needs its OWN answer has to
        // ask first rather than find out by receiving somebody else's.
        busy: (sessionID: SessionID) =>
          state.assertNotBusy(sessionID).pipe(
            Effect.as(false),
            Effect.catch(() => Effect.succeed(true)),
          ),
      } satisfies TaskPromptOps
    })

    const cancel = Effect.fn("SessionPrompt.cancel")(function* (sessionID: SessionID, spareDetached = false) {
      yield* Effect.logInfo("cancel", { "session.id": sessionID })
      yield* state.cancel(sessionID, spareDetached)
    })

    const resolvePromptParts = Effect.fn("SessionPrompt.resolvePromptParts")(function* (template: string) {
      const ctx = yield* InstanceState.context
      const parts: Types.DeepMutable<PromptInput["parts"]> = [{ type: "text", text: template }]
      const files = ConfigMarkdown.files(template)
      const seen = new Set<string>()
      yield* Effect.forEach(
        files,
        Effect.fnUntraced(function* (match) {
          const name = match[1]
          if (!name) return
          if (seen.has(name)) return
          seen.add(name)

          const filepath = name.startsWith("~/")
            ? path.join(os.homedir(), name.slice(2))
            : path.resolve(ctx.worktree, name)

          const info = yield* fsys.stat(filepath).pipe(Effect.option)
          if (Option.isNone(info)) {
            const found = yield* agents.get(name)
            if (found) parts.push({ type: "agent", name: found.name })
            return
          }
          const stat = info.value
          parts.push({
            type: "file",
            url: pathToFileURL(filepath).href,
            filename: name,
            mime: stat.type === "Directory" ? "application/x-directory" : "text/plain",
          })
        }),
        { concurrency: "unbounded", discard: true },
      )
      return parts
    })

    const title = Effect.fn("SessionPrompt.ensureTitle")(function* (input: {
      session: Session.Info
      history: SessionV1.WithParts[]
      providerID: ProviderV2.ID
      modelID: ModelV2.ID
    }) {
      if (input.session.parentID) return
      if (!Session.isDefaultTitle(input.session.title)) return

      const real = (m: SessionV1.WithParts) =>
        m.info.role === "user" && !m.parts.every((p) => "synthetic" in p && p.synthetic)
      const idx = input.history.findIndex(real)
      if (idx === -1) return
      if (input.history.filter(real).length !== 1) return

      const context = input.history.slice(0, idx + 1)
      const firstUser = context[idx]
      if (!firstUser || firstUser.info.role !== "user") return
      const firstInfo = firstUser.info

      const subtasks = firstUser.parts.filter((p): p is SessionV1.SubtaskPart => p.type === "subtask")
      const onlySubtasks = subtasks.length > 0 && firstUser.parts.every((p) => p.type === "subtask")

      const ag = yield* agents.get("title")
      if (!ag) return
      const generate = Effect.fnUntraced(function* (mdl: Provider.Model) {
        const msgs = onlySubtasks
          ? [{ role: "user" as const, content: subtasks.map((p) => p.prompt).join("\n") }]
          : yield* MessageV2.toModelMessagesEffect(context, mdl)
        return yield* llm
          .stream({
            agent: ag,
            user: firstInfo,
            system: [],
            small: true,
            tools: {},
            model: mdl,
            sessionID: input.session.id,
            retries: 2,
            messages: [{ role: "user", content: "Generate a title for this conversation:\n" }, ...msgs],
          })
          .pipe(
            Stream.filter(LLMEvent.is.textDelta),
            Stream.map((e) => e.text),
            Stream.mkString,
          )
      })
      // The subagent binding routes the hidden native generations too, of which
      // this is one. Unbound, or Flock off, and the chain is empty — the
      // resolution below is then exactly the one that has always run here,
      // `small_model` and all.
      const routed = yield* FlockHealth.oneShot({ flock, provider, generate })
      const text =
        routed ??
        (yield* generate(
          ag.model
            ? yield* provider.getModel(ag.model.providerID, ag.model.modelID)
            : ((yield* provider.getSmallModel(input.providerID)) ??
                (yield* provider.getModel(input.providerID, input.modelID))),
        ).pipe(Effect.orDie))
      const cleaned = text
        .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
        // ...then any tag left UNPAIRED. The pair above matches nothing when a
        // server leaks a closer with no opener, which is how `</think>loop ran`
        // became a session title. The adapter seam now drops those upstream; this
        // stays as the belt, because a title is written straight to disk and every
        // protocol that has ever leaked one reaches this line.
        .replace(/<\/?think>\s*/g, "")
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0)
      if (!cleaned) return
      const t = cleaned.length > 100 ? cleaned.substring(0, 97) + "..." : cleaned
      yield* sessions
        .setTitle({ sessionID: input.session.id, title: t })
        .pipe(Effect.catchCause((cause) => Effect.logError("failed to generate title", { error: Cause.squash(cause) })))
    })

    const handleSubtask = Effect.fn("SessionPrompt.handleSubtask")(function* (input: {
      task: SessionV1.SubtaskPart
      model: Provider.Model
      lastUser: SessionV1.User
      sessionID: SessionID
      session: Session.Info
      msgs: SessionV1.WithParts[]
    }) {
      const { task, model, lastUser, sessionID, session, msgs } = input
      const ctx = yield* InstanceState.context
      const promptOps = yield* ops()
      const { task: taskTool } = yield* registry.named()
      const taskModel = task.model ? yield* getModel(task.model.providerID, task.model.modelID, sessionID) : model
      const assistantMessage: SessionV1.Assistant = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "assistant",
        parentID: lastUser.id,
        sessionID,
        mode: task.agent,
        agent: task.agent,
        variant: lastUser.model.variant,
        path: { cwd: ctx.directory, root: ctx.worktree },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: taskModel.id,
        providerID: taskModel.providerID,
        time: { created: Date.now() },
      })
      let part: SessionV1.ToolPart = yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: assistantMessage.id,
        sessionID: assistantMessage.sessionID,
        type: "tool",
        callID: ulid(),
        tool: TaskTool.id,
        state: {
          status: "running",
          input: {
            prompt: task.prompt,
            description: task.description,
            subagent_type: task.agent,
            command: task.command,
          },
          time: { start: Date.now() },
        },
      })
      const taskArgs = {
        prompt: task.prompt,
        description: task.description,
        subagent_type: task.agent,
        command: task.command,
      }
      yield* plugin.trigger(
        "tool.execute.before",
        { tool: TaskTool.id, sessionID, callID: part.id },
        { args: taskArgs },
      )

      const taskAgent = yield* agents.get(task.agent)
      if (!taskAgent) {
        const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${task.agent}".${hint}` })
        yield* events.publish(Session.Event.Error, { sessionID, error: error.toObject() })
        throw error
      }

      let error: Error | undefined
      const taskAbort = new AbortController()
      const result = yield* taskTool
        .execute(taskArgs, {
          agent: task.agent,
          messageID: assistantMessage.id,
          sessionID,
          abort: taskAbort.signal,
          callID: part.callID,
          extra: { bypassAgentCheck: true, promptOps },
          messages: msgs,
          metadata: (val: { title?: string; metadata?: Record<string, any> }) =>
            Effect.gen(function* () {
              part = yield* sessions.updatePart({
                ...part,
                type: "tool",
                state: { ...part.state, ...val },
              } satisfies SessionV1.ToolPart)
            }),
          // Same live read as session/tools.ts: an Approve/YOLO change made while
          // this subtask is running has to reach the NEXT ask, not the next turn.
          ask: (req: any) =>
            Effect.gen(function* () {
              const live = yield* sessions.get(sessionID).pipe(Effect.orDie)
              return yield* permission.ask({
                ...req,
                sessionID,
                ruleset: Permission.merge(taskAgent.permission, live.permission ?? []),
              })
            }).pipe(Effect.orDie),
        })
        .pipe(
          Effect.catchCause((cause) => {
            const defect = Cause.squash(cause)
            error = defect instanceof Error ? defect : new Error(String(defect))
            return Effect.logError("subtask execution failed", {
              error,
              agent: task.agent,
              description: task.description,
            })
          }),
          Effect.onInterrupt(() =>
            Effect.gen(function* () {
              taskAbort.abort()
              assistantMessage.finish = "tool-calls"
              assistantMessage.time.completed = Date.now()
              yield* sessions.updateMessage(assistantMessage)
              if (part.state.status === "running") {
                yield* sessions.updatePart({
                  ...part,
                  state: {
                    status: "error",
                    error: "Cancelled",
                    time: { start: part.state.time.start, end: Date.now() },
                    metadata: part.state.metadata,
                    input: part.state.input,
                  },
                } satisfies SessionV1.ToolPart)
              }
            }),
          ),
        )

      const attachments = result?.attachments?.map((attachment) => ({
        ...attachment,
        id: PartID.ascending(),
        sessionID,
        messageID: assistantMessage.id,
      }))

      yield* plugin.trigger(
        "tool.execute.after",
        { tool: TaskTool.id, sessionID, callID: part.id, args: taskArgs },
        result,
      )

      assistantMessage.finish = "tool-calls"
      assistantMessage.time.completed = Date.now()
      yield* sessions.updateMessage(assistantMessage)

      if (result && part.state.status === "running") {
        yield* sessions.updatePart({
          ...part,
          state: {
            status: "completed",
            input: part.state.input,
            title: result.title,
            metadata: result.metadata,
            output: result.output,
            attachments,
            time: { ...part.state.time, end: Date.now() },
          },
        } satisfies SessionV1.ToolPart)
      }

      if (!result) {
        yield* sessions.updatePart({
          ...part,
          state: {
            status: "error",
            error: error ? `Tool execution failed: ${error.message}` : "Tool execution failed",
            time: {
              start: part.state.status === "running" ? part.state.time.start : Date.now(),
              end: Date.now(),
            },
            metadata: part.state.status === "pending" ? undefined : part.state.metadata,
            input: part.state.input,
          },
        } satisfies SessionV1.ToolPart)
      }

      if (!task.command) return

      const summaryUserMsg: SessionV1.User = {
        id: MessageID.ascending(),
        sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: lastUser.agent,
        model: lastUser.model,
      }
      yield* sessions.updateMessage(summaryUserMsg)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: summaryUserMsg.id,
        sessionID,
        type: "text",
        text: "Summarize the task tool output above and continue with your task.",
        synthetic: true,
      } satisfies SessionV1.TextPart)
    })

    const shellImpl = Effect.fn("SessionPrompt.shellImpl")(function* (input: ShellInput, ready?: Latch.Latch) {
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const markReady = ready ? ready.open.pipe(Effect.asVoid) : Effect.void
          const { msg, part, cwd } = yield* Effect.gen(function* () {
            const ctx = yield* InstanceState.context
            const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
            if (session.revert) {
              yield* revert.cleanup(session)
            }
            const agent = yield* agents.get(input.agent)
            if (!agent) {
              const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
              const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
              const error = new NamedError.Unknown({ message: `Agent not found: "${input.agent}".${hint}` })
              yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
              throw error
            }
            const model = input.model ?? agent.model ?? (yield* currentModel(input.sessionID))
            const userMsg: SessionV1.User = {
              id: input.messageID ?? MessageID.ascending(),
              sessionID: input.sessionID,
              time: { created: Date.now() },
              role: "user",
              agent: input.agent,
              model: { providerID: model.providerID, modelID: model.modelID },
            }
            yield* sessions.updateMessage(userMsg)
            const userPart: SessionV1.Part = {
              type: "text",
              id: PartID.ascending(),
              messageID: userMsg.id,
              sessionID: input.sessionID,
              text: "The following tool was executed by the user",
              synthetic: true,
            }
            yield* sessions.updatePart(userPart)

            const msg: SessionV1.Assistant = {
              id: MessageID.ascending(),
              sessionID: input.sessionID,
              parentID: userMsg.id,
              mode: input.agent,
              agent: input.agent,
              cost: 0,
              path: { cwd: ctx.directory, root: ctx.worktree },
              time: { created: Date.now() },
              role: "assistant",
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              modelID: model.modelID,
              providerID: model.providerID,
            }
            yield* sessions.updateMessage(msg)
            const started = Date.now()
            const part: SessionV1.ToolPart = {
              type: "tool",
              id: PartID.ascending(),
              messageID: msg.id,
              sessionID: input.sessionID,
              tool: ShellID.ToolID,
              callID: ulid(),
              state: {
                status: "running",
                time: { start: started },
                input: { command: input.command },
              },
            }
            yield* sessions.updatePart(part)
            return { msg, part, cwd: ctx.directory }
          }).pipe(Effect.ensuring(markReady))

          const cfg = yield* config.get()
          const sh = Shell.preferred(cfg.shell)
          const args = Shell.args(sh, input.command, cwd)
          let output = ""
          let aborted = false

          const finish = Effect.uninterruptible(
            Effect.gen(function* () {
              if (aborted) {
                output += "\n\n" + ["<metadata>", "User aborted the command", "</metadata>"].join("\n")
              }
              const completed = Date.now()
              if (!msg.time.completed) {
                msg.time.completed = completed
                yield* sessions.updateMessage(msg)
              }
              if (part.state.status === "running") {
                part.state = {
                  status: "completed",
                  time: { ...part.state.time, end: completed },
                  input: part.state.input,
                  title: "",
                  metadata: { output },
                  output,
                }
                yield* sessions.updatePart(part)
              }
            }),
          )

          const exit = yield* restore(
            Effect.gen(function* () {
              const shellEnv = yield* plugin.trigger(
                "shell.env",
                { cwd, sessionID: input.sessionID, callID: part.callID },
                { env: {} },
              )
              const cmd = ChildProcess.make(sh, args, {
                cwd,
                extendEnv: true,
                env: { ...shellEnv.env, TERM: "dumb" },
                stdin: "ignore",
                forceKillAfter: "3 seconds",
              })
              const handle = yield* spawner.spawn(cmd)
              yield* Stream.runForEach(Stream.decodeText(handle.all), (chunk) =>
                Effect.gen(function* () {
                  output += chunk
                  if (part.state.status === "running") {
                    part.state.metadata = { output }
                    yield* sessions.updatePart(part)
                  }
                }),
              )
              yield* handle.exitCode
            }).pipe(Effect.scoped, Effect.orDie),
          ).pipe(Effect.exit)

          if (Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause) && !Cause.hasDies(exit.cause)) {
            aborted = true
          }
          yield* finish

          if (Exit.isFailure(exit) && !aborted && !Cause.hasInterruptsOnly(exit.cause)) {
            return yield* Effect.failCause(exit.cause)
          }

          return { info: msg, parts: [part] }
        }),
      )
    })

    const getModel = Effect.fn("SessionPrompt.getModel")(function* (
      providerID: ProviderV2.ID,
      modelID: ModelV2.ID,
      sessionID: SessionID,
    ) {
      const exit = yield* provider.getModel(providerID, modelID).pipe(Effect.exit)
      if (Exit.isSuccess(exit)) return exit.value
      const err = Cause.squash(exit.cause)
      if (Provider.ModelNotFoundError.isInstance(err)) {
        const hint = err.suggestions?.length ? ` Did you mean: ${err.suggestions.join(", ")}?` : ""
        yield* events.publish(Session.Event.Error, {
          sessionID,
          error: new NamedError.Unknown({
            message: `Model not found: ${err.providerID}/${err.modelID}.${hint}`,
          }).toObject(),
        })
      }
      return yield* Effect.die(err)
    })

    const currentModel = Effect.fnUntraced(function* (sessionID: SessionID) {
      const current = yield* db
        .select({ model: SessionTable.model })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (current?.model) {
        return {
          providerID: ProviderV2.ID.make(current.model.providerID),
          modelID: ModelV2.ID.make(current.model.id),
          ...(current.model.variant && current.model.variant !== "default" ? { variant: current.model.variant } : {}),
        }
      }
      const match = yield* sessions
        .findMessage(sessionID, (m) => m.info.role === "user" && !!m.info.model)
        .pipe(Effect.orDie)
      if (Option.isSome(match) && match.value.info.role === "user") return match.value.info.model
      // A definition's own `model:` pin has already been consulted by the
      // caller, so the provider default is what is left. There WAS a step
      // between them — an unpinned definition's `model_prefer:` list, resolved
      // against the live catalog — and it is gone: a bot pins its model or it
      // has none (agent/bot.ts).
      return yield* provider.defaultModel().pipe(Effect.orDie)
    })

    const createUserMessage = Effect.fn("SessionPrompt.createUserMessage")(function* (input: PromptInput) {
      const agentName = input.agent
      const ag = agentName ? yield* agents.get(agentName) : yield* agents.defaultInfo()
      if (!ag) {
        const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${agentName}".${hint}` })
        yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }

      const model = input.model ?? ag.model ?? (yield* currentModel(input.sessionID))
      const same = ag.model && model.providerID === ag.model.providerID && model.modelID === ag.model.modelID
      const full =
        !input.variant && ag.variant && same
          ? yield* provider
              .getModel(model.providerID, model.modelID)
              .pipe(Effect.catchIf(Provider.ModelNotFoundError.isInstance, () => Effect.succeed(undefined)))
          : undefined
      const variant = input.variant ?? (ag.variant && full?.variants?.[ag.variant] ? ag.variant : undefined)

      const info: SessionV1.User = {
        id: input.messageID ?? MessageID.ascending(),
        role: "user",
        sessionID: input.sessionID,
        time: { created: Date.now() },
        tools: input.tools,
        agent: ag.name,
        model: {
          providerID: model.providerID,
          modelID: model.modelID,
          variant,
        },
        system: input.system,
        format: input.format,
        temperature: input.temperature,
        topP: input.topP,
        contextOverride: input.contextOverride,
      }

      const current = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      if (
        current.agent !== info.agent ||
        current.model?.providerID !== info.model.providerID ||
        current.model?.id !== info.model.modelID ||
        (current.model?.variant === "default" ? undefined : current.model?.variant) !== info.model.variant
      ) {
        yield* sessions.setAgentModel({
          sessionID: input.sessionID,
          agent: info.agent,
          model: {
            id: info.model.modelID,
            providerID: info.model.providerID,
            variant: info.model.variant ?? "default",
          },
          time: info.time.created,
        })
      }

      yield* Effect.addFinalizer(() => instruction.clear(info.id))

      type Draft<T> = T extends SessionV1.Part ? Omit<T, "id"> & { id?: string } : never
      const assign = (part: Draft<SessionV1.Part>): SessionV1.Part => ({
        ...part,
        id: part.id ? PartID.make(part.id) : PartID.ascending(),
      })

      const resolvePart: (part: PromptInput["parts"][number]) => Effect.Effect<Draft<SessionV1.Part>[]> = Effect.fn(
        "SessionPrompt.resolveUserPart",
      )(function* (part) {
        if (part.type === "file") {
          if (part.source?.type === "resource") {
            const { clientName, uri } = part.source
            yield* Effect.logInfo("mcp resource", { clientName, uri, mime: part.mime })
            const pieces: Draft<SessionV1.Part>[] = [
              {
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text: `Reading MCP resource: ${part.filename} (${uri})`,
              },
            ]
            const exit = yield* mcp.readResource(clientName, uri).pipe(Effect.exit)
            if (Exit.isSuccess(exit)) {
              const content = exit.value
              if (!content) throw new Error(`Resource not found: ${clientName}/${uri}`)
              const items = Array.isArray(content.contents) ? content.contents : [content.contents]
              for (const c of items) {
                if (!c || typeof c !== "object") continue
                if ("text" in c && typeof c.text === "string" && c.text) {
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: c.text,
                  })
                } else if ("blob" in c && typeof c.blob === "string" && c.blob) {
                  const mime = "mimeType" in c && typeof c.mimeType === "string" ? c.mimeType : part.mime
                  const filename = "uri" in c && typeof c.uri === "string" ? c.uri : part.filename
                  const size = mcpResourceBase64Size(c.blob)
                  if (!SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES.has(mime)) {
                    pieces.push({
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `[Binary MCP resource omitted: ${filename ?? uri} (${mime}, ${formatMcpResourceBytes(size)}) is not a supported attachment type]`,
                    })
                    continue
                  }
                  if (size > MAX_MCP_RESOURCE_BLOB_BYTES) {
                    pieces.push({
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `[Binary MCP resource omitted: ${filename ?? uri} (${mime}, ${formatMcpResourceBytes(size)}) exceeds ${formatMcpResourceBytes(MAX_MCP_RESOURCE_BLOB_BYTES)}]`,
                    })
                    continue
                  }
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `[Binary MCP resource attached: ${filename ?? uri} (${mime})]`,
                  })
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "file",
                    mime,
                    filename,
                    url: `data:${mime};base64,${c.blob}`,
                  })
                }
              }
            } else {
              const error = Cause.squash(exit.cause)
              yield* Effect.logError("failed to read MCP resource", { error, clientName, uri })
              const message = error instanceof Error ? error.message : String(error)
              pieces.push({
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text: `Failed to read MCP resource ${part.filename}: ${message}`,
              })
            }
            return pieces
          }
          const url = new URL(part.url)
          switch (url.protocol) {
            case "data:":
              if (part.mime === "text/plain") {
                return [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify({ filePath: part.filename })}`,
                  },
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: decodeDataUrl(part.url),
                  },
                  { ...part, messageID: info.id, sessionID: input.sessionID },
                ]
              }
              break
            case "file:": {
              yield* Effect.logInfo("file", { mime: part.mime })
              const filepath = fileURLToPath(part.url)
              const mime = (yield* fsys.isDir(filepath)) ? "application/x-directory" : part.mime

              const { read } = yield* registry.named()
              const execRead = (args: Parameters<typeof read.execute>[0], extra?: Tool.Context["extra"]) => {
                const controller = new AbortController()
                return read
                  .execute(args, {
                    sessionID: input.sessionID,
                    abort: controller.signal,
                    agent: input.agent!,
                    messageID: info.id,
                    extra: { bypassCwdCheck: true, ...extra },
                    messages: [],
                    metadata: () => Effect.void,
                    ask: () => Effect.void,
                  })
                  .pipe(Effect.onInterrupt(() => Effect.sync(() => controller.abort())))
              }

              if (mime === "text/plain") {
                let offset: number | undefined
                let limit: number | undefined
                const range = { start: url.searchParams.get("start"), end: url.searchParams.get("end") }
                if (range.start != null) {
                  const filePathURI = part.url.split("?")[0]
                  let start = parseInt(range.start)
                  let end = range.end ? parseInt(range.end) : undefined
                  if (start === end) {
                    const symbols = yield* lsp.documentSymbol(filePathURI).pipe(Effect.catch(() => Effect.succeed([])))
                    for (const symbol of symbols) {
                      let r: LSP.Range | undefined
                      if ("range" in symbol) r = symbol.range
                      else if ("location" in symbol) r = symbol.location.range
                      if (r?.start?.line && r?.start?.line === start) {
                        start = r.start.line
                        end = r?.end?.line ?? start
                        break
                      }
                    }
                  }
                  offset = Math.max(start, 1)
                  if (end) limit = end - (offset - 1)
                }
                const args = { filePath: filepath, offset, limit }
                const pieces: Draft<SessionV1.Part>[] = [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                  },
                ]
                const exit = yield* provider.getModel(info.model.providerID, info.model.modelID).pipe(
                  Effect.flatMap((mdl) => execRead(args, { model: mdl })),
                  Effect.exit,
                )
                if (Exit.isSuccess(exit)) {
                  const result = exit.value
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: result.output,
                  })
                  if (result.attachments?.length) {
                    pieces.push(
                      ...result.attachments.map((a) => ({
                        ...a,
                        synthetic: true,
                        filename: a.filename ?? part.filename,
                        messageID: info.id,
                        sessionID: input.sessionID,
                      })),
                    )
                  } else {
                    pieces.push({ ...part, mime, messageID: info.id, sessionID: input.sessionID })
                  }
                } else {
                  const error = Cause.squash(exit.cause)
                  yield* Effect.logError("failed to read file", { error, filepath })
                  const message = error instanceof Error ? error.message : String(error)
                  yield* events.publish(Session.Event.Error, {
                    sessionID: input.sessionID,
                    error: new NamedError.Unknown({ message }).toObject(),
                  })
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Read tool failed to read ${filepath} with the following error: ${message}`,
                  })
                }
                return pieces
              }

              if (mime === "application/x-directory") {
                const args = { filePath: filepath }
                const exit = yield* execRead(args).pipe(Effect.exit)
                if (Exit.isFailure(exit)) {
                  const error = Cause.squash(exit.cause)
                  yield* Effect.logError("failed to read directory", { error, filepath })
                  const message = error instanceof Error ? error.message : String(error)
                  yield* events.publish(Session.Event.Error, {
                    sessionID: input.sessionID,
                    error: new NamedError.Unknown({ message }).toObject(),
                  })
                  return [
                    {
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `Read tool failed to read ${filepath} with the following error: ${message}`,
                    },
                  ]
                }
                return [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                  },
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: exit.value.output,
                  },
                  { ...part, mime, messageID: info.id, sessionID: input.sessionID },
                ]
              }

              return [
                {
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "text",
                  synthetic: true,
                  text: `Called the Read tool with the following input: {"filePath":"${filepath}"}`,
                },
                {
                  id: part.id,
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "file",
                  url:
                    `data:${mime};base64,` +
                    Buffer.from(yield* fsys.readFile(filepath).pipe(Effect.catch(Effect.die))).toString("base64"),
                  mime,
                  filename: part.filename!,
                  source: part.source,
                },
              ]
            }
          }
        }

        if (part.type === "agent") {
          const perm = Permission.evaluate("task", part.name, ag.permission)
          const hint = perm.action === "deny" ? " . Invoked by user; guaranteed to exist." : ""
          return [
            { ...part, messageID: info.id, sessionID: input.sessionID },
            {
              messageID: info.id,
              sessionID: input.sessionID,
              type: "text",
              synthetic: true,
              text:
                " Use the above message and context to generate a prompt and call the task tool with subagent: " +
                part.name +
                hint,
            },
          ]
        }

        return [{ ...part, messageID: info.id, sessionID: input.sessionID }]
      })

      const resolvedParts = yield* Effect.forEach(input.parts, resolvePart, { concurrency: "unbounded" }).pipe(
        Effect.map((x) => x.flat().map(assign)),
      )

      yield* plugin.trigger(
        "chat.message",
        {
          sessionID: input.sessionID,
          agent: input.agent,
          model: input.model,
          messageID: input.messageID,
          variant: input.variant,
        },
        { message: info, parts: resolvedParts },
      )

      const parts = yield* Effect.forEach(resolvedParts, (part) =>
        part.type === "file" && part.mime.startsWith("image/")
          ? image.normalize(part).pipe(
              Effect.catchIf(
                (error) => error instanceof Image.ResizerUnavailableError,
                () => Effect.succeed(part),
              ),
            )
          : Effect.succeed(part),
      )

      const parsed = decodeMessageInfo(info, { errors: "all", propertyOrder: "original" })
      if (Exit.isFailure(parsed)) {
        yield* Effect.logError("invalid user message before save", {
          sessionID: input.sessionID,
          messageID: info.id,
          agent: info.agent,
          model: info.model,
          cause: Cause.pretty(parsed.cause),
        })
      }
      for (const [index, part] of parts.entries()) {
        const p = decodeMessagePart(part, { errors: "all", propertyOrder: "original" })
        if (Exit.isSuccess(p)) continue
        yield* Effect.logError("invalid user part before save", {
          sessionID: input.sessionID,
          messageID: info.id,
          partID: part.id,
          partType: part.type,
          index,
          cause: Cause.pretty(p.cause),
          part,
        })
      }

      yield* sessions.updateMessage(info)
      for (const part of parts) yield* sessions.updatePart(part)

      return { info, parts }
    }, Effect.scoped)

    const prompt: (input: PromptInput) => Effect.Effect<SessionV1.WithParts, Image.Error> = Effect.fn(
      "SessionPrompt.prompt",
    )(function* (input: PromptInput) {
      const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      yield* revert.cleanup(session)
      const message = yield* createUserMessage(input)
      yield* sessions.touch(input.sessionID)

      // A `tools` map on the prompt authoritatively REPLACES the session
      // permission ruleset: { edit: true } allows edits, { "*": true } allows
      // everything, and an EMPTY map ({}) clears it back to the agent defaults
      // (ask). Only an ABSENT (undefined) map leaves the ruleset untouched. This
      // present-clears semantics is what lets the ACP permission-mode presets
      // (default/auto/bypass) ride each prompt and reset cleanly - e.g.
      // downgrading bypass -> default sends {} and the persisted rules are dropped
      // (the old `permissions.length > 0` guard could never express that reset).
      if (input.tools !== undefined) {
        const permissions: PermissionV1.Rule[] = []
        for (const [t, enabled] of Object.entries(input.tools)) {
          permissions.push({ permission: t, action: enabled ? "allow" : "deny", pattern: "*" })
        }
        session.permission = permissions
        yield* sessions.setPermission({ sessionID: session.id, permission: permissions })
      }

      if (input.noReply === true) return message
      return yield* loop({ sessionID: input.sessionID })
    })

    const lastAssistant = Effect.fnUntraced(function* (sessionID: SessionID) {
      const match = yield* sessions.findMessage(sessionID, (m) => m.info.role !== "user").pipe(Effect.orDie)
      if (Option.isSome(match)) return match.value
      const msgs = yield* sessions.messages({ sessionID, limit: 1 }).pipe(Effect.orDie)
      if (msgs.length > 0) return msgs[0]
      throw new Error("Impossible")
    })

    // origami_change-start (bounded unknown-continue)
    /**
     * The engine's own line in the chat, written the way
     * `session/processor.ts`'s `notice` writes one: create the part, publish the
     * delta, then persist the text. The delta is what puts it in front of the
     * user - a whole-part text update with no peer or task-result metadata is
     * dropped by the ACP bridge's `handlePartUpdated`, so without it the line
     * would surface only on a later history replay.
     */
    const unknownFinishNotice = Effect.fn("SessionPrompt.unknownFinishNotice")(function* (
      message: SessionV1.Assistant,
    ) {
      const start = Date.now()
      const part: SessionV1.TextPart = {
        id: PartID.ascending(),
        messageID: message.id,
        sessionID: message.sessionID,
        type: "text",
        text: "",
        time: { start },
        metadata: { [UNKNOWN_FINISH_KEY]: "bounded" },
      }
      yield* sessions.updatePart(part)
      yield* sessions.updatePartDelta({
        sessionID: part.sessionID,
        messageID: part.messageID,
        partID: part.id,
        field: "text",
        delta: UNKNOWN_FINISH_NOTICE,
      })
      yield* sessions.updatePart({ ...part, text: UNKNOWN_FINISH_NOTICE, time: { start, end: Date.now() } })
    })
    // origami_change-end

    const runLoop: (sessionID: SessionID) => Effect.Effect<SessionV1.WithParts> = Effect.fn("SessionPrompt.run")(
      function* (sessionID: SessionID) {
        const ctx = yield* InstanceState.context
        let structured: unknown
        let step = 0
        // origami_change (bounded unknown-continue): consecutive steps this turn
        // that ended on an unreadable stop reason and were carried on anyway.
        let unknownContinues = 0
        const session = yield* sessions.get(sessionID).pipe(Effect.orDie)

        while (true) {
          yield* status.set(sessionID, { type: "busy" })
          yield* Effect.logInfo("loop", { "session.id": sessionID, step })

          let msgs = yield* MessageV2.filterCompactedEffect(sessionID).pipe(
            Effect.provideService(Database.Service, database),
          )

          const { user: lastUser, assistant: lastAssistant, finished: lastFinished, tasks } = MessageV2.latest(msgs)

          if (!lastUser) throw new Error("No user message found in stream. This should never happen.")

          const lastAssistantMsg = msgs.findLast(
            (msg) => msg.info.role === "assistant" && msg.info.id === lastAssistant?.id,
          )
          // Some providers return "stop" even when the assistant message contains
          // tool calls. Keep the loop running so tool results can be sent back to
          // the model, but ignore cleanup-marked interrupted orphans.
          const hasToolCalls =
            lastAssistantMsg?.parts.some(
              (part) => part.type === "tool" && !part.metadata?.providerExecuted && !isOrphanedInterruptedTool(part),
            ) ?? false

          // origami_change-start (bounded unknown-continue)
          // A step this gate would have EXITED on, but for "unknown" now sitting
          // in the continue-list beside "tool-calls". Computed before the gate so
          // the counter measures exactly the continues the new entry bought, and
          // nothing else: an interjection keeps the turn alive on its own terms
          // (`lastUser.id > lastAssistant.id`) and must not spend this budget.
          const unknownContinue =
            lastAssistant?.finish === "unknown" && !hasToolCalls && lastUser.id < lastAssistant.id
          // Consecutive-ish: any READABLE reason puts the budget back. A step
          // that finishes "unknown" WITH tool parts takes neither branch - it
          // neither spends the budget nor restores it - so a gateway that
          // mangles reasons on tool steps too can reach the bound across
          // non-adjacent prose steps. Deliberate: three unreadable prose stops
          // in one turn is the broken-route signal regardless of spacing.
          if (lastAssistant?.finish && lastAssistant.finish !== "unknown") unknownContinues = 0
          if (unknownContinue) unknownContinues++
          // origami_change-end

          if (
            lastAssistant?.finish &&
            // origami_change (bounded unknown-continue): upstream opencode
            // 1.18.21's line. "unknown" means nobody could read how the reply
            // ended, so treating it as finished ends the turn mid-answer.
            !["tool-calls", "unknown"].includes(lastAssistant.finish) &&
            !hasToolCalls &&
            lastUser.id < lastAssistant.id
          ) {
            const orphan = lastAssistantMsg?.parts.find(
              (part): part is SessionV1.ToolPart => part.type === "tool" && isOrphanedInterruptedTool(part),
            )
            if (orphan) {
              yield* Effect.logWarning("loop exit with orphaned interrupted tool", {
                "session.id": sessionID,
                messageID: lastAssistant.id,
                tool: orphan.tool,
                callID: orphan.callID,
              })
            }
            yield* Effect.logInfo("exiting loop", { "session.id": sessionID })
            break
          }

          // origami_change-start (bounded unknown-continue)
          // The bound. Not an error state: the model produced prose on every one
          // of these steps, so the turn's content is real - this is the steady
          // state of a gateway that cannot spell its stop reason, and the honest
          // move is to say so once and stop asking.
          if (lastAssistant && unknownContinue && unknownContinues > UNKNOWN_CONTINUE_LIMIT) {
            yield* Effect.logWarning("stopping on repeated unknown finish", {
              "session.id": sessionID,
              messageID: lastAssistant.id,
              continues: unknownContinues,
              limit: UNKNOWN_CONTINUE_LIMIT,
            })
            // Never onto a summary: compaction quotes a summary's text parts
            // back as history, and the engine's line is not model prose - the
            // same guard the processor's TRUNCATED_NOTICE carries.
            if (!lastAssistant.summary) yield* unknownFinishNotice(lastAssistant)
            break
          }
          // origami_change-end

          step++
          if (step === 1)
            yield* title({
              session,
              modelID: lastUser.model.modelID,
              providerID: lastUser.model.providerID,
              history: msgs,
            }).pipe(Effect.ignore, Effect.forkIn(scope))

          const resolvedModel = yield* getModel(lastUser.model.providerID, lastUser.model.modelID, sessionID)
          // t-lmqe0g: applied HERE, the single point every downstream reader of
          // `model` shares (compaction/overflow, native-request, sys.environment).
          const model = applyContextOverride(resolvedModel, lastUser.contextOverride)
          const task = tasks.pop()

          if (task?.type === "subtask") {
            yield* handleSubtask({ task, model, lastUser, sessionID, session, msgs })
            continue
          }

          if (task?.type === "compaction") {
            const result = yield* compaction.process({
              messages: msgs,
              parentID: lastUser.id,
              sessionID,
              auto: task.auto,
              overflow: task.overflow,
            })
            if (result === "stop") break
            continue
          }

          if (
            lastFinished &&
            lastFinished.summary !== true &&
            (yield* compaction.isOverflow({ tokens: lastFinished.tokens, model, sessionID }))
          ) {
            yield* compaction.create({ sessionID, agent: lastUser.agent, model: lastUser.model, auto: true })
            continue
          }

          const agent = yield* agents.get(lastUser.agent)
          if (!agent) {
            const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
            const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
            const error = new NamedError.Unknown({ message: `Agent not found: "${lastUser.agent}".${hint}` })
            yield* events.publish(Session.Event.Error, { sessionID, error: error.toObject() })
            throw error
          }
          const maxSteps = agent.steps ?? DEFAULT_MAX_STEPS
          // Hard backstop against a non-terminating loop. The soft nudge below
          // (isLastStep -> MAX_STEPS_PROMPT) asks the model to wrap up on its
          // last allowed step (step === maxSteps); if it ignores that and the
          // loop reaches the step AFTER the cap, stop deterministically rather
          // than run another model call forever. `step` was already incremented
          // for this iteration above, and no assistant message is created until
          // after this point, so breaking here exits cleanly like the other
          // guarded loop exits.
          if (step > maxSteps) {
            const error = new NamedError.Unknown({
              message: `Stopped after reaching the ${maxSteps}-step limit for a single turn. This is a safety backstop against a runaway loop. If this was legitimate long-running work, raise the agent's "steps" budget or split the task across turns.`,
            })
            // The event alone is not the record. It reaches whoever is listening
            // at this instant and nobody else, while the STORED message is what a
            // replay, a late-joining client and every task adapter read - and it
            // was left with no error and no completed time, i.e. indistinguishable
            // from a turn still in flight. Marked the same way the interrupted and
            // halted paths mark theirs.
            if (lastAssistant) {
              lastAssistant.error ??= error.toObject()
              lastAssistant.time.completed ??= Date.now()
              yield* sessions.updateMessage(lastAssistant)
            }
            yield* events.publish(Session.Event.Error, { sessionID, error: error.toObject() })
            yield* Effect.logWarning("stopping on max steps", { "session.id": sessionID, maxSteps, step })
            break
          }
          const isLastStep = step >= maxSteps
          // The STORED list, read fresh each step: the window `msgs` holds is
          // post-compaction, so it is exactly the thing that cannot be trusted
          // to still carry the todos.
          //
          // Two channels back (see `SessionReminders.Applied`): the window, with
          // any PERSISTED plan brief already in it, and the in-memory reminder
          // texts for this step. The second lot never enters a stored message -
          // they ride the trailing lane with the memory index, because they are
          // recomputed every step and rewriting a sent message costs the cache.
          const applied = yield* SessionReminders.apply({
            messages: msgs,
            agent,
            session,
            todos: yield* todo.get(sessionID),
          }).pipe(
            Effect.provideService(RuntimeFlags.Service, flags),
            Effect.provideService(FSUtil.Service, fsys),
            Effect.provideService(Session.Service, sessions),
          )
          msgs = applied.messages

          const msg: SessionV1.Assistant = {
            id: MessageID.ascending(),
            parentID: lastUser.id,
            role: "assistant",
            mode: agent.name,
            agent: agent.name,
            variant: lastUser.model.variant,
            path: { cwd: ctx.directory, root: ctx.worktree },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: model.id,
            providerID: model.providerID,
            time: { created: Date.now() },
            sessionID,
          }
          yield* sessions.updateMessage(msg)

          const finalizeInterruptedAssistant = Effect.gen(function* () {
            if (msg.time.completed) return
            msg.error ??= MessageV2.fromError(new DOMException("Aborted", "AbortError"), {
              providerID: msg.providerID,
              aborted: true,
            })
            msg.time.completed = Date.now()
            yield* sessions.updateMessage(msg)
          })

          const handle = yield* processor
            .create({
              assistantMessage: msg,
              sessionID,
              model,
            })
            .pipe(Effect.onInterrupt(() => finalizeInterruptedAssistant))

          const outcome: "break" | "continue" = yield* Effect.gen(function* () {
            const lastUserMsg = msgs.findLast((m) => m.info.role === "user")
            const bypassAgentCheck = lastUserMsg?.parts.some((p) => p.type === "agent") ?? false
            const promptOps = yield* ops()

            // The flock tools exist for the duration of a COLLAB turn and
            // nowhere else. Gated on the turn context rather than on the agent
            // or a config flag: an ordinary chat has no room to post into, no
            // roster to address and no budget to spend, so giving it `ask`
            // would be giving it a tool that can only fail.
            const collabTurn = yield* CollabSystem.Turn
            // origami_change-start (prompt matrix): a COMPOSED turn is a
            // character speaking - a bot session or a collab turn - and the
            // workspace's own instruction files are not a character's to read.
            // The other half of the matrix (which base prompt sits above the
            // persona) is in session/llm/request.ts; this half has to live
            // HERE, at the source, because the transparency capture is drafted
            // from the very list built below. Filtering in the request layer
            // instead would leave the capture claiming an `instructions` block
            // the model never received, and the capture is the surface a user
            // checks the prompt with.
            const composed = collabTurn !== undefined || AgentBot.isBot(agent)
            // origami_change-end
            const flockTools = collabTurn
              ? yield* FlockTools.defs.pipe(
                  Effect.provideService(Truncate.Service, truncate),
                  Effect.provideService(Agent.Service, agents),
                )
              : undefined

            // t-kgtr6c. ONE gate, read once, spent twice: it decides both the
            // tool below and the sys.vision block further down. Registering the
            // tool without the prompt block gives the model something it never
            // reaches for; the block without the tool gives it an instruction
            // it cannot follow. `session` is re-read per turn by the loop, so a
            // profile set mid-conversation applies from the next message.
            //
            // Round 5 split the SECOND fact out. Arming is the toggle plus a
            // blind model; whether a picture is actually on the turn is now
            // only asked where it still matters - the media strip below.
            const visionProfile = SessionVision.activeProfile({
              profile: Session.visionProfile(session),
              model,
            })
            const turnHasImage = SessionVision.turnHasImage(msgs)
            const visionTools = visionProfile
              ? yield* VisionRequest.defs({ profile: visionProfile, images: SessionVision.turnImages(msgs) }).pipe(
                  Effect.provideService(Truncate.Service, truncate),
                  Effect.provideService(Agent.Service, agents),
                  // Round 4: the tool is a DIRECT completion, so it needs the
                  // provider layer and no longer needs the session store — it
                  // creates nothing.
                  Effect.provideService(Provider.Service, provider),
                )
              : undefined

            const extraTools =
              flockTools || visionTools ? [...(flockTools ?? []), ...(visionTools ?? [])] : undefined

            const tools = yield* SessionTools.resolve({
              agent,
              session,
              model,
              processor: handle,
              bypassAgentCheck,
              messages: msgs,
              promptOps,
              ...(extraTools ? { extraTools } : {}),
            }).pipe(
              Effect.provideService(Plugin.Service, plugin),
              Effect.provideService(Permission.Service, permission),
              Effect.provideService(ToolRegistry.Service, registry),
              Effect.provideService(ToolSearch.Service, toolSearch),
              Effect.provideService(MCP.Service, mcp),
              Effect.provideService(Truncate.Service, truncate),
              Effect.provideService(RuntimeFlags.Service, flags),
              // Config.Service so resolve can read `tools: { <id>: false }` —
              // the OFF state (tool/tool-enabled.ts). `runLoop` is annotated
              // R = never, so every service resolve needs must be handed to it
              // here, like the ones above.
              Effect.provideService(Config.Service, config),
              // Session.Service so each tool's `ask` can re-read the session
              // ruleset LIVE, instead of the snapshot this turn opened with.
              Effect.provideService(Session.Service, sessions),
            )

            if (lastUser.format?.type === "json_schema") {
              tools["StructuredOutput"] = createStructuredOutputTool({
                schema: lastUser.format.schema,
                onSuccess(output) {
                  structured = output
                },
              })
            }

            if (step === 1)
              yield* summary.summarize({ sessionID, messageID: lastUser.id }).pipe(Effect.ignore, Effect.forkIn(scope))

            yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })

            const [skills, botMemory, env, instructions, memory, mcpInstructions, flock, vision, modelMsgs] =
              yield* Effect.all([
                sys.skills(agent),
                // A BOT's own store, and only a bot's. `systemBlock` answers
                // undefined for a native agent — which is what a MAIN session
                // runs — so a chat's prompt is untouched, and undefined again
                // when the bot has remembered nothing yet. The same definition
                // resolves the same directory in a bot session and in a collab
                // participation, because the directory is keyed to the
                // DEFINITION FILE rather than to the session.
                AgentBotMemory.systemBlock({
                  name: agent.name,
                  info: agent,
                  definitionFile: (name) => agents.definitionFile(name),
                }).pipe(Effect.provideService(FSUtil.Service, fsys)),
                sys.environment(model),
                // origami_change (prompt matrix): empty for a composed turn - see
                // `composed` above.
                composed ? Effect.succeed<string[]>([]) : instruction.system().pipe(Effect.orDie),
                // The memory index, kept OUT of the system prompt on purpose -
                // it is appended to the message list below. Same gate as the
                // instruction files: a composed turn is not delivered either.
                composed ? Effect.succeed<string[]>([]) : instruction.memory().pipe(Effect.orDie),
                sys.mcp(agent, session.permission),
                sys.flock(agent),
                sys.vision(visionProfile),
                // t-kgtr6c. The SAME gate spent a third time, on the parent's own
                // request. Without it this turn carries two contradictory
                // instructions: `provider/transform.ts:408` swaps the image the
                // model cannot read for "ERROR: Cannot read ... Inform the user",
                // while `sys.vision` above tells it to call `vision_request`
                // instead. Armed, the part is a neutral note instead - see
                // `SessionVision.blindOptions` for what reaches the wire either
                // way. Unarmed it is `undefined`, so an ordinary chat is
                // unchanged.
                MessageV2.toModelMessagesEffect(msgs, model, SessionVision.blindOptions(visionProfile, turnHasImage)),
              ])
            const format = lastUser.format ?? { type: "text" as const }
            // The blocks the model gets, each still knowing where it came from.
            // `system` is DERIVED from them so the prompt and the transparency
            // capture cannot drift apart; the request layer completes the
            // capture once the plugin transform has had the final say.
            const systemParts = SessionPromptCapture.parts({
              env,
              instructions,
              mcp: mcpInstructions,
              skills,
              flock,
              vision,
              structuredOutput: format.type === "json_schema" ? STRUCTURED_OUTPUT_SYSTEM_PROMPT : undefined,
            })
            const system = systemParts.map((entry) => entry.text)
            // THE MEMORY BLOCKS DO NOT GO IN THE SYSTEM PROMPT.
            //
            // Everything above holds still across a conversation's steps, so
            // it sits in the provider's cached prefix. The memory index is the
            // one prompt input the agent REWRITES mid-turn (`remember`), and a
            // prefix cache is an exact-match: one remembered fact invalidated
            // the entire conversation and the next step re-read the whole
            // context - measured at 190-240s on long sessions. Appended after
            // the last message it sits past every breakpoint, so a write costs
            // only the block itself. Delivered as `user` because a trailing
            // `system` message is rejected by the Anthropic message format.
            const memoryParts = SessionPromptCapture.memoryParts({ memory, botMemory })
            SessionPromptCapture.draft(sessionID, [...systemParts, ...memoryParts])
            const result = yield* handle.process({
              user: lastUser,
              agent,
              permission: session.permission,
              sessionID,
              parentSessionID: session.parentID,
              system,
              messages: [
                ...withTrailingInjections(modelMsgs, memoryParts, applied.reminders),
                ...(isLastStep ? [{ role: "assistant" as const, content: MAX_STEPS_PROMPT }] : []),
              ],
              tools,
              model,
              toolChoice: format.type === "json_schema" ? "required" : undefined,
            })

            if (structured !== undefined) {
              handle.message.structured = structured
              handle.message.finish = handle.message.finish ?? "stop"
              yield* sessions.updateMessage(handle.message)
              return "break" as const
            }

            const finished = handle.message.finish && !["tool-calls", "unknown"].includes(handle.message.finish)
            if (finished && !handle.message.error) {
              // Surface any content-filter finish (e.g. Anthropic stop_reason:
              // refusal) as an error. These turns may have produced no visible
              // output at all — previously the session went idle silently — or
              // partial text that was cut off by the provider's filter.
              if (handle.message.finish === "content-filter") {
                handle.message.error = new SessionV1.ContentFilterError({
                  message: "The response was blocked by the provider's content filter",
                }).toObject()
                yield* sessions.updateMessage(handle.message)
                yield* events.publish(Session.Event.Error, { sessionID, error: handle.message.error })
                return "break" as const
              }
              if (format.type === "json_schema") {
                handle.message.error = new SessionV1.StructuredOutputError({
                  message: "Model did not produce structured output",
                  retries: 0,
                }).toObject()
                yield* sessions.updateMessage(handle.message)
                return "break" as const
              }
            }

            // `handoff` and `done` end the turn from INSIDE it. A tool cannot
            // break its own agent's loop, so it records the intent on the turn
            // context and the loop honours it here - after the step that ran
            // the tool, so the tool result is still delivered.
            if (collabTurn?.stop.requested) {
              handle.message.finish = handle.message.finish ?? "stop"
              yield* sessions.updateMessage(handle.message)
              return "break" as const
            }

            if (result === "stop") return "break" as const
            if (result === "compact") {
              yield* compaction.create({
                sessionID,
                agent: lastUser.agent,
                model: lastUser.model,
                auto: true,
                overflow: !handle.message.finish,
              })
            }
            return "continue" as const
          }).pipe(
            Effect.ensuring(instruction.clear(handle.message.id)),
            Effect.onInterrupt(() => finalizeInterruptedAssistant),
          )
          if (outcome === "break") break
          continue
        }

        yield* compaction.prune({ sessionID }).pipe(Effect.ignore, Effect.forkIn(scope))
        return yield* lastAssistant(sessionID)
      },
    )

    /**
     * GOAL MODE's post-turn hook (session/goal.ts).
     *
     * FORKED, and forked HERE rather than inside `runLoop`, for two reasons.
     * The turn has to END first - the caller gets its answer, the UI settles,
     * and the user can interject - because the check spawns a whole critic
     * session and an inline one would freeze the chat behind it. And it has to
     * be after `ensureRunning` rather than at the bottom of `runLoop`, because
     * `Runner.finishRun` runs `onIdle` BEFORE it completes the caller's
     * deferred: by this line the session is demonstrably idle, so the check
     * never has to poll for a turn that has not finished letting go.
     *
     * `Effect.ignore` on top of the module's own guards: a goal check that
     * fails must cost the turn that triggered it nothing at all.
     */
    const goalDeps = Effect.fn("SessionPrompt.goalDeps")(function* (sessionID: SessionID) {
      const ctx = yield* InstanceState.context
      return {
        sessions,
        agents,
        ops: yield* ops(),
        worktree: ctx.worktree,
        model: currentModel(sessionID).pipe(
          Effect.map((model) => ({ providerID: model.providerID, modelID: model.modelID })),
        ),
        lastAssistant: lastAssistant(sessionID).pipe(
          Effect.map((message) => (message.info.role === "assistant" ? message : undefined)),
          Effect.catchCause(() => Effect.succeed(undefined)),
        ),
      } satisfies SessionGoal.CheckDeps
    })

    const loop: (input: LoopInput) => Effect.Effect<SessionV1.WithParts> = Effect.fn("SessionPrompt.loop")(function* (
      input: LoopInput,
    ) {
      const result = yield* state.ensureRunning(
        input.sessionID,
        lastAssistant(input.sessionID),
        runLoop(input.sessionID),
      )
      yield* goalDeps(input.sessionID)
        .pipe(
          Effect.flatMap((deps) => SessionGoal.check(deps, input.sessionID)),
          Effect.ignore,
          Effect.forkIn(scope),
        )
        .pipe(Effect.ignore)
      return result
    })

    // origami_change-start (interject): a message the user pushed INTO a
    // running turn instead of waiting for the turn to end.
    //
    // Delivery needs no queue of its own. `runLoop` re-reads the whole message
    // window from the store at the top of every step, so a user message
    // persisted here is picked up at the next tool boundary by itself - and
    // that same write is what a replay or a session restore reads back, in
    // order, for free. It also flips the loop's exit test
    // (`lastUser.id < lastAssistant.id`), so a turn that would otherwise have
    // finished stays alive to answer it.
    //
    // The signal is the other half. A foreground shell that runs for minutes
    // never REACHES a boundary; signalling promotes it to a background job -
    // process untouched, output still streaming - which settles the blocking
    // tool call and brings the boundary forward to now.
    const interject: (input: InterjectInput) => Effect.Effect<InterjectResult> = Effect.fn(
      "SessionPrompt.interject",
    )(function* (input: InterjectInput) {
      const busy = yield* state.assertNotBusy(input.sessionID).pipe(
        Effect.as(false),
        Effect.catch(() => Effect.succeed(true)),
      )
      // Agent and model come from the last user message, read exactly as
      // `runLoop` reads them, so an interjection can never silently switch the
      // agent or model the turn is already running under.
      const msgs = yield* MessageV2.filterCompactedEffect(input.sessionID).pipe(
        Effect.provideService(Database.Service, database),
      )
      const prior = MessageV2.latest(msgs).user
      const model = prior?.model ?? (yield* currentModel(input.sessionID))
      const agent = prior?.agent ?? (yield* agents.defaultInfo())?.name
      const message: SessionV1.User = {
        id: MessageID.ascending(),
        sessionID: input.sessionID,
        role: "user",
        time: { created: Date.now() },
        agent,
        model: { providerID: model.providerID, modelID: model.modelID },
      }
      yield* sessions.updateMessage(message)
      // The envelope is `synthetic`: the model must read it, and the user must
      // not be shown instructions written on their behalf.
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: message.id,
        sessionID: input.sessionID,
        type: "text",
        text: Interject.ENVELOPE,
        synthetic: true,
      } satisfies SessionV1.TextPart)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: message.id,
        sessionID: input.sessionID,
        type: "text",
        text: input.text,
      } satisfies SessionV1.TextPart)
      yield* sessions.touch(input.sessionID)
      const promoted = yield* interjections.signal(input.sessionID)
      // Not busy = the turn ended between the user queueing the message and
      // pressing the button. Nothing is left to re-read the store, so start the
      // turn a plain send would have started. Forked: the caller is a UI click
      // waiting on an acknowledgement, not on an answer.
      if (!busy) yield* loop({ sessionID: input.sessionID }).pipe(Effect.forkIn(scope))
      yield* Effect.logInfo("interject", { "session.id": input.sessionID, busy, promoted })
      return { messageID: message.id, busy, promoted }
    })
    // origami_change-end

    const shell: (input: ShellInput) => Effect.Effect<SessionV1.WithParts, Session.BusyError> = Effect.fn(
      "SessionPrompt.shell",
    )(function* (input: ShellInput) {
      const ready = yield* Latch.make()
      return yield* state.startShell(input.sessionID, lastAssistant(input.sessionID), shellImpl(input, ready), ready)
    })

    const command = Effect.fn("SessionPrompt.command")(function* (input: CommandInput) {
      yield* Effect.logInfo("command", {
        "session.id": input.sessionID,
        command: input.command,
        agent: input.agent,
      })
      const cmd = yield* commands.get(input.command)
      if (!cmd) {
        const available = (yield* commands.list()).map((c) => c.name)
        const hint = available.length ? ` Available commands: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Command not found: "${input.command}".${hint}` })
        yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }
      const agentName = cmd.agent ?? input.agent

      const raw = input.arguments.match(argsRegex) ?? []
      const args = raw.map((arg) => arg.replace(quoteTrimRegex, ""))
      const templateCommand = yield* Effect.promise(async () => cmd.template)

      const placeholders = templateCommand.match(placeholderRegex) ?? []
      let last = 0
      for (const item of placeholders) {
        const value = Number(item.slice(1))
        if (value > last) last = value
      }

      const withArgs = templateCommand.replaceAll(placeholderRegex, (_, index) => {
        const position = Number(index)
        const argIndex = position - 1
        if (argIndex >= args.length) return ""
        if (position === last) return args.slice(argIndex).join(" ")
        return args[argIndex]
      })
      const usesArgumentsPlaceholder = templateCommand.includes("$ARGUMENTS")
      let template = withArgs.replaceAll("$ARGUMENTS", input.arguments)

      if (placeholders.length === 0 && !usesArgumentsPlaceholder && input.arguments.trim()) {
        template = template + "\n\n" + input.arguments
      }

      const shellMatches = ConfigMarkdown.shell(template)
      if (shellMatches.length > 0) {
        const cfg = yield* config.get()
        const sh = Shell.preferred(cfg.shell)
        const results = yield* Effect.promise(() =>
          Promise.all(
            shellMatches.map(async ([, cmd]) => (await Process.text([cmd], { shell: sh, nothrow: true })).text),
          ),
        )
        let index = 0
        template = template.replace(bashRegex, () => results[index++])
      }
      template = template.trim()

      // Session-scoped ${todos} injection for commands that audit the agent's
      // stated work against the actual diff (e.g. /verify-plan). Subtask commands
      // run context-isolated, so the todo list cannot reach the critic any other
      // way. Done AFTER shell substitution so todo text is never executed. Only
      // read the todo table when the template actually asks for it.
      if (template.includes(TODOS_PLACEHOLDER)) {
        template = substituteTodos(template, yield* todo.get(input.sessionID))
      }

      const taskModel = yield* Effect.gen(function* () {
        if (cmd.model) return Provider.parseModel(cmd.model)
        if (cmd.agent) {
          const cmdAgent = yield* agents.get(cmd.agent)
          if (cmdAgent?.model) return cmdAgent.model
        }
        if (input.model) return Provider.parseModel(input.model)
        return yield* currentModel(input.sessionID)
      })

      yield* getModel(taskModel.providerID, taskModel.modelID, input.sessionID)

      const agent = agentName ? yield* agents.get(agentName) : yield* agents.defaultInfo()
      if (!agent) {
        const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${agentName}".${hint}` })
        yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }

      const templateParts = yield* resolvePromptParts(template)
      const inputFiles = new Set(
        input.parts?.filter((part) => new URL(part.url).protocol === "file:").map((part) => fileURLToPath(part.url)),
      )
      const uniqueTemplateParts = templateParts.filter(
        (part) => part.type !== "file" || !inputFiles.has(fileURLToPath(part.url)),
      )
      const isSubtask = (agent.mode === "subagent" && cmd.subtask !== false) || cmd.subtask === true
      const parts = isSubtask
        ? [
            {
              type: "subtask" as const,
              agent: agent.name,
              description: cmd.description ?? "",
              command: input.command,
              model: { providerID: taskModel.providerID, modelID: taskModel.modelID },
              prompt: templateParts.find((y) => y.type === "text")?.text ?? "",
            },
          ]
        : [...uniqueTemplateParts, ...(input.parts ?? [])]

      const userAgent = isSubtask ? (input.agent ?? (yield* agents.defaultInfo()).name) : agent.name
      const userModel = isSubtask
        ? input.model
          ? Provider.parseModel(input.model)
          : yield* currentModel(input.sessionID)
        : taskModel

      yield* plugin.trigger(
        "command.execute.before",
        { command: input.command, sessionID: input.sessionID, arguments: input.arguments },
        { parts },
      )

      const result = yield* prompt({
        sessionID: input.sessionID,
        messageID: input.messageID,
        model: userModel,
        agent: userAgent,
        parts,
        variant: input.variant,
      })
      yield* events.publish(Command.Event.Executed, {
        name: input.command,
        sessionID: input.sessionID,
        arguments: input.arguments,
        messageID: result.info.id,
      })
      return result
    })

    return Service.of({
      cancel,
      prompt,
      loop,
      interject, // origami_change
      shell,
      command,
      resolvePromptParts,
    })
  }),
)

const ModelRef = Schema.Struct({
  providerID: ProviderV2.ID,
  modelID: ModelV2.ID,
})

export const PromptInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
  model: Schema.optional(ModelRef),
  agent: Schema.optional(Schema.String),
  noReply: Schema.optional(Schema.Boolean),
  tools: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)).annotate({
    description:
      "@deprecated tools and permissions have been merged, you can set permissions on the session itself now",
  }),
  format: Schema.optional(SessionV1.Format),
  system: Schema.optional(Schema.String),
  variant: Schema.optional(Schema.String),
  temperature: Schema.optional(Schema.Finite).annotate({
    description: "Per-session sampling temperature override (unset = provider/agent default)",
  }),
  topP: Schema.optional(Schema.Finite).annotate({
    description: "Per-session top_p override (unset = provider/agent default)",
  }),
  contextOverride: Schema.optional(Schema.Finite).annotate({
    description:
      "Per-turn context-window override (unset = the resolved model's own configured limit.context). Set by tool/task.ts from a sub-agent model override's stored context length (t-lmqe0g).",
  }),
  parts: Schema.Array(
    Schema.Union([
      SessionV1.TextPartInput,
      SessionV1.FilePartInput,
      SessionV1.AgentPartInput,
      SessionV1.SubtaskPartInput,
    ]).annotate({ discriminator: "type" }),
  ),
})
export type PromptInput = Schema.Schema.Type<typeof PromptInput>

export class LoopInput extends Schema.Class<LoopInput>("SessionPrompt.LoopInput")({
  sessionID: SessionID,
}) {}

export const ShellInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
  agent: Schema.String,
  model: Schema.optional(ModelRef),
  command: Schema.String,
})
export type ShellInput = Schema.Schema.Type<typeof ShellInput>

export const CommandInput = Schema.Struct({
  messageID: Schema.optional(MessageID),
  sessionID: SessionID,
  agent: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  arguments: Schema.String,
  command: Schema.String,
  variant: Schema.optional(Schema.String),
  // Inlined (no identifier annotation) to keep the original SDK output — the
  // PromptInput call site below references FilePartInput by ref via the
  // Schema export in message-v2.ts.
  parts: Schema.optional(
    Schema.Array(
      Schema.Union([
        Schema.Struct({
          id: Schema.optional(PartID),
          type: Schema.Literal("file"),
          mime: Schema.String,
          filename: Schema.optional(Schema.String),
          url: Schema.String,
          source: Schema.optional(SessionV1.FilePartSource),
        }),
      ]).annotate({ discriminator: "type" }),
    ),
  ),
})
export type CommandInput = Schema.Schema.Type<typeof CommandInput>

/** @internal Exported for testing */
export function createStructuredOutputTool(input: {
  schema: Record<string, any>
  onSuccess: (output: unknown) => void
}): AITool {
  // Remove $schema property if present (not needed for tool input)
  const { $schema: _, ...toolSchema } = input.schema

  return tool({
    description: STRUCTURED_OUTPUT_DESCRIPTION,
    inputSchema: jsonSchema(toolSchema as JSONSchema7),
    async execute(args) {
      // AI SDK validates args against inputSchema before calling execute()
      input.onSuccess(args)
      return {
        output: "Structured output captured successfully.",
        title: "Structured Output",
        metadata: { valid: true },
      }
    },
    toModelOutput({ output }) {
      return {
        type: "text",
        value: output.output,
      }
    },
  })
}
const bashRegex = /!`([^`]+)`/g
// Match [Image N] as single token, quoted strings, or non-space sequences
const argsRegex = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi
const placeholderRegex = /\$(\d+)/g
const quoteTrimRegex = /^["']|["']$/g

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [
    Interject.node, // origami_change
    SessionStatus.node,
    Session.node,
    Agent.node,
    FlockRouting.node,
    Provider.node,
    SessionProcessor.node,
    SessionCompaction.node,
    Plugin.node,
    Command.node,
    Config.node,
    Todo.node,
    Permission.node,
    FSUtil.node,
    MCP.node,
    LSP.node,
    ToolRegistry.node,
    ToolSearch.node,
    Truncate.node,
    Image.node,
    CrossSpawnSpawner.node,
    Instruction.node,
    SessionRunState.node,
    SessionRevert.node,
    SessionSummary.node,
    SystemPrompt.node,
    LLM.node,
    EventV2Bridge.node,
    RuntimeFlags.node,
    Database.node,
  ],
})

export * as SessionPrompt from "./prompt"
