import { SessionV1 } from "@origami/core/v1/session"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import type { Err } from "./retry"

/**
 * Image cap: an endpoint refusing a prompt because it carries too many
 * PICTURES, and naming the number it will take.
 *
 * `ProviderTransform` bounds the growth (see IMAGE_WINDOW_DEFAULT) but cannot
 * know a server cap SMALLER than its own default. Without this, a turn carrying
 * more pictures than the server takes fails, and the next turn re-sends the same
 * ones — a softlock spending the whole retry budget on a payload that cannot be
 * accepted. So: read the number out of the refusal, remember it for the session,
 * and let the window clamp to it. A second refusal at the same number is let out
 * with the provider's own words — the count was not the cause.
 *
 * Process-local, session-scoped, bounded store, as in `session/degrade.ts`.
 */

/** The one sentence this classifier trusts, copied from a live failure. A looser
 *  pattern would clamp a session because a model wrote "at most 4 images" in
 *  prose, so any other phrasing falls through to the ordinary retry path. */
const CAP = /\bat most (\d+) image(?:\(s\)|s)? may be provided\b/i

function apiError(error: Err) {
  return SessionV1.APIError.isInstance(error) ? error : undefined
}

function scan(text: string | undefined): number | undefined {
  if (!text) return undefined
  const match = CAP.exec(text)
  if (!match) return undefined
  const parsed = Number.parseInt(match[1]!, 10)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined
}

/**
 * How many images this endpoint says it takes, or undefined for any other error.
 *
 * No HTTP status is required: unlike a knob rejection, this sentence IS the
 * refusal, and the status varies — the same cap has arrived through a JSON-RPC
 * internal error with no HTTP code of its own.
 */
export function detect(error: Err): number | undefined {
  const data = apiError(error)?.data
  if (!data) return undefined
  return scan(data.message) ?? scan(data.responseBody)
}

/** How many sessions keep a cap, matching `SessionDegrade.LIMIT`: a long-lived
 *  server opens a session per sub-agent. */
export const LIMIT = 128

const caps = new Map<string, number>()

/** Remember that this endpoint takes at most `images` per prompt. */
export function record(sessionID: string, images: number): void {
  const current = caps.get(sessionID)
  // The SMALLEST wins: two lanes behind one endpoint can answer with different
  // caps, and the tighter one is the only one both accept.
  const next = current === undefined ? images : Math.min(current, images)
  caps.delete(sessionID)
  caps.set(sessionID, next)
  for (const key of caps.keys()) {
    if (caps.size <= LIMIT) break
    caps.delete(key)
  }
}

/** True once this session already sends at most `images` and was refused anyway. */
export function isRecorded(sessionID: string, images: number): boolean {
  const current = caps.get(sessionID)
  return current !== undefined && current <= images
}

/** The cap this session has learned, or undefined. */
export function limit(sessionID: string): number | undefined {
  return caps.get(sessionID)
}

/**
 * The model as the message transform should see it for THIS session. Identity
 * unless the clamp actually lowers the declared limit, so the common path
 * allocates nothing.
 */
export function clamp(sessionID: string, model: Provider.Model): Provider.Model {
  const learned = caps.get(sessionID)
  if (learned === undefined) return model
  const declared = model.limit.images ?? ProviderTransform.IMAGE_WINDOW_DEFAULT
  if (declared <= learned) return model
  return { ...model, limit: { ...model.limit, images: learned } }
}

/** The one line the user reads in the chat when the window is clamped. */
export function notice(images: number): string {
  return `This endpoint accepts at most ${images} image${images === 1 ? "" : "s"} per request — older images were replaced with a note. Attach fewer images, or raise the server's image limit.`
}

/** Test seam — the store is module state, so a test must be able to empty it. */
export function reset(): void {
  caps.clear()
}

export * as SessionImageCap from "./image-cap"
