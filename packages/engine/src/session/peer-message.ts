import { createHash } from "node:crypto"

/**
 * PEER MESSAGE PROVENANCE — the part-metadata key that says a user turn came
 * from another AGENT, not from the human at the keyboard. One module for both
 * sides: `tool/agents.ts` writes the key, `acp/event.ts` reads it, and a shared
 * definition stops those two drifting apart. It also carries the IDEMPOTENCY id,
 * which the sender mints and the receiving prompt path drops a repeat of, so
 * both ends must agree on how it is computed down to the byte.
 */

export const PEER_MESSAGE_KEY = "origami_peer"

/**
 * How long a delivered id keeps blocking a repeat of itself. ONE constant for
 * both ends: the sender's guard stops an unanswered probe being re-sent, the
 * receiver's stops a duplicate POST from any sender. A window rather than
 * forever because an identical line is a legitimate message eventually ("done"
 * twice, an hour apart).
 */
export const PEER_DEDUPE_WINDOW_MS = 5 * 60_000

export type PeerMessageOrigin = {
  from: string
  /** The address the receiver answers on — `name#sessionId`. */
  replyTo: string
  /** The idempotency id, absent on a message minted before this existed. */
  id?: string
  /**
   * PRESENT ONLY ON A SUB-AGENT QUESTION — one of THIS chat's own children
   * asking its parent rather than the user. Same key, same reason as `flock`:
   * to every existing reader it is the same fact, a user part nobody in this
   * window typed. Written in `session/subagent-question.ts`.
   */
  subagent?: SubagentOrigin
  /**
   * PRESENT ONLY ON A FLOCK MESSAGE — another PERSON's Origami over the relay,
   * not another session of this owner's. It rides the same key rather than a
   * second one because both are the same fact to every existing reader: a user
   * part nobody in this window typed. Written in `flock/deliver.ts`.
   */
  flock?: FlockOrigin
}

/** WHO is asking and WHAT answers it. `label` is the drawer's own name for the
 *  child (`<type> · T<n> · <description>`); `requestID` is the pending question
 *  the reply tool resolves. */
export type SubagentOrigin = {
  label: string
  requestID: string
  /** The child's session, so a client can point at the row that is waiting. */
  sessionID: string
}

export type FlockOrigin = {
  contact: string
  thread: string
  kind: string
  /** The contact's sigil id, for the badge. Absent means the default. */
  icon?: string
}

export function peerMessageMetadata(origin: PeerMessageOrigin) {
  return {
    [PEER_MESSAGE_KEY]: {
      from: origin.from,
      replyTo: origin.replyTo,
      ...(origin.id ? { id: origin.id } : {}),
      ...(origin.subagent ? { subagent: origin.subagent } : {}),
      ...(origin.flock ? { flock: origin.flock } : {}),
    },
  }
}

/** The sub-agent rider on a peer origin, or undefined. Fail-closed like
 *  `flockOrigin`: a partial rider counts as absent rather than badging a row
 *  with half an identity. */
function subagentOrigin(raw: unknown): SubagentOrigin | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const value = raw as { label?: unknown; requestID?: unknown; sessionID?: unknown }
  if (typeof value.label !== "string" || !value.label) return undefined
  if (typeof value.requestID !== "string" || !value.requestID) return undefined
  if (typeof value.sessionID !== "string" || !value.sessionID) return undefined
  return { label: value.label, requestID: value.requestID, sessionID: value.sessionID }
}

/** The flock rider on a peer origin, or undefined. */
function flockOrigin(raw: unknown): FlockOrigin | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const value = raw as { contact?: unknown; thread?: unknown; kind?: unknown; icon?: unknown }
  if (typeof value.contact !== "string" || !value.contact) return undefined
  if (typeof value.thread !== "string" || !value.thread) return undefined
  if (typeof value.kind !== "string" || !value.kind) return undefined
  const icon = typeof value.icon === "string" && value.icon ? value.icon : undefined
  return { contact: value.contact, thread: value.thread, kind: value.kind, ...(icon ? { icon } : {}) }
}

/**
 * The provenance a part carries, or undefined for every ordinary part. Reading
 * is fail-closed here and in `flockOrigin`: anything that is not exactly what
 * `peerMessageMetadata` writes counts as absent, because the alternative is
 * badging a human's own typed message as coming from some other agent.
 */
export function peerMessage(metadata: unknown): PeerMessageOrigin | undefined {
  if (!metadata || typeof metadata !== "object") return undefined
  const raw = (metadata as Record<string, unknown>)[PEER_MESSAGE_KEY]
  if (!raw || typeof raw !== "object") return undefined
  const value = raw as { from?: unknown; replyTo?: unknown; id?: unknown; flock?: unknown; subagent?: unknown }
  if (typeof value.from !== "string" || !value.from) return undefined
  if (typeof value.replyTo !== "string" || !value.replyTo) return undefined
  const id = typeof value.id === "string" && value.id ? value.id : undefined
  const flock = flockOrigin(value.flock)
  const subagent = subagentOrigin(value.subagent)
  return {
    from: value.from,
    replyTo: value.replyTo,
    ...(id ? { id } : {}),
    ...(subagent ? { subagent } : {}),
    ...(flock ? { flock } : {}),
  }
}

/**
 * The id for one handoff, DERIVED rather than random. A random id per tool call
 * would only catch a duplicate POST, never the commoner case of the sending
 * MODEL re-sending the same probe because nothing answered it. The deliberate
 * cost: a genuinely repeated line inside the window counts as the same message,
 * which is why the window exists rather than a permanent ledger.
 */
export function peerMessageId(input: { from: string; to: string; text: string }): string {
  // JSON.stringify rather than a hand-rolled delimiter: unambiguous separation.
  return createHash("sha256").update(JSON.stringify([input.from, input.to, input.text])).digest("hex").slice(0, 16)
}

/** Ids already accepted, per session. Plain module state: both ends run in THIS
 *  process, and a ledger that survived a restart would be one nobody could
 *  clear. */
const delivered = new Map<string, Map<string, number>>()
/** Bounded: the receiver never learns that a chat closed, so an unbounded map
 *  would be a slow leak in an engine that runs for days. */
const MAX_IDS_PER_SESSION = 64
const MAX_SESSIONS = 64

/**
 * Claim an id for a session. `true` the first time, `false` for a repeat inside
 * the window. Recorded on the FIRST claim rather than after a successful
 * injection: a burst of identical deliveries would otherwise all pass the check
 * before any of them finished.
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
 * Should this prompt be dropped as a duplicate of one already injected? A prompt
 * with no peer rider is an ordinary human turn and is never dropped — the guard
 * is scoped to messages this feature itself put on the wire.
 */
export function duplicatePeerPrompt(sessionID: string, parts: readonly unknown[], now = Date.now()): boolean {
  // `unknown[]` rather than a part shape: the prompt payload is a union whose
  // file and agent members declare no `metadata` at all, so a structural
  // parameter would exclude the very calls this is for.
  const ids = parts
    .map((part) => peerMessage((part as { metadata?: unknown } | null)?.metadata)?.id)
    .filter((id): id is string => !!id)
  if (!ids.length) return false
  // Decided over the WHOLE prompt before any of it is claimed. Claiming as it
  // goes would, for a prompt whose second part is the repeat, record the first
  // id as delivered by a prompt that was then dropped.
  const seen = delivered.get(sessionID)
  if (ids.some((id) => seen !== undefined && now - (seen.get(id) ?? -Infinity) <= PEER_DEDUPE_WINDOW_MS)) return true
  for (const id of ids) claimPeerMessage(sessionID, id, now)
  return false
}
