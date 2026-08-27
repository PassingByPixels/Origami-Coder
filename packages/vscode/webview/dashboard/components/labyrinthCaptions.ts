// Which of the flight strip's LABELS the strip can actually afford to print —
// the per-step caption, and the TIME-AXIS clock row beneath the lanes.
//
// The defect this exists for (owner's UAT): flight places x by real wall clock,
// so two steps a few milliseconds apart land on top of each other and their
// labels were drawn straight through one another — "Write ta**sk**mpell…" for
// the captions, "11:57:17:43   11:57:46" for the clock row. labyrinthSwim.ts's
// swimCrowded already drops the DETAIL rows at that density; the caption sits
// above them and the clock below them, and neither was gated.
//
// Both are DROP rules over one shared implementation (labyrinthCollide.ts), so
// the strip cannot end up with two anti-collision policies that disagree about
// the same run. Neither is misleading: nothing is claimed by an absence — the
// marker is still drawn, still hoverable (its <title> carries the full text),
// still clickable, and the inspector still shows every field. This is the
// disposition swimCrowded already takes for the detail rows.
//
// The axis is NOT re-ticked at even intervals instead. Evenly-spaced ticks
// would have to carry times INTERPOLATED off the scale rather than times the
// run recorded, and on the evenly-spaced fallback (flightIsTimeBased false)
// there is no scale to interpolate on at all — while the clock row still
// legitimately prints each step's real start there. Sampling the real starts
// keeps every printed time a fact, and the greedy rule already spaces them by
// the room available rather than by their index.

import { collisionHidden } from './labyrinthCollide';
import { FLIGHT_CAPTION_CHARS } from './labyrinthFlight';
import { formatClock, stepCaption, truncate } from './labyrinthFormat';

/** Over-estimated advance for the 13px caption (mirrors THREAD_CHAR_W). */
const CAPTION_CHAR_W = 8.4;
/** ...and for the 11px clock row, which is a size smaller. */
const CLOCK_CHAR_W = 7.2;

/** The part of a laid-out point the caption rule reads. */
export interface CaptionPoint {
  x: number;
  y: number;
  step: { tool?: string; title: string };
}

/** The part of a laid-out point the axis rule reads. */
export interface ClockPoint {
  x: number;
  step: { startedAt?: number };
}

/**
 * Per-point: must this caption be dropped to keep the strip readable?
 *
 * Lanes are keyed on y, so a sub-agent's own lane is measured independently of
 * the trunk — two steps at the same instant on DIFFERENT lanes do not collide.
 */
export function swimCaptionHidden(points: readonly CaptionPoint[]): boolean[] {
  return collisionHidden(points.map((p) => ({
    row: p.y,
    x: p.x,
    half: (truncate(stepCaption(p.step), FLIGHT_CAPTION_CHARS).length * CAPTION_CHAR_W) / 2,
  })));
}

/**
 * Per-point: must this TIME-AXIS label be dropped?
 *
 * ONE row, unlike the captions: every clock prints at the same y (swimClockY,
 * under the lowest lane in use) whatever lane its marker took, so a trunk step
 * and a sub-agent step at the same instant DO collide down there even though
 * their captions do not.
 *
 * A step with no timestamp prints no clock — it is hidden, and it reserves no
 * space, so it cannot push a label that does print off the strip.
 */
export function swimClockHidden(points: readonly ClockPoint[]): boolean[] {
  return collisionHidden(points.map((p) => {
    const clock = formatClock(p.step.startedAt);
    return { row: 0, x: p.x, half: ((clock?.length ?? 0) * CLOCK_CHAR_W) / 2, printed: clock !== undefined };
  }));
}
