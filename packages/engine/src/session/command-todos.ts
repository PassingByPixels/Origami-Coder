import type { Todo } from "./todo"

/** Placeholder a command template can include to have the current session's
 *  todo list spliced in. Shared so the template file and the substitution code
 *  stay pinned to the same magic string - if they drift, todo injection
 *  silently no-ops and a plan-adherence critic ends up auditing against nothing. */
export const TODOS_PLACEHOLDER = "${todos}"

/** The todo list as markdown bullets. ONE renderer, shared by the command
 *  substitution and the post-compaction reminder: two renderers would let the
 *  same stored list read differently in the two places the model sees it, and
 *  the reminder compares rendered strings to decide whether the model's view is
 *  already current. */
export function renderTodoList(items: readonly Todo.Info[]): string {
  return items
    .map((item) => `- [${item.status}] ${item.content}${item.priority ? ` (priority: ${item.priority})` : ""}`)
    .join("\n")
}

/** Replace {@link TODOS_PLACEHOLDER} in a command template with the session's
 *  todo list rendered as markdown bullets, or a clear fallback when there are
 *  none (never a blank line - the critic must be able to tell "no plan" apart
 *  from "empty plan"). Returns the template unchanged when it has no
 *  placeholder, so it is safe to call unconditionally. Kept pure and free of the
 *  prompt.ts service graph so it is trivially unit-testable. */
export function substituteTodos(template: string, items: readonly Todo.Info[]): string {
  if (!template.includes(TODOS_PLACEHOLDER)) return template
  const rendered = items.length === 0 ? "(no todo list was recorded for this session)" : renderTodoList(items)
  return template.replaceAll(TODOS_PLACEHOLDER, rendered)
}
