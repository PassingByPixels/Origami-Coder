// What a flat todo list MEANS as a tree, and what the strip shows about it.
//
// Nesting arrives as an optional `depth` on each row rather than a parent id,
// because the list has no ids: it is stored full-list-replace with the array
// index as identity, so there is nothing stable for a child to point at. Depth
// composes with that — children sit directly after their parent, which is the
// order a model writes an outline in anyway.
//
// A LEAF: no DOM, no imports, no `vscode`. That is the point. The two rules
// worth getting right (what a malformed depth becomes, and how many children a
// row owns) are then assertions rather than a rendered component, and jsdom's
// missing layout engine cannot make an indent test pass by accident.
//
// FAIL-OPEN throughout: every input list comes out the same length, in the same
// order. A depth the model got wrong costs that row its indent, never its place
// in the plan.

/** The deepest a row may sit. Mirrored in the tool description the model reads
 *  (packages/engine/src/tool/todowrite.txt) and in the engine's own bullet
 *  renderer (packages/engine/src/session/command-todos.ts). */
export const MAX_DEPTH = 3;

/** Pixels of left padding per level. One place, so the strip and its tests
 *  cannot disagree about what "indented" means. */
export const INDENT_PX = 14;

/** The fields this module reads. Declared structurally so it stays a leaf —
 *  the strip's own row type is a superset and passes through unchanged. */
export interface TodoLike {
  status: string;
  depth?: number;
}

/** What the strip needs that the row itself does not carry. */
export interface TodoAnnotation {
  /** The row's depth AFTER normalisation — safe to multiply by INDENT_PX. */
  depth: number;
  /** Completed descendants, direct and transitive. */
  childDone: number;
  /** All descendants, direct and transitive. 0 means the row is a leaf. */
  childTotal: number;
}

/**
 * Every row's depth, normalised, in input order.
 *
 * The rules, and why each one exists:
 * - not a finite number (absent, NaN, Infinity, a string that slipped through)
 *   -> 0. The row is flat, not gone.
 * - fractional -> floored; negative -> 0. A depth is a level, not a measurement.
 * - never more than one level below the row before it. A list that jumps 0 -> 2
 *   describes a child of a parent that is not there; rendering it two levels in
 *   would draw an indent under nothing.
 * - never deeper than MAX_DEPTH. Past three levels the indent costs more content
 *   width than the structure is worth in a strip this narrow.
 * - the first row is always 0: there is nothing above it to be a child of.
 */
export function normalizeDepths(todos: readonly TodoLike[]): number[] {
  const out: number[] = [];
  let previous = -1;
  for (const todo of todos) {
    const raw = todo.depth;
    const floor = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : 0;
    const depth = Math.max(0, Math.min(floor, previous + 1, MAX_DEPTH));
    out.push(depth);
    previous = depth;
  }
  return out;
}

/**
 * The rows with their normalised depth and their subtree tallies attached.
 *
 * A row's descendants are the unbroken run that follows it at a GREATER depth —
 * which is exactly what depth-plus-order means, and why no id is needed. The
 * tallies are transitive: a parent of a parent counts its grandchildren too, so
 * the top of a plan reports the whole plan rather than its first level only.
 *
 * `status` is read but never written. A parent's status is whatever the model
 * set it to; deriving "done" from the children would silently disagree with the
 * model's own view of its plan, and the count is there to show that disagreement
 * rather than paper over it.
 */
export function annotate<T extends TodoLike>(todos: readonly T[]): (T & TodoAnnotation)[] {
  const depths = normalizeDepths(todos);
  return todos.map((todo, i) => {
    let childDone = 0;
    let childTotal = 0;
    for (let j = i + 1; j < todos.length && depths[j] > depths[i]; j++) {
      childTotal++;
      if (todos[j].status === 'completed') childDone++;
    }
    return { ...todo, depth: depths[i], childDone, childTotal };
  });
}

/**
 * Status tally for the strip's header, over LEAVES ONLY.
 *
 * A row with children is a CONTAINER, not work. Counting it as well counts the
 * same plan twice — once as the major and once as everything under it — so one
 * major over two sub-tasks read as three tasks, and a header could sit at
 * "3/5 done" with nothing left to do. `total` is the leaf count the three
 * tallies add up to, so a caller does not have to re-derive which rows it lost.
 *
 * A row has children exactly when the row AFTER it is deeper: the same subtree
 * rule `annotate` walks, seen one step at a time. Read off the normalised
 * depths, so a jump the model got wrong groups the way it is drawn.
 */
export function counts(items: readonly TodoLike[]) {
  const depths = normalizeDepths(items);
  let pending = 0;
  let in_progress = 0;
  let completed = 0;
  let total = 0;
  items.forEach((t, i) => {
    if (i + 1 < items.length && depths[i + 1] > depths[i]) return;
    total++;
    if (t.status === 'pending') pending++;
    else if (t.status === 'in_progress') in_progress++;
    else completed++;
  });
  return { pending, in_progress, completed, total };
}
