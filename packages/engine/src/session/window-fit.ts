import type { ModelMessage, Tool } from "ai"
import { SessionPromptCapture } from "./prompt-capture"

/**
 * Does a request fit the model's context window? (t-tc20mj)
 *
 * A window counts the prompt AND the reply: vLLM, llama.cpp and Anthropic
 * refuse a request whose prompt plus `max_tokens` exceeds it. A model that
 * declares no output limit is sent a flat 32k (`ProviderTransform.maxOutputTokens`),
 * so a self-hosted session that is within 32k of its window is refused on every
 * request, compaction's own included. This module holds the arithmetic: an
 * estimate of the outgoing prompt, the clamp, and a per-session correction
 * learned from the usage the endpoint reports.
 */

/** A flat token count for one image or document part. Its bytes are not text
 *  the tokenizer reads, so counting its base64 would make one screenshot look
 *  like a full window. */
const MEDIA_TOKENS = 1_600

/** What the estimate can be wrong by after calibration: chat-template tokens,
 *  a plugin transform, the text added since the last measured request. */
export function margin(context: number) {
  return Math.max(256, Math.ceil(context / 50))
}

/**
 * The least reply worth sending a request for. Below it the request is not
 * sent at all and the step asks for compaction, because a reply cut to a few
 * hundred tokens ends mid-thought and still bills the whole prompt.
 */
export function floor(context: number) {
  return Math.min(4_096, Math.floor(context / 8))
}

function mediaHolder(holder: unknown) {
  if (!holder || typeof holder !== "object") return false
  const type = (holder as { type?: unknown }).type
  return type === "file" || type === "image" || type === "media"
}

/** One outgoing message in tokens: chars/4 over its serialised form, media flat. */
export function measure(message: ModelMessage): number {
  let media = 0
  const text =
    JSON.stringify(message, function (this: unknown, key, value) {
      if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
        media++
        return ""
      }
      if ((key === "data" || key === "image") && mediaHolder(this)) {
        media++
        return ""
      }
      return value
    }) ?? ""
  return SessionPromptCapture.estimateTokens(text.length) + media * MEDIA_TOKENS
}

/** The whole prompt: every message, any system text sent outside them, and the tool block. */
export function estimate(input: {
  readonly messages: readonly ModelMessage[]
  readonly system?: readonly string[]
  readonly tools?: Record<string, Tool>
}): number {
  const messages = input.messages.reduce((sum, message) => sum + measure(message), 0)
  const system = (input.system ?? []).reduce((sum, text) => sum + text.length, 0)
  const tools = input.tools
    ? SessionPromptCapture.toolEntries(input.tools).reduce(
        (sum, tool) => sum + tool.name.length + tool.descriptionChars + tool.schemaBytes,
        0,
      )
    : 0
  return messages + SessionPromptCapture.estimateTokens(system + tools)
}

export type Fit = {
  /** What to send as `max_tokens`. Never more than was asked for. */
  readonly maxOutputTokens: number
  /** True when no reply of at least the floor fits: do not send, compact. */
  readonly short: boolean
}

/**
 * Clamp `requested` to what the window has left after the prompt. With no
 * known window (`context` 0) the request is left alone: there is nothing to
 * clamp against, and the provider's refusal still routes to compaction.
 */
export function fit(input: { readonly context: number; readonly estimate: number; readonly requested: number }): Fit {
  if (input.context <= 0) return { maxOutputTokens: input.requested, short: false }
  const room = input.context - input.estimate - margin(input.context)
  if (room < Math.min(floor(input.context), input.requested)) return { maxOutputTokens: input.requested, short: true }
  return { maxOutputTokens: Math.min(input.requested, room), short: false }
}

// ---------------------------------------------------------------------------
// Calibration. chars/4 is a guess about the endpoint's tokenizer; code and JSON
// run nearer 3 characters per token on the models this matters for, and an
// estimate that is a quarter short defeats the clamp on exactly the requests it
// exists for. The endpoint reports the real prompt size on every reply, so each
// session keeps the last ratio of reported to estimated and scales its next
// estimate by it. Only upward, at most double: an estimate that errs high costs
// a slightly smaller max_tokens, one that errs low costs a refused request.
// Process-local and bounded, like the prompt capture.
// ---------------------------------------------------------------------------

const LIMIT = 64
const MAX_RATIO = 2

const pending = new Map<string, number>()
const ratios = new Map<string, number>()

function bounded(map: Map<string, number>, key: string, value: number) {
  map.delete(key)
  map.set(key, value)
  for (const oldest of map.keys()) {
    if (map.size <= LIMIT) break
    map.delete(oldest)
  }
}

/** The estimate of the request this session just sent, for `observe` to compare against. */
export function sent(sessionID: string, estimate: number) {
  if (estimate > 0) bounded(pending, sessionID, estimate)
}

/** The prompt size the endpoint reported for that request. */
export function observe(sessionID: string, reported: number) {
  const estimate = pending.get(sessionID)
  pending.delete(sessionID)
  if (!estimate || !(reported > 0)) return
  bounded(ratios, sessionID, Math.min(MAX_RATIO, Math.max(1, reported / estimate)))
}

export function calibrate(sessionID: string, estimate: number) {
  return Math.ceil(estimate * (ratios.get(sessionID) ?? 1))
}

/** Test hook. */
export function reset() {
  pending.clear()
  ratios.clear()
}

// ---------------------------------------------------------------------------
// Compaction's own request. It is the one request that must fit whatever the
// history is, since it is how the history is made to fit.
// ---------------------------------------------------------------------------

/** The same messages without the model's own reasoning: a summary is written
 *  from what was said and done, and reasoning can be the larger half. */
export function withoutReasoning(messages: readonly ModelMessage[]): ModelMessage[] {
  return messages.flatMap((message): ModelMessage[] => {
    if (message.role !== "assistant" || typeof message.content === "string") return [message]
    const content = message.content.filter((part) => part.type !== "reasoning")
    if (content.length === message.content.length) return [message]
    return content.length ? [{ ...message, content }] : []
  })
}

/**
 * The newest part of `messages` that fits `limit` tokens once `fixed` (the
 * prompt around them) is added, and how many messages were left out.
 *
 * Cuts are made where the array stays a valid conversation: at a user message,
 * or, inside one long turn, before an assistant step, keeping the user message
 * that opened the turn. A tool result is never separated from its call. When
 * not even the last step fits, the smallest valid remainder is returned and the
 * request layer refuses it honestly.
 */
export function newest(input: {
  readonly messages: readonly ModelMessage[]
  readonly limit: number
  readonly fixed: number
  readonly sessionID: string
}): { messages: ModelMessage[]; omitted: number } {
  const sizes = input.messages.map(measure)
  const suffix: number[] = new Array(sizes.length + 1).fill(0)
  for (let i = sizes.length - 1; i >= 0; i--) suffix[i] = suffix[i + 1]! + sizes[i]!
  const fits = (tokens: number) => calibrate(input.sessionID, input.fixed + tokens) <= input.limit

  if (fits(suffix[0]!)) return { messages: [...input.messages], omitted: 0 }
  for (let i = 1; i < input.messages.length; i++) {
    if (input.messages[i]!.role === "user" && fits(suffix[i]!))
      return { messages: input.messages.slice(i), omitted: i }
  }

  const opener = input.messages.findLastIndex((message) => message.role === "user")
  const steps: number[] = []
  for (let i = opener + 2; i < input.messages.length; i++) {
    if (input.messages[i]!.role === "assistant" && input.messages[i - 1]!.role !== "assistant") steps.push(i)
  }
  const head = opener >= 0 ? [input.messages[opener]!] : []
  const headSize = opener >= 0 ? sizes[opener]! : 0
  const cut = steps.find((i) => fits(headSize + suffix[i]!)) ?? steps.at(-1)
  if (cut === undefined) return { messages: input.messages.slice(Math.max(0, opener)), omitted: Math.max(0, opener) }
  return { messages: [...head, ...input.messages.slice(cut)], omitted: cut - head.length }
}

export * as SessionWindowFit from "./window-fit"
