// collabHop.ts — the collab budget's derived TEXT, as a PURE leaf, mirroring
// cronFormat.ts / loopFormat.ts.
//
// THE CAP AND THE HOP BUDGET ARE THE SAME NUMBER, read two ways (C21):
// `loopBreakerCap` is the setting, `hopState` is what is left of it for the
// current human message. Two surfaces now draw from that pair — the control
// strip (which still says WHY a room is paused) and the compact bar under the
// composer (which says how much budget is left) — so the wording lives here
// rather than in either of them, and the two cannot drift apart.
//
// THE THREE CAP VALUES ARE NOT A SPECTRUM and are never folded: null is "the
// engine's default", 0 is "OFF", N is that cap. Each earns its own sentence
// rather than a shared one with a number in it.
//
// The shape below MIRRORS src/acpExtTypes.ts rather than importing it —
// tsconfig.webview.json pins rootDir to `webview/`, so a webview .ts cannot
// reach into src/. Same convention collabActivity.ts and collabKinds.ts follow;
// keep the three in step.

/** Mirrors `CollabHopState`, typed as it arrives off the wire: unvalidated. */
export interface HopStateLike {
  /** null = the budget is OFF, so nothing ever counts against it. */
  remaining?: unknown;
  cap?: unknown;
}

/** Below this, the remaining budget is drawn in the low state. Three is the
 *  last point at which raising the cap is still cheaper than being interrupted. */
export const HOP_LOW_AT = 3;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The loop-breaker SETTING, in words. Now the TOOLTIP: inline it wrapped into
 *  a tall column at sidebar widths (owner UAT) — the bar shows capShort. */
export function capText(cap: number | null | undefined): string {
  if (cap === null || cap === undefined) return 'Loop breaker: default (6 agent turns without you)';
  if (cap === 0) return 'Loop breaker: OFF — the agents will not stop for you';
  return `Loop breaker: ${cap} agent turn${cap === 1 ? '' : 's'} without you`;
}

/** The same three states at bar width. Never folded: each value keeps its word. */
export function capShort(cap: number | null | undefined): string {
  if (cap === null || cap === undefined) return 'cap: default';
  if (cap === 0) return 'cap: off';
  return `cap: ${cap}`;
}

/**
 * What is LEFT of the budget, for the prominent read-out under the composer.
 *
 * `remaining: null` means the budget is OFF and must never be coalesced with a
 * number — "0 hops left" would say the opposite of what the engine reported.
 * A cap the engine did not send still prints the count it DID send, rather than
 * a fraction with an invented denominator.
 *
 * '' when there is no hopState at all: an older engine reported no budget, and
 * a bar that printed one would be inventing the whole figure.
 */
export function hopText(hop: HopStateLike | null | undefined): string {
  if (!hop || typeof hop !== 'object') return '';
  const remaining = num(hop.remaining);
  if (remaining === null) return 'hop budget off';
  const cap = num(hop.cap);
  return cap === null ? `${remaining} hop${remaining === 1 ? '' : 's'} left` : `hops ${remaining}/${cap}`;
}

/** True when the budget is nearly spent — the emphasis state. A budget that is
 *  OFF is NOT low: nothing is running down. */
export function hopLow(hop: HopStateLike | null | undefined, at = HOP_LOW_AT): boolean {
  if (!hop || typeof hop !== 'object') return false;
  const remaining = num(hop.remaining);
  return remaining !== null && remaining <= at;
}

/** Why the room is paused. The M4 hop wording is used ONLY when the engine
 *  actually reported a spent budget — an older build keeps the loop-breaker
 *  sentence it earned. */
export function suspendText(hop: HopStateLike | null | undefined): string {
  return hopLow(hop, 0)
    ? 'hop budget spent — waiting for you. Post again and the agents get a fresh budget.'
    : 'Paused — waiting for you. The agents hit the loop breaker and will not speak again until you post.';
}
