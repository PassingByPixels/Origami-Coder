// subagentWarn.ts — "this one is about to be killed".
//
// A sub-agent is stopped by a CEILING it cannot see (ORIGAMI_SUBAGENT_MAX_MS,
// written at spawn from `origami.subagentTimeLimitHours` — src/subagentLimit.ts),
// and the first anyone hears of it is a dead child. The drawer already holds
// the start stamp and the limit is one setting away, so the row can say so
// while there is still time to interject.
//
// Split from subagentTiming.ts by responsibility: that answers "how long has
// this been out", this answers "is that long enough to worry". Pure, DOM-free
// and clock-injected, so 79.9% vs 80.0% is testable without waiting four hours.

import { elapsedText } from './subagentFormat';

/** How much of the ceiling must be gone before the dot turns amber. 80% of a
 *  four-hour cap is 48 minutes of warning — enough to interject, late enough
 *  that an ordinary agent never trips it. */
export const WARN_FRACTION = 0.8;

const MS_PER_HOUR = 3_600_000;

/** The limit in ms, or 0 for "no usable limit" — which turns the warning OFF
 *  rather than guessing four hours. The host is the only honest source
 *  (subagentLimitPane.ts posts it), and a webview inventing a ceiling would
 *  amber rows the engine is perfectly happy with. */
export function limitMs(hours: number | undefined): number {
  return typeof hours === 'number' && Number.isFinite(hours) && hours > 0 ? Math.round(hours * MS_PER_HOUR) : 0;
}

/** `4 h` / `30 min` — how the limit itself is named in the warning. */
function limitName(ms: number): string {
  const hours = ms / MS_PER_HOUR;
  return Number.isInteger(hours) ? `${hours} h` : `${Math.round(ms / 60_000)} min`;
}

/**
 * The row's warning title, or '' for no warning at all — which is also the
 * amber flag, so the dot and the tooltip can never disagree.
 *
 * SETTLED ROWS NEVER WARN. A finished child cannot be killed by the ceiling,
 * and a long one that finished is exactly the row a user does not need chasing.
 * An unknown age (`0`, subagentTiming.ts) never warns either: amber on a row
 * whose clock nobody trusts is a false alarm with no way to check it.
 */
export function limitWarning(elapsedMs: number, settled: boolean, limit: number): string {
  if (settled || limit <= 0 || elapsedMs <= 0) return '';
  if (elapsedMs < limit * WARN_FRACTION) return '';
  const left = limit - elapsedMs;
  if (left <= 0) return `Past the ${limitName(limit)} sub-agent time limit — the engine may stop it at any moment`;
  return `Approaching the ${limitName(limit)} sub-agent time limit — about ${elapsedText(left)} left`;
}
