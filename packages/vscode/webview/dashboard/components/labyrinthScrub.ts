// The scrub line's rules: where the chart's time cursor lands, and which
// step it's pointing at.
//
// A tool tick on this chart is 1.6 user units wide, and on a long run
// several share a pixel column. Widening the tick isn't the answer, since a
// tick's width is its duration and inflating it would be a lie, so the
// reader gets a cursor instead: drop it anywhere and it takes the nearest
// real mark.
//
// The candidates are every drawn x, not the step list: the spine, category
// bars, delegate lanes, and each sub-agent span's departure and rejoin. A
// reader aiming at a rejoin arrow is aiming at a real place on the picture.
//
// Every stop carries the ordinal it selects, so placing the cursor and
// clicking a tick finish in the same call.
//
// Pure, with one exception: `scrubXAt` reads a rect off the event target,
// since only the live element knows how many CSS pixels the viewBox is
// drawn across. Everything else is arithmetic, assertable with no layout
// engine (jsdom has none).

import { formatClock } from './labyrinthFormat';

/** One place the cursor may sit: a drawn x, and the step it stands for. */
export interface ScrubStop { x: number; ordinal: number }

/** The part of the chart the cursor reads. `FlightChart` satisfies it. */
export interface ScrubChart {
  marks: ReadonlyArray<{ x: number; ordinal: number }>;
  spans: ReadonlyArray<{ x1: number; x2: number; ordinal: number }>;
}

/** The part of a step the cursor's label reads. `LayoutStep` satisfies it. */
export interface ScrubStep { ordinal: number; startedAt?: number }

/** Every x the cursor may snap to, in axis order. Sorted by x then ordinal
 *  so an exact tie goes to the earlier stop. */
export function scrubStops(chart: ScrubChart): ScrubStop[] {
  const seen = new Set<string>();
  const out: ScrubStop[] = [];
  const add = (x: number, ordinal: number): void => {
    if (!Number.isFinite(x)) return;
    const key = `${x}|${ordinal}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ x, ordinal });
  };
  for (const m of chart.marks) add(m.x, m.ordinal);
  // Both ends of a delegate's span: the departure is its spawn, and the rejoin
  // is the other moment on the band a reader points at.
  for (const s of chart.spans) { add(s.x1, s.ordinal); add(s.x2, s.ordinal); }
  return out.sort((a, b) => a.x - b.x || a.ordinal - b.ordinal);
}

/** The stop nearest `x`. Ties go to the earlier one; no stops means no cursor. */
export function snapScrub(stops: readonly ScrubStop[], x: number): ScrubStop | null {
  if (!Number.isFinite(x)) return null;
  let best: ScrubStop | null = null;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const stop of stops) {
    const gap = Math.abs(stop.x - x);
    // Strictly less: `stops` is already in axis order, so the first stop at a
    // tied distance is the earlier one and keeps the win.
    if (gap < bestGap) { bestGap = gap; best = stop; }
  }
  return best;
}

/** Where an arrow key moves the cursor. Null = it doesn't move. The walk
 *  skips stops that would select the step the cursor is already on, since a
 *  key press that leaves the inspector where it was reads as a dead key. */
export function stepScrub(
  stops: readonly ScrubStop[], from: ScrubStop | null, key: string,
): ScrubStop | null {
  const last = stops.length - 1;
  if (last < 0) return null;
  if (key === 'Home') return stops[0]!;
  if (key === 'End') return stops[last]!;
  const dir = key === 'ArrowRight' ? 1 : key === 'ArrowLeft' ? -1 : 0;
  if (dir === 0) return null;
  if (!from) return dir > 0 ? stops[0]! : stops[last]!;
  const at = stops.findIndex((s) => s.x === from.x && s.ordinal === from.ordinal);
  const start = at < 0 ? (dir > 0 ? -1 : stops.length) : at;
  for (let i = start + dir; i >= 0 && i <= last; i += dir) {
    if (stops[i]!.ordinal !== from.ordinal) return stops[i]!;
  }
  return null;
}

/** A pointer's clientX as a chart user unit. The one DOM reader here, since
 *  zoom draws the same viewBox across a different number of CSS pixels.
 *  Null when the element has no width yet. */
export function scrubXAt(
  ev: { clientX: number; currentTarget: EventTarget | null }, chartWidth: number,
): number | null {
  const el = ev.currentTarget as { getBoundingClientRect?: () => { left: number; width: number } } | null;
  const rect = el?.getBoundingClientRect?.();
  if (!rect || !(rect.width > 0)) return null;
  return ((ev.clientX - rect.left) * chartWidth) / rect.width;
}

/** What rides on the cursor: the snapped step's own clock, or its ordinal
 *  when the run carries none. Never an x interpolated back into a time. */
export function scrubLabel(stop: ScrubStop, steps: readonly ScrubStep[]): string {
  const step = steps.find((s) => s.ordinal === stop.ordinal);
  return formatClock(step?.startedAt) ?? `#${stop.ordinal}`;
}
