export * as Database from "./database"

import { EffectDrizzleSqlite } from "@origami/effect-drizzle-sqlite"
import { layer as sqliteLayer } from "#sqlite"
import { Context, Effect, Layer } from "effect"
import { Global } from "../global"
import { Flag } from "../flag/flag"
import { isAbsolute, join } from "path"
import { DatabaseMigration } from "./migration"
import { DatabaseLegacyImport } from "./legacy-import"
import { makeGlobalNode } from "../effect/app-node"

const makeDatabase = EffectDrizzleSqlite.makeWithDefaults()
type DatabaseShape = Effect.Success<typeof makeDatabase>

export interface Interface {
  db: DatabaseShape
}

export class Service extends Context.Service<Service, Interface>()("@origami/v2/storage/Database") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = yield* makeDatabase

    yield* db.run("PRAGMA journal_mode = WAL")
    yield* db.run("PRAGMA synchronous = NORMAL")
    yield* db.run("PRAGMA busy_timeout = 5000")
    yield* db.run("PRAGMA cache_size = -64000")
    yield* db.run("PRAGMA foreign_keys = ON")
    yield* db.run("PRAGMA wal_checkpoint(PASSIVE)")
    yield* DatabaseMigration.apply(db)

    // OFF unless asked for. The import reads whole legacy stores into this one
    // — gigabytes, on the machine this was written for — so it is the owner's
    // call to make once, not something a routine start-up does behind them.
    // It never fails start-up: a store that cannot be read is logged and left.
    if (!Flag.ORIGAMI_DB) {
      if (Flag.ORIGAMI_DB_IMPORT_LEGACY) {
        yield* DatabaseLegacyImport.importLegacy(db, { dataDir: Global.Path.data }).pipe(
          Effect.tap((summary) => Effect.logInfo("legacy database import complete", { rows: summary.rows })),
          Effect.catchCause((cause) => Effect.logError("legacy database import failed", { cause })),
        )
      } else {
        // Empty store + orphans beside it = the one case that must never be
        // silent, because it reads exactly like the defect this fixes.
        yield* DatabaseLegacyImport.orphanNotice(db, Global.Path.data)
      }
    }

    return { db }
  }).pipe(Effect.orDie),
)

export function layerFromPath(filename: string) {
  return layer.pipe(Layer.provide(sqliteLayer({ filename })))
}

/**
 * ONE database, whatever build is asking.
 *
 * This used to key the filename on `InstallationChannel`, which falls back to
 * the current git BRANCH for anything that is not a `latest`/`beta`/`prod`
 * release. Every engine line therefore opened a different file — the machine
 * this was fixed on had five, holding 1343 sessions between them — and each
 * change of line looked exactly like the release having deleted the user's
 * chat history. It had not; the history was still there, under a name nothing
 * would ask for again.
 *
 * The build a session came from is recorded where that belongs: the `version`
 * COLUMN on the session row. A filename is an address, not a label.
 *
 * `DatabaseLegacyImport` brings the orphaned files into this one.
 */
export function path() {
  if (Flag.ORIGAMI_DB) {
    if (Flag.ORIGAMI_DB === ":memory:" || isAbsolute(Flag.ORIGAMI_DB)) return Flag.ORIGAMI_DB
    return join(Global.Path.data, Flag.ORIGAMI_DB)
  }
  return join(Global.Path.data, "origami.db")
}

export const node = makeGlobalNode({ service: Service, layer: layerFromPath(path()), deps: [] })
