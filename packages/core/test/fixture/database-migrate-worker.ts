// One "engine start" in its own process: open the store the way the engine
// does (`Database.layerFromPath`, which runs every migration), then optionally
// apply one extra migration that is NOT idempotent, the way a new release's
// `ALTER TABLE ... ADD COLUMN` is. Every worker waits for the same wall-clock
// instant first, so the processes reach the migrations together.
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@origami/core/database/database"
import { DatabaseMigration } from "@origami/core/database/migration"

type Msg = { file: string; startAt: number; extra?: boolean }

const msg: Msg = JSON.parse(process.argv[2])

const wait = msg.startAt - Date.now()
if (wait > 0) await Bun.sleep(wait)

await Effect.runPromise(
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    if (msg.extra)
      yield* DatabaseMigration.applyOnly(db, [
        {
          id: "test_add_probe_column",
          up: (tx) => tx.run(sql`ALTER TABLE ${sql.identifier("session")} ADD COLUMN probe_extra TEXT`),
        },
      ])
  }).pipe(Effect.provide(Database.layerFromPath(msg.file)), Effect.scoped),
)
console.log("migrated")
