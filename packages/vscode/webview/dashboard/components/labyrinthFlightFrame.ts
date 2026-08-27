// Everything the FLIGHT strip needs that the other two modes never ask for,
// derived once instead of as six separate mode-guarded expressions in
// LabyrinthMap.svelte — which was at its architecture cap when the map gained
// its fit-to-width control.
//
// Nothing new is decided here: the lane extents, the named handoffs and the
// three density gates all still come from labyrinthSwim / labyrinthCaptions /
// labyrinthRails. This file only says WHICH of them flight needs together, and
// gives thread and corridor one empty value to render from rather than six.

import {
  flightSpans, swimLaneTags, swimCrowded, swimCaptionHidden, swimClockHidden,
  FLIGHT_BASE_Y, FLIGHT_LANE_DY, type LayoutStep, type LayoutPoint,
} from './labyrinthLayout';
import { handoffEdges } from './labyrinthRails';

export interface FlightFrame {
  /** Each sub-agent's own lane: its clock-gated extent, departure and rejoin. */
  spans: ReturnType<typeof flightSpans>;
  /** Handoff arcs, drawn only where the target is NAMED. */
  edges: ReturnType<typeof handoffEdges>;
  /** Per-marker density gates: detail rows, the caption, the time-axis label. */
  crowded: boolean[];
  captionHidden: boolean[];
  clockHidden: boolean[];
  /** The strip's named rows, so it says what its heights MEAN. */
  lanes: Array<{ label: string; y: number }>;
}

/** Thread and corridor render from this — no lanes, no spans, no gates. */
export const NO_FLIGHT_FRAME: FlightFrame = {
  spans: [], edges: [], crowded: [], captionHidden: [], clockHidden: [], lanes: [],
};

export function flightFrame(
  steps: readonly LayoutStep[],
  points: readonly LayoutPoint[],
  members: readonly string[],
  lanes: number,
): FlightFrame {
  return {
    spans: flightSpans(steps, members),
    edges: handoffEdges(points, steps, members),
    crowded: swimCrowded(points),
    captionHidden: swimCaptionHidden(points),
    clockHidden: swimClockHidden(points),
    // TOOLS above the trunk, MAIN on it, then one row per sub-agent.
    lanes: [{ label: 'TOOLS', y: FLIGHT_BASE_Y - FLIGHT_LANE_DY }, { label: 'MAIN', y: FLIGHT_BASE_Y }, ...swimLaneTags(lanes, members)],
  };
}
