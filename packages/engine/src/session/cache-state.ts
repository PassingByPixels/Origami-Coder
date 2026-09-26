/**
 * `origami/cacheState`: whether this session's prompt prefix is still in the
 * provider's cache, pushed to the client as it changes (t-rylyhm).
 *
 * WHY THE ENGINE OWNS THIS. The client cannot know it. The one fact that says
 * "warm" is the cache-read token count the provider returned on the last REAL
 * request, and that number never leaves the engine as a state - only as a token
 * pill. So the badge on the composer reads what the engine measured, and the
 * engine says when it stops being true.
 *
 * WHAT WARM MEANS, exactly, because the cheap answers are all wrong:
 *
 *   - NOT "the cache warmer is armed". The warmer arms on every Anthropic-family
 *     request and fires at 80% of the TTL; arming says nothing about whether the
 *     provider kept anything. Measured over 20 days of log it fired ONCE, and
 *     the fleet's real traffic is never warmed at all.
 *   - NOT "a warm went out". A warm that was sent and returned nothing from the
 *     cache is a miss like any other.
 *   - Warm is: the last real step-finish on this session reported `cache.read
 *     > 0`, OR a warm request came back with `cache.read > 0`; AND the window
 *     the provider publishes has not elapsed.
 *
 * THREE STATES, and "unmeasured" is not a polite "cold". A provider that
 * reports no cache tokens at all (LM Studio, sglang, most local vLLM lanes)
 * tells us nothing, and a cold badge there would be a claim nobody made.
 *
 * NO WINDOW, NO `until`. A provider outside `cache-policy.ts` and outside the
 * inline-hint path publishes no lifetime. It gets `state: "warm"` with no
 * `until` and no `ttlSeconds`, and the badge says so rather than counting down
 * against a number the engine invented.
 *
 * The channel is a plain module-level listener list, the shape `turn-end.ts`
 * uses and for the same reason: the value is read by the ACP shell, which boots
 * the engine in-process, so a public EventV2 wire type would buy nothing.
 */
/** The JSON-RPC method. `acpClient.ts` strips a single leading `_`. */
export const CACHE_STATE_METHOD = "origami/cacheState"

export type CacheState = "warm" | "cold" | "unmeasured"

/** Which event produced this push. The client shows it; nothing branches on it. */
export type CacheStateSource = "request" | "warm" | "expired" | "compaction" | "model"

/** The wire payload, exactly as `acpClient.ts` decodes it. */
export type CacheStatePush = {
  readonly sessionId: string
  readonly state: CacheState
  /** Epoch ms the window runs out. OMITTED when the provider publishes none. */
  readonly until?: number
  /** The window used for `until`, in seconds. Omitted with `until`. */
  readonly ttlSeconds?: number
  readonly source: CacheStateSource
}

export type CacheStateListener = (push: CacheStatePush) => void

const listeners = new Set<CacheStateListener>()

export function onCacheState(listener: CacheStateListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export type TimerHandle = { readonly id: unknown }

export interface Clock {
  now(): number
  setTimeout(fn: () => void, ms: number): TimerHandle
  clearTimeout(handle: TimerHandle): void
}

const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const id = setTimeout(fn, ms)
    // A pending expiry must never hold the process open: it is a UI signal.
    ;(id as unknown as { unref?: () => void }).unref?.()
    return { id }
  },
  clearTimeout: (handle) => clearTimeout(handle.id as ReturnType<typeof setTimeout>),
}

let clock: Clock = realClock

/** Test seam. */
export function setClock(next: Clock | undefined): void {
  clock = next ?? realClock
}

type Entry = {
  /** The window the LAST real request was sent under, in seconds. Undefined
   *  means this provider publishes none. */
  window: number | undefined
  /** The last push, so an unchanged state is not re-sent every step. */
  last: CacheStatePush | undefined
  expiry: TimerHandle | undefined
}

const sessions = new Map<string, Entry>()

const entry = (sessionID: string): Entry => {
  const found = sessions.get(sessionID)
  if (found) return found
  const made: Entry = { window: undefined, last: undefined, expiry: undefined }
  sessions.set(sessionID, made)
  return made
}

const clearExpiry = (e: Entry): void => {
  if (e.expiry === undefined) return
  clock.clearTimeout(e.expiry)
  e.expiry = undefined
}

/** Best-effort by construction: a sink that throws must not take down a turn. */
const publish = (sessionID: string, push: CacheStatePush): void => {
  const e = entry(sessionID)
  // A tool loop finishes a step every few seconds and most of them repeat the
  // previous answer. Only a CHANGE goes on the wire.
  if (e.last && e.last.state === push.state && e.last.until === push.until && e.last.source === push.source) return
  e.last = push
  for (const listener of listeners) {
    try {
      listener(push)
    } catch {
      // deliberately swallowed; see above
    }
  }
}

const goCold = (sessionID: string, source: CacheStateSource): void => {
  clearExpiry(entry(sessionID))
  publish(sessionID, { sessionId: sessionID, state: "cold", source })
}

/**
 * A hit, measured. Publishes warm, and arms the expiry when - and only when -
 * the provider published a window.
 */
const goWarm = (sessionID: string, source: CacheStateSource): void => {
  const e = entry(sessionID)
  clearExpiry(e)
  if (e.window === undefined) {
    publish(sessionID, { sessionId: sessionID, state: "warm", source })
    return
  }
  const until = clock.now() + e.window * 1000
  publish(sessionID, { sessionId: sessionID, state: "warm", until, ttlSeconds: e.window, source })
  e.expiry = clock.setTimeout(() => {
    const current = sessions.get(sessionID)
    if (!current || current.expiry === undefined) return
    current.expiry = undefined
    // Only the state this timer was armed for expires. A cold that landed in
    // between already superseded it, and `publish` drops the repeat anyway.
    if (current.last?.state !== "warm") return
    publish(sessionID, { sessionId: sessionID, state: "cold", source: "expired" })
  }, e.window * 1000)
}

/**
 * A real request is going out under this window (undefined = the provider
 * publishes none). Recorded, not published: a request in flight says nothing
 * about the cache until its usage comes back.
 */
export function request(input: { sessionID: string; ttlSeconds: number | undefined }): void {
  entry(input.sessionID).window = input.ttlSeconds
}

/**
 * A real step finished. `cacheRead` is the RAW `usage.cacheReadInputTokens`,
 * undefined included: `undefined` is the provider saying nothing, which is not
 * the same fact as a reported zero, and only the raw value keeps them apart.
 */
export function measured(input: { sessionID: string; cacheRead: number | undefined }): void {
  if (input.cacheRead === undefined) {
    clearExpiry(entry(input.sessionID))
    publish(input.sessionID, { sessionId: input.sessionID, state: "unmeasured", source: "request" })
    return
  }
  if (input.cacheRead > 0) return goWarm(input.sessionID, "request")
  goCold(input.sessionID, "request")
}

/**
 * A warm request came back. ONLY a read greater than zero counts: a warm that
 * read nothing refreshed nothing, and a warm that failed is not evidence of a
 * cold cache either - it is evidence about the warm.
 */
export function warmed(input: { sessionID: string; cacheRead: number | undefined }): void {
  if (input.cacheRead === undefined || input.cacheRead <= 0) return
  goWarm(input.sessionID, "warm")
}

/** A compaction threw the prefix away. */
export function compacted(sessionID: string): void {
  goCold(sessionID, "compaction")
}

/** The chat switched model, so the new model's cache holds nothing yet. */
export function modelChanged(sessionID: string): void {
  goCold(sessionID, "model")
}

/** The chat closed (t-w2u5vf): its badge has no reader left. */
export function evict(sessionID: string): void {
  const e = sessions.get(sessionID)
  if (e) clearExpiry(e)
  sessions.delete(sessionID)
}

/** Test seam: module state is process-wide, so a suite needs a way back to zero. */
export function reset(): void {
  for (const e of sessions.values()) clearExpiry(e)
  sessions.clear()
  listeners.clear()
  clock = realClock
}

export * as SessionCacheState from "./cache-state"
