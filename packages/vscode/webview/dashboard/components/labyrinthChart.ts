// THE ANALYTICS FLIGHT CHART'S FRAME — every coordinate the SVG draws, as one
// pure value.
//
// Flight used to be a wide strip that GREW with the run (150px per step) and
// scrolled. This view fits the whole run into the panel instead and lets the
// reader zoom in, which is the layout the owner approved: the chart is built AT
// the container's own measured width, so at rest one user unit is one CSS pixel
// and the text is crisp. Zoom then makes the rendered width LARGER than the
// viewBox, so ticks and labels get bigger rather than a fixed giant canvas being
// squashed down into an illegible one.
//
// The rows, top to bottom: one "All activity" spine, one row per tool CATEGORY,
// a labelled gap, then the SUB-AGENT band (labyrinthAgentBand.ts). The gap is
// not decoration — it is the point of the layout, so it carries its own count.
//
// TIME IS STILL GATED. `flightIsTimeBased` is the same gate the old strip used
// and the pane's own notice reads: one step without a usable start and the whole
// chart falls back to EVEN SPACING, with no idle windows, no span bars and no
// clock on the axis — because every one of those is a length, and a length off
// an invented scale is fiction. Positions then show order, and the pane says so.
//
// The AXIS ANNOTATIONS — idle windows, turn markers, clock labels — are
// labyrinthAxis.ts's: they cross every row rather than sitting on one, and they
// all vanish together when the clock cannot order the run. This file went past
// its cap and that was the seam it was pointing at.
//
// Pure — no DOM, so every row y and every tick x is assertable without a layout
// engine (jsdom has none).

import type { AgentRow } from './labyrinthAgentBand';
import { bandLabel } from './labyrinthBandLabel';
import { categoryVar, toolCategory, CATEGORY_ORDER, type Category } from './labyrinthCategory';
import { axisMarks, IDLE_MS, type AxisTick, type IdleWindow, type TurnMark } from './labyrinthAxis';
import { flightIsTimeBased } from './labyrinthFlight';
import { isThreshold, type LaneStep } from './labyrinthLanes';
import { finiteTime } from './labyrinthSpans';
import { TONE_VARS } from './labyrinthTone';

/** The part of a step the chart reads. `ChartStep` satisfies it. Declared here
 *  rather than imported from labyrinthLayout.ts so this leaf stays a leaf. */
export interface ChartStep extends LaneStep {
  ordinal: number;
  tool?: string;
  title: string;
  startedAt?: number;
  endedAt?: number;
}

/** Narrowest chart worth drawing; below it the category labels collide. */
export const MIN_CHART_WIDTH = 700;
/** Re-exported so the chart stays one import for its consumers. */
export { IDLE_MS };
export type { IdleWindow, TurnMark, AxisTick };

const PAD_L = 120;
const PAD_R = 24;
/**
 * The first row's top. It leaves a band above the chart that belongs to
 * LabyrinthBreaks.svelte, which draws its model tag at a FIXED y of 12 (that
 * geometry is shared with thread and corridor and is not this view's to move).
 * At the old value of 10 the break tag and the first turn label were printed
 * through each other — seen on a real render, invisible to jsdom.
 */
const TOP = 26;
const ALL_H = 34;
const ROW_H = 22;
const GAP_H = 46;
const AGENT_H = 28;
const NEST_H = 24;
const AXIS_H = 28;
/** Room a turn label needs at the right-hand end before it must flip side. */
const TURN_LABEL_W = 46;

export interface ChartRow { key: string; label: string; y: number; h: number; indent: number }
export interface ChartMark {
  ordinal: number;
  x: number; y: number; w: number; h: number;
  fill: string;
  diamond: boolean;
  band: 'all' | 'category' | 'agent';
}
export interface ChartSpan {
  first: number; ordinal: number; x1: number; x2: number; y: number;
  open: boolean; label: string; labelX: number; detail: string; indent: number;
  depart: string; rejoin: string | null;
}
export interface LossMark { ordinal: number; x: number }

export interface FlightChart {
  width: number; height: number; top: number; chartBottom: number;
  padLeft: number; padRight: number;
  /** True when x is wall clock. False = even spacing; see the header. */
  timeBased: boolean;
  allRow: ChartRow;
  categoryRows: ChartRow[];
  gapY: number;
  gapLabel: string;
  agentLanes: ChartRow[];
  marks: ChartMark[];
  spans: ChartSpan[];
  idle: IdleWindow[];
  turns: TurnMark[];
  axis: AxisTick[];
  losses: LossMark[];
  /**
   * One entry per STEP INDEX: where that step sits on the All-activity spine.
   * LabyrinthBreaks.svelte is indexed by step position (labyrinthBreaks.ts's
   * `ModelBreak.index`), so it needs a position per step, not the mark list —
   * a step contributes up to three marks, and a break belongs to none of them
   * in particular.
   */
  spine: Array<{ x: number; y: number }>;
}

const r = (n: number): number => Math.round(n * 100) / 100;

function markFill(step: ChartStep): string {
  if (isThreshold(step)) return 'var(--og-error)';
  if (step.kind === 'tool') return categoryVar(toolCategory(step));
  return `var(${TONE_VARS[step.kind] ?? '--og-text-secondary'})`;
}

export interface ChartInput {
  steps: readonly ChartStep[];
  rows: readonly AgentRow[];
  /** The container's own measured width in px. Clamped to MIN_CHART_WIDTH. */
  width: number;
  /** Ordinals whose prefill was billed fresh (labyrinthCache.ts). */
  lossOrdinals?: ReadonlySet<number>;
}

export function flightChart(input: ChartInput): FlightChart {
  const { steps, rows } = input;
  const W = Math.max(MIN_CHART_WIDTH, Math.round(input.width) || 0);
  const timeBased = flightIsTimeBased(steps);

  const starts = steps.map((s) => finiteTime(s.startedAt)).filter((n): n is number => n !== undefined);
  const ends = steps.map((s) => finiteTime(s.endedAt) ?? finiteTime(s.startedAt)).filter((n): n is number => n !== undefined);
  const rawMin = starts.length ? Math.min(...starts) : 0;
  const rawMax = ends.length ? Math.max(...ends) : 0;
  // 2% of breathing room each side, so a step at either extreme is not drawn
  // half off the axis rule.
  const pad = (rawMax - rawMin) * 0.02;
  const tMin = rawMin - pad;
  const tMax = rawMax + pad;
  const span = W - PAD_L - PAD_R;
  const byTime = (t: number): number => (tMax > tMin ? PAD_L + (span * (t - tMin)) / (tMax - tMin) : PAD_L);
  const byIndex = (i: number): number => (steps.length > 1 ? PAD_L + (span * i) / (steps.length - 1) : PAD_L);
  const xOf = (i: number): number => {
    if (!timeBased) return byIndex(i);
    return byTime(finiteTime(steps[i]!.startedAt)!);
  };

  let y = TOP;
  const allRow: ChartRow = { key: 'all', label: 'All activity', y, h: ALL_H, indent: 0 };
  y += ALL_H;
  const categoryRows: ChartRow[] = CATEGORY_ORDER.map((category) => {
    const row: ChartRow = { key: category, label: category, y, h: ROW_H, indent: 0 };
    y += ROW_H;
    return row;
  });
  const gapY = y;
  y += GAP_H;
  const agentLanes: ChartRow[] = rows.map((row) => {
    const h = row.indent > 0 ? NEST_H : AGENT_H;
    const lane: ChartRow = { key: String(row.first), label: row.label, y, h, indent: row.indent };
    y += h;
    return lane;
  });
  const chartBottom = y + 8;
  const height = chartBottom + AXIS_H;

  const laneOf = new Map(agentLanes.map((lane) => [Number(lane.key), lane]));
  const catOf = new Map(categoryRows.map((row) => [row.key as Category, row]));
  const mid = (row: ChartRow): number => row.y + row.h / 2;
  /** Which lane a step's ticks belong to: the delegate that produced it. */
  const ownerOf = new Map<number, number>();
  for (const row of rows) for (const index of row.steps) ownerOf.set(index, row.first);

  const marks: ChartMark[] = [];
  const spine: Array<{ x: number; y: number }> = [];
  steps.forEach((step, i) => {
    const x = xOf(i);
    spine.push({ x, y: mid(allRow) });
    const fill = markFill(step);
    // DIAMOND = an event, not a stretch of work. A delegate spawn is one; so is
    // a context compaction, which has no duration of its own and would be a
    // one-pixel tick nobody could hit if it were drawn like a tool step.
    const diamond = step.kind === 'subagent' || step.kind === 'compaction';
    // The spine carries EVERY step, any depth — it is the run's own outline.
    const h = ALL_H - 8;
    marks.push({
      ordinal: step.ordinal, x, y: diamond ? mid(allRow) : mid(allRow) - h / 2,
      w: diamond ? 8 : 1.6, h: diamond ? 8 : h, fill, diamond, band: 'all',
    });
    // The category rows are the TOP-LEVEL agent's own time; a delegate's work
    // belongs to its lane in the band, never doubled into the bars above it.
    if ((step.depth ?? 0) === 0 && (step.kind === 'tool' || step.kind === 'error' || step.kind === 'subagent')) {
      const row = catOf.get(toolCategory(step));
      if (row) {
        const end = timeBased ? finiteTime(step.endedAt) : undefined;
        const w = end === undefined ? 1.6 : Math.max(1.6, byTime(end) - x);
        const ch = row.h - 8;
        marks.push({
          ordinal: step.ordinal, x, y: diamond ? mid(row) : mid(row) - ch / 2,
          w: diamond ? 9 : w, h: diamond ? 9 : ch, fill, diamond, band: 'category',
        });
      }
    }
    const lane = laneOf.get(ownerOf.get(i) ?? -1);
    if (lane && step.kind !== 'subagent') {
      const lh = Math.min(10, lane.h - 10);
      marks.push({ ordinal: step.ordinal, x, y: mid(lane) - lh / 2, w: 1.4, h: lh, fill, diamond: false, band: 'agent' });
    }
  });

  const axisEnd = W - PAD_R;
  const spans: ChartSpan[] = !timeBased ? [] : rows.flatMap((row) => {
    const lane = laneOf.get(row.first);
    if (!lane || row.startMs === undefined) return [];
    const x1 = byTime(row.startMs);
    const x2 = row.open ? axisEnd : row.endMs === undefined ? x1 : byTime(row.endMs);
    if (x2 <= x1) return [];
    const laneY = mid(lane);
    const band = bandLabel(row, PAD_L);
    // The row it left FROM: its parent's lane when it was itself delegated,
    // else the Delegate category row on the main chart.
    const parent = rows.find((p) => p.first !== row.first && p.steps.includes(row.first));
    const fromRow = parent ? laneOf.get(parent.first) : catOf.get('Delegate');
    const fromY = fromRow ? mid(fromRow) : mid(allRow);
    return [{
      first: row.first, ordinal: row.ordinal, x1: r(x1), x2: r(x2), y: laneY,
      open: row.open, label: band.text, labelX: band.x, detail: row.detail, indent: row.indent,
      depart: `M ${r(x1)} ${r(fromY)} L ${r(x1)} ${r(laneY)}`,
      rejoin: row.open ? null : `M ${r(x2)} ${r(laneY)} L ${r(x2)} ${r(fromY)}`,
    }];
  });

  // Everything that crosses every row rather than sitting on one: the idle
  // shading, the turn markers and the clock labels. One gate for all three —
  // with no usable clock none of them is drawn, because each is a LENGTH.
  const { idle, turns, axis } = axisMarks({
    steps, byTime: timeBased ? byTime : null, xOf, tMin, tMax, labelLimit: W - PAD_R - TURN_LABEL_W,
  });

  const wanted = input.lossOrdinals;
  const losses: LossMark[] = !wanted ? [] : steps
    .map((step, i) => ({ step, i }))
    .filter(({ step }) => wanted.has(step.ordinal))
    .map(({ step, i }) => ({ ordinal: step.ordinal, x: r(xOf(i)) }));

  const never = rows.filter((row) => row.open).length;
  return {
    width: W, height, top: TOP, chartBottom, padLeft: PAD_L, padRight: PAD_R,
    timeBased, allRow, categoryRows, gapY, agentLanes, marks, spans, idle, turns, axis, losses, spine,
    gapLabel: rows.length === 0
      ? 'SUB-AGENTS — none delegated'
      : `SUB-AGENTS — ${rows.length} delegated, ${never} never rejoined`,
  };
}
