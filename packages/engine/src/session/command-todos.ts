import type { Todo } from "./todo"

/** Placeholder a command template can include to have the session's todo list
 *  spliced in. Shared so the template file and the substitution code stay pinned
 *  to the same string - if they drift, injection silently no-ops. */
export const TODOS_PLACEHOLDER = "${todos}"

/** Deepest nesting a rendered bullet is indented to - the same ceiling the tool
 *  description states, applied per item, so a list whose depths jump is still
 *  rendered whole. Full normalisation belongs to the reader that builds a tree. */
const MAX_DEPTH = 3

function indent(depth: number | undefined): string {
  if (typeof depth !== "number" || !Number.isFinite(depth)) return ""
  return "  ".repeat(Math.min(MAX_DEPTH, Math.max(0, Math.floor(depth))))
}

/** The todo list as markdown bullets. The ONE renderer, shared by the command
 *  substitution and the post-compaction reminder, which compares rendered
 *  strings to decide whether the model's view is already current. */
export function renderTodoList(items: readonly Todo.Info[]): string {
  return items
    .map(
      (item) =>
        `${indent(item.depth)}- [${item.status}] ${item.content}${item.priority ? ` (priority: ${item.priority})` : ""}`,
    )
    .join("\n")
}

/** Replace {@link TODOS_PLACEHOLDER} with the session's todo list as markdown
 *  bullets, or a fallback when there are none - never a blank line, so a reader
 *  can tell "no plan" apart from "empty plan". A template with no placeholder is
 *  returned unchanged, so this is safe to call unconditionally. */
export function substituteTodos(template: string, items: readonly Todo.Info[]): string {
  if (!template.includes(TODOS_PLACEHOLDER)) return template
  const rendered = items.length === 0 ? "(no todo list was recorded for this session)" : renderTodoList(items)
  return template.replaceAll(TODOS_PLACEHOLDER, rendered)
}
