import { createHash } from "node:crypto"

/**
 * PEER MESSAGE PROVENANCE (t-kgu05m) — the part-metadata key that says a user
 * turn came from another AGENT, not from the human at the keyboard.
 *
 * One module for both sides on purpose: `tool/agents.ts` writes the key when it
 * posts to a peer, `acp/event.ts` reads it when the part comes back out, and a
 * shared definition is what stops those two from becoming a mirror that can
 * drift. Same shape, and the same reasoning, as task-result.ts next to it.
 *
 * It also carries the IDEMPOTENCY id, for the same reason: the sender mints it
 * and the receiving prompt path drops a repeat of it, so the two ends have to
 * agree on how the id is computed down to the byte.
 */

export const PEER_MESSAGE_KEY = "origami_peer"

/**
 * How long a delivered id keeps blocking a repeat of itself.
 *
 * ONE constant for both ends. The sender's guard stops the loop the user
 * actually saw — an agent that got no answer sending the same probe three
 * times — and the receiver's stops a duplicate POST from any sender at all,
 * including a retry this engine never chose. A window rather than forever
 * because an identical line is a legitimate message eventually ("done" twice,
 * an hour apart); five minutes is far longer than the seconds in which a
 * re-send is impatience, and far shorter than the span in which it is news.
 */
export const PEER_DEDUPE_WINDOW_MS = 5 * 60_000

export type PeerMessageOrigin = {
  /** The sending agent's display name. */
  from: string
  /** The address the receiver answers on — `name#sessionId`. */
  replyTo: string
  /** The idempotency id, absent on a message minted before this existed. */
  id?: string
}

/** The part `metadata` object carrying this provenance. */
export function peerMessageMetadata(origin: PeerMessageOrigin) {
  return {
    [PEER_MESSAGE_KEY]: { from: origin.from, replyTo: origin.replyTo, ...(origin.id ? { id: origin.id } : {}) },
  }
}

/**
 * The provenance a part carries, or undefined for every ordinary part.
 * Fail-closed: anything that is not exactly what `peerMessageMetadata` writes
 * is treated as absent, because the alternative is badging a human's own typed
 * message as coming from some other agent.
 */
export function peerMessage(metadata: unknown): PeerMessageOrigin | undefined {
  if (!metadata || typeof metadata !== "object") return undefined
  const raw = (metadata as Record<string, unknown>)[PEER_MESSAGE_KEY]
  if (!raw || typeof raw !== "object") return undefined
  const value = raw as { from?: unknown; replyTo?: unknown; id?: unknown }
  if (typeof value.from !== "string" || !value.from) return undefined
  if (typeof value.replyTo !== "string" || !value.replyTo) return undefined
  const id = typeof value.id === "string" && value.id ? value.id : undefined
  return { from: value.from, replyTo: value.replyTo, ...(id ? { id } : {}) }
}

/**
 * The id for one handoff, derived rather than random.
 *
 * A random id per tool call would only ever catch a duplicate POST, and the
 * duplicate the UAT produced was not that: the sending MODEL re-sent the same
 * probe because nothing had answered it. Deriving the id from who is sending,
 * who is receiving and what is being said is what makes that second call
 * recognisable as the same message. The cost is deliberate and named — a
 * genuinely repeated line inside the window is treated as the same message —
 * and it is why the window exists rather than a permanent ledger.
 */
export function peerMessageId(input: { from: string; to: string; text: string }): string {
  // JSON.stringify rather than a delimiter of my own: it separates the three
  // fields unambiguously without putting a literal separator character in this
  // source file, and an invisible one here would be unreviewable in a diff.
  return createHash("sha256").update(JSON.stringify([input.from, input.to, input.text])).digest("hex").slice(0, 16)
}

// --------------------------- the delivered ledger ---------------------------

/** Ids already accepted, per session. Plain module state, like the broker's:
 *  the prompt path and the send tool both run in THIS process, and a ledger
 *  that survived a restart would be a ledger nobody could clear. */
const delivered = new Map<string, Map<string, number>>()
/** Ids kept per session, and sessions kept at all. Bounded because the receiver
 *  never learns that a chat closed — an unbounded map would be a slow leak in
 *  an engine that runs for days. */
const MAX_IDS_PER_SESSION = 64
const MAX_SESSIONS = 64

/**
 * Claim an id for a session. `true` the first time, `false` for a repeat inside
 * the window — the caller then drops the message instead of injecting it twice.
 *
 * Recording on the FIRST claim (rather than after a successful injection) is
 * the safer order for the failure it exists to stop: a burst of identical
 * deliveries would otherwise all pass the check before any of them finished.
 */
export function claimPeerMessage(sessionID: string, id: string, now = Date.now()): boolean {
  const seen = delivered.get(sessionID) ?? new Map<string, number>()
  const at = seen.get(id)
  if (at !== undefined && now - at <= PEER_DEDUPE_WINDOW_MS) return false
  seen.set(id, now)
  for (const [key, stamp] of seen) {
    if (now - stamp > PEER_DEDUPE_WINDOW_MS) seen.delete(key)
  }
  while (seen.size > MAX_IDS_PER_SESSION) seen.delete(seen.keys().next().value as string)
  delivered.delete(sessionID)
  delivered.set(sessionID, seen)
  while (delivered.size > MAX_SESSIONS) delivered.delete(delivered.keys().next().value as string)
  return true
}

/** Test seam: the ledger is process-wide, so a suite needs a way back to zero. */
export function resetPeerMessages(): void {
  delivered.clear()
}

/**
 * Should this prompt be dropped as a duplicate of one already injected?
 *
 * Called on the RECEIVING side, where the only thing known about the sender is
 * what rode in on the part. A prompt with no peer rider is an ordinary human
 * turn and is never dropped — the guard is scoped to messages this feature
 * itself put on the wire.
 */
export function duplicatePeerPrompt(sessionID: string, parts: readonly unknown[], now = Date.now()): boolean {
  // `unknown[]` rather than a part shape: the prompt payload is a union whose
  // file and agent members declare no `metadata` at all, so a structural
  // parameter excludes the very calls this is for. Reading is fail-closed
  // anyway — `peerMessage` rejects everything that is not exactly its own key.
  const ids = parts
    .map((part) => peerMessage((part as { metadata?: unknown } | null)?.metadata)?.id)
    .filter((id): id is string => !!id)
  if (!ids.length) return false
  // Decided over the WHOLE prompt before any of it is claimed. Claiming as it
  // goes would, for a prompt whose second part is the repeat, leave the first
  // id recorded as delivered by a prompt that was then dropped — the ledger
  // would be lying about a message nobody ever saw.
  const seen = delivered.get(sessionID)
  if (ids.some((id) => seen !== undefined && now - (seen.get(id) ?? -Infinity) <= PEER_DEDUPE_WINDOW_MS)) return true
  for (const id of ids) claimPeerMessage(sessionID, id, now)
  return false
}
