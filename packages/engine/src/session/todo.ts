import { LayerNode } from "@origami/core/effect/layer-node"
import { SessionID } from "./schema"
import { Effect, Layer, Context } from "effect"
import { Database } from "@origami/core/database/database"
import { eq } from "drizzle-orm"
import { asc } from "drizzle-orm"
import { TodoTable } from "@origami/core/session/sql"
import { TodoReconcile } from "@origami/core/session/todo-reconcile"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionTodo } from "@origami/schema/session-todo"

export const Info = SessionTodo.Info
export type Info = SessionTodo.Info

export const Event = SessionTodo.Event

export interface Interface {
  readonly update: (input: { sessionID: SessionID; todos: ReadonlyArray<Info> }) => Effect.Effect<void>
  readonly get: (sessionID: SessionID) => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@origami/SessionTodo") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const { db } = yield* Database.Service

    const update = Effect.fn("Todo.update")(function* (input: { sessionID: SessionID; todos: ReadonlyArray<Info> }) {
      // READ-MODIFY-WRITE, inside the transaction. The write is a full-list
      // replace, so what the model left out is only recoverable from the rows
      // about to be deleted - the two rules, and why they live at this seam,
      // are in @origami/core/session/todo-reconcile.
      const stored = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const previous = yield* tx
              .select()
              .from(TodoTable)
              .where(eq(TodoTable.session_id, input.sessionID))
              .orderBy(asc(TodoTable.position))
              .all()
            const next = TodoReconcile.reconcileTodos(previous, input.todos)
            yield* tx.delete(TodoTable).where(eq(TodoTable.session_id, input.sessionID)).run()
            if (next.length === 0) return next
            yield* tx
              .insert(TodoTable)
              .values(
                next.map((todo, position) => ({
                  session_id: input.sessionID,
                  content: todo.content,
                  status: todo.status,
                  priority: todo.priority,
                  position,
                  // Stored AS SENT - see the core twin for why the write does
                  // not clamp. Carry-forward is not clamping: it fills a field
                  // the model omitted, it never rewrites one it sent.
                  depth: todo.depth,
                })),
              )
              .run()
            return next
          }),
        )
        .pipe(Effect.orDie)
      // The list that was STORED, not the one that arrived - so a subscriber
      // rendering the event and one re-reading the table agree.
      yield* events.publish(Event.Updated, { sessionID: input.sessionID, todos: stored })
    })

    const get = Effect.fn("Todo.get")(function* (sessionID: SessionID) {
      const rows = yield* db
        .select()
        .from(TodoTable)
        .where(eq(TodoTable.session_id, sessionID))
        .orderBy(asc(TodoTable.position))
        .all()
        .pipe(Effect.orDie)
      // `depth` is always a number here: the column is NOT NULL DEFAULT 0, so a
      // row written before the column existed reads back flat.
      return rows.map((row) => ({
        content: row.content,
        status: row.status,
        priority: row.priority,
        depth: row.depth,
      }))
    })

    return Service.of({ update, get })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [EventV2Bridge.node, Database.node] })

export * as Todo from "./todo"
