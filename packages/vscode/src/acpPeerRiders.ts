// The two OPTIONAL riders that sit inside `_meta.origami_peer`, each naming a
// sender that is neither the human nor another of this owner's sessions.
//
// Extracted from acpPeerMeta.ts when the sub-agent rider landed and pushed that
// file past its cap. The split is by responsibility, not by size: acpPeerMeta.ts
// answers "did an agent send this at all", which is the question the routing
// decision turns on; this answers "which kind of agent", which only the badge
// cares about. Both stay FAIL-CLOSED — a half-formed rider reads as no rider,
// because a badge naming a sender who did not write the message is worse than
// no badge, and a "sub-agent question" badge on a message no agent sent tells
// the user an agent is blocked when none is.
//
// Validated the same way in packages/engine/src/session/peer-message.ts.

/** A message from another PERSON's Origami over the flock, rather than from
 *  another session of this owner's. Absent on an ordinary peer handoff. */
export interface FlockOrigin { contact: string; thread: string; kind: string; icon?: string }

/** A question from one of THIS chat's own sub-agents (t-po041k). The agent is
 *  blocked until `requestID` is answered. Absent on an ordinary handoff. */
export interface SubagentOrigin { label: string; requestID: string; sessionID: string }

export function flockFromMeta(raw: unknown): FlockOrigin | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const f = raw as { contact?: unknown; thread?: unknown; kind?: unknown; icon?: unknown };
  if (typeof f.contact !== 'string' || !f.contact || typeof f.thread !== 'string' || !f.thread) return undefined;
  if (typeof f.kind !== 'string' || !f.kind) return undefined;
  const icon = typeof f.icon === 'string' && f.icon ? f.icon : undefined;
  return { contact: f.contact, thread: f.thread, kind: f.kind, ...(icon ? { icon } : {}) };
}

export function subagentFromMeta(raw: unknown): SubagentOrigin | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const s = raw as { label?: unknown; requestID?: unknown; sessionID?: unknown };
  if (typeof s.label !== 'string' || !s.label) return undefined;
  if (typeof s.requestID !== 'string' || !s.requestID) return undefined;
  if (typeof s.sessionID !== 'string' || !s.sessionID) return undefined;
  return { label: s.label, requestID: s.requestID, sessionID: s.sessionID };
}
