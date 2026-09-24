// What a step IS — its LANE, whether it is a boundary event, and the tone its
// glyph carries. Split out of labyrinthLayout.ts so that file stays "where
// does a point go" and this one stays "what kind of thing is this step".
//
// The lane model is the mockup's: every crossing belongs to a thread, and
// the THREAD decides its offset from the spine — `main` on the spine,
// `tools` jutting one way, `delegation` the other.

/**
 * What a `compaction` step carries beyond its kind, mirroring `RunStep`'s
 * own field. `contextBefore`/`summaryTokens` are OPTIONAL; an absent one
 * renders as NOTHING rather than a 0, which would read as a measurement.
 */
export interface CompactionFacts {
  trigger: 'auto' | 'manual' | 'overflow' | 'unknown';
  contextBefore?: number;
  summaryTokens?: number;
}

/** The part of a step these rules read. `LayoutStep` extends this. */
export interface LaneStep {
  kind: 'prompt' | 'reply' | 'tool' | 'thinking' | 'subagent' | 'compaction' | 'error';
  status?: 'completed' | 'error' | 'running' | 'pending';
  /**
   * OPTIONAL sub-agent nesting level; absent, non-finite or negative all
   * read as 0, so the map renders identically whether `run_steps` sends it.
   */
  depth?: number;
}

export type Lane = 'main' | 'tools' | 'delegation';

/** Distance of the tools/delegation lanes from the spine, in user units. */
export const LANE_GAP = 110;

/** `depth` as a usable level: absent, non-finite or negative all read as 0. */
export function normDepth(step: LaneStep): number {
  const raw = step.depth;
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

/**
 * Depth decides the lane before kind does. Sub-agent steps come back as
 * ordinary kinds carrying `depth: 1`; deciding by kind alone put them back
 * on the spine. Only at depth 0 does kind get a say.
 */
export function laneFor(step: LaneStep): Lane {
  if (normDepth(step) > 0) return 'delegation';
  if (step.kind === 'tool') return 'tools';
  if (step.kind === 'subagent') return 'delegation';
  return 'main';
}

/**
 * Signed offset from the spine: positive for tools, negative for
 * delegation, zero on main. Fixes only which SIDE a lane is on — how far
 * out a step sits is labyrinthBranches.ts's business.
 */
export function laneOffset(step: LaneStep): number {
  const lane = laneFor(step);
  if (lane === 'main') return 0;
  return lane === 'tools' ? LANE_GAP : -LANE_GAP;
}

/**
 * A THRESHOLD is a boundary event: a step whose kind or status is `error`.
 * Not widened by sniffing titles for "permission" — that would invent
 * boundaries the run never had.
 */
export function isThreshold(step: LaneStep): boolean {
  return step.kind === 'error' || step.status === 'error';
}

/**
 * Glyph tone for a step, with a failure always outranking its kind (a
 * subagent that died reads as a FAILURE, not a routing point). The glyph's
 * SHAPE comes from the raw `kind`, so a failed tool still shows the tool
 * mark; only its colour changes.
 */
export function stepGlyph(step: LaneStep): LaneStep['kind'] {
  return isThreshold(step) ? 'error' : step.kind;
}
