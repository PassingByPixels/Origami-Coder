/**
 * The Claude CLI states a window's length inside its rate-limit type; this is the one place that
 *  reads it.
 *
 * `seven_day` is the CLI's own statement of the plan's cadence, read directly rather than recovered
 *  by parsing the pill's rendered label back into a duration.
 */

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** The words the CLI spells its window counts with. */
export const NUMBER_WORD: Record<string, string> = {
  one: '1', two: '2', three: '3', four: '4', five: '5', six: '6',
  seven: '7', eight: '8', nine: '9', ten: '10', twelve: '12', thirty: '30',
};

/**
 * `seven_day` -> 7 days, `five_hour` -> 5 hours, in milliseconds.
 *
 * `undefined` for a type this build cannot split, the same silence `windowLabel` falls back to — a
 *  guessed length is worse than none.
 */
export function windowLengthMs(rateLimitType: string): number | undefined {
  const parts = rateLimitType.split('_').filter(Boolean);
  const n = Number(NUMBER_WORD[parts[0] ?? ''] ?? '');
  const unit = parts[1] ?? '';
  if (!Number.isFinite(n) || n <= 0) return undefined;
  if (/^hour/i.test(unit)) return n * HOUR;
  if (/^day/i.test(unit)) return n * DAY;
  return undefined;
}
