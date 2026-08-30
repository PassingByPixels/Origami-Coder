export * as TodoWriteTool from "./todowrite"

import { ToolFailure } from "@origami/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
import { SessionTodo } from "../session/todo"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "todowrite"

export const Input = Schema.Struct({
  todos: Schema.Array(SessionTodo.Info).annotate({ description: "The updated todo list" }),
})

export const Output = Schema.Struct({
  todos: Schema.Array(SessionTodo.Info),
})
export type Output = typeof Output.Type

export const toModelOutput = (output: Output) => JSON.stringify(output.todos, null, 2)

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const todos = yield* SessionTodo.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [name]: Tool.make({
          // DRIFT RISK: this is the SHORT twin of the engine's full description
          // in packages/engine/src/tool/todowrite.txt. They are two texts for
          // one tool, so a rule taught in one and not the other is a model that
          // behaves differently depending on which runtime answered. Keep the
          // nesting sentence below in step with that file's "## Nesting"
          // section.
          description:
            "Create and maintain a structured task list for the current coding session. Use it to track progress during multi-step work and keep todo statuses current. " +
            "Use the optional `depth` field for sub-tasks: 0 (or omitted) is top level, a sub-task is its parent's depth + 1 and comes directly after that parent, maximum 3. " +
            "Put the structure in `depth`, never in the `content` text as a numbering prefix such as \"1a\". " +
            "The list is replaced whole on every call, so re-send each item's `depth` every time you rewrite it. " +
            "A parent sent as `completed` while a task under it is still `pending` or `in_progress` is recorded as `in_progress` instead.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: toModelOutput(output) }],
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* permission.assert({
                action: name,
                resources: ["*"],
                save: ["*"],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })
              yield* todos.update({ sessionID: context.sessionID, todos: input.todos })
              return { todos: input.todos }
            }).pipe(Effect.mapError(() => new ToolFailure({ message: "Unable to update todos" }))),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/todowrite",
  layer,
  deps: [ToolRegistry.node, PermissionV2.node, SessionTodo.node],
})
