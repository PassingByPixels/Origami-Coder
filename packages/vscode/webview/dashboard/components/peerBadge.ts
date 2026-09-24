// peerBadge.ts — WHAT the agent-origin row says it is, for the three senders
// that share it.
//
// Extracted from PeerMessageRow.svelte when the sub-agent question landed and
// pushed that file past its cap. The split is by responsibility: the component
// owns the markup and the envelope strip, this owns the one rule a reader has
// to get right — a peer HANDOFF needs nothing from the user, a FLOCK message is
// another person entirely, and a SUB-AGENT QUESTION means one of the user's own
// agents is stopped until somebody answers. Three senders, one row, and the
// badge is the only thing that tells them apart.
//
// Pure and DOM-free, so the rule is testable without mounting.

export interface PeerBadge {
  /** The badge text. */
  text: string;
  /** Which sender it is, as the class the row styles from. */
  tone: 'peer' | 'flock' | 'subagent';
  /** A second line under the badge, or '' when there is nothing to add. */
  detail: string;
}

export function peerBadge(input: {
  from: string;
  flock?: { contact: string; thread: string };
  subagent?: { label: string };
}): PeerBadge {
  // A sub-agent question wins over a flock rider: both cannot be true, and if
  // a malformed message ever carried both, the one that says an agent is
  // BLOCKED is the one the user must not miss.
  if (input.subagent) {
    return { text: 'sub-agent question', tone: 'subagent', detail: `${input.subagent.label} · waiting` };
  }
  if (input.flock) {
    return { text: `flock · ${input.flock.contact}`, tone: 'flock', detail: `thread ${input.flock.thread}` };
  }
  return { text: `from ${input.from}`, tone: 'peer', detail: '' };
}
