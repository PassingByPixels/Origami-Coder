import { LayerNode } from "@origami/core/effect/layer-node"
import { SessionV1 } from "@origami/core/v1/session"
import { ConfigV1 } from "@origami/core/v1/config/config"
import { Session } from "./session"
import { SessionID, MessageID, PartID } from "./schema"
import { Provider } from "@/provider/provider"
import { MessageV2 } from "./message-v2"
import { Token } from "@/util/token"
import { SessionProcessor } from "./processor"
import { Agent } from "@/agent/agent"
import { FlockHealth } from "@/flock/health"
import { FlockRouting } from "@/flock/routing"
import { Plugin } from "@/plugin"
import { Config } from "@/config/config"
import { NotFoundError } from "@/storage/storage"

import { Effect, Layer, Context, Option } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { overflowCheck, preserveRecentBudget, fixedFloor } from "./overflow"
import { SessionCompactionPrompt } from "./compaction-prompt"
import { SessionCacheState } from "./cache-state"
import { SessionCacheWarm } from "./cache-warm"
import { SessionPromptCapture } from "./prompt-capture"
import { SessionWindowFit } from "./window-fit"
import { ProviderTransform } from "@/provider/transform"
import type { ModelMessage } from "ai"
import { serviceUse } from "@origami/core/effect/service-use"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { ProviderV2 } from "@origami/core/provider"
import { ModelV2 } from "@origami/core/model"
import { SessionCompactionEvent } from "@origami/schema/session-compaction-event"

export const Event = SessionCompactionEvent

export const PRUNE_MINIMUM = 20_000
export const PRUNE_PROTECT = 40_000
const TOOL_OUTPUT_MAX_CHARS = 2_000
/** The harder cut, used only when the compaction request would not fit the window. */
const TOOL_OUTPUT_TIGHT_CHARS = 400
const PRUNE_PROTECTED_TOOLS = ["skill"]
const DEFAULT_TAIL_TURNS = 2

/**
 * The share of the pre-compaction context an auto compaction has to buy back
 * before its summary is allowed to take effect.
 *
 * A compaction is not free: it costs a whole generation and adds a summary to the
 * context it is meant to shrink, and can end up growing it. So the result is
 * measured before it is kept, on the engine's own estimator on both sides —
 * comparing an estimate against a provider-reported count would decide a 10%
 * question with two different rulers.
 */
export const MIN_COMPACTION_GAIN = 0.1

type Turn = {
  start: number
  end: number
  id: MessageID
}

type Tail = {
  start: number
  id: MessageID
}

type CompletedCompaction = {
  userIndex: number
  assistantIndex: number
  summary: string | undefined
}

/**
 * Marks a text part the engine wrote onto a summary message, so `summaryText`
 * can leave it out: folding an engine line about why the turn stopped into the
 * summary would send it back as "previous summary" on the next compaction.
 */
const NOTICE_KEY = "origami_compaction_stop"

/**
 * The one line the user reads when compaction finished and the turn stops there
 * anyway. It names the switch that did it, because that switch is a plugin
 * setting the user (or their plugin author) can change.
 */
const STOPPED_AFTER_COMPACTION =
  "The conversation was compacted. Work stops here because a plugin disabled compaction autocontinue - send a message to carry on."

function summaryText(message: SessionV1.WithParts) {
  const text = message.parts
    .filter((part): part is SessionV1.TextPart => part.type === "text" && part.metadata?.[NOTICE_KEY] === undefined)
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim()
  return text || undefined
}

function completedCompactions(messages: SessionV1.WithParts[]) {
  const users = new Map<MessageID, number>()
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.info.role !== "user") continue
    if (!msg.parts.some((part) => part.type === "compaction")) continue
    users.set(msg.info.id, i)
  }

  return messages.flatMap((msg, assistantIndex): CompletedCompaction[] => {
    if (msg.info.role !== "assistant") return []
    if (!msg.info.summary || !msg.info.finish || msg.info.error) return []
    const userIndex = users.get(msg.info.parentID)
    if (userIndex === undefined) return []
    return [{ userIndex, assistantIndex, summary: summaryText(msg) }]
  })
}

function turns(messages: SessionV1.WithParts[]) {
  const result: Turn[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.info.role !== "user") continue
    if (msg.parts.some((part) => part.type === "compaction")) continue
    result.push({
      start: i,
      end: messages.length,
      id: msg.info.id,
    })
  }
  for (let i = 0; i < result.length - 1; i++) {
    result[i].end = result[i + 1].start
  }
  return result
}

function splitTurn(input: {
  messages: SessionV1.WithParts[]
  turn: Turn
  model: Provider.Model
  budget: number
  estimate: (input: { messages: SessionV1.WithParts[]; model: Provider.Model }) => Effect.Effect<number>
}) {
  return Effect.gen(function* () {
    if (input.budget <= 0) return undefined
    if (input.turn.end - input.turn.start <= 1) return undefined
    for (let start = input.turn.start + 1; start < input.turn.end; start++) {
      const size = yield* input.estimate({
        messages: input.messages.slice(start, input.turn.end),
        model: input.model,
      })
      if (size > input.budget) continue
      return {
        start,
        id: input.messages[start]!.info.id,
      } satisfies Tail
    }
    return undefined
  })
}

export interface Interface {
  readonly isOverflow: (input: {
    tokens: SessionV1.Assistant["tokens"]
    model: Provider.Model
    /** The session whose per-chat threshold override, if any, should govern
     *  instead of the cfg-derived reserve. Optional so an existing caller keeps
     *  its cfg-only behaviour. */
    sessionID?: SessionID
  }) => Effect.Effect<boolean>
  readonly prune: (input: { sessionID: SessionID }) => Effect.Effect<void>
  readonly process: (input: {
    parentID: MessageID
    messages: SessionV1.WithParts[]
    sessionID: SessionID
    auto: boolean
    overflow?: boolean
  }) => Effect.Effect<"continue" | "stop">
  readonly create: (input: {
    sessionID: SessionID
    agent: string
    model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
    auto: boolean
    overflow?: boolean
  }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@origami/SessionCompaction") {}

export const use = serviceUse(Service)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const session = yield* Session.Service
    const agents = yield* Agent.Service
    const plugin = yield* Plugin.Service
    const processors = yield* SessionProcessor.Service
    const provider = yield* Provider.Service
    const flock = yield* FlockRouting.Service
    const events = yield* EventV2Bridge.Service
    const flags = yield* RuntimeFlags.Service

    const isOverflow = Effect.fn("SessionCompaction.isOverflow")(function* (input: {
      tokens: SessionV1.Assistant["tokens"]
      model: Provider.Model
      sessionID?: SessionID
    }) {
      // Row read is best-effort: a session that vanished mid-check falls back to
      // the cfg-only behaviour rather than failing the overflow check itself.
      const row = input.sessionID
        ? yield* session.get(input.sessionID).pipe(Effect.catch(() => Effect.succeed(undefined)))
        : undefined
      const check = overflowCheck({
        cfg: yield* config.get(),
        tokens: input.tokens,
        model: input.model,
        outputTokenMax: flags.outputTokenMax,
        thresholdOverride: row ? Session.compactionThreshold(row) : undefined,
        floor: fixedFloor(input.sessionID),
      })
      // The window is full and compaction is not the answer: what is left is
      // mostly the fixed block, which no summary can remove. Logged once with the
      // numbers, because the alternative is a silent non-event.
      if (check.gated)
        yield* Effect.logInfo("compaction held back: too little history to remove", {
          "session.id": input.sessionID,
          count: check.count,
          floor: check.floor,
          history: check.history,
          required: check.required,
          usable: check.usable,
        })
      return check.overflow
    })

    const estimate = Effect.fn("SessionCompaction.estimate")(function* (input: {
      messages: SessionV1.WithParts[]
      model: Provider.Model
    }) {
      const msgs = yield* MessageV2.toModelMessagesEffect(input.messages, input.model)
      return Token.estimate(JSON.stringify(msgs))
    })

    const select = Effect.fn("SessionCompaction.select")(function* (input: {
      messages: SessionV1.WithParts[]
      cfg: ConfigV1.Info
      model: Provider.Model
    }) {
      const limit = input.cfg.compaction?.tail_turns ?? DEFAULT_TAIL_TURNS
      if (limit <= 0) return { head: input.messages, tail_start_id: undefined }
      const budget = preserveRecentBudget({ cfg: input.cfg, model: input.model })
      const all = turns(input.messages)
      if (!all.length) return { head: input.messages, tail_start_id: undefined }
      const recent = all.slice(-limit)
      const sizes = yield* Effect.forEach(
        recent,
        (turn) =>
          estimate({
            messages: input.messages.slice(turn.start, turn.end),
            model: input.model,
          }),
        { concurrency: 1 },
      )

      let total = 0
      let keep: Tail | undefined
      for (let i = recent.length - 1; i >= 0; i--) {
        const turn = recent[i]!
        const size = sizes[i]
        if (total + size <= budget) {
          total += size
          keep = { start: turn.start, id: turn.id }
          continue
        }
        const remaining = budget - total
        const split = yield* splitTurn({
          messages: input.messages,
          turn,
          model: input.model,
          budget: remaining,
          estimate,
        })
        if (split) keep = split
        else if (!keep) {
          yield* Effect.logInfo("tail fallback", { budget, size, total })
        }
        break
      }

      if (!keep || keep.start === 0) return { head: input.messages, tail_start_id: undefined }
      return {
        head: input.messages.slice(0, keep.start),
        tail_start_id: keep.id,
      }
    })

    // goes backwards through parts until there are PRUNE_PROTECT tokens worth of tool
    // calls, then erases output of older tool calls to free context space
    const prune = Effect.fn("SessionCompaction.prune")(function* (input: { sessionID: SessionID }) {
      const cfg = yield* config.get()
      if (!cfg.compaction?.prune) return
      yield* Effect.logInfo("pruning")

      const msgs = yield* session
        .messages({ sessionID: input.sessionID })
        .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)))
      if (!msgs) return

      let total = 0
      let pruned = 0
      const toPrune: SessionV1.ToolPart[] = []
      let turns = 0

      loop: for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
        const msg = msgs[msgIndex]
        if (msg.info.role === "user") turns++
        if (turns < 2) continue
        if (msg.info.role === "assistant" && msg.info.summary) break loop
        for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
          const part = msg.parts[partIndex]
          if (part.type !== "tool") continue
          if (part.state.status !== "completed") continue
          if (PRUNE_PROTECTED_TOOLS.includes(part.tool)) continue
          if (part.state.time.compacted) break loop
          const estimate = Token.estimate(part.state.output)
          total += estimate
          if (total <= PRUNE_PROTECT) continue
          pruned += estimate
          toPrune.push(part)
        }
      }

      yield* Effect.logInfo("found", { pruned, total })
      if (pruned > PRUNE_MINIMUM) {
        for (const part of toPrune) {
          if (part.state.status === "completed") {
            part.state.time.compacted = Date.now()
            yield* session.updatePart(part)
          }
        }
        yield* Effect.logInfo("pruned", { count: toPrune.length })
      }
    })

    /**
     * The engine's own line in the chat, on the summary message, written the way
     * `session/processor.ts`'s `notice` writes one: create the part, publish the
     * delta, then persist the text. The delta is what puts it in front of the
     * user — a whole-part text update is dropped by the ACP bridge, so without it
     * the line would surface only on a later history replay.
     *
     * `summaryText` skips parts carrying `NOTICE_KEY`, so an engine line never
     * becomes summary prose the next compaction quotes back as history.
     */
    const notice = Effect.fn("SessionCompaction.notice")(function* (message: SessionV1.Assistant, text: string) {
      const start = Date.now()
      const part: SessionV1.TextPart = {
        id: PartID.ascending(),
        messageID: message.id,
        sessionID: message.sessionID,
        type: "text",
        text: "",
        time: { start },
        metadata: { [NOTICE_KEY]: "autocontinue" },
      }
      yield* session.updatePart(part)
      yield* session.updatePartDelta({
        sessionID: part.sessionID,
        messageID: part.messageID,
        partID: part.id,
        field: "text",
        delta: text,
      })
      yield* session.updatePart({ ...part, text, time: { start, end: Date.now() } })
    })

    const processCompaction = Effect.fn("SessionCompaction.process")(function* (input: {
      parentID: MessageID
      messages: SessionV1.WithParts[]
      sessionID: SessionID
      auto: boolean
      overflow?: boolean
    }) {
      const parent = input.messages.findLast((m) => m.info.id === input.parentID)
      if (!parent || parent.info.role !== "user") {
        throw new Error(`Compaction parent must be a user message: ${input.parentID}`)
      }
      const userMessage = parent.info
      const compactionPart = parent.parts.find((part): part is SessionV1.CompactionPart => part.type === "compaction")

      let messages = input.messages
      let replay:
        | {
            info: SessionV1.User
            parts: SessionV1.Part[]
          }
        | undefined
      if (input.overflow) {
        const idx = input.messages.findIndex((m) => m.info.id === input.parentID)
        for (let i = idx - 1; i >= 0; i--) {
          const msg = input.messages[i]
          if (msg.info.role === "user" && !msg.parts.some((p) => p.type === "compaction")) {
            replay = { info: msg.info, parts: msg.parts }
            messages = input.messages.slice(0, i)
            break
          }
        }
        const hasContent =
          replay && messages.some((m) => m.info.role === "user" && !m.parts.some((p) => p.type === "compaction"))
        if (!hasContent) {
          replay = undefined
          messages = input.messages
        }
      }

      const agent = yield* agents.get("compaction")
      const cfg = yield* config.get()
      const history = compactionPart && messages.at(-1)?.info.id === input.parentID ? messages.slice(0, -1) : messages
      const prior = completedCompactions(history)
      const hidden = new Set(prior.flatMap((item) => [item.userIndex, item.assistantIndex]))
      const previousSummary = prior.at(-1)?.summary
      // What this compaction can see, and therefore what it can remove. Hoisted
      // out of `attempt` because the working-set extraction and the gain
      // measurement both read it, and neither depends on which model runs.
      const visible = history.filter((_, index) => !hidden.has(index))
      // Allow plugins to inject context or replace compaction prompt.
      const compacting = yield* plugin.trigger(
        "experimental.session.compacting",
        { sessionID: input.sessionID },
        { context: [], prompt: undefined },
      )
      const nextPrompt =
        compacting.prompt ??
        SessionCompactionPrompt.build({ previousSummary, context: compacting.context, messages: visible })

      // origami_change-start (t-tc20mj): compaction's own request must fit the
      // window, since it is how the history is made to fit. The selected head is
      // otherwise unbounded, and in the field it overflowed the same way the turn
      // did. When it does not fit with room for the summary, what is sent shrinks
      // in steps, least loss first: the model's reasoning, then tool results cut
      // harder, then the oldest messages.
      const fitted = Effect.fnUntraced(function* (msgs: SessionV1.WithParts[], model: Provider.Model) {
        const convert = (toolOutputMaxChars: number) =>
          MessageV2.toModelMessagesEffect(msgs, model, { stripMedia: true, toolOutputMaxChars })
        const full = yield* convert(TOOL_OUTPUT_MAX_CHARS)
        const context = model.limit.context
        if (context <= 0) return { messages: full, omitted: 0 }
        // Room for the summary: what the request will ask for, and at most a
        // quarter of the window, as for an unknown output limit (overflow.ts).
        const reserve = Math.min(
          ProviderTransform.maxOutputTokens(model, flags.outputTokenMax),
          Math.floor(context / 4),
        )
        const limit = context - SessionWindowFit.margin(context) - reserve
        const fixed = SessionWindowFit.estimate({
          messages: [],
          system: [agent.prompt ?? "", userMessage.system ?? "", nextPrompt],
        })
        const fits = (messages: ModelMessage[]) =>
          SessionWindowFit.calibrate(input.sessionID, fixed + SessionWindowFit.estimate({ messages })) <= limit
        if (fits(full)) return { messages: full, omitted: 0 }
        const lean = SessionWindowFit.withoutReasoning(full)
        const result = fits(lean)
          ? { messages: lean, omitted: 0 }
          : SessionWindowFit.newest({
              messages: SessionWindowFit.withoutReasoning(yield* convert(TOOL_OUTPUT_TIGHT_CHARS)),
              limit,
              fixed,
              sessionID: input.sessionID,
            })
        yield* Effect.logInfo("compaction request shrunk to fit the window", {
          "session.id": input.sessionID,
          context,
          limit,
          omitted: result.omitted,
        })
        return result
      })
      // origami_change-end

      // Everything from the selection down is per-attempt on purpose: how much
      // history fits, and how it is rendered, are facts about the model that
      // runs it, so a walk to another binding has to work them out again.
      const attempt = Effect.fnUntraced(function* (model: Provider.Model) {
        const selected = yield* select({
          messages: visible,
          cfg,
          model,
        })
        // t-u54x6w: the copy keeps a plugin that rewrites messages away from
        // `visible`, which the gain check below measures again. No plugin with
        // that hook: nothing can write, and the copy of the whole history
        // (screenshots included) was a block of the JS thread for nothing.
        const rewriter = (yield* plugin.list()).some((hook) => hook["experimental.chat.messages.transform"])
        const msgs = rewriter ? structuredClone(selected.head) : selected.head
        yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })
        const { messages: modelMessages, omitted } = yield* fitted(msgs, model)
        const prompt = omitted
          ? `${nextPrompt}\n\nThe oldest ${omitted} messages of this conversation are not shown above: they did not fit the model's context window.`
          : nextPrompt
        const ctx = yield* InstanceState.context
        const msg: SessionV1.Assistant = {
          id: MessageID.ascending(),
          role: "assistant",
          parentID: input.parentID,
          sessionID: input.sessionID,
          mode: "compaction",
          agent: "compaction",
          variant: userMessage.model.variant,
          summary: true,
          path: {
            cwd: ctx.directory,
            root: ctx.worktree,
          },
          cost: 0,
          tokens: {
            output: 0,
            input: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          modelID: model.id,
          providerID: model.providerID,
          time: {
            created: Date.now(),
          },
        }
        yield* session.updateMessage(msg)
        const processor = yield* processors.create({
          assistantMessage: msg,
          sessionID: input.sessionID,
          model,
        })
        const result = yield* processor.process({
          user: userMessage,
          agent,
          sessionID: input.sessionID,
          tools: {},
          system: [],
          messages: [
            ...modelMessages,
            {
              role: "user",
              content: [{ type: "text", text: prompt }],
            },
          ],
          model,
        })
        return { selected, processor, result, model }
      })

      /** Whether an attempt's own message already holds summary text. */
      const wrote = Effect.fnUntraced(function* (messageID: MessageID) {
        const found = yield* session
          .findMessage(input.sessionID, (item) => item.info.id === messageID)
          .pipe(Effect.catchCause(() => Effect.succeed(Option.none<SessionV1.WithParts>())))
        return Option.match(found, { onNone: () => false, onSome: (item) => FlockHealth.produced(item.parts) })
      })

      /** The summary prose an attempt actually wrote, engine notices excluded. */
      const summaryOf = Effect.fnUntraced(function* (messageID: MessageID) {
        const found = yield* session
          .findMessage(input.sessionID, (item) => item.info.id === messageID)
          .pipe(Effect.catchCause(() => Effect.succeed(Option.none<SessionV1.WithParts>())))
        return Option.match(found, { onNone: () => undefined, onSome: (item) => summaryText(item) })
      })

      // Compaction is cheap background work, so it rides the subagent binding like
      // the other hidden generations. It is also a streamed one — it writes a real
      // assistant message — so a binding that failed after producing summary text
      // is never walked past, and a chain that ran and failed keeps its own failed
      // message rather than billing a second full-history generation.
      const candidates = yield* flock.resolveSubagents()
      const walked = candidates?.length
        ? yield* FlockHealth.walk({
            candidates,
            provider,
            attempt: (model) =>
              attempt(model).pipe(
                Effect.flatMap((run) => {
                  const error = run.processor.message.error
                  // "compact" is the engine's own overflow escape hatch, not
                  // sickness: this history does not fit this window, and the next
                  // binding would be handed exactly the same history.
                  if (!error || run.result === "compact") return Effect.succeed(FlockHealth.ok(run))
                  return wrote(run.processor.message.id).pipe(
                    Effect.map((hadOutput) => FlockHealth.failed(error, hadOutput, run)),
                  )
                }),
              ),
          })
        : undefined

      const run = yield* Effect.gen(function* () {
        if (walked?.kind === "ok") return walked.value
        // A failure the chain could not survive keeps the attempt that produced
        // it: the message it left behind already carries the error.
        if (walked?.kind === "failed") return walked.failure.value
        return yield* attempt(
          agent.model
            ? yield* provider.getModel(agent.model.providerID, agent.model.modelID).pipe(Effect.orDie)
            : yield* provider.getModel(userMessage.model.providerID, userMessage.model.modelID).pipe(Effect.orDie),
        )
      })
      // Only reachable if a failing attempt handed nothing back at all. Stopping
      // is the honest answer; re-running would bill the whole history again.
      if (!run) return "stop"
      const { selected, processor, result, model } = run

      if (result === "compact") {
        processor.message.error = new SessionV1.ContextOverflowError({
          message: replay
            ? "Conversation history too large to compact - exceeds model context limit"
            : "Session too large to compact - context exceeds model limit even after stripping media",
        }).toObject()
        processor.message.finish = "error"
        yield* session.updateMessage(processor.message)
        return "stop"
      }

      // The result is measured before it is kept, and only for auto compaction: a
      // manual /compact is the user asking for a summary and the engine does not
      // overrule that. Only once summary text exists — with nothing written there
      // is nothing to weigh.
      if (input.auto) {
        const summary = yield* summaryOf(processor.message.id)
        if (summary) {
          const floor = fixedFloor(input.sessionID)
          const tailStart = selected.tail_start_id
            ? visible.findIndex((item) => item.info.id === selected.tail_start_id)
            : -1
          const tail = tailStart >= 0 ? visible.slice(tailStart) : []
          const before = floor + (yield* estimate({ messages: visible, model }))
          const after =
            floor + Token.estimate(summary) + (tail.length ? yield* estimate({ messages: tail, model }) : 0)
          if (after > before * (1 - MIN_COMPACTION_GAIN)) {
            // The summary stays in the transcript as a failed message on purpose:
            // `completedCompactions` here and `filterCompacted` in message-v2.ts
            // both skip a summary carrying an error, so the marker never takes
            // effect and no message is deleted.
            yield* Effect.logInfo("compaction discarded: it would not shrink the context", {
              "session.id": input.sessionID,
              before,
              after,
              floor,
            })
            processor.message.error = new SessionV1.ContextOverflowError({
              message: `Compaction skipped - the summary would not shrink the context (${before} -> ${after} tokens, floor ${floor})`,
            }).toObject()
            processor.message.finish = "error"
            yield* session.updateMessage(processor.message)
            return "stop"
          }
        }
      }

      if (compactionPart && selected.tail_start_id && compactionPart.tail_start_id !== selected.tail_start_id) {
        yield* session.updatePart({
          ...compactionPart,
          tail_start_id: selected.tail_start_id,
        })
      }

      // Whether the turn goes on after this compaction. The autocontinue hook can
      // switch it off, and when it does the caller has to be told: the summary on
      // its own satisfies `session/prompt.ts`'s exit gate, so the turn would
      // otherwise end silently with the user looking at a summary and no reply.
      let continues = true

      if (result === "continue" && input.auto) {
        if (replay) {
          const original = replay.info
          const replayMsg = yield* session.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: input.sessionID,
            time: { created: Date.now() },
            agent: original.agent,
            model: original.model,
            format: original.format,
            tools: original.tools,
            system: original.system,
          })
          for (const part of replay.parts) {
            if (part.type === "compaction") continue
            const replayPart =
              part.type === "file" && MessageV2.isMedia(part.mime)
                ? { type: "text" as const, text: `[Attached ${part.mime}: ${part.filename ?? "file"}]` }
                : part
            yield* session.updatePart({
              ...replayPart,
              id: PartID.ascending(),
              messageID: replayMsg.id,
              sessionID: input.sessionID,
            })
          }
        }

        if (!replay) {
          const info = yield* provider.getProvider(userMessage.model.providerID)
          const autocontinue = (yield* plugin.trigger(
            "experimental.compaction.autocontinue",
            {
              sessionID: input.sessionID,
              agent: userMessage.agent,
              model: yield* provider
                .getModel(userMessage.model.providerID, userMessage.model.modelID)
                .pipe(Effect.orDie),
              provider: {
                source: info.source,
                info,
                options: info.options,
              },
              message: userMessage,
              overflow: input.overflow === true,
            },
            { enabled: true },
          )).enabled
          if (!autocontinue) {
            continues = false
            yield* notice(processor.message, STOPPED_AFTER_COMPACTION)
          } else {
            const continueMsg = yield* session.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: input.sessionID,
              time: { created: Date.now() },
              agent: userMessage.agent,
              model: userMessage.model,
            })
            const text =
              (input.overflow
                ? "The previous request exceeded the provider's size limit due to large media attachments. The conversation was compacted and media files were removed from context. If the user was asking about attached images or files, explain that the attachments were too large to process and suggest they try again with smaller or fewer files.\n\n"
                : "") +
              "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed."
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: continueMsg.id,
              sessionID: input.sessionID,
              type: "text",
              // Internal marker for auto-compaction followups so provider plugins
              // can distinguish them from manual post-compaction user prompts.
              // This is not a stable plugin contract and may change or disappear.
              metadata: { compaction_continue: true },
              synthetic: true,
              text,
              time: {
                start: Date.now(),
                end: Date.now(),
              },
            })
          }
        }
      }

      if (processor.message.error) return "stop"
      if (result === "continue") {
        yield* events.publish(Event.Compacted, { sessionID: input.sessionID })
      }
      // The compaction itself succeeded - the event above says so - and the work
      // still stops here. Both facts are true and both are reported.
      if (!continues) return "stop"
      return result
    })

    const create = Effect.fn("SessionCompaction.create")(function* (input: {
      sessionID: SessionID
      agent: string
      model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
      auto: boolean
      overflow?: boolean
    }) {
      // A compaction rewrites the history, so the cached prefix is dead. Cancel
      // any pending warm and keep this session cold until a real request has
      // rebuilt the prefix (session/cache-warm.ts). Here rather than at the two
      // call sites because this is the ONE entry both auto and /compact take.
      SessionCacheWarm.compacted(input.sessionID)
      // And the next step-finish must be able to SAY so: a compaction rewrites
      // the history, so the miss that follows has one cause and it is this one,
      // not whatever the message diff reports (t-rylleg).
      SessionPromptCapture.markCompacted(input.sessionID)
      // And the badge that says so on the composer (t-rylyhm): the same fact,
      // reported rather than only acted on.
      SessionCacheState.compacted(input.sessionID)
      const msg = yield* session.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        model: input.model,
        sessionID: input.sessionID,
        agent: input.agent,
        time: { created: Date.now() },
      })
      yield* session.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: msg.sessionID,
        type: "compaction",
        auto: input.auto,
        overflow: input.overflow,
      })
    })

    return Service.of({
      isOverflow,
      prune,
      process: processCompaction,
      create,
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [
    Config.node,
    Session.node,
    Agent.node,
    FlockRouting.node,
    Plugin.node,
    SessionProcessor.node,
    Provider.node,
    EventV2Bridge.node,
    RuntimeFlags.node,
  ],
})

export * as SessionCompaction from "./compaction"
