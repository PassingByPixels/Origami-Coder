// A delegated stretch as a branch: it leaves the trunk, runs its own vertical
// segment, and merges back where it actually returned — often after its own
// last step, since sub-agents detach by default. A branch that never
// rejoins is reserved for a run that never came back.
//
// Sibling branches never interleave in list order; overlap is drawn only
// from the spawn's real `endedAt` clock (labyrinthSpans.ts), never guessed.

import { normDepth, type LaneStep } from './labyrinthLanes';
import { mergeIndex, spanBackground, spanIsOpen, type SpanStep } from './labyrinthSpans';
import { lastRowIndex, rowMergeIndex, threadRows } from './labyrinthTime';

/** The part of a step the branch model reads. */
export interface BranchStep extends LaneStep, SpanStep {
  ordinal: number;
  /** OPTIONAL `ordinal` of the spawning subagent step; the engine may omit it. */
  parentOrdinal?: number;
}

/** Branch columns before overflow folds onto the outermost one, capped so a
 *  deep or busy run cannot walk off the left of the viewBox. */
export const MAX_BRANCH_COLUMNS = 4;

export interface BranchSpan {
  /** The spawning step's `ordinal`; negative for a synthesised branch (never real). */
  key: number;
  column: number;
  /** Index of the first step drawn on this branch: the spawn, or the first
   *  orphaned child. Also the render key — unlike `key`, always unique. */
  first: number;
  /** Index of the last step drawn ON this branch. Its rail may run past it. */
  last: number;
  /** Index the rail returns to the trunk: `last`, or later if the spawn's
   *  `endedAt` shows steps ran while it was still going. Meaningless when `open`. */
  mergeAt: number;
  /** True when the sub-agent had not reported back: departed, never merged. */
  open: boolean;
  /** Tri-state `background`; undefined when the engine did not say. */
  background?: boolean;
  /** Column of the trunk this branch hangs off; -1 is the main spine. */
  parentColumn: number;
}

export interface BranchModel {
  /** Per step index: its branch column, or -1 for the trunk. */
  column: number[];
  /** Per step index: the `first` of the branch whose agent produced it, or -1
   *  for the trunk. A spawn's `task` call belongs to its branch's head but its
   *  usage counts toward the parent thread, so per-host totals sum to the run. */
  host: number[];
  spans: BranchSpan[];
}

/** Assign every step to a branch column, allocated when a branch opens and
 *  released once its rail is drawn. Release is keyed on `mergeAt`, not the
 *  last step, so backgrounded siblings stay parallel; an unreturned branch
 *  holds its column to the end of the run. The ledger keys on row, not list
 *  position, since two rails on one row is what it prevents. */
export function branchModel(steps: readonly BranchStep[]): BranchModel {
  const column: number[] = new Array(steps.length).fill(-1);
  const host: number[] = new Array(steps.length).fill(-1);
  const spans: BranchSpan[] = [];
  // open[i] carries the steps at depth i+1; its length is the current nesting.
  const open: BranchSpan[] = [];
  /** Columns with a branch still OPEN on them. */
  const held = new Set<number>();
  /** Per column: the last step index its rail is still drawn on. -1 = free. */
  const freeAt: number[] = new Array(MAX_BRANCH_COLUMNS).fill(-1);
  const FOREVER = Number.MAX_SAFE_INTEGER;
  // The drawn axis: clock rows when the run has a complete one, else list positions.
  const rows = threadRows(steps);
  const row = (at: number): number => (rows ? rows[at]! : at);
  const floor = rows ? lastRowIndex(rows) : Math.max(0, steps.length - 1);

  const take = (at: number): number => {
    for (let c = 0; c < MAX_BRANCH_COLUMNS; c++) {
      if (!held.has(c) && freeAt[c]! < row(at)) {
        held.add(c);
        return c;
      }
    }
    return MAX_BRANCH_COLUMNS - 1; // overflow folds onto the outermost column
  };
  const close = (): void => {
    const span = open.pop();
    if (!span) return;
    const head = steps[span.first];
    span.open = spanIsOpen(head);
    span.background = spanBackground(head);
    span.mergeAt = span.open ? floor
      : rows ? rowMergeIndex(steps, rows, span.first, span.last)
        : mergeIndex(steps, span.first, span.last);
    // Only free a folded-onto column once the LAST branch sharing it has gone.
    if (!open.some((o) => o.column === span.column)) held.delete(span.column);
    // max(): a nested branch may outlive the one it folded onto.
    freeAt[span.column] = Math.max(freeAt[span.column]!, span.open ? FOREVER : row(span.mergeAt));
    spans.push(span);
  };
  const start = (at: number, key: number, parentColumn: number): BranchSpan => ({
    key, column: take(at), first: at, last: at, mergeAt: at, open: false, parentColumn,
  });

  steps.forEach((step, i) => {
    // Clamped so a junk depth cannot open an unbounded stack of branches.
    const depth = Math.min(normDepth(step), MAX_BRANCH_COLUMNS);
    const parent = step.parentOrdinal;
    const key = typeof parent === 'number' && Number.isFinite(parent) ? parent : undefined;

    while (open.length > depth) close();
    // A sibling branch at the same depth: the parent changed under us.
    if (depth > 0 && open.length === depth && key !== undefined) {
      const here = open[depth - 1]!;
      if (here.key >= 0 && here.key !== key) close();
    }
    // A step with `depth` but no `parentOrdinal` still gets its own branch.
    while (open.length < depth) {
      const inner = open.length === depth - 1 && key !== undefined;
      open.push(start(i, inner ? key : -(i + 1), open.length ? open[open.length - 1]!.column : -1));
    }

    if (depth > 0) {
      const here = open[depth - 1]!;
      column[i] = here.column;
      host[i] = here.first;
      here.last = i;
    }
    // A spawn sits at the head of the branch it opens, not its parent's rail.
    if (step.kind === 'subagent') {
      const span = start(i, step.ordinal, depth > 0 ? open[depth - 1]!.column : -1);
      column[i] = span.column;
      open.push(span);
    }
  });
  while (open.length) close();

  spans.sort((a, b) => a.first - b.first);
  return { column, host, spans };
}
