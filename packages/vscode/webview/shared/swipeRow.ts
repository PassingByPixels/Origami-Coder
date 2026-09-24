// SWIPE-TO-DELETE — the maths behind SwipeRow.svelte.
//
// Ported from react-bits Micro/SwipeRow (Mock-Redesign/CHANGES.md change 2),
// constants and formulas as written, so the feel matches the reference:
//
//   * the drag LOCKS to the horizontal after HYST px, or as soon as the
//     horizontal beats the vertical — otherwise a list scroll would open rows;
//   * past the action width the travel is RUBBER-BANDED, an asymptote rather
//     than a wall, so a hard pull never feels stuck;
//   * a FLICK decides by direction, a slow release by projected distance;
//   * a full swipe past the commit point DELETES rather than just opening.
//
// Every function here is pure, which is the point: jsdom has no layout, so the
// only honest way to prove the feel is to test the numbers directly.

/** Revealed width of the delete panel, px (reference `actionWidth`). */
export const SWIPE_ACTION_W = 84;
/** px of travel before the drag locks to the horizontal. */
export const SWIPE_HYST = 10;
/** px/s at which a release is read as a flick and direction alone decides. */
export const SWIPE_FLICK = 110;
/** Momentum decay used to project where a release would have coasted to. */
export const SWIPE_DECEL = 0.998;
/** Rubber-band resistance (reference default). */
export const SWIPE_RESIST = 0.55;
/** Share of the row width past which a swipe commits the delete. */
export const SWIPE_COMMIT_AT = 0.6;

/** Rubber band: an overshoot of `o` against a dimension `dim`, asymptotic. */
export function rubber(o: number, dim: number): number {
  return (o * dim * SWIPE_RESIST) / (dim + SWIPE_RESIST * Math.abs(o));
}

/** How much further a release travelling at `v` px/s would have coasted. */
export function project(v: number): number {
  return ((v / 1000) * SWIPE_DECEL) / (1 - SWIPE_DECEL);
}

/**
 * The point a swipe stops being "reveal the delete" and becomes "delete it".
 * Never closer than one and a half action widths, so a narrow row cannot
 * commit on a flick that barely uncovered the panel.
 */
export function commitPoint(rowW: number, actionW = SWIPE_ACTION_W): number {
  return Math.max(SWIPE_COMMIT_AT * rowW, actionW + actionW / 2);
}

/**
 * Raw drag distance -> revealed pixels. Free to the action width, then at
 * `SWIPE_RESIST` of the pull until the commit point, then rubber-banded.
 * A pull the OTHER way (raw < 0) is rubber-banded from the start: there is
 * nothing to reveal on that side.
 */
export function mapExtent(raw: number, rowW: number, actionW = SWIPE_ACTION_W): number {
  if (raw < 0) return rubber(raw, rowW);
  if (raw <= actionW) return raw;
  const c = commitPoint(rowW, actionW);
  const knee = actionW + (c - actionW) / SWIPE_RESIST;
  return raw <= knee ? actionW + SWIPE_RESIST * (raw - actionW) : c + rubber(raw - knee, rowW);
}

/** px/s from the drag samples, or 0 when there are too few to mean anything. */
export function velocity(samples: Array<[number, number]>): number {
  if (samples.length < 2) return 0;
  const a = samples[0];
  const b = samples[samples.length - 1];
  return ((b[1] - a[1]) / Math.max(1, b[0] - a[0])) * 1000;
}

/** Flick: direction decides. Otherwise: would it coast past halfway? */
export function decideOpen(extent: number, v: number, actionW = SWIPE_ACTION_W): boolean {
  if (Math.abs(v) >= SWIPE_FLICK) return v > 0;
  return extent + project(v) > actionW / 2;
}

/** The settle transition. A flick overshoots; reduced motion never does. */
export function settleEase(v: number, reduced: boolean): string {
  if (reduced) return '200ms cubic-bezier(0.23, 1, 0.32, 1)';
  if (Math.abs(v) >= SWIPE_FLICK) return '400ms cubic-bezier(0.34, 1.56, 0.64, 1)';
  return '300ms cubic-bezier(0.23, 1, 0.32, 1)';
}

/** True once a locked horizontal drag has been established. */
export function locks(dx: number, dy: number): boolean {
  return Math.abs(dx) >= SWIPE_HYST && Math.abs(dx) >= Math.abs(dy);
}
