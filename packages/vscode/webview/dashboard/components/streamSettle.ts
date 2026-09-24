// streamSettle.ts — when does a bubble stop reading as LIVE?
//
// Text still arriving renders in --og-chat and settles to --og-text once the
// stream goes quiet (Mock-Redesign CHANGES.md change 11). The mock had to infer
// "live" from text GROWTH because its bundle carries no streaming flag; the
// product does not — ChatTranscript already knows which row is the open agent
// message (`currentAgentMsgId`) — so the row is told, and this leaf owns only
// the QUIET rule, which is the part the flag cannot answer: the flag stays true
// for the whole turn, while the colour must settle the moment the text stops.
//
// A pure leaf so the rule is testable with nothing rendered (jsdom has no
// layout, so a computed-colour assertion would prove nothing anyway).

/** Quiet for this long and the run settles to ink. The mock's measured value. */
export const SETTLE_MS = 420;

/**
 * Is this bubble live RIGHT NOW? `streaming` is the caller's truth (the row is
 * the open agent message); `lastGrowthAt` is when its text last got longer.
 *
 * A bubble that is no longer the open message is settled whatever its timings
 * say — the turn ended, and a caret blinking on a finished answer is a lie.
 * A streaming bubble that has not grown for SETTLE_MS is settled too: the model
 * is thinking, or the tail of the turn is tool work, and holding the whole
 * answer in the live colour until the turn closes would leave prose the reader
 * has finished reading still dressed as arriving.
 */
export function isLive(streaming: boolean, lastGrowthAt: number, now: number): boolean {
  return streaming && now - lastGrowthAt < SETTLE_MS;
}

/** ms until the next settle check is worth making, or null if none is due. */
export function settleDelay(streaming: boolean, lastGrowthAt: number, now: number): number | null {
  if (!streaming) return null;
  return Math.max(0, SETTLE_MS - (now - lastGrowthAt));
}
