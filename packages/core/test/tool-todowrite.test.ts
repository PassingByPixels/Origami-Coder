import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@origami/core/database/database"
import { AppNodeBuilder } from "@origami/core/effect/app-node-builder"
import { LayerNode } from "@origami/core/effect/layer-node"
import { EventV2 } from "@origami/core/event"
import { PermissionV2 } from "@origami/core/permission"
import { Project } from "@origami/core/project"
import { ProjectTable } from "@origami/core/project/sql"
import { AbsolutePath } from "@origami/core/schema"
import { SessionV2 } from "@origami/core/session"
import { SessionTable } from "@origami/core/session/sql"
import { SessionTodo } from "@origami/core/session/todo"
import { TodoWriteTool } from "@origami/core/tool/todowrite"
import { ToolRegistry } from "@origami/core/tool/registry"
import { ToolOutputStore } from "@origami/core/tool-output-store"
import { testEffect } from "./lib/effect"
import { toolIdentity, executeTool, settleTool, toolDefinitions } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_todowrite_tool_test")
const assertions: PermissionV2.AssertInput[] = []
let deny = false

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) =>
      Effect.sync(() => assertions.push(input)).pipe(
        Effect.andThen(deny ? Effect.fail(new PermissionV2.BlockedError({ rules: [] })) : Effect.void),
      ),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionTodo.node,
      ToolRegistry.node,
      ToolRegistry.toolsNode,
      TodoWriteTool.node,
    ]),
    [
      [PermissionV2.node, permission],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    ],
  ),
)

const setup = Effect.gen(function* () {
  assertions.length = 0
  deny = false
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
      slug: "todowrite",
      directory: "/project",
      title: "todowrite",
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
})

const call = (todos: ReadonlyArray<SessionTodo.Info>, id = "call-todowrite") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: TodoWriteTool.name, input: { todos } },
})

describe("TodoWriteTool", () => {
  it.effect("registers, approves the wildcard resource, persists todos, and returns typed output", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      const service = yield* SessionTodo.Service
      const todoList: ReadonlyArray<SessionTodo.Info> = [
        { content: "Implement slice", status: "in_progress", priority: "high" },
      ]

      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual([TodoWriteTool.name])
      expect(yield* settleTool(registry, call(todoList))).toEqual({
        result: { type: "text", value: JSON.stringify(todoList, null, 2) },
        output: {
          structured: { todos: todoList },
          content: [{ type: "text", text: JSON.stringify(todoList, null, 2) }],
        },
      })
      expect(assertions).toMatchObject([{ sessionID, action: "todowrite", resources: ["*"], save: ["*"] }])
      // BACK-COMPAT: a call that names no depth is echoed to the model byte for
      // byte as it was sent (the JSON above), and reads back off the store as a
      // flat list.
      expect(yield* service.get(sessionID)).toEqual([{ ...todoList[0]!, depth: 0 }])
    }),
  )

  // Nesting reaches the store through the TOOL, not only through the service:
  // the tool's input schema has to declare `depth` or the decoder drops it as an
  // unknown field and the list arrives flat with no error anywhere.
  it.effect("accepts a nested list and persists each item's depth", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      const service = yield* SessionTodo.Service
      const nested: ReadonlyArray<SessionTodo.Info> = [
        { content: "Add the export button", status: "in_progress", priority: "high", depth: 0 },
        { content: "Wire the click handler", status: "completed", priority: "high", depth: 1 },
        { content: "Update the docs", status: "pending", priority: "low", depth: 0 },
      ]

      expect(yield* executeTool(registry, call(nested))).toEqual({
        type: "text",
        value: JSON.stringify(nested, null, 2),
      })
      expect(yield* service.get(sessionID)).toEqual(nested)
    }),
  )

  // FAIL-OPEN. A depth the model got wrong must cost that row its indent, never
  // the whole call: the readers clamp, so the schema deliberately accepts any
  // number rather than a non-negative integer.
  it.effect("accepts an out-of-range or fractional depth instead of failing the call", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      const service = yield* SessionTodo.Service
      const odd: ReadonlyArray<SessionTodo.Info> = [
        { content: "negative", status: "pending", priority: "low", depth: -3 },
        { content: "fractional", status: "pending", priority: "low", depth: 1.5 },
        { content: "far too deep", status: "pending", priority: "low", depth: 99 },
      ]

      expect(yield* executeTool(registry, call(odd))).toEqual({
        type: "text",
        value: JSON.stringify(odd, null, 2),
      })
      expect((yield* service.get(sessionID)).map((todo) => todo.content)).toEqual([
        "negative",
        "fractional",
        "far too deep",
      ])
    }),
  )

  it.effect("does not update persisted todos when permission is denied", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      const service = yield* SessionTodo.Service
      yield* service.update({ sessionID, todos: [{ content: "keep", status: "pending", priority: "low" }] })
      deny = true

      expect(
        yield* executeTool(registry, call([{ content: "blocked", status: "completed", priority: "high" }])),
      ).toEqual({
        type: "error",
        value: "Unable to update todos",
      })
      expect(yield* service.get(sessionID)).toEqual([
        { content: "keep", status: "pending", priority: "low", depth: 0 },
      ])
      expect(assertions).toMatchObject([{ sessionID, action: "todowrite", resources: ["*"], save: ["*"] }])
    }),
  )
})
