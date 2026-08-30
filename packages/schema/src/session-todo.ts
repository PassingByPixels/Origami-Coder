export * as SessionTodo from "./session-todo"

import { Schema } from "effect"
import { define, inventory } from "./event"
import { SessionID } from "./session-id"

export const Info = Schema.Struct({
  content: Schema.String.annotate({ description: "Brief description of the task" }),
  status: Schema.String.annotate({
    description: "Current status of the task: pending, in_progress, completed, cancelled",
  }),
  priority: Schema.String.annotate({
    description: "Priority level of the task: high, medium, low",
  }),
  // Nesting, expressed by POSITION rather than by reference: the list is stored
  // full-list-replace with the array index as the only identity, so there is no
  // stable id for a child to point at. `Schema.Number` and not a non-negative
  // int on purpose - a model that sends -1 or 1.5 must still get its list
  // written (the readers clamp), where a stricter check would fail the whole
  // call and lose every item in it.
  depth: Schema.optional(Schema.Number).annotate({
    description:
      "Nesting level. Omit or 0 for a top-level task; a sub-task is its parent's depth + 1 and must come " +
      "directly after that parent in the list. Maximum 3.",
  }),
}).annotate({ identifier: "Todo" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

const Updated = define({
  type: "todo.updated",
  schema: {
    sessionID: SessionID,
    todos: Schema.Array(Info),
  },
})
export const Event = { Updated, Definitions: inventory(Updated) }
