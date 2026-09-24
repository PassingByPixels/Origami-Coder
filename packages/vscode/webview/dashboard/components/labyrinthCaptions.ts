// Which of the flight strip's LABELS the strip can actually afford to
// print — the per-step caption, and the TIME-AXIS clock row beneath the
// lanes.
//
// Flight places x by real wall clock, so steps a few milliseconds apart
// can land on top of each other and draw their labels through one
// another. Both use one shared drop rule (labyrinthCollide.ts), so the
// strip cannot end up with two anti-collision policies that disagree.
// Nothing is misleading on drop: the marker is still drawn, hoverable and
// clickable, and the inspector still shows every field.
//
// The axis is not re-ticked at even intervals: that would carry times
// INTERPOLATED off the scale rather than times the run recorded. Sampling
// the real starts keeps every printed time a fact.

import { collisionHidden } from './labyrinthCollide';
import { FLIGHT_CAPTION_CHARS } from './labyrinthFlight';
import { formatClock, stepCaption, truncate } from './labyrinthFormat';

/** Over-estimated advance for the 13px caption (mirrors THREAD_CHAR_W). */
const CAPTION_CHAR_W = 8.4;
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
 * Per-point: must this caption be dropped? Lanes are keyed on y, so a
 * sub-agent's own lane is measured independently — two steps at the same
 * instant on different lanes do not collide.
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
 * ONE row, unlike the captions: every clock prints at the same y, so a
 * trunk step and a sub-agent step at the same instant DO collide there
 * even though their captions do not. A step with no timestamp prints no
 * clock and reserves no space.
 */
export function swimClockHidden(points: readonly ClockPoint[]): boolean[] {
  return collisionHidden(points.map((p) => {
    const clock = formatClock(p.step.startedAt);
    return { row: 0, x: p.x, half: ((clock?.length ?? 0) * CLOCK_CHAR_W) / 2, printed: clock !== undefined };
  }));
}
