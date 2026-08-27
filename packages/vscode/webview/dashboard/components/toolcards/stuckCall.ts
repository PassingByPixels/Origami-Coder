// stuckCall.ts — when a running tool call has been running long enough to say
// so, and for how long. Extracted from BashCard when the age + Kill controls
// had to move into ToolCard's HEADER: they were rendered in the card BODY,
// which ToolCard only mounts once the user expands the card, so on a live
// wedged bash call — collapsed, like every card starts — the Kill button did
// not exist in the DOM at all. Every test of it had rendered BashCard directly
// and so never crossed that gate.
//
// Pure so the rule is testable without a DOM, and shared rather than mirrored
// so the header and the card can never disagree about what "stuck" means.

/**
 * How long a call runs before its age is worth showing. Short enough that a
 * genuinely wedged command is flagged while the user is still looking at it,
 * long enough that an ordinary build or test run never wears the warning.
 */
export const STUCK_AFTER_S = 30;

export interface StuckState {
  /** Whole seconds since the call started; 0 when there is nothing to age. */
  elapsed: number;
  /** True once `elapsed` has passed STUCK_AFTER_S. */
  stuck: boolean;
}

/**
 * `now` is passed in rather than read here so the caller owns the clock — a
 * component seeds it at construction, which is what makes a card scrolled into
 * view on an already-old call honest on its FIRST frame instead of a tick later.
 */
export function stuckState(input: { running: boolean; startedAt?: number; now: number }): StuckState {
  if (!input.running || !input.startedAt) return { elapsed: 0, stuck: false };
  const elapsed = Math.max(0, Math.floor((input.now - input.startedAt) / 1000));
  return { elapsed, stuck: elapsed >= STUCK_AFTER_S };
}
