// The ONE renderer that turns the stored todo list into text the model reads.
// It feeds two places - the `${todos}` command substitution and the
// post-compaction reminder - and reminders.ts also COMPARES its output against
// the visible list to decide whether to speak at all, so a change in what it
// emits is a change in when the model gets reminded.
import { describe, expect, test } from "bun:test"
import { renderTodoList, substituteTodos, TODOS_PLACEHOLDER } from "@/session/command-todos"
import type { Todo } from "@/session/todo"

const flat: Todo.Info[] = [
  { content: "reproduce the failure", status: "completed", priority: "high" },
  { content: "fix the parser", status: "in_progress", priority: "high" },
]

describe("renderTodoList", () => {
  // BACK-COMPAT: this is the exact text the renderer produced before nesting,
  // and reminders.ts's "is the model's view already current?" check is a string
  // comparison against it.
  test("renders a list with no depth exactly as it always did", () => {
    expect(renderTodoList(flat)).toBe(
      "- [completed] reproduce the failure (priority: high)\n- [in_progress] fix the parser (priority: high)",
    )
  })

  test("indents a nested item two spaces per level", () => {
    const nested: Todo.Info[] = [
      { content: "parent", status: "in_progress", priority: "high", depth: 0 },
      { content: "child", status: "completed", priority: "high", depth: 1 },
      { content: "grandchild", status: "pending", priority: "low", depth: 2 },
      { content: "sibling", status: "pending", priority: "low", depth: 0 },
    ]
    expect(renderTodoList(nested).split("\n")).toEqual([
      "- [in_progress] parent (priority: high)",
      "  - [completed] child (priority: high)",
      "    - [pending] grandchild (priority: low)",
      "- [pending] sibling (priority: low)",
    ])
  })

  test("caps the indent at three levels and floors a fractional one", () => {
    const odd: Todo.Info[] = [
      { content: "deep", status: "pending", priority: "low", depth: 9 },
      { content: "fractional", status: "pending", priority: "low", depth: 1.8 },
    ]
    expect(renderTodoList(odd).split("\n")).toEqual([
      "      - [pending] deep (priority: low)",
      "  - [pending] fractional (priority: low)",
    ])
  })

  // FAIL-OPEN: a depth the model got wrong costs the line its indent, never its
  // place in the list the model is about to work from.
  test("keeps every line when a depth is negative or not a number", () => {
    const junk = [
      { content: "negative", status: "pending", priority: "low", depth: -2 },
      { content: "nan", status: "pending", priority: "low", depth: Number.NaN },
      { content: "infinite", status: "pending", priority: "low", depth: Number.POSITIVE_INFINITY },
    ] as Todo.Info[]
    expect(renderTodoList(junk).split("\n")).toEqual([
      "- [pending] negative (priority: low)",
      "- [pending] nan (priority: low)",
      "- [pending] infinite (priority: low)",
    ])
  })
})

describe("substituteTodos", () => {
  test("splices the indented list into a template", () => {
    const nested: Todo.Info[] = [
      { content: "parent", status: "pending", priority: "high", depth: 0 },
      { content: "child", status: "pending", priority: "high", depth: 1 },
    ]
    expect(substituteTodos(`Plan:\n${TODOS_PLACEHOLDER}`, nested)).toBe(
      "Plan:\n- [pending] parent (priority: high)\n  - [pending] child (priority: high)",
    )
  })

  test("still tells 'no plan' apart from 'empty plan'", () => {
    expect(substituteTodos(TODOS_PLACEHOLDER, [])).toBe("(no todo list was recorded for this session)")
  })
})
