import { describe, expect } from "bun:test"
import { asc } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@origami/core/database/database"
import { LayerNode } from "@origami/core/effect/layer-node"
import { AppNodeBuilder } from "@origami/core/effect/app-node-builder"
import { EventV2 } from "@origami/core/event"
import { Project } from "@origami/core/project"
import { ProjectTable } from "@origami/core/project/sql"
import { AbsolutePath } from "@origami/core/schema"
import { SessionV2 } from "@origami/core/session"
import { SessionTable, TodoTable } from "@origami/core/session/sql"
import { SessionTodo } from "@origami/core/session/todo"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionTodo.node])))
const sessionID = SessionV2.ID.make("ses_todo_test")

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

describe("SessionTodo", () => {
  it.effect("replaces persisted todos in order and publishes updates", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const todos = yield* SessionTodo.Service
      const published = new Array<EventV2.Payload>()
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          if (event.type === SessionTodo.Event.Updated.type) published.push(event)
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)

      yield* todos.update({
        sessionID,
        todos: [
          { content: "second", status: "pending", priority: "low" },
          { content: "first", status: "in_progress", priority: "high" },
        ],
      })
      // A write that names no depth reads back flat - the shape every stored
      // list had before the column existed.
      expect(yield* todos.get(sessionID)).toEqual([
        { content: "second", status: "pending", priority: "low", depth: 0 },
        { content: "first", status: "in_progress", priority: "high", depth: 0 },
      ])
      expect(
        (yield* db.select().from(TodoTable).orderBy(asc(TodoTable.position)).all().pipe(Effect.orDie)).map((row) => ({
          content: row.content,
          position: row.position,
          depth: row.depth,
        })),
      ).toEqual([
        { content: "second", position: 0, depth: 0 },
        { content: "first", position: 1, depth: 0 },
      ])

      yield* todos.update({ sessionID, todos: [{ content: "replacement", status: "completed", priority: "medium" }] })
      expect(yield* todos.get(sessionID)).toEqual([
        { content: "replacement", status: "completed", priority: "medium", depth: 0 },
      ])

      yield* todos.update({ sessionID, todos: [] })
      expect(yield* todos.get(sessionID)).toEqual([])
      // The event carries what was STORED, not what arrived: every row has its
      // resolved depth, so a subscriber rendering the event and one re-reading
      // the table cannot disagree about the same write.
      expect(published.map((event) => event.data)).toEqual([
        {
          sessionID,
          todos: [
            { content: "second", status: "pending", priority: "low", depth: 0 },
            { content: "first", status: "in_progress", priority: "high", depth: 0 },
          ],
        },
        { sessionID, todos: [{ content: "replacement", status: "completed", priority: "medium", depth: 0 }] },
        { sessionID, todos: [] },
      ])
    }),
  )

  // Nesting is stored as a depth per row rather than a parent reference,
  // because a row has no identity to reference: the list is replaced whole on
  // every write and its ONLY identity is the position. Depth composes with
  // that; an id would have to be invented and then kept stable across a
  // full-list replace, which nothing here does.
  it.effect("persists depth through a write and reads it back in list order", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const todos = yield* SessionTodo.Service

      // The grandchild is COMPLETED, not pending: a completed `child` sitting
      // over an open grandchild is exactly the lie the write seam now refuses
      // to record (see the demotion cases below), and it would settle this
      // depth round-trip on a status change rather than on the depths.
      const nested = [
        { content: "parent", status: "in_progress", priority: "high", depth: 0 },
        { content: "child", status: "completed", priority: "high", depth: 1 },
        { content: "grandchild", status: "completed", priority: "low", depth: 2 },
        { content: "sibling", status: "pending", priority: "low", depth: 0 },
      ]
      yield* todos.update({ sessionID, todos: nested })
      expect(yield* todos.get(sessionID)).toEqual(nested)

      // Stored AS SENT: the write does not clamp, so a reader still sees what
      // the model actually claimed and can say so.
      yield* todos.update({
        sessionID,
        todos: [{ content: "wrong", status: "pending", priority: "low", depth: 9 }],
      })
      expect(
        (yield* db.select().from(TodoTable).orderBy(asc(TodoTable.position)).all().pipe(Effect.orDie)).map(
          (row) => row.depth,
        ),
      ).toEqual([9])

      // A partly-nested list: the rows that named no depth are flat, and the
      // one that did keeps it. Nothing is dropped or reordered.
      yield* todos.update({
        sessionID,
        todos: [
          { content: "a", status: "pending", priority: "low" },
          { content: "b", status: "pending", priority: "low", depth: 1 },
          { content: "c", status: "pending", priority: "low" },
        ],
      })
      expect(yield* todos.get(sessionID)).toEqual([
        { content: "a", status: "pending", priority: "low", depth: 0 },
        { content: "b", status: "pending", priority: "low", depth: 1 },
        { content: "c", status: "pending", priority: "low", depth: 0 },
      ])
    }),
  )

  // THE COMPACTION REPRO, at the seam. The model re-emits the same list from a
  // rendered summary and every `depth` is gone; without carry-forward the tree
  // it just built is flattened by its own next write.
  it.effect("carries a dropped depth forward from the row already stored", () =>
    Effect.gen(function* () {
      yield* setup
      const todos = yield* SessionTodo.Service
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

  // An explicit number is the model saying where the row goes - including an
  // explicit 0, which is a promotion, not a gap to fill from the old row.
  it.effect("lets an explicit depth override the stored one", () =>
    Effect.gen(function* () {
      yield* setup
      const todos = yield* SessionTodo.Service
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

  // A parent that says it is done while its own sub-tasks are open is a lie the
  // next agent reads as fact. The store refuses to record it.
  it.effect("stores a completed parent as in_progress while a child is still open", () =>
    Effect.gen(function* () {
      yield* setup
      const todos = yield* SessionTodo.Service
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
      const todos = yield* SessionTodo.Service
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
})
