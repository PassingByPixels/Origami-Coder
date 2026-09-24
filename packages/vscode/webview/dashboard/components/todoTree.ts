// What a flat todo list means as a tree, and what the strip shows about it.
//
// Nesting arrives as an optional `depth` on each row rather than a parent
// id, since the list has no ids (stored full-list-replace with the array
// index as identity). Depth composes with that: children sit directly after
// their parent, the order a model writes an outline in anyway.
//
// A leaf: no DOM, no imports, no `vscode`, so the two rules worth getting
// right (what a malformed depth becomes, how many children a row owns) are
// assertions rather than a rendered component, and jsdom's missing layout
// engine can't make an indent test pass by accident.
//
// Fail-open throughout: every input list comes out the same length, in the
// same order. A depth the model got wrong costs that row its indent, never
// its place in the plan.

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

/** Every row's depth, normalised, in input order:
 *  - not a finite number -> 0 (the row is flat, not gone).
 *  - fractional -> floored; negative -> 0.
 *  - never more than one level below the row before it, or a jump 0 -> 2
 *    would draw an indent under a parent that isn't there.
 *  - never deeper than MAX_DEPTH.
 *  - the first row is always 0. */
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

/** The rows with their normalised depth and subtree tallies attached. A
 *  row's descendants are the unbroken run that follows it at a greater
 *  depth, transitively, so a grandparent reports the whole plan. `status` is
 *  read but never written: deriving "done" from children would silently
 *  disagree with the model's own view of its plan. */
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

/** Status tally for the strip's header, over leaves only. A row with
 *  children is a container, not work — counting it too would count the same
 *  plan twice. A row has children exactly when the row after it is deeper,
 *  read off the normalised depths so a jump the model got wrong groups the
 *  way it's drawn. */
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
