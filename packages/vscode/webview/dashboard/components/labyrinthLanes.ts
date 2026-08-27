// What a step IS — its LANE, whether it is a boundary event, and the tone its
// glyph carries. Split out of labyrinthLayout.ts (which sits at its
// architecture cap) so that file stays "where does a point go" and this one
// stays "what kind of thing is this step"; both are pure, so both are
// answerable without a DOM.
//
// The lane model is the mockup's (hermes-labyrinth src/parts/30-map.js:12-17):
// every crossing belongs to a thread and the THREAD decides its offset from
// the spine — `main` on the spine, `tools` jutting one way, `delegation` (a
// sub-agent) the other — so a delegated stretch visibly branches and returns
// instead of every step queueing in one identical column.

/** The part of a step these rules read. `LayoutStep` extends this. */
export interface LaneStep {
  kind: 'prompt' | 'reply' | 'tool' | 'thinking' | 'subagent' | 'error';
  status?: 'completed' | 'error' | 'running' | 'pending';
  /**
   * OPTIONAL sub-agent nesting level; 0 (or absent) is the main thread. The
   * map must render identically whether or not `run_steps` sends it, so an
   * absent, non-finite or negative value is read as 0 and NEVER invented.
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
 * DEPTH FIRST, kind second.
 *
 * A sub-agent's own steps come back as ordinary `prompt`/`thinking`/`reply`
 * kinds carrying `depth: 1`. Deciding the lane by kind alone put all of them
 * back on the spine, so a delegated stretch read as work the MAIN agent did —
 * the defect this rule exists to kill. Anything below depth 0 belongs to its
 * parent's branch whatever its kind; only at depth 0 does kind get a say.
 */
export function laneFor(step: LaneStep): Lane {
  if (normDepth(step) > 0) return 'delegation';
  if (step.kind === 'tool') return 'tools';
  if (step.kind === 'subagent') return 'delegation';
  return 'main';
}

/**
 * Signed offset from the spine for a step drawn on a LANE rather than on a
 * branch column: positive for tools, negative for delegation, zero on main.
 * How far out a delegated step actually sits is the branch model's business
 * (labyrinthBranches.ts) — this only fixes which SIDE each lane is on, which
 * is also what the flight strip's rows are ordered by.
 */
export function laneOffset(step: LaneStep): number {
  const lane = laneFor(step);
  if (lane === 'main') return 0;
  return lane === 'tools' ? LANE_GAP : -LANE_GAP;
}

/**
 * A THRESHOLD is a boundary event — the mockup's `thresholds` thread, whose
 * samples are a redaction and a model fallback at 92% context.
 *
 * This engine projects NEITHER, and `run_steps` has no permission/approval
 * kind to project (it maps text / reasoning / tool / subtask / retry /
 * assistant-error). So the honest boundary set here is the failures: a step
 * whose kind or status is `error`. It is deliberately not widened by sniffing
 * titles for "permission" — that would invent boundaries the run never had.
 */
export function isThreshold(step: LaneStep): boolean {
  return step.kind === 'error' || step.status === 'error';
}

/**
 * Glyph tone for a step — one per kind, with a failure always outranking its
 * kind (a subagent that died reads as a FAILURE, not as a routing point). The
 * glyph's SHAPE comes from the raw `kind`, so a failed tool still shows the
 * tool mark; only its colour changes. Extends the original three-value
 * stepGlyph, which could not tell a prompt from a reply from a tool.
 */
export function stepGlyph(step: LaneStep): LaneStep['kind'] {
  return isThreshold(step) ? 'error' : step.kind;
}
