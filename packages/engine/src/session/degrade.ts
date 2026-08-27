import { SessionV1 } from "@origami/core/v1/session"
import type { Err } from "./retry"

/**
 * Knob rejection: an endpoint refusing ONE request field rather than failing.
 *
 * The engine derives some request fields from the model NAME (provider/transform.ts
 * picks reasoning tiers by regex on the model id). That holds for hosted vendor
 * APIs, where the vendor owns both the name and the published tiers. It does not
 * hold for a self-hosted endpoint, where the id is whatever `--served-model-name`
 * was given and the accepted vocabulary lives inside the container.
 *
 * When the guess is wrong the endpoint answers with a status and a message that
 * NAMES the field — the highest-quality capability signal available. Retrying the
 * identical request cannot make that message change, so the retry loop turns a
 * one-line problem into a silent hang. Instead: drop the field, retry once, and
 * remember the rejection for the rest of the session.
 *
 * The store is process-local and session-scoped by design. A capability cache
 * that survives a restart has to be keyed on something that moves when the
 * server changes (vLLM returns `system_fingerprint` for exactly this), and that
 * is a separate piece of work — see the capability-discovery arc.
 */

export type Knob = {
  /**
   * Every spelling this knob can carry in the flat request-options record that
   * `LLMRequestPrep.prepare` assembles. camelCase is what `ProviderTransform`
   * writes and what the AI SDK renames on the wire (`@ai-sdk/openai-compatible`
   * maps `reasoningEffort` -> `reasoning_effort`); the snake_case spelling
   * exists because a variant body can carry the wire name directly, and unknown
   * keys are spread into the body verbatim.
   */
  readonly keys: readonly string[]
  /** What the user is told was dropped. */
  readonly label: string
  /** Matches an error message that names THIS knob. */
  readonly names: RegExp
}

/**
 * Only knobs the engine SYNTHESISES on the user's behalf and can drop on its
 * own are listed. Each is a standalone scalar with no interlock: dropping it
 * leaves a valid request that the endpoint answers with its own default.
 *
 * `reasoningSummary`/`include` are deliberately absent — they are set and
 * cleared together (see the Azure branch in session/llm/request.ts), so
 * dropping one of them alone would leave an inconsistent request.
 */
export const KNOBS: readonly Knob[] = [
  {
    keys: ["reasoningEffort", "reasoning_effort"],
    label: "reasoning effort",
    names: /reasoning[\s_-]?effort/i,
  },
  {
    keys: ["textVerbosity", "verbosity"],
    label: "text verbosity",
    names: /\b(?:text[\s_-]?)?verbosity\b/i,
  },
]

/**
 * A message has to READ as a rejection before any knob name in it counts. A
 * server can mention a field in prose ("reasoning effort budget exhausted")
 * without refusing it, and misreading that as a knob rejection would drop a
 * field the endpoint was happy with.
 */
const REJECTION = /\b(?:invalid|unsupported|unrecognized|unrecognised|unknown|unexpected|not supported|not allowed|must be one of|is not one of)\b/i

function apiError(error: Err) {
  return SessionV1.APIError.isInstance(error) ? error : undefined
}

/** 401/403 — a credential problem. No number of retries fixes it. */
export function isAuth(error: Err): boolean {
  const status = apiError(error)?.data.statusCode
  return status === 401 || status === 403
}

function scan(text: string | undefined): Knob | undefined {
  if (!text || !REJECTION.test(text)) return undefined
  const hits = KNOBS.filter((knob) => knob.names.test(text))
  // Exactly one. A message naming two knobs does not say which one was
  // refused, and guessing would drop a field for no evidence.
  return hits.length === 1 ? hits[0] : undefined
}

/**
 * The knob this error rejects, or undefined when the error is anything else.
 *
 * Conservative on purpose: no HTTP status means no rejection to read, and an
 * error this cannot parse falls through to the ordinary retry path — the
 * classifier must never invent a new failure mode for errors it does not
 * understand.
 */
export function detect(error: Err): Knob | undefined {
  const data = apiError(error)?.data
  if (!data || data.statusCode === undefined || data.statusCode < 400) return undefined
  return scan(data.message) ?? scan(data.responseBody)
}

/**
 * How many sessions keep a rejection set. Each holds a couple of short strings,
 * but a long-lived server opens a session per sub-agent, so the map is bounded
 * rather than left to grow with the process. Oldest write is evicted first.
 */
export const LIMIT = 128

const rejected = new Map<string, Set<string>>()

/** Remember that this endpoint refused this knob, for the rest of the session. */
export function record(sessionID: string, knob: Knob): void {
  const current = rejected.get(sessionID) ?? new Set<string>()
  current.add(knob.label)
  // Re-insert so iteration order is write order, then trim the front.
  rejected.delete(sessionID)
  rejected.set(sessionID, current)
  for (const key of rejected.keys()) {
    if (rejected.size <= LIMIT) break
    rejected.delete(key)
  }
}

/** True once this session has already dropped the knob and been refused again. */
export function isRecorded(sessionID: string, knob: Knob): boolean {
  return rejected.get(sessionID)?.has(knob.label) === true
}

/**
 * The request options with every knob this session has had refused removed.
 * Called where the options record is assembled, so the DROP survives a fresh
 * `prepare` on the retry and on every later turn of the same session.
 */
export function strip(sessionID: string, options: Record<string, any>): Record<string, any> {
  const labels = rejected.get(sessionID)
  if (!labels?.size) return options
  const drop = KNOBS.filter((knob) => labels.has(knob.label)).flatMap((knob) => knob.keys)
  if (!drop.some((key) => key in options)) return options
  return Object.fromEntries(Object.entries(options).filter(([key]) => !drop.includes(key)))
}

/** The one-line notice the user reads in the chat when a knob is dropped. */
export function notice(knob: Knob): string {
  return `${knob.label} not supported by this endpoint — used the default.`
}

/** Test seam — the store is module state, so a test must be able to empty it. */
export function reset(): void {
  rejected.clear()
}

export * as SessionDegrade from "./degrade"
