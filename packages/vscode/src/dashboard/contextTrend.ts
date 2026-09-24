// The last twenty context readings of a chat (t-ru1i84), so the breakdown card can draw
// where the conversation is HEADING and not only where it stands.
//
// The host keeps them, not the webview: a reload rebuilds the webview and would lose the
// series, and the same readings already pass through here on their way out.
//
// WHAT COUNTS AS A READING is the engine's own `used` — the real occupancy off a usage
// frame, the same number the gauge shows. The per-turn poll's figure is not used: it is a
// turn counter, and mixing the two would draw a line whose points mean different things.
//
// A READING IDENTICAL TO THE ONE BEFORE IT IS DROPPED. Several frames can carry the same
// total within one turn, and twenty points of which fifteen are the same moment would
// draw a flat line that looks like a quiet conversation rather than one sample repeated.

/** Points kept per session. Twenty is what the card's 232px can draw without the line
 *  becoming a texture. */
export const TREND_POINTS = 20;

const rings = new Map<string, number[]>();

/** Test seam — the ring is module state and outlives a single case. */
export function resetContextTrend(): void {
  rings.clear();
}

/** A chat that is gone keeps no history. Called when a session closes. */
export function forgetContextTrend(sessionId: string): void {
  rings.delete(sessionId);
}

/** Record one reading and answer the session's series, oldest first. A reading that is
 *  not a positive number is ignored: `0` is what a fresh chat reports before anything has
 *  been sent, and a leading zero would anchor every later point against nothing. */
export function pushContextReading(sessionId: string, used: unknown): readonly number[] {
  const ring = rings.get(sessionId) ?? [];
  const value = typeof used === 'number' && Number.isFinite(used) && used > 0 ? Math.round(used) : undefined;
  if (value !== undefined && ring[ring.length - 1] !== value) {
    ring.push(value);
    if (ring.length > TREND_POINTS) ring.splice(0, ring.length - TREND_POINTS);
  }
  rings.set(sessionId, ring);
  return ring;
}

/** The series so far, for a message that carries it without adding to it. `undefined`
 *  when there is nothing to draw — the card must render no sparkline at all rather than
 *  an empty box, and an absent field is how it learns that. */
export function contextTrend(sessionId: string): number[] | undefined {
  const ring = rings.get(sessionId);
  return ring && ring.length > 0 ? [...ring] : undefined;
}

/** The spread a post site adds: `...trendField(sessionId)`. Nothing at all when there is
 *  no series, so the field is optional on the wire in the plainest possible sense. */
export function trendField(sessionId: string): { trend?: number[] } {
  const trend = contextTrend(sessionId);
  return trend ? { trend } : {};
}
