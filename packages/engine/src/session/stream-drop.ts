import { SessionV1 } from "@origami/core/v1/session"
import { LLMError } from "@origami/llm"
import { isRecord } from "@/util/record"
import type { Err } from "./retry"

/**
 * Stream drop: the provider stream dying AFTER the request succeeded.
 *
 * The AI SDK retries `doStream` — the call that opens the stream — and nothing
 * else. Once headers land, every later failure is forwarded as a `fullStream`
 * part of type `error`, so the raw value reaches `MessageV2.fromError` with no
 * HTTP status, no headers and no `APICallError` wrapper, and
 * `@ai-sdk/openai-compatible` flattens such a frame to a BARE STRING that
 * matches none of `SessionRetry.retryable`'s branches. Hence this family's own
 * classifier. It is transient by construction — the request was accepted, the
 * transport failed — so re-sending the identical request is the only sound
 * repair; see `DISCARD-AND-REDO` below.
 */

/** Marker written into `APIError.metadata.code`, so the retry policy can tell a
 *  dropped stream from a rate limit without re-parsing the message. */
export const CODE = "stream_drop"

/**
 * DISCARD-AND-REDO, not continue-from-partial.
 *
 * `session/prompt.ts` builds `streamInput.messages` ONCE per step and hands the
 * same array to `handle.process`, so `Effect.retry` re-sends a byte-identical
 * request. The engine has no continuation mechanism: resuming from the partial
 * text would mean synthesising an assistant prefix or a "continue" user turn,
 * which is banned. The partial parts already persisted are LEFT IN PLACE — a
 * tool part can record a side effect that really happened — with the retry
 * notice written between the two.
 */

/**
 * Attempts spent on a dropped stream, and the pause between them. Tighter than
 * `SessionRetry.RETRY_LIMIT_DEFAULT` (8) because a dropped stream was accepted,
 * processed and BILLED, so every redo bills it again. The backoff is short
 * because nothing is asking us to wait: a rate limit names a wait, a severed
 * socket does not.
 */
export const LIMIT_DEFAULT = 3
export const DELAY_BASE = 500
export const DELAY_MAX = 4000

export function limit() {
  const raw = Number.parseInt(process.env["ORIGAMI_STREAM_DROP_RETRY_LIMIT"] ?? "", 10)
  if (Number.isInteger(raw) && raw >= 0) return raw
  return LIMIT_DEFAULT
}

/** `attempt` is 1-based, matching `SessionRetry.delay`. */
export function delay(attempt: number) {
  return Math.min(DELAY_BASE * Math.pow(2, Math.max(0, attempt - 1)), DELAY_MAX)
}

/**
 * A stream that ran out of events without ever naming a finish reason, AND left
 * nothing behind worth keeping. The two runtimes spell the same silence
 * differently: `@origami/llm`'s OpenAI Chat protocol emits its finish lifecycle
 * only `if (reason)`, leaving `finish` unset, while the AI SDK path maps the
 * missing reason to the literal `"unknown"`.
 *
 * That alone does NOT decide the repair. `session/processor.ts` splits on a
 * second fact — whether the attempt committed prose. Prose plus an unreadable
 * reason is a finished generation with a mangled label, so the turn is kept and
 * the loop continues (bounded by `UNKNOWN_CONTINUE_LIMIT`); only the silent case
 * reaches this error. Carried as a `code` so no provider sentence can collide.
 */
export const NO_FINISH_CODE = "stream_ended_early"

export function endedEarly() {
  return Object.assign(new Error("The provider stream ended with no finish reason."), { code: NO_FINISH_CODE })
}

/**
 * A stream that DID name a finish reason - "stop" - and left NOTHING on the
 * message: no prose, no tool call. The shape is OpenAI's Responses API, which
 * can end a response `completed` carrying only a `reasoning` output item;
 * `@ai-sdk/openai` maps that to "stop", so `session/processor.ts` sets
 * `terminal`, the silent-stream guard above (which tests `!terminal`) never sees
 * it, and the loop's exit gate ends the turn mid-task on an empty message.
 *
 * A separate code from `NO_FINISH_CODE` because the notice quotes the sentence:
 * this stream was not silent about how it ended, it was empty.
 */
export const EMPTY_REPLY_CODE = "stream_empty_reply"

export function emptyReply() {
  return Object.assign(new Error("The provider ended the reply with no content."), { code: EMPTY_REPLY_CODE })
}

/**
 * The bar for membership is one question: could re-sending the identical
 * request plausibly succeed? A refusal, a bad key, a context overflow and a
 * content filter all answer no, and none of them may match these patterns.
 */
const PATTERNS: readonly { readonly re: RegExp; readonly why: string }[] = [
  {
    // A gateway cutting a stream that emitted no token for too long; reaches us
    // as the bare string "Upstream idle timeout exceeded".
    re: /\bidle timeout\b/i,
    why: "gateway idle timeout",
  },
  {
    // Node/undici socket faults, once a provider package has flattened them to
    // text and `MessageV2.fromError`'s top-level `code` check no longer reaches
    // them.
    re: /\b(?:econnreset|econnaborted|etimedout|epipe|socket hang ?up|connection reset)\b/i,
    why: "socket reset",
  },
  {
    // The body ended before the response did. `ERR_STREAM_PREMATURE_CLOSE` is
    // Node's own name for it; `UND_ERR_*` are undici's.
    re: /\b(?:premature close|err_stream_premature_close|und_err_socket|und_err_body_timeout|und_err_headers_timeout)\b/i,
    why: "premature close",
  },
  {
    // undici raises `TypeError: terminated` (and `fetch failed`) when a body is
    // cut mid-flight. Anchored to the whole message: "terminated" as one word
    // inside a longer sentence is not evidence of a transport fault.
    re: /^\s*(?:terminated|fetch failed)\s*$/i,
    why: "connection terminated",
  },
  {
    // Gateway 5xx phrasing. `@ai-sdk/openai-compatible` throws the status code
    // away for mid-stream error frames, so the words are the only signal left —
    // `SessionRetry.retryable`'s `statusCode >= 500` branch never sees these.
    re: /\b(?:bad gateway|gateway time-?out|service unavailable|internal server error|upstream (?:error|connect error|request timeout))\b/i,
    why: "upstream server error",
  },
  {
    // Capacity arriving as a stream frame instead of a status.
    re: /\b(?:overloaded|temporarily unavailable|no instances available)\b/i,
    why: "provider overloaded",
  },
  {
    // The engine's own code, written by `endedEarly` above. `text()` reads an
    // Error's `code`, so this arrives the same way a socket fault's code does.
    re: new RegExp(`\\b${NO_FINISH_CODE}\\b`),
    why: "no finish reason",
  },
  {
    // Same route in, written by `emptyReply` above.
    re: new RegExp(`\\b${EMPTY_REPLY_CODE}\\b`),
    why: "empty reply",
  },
]

/** How deep to follow `cause` chains. undici nests the real code one level in. */
const DEPTH = 3

function text(value: unknown, depth = 0): string {
  if (depth > DEPTH || value === null || value === undefined) return ""
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (value instanceof Error) {
    return [value.name, value.message, text((value as { code?: unknown }).code, depth + 1), text(value.cause, depth + 1)]
      .filter(Boolean)
      .join(" ")
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>
    return [record["message"], record["code"], record["type"], record["reason"], record["cause"]]
      .map((entry) => text(entry, depth + 1))
      .filter(Boolean)
      .join(" ")
  }
  return ""
}

/**
 * The transient reason this value names, or undefined for anything else.
 *
 * Conservative on purpose, in both directions. A value it cannot read falls
 * through to the existing unknown-error path unchanged, and an aborted turn is
 * never a drop — undici reports a cancelled body with the same vocabulary a
 * severed one uses.
 */
export function detect(value: unknown, aborted?: boolean): { message: string; why: string } | undefined {
  if (aborted) return undefined
  const native = nativeDrop(value)
  if (native) return native
  const flat = text(value)
  if (!flat) return undefined
  const hit = PATTERNS.find((pattern) => pattern.re.test(flat))
  if (!hit) return undefined
  // The message the user reads is the provider's own sentence when there is
  // one, never the JSON blob `NamedError.Unknown` used to produce.
  const message = typeof value === "string" ? value : messageOf(value) || flat
  return { message: message.trim(), why: hit.why }
}

/**
 * The same family as seen through `@origami/llm`, which keeps the fault typed
 * instead of flattening it to a sentence. A transport failure is a drop by
 * definition, and so is a body that stopped being readable mid-flight. An error
 * FRAME the protocol could not decode is a drop only when the frame text — not
 * the wrapper — matches a pattern above.
 */
function nativeDrop(value: unknown): { message: string; why: string } | undefined {
  if (!(value instanceof LLMError)) return undefined
  const reason = value.reason
  if (reason._tag === "Transport")
    return { message: reason.message.trim(), why: reason.kind ? `transport ${reason.kind}` : "transport failure" }
  if (reason._tag !== "InvalidProviderOutput") return undefined
  if (reason.message.startsWith("Failed to read ")) return { message: reason.message.trim(), why: "premature close" }
  const raw = reason.raw ?? ""
  const hit = PATTERNS.find((pattern) => pattern.re.test(raw))
  if (!hit) return undefined
  return { message: (frameMessage(raw) ?? raw).trim(), why: hit.why }
}

/** The provider's own sentence inside an `{"error":{"message":…}}` frame. */
function frameMessage(raw: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) return undefined
    const error = parsed["error"]
    if (typeof error === "string") return error
    if (isRecord(error)) {
      const message = error["message"]
      return typeof message === "string" ? message : undefined
    }
    return undefined
  } catch {
    return undefined
  }
}

function messageOf(value: unknown): string {
  if (value instanceof Error) return value.message
  if (value && typeof value === "object") {
    const own = (value as Record<string, unknown>)["message"]
    if (typeof own === "string") return own
  }
  return ""
}

/** True when an already-classified error is a member of this family. */
export function isDrop(error: Err): boolean {
  if (!SessionV1.APIError.isInstance(error)) return false
  return error.data.metadata?.["code"] === CODE
}

/**
 * The notice the user reads in place of a dead turn, as DATA rather than a
 * sentence.
 *
 * It used to be a text part, so it landed in the agent's bubble under the
 * agent's name, and a run of drops ran together in one blob. A client cannot
 * take that apart again without matching the wording, and the wording is half
 * provider prose: one real detail reads `fetch failed (ECONNRESET)`, brackets
 * and all. So the engine names the facts and the client draws the card.
 *
 * `detail` is the provider's own sentence, kept verbatim so the transcript
 * records which gateway said what. `terminal` is the difference between a card
 * that says "retrying" and one that says the ladder is spent and offers Retry.
 */
export interface Notice {
  /** `retrying` = another attempt follows. `stopped` = the ladder is spent. */
  kind: "retrying" | "stopped"
  /** 1-based, the attempt that JUST failed. */
  attempt: number
  /** How many attempts this family spends in total - `limit()` when it ran. */
  max: number
  detail: string
  terminal: boolean
}

/**
 * Where a notice rides: the key on the notice part's `metadata`, and the same
 * key on the ACP `_meta` of the empty `agent_message_chunk` that carries it to
 * a client (`acp/event.ts`). One string, so the part a session stores and the
 * frame a client reads name the notice identically.
 *
 * MIRRORED in `packages/vscode/src/acpStreamDrop.ts`. That package cannot
 * resolve this one, so the mirror is a literal there with this note beside it.
 */
export const NOTICE_KEY = "origami_stream_drop"

export function notice(kind: Notice["kind"], attempt: number, detail: string): Notice {
  return { kind, attempt, max: limit(), detail, terminal: kind === "stopped" }
}

/** The notice carried by a part's (or an ACP frame's) metadata, or undefined.
 *  Fail-closed: a half-written rider draws nothing rather than a card with
 *  `undefined` in it. */
export function readNotice(metadata: unknown): Notice | undefined {
  if (!isRecord(metadata)) return undefined
  const raw = metadata[NOTICE_KEY]
  if (!isRecord(raw)) return undefined
  const kind = raw["kind"]
  const attempt = raw["attempt"]
  const max = raw["max"]
  const detail = raw["detail"]
  if (kind !== "retrying" && kind !== "stopped") return undefined
  if (!Number.isInteger(attempt) || !Number.isInteger(max)) return undefined
  if (typeof detail !== "string") return undefined
  return { kind, attempt: attempt as number, max: max as number, detail, terminal: kind === "stopped" }
}

/**
 * The one-line prose form of a notice, for surfaces with no card to draw: the
 * non-interactive `origami run` (plain and `--format json`). The chat never
 * sees this string; it draws the structured notice.
 */
export function describeNotice(n: Notice): string {
  return n.kind === "retrying"
    ? `Stream dropped (${n.detail}) - retrying, attempt ${n.attempt} of ${n.max}.`
    : `Stream dropped (${n.detail}) - stopped after ${n.attempt} of ${n.max} attempts.`
}

export * as SessionStreamDrop from "./stream-drop"
