// The v1 engine's todo write seam, and the two things it has to do for a model
// that cannot see its own list any more.
//
// A TWIN of packages/core/test/session-todo.test.ts by design: the two services
// write the SAME table with the same rules, and a rule taught to one and not the
// other is a session that behaves differently depending on which runtime
// answered. The rules themselves are asserted once, on the pure module
// (core/test/session-todo-reconcile.test.ts); what is checked here is that this
// seam is wired to them.

import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Database } from "@origami/core/database/database"
import { AppNodeBuilder } from "@origami/core/effect/app-node-builder"
import { LayerNode } from "@origami/core/effect/layer-node"
import { Project } from "@origami/core/project"
import { ProjectTable } from "@origami/core/project/sql"
import { AbsolutePath } from "@origami/core/schema"
import { SessionTable } from "@origami/core/session/sql"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Todo } from "@/session/todo"
import { SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2Bridge.node, Todo.node])))
const sessionID = SessionID.make("ses_engine_todo_test")

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "todo",
      directory: "/project",
      title: "todo",
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
})

describe("Todo (v1 engine)", () => {
  // THE COMPACTION REPRO. The todowrite call goes with the dropped head, the
  // model rebuilds the list from the rendered reminder, and every `depth` is
  // missing - so its own next write flattens the tree it just described.
  it.effect("carries a dropped depth forward from the row already stored", () =>
    Effect.gen(function* () {
      yield* setup
      const todos = yield* Todo.Service
      yield* todos.update({
        sessionID,
        todos: [
          { content: "major one", status: "in_progress", priority: "high", depth: 0 },
          { content: "sub a", status: "completed", priority: "high", depth: 1 },
          { content: "sub b", status: "pending", priority: "medium", depth: 1 },
        ],
      })

      yield* todos.update({
        sessionID,
        todos: [
          { content: "major one", status: "in_progress", priority: "high" },
          { content: "sub a", status: "completed", priority: "high" },
          { content: "sub b", status: "pending", priority: "medium" },
        ],
      })
      expect((yield* todos.get(sessionID)).map((todo) => todo.depth)).toEqual([0, 1, 1])
    }),
  )

  it.effect("lets an explicit depth override the stored one", () =>
    Effect.gen(function* () {
      yield* setup
      const todos = yield* Todo.Service
      yield* todos.update({
        sessionID,
        todos: [
          { content: "parent", status: "pending", priority: "low", depth: 0 },
          { content: "child", status: "pending", priority: "low", depth: 1 },
        ],
      })
      yield* todos.update({
        sessionID,
        todos: [
          { content: "parent", status: "pending", priority: "low", depth: 0 },
          { content: "child", status: "pending", priority: "low", depth: 0 },
        ],
      })
      expect((yield* todos.get(sessionID)).map((todo) => todo.depth)).toEqual([0, 0])
    }),
  )

  it.effect("stores a completed parent as in_progress while a child is still open", () =>
    Effect.gen(function* () {
      yield* setup
      const todos = yield* Todo.Service
      yield* todos.update({
        sessionID,
        todos: [
          { content: "major", status: "completed", priority: "high", depth: 0 },
          { content: "sub", status: "pending", priority: "high", depth: 1 },
        ],
      })
      expect((yield* todos.get(sessionID)).map((todo) => todo.status)).toEqual(["in_progress", "pending"])
    }),
  )

  it.effect("keeps a completed parent completed once every child is terminal", () =>
    Effect.gen(function* () {
      yield* setup
      const todos = yield* Todo.Service
      yield* todos.update({
        sessionID,
        todos: [
          { content: "major", status: "completed", priority: "high", depth: 0 },
          { content: "done", status: "completed", priority: "high", depth: 1 },
          { content: "dropped", status: "cancelled", priority: "low", depth: 1 },
        ],
      })
      expect((yield* todos.get(sessionID)).map((todo) => todo.status)).toEqual([
        "completed",
        "completed",
        "cancelled",
      ])
    }),
  )

  // BACK-COMPAT: the shape every stored list had before nesting. Nothing here
  // inherits, nothing here is demoted, and the list reads back flat and whole.
  it.effect("writes a flat list unchanged", () =>
    Effect.gen(function* () {
      yield* setup
      const todos = yield* Todo.Service
      yield* todos.update({
        sessionID,
        todos: [
          { content: "one", status: "completed", priority: "low" },
          { content: "two", status: "in_progress", priority: "high" },
        ],
      })
      expect(yield* todos.get(sessionID)).toEqual([
        { content: "one", status: "completed", priority: "low", depth: 0 },
        { content: "two", status: "in_progress", priority: "high", depth: 0 },
      ])
    }),
  )
})
