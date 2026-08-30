// WHICH ROWS A SHUT BRANCH STILL SHOWS, and which branches open shut.
//
// A major with sub-tasks under it is a CONTAINER, not a work item: it groups
// the steps, and once every step under it has settled there is nothing left to
// read there. So the strip treats it like a folder — a twisty, a subtree that
// goes away with it, and a branch that opens already shut when it is finished.
//
// A LEAF, like todoTree.ts beside it: no DOM, no imports beyond the tree shapes,
// no `vscode`. That is what lets "the sub-tasks are hidden" be an assertion
// about which rows exist rather than a computed style jsdom cannot produce.
//
// Extracted rather than folded into todoTree.ts, which sits under a 140-line cap
// the ratchet will not let this grow through. The split is a real seam anyway:
// todoTree answers what the depths MEAN, this answers what is on screen.

import type { TodoAnnotation, TodoLike } from './todoTree';

/** Statuses that will not change again. `cancelled` and `failed` are outcomes,
 *  not open work, so a branch holding only those is finished — the same rule the
 *  write seam uses to decide whether a parent may be recorded `completed`
 *  (packages/core/src/session/todo-reconcile.ts). */
const TERMINAL = new Set(['completed', 'cancelled', 'failed']);

/** The rows this module reads: a row's status plus the tree facts `annotate`
 *  attached to it. */
export type CollapseRow = TodoLike & TodoAnnotation;

/**
 * Which parents START collapsed, one flag per row in input order.
 *
 * A parent is shut when it HAS descendants and every one of them has settled.
 * That is the branch with nothing left to watch; anything still `pending` or
 * `in_progress` is live work and stays on screen, however deep it sits — a
 * grandparent is held open by a single open grandchild.
 *
 * A leaf is never shut: there is nothing under it to hide.
 */
export function autoCollapsed(rows: readonly CollapseRow[]): boolean[] {
  return rows.map((row, i) => {
    if (row.childTotal === 0) return false;
    for (let j = i + 1; j < rows.length && rows[j].depth > row.depth; j++) {
      if (!TERMINAL.has(rows[j].status)) return false;
    }
    return true;
  });
}

/**
 * The rows to render, given which of them are collapsed.
 *
 * A row is dropped when ANY ancestor is collapsed, not only its direct parent:
 * the whole subtree goes with the row that shut. A flag on a LEAF is ignored, so
 * a stale choice carried over from a list that has since changed shape can never
 * make rows disappear — the worst it does is nothing.
 */
export function visible<T extends TodoAnnotation>(rows: readonly T[], collapsed: readonly boolean[]): T[] {
  const out: T[] = [];
  let hiddenBelow: number | null = null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (hiddenBelow !== null && row.depth > hiddenBelow) continue;
    hiddenBelow = row.childTotal > 0 && collapsed[i] === true ? row.depth : null;
    out.push(row);
  }
  return out;
}
