// WHAT THE TIME AXIS SAYS about a run: the windows where nothing happened, the
// user turns that punctuate it, and the clock labels under it.
//
// Extracted from labyrinthChart.ts when that file went past its cap. The split
// is not arbitrary: labyrinthChart.ts answers "where does a row go and what sits
// on it", and everything here is instead an annotation ACROSS every row, derived
// from the clock alone. All three are also the parts that must vanish together
// when the run cannot be clock-ordered — one gate, one file.
//
// Pure — no DOM.

import { finiteTime } from './labyrinthSpans';

/** A quiet stretch worth shading. Under this, every turn boundary would shade. */
export const IDLE_MS = 90_000;
/** Below this an idle block cannot hold its label horizontally. */
const NARROW_IDLE = 46;
/** Clock labels are one fixed set, so density can never collide them. */
const AXIS_TICKS = 6;
/** Room a turn label needs before it would be printed through its neighbour. */
const TURN_LABEL_W = 46;

export interface IdleWindow { x1: number; x2: number; label: string; narrow: boolean }
export interface TurnMark {
  ordinal: number;
  x: number;
  label: string;
  /** Which side of its own line the label sits on, so the last turn's label is
   *  never printed off the right-hand edge, where the SVG clips it silently. */
  anchor: 'start' | 'end';
  /** True when the previous printed label is too close to share the row. The
   *  dashed line is still drawn — the marker is the fact, the label is furniture. */
  labelHidden: boolean;
}
export interface AxisTick { x: number; label: string }

/** The part of a step the axis reads. */
export interface AxisStep {
  ordinal: number;
  kind: string;
  depth?: number;
  startedAt?: number;
  endedAt?: number;
}

const r = (n: number): number => Math.round(n * 100) / 100;

/** HH:MM, local — the same clock `formatClock` prints, one field shorter so six
 *  of them fit across an axis without overlapping. */
function axisClock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * Gaps in the FULL step stream, EVERY depth.
 *
 * Reading only the trunk would shade every stretch a foreground sub-agent was
 * working through, which is delegated activity and the opposite of idleness. The
 * walk therefore carries a REACH — the furthest end seen so far — rather than
 * just the previous step's end, so a long span covers the steps inside it.
 */
export function idleWindows(steps: readonly AxisStep[]): Array<{ startMs: number; endMs: number }> {
  const timed = steps
    .map((s) => ({ start: finiteTime(s.startedAt), end: finiteTime(s.endedAt) }))
    .filter((s): s is { start: number; end: number | undefined } => s.start !== undefined)
    .sort((a, b) => a.start - b.start);
  const out: Array<{ startMs: number; endMs: number }> = [];
  let reach = timed[0]?.end ?? timed[0]?.start ?? 0;
  for (let i = 1; i < timed.length; i++) {
    const next = timed[i]!.start;
    if (next - reach >= IDLE_MS) out.push({ startMs: reach, endMs: next });
    reach = Math.max(reach, timed[i]!.end ?? next);
  }
  return out;
}

export interface AxisInput {
  steps: readonly AxisStep[];
  /** Time -> x. NULL when the run cannot be clock-ordered; nothing with a
   *  LENGTH is then drawn, because a length off an invented scale is fiction. */
  byTime: ((t: number) => number) | null;
  /** x of step `i` on whatever axis is in use — clock, or even spacing. */
  xOf: (index: number) => number;
  tMin: number;
  tMax: number;
  /** x past which a turn label must be anchored to the LEFT of its own line. */
  labelLimit: number;
}

export function axisMarks(input: AxisInput): { idle: IdleWindow[]; turns: TurnMark[]; axis: AxisTick[] } {
  const { steps, byTime, tMin, tMax, labelLimit } = input;

  const idle: IdleWindow[] = !byTime ? [] : idleWindows(steps).map((w) => {
    const x1 = byTime(w.startMs);
    const x2 = byTime(w.endMs);
    return {
      x1: r(x1), x2: r(x2), narrow: x2 - x1 < NARROW_IDLE,
      label: `idle ${Math.round((w.endMs - w.startMs) / 6000) / 10}m`,
    };
  });

  // Turn labels are DROPPED rather than smeared where two turns share a pixel
  // column — the rule the strip's clock row already followed. On a run whose
  // first two prompts are a minute apart in twenty, that is most of them.
  let lastLabelX = Number.NEGATIVE_INFINITY;
  const turns: TurnMark[] = steps
    .map((step, i) => ({ step, i }))
    .filter(({ step }) => step.kind === 'prompt' && (step.depth ?? 0) === 0)
    .map(({ step, i }, n) => {
      const x = r(input.xOf(i));
      const anchor: 'start' | 'end' = x > labelLimit ? 'end' : 'start';
      const labelHidden = x - lastLabelX < TURN_LABEL_W;
      if (!labelHidden) lastLabelX = x;
      return { ordinal: step.ordinal, x, label: `Turn ${n + 1}`, anchor, labelHidden };
    });

  const axis: AxisTick[] = !byTime ? [] : Array.from({ length: AXIS_TICKS + 1 }, (_, i) => {
    const t = tMin + (tMax - tMin) * (i / AXIS_TICKS);
    return { x: r(byTime(t)), label: axisClock(t) };
  });

  return { idle, turns, axis };
}
