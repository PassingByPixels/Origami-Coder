export * as TodoReconcile from "./todo-reconcile"

/**
 * WHAT A TODOWRITE MEANS WHEN THE MODEL HAS FORGOTTEN HALF OF IT.
 *
 * Every write is a FULL-LIST REPLACE and position is the only identity - there
 * are no ids for a child to point at, so nesting rides on `depth` plus order.
 * That works right up until the window is compacted: the model rewrites the
 * same list from a rendered summary and re-sends every item WITHOUT its depth,
 * so a four-parent outline lands as sixteen flat rows and the tree is gone with
 * no error anywhere. Owner-reproduced on ses_fae2ce20afferpNfEuYnUJtCYF.
 *
 * The same replace lets a second lie through: a parent can arrive `completed`
 * while its own sub-tasks are still open, and nothing in the data says no.
 *
 * Both are fixed HERE rather than in each caller, because both write seams (the
 * v1 engine service and the v2 core service) are twins of one another and a rule
 * taught to one and not the other is a session that behaves differently
 * depending on which runtime answered.
 *
 * FAIL-OPEN, like every other reader of this list: the list that comes in comes
 * out the same length in the same order. A rule that cannot decide leaves the
 * row alone.
 */

/** Deepest level the tree rules recognise. The same ceiling the strip
 *  (packages/vscode/webview/dashboard/components/todoTree.ts), the engine's
 *  bullet renderer and the tool description all name. */
const MAX_DEPTH = 3

/** Statuses that will never change again, so a child in one of them cannot hold
 *  its parent open. `cancelled` and `failed` are outcomes, not open work. */
const TERMINAL = new Set(["completed", "cancelled", "failed"])

/** The fields these rules read, declared structurally so both services' `Info`
 *  and a raw database row pass through unchanged. */
export interface TodoLike {
  readonly content: string
  readonly status: string
  readonly depth?: number
}

/** A depth that can be compared. Anything that is not a real number (absent,
 *  NaN, Infinity) is read as top level - never as a dropped row. */
function depthOf(todo: TodoLike): number {
  return typeof todo.depth === "number" && Number.isFinite(todo.depth) ? todo.depth : 0
}

/**
 * Every row's depth as the TREE reads it, in input order.
 *
 * A MIRROR of `normalizeDepths` in the strip's todoTree.ts, and deliberately so:
 * the two answer the same question ("which rows are under which") for the same
 * list, and parenthood decided here has to match the parenthood the user is
 * looking at. Kept as a copy rather than an import because a webview leaf must
 * not become a runtime dependency of the database layer.
 *
 * Note this is used ONLY to decide parenthood. The depth WRITTEN is still the
 * one the model sent - clamping the stored number would hide the model's own
 * mistake from every reader.
 */
function normalizeDepths(todos: readonly TodoLike[]): number[] {
  const out: number[] = []
  let previous = -1
  for (const todo of todos) {
    const depth = Math.max(0, Math.min(Math.floor(depthOf(todo)), previous + 1, MAX_DEPTH))
    out.push(depth)
    previous = depth
  }
  return out
}

/**
 * Give back the depth an item had last time, when this write does not name one.
 *
 * ABSENT ONLY. An explicit number - 0 included - is the model saying where the
 * row goes, and it wins; only a structurally missing `depth` is a gap to fill.
 *
 * Matching is byte-identical content and nothing else. No fuzzy match: two
 * near-identical task names are two tasks, and guessing between them would move
 * a row under the wrong parent, which is worse than leaving it flat.
 *
 * Matches are CONSUMED, whether or not the incoming row needed the value, so a
 * list with the same content twice maps one-to-one by order instead of every
 * duplicate inheriting the first occurrence's depth.
 */
function carryDepth<T extends TodoLike>(stored: readonly TodoLike[], incoming: readonly T[]) {
  const byContent = new Map<string, number[]>()
  for (const todo of stored) {
    const queue = byContent.get(todo.content)
    if (queue) queue.push(depthOf(todo))
    else byContent.set(todo.content, [depthOf(todo)])
  }
  return incoming.map((todo) => {
    const inherited = byContent.get(todo.content)?.shift()
    const explicit = typeof todo.depth === "number" && Number.isFinite(todo.depth)
    return { ...todo, depth: explicit ? (todo.depth as number) : (inherited ?? 0) }
  })
}

/**
 * Refuse to record a parent as finished while its own sub-tasks are open.
 *
 * A parent's descendants are the unbroken run that follows it at a greater
 * depth - the same rule the strip draws with. If any of them is still `pending`
 * or `in_progress`, a `completed` parent is stored `in_progress` instead: the
 * work under it is demonstrably not done, and a checklist that says otherwise is
 * a lie the next agent reads as fact.
 *
 * Only `completed` is touched, and only downward to `in_progress`. A leaf is
 * never rewritten, and a parent the model marked `cancelled` keeps that - it
 * abandoned the branch rather than claiming it.
 */
function demoteParents<T extends TodoLike & { depth: number }>(items: readonly T[]): T[] {
  const depths = normalizeDepths(items)
  return items.map((item, index) => {
    if (item.status !== "completed") return item
    for (let j = index + 1; j < items.length && depths[j]! > depths[index]!; j++) {
      if (!TERMINAL.has(items[j]!.status)) return { ...item, status: "in_progress" }
    }
    return item
  })
}

/**
 * The list to STORE, given the list already stored and the one just written.
 *
 * Order: carry-forward first, then demotion - the second rule needs the depths
 * the first one restored, or a parent whose nesting the model dropped would look
 * like a leaf and keep its false `completed`.
 */
export function reconcileTodos<T extends TodoLike>(stored: readonly TodoLike[], incoming: readonly T[]) {
  return demoteParents(carryDepth(stored, incoming))
}
