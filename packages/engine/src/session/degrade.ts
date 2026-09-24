import { SessionV1 } from "@origami/core/v1/session"
import type { Err } from "./retry"

/**
 * Knob rejection: an endpoint refusing one request field rather than failing.
 *
 * The engine derives some request fields from the model name, which holds for
 * hosted vendor APIs but not for a self-hosted endpoint. When the guess is wrong
 * the endpoint names the field, and retrying the identical request cannot change
 * that — so drop the field, retry once, and remember it for the session. The
 * store is process-local: a cache surviving a restart would have to be keyed on
 * something that moves when the server does (vLLM's `system_fingerprint`).
 */

export type Knob = {
  /**
   * Every spelling this knob can carry in the flat request-options record.
   * `ProviderTransform` writes camelCase; snake_case exists because a variant
   * body can carry the wire name directly and unknown keys are spread verbatim.
   */
  readonly keys: readonly string[]
  /** What the user is told was dropped. */
  readonly label: string
  /** Matches an error message that names this knob. */
  readonly names: RegExp
}

/**
 * Only knobs the engine synthesises on the user's behalf and can drop on its own.
 * Each is a standalone scalar with no interlock, so dropping it leaves a valid
 * request. `reasoningSummary`/`include` are deliberately absent — they are set
 * and cleared together, so dropping one alone would be inconsistent.
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
  {
    // Derived from the model FAMILY (transform.ts promptCacheRetention), so a
    // sibling model in a listed family that does not take extended retention
    // refuses it; dropping it leaves an ordinary in-memory cached prefix.
    keys: ["promptCacheRetention", "prompt_cache_retention"],
    label: "prompt cache retention",
    names: /prompt[\s_-]?cache[\s_-]?retention/i,
  },
]

/**
 * A message has to read as a rejection before any knob name in it counts: a
 * server can mention a field in prose without refusing it.
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
  // Exactly one: a message naming two knobs does not say which was refused.
  return hits.length === 1 ? hits[0] : undefined
}

/**
 * The knob this error rejects, or undefined for anything else. No HTTP status
 * means no rejection to read; an unparseable error takes the ordinary retry path.
 */
export function detect(error: Err): Knob | undefined {
  const data = apiError(error)?.data
  if (!data || data.statusCode === undefined || data.statusCode < 400) return undefined
  return scan(data.message) ?? scan(data.responseBody)
}

/**
 * How many sessions keep a rejection set. A long-lived server opens a session per
 * sub-agent, so the map is bounded; oldest write is evicted first.
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
 * Called where the options record is assembled, so the drop survives a fresh
 * `prepare` on the retry and on every later turn of the session.
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
