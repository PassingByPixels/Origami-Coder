import { SessionV1 } from "@origami/core/v1/session"
import type { Err } from "./retry"

/**
 * Tier rejection: an endpoint that takes `reasoning_effort` but not THIS value.
 *
 * Distinct from the knob rejection in `degrade.ts`: there the FIELD is unknown
 * and the repair is to stop sending it; here the field is fine and the VALUE is
 * off this model's list, so the repair is one step down the ladder. The tier is
 * remembered for that MODEL across restarts (provider/effort-demotion.ts), not
 * for the session.
 *
 * Deliberately inert on: a message naming the field but not the tier that was
 * sent (that is `degrade.ts`); a tier without the field (`high` and `none` are
 * ordinary words any enum can carry); any status other than 400 or 422 (a 5xx
 * or a 429 is not a judgement about the request).
 */

/** Same wording gate as `degrade.ts`: a server can mention a field without refusing it. */
const REJECTION =
  /\b(?:invalid|unsupported|unrecognized|unrecognised|unknown|unexpected|not supported|not allowed|must be one of|is not one of|does not support)\b/i

/** Every spelling the effort field carries in an error: `reasoning.effort`
 *  (Responses API), `reasoning_effort` (Chat Completions), and AI SDK camelCase. */
const EFFORT_FIELD = /reasoning[._\s-]?effort/i

/** The tier as a whole word, so `high` does not match inside `xhigh`. */
function namesTier(text: string, tier: string): boolean {
  return new RegExp("(?:^|[^a-z0-9_-])" + tier + "(?:[^a-z0-9_-]|$)", "i").test(text)
}

/**
 * Whether this error is THIS tier being refused.
 *
 * `sent` is the tier the request actually carried (from `LLMRequestPrep.prepare`
 * through `sent()` below), never guessed from the message: a reply that lists
 * the tiers it WILL take names several, and reading one of those as the refusal
 * would demote a tier the endpoint just said it accepts.
 */
export function isRejected(error: Err, sent: string | undefined): boolean {
  if (!sent) return false
  if (!SessionV1.APIError.isInstance(error)) return false
  const data = error.data
  if (data.statusCode !== 400 && data.statusCode !== 422) return false
  const text = [data.message, data.responseBody].filter((part): part is string => typeof part === "string").join("\n")
  if (!text) return false
  return REJECTION.test(text) && EFFORT_FIELD.test(text) && namesTier(text, sent)
}

/** How many sessions each store keeps, matching `SessionDegrade.LIMIT`: one
 *  long-lived server opens a session per sub-agent, so the maps stay bounded. */
export const LIMIT = 128

function remember<T>(store: Map<string, Map<string, T>>, sessionID: string, modelKey: string, value: T): void {
  const current = store.get(sessionID) ?? new Map<string, T>()
  current.set(modelKey, value)
  // Re-insert so iteration order is write order, then trim the front.
  store.delete(sessionID)
  store.set(sessionID, current)
  for (const key of store.keys()) {
    if (store.size <= LIMIT) break
    store.delete(key)
  }
}

const lastSent = new Map<string, Map<string, string>>()
const demotedOnce = new Map<string, Map<string, true>>()

/** The model key both stores use, and the one `ProviderEffortDemotion` splits apart. */
export function key(providerID: string, modelID: string): string {
  return providerID + "/" + modelID
}

/** Record the tier the outgoing request carries. Called from `prepare`, the only
 *  code that resolves it. */
export function sent(sessionID: string, modelKey: string, tier: string | undefined): void {
  if (!tier) return
  remember(lastSent, sessionID, modelKey, tier)
}

/** The tier the last request for this session and model carried. */
export function lastTier(sessionID: string, modelKey: string): string | undefined {
  return lastSent.get(sessionID)?.get(modelKey)
}

/** Remember this session has spent its one demotion for this model, so a second
 *  refusal surfaces the endpoint's own words instead of walking the ladder down. */
export function record(sessionID: string, modelKey: string): void {
  remember(demotedOnce, sessionID, modelKey, true)
}

export function isRecorded(sessionID: string, modelKey: string): boolean {
  return demotedOnce.get(sessionID)?.get(modelKey) === true
}

/** The one line the user reads in the chat when a tier is demoted. */
export function notice(from: string, to: string): string {
  return `${from} reasoning effort is not supported by this model - retried at ${to}.`
}

/** The chat closed (t-w2u5vf). A reopened chat starts from what a restarted
 *  engine knows: the demoted tier per model is in `ProviderEffortDemotion`. */
export function evict(sessionID: string): void {
  lastSent.delete(sessionID)
  demotedOnce.delete(sessionID)
}

/** Test seam - both stores are module state, so a test must be able to empty them. */
export function reset(): void {
  lastSent.clear()
  demotedOnce.clear()
}

export * as SessionEffortTier from "./effort-tier"
