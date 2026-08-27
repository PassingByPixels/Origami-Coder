import { FinishReason, LLMEvent, ProviderMetadata, ToolResultValue } from "@origami/llm"
import { ThinkTags } from "@origami/llm/protocols"
import { Effect, Schema } from "effect"
import { type LogWarningsFunction, type Warning, type streamText } from "ai"
import { errorMessage } from "@/util/error"

/**
 * One line of prose for an AI SDK warning.
 *
 * The SDK's own `formatWarning` is module-private, so the three shapes of
 * `SharedV3Warning` are rendered here. Provider and model are deliberately NOT
 * folded into the string: they travel as their own structured log fields, so a
 * log query can group warnings by model without parsing prose.
 */
export function warningMessage(warning: Warning): string {
  switch (warning.type) {
    case "unsupported":
      return `unsupported feature "${warning.feature}"` + (warning.details ? `: ${warning.details}` : "")
    case "compatibility":
      return `compatibility mode for "${warning.feature}"` + (warning.details ? `: ${warning.details}` : "")
    case "other":
      return warning.message
    default:
      return JSON.stringify(warning)
  }
}

/**
 * Send the AI SDK's own warnings to the engine log.
 *
 * They were being THROWN AWAY. `server/server.ts` and `session/prompt.ts` each
 * set `globalThis.AI_SDK_LOG_WARNINGS = false` at import time, and with good
 * reason: the SDK's default logger is `console.warn`, and the engine speaks a
 * protocol on stdout. But `false` silences the WHOLE channel, and that channel
 * carries the only notice the SDK gives when it discards content from the
 * request it is about to send. A function value keeps stdout clean and keeps
 * the signal.
 *
 * Why per call and not once at import: this module is imported before both
 * `= false` assignments run, so a module-level install would be overwritten by
 * them. Installing from inside a request instead runs after every import, which
 * is what makes the function value win.
 *
 * `fork` carries the CALLING turn's fiber context, so a line lands with that
 * session's instance and loggers. Provider and model come from the SDK's own
 * arguments rather than from the closure, so a line is never wrong about which
 * model warned even when two turns overlap and the later one owns the context.
 *
 * Reading `streamText`'s `result.warnings` instead is not an option: its getter
 * calls `consumeStream()` (ai@6 dist: `get warnings()` -> `this.steps` ->
 * `this.consumeStream()`), which would start draining the stream behind the
 * lazy `fullStream` consumption in llm.ts.
 */
export function installWarningLogger(fork: (effect: Effect.Effect<void>) => void): void {
  const logger: LogWarningsFunction = ({ warnings, provider, model }) => {
    for (const warning of warnings)
      fork(
        Effect.logWarning("provider warning", {
          message: warningMessage(warning),
          provider,
          model,
        }),
      )
  }
  globalThis.AI_SDK_LOG_WARNINGS = logger
}

type Result = Awaited<ReturnType<typeof streamText>>
type AISDKEvent = Result["fullStream"] extends AsyncIterable<infer T> ? T : never

export function adapterState() {
  return {
    step: 0,
    text: 0,
    reasoning: 0,
    currentTextID: undefined as string | undefined,
    currentReasoningID: undefined as string | undefined,
    toolNames: {} as Record<string, string>,
    copilotTotalNanoAiu: undefined as number | undefined,
    // Local OpenAI-compatible servers (vLLM, LM Studio) leak `<think>` markup onto
    // the CONTENT channel instead of `reasoning_content` — including a closer with
    // no opener, which is what put a literal `</think>` into a session title. The
    // scanner state is per-stream and MUST persist across deltas: a tag arrives
    // split (`</thi` + `nk>`) whenever the server flushes mid-token, so per-chunk
    // scanning would both leak the tag and drop text.
    think: ThinkTags.initial(),
    // The reasoning block THIS scanner opened, in its own id namespace.
    //
    // Deliberately NOT `currentReasoningID`: the provider may be streaming a real
    // `reasoning_content` block at the same time, and publish-llm-event.ts dies on
    // a duplicate start ("Duplicate reasoning start") and on a delta before start.
    // Sharing the namespace would turn a mixed-channel model into a dead session.
    thinkBlockID: undefined as string | undefined,
    thinkBlocks: 0,
  }
}

/**
 * Route scanned segments into the event lifecycle, mirroring the native OpenAI
 * Chat adapter's `emitSegment`: a reasoning segment joins (or opens) the scanner's
 * own reasoning block, and a text segment closes that block first so the two never
 * interleave inside one block.
 *
 * Every start/end is emitted exactly once because `thinkBlockID` is the only gate —
 * the consumer treats an unmatched delta or a repeated start as a fatal defect.
 */
function emitSegments(
  state: ReturnType<typeof adapterState>,
  segments: ReadonlyArray<ThinkTags.Segment>,
  textID: string,
  providerMetadata: ProviderMetadata | undefined,
): LLMEvent[] {
  const events: LLMEvent[] = []
  for (const segment of segments) {
    if (segment.kind === "reasoning") {
      if (state.thinkBlockID === undefined) {
        state.thinkBlockID = `think-${state.thinkBlocks++}`
        events.push(LLMEvent.reasoningStart({ id: state.thinkBlockID }))
      }
      events.push(LLMEvent.reasoningDelta({ id: state.thinkBlockID, text: segment.text }))
      continue
    }
    if (state.thinkBlockID !== undefined) {
      events.push(LLMEvent.reasoningEnd({ id: state.thinkBlockID }))
      state.thinkBlockID = undefined
    }
    events.push(LLMEvent.textDelta({ id: textID, text: segment.text, providerMetadata }))
  }
  return events
}

/**
 * Close the scanner down for a text block: release whatever is still HELD, then
 * close any reasoning block it opened.
 *
 * The flush is the load-bearing half. A trailing `<` is held back so the next
 * chunk can prove whether it was the head of a tag; if the stream ends there and
 * nothing drains it, the reply silently loses its last characters — a worse bug
 * than the stray tag this exists to remove.
 */
function closeScan(state: ReturnType<typeof adapterState>, textID: string): LLMEvent[] {
  const tail = ThinkTags.flush(state.think)
  const events = tail ? emitSegments(state, [tail], textID, undefined) : []
  state.think = ThinkTags.initial()
  if (state.thinkBlockID !== undefined) {
    events.push(LLMEvent.reasoningEnd({ id: state.thinkBlockID }))
    state.thinkBlockID = undefined
  }
  return events
}

/**
 * Release whatever the scanner is still holding, wherever the stream stopped.
 *
 * `closeScan` is reachable only through the events the adapter is handed, so a
 * stream that ends by failing, by aborting, or by simply running out of events
 * never reaches it and the held characters die with the scanner. This is the
 * seam the stream itself calls on those exits (see `llm.ts`).
 *
 * Idempotent by construction: `closeScan` resets the scanner, so the drain that
 * runs on a normal end and the one that runs on a failure cannot emit the same
 * characters twice. It emits nothing when no text block is open — a delta into a
 * block that was never started is a fatal defect downstream, so a fabricated id
 * would be worse than the truncation it avoided. `pending` is only ever non-empty
 * after a text delta, and every text delta sets `currentTextID`, so that branch
 * is a guard rather than a policy.
 */
export function drain(state: ReturnType<typeof adapterState>): LLMEvent[] {
  if (state.currentTextID === undefined) return []
  return closeScan(state, state.currentTextID)
}

function finishReason(value: string | undefined): FinishReason {
  return Schema.is(FinishReason)(value) ? value : "unknown"
}

function providerMetadata(value: unknown): ProviderMetadata | undefined {
  if (value == null) return undefined
  return Schema.is(ProviderMetadata)(value) ? value : undefined
}

// Temporary AI SDK bridge: Copilot billing survives only in raw provider chunks here.
// Move this extraction into @origami/llm when Copilot is handled by the native runtime.
function copilotTotalNanoAiu(value: unknown) {
  if (!value || typeof value !== "object") return
  const raw = value as Record<string, unknown>
  const response =
    raw.response && typeof raw.response === "object" ? (raw.response as Record<string, unknown>) : undefined
  const usage = raw.copilot_usage ?? response?.copilot_usage
  if (!usage || typeof usage !== "object") return
  const total = (usage as Record<string, unknown>).total_nano_aiu
  if (typeof total !== "number" || !Number.isFinite(total) || total < 0) return
  return total
}

function usage(value: unknown) {
  if (!value || typeof value !== "object") return undefined
  const item = value as {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
    reasoningTokens?: number
    cachedInputTokens?: number
    inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number }
    outputTokenDetails?: { reasoningTokens?: number }
  }
  const entries = Object.entries({
    inputTokens: item.inputTokens,
    outputTokens: item.outputTokens,
    totalTokens: item.totalTokens,
    reasoningTokens: item.outputTokenDetails?.reasoningTokens ?? item.reasoningTokens,
    cacheReadInputTokens: item.inputTokenDetails?.cacheReadTokens ?? item.cachedInputTokens,
    cacheWriteInputTokens: item.inputTokenDetails?.cacheWriteTokens,
  }).filter((entry) => entry[1] !== undefined)
  return entries.length === 0 ? undefined : Object.fromEntries(entries)
}

function currentTextID(state: ReturnType<typeof adapterState>, id: string | undefined) {
  state.currentTextID = id ?? state.currentTextID ?? `text-${state.text++}`
  return state.currentTextID
}

function currentReasoningID(state: ReturnType<typeof adapterState>, id: string | undefined) {
  state.currentReasoningID = id ?? state.currentReasoningID ?? `reasoning-${state.reasoning++}`
  return state.currentReasoningID
}

export function toLLMEvents(
  state: ReturnType<typeof adapterState>,
  event: AISDKEvent,
): Effect.Effect<ReadonlyArray<LLMEvent>, unknown> {
  switch (event.type) {
    case "start":
      return Effect.succeed([])

    case "start-step":
      return Effect.succeed([LLMEvent.stepStart({ index: state.step })])

    case "finish-step":
      return Effect.sync(() => {
        const original = providerMetadata(event.providerMetadata)
        const metadata =
          state.copilotTotalNanoAiu === undefined
            ? original
            : {
                ...original,
                copilot: {
                  ...original?.copilot,
                  totalNanoAiu: state.copilotTotalNanoAiu,
                },
              }
        state.copilotTotalNanoAiu = undefined
        return [
          LLMEvent.stepFinish({
            index: state.step++,
            reason: finishReason(event.finishReason),
            usage: usage(event.usage),
            providerMetadata: metadata,
          }),
        ]
      })

    case "finish":
      return Effect.sync(() => {
        // A stream that finished WITHOUT text-end still has a text block open, so
        // held characters have somewhere legal to go. Only then — emitting a delta
        // into a block that was never started is a fatal defect downstream, so a
        // fabricated id would be worse than the truncation it tried to avoid.
        const events: LLMEvent[] = state.currentTextID !== undefined ? closeScan(state, state.currentTextID) : []
        events.push(
          LLMEvent.finish({
            reason: finishReason(event.finishReason),
            usage: usage(event.totalUsage),
            providerMetadata: "providerMetadata" in event ? providerMetadata(event.providerMetadata) : undefined,
          }),
        )
        // Reset so the adapter can be reused for a follow-up stream without leaking
        // counters or block IDs. adapterState() is the single source of truth for shape.
        Object.assign(state, adapterState())
        return events
      })

    case "text-start":
      return Effect.sync(() => {
        state.currentTextID = currentTextID(state, event.id)
        return [
          LLMEvent.textStart({
            id: state.currentTextID,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "text-delta":
      return Effect.sync(() => {
        const id = currentTextID(state, event.id)
        const metadata = providerMetadata(event.providerMetadata)
        // Hot path, every delta of every turn: a chunk with nothing held over and
        // no `<` in it cannot contain or begin a tag, so it skips the scanner's
        // concat/allocate entirely. Safe as long as both tags start with `<`,
        // which is the whole grammar think-tags.ts watches for.
        if (!state.think.pending && !event.text.includes("<"))
          return [LLMEvent.textDelta({ id, text: event.text, providerMetadata: metadata })]
        const scanned = ThinkTags.scan(state.think, event.text)
        state.think = scanned.state
        return emitSegments(state, scanned.segments, id, metadata)
      })

    case "text-end":
      return Effect.sync(() => {
        const id = currentTextID(state, event.id)
        // Drain BEFORE the block closes — after textEnd there is no block left to
        // put held characters into.
        const events = closeScan(state, id)
        state.currentTextID = undefined
        events.push(
          LLMEvent.textEnd({
            id,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        )
        return events
      })

    case "reasoning-start":
      return Effect.sync(() => {
        state.currentReasoningID = currentReasoningID(state, event.id)
        return [
          LLMEvent.reasoningStart({
            id: state.currentReasoningID,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "reasoning-delta":
      return Effect.succeed([
        LLMEvent.reasoningDelta({
          id: currentReasoningID(state, event.id),
          text: event.text,
          providerMetadata: providerMetadata(event.providerMetadata),
        }),
      ])

    case "reasoning-end":
      return Effect.sync(() => {
        const id = currentReasoningID(state, event.id)
        state.currentReasoningID = undefined
        return [
          LLMEvent.reasoningEnd({
            id,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "tool-input-start":
      return Effect.sync(() => {
        state.toolNames[event.id] = event.toolName
        return [
          LLMEvent.toolInputStart({
            id: event.id,
            name: event.toolName,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "tool-input-delta":
      return Effect.succeed([
        LLMEvent.toolInputDelta({
          id: event.id,
          name: state.toolNames[event.id] ?? "unknown",
          text: event.delta ?? "",
        }),
      ])

    case "tool-input-end":
      return Effect.succeed([
        LLMEvent.toolInputEnd({
          id: event.id,
          name: state.toolNames[event.id] ?? "unknown",
          providerMetadata: providerMetadata(event.providerMetadata),
        }),
      ])

    case "tool-call":
      return Effect.sync(() => {
        state.toolNames[event.toolCallId] = event.toolName
        return [
          LLMEvent.toolCall({
            id: event.toolCallId,
            name: event.toolName,
            input: event.input,
            providerExecuted: "providerExecuted" in event ? event.providerExecuted : undefined,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "tool-result":
      return Effect.sync(() => {
        const name = state.toolNames[event.toolCallId] ?? "unknown"
        delete state.toolNames[event.toolCallId]
        return [
          LLMEvent.toolResult({
            id: event.toolCallId,
            name,
            result: ToolResultValue.make(event.output),
            providerExecuted: "providerExecuted" in event ? event.providerExecuted : undefined,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "tool-error":
      return Effect.sync(() => {
        const name = state.toolNames[event.toolCallId] ?? ("toolName" in event ? event.toolName : "unknown")
        delete state.toolNames[event.toolCallId]
        return [
          LLMEvent.toolError({
            id: event.toolCallId,
            name,
            message: errorMessage(event.error),
            error: event.error,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "error":
      return Effect.fail(event.error)

    case "abort":
      // An aborted stream never reaches `text-end` or `finish`, so this is the
      // last chance to put held characters into the block that is still open.
      return Effect.sync(() => drain(state))

    case "source":
    case "file":
    case "tool-output-denied":
    case "tool-approval-request":
      return Effect.succeed([])

    case "raw":
      return Effect.sync(() => {
        state.copilotTotalNanoAiu = copilotTotalNanoAiu(event.rawValue) ?? state.copilotTotalNanoAiu
        return []
      })

    default: {
      const _exhaustive: never = event
      void _exhaustive
      return Effect.succeed([])
    }
  }
}

export * as LLMAISDK from "./ai-sdk"
