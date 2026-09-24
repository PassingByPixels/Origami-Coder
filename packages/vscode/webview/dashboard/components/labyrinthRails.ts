// How a delegated run's EXTENT is drawn IN THREAD — the branch rail.
//
// A branch has four parts: a DEPART off the trunk, the SPINE through the
// child's own steps, a TRAIL past main-thread steps that ran while it
// worked, and a MERGE back. Without the trail, a sub-agent reads as
// finished the instant it was spawned.

import { LANE_GAP } from './labyrinthLanes';
import type { BranchModel } from './labyrinthBranches';
import { memberLanes } from './labyrinthCollabIndex';

/** Spacing between branch columns, stacking outward from the delegation lane. */
export const BRANCH_COL_GAP = 40;

/** x of a branch column. Delegation is the LEFT side; columns stack outward. */
export function branchX(spineX: number, column: number): number {
  return spineX - (LANE_GAP + column * BRANCH_COL_GAP);
}

export interface BranchPath {
  /** Unique render key — the span's first step index. */
  first: number;
  /** Leaves the trunk, arriving at the branch head. */
  depart: string;
  /** The branch's own vertical run; null when it carries a single step. */
  spine: string | null;
  /**
   * The IN-FLIGHT stretch: rail past the child's last step, alongside trunk
   * steps that ran before it returned. Null when there is none.
   */
  trail: string | null;
  /** Rejoins the trunk. NULL for a branch that never came back. */
  merge: string | null;
  /** True when this branch never merged — the sub-agent had not returned. */
  open: boolean;
  /** Tri-state; ABSENT when the engine sent no `background` (say nothing). */
  background?: boolean;
  /** x of the rail, so the map can cap an open branch without redoing geometry. */
  x: number;
  /** y the rail ends at: the merge point, or the run's floor when open. */
  endY: number;
}

const r = (n: number): number => Math.round(n * 100) / 100;

/**
 * The rails for each branch, over the same points the markers were laid at.
 * A single-step branch still draws a departure and a merge, as a fact about
 * the run, not an omission.
 */
export function branchPaths(
  points: readonly { x: number; y: number }[],
  model: BranchModel,
  spineX: number,
  rowPitch: number,
): BranchPath[] {
  const half = rowPitch / 2;
  const out: BranchPath[] = [];
  for (const span of model.spans) {
    const head = points[span.first];
    const tail = points[span.last];
    const stop = points[Math.min(span.mergeAt, points.length - 1)];
    if (!head || !tail || !stop) continue;
    const cx = branchX(spineX, span.column);
    const ax = span.parentColumn < 0 ? spineX : branchX(spineX, span.parentColumn);
    // An open branch runs half a row past its last step, so its open end is visible.
    const endY = span.open ? stop.y + half : stop.y;
    out.push({
      first: span.first,
      depart: `M ${r(ax)} ${r(head.y - half)} L ${r(cx)} ${r(head.y)}`,
      spine: span.last > span.first ? `M ${r(cx)} ${r(head.y)} L ${r(cx)} ${r(tail.y)}` : null,
      trail: endY > tail.y ? `M ${r(cx)} ${r(tail.y)} L ${r(cx)} ${r(endY)}` : null,
      merge: span.open ? null : `M ${r(cx)} ${r(endY)} L ${r(ax)} ${r(endY + half)}`,
      open: span.open,
      ...(span.background === undefined ? {} : { background: span.background }),
      x: cx,
      endY,
    });
  }
  return out;
}

// --- Handoff edges (collab maps only) -------------------------------------
//
// A `handoff` marks work passing between members; the map draws it as a
// rail between their lanes only where the target is derivable from what
// the step recorded. Ambiguous or unnamed targets get no edge. Read from
// the preview as `@slug`.

export interface HandoffStep { tool?: string; title?: string; preview?: string; agent?: string; startedAt?: number; endedAt?: number; collabTool?: boolean }

export interface HandoffEdge {
  from: number;
  to: number;
  /** The member the work went to; drawn as the edge's label. */
  target: string;
  d: string;
}

/** The one member this step names as `@slug`, or null for none or many. */
function namedTarget(step: HandoffStep, names: readonly string[]): string | null {
  const text = `${step.title ?? ''} ${step.preview ?? ''}`.toLowerCase();
  const hit = names.filter((n) => n && n !== step.agent
    && new RegExp(`@${n.toLowerCase().replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}([^a-z0-9_-]|$)`).test(text));
  return hit.length === 1 ? hit[0]! : null;
}

/**
 * An edge per derivable handoff: to the first step on the named member's
 * lane that started at or after it ended. No such step means no edge.
 */
export function handoffEdges(
  points: readonly { x: number; y: number }[],
  steps: readonly HandoffStep[],
  members?: readonly string[],
): HandoffEdge[] {
  if (!members?.length) return [];
  const { lane, names } = memberLanes(steps, members);
  const out: HandoffEdge[] = [];
  steps.forEach((step, i) => {
    if (step.collabTool !== true || step.tool !== 'handoff') return;
    const end = step.endedAt;
    const target = namedTarget(step, names);
    if (target === null || typeof end !== 'number' || !Number.isFinite(end)) return;
    const want = names.indexOf(target);
    const to = steps.findIndex((s, j) => lane[j] === want
      && typeof s.startedAt === 'number' && Number.isFinite(s.startedAt) && s.startedAt >= end);
    const a = points[i];
    const b = points[to];
    if (to < 0 || !a || !b) return;
    out.push({ from: i, to, target, d: `M ${r(a.x)} ${r(a.y)} L ${r(b.x)} ${r(b.y)}` });
  });
  return out;
}
