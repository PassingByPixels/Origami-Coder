/**
 * Which session a provider request belongs to, read back off the request itself.
 *
 * The AI SDK builds its client ONCE per provider (`resolveSDK` caches on the
 * resolved options hash), so the `fetch` wrapper that takes the concurrency
 * permit has no closure over the step that is running. The only per-request
 * channel that reaches it is the request's own headers: `session/llm.ts` passes
 * `prepared.headers` to `streamText`, and `session/llm/request.ts` already puts
 * the session identity there (`X-Session-Id`, and `x-parent-session-id` for a
 * sub-agent step) for endpoint session affinity.
 *
 * Reading them back here is therefore a read of something already on the wire —
 * nothing new is sent, and nothing is stripped. The native runtime does not need
 * this: it is handed the identity directly (`native-runtime.ts gatedFetch`).
 *
 * A request with no session header at all (a call that did not come from a
 * session step) is UNKNOWN: it gets no priority and no queue notice, rather than
 * being treated as a parent and allowed to jump the queue.
 */

export const SESSION_HEADER = "x-session-id"
export const PARENT_SESSION_HEADER = "x-parent-session-id"

export type RequestIdentity = {
  readonly sessionID?: string
  readonly parentSessionID?: string
}

/**
 * Header lookup over the three shapes a `fetch` init can carry — `Headers`, an
 * array of pairs, or a plain record — all matched case-insensitively, because
 * the name the request was built with is not the name it is stored under
 * (`X-Session-Id` in request.ts, lowercase on a `Headers` object).
 */
function header(headers: unknown, name: string): string | undefined {
  if (!headers) return undefined
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    const value = headers.get(name)
    return value === null || value === "" ? undefined : value
  }
  const entries: Array<[string, unknown]> = Array.isArray(headers)
    ? (headers as Array<[string, unknown]>)
    : typeof headers === "object"
      ? Object.entries(headers as Record<string, unknown>)
      : []
  for (const entry of entries) {
    if (!entry || typeof entry[0] !== "string") continue
    if (entry[0].toLowerCase() !== name) continue
    if (typeof entry[1] !== "string" || entry[1] === "") continue
    return entry[1]
  }
  return undefined
}

/** The identity of the request `init` describes; empty when it carries none. */
export function read(init: unknown): RequestIdentity {
  const headers = init && typeof init === "object" ? (init as { headers?: unknown }).headers : undefined
  const sessionID = header(headers, SESSION_HEADER)
  if (!sessionID) return {}
  const parentSessionID = header(headers, PARENT_SESSION_HEADER)
  return parentSessionID ? { sessionID, parentSessionID } : { sessionID }
}

export * as ProviderRequestIdentity from "./request-identity"
