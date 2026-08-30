export * as SessionTodo from "./todo"

import { asc, eq } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { SessionTodo } from "@origami/schema/session-todo"
import { Database } from "../database/database"
import { makeLocationNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { SessionSchema } from "./schema"
import { TodoTable } from "./sql"
import { TodoReconcile } from "./todo-reconcile"

export const Info = SessionTodo.Info
export type Info = typeof Info.Type
export const Event = SessionTodo.Event

export interface Interface {
  readonly update: (input: {
    readonly sessionID: SessionSchema.ID
    readonly todos: ReadonlyArray<Info>
  }) => Effect.Effect<void>
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<ReadonlyArray<Info>>
}

export class Service extends Context.Service<Service, Interface>()("@origami/v2/SessionTodo") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service

    const update = Effect.fn("SessionTodo.update")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly todos: ReadonlyArray<Info>
    }) {
      // READ-MODIFY-WRITE, inside the transaction. The write is a full-list
      // replace, so what the model left out is only recoverable from the rows
      // about to be deleted - see todo-reconcile.ts for the two rules and why
      // they live at this seam rather than in each caller.
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
                  // Stored AS SENT. Clamping is the reader's job (the strip
                  // normalises the whole list at once, which needs the item
                  // before this one) and a write that silently rewrote the
                  // model's own numbers would hide that from every reader.
                  // Carry-forward is not clamping: it fills a field the model
                  // omitted, it never rewrites one it sent.
                  depth: todo.depth,
                })),
              )
              .run()
            return next
          }),
        )
        .pipe(Effect.orDie)
      // The list that was STORED, not the one that arrived: a subscriber
      // rendering this event has to see what a subscriber re-reading the table
      // would see, or the two surfaces disagree about the same write.
      yield* events.publish(Event.Updated, { sessionID: input.sessionID, todos: stored })
    })

    const get = Effect.fn("SessionTodo.get")(function* (sessionID: SessionSchema.ID) {
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

export const node = makeLocationNode({ service: Service, layer, deps: [EventV2.node, Database.node] })
