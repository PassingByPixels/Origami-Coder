// What the map must SAY about its own positions when it could not place them
// by clock. A LEAF, so "does thread admit it fell back to list order?" is
// answerable without mounting the pane, and so both clock-positioned modes
// phrase the same admission in the same words.
//
// Corridor is deliberately silent: it is the COMPACT view, has never claimed
// to be positioned by time, and so has nothing to disclaim.

import { flightIsTimeBased } from './labyrinthFlight';
import { threadIsTimeBased } from './labyrinthTime';
import type { SpanStep } from './labyrinthSpans';
import type { MapMode } from './labyrinthLayout';

/** The flight strip's existing wording, unchanged — its axis is x, not rows. */
const FLIGHT_NOTE =
  'Even spacing — these steps carry no usable timestamps, so positions here show ORDER, not time.';
/**
 * Thread's wording names the CONSEQUENCE as well as the cause: with rows in
 * list order, a sub-agent's steps sit above the main-thread work that ran
 * during it, which reads as "and then" when the truth was "meanwhile".
 */
const THREAD_NOTE =
  'Stacked in list order — at least one step carries no usable timestamp, so rows here show ORDER, not time. '
  + 'Work that ran alongside a sub-agent cannot be placed beside it.';

/** The line to print above the map, or null when its positions are honest. */
export function mapNotice(mode: MapMode, steps: readonly SpanStep[]): string | null {
  if (mode === 'flight') return flightIsTimeBased(steps) ? null : FLIGHT_NOTE;
  if (mode === 'thread') return threadIsTimeBased(steps) ? null : THREAD_NOTE;
  return null;
}
