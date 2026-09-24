/**
 * "This sub-agent is waiting for a provider slot", and the process-local channel
 * it travels on (t-52cxcw).
 *
 * A queued sub-agent had no live surface at all: the transcript row's label is
 * frozen at the pending frame (chatToolTitle.ts refuses a later title for
 * `task`) and `session.status` is not on the ACP wire, so the drawer row's
 * activity tail — fed by the childChunk text path in acp/event.ts — is the one
 * place a waiting line can appear with no extension change.
 *
 * A plain module-level listener list, the same shape as session/turn-end.ts and
 * for the same reason: the publisher is the provider fetch wrapper and the only
 * reader is the ACP shell, which boots the engine IN-PROCESS. Making this an
 * EventV2 would mean a new PUBLIC wire type for a value nothing off-process
 * reads.
 */

export type QueueState =
  /** Queued behind `ahead` requests already waiting for this provider's cap. */
  | { readonly type: "waiting"; readonly ahead: number }
  /** A permit was granted (or the wait failed) — the line is stale, clear it. */
  | { readonly type: "started" }

export type ProviderQueueEvent = {
  readonly sessionID: string
  readonly providerID: string
  readonly state: QueueState
}

export type ProviderQueueListener = (event: ProviderQueueEvent) => void

const listeners = new Set<ProviderQueueListener>()

export function onProviderQueue(listener: ProviderQueueListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Best-effort by construction: a sink that throws must never take down the
 *  request it is reporting on — this is a UI signal, not a result. */
export function publishProviderQueue(event: ProviderQueueEvent): void {
  for (const listener of listeners) {
    try {
      listener(event)
    } catch {
      // deliberately swallowed; see above
    }
  }
}

/**
 * The line itself, so the engine test and the ACP forwarder cannot drift. Plain
 * ASCII: it is appended to the child's forwarded text and read in a one-line
 * activity tail.
 */
export function waitingLine(ahead: number): string {
  if (ahead <= 0) return "waiting for a provider slot\n"
  return `waiting for a provider slot (${ahead} ahead)\n`
}

/**
 * What clears the waiting line. The activity tail is APPEND-ONLY — it prints the
 * last few non-empty lines of the child's stream — so a stale "waiting" can only
 * be superseded by another line, never erased. Emitted once, and only for a
 * request that actually queued.
 */
export function startedLine(): string {
  return "provider slot granted\n"
}

/** Test seam: the listener set is process-wide, so a suite needs a way back to
 *  zero. */
export function resetProviderQueueListeners(): void {
  listeners.clear()
}

export * as SessionProviderQueue from "./provider-queue"
