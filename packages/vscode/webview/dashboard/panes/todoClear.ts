// todoClear.ts — "Clear completed" on the Todo panel: WHICH rows a click hides,
// and for how long.
//
// The list belongs to the MODEL. `todowrite` replaces it whole, the desk never
// writes it back, and the panel is a reader — so clearing cannot delete
// anything. It is a VIEW FILTER, and that is the whole reason this file exists:
// the rule is "hide the rows that were completed at the moment of the click",
// which is a sentence about a set of keys, not about a list.
//
// WHY CONTENT + STATUS IS THE KEY. A row has no stable id — the wire's `id` is
// its index in the array the model last wrote (acpTodoWrite.ts), so the third
// item is `2` today and something else after the next rewrite. Keying on the
// index would hide whatever happens to land there. Keying on the content ALONE
// would hide a row the model later REOPENS, which is the one case the owner
// must see. Content plus status is both: the same finished row stays hidden
// across re-renders, and the moment its status changes it is a different key
// and comes back.
//
// A pure leaf beside todoTree.ts and todoCollapse.ts, and for their reason: the
// cases worth getting right (a reopened row, a new row with the same words) are
// assertions, not a render. Nothing here touches the DOM or the wire — the
// hidden set is webview state the host is never told about.

/** The fields this module reads. Structural, so the panel's row type stays a
 *  superset and passes through untouched. */
export interface ClearableTodo {
  content: string;
  status: string;
}

/** One row's identity for the hidden set. JSON, so a content string that
 *  happens to contain the separator cannot forge another row's key. */
export function clearKey(todo: ClearableTodo): string {
  return JSON.stringify([todo.status, todo.content]);
}

/** Is there anything left for the control to do? FALSE disables the button —
 *  the list is read against what is still on screen, so a second click on an
 *  already-cleared list is offered as dead rather than as a no-op. */
export function hasCompleted(todos: readonly ClearableTodo[]): boolean {
  return todos.some((t) => t.status === 'completed');
}

/** What ONE click hides: every row completed right now. Deliberately read at
 *  the click and never re-read — a row the model finishes a second later was
 *  not on screen when the owner pressed the button. */
export function completedKeys(todos: readonly ClearableTodo[]): string[] {
  return todos.filter((t) => t.status === 'completed').map(clearKey);
}

/** The list as the panel draws it: input order, minus the hidden keys. Every
 *  other row survives, including one that merely LOOKS finished — only a key
 *  the owner actually cleared is dropped. */
export function hiddenAfterClear<T extends ClearableTodo>(
  todos: readonly T[],
  hidden: ReadonlySet<string>,
): T[] {
  if (hidden.size === 0) return [...todos];
  return todos.filter((t) => !hidden.has(clearKey(t)));
}

/** The hidden set for ONE list, out of the per-list record the pane keeps.
 *  A list nobody has cleared has no entry, which is an empty set, not a bug. */
export function hiddenSet(byList: Record<string, string[]> | undefined, listId: string): ReadonlySet<string> {
  return new Set(byList?.[listId] ?? []);
}

/** The pane's record with `keys` added to `listId`'s set, deduplicated and with
 *  every other list left alone. Returned fresh rather than mutated, because the
 *  pane's session objects are re-assigned to trigger a re-render. */
export function withCleared(
  byList: Record<string, string[]> | undefined,
  listId: string,
  keys: readonly string[],
): Record<string, string[]> {
  return { ...(byList ?? {}), [listId]: [...new Set([...(byList?.[listId] ?? []), ...keys])] };
}
