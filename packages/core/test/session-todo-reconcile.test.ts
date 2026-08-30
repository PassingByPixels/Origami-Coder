// The two rules a full-list-replace todo write needs and cannot get from the
// model, as assertions rather than as a database.
//
// Both exist because position is the ONLY identity: the model rewrites the whole
// list every time, so anything it forgets is gone. After a compaction it rewrites
// from a rendered summary and drops every `depth` (owner-reproduced), and nothing
// stops it marking a parent done while its sub-tasks are still open.
//
// The invariant behind every case: the list that goes in comes out the same
// length, in the same order, with every other field untouched.

import { describe, expect, it } from "bun:test"
import { TodoReconcile } from "@origami/core/session/todo-reconcile"

const todo = (content: string, status = "pending", depth?: number) =>
  depth === undefined ? { content, status, priority: "medium" } : { content, status, priority: "medium", depth }

const shape = (items: ReadonlyArray<{ content: string; status: string; depth: number }>) =>
  items.map((item) => [item.content, item.status, item.depth])

describe("reconcileTodos - depth carry-forward", () => {
  // THE REPRO. Compaction takes the todowrite call with it, the model re-emits
  // the same 4 items from the rendered reminder, and every `depth` is missing.
  it("restores the tree when a post-compaction rewrite drops every depth", () => {
    const stored = [todo("major one", "in_progress", 0), todo("sub a", "completed", 1), todo("sub b", "pending", 1)]
    const rewritten = [todo("major one", "in_progress"), todo("sub a", "completed"), todo("sub b", "pending")]
    expect(TodoReconcile.reconcileTodos(stored, rewritten).map((t) => t.depth)).toEqual([0, 1, 1])
  })

  it("keeps an EXPLICIT depth even when the stored row disagrees", () => {
    const stored = [todo("parent", "pending", 0), todo("child", "pending", 1)]
    const incoming = [todo("parent", "pending", 0), todo("child", "pending", 0)]
    expect(TodoReconcile.reconcileTodos(stored, incoming).map((t) => t.depth)).toEqual([0, 0])
  })

  // An explicit 0 is the model SAYING top level. Only a structurally absent
  // field is a gap, so this must not be read as "no depth, go and inherit 1".
  it("treats an explicit 0 as a decision, not as an absent field", () => {
    const stored = [todo("root", "pending", 0), todo("promoted", "pending", 1)]
    const incoming = [todo("root", "pending", 0), todo("promoted", "pending", 0)]
    expect(TodoReconcile.reconcileTodos(stored, incoming)[1]!.depth).toBe(0)
  })

  it("leaves a NEW task flat - there is nothing to inherit from", () => {
    const stored = [todo("parent", "pending", 0), todo("child", "pending", 1)]
    const incoming = [todo("parent", "pending"), todo("child", "pending"), todo("brand new", "pending")]
    expect(TodoReconcile.reconcileTodos(stored, incoming).map((t) => t.depth)).toEqual([0, 1, 0])
  })

  // Content is the only key, so duplicates have to pair up BY ORDER or the
  // second "run the tests" would inherit the first one's level.
  it("maps duplicate contents one-to-one by order, consuming each match once", () => {
    const stored = [
      todo("run the tests", "completed", 1),
      todo("run the tests", "pending", 2),
      todo("run the tests", "pending", 0),
    ]
    const incoming = [todo("run the tests"), todo("run the tests"), todo("run the tests")]
    expect(TodoReconcile.reconcileTodos(stored, incoming).map((t) => t.depth)).toEqual([1, 2, 0])
  })

  it("runs out of matches rather than reusing one", () => {
    const stored = [todo("deploy", "pending", 2)]
    const incoming = [todo("deploy"), todo("deploy")]
    expect(TodoReconcile.reconcileTodos(stored, incoming).map((t) => t.depth)).toEqual([2, 0])
  })

  // A DESIGN CHOICE beyond "absent inherits": an item that named its own depth
  // still CONSUMES its content's match, so the i-th "run the tests" in the write
  // pairs with the i-th "run the tests" in the store. Without it the explicit row
  // would leave its slot behind and the next duplicate would inherit the wrong
  // level - one-to-one by order is the whole reason matches are consumed.
  it("consumes a match even when the row named its own depth", () => {
    const stored = [todo("step", "pending", 0), todo("step", "pending", 2)]
    const incoming = [todo("step", "pending", 1), todo("step", "pending")]
    expect(TodoReconcile.reconcileTodos(stored, incoming).map((t) => t.depth)).toEqual([1, 2])
  })

  // `Schema.Number` accepts NaN and Infinity, and the OLD write put whatever
  // arrived straight into an integer column. Neither is a level, so both are
  // read as "named no depth" and go down the inherit path instead.
  it("treats NaN and Infinity as an absent depth, not as an explicit one", () => {
    const stored = [todo("a", "pending", 1), todo("b", "pending", 2)]
    const incoming = [
      { content: "a", status: "pending", priority: "low", depth: Number.NaN },
      { content: "b", status: "pending", priority: "low", depth: Number.POSITIVE_INFINITY },
    ]
    expect(TodoReconcile.reconcileTodos(stored, incoming).map((t) => t.depth)).toEqual([1, 2])
  })

  it("matches on bytes only - a renamed task does not inherit", () => {
    const stored = [todo("parent", "pending", 0), todo("Write the docs", "pending", 1)]
    const incoming = [todo("parent", "pending"), todo("write the docs", "pending")]
    expect(TodoReconcile.reconcileTodos(stored, incoming)[1]!.depth).toBe(0)
  })

  it("inherits nothing when there is no stored list at all", () => {
    expect(TodoReconcile.reconcileTodos([], [todo("first"), todo("second")]).map((t) => t.depth)).toEqual([0, 0])
  })

  it("returns nothing for an empty write, whatever was stored", () => {
    expect(TodoReconcile.reconcileTodos([todo("gone", "pending", 1)], [])).toEqual([])
  })

  it("keeps every other field of the row it was given", () => {
    const stored = [{ content: "a", status: "pending", depth: 2 }]
    const incoming = [{ content: "a", status: "pending", priority: "high", activeForm: "Doing a" }]
    expect(TodoReconcile.reconcileTodos(stored, incoming)[0]).toEqual({
      content: "a",
      status: "pending",
      priority: "high",
      activeForm: "Doing a",
      depth: 2,
    })
  })
})

describe("reconcileTodos - parent demotion", () => {
  it("demotes a completed parent whose child is still pending", () => {
    const incoming = [todo("major", "completed", 0), todo("sub", "pending", 1)]
    expect(shape(TodoReconcile.reconcileTodos([], incoming))).toEqual([
      ["major", "in_progress", 0],
      ["sub", "pending", 1],
    ])
  })

  it("demotes a completed parent whose child is in_progress", () => {
    const incoming = [todo("major", "completed", 0), todo("sub", "in_progress", 1)]
    expect(TodoReconcile.reconcileTodos([], incoming)[0]!.status).toBe("in_progress")
  })

  it("leaves a completed parent alone when every child is terminal", () => {
    const incoming = [
      todo("major", "completed", 0),
      todo("done", "completed", 1),
      todo("dropped", "cancelled", 1),
      todo("broke", "failed", 1),
    ]
    expect(TodoReconcile.reconcileTodos([], incoming)[0]!.status).toBe("completed")
  })

  // Transitive, like the strip's own tally: the top of a plan answers for the
  // whole plan, not only for its first level.
  it("demotes a grandparent held open by a GRANDCHILD", () => {
    const incoming = [
      todo("root", "completed", 0),
      todo("branch", "completed", 1),
      todo("leaf", "pending", 2),
    ]
    expect(TodoReconcile.reconcileTodos([], incoming).map((t) => t.status)).toEqual([
      "in_progress",
      "in_progress",
      "pending",
    ])
  })

  it("never touches a completed LEAF", () => {
    const incoming = [todo("one", "completed", 0), todo("two", "pending", 0)]
    expect(TodoReconcile.reconcileTodos([], incoming).map((t) => t.status)).toEqual(["completed", "pending"])
  })

  it("stops a subtree at the next row of equal depth - a sibling cannot hold a parent open", () => {
    const incoming = [
      todo("first", "completed", 0),
      todo("its child", "completed", 1),
      todo("second", "pending", 0),
    ]
    expect(TodoReconcile.reconcileTodos([], incoming)[0]!.status).toBe("completed")
  })

  it("does not promote a cancelled parent that still has open children", () => {
    const incoming = [todo("abandoned", "cancelled", 0), todo("sub", "pending", 1)]
    expect(TodoReconcile.reconcileTodos([], incoming)[0]!.status).toBe("cancelled")
  })

  // Order matters: the depths have to be restored BEFORE parenthood is decided,
  // or a post-compaction rewrite looks like a flat list of leaves and the false
  // `completed` sails through.
  it("demotes on the CARRIED depths, not on the ones the rewrite sent", () => {
    const stored = [todo("major", "in_progress", 0), todo("sub", "pending", 1)]
    const rewritten = [todo("major", "completed"), todo("sub", "pending")]
    expect(shape(TodoReconcile.reconcileTodos(stored, rewritten))).toEqual([
      ["major", "in_progress", 0],
      ["sub", "pending", 1],
    ])
  })

  // Parenthood is read off the NORMALISED depths (the strip's rule), so a jump
  // the model got wrong still describes the tree the user is looking at.
  it("reads parenthood off normalised depths, so a jumped depth is still a child", () => {
    const incoming = [todo("major", "completed", 0), todo("sub", "pending", 3)]
    expect(TodoReconcile.reconcileTodos([], incoming)[0]!.status).toBe("in_progress")
  })
})
