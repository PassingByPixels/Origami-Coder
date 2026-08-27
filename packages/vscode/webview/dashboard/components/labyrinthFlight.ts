// The FLIGHT strip's geometry — one horizontal spine, x BY TIME, y by lane.
// Extracted from labyrinthLayout.ts (at its architecture cap) when flight grew
// into the DETAIL view; that file keeps thread + corridor, this one owns the
// strip. Pure, so "does flight really space by time?" needs no DOM.
//
// Sized to be USED rather than merely to fit: each marker carries a detail
// block inline (see labyrinthDetail.ts) instead of making the reader click
// through the inspector one step at a time. It is also the only mode that
// positions by wall clock, so genuine sub-agent CONCURRENCY — two threads
// running in the same moment — becomes visible here and nowhere else.

import { laneFor, type LaneStep } from './labyrinthLanes';

export interface FlightStep extends LaneStep {
  startedAt?: number;
}

const FLIGHT_X0 = 110;
const FLIGHT_RIGHT_MARGIN = 80;
/** The main lane's baseline; tools sit above it, delegation below. */
export const FLIGHT_BASE_Y = 170;
export const FLIGHT_LANE_DY = 130;
/** Caption, then the detail rows, all BELOW the marker so every lane reads alike. */
export const FLIGHT_CAPTION_DY = 24;
export const FLIGHT_DETAIL_DY = 38;
export const FLIGHT_DETAIL_ROW = 14;
export const FLIGHT_CAPTION_CHARS = 16;
/** Clock row, under the lowest lane's detail block. */
export const FLIGHT_CLOCK_Y = 416;
const FLIGHT_HEIGHT = 440;
const FLIGHT_MIN_WIDTH = 760;
/** Pitch wide enough for a full detail row without colliding with its neighbour. */
const FLIGHT_PER_STEP = 150;

/** The strip's viewBox for `count` steps — it grows wider, never denser. */
export function flightBox(count: number): { width: number; height: number } {
  return {
    width: Math.max(FLIGHT_MIN_WIDTH, FLIGHT_X0 + count * FLIGHT_PER_STEP + FLIGHT_RIGHT_MARGIN),
    height: FLIGHT_HEIGHT,
  };
}

function flightY(step: LaneStep): number {
  const lane = laneFor(step);
  if (lane === 'tools') return FLIGHT_BASE_Y - FLIGHT_LANE_DY;
  if (lane === 'delegation') return FLIGHT_BASE_Y + FLIGHT_LANE_DY;
  return FLIGHT_BASE_Y;
}

/**
 * Whether the flight strip can honestly place markers by time.
 *
 * TRUE only when EVERY step carries a finite `startedAt` AND the run spans a
 * non-zero interval. `startedAt` is optional in the engine's projection (see
 * run-steps.ts: it is emitted only when the underlying part has a start time),
 * so a partially-timed run would otherwise mix real positions with invented
 * ones — which is worse than admitting we have no timing. When this is false
 * the strip falls back to EVEN SPACING and the pane says so on screen.
 */
export function flightIsTimeBased(steps: readonly FlightStep[]): boolean {
  if (steps.length < 2) return false;
  const ts: number[] = [];
  for (const s of steps) {
    if (typeof s.startedAt !== 'number' || !Number.isFinite(s.startedAt)) return false;
    ts.push(s.startedAt);
  }
  return Math.max(...ts) > Math.min(...ts);
}

/**
 * Where a timestamp lands on the strip, or null when the strip is not
 * time-based (on evenly-spaced fallback positions there is no scale to map
 * onto, and inventing one would make a duration bar pure fiction).
 *
 * CLAMPED to the axis at both ends. The scale is built from step STARTS, so a
 * sub-agent that ended after the last step began has no x of its own; it is
 * drawn as reaching the final marker rather than extrapolated off the canvas.
 */
export function flightTimeScale(steps: readonly FlightStep[]): ((t: number) => number) | null {
  if (!flightIsTimeBased(steps)) return null;
  const ts = steps.map((s) => s.startedAt as number);
  const min = Math.min(...ts);
  const max = Math.max(...ts);
  const span = flightBox(steps.length).width - FLIGHT_RIGHT_MARGIN - FLIGHT_X0;
  return (t: number) => FLIGHT_X0 + (span * (Math.min(Math.max(t, min), max) - min)) / (max - min);
}

export function flightLayout<S extends FlightStep>(steps: readonly S[]): Array<{ x: number; y: number; step: S }> {
  const n = steps.length;
  if (n === 0) return [];
  const span = flightBox(n).width - FLIGHT_RIGHT_MARGIN - FLIGHT_X0;
  if (n === 1) return [{ x: FLIGHT_X0, y: flightY(steps[0]!), step: steps[0]! }];
  if (!flightIsTimeBased(steps)) {
    return steps.map((step, i) => ({ x: FLIGHT_X0 + (span * i) / (n - 1), y: flightY(step), step }));
  }
  const ts = steps.map((s) => s.startedAt as number);
  const min = Math.min(...ts);
  const max = Math.max(...ts);
  return steps.map((step, i) => ({
    x: FLIGHT_X0 + (span * (ts[i]! - min)) / (max - min),
    y: flightY(step),
    step,
  }));
}
