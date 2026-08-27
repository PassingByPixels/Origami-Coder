// A delegated stretch as a BRANCH: it leaves the trunk, runs its own vertical
// segment through that sub-agent's steps, and MERGES BACK where the sub-agent
// actually returned — which, now that sub-agents detach by default, is often
// well after its own last step. Both ends are drawn; a branch that departs and
// never rejoins is reserved for the run that genuinely never came back.
//
// Split out of labyrinthLayout.ts (at its architecture cap); that file stays
// "where does a point go", this one is "which thread is a point ON". The rails
// themselves moved to labyrinthRails.ts and the timing rules to
// labyrinthSpans.ts when this file reached its own cap. Pure, so the whole
// model is testable without a DOM.
//
// NO FAKED OVERLAP — but no faked SEQUENCE either. `run_steps` inlines a
// child's steps immediately after the spawning step (engine `collect`), so in
// list order sibling branches never interleave. That ordering used to be the
// whole story, because a sub-agent blocked. It no longer is: the spawn's real
// `endedAt` is stitched on from the completion the engine injected, and where
// it post-dates later main-thread steps those steps genuinely ran while the
// branch was still working. Overlap is drawn ONLY from that clock, never
// guessed — see labyrinthSpans.ts.

import { normDepth, type LaneStep } from './labyrinthLanes';
import { mergeIndex, spanBackground, spanIsOpen, type SpanStep } from './labyrinthSpans';
import { lastRowIndex, rowMergeIndex, threadRows } from './labyrinthTime';

/** The part of a step the branch model reads. */
export interface BranchStep extends LaneStep, SpanStep {
  ordinal: number;
  /** OPTIONAL `ordinal` of the spawning subagent step; the engine may omit it. */
  parentOrdinal?: number;
}

/**
 * Distinct branch columns before overflow folds onto the outermost one. A cap
 * is what stops a deep or busy run walking off the left of the viewBox; the
 * engine's own MAX_SUBAGENT_DEPTH is 2, so 4 is already generous.
 */
export const MAX_BRANCH_COLUMNS = 4;

export interface BranchSpan {
  /** The spawning step's `ordinal`; negative for a branch synthesised from a
   *  bare `depth` (see below), which is never a real ordinal. */
  key: number;
  column: number;
  /** Index of the first step drawn on this branch — the spawn, or the first
   *  orphaned child when there was no spawn to hang off. Also the render key:
   *  unlike `key` it is unique by construction. */
  first: number;
  /** Index of the last step drawn ON this branch. Its rail may run past it. */
  last: number;
  /**
   * Index the rail returns to the trunk at: `last`, or later when the spawn's
   * `endedAt` proves main-thread steps ran while the sub-agent was still going.
   * Meaningless when `open` — nothing merged.
   */
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
  /**
   * Per step index: the `first` of the branch whose AGENT produced it, or -1
   * for the trunk. Deliberately NOT the same as `column` for a spawn: a `task`
   * call is drawn at the head of the branch it opens but was made BY the thread
   * above it, and its message's usage is that thread's spend, not the
   * sub-agent's. Every index has exactly one host, so per-host totals partition
   * the run — which is what makes "main + branches = run" checkable rather than
   * asserted.
   */
  host: number[];
  spans: BranchSpan[];
}

/**
 * Assign every step to a branch column.
 *
 * Columns are ALLOCATED when a branch opens and RELEASED once its rail has
 * finished being drawn, so 25 sequential sub-agents reuse one column instead of
 * producing 25. Release is keyed on `mergeAt`, NOT on the branch's last step:
 * three tasks backgrounded together stay visually parallel because none of them
 * frees its column while another's rail still runs down it. A branch that never
 * returned holds its column to the end of the run, which is the truth about it.
 *
 * The ledger is keyed on the ROW a rail reaches, not on a list position. Thread
 * orders its rows by clock whenever it can (labyrinthTime.ts), so two branches
 * whose list ranges do not overlap can still be drawn over each other — and two
 * rails on one x is the one thing this ledger exists to prevent. With no usable
 * clock, row IS list position and every rule below behaves exactly as before.
 */
export function branchModel(steps: readonly BranchStep[]): BranchModel {
  const column: number[] = new Array(steps.length).fill(-1);
  const host: number[] = new Array(steps.length).fill(-1);
  const spans: BranchSpan[] = [];
  // open[i] carries the steps at depth i+1; its length IS the current nesting.
  const open: BranchSpan[] = [];
  /** Columns with a branch still OPEN on them. */
  const held = new Set<number>();
  /** Per column: the last step index its rail is still drawn on. -1 = free. */
  const freeAt: number[] = new Array(MAX_BRANCH_COLUMNS).fill(-1);
  const FOREVER = Number.MAX_SAFE_INTEGER;
  // The drawn axis: clock rows when the run carries a complete one, else the
  // list positions this model has always used.
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
    // A sibling branch at the same depth: the parent changed under us, so the
    // previous one has ended even though no depth-0 step separated them.
    if (depth > 0 && open.length === depth && key !== undefined) {
      const here = open[depth - 1]!;
      if (here.key >= 0 && here.key !== key) close();
    }
    // The engine may send `depth` without `parentOrdinal`. Such a step still
    // belongs OFF the spine, so it gets a branch rather than being dropped
    // back onto the trunk — the exact failure this whole model replaces.
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
    // A spawn sits at the HEAD of the branch it opens, not on its parent's
    // rail — that head is where the departure line lands.
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
