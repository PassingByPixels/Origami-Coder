// peerEnvelope.ts — WHAT THE HUMAN READS of an agent-origin message.
//
// The engine wraps one in an XML-ish frame followed by an instruction sentence
// addressed to the RECEIVING MODEL. The human should see neither: strip
// everything from the opening tag through the closing one, and leave anything
// that does not match that pattern alone rather than guessing.
//
// BOTH FRAMES, because a flock message rides the same row: `flock/deliver.ts`
// writes `<flock_message …>` with its own instruction sentence after it, and a
// reader that knew only the peer tag would show the owner raw XML plus a
// paragraph addressed to the model. The back-reference stops the two matching
// each other's closing tag. A sub-agent question needs no third alternative —
// it rides the `<peer_message>` frame with one extra attribute, deliberately
// (packages/engine/src/session/subagent-question.ts).
//
// Extracted from PeerMessageRow.svelte when that file passed its cap; still
// re-exported from the component, so every existing importer is unchanged.

export function peerBody(text: string): string {
  const match = /^<(peer|flock)_message\b[^>]*>\n?([\s\S]*?)\n?<\/\1_message>/.exec(text.trim());
  return match ? match[2] : text;
}
