export * as DatabaseLegacyImport from "./legacy-import"

import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { readdirSync } from "fs"
import { basename, join } from "path"
import type { EffectDrizzleSqlite } from "@origami/effect-drizzle-sqlite"

type Database = EffectDrizzleSqlite.EffectSQLiteDatabase

/**
 * One-time import of the per-channel databases this installation used to write.
 *
 * THE DEFECT THIS REPAIRS. `Database.path()` used to key the filename on the
 * installation channel — a released build wrote `origami.db`, but any other
 * build wrote `origami-<channel>.db`, and the channel falls back to the current
 * GIT BRANCH. So every engine line change silently started a fresh, empty
 * store and orphaned the previous one. It reads as "the release ate my chat
 * history"; the history was never lost, just addressed by a name nothing asked
 * for again. `path()` is stable now, and this brings the orphans home.
 *
 * The legacy files are treated as READ-ONLY BACKUPS. Nothing here deletes,
 * moves or writes to one, by design: if an import goes wrong the originals are
 * still the originals, and a second run can only add rows it did not add
 * before.
 */

/**
 * Tables carried over, and the reason the list stops where it does: this is
 * the CHAT HISTORY — the runs, what was said in them, and what they belonged
 * to. `project`/`workspace` come along because a session references them and
 * would otherwise arrive orphaned.
 *
 * Deliberately NOT imported: `account`/`credential` (merging one machine's
 * logins into another's is a security decision, not a history one), `event`/
 * `event_sequence` (a replay log, meaningless out of its own store),
 * `collab`/`collab_*` (live multi-party state), and `migration`/
 * `data_migration` (each store's own bookkeeping — importing them would tell
 * the target it had run migrations it has not run).
 *
 * ORDER DOES NOT MATTER: the import defers foreign-key checks to COMMIT, so a
 * child inserted before its parent is fine, and a genuinely orphaned row still
 * fails the whole file rather than landing broken.
 */
export const LEGACY_TABLES = [
  "project",
  "workspace",
  "session",
  "message",
  "part",
  "session_input",
  "session_message",
  "session_context_epoch",
  "session_share",
  "todo",
] as const

/** `data_migration` row name for one imported file. */
export const markerFor = (file: string) => `legacy-db-import:${basename(file)}`

/** What one file's import did. `skipped` means the marker was already there. */
export interface FileResult {
  file: string
  imported: Record<string, number>
  skipped: boolean
  error?: string
}

export interface Summary {
  files: FileResult[]
  /** Total rows written across every file and table. */
  rows: number
}

const LEGACY_NAME = /^origami-.+\.db$/

/**
 * The per-channel databases sitting next to the stable one. `origami.db` is
 * the target and never a source; the `-wal`/`-shm` sidecars are not databases.
 */
export function legacyFiles(dataDir: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dataDir)
  } catch {
    return []
  }
  return entries
    .filter((name) => LEGACY_NAME.test(name))
    .sort()
    .map((name) => join(dataDir, name))
}

const SCHEMA = "legacy_import"

/** Columns present in BOTH stores, so an older file imports without its
 *  schema having to match. A column the source never had takes the target's
 *  default; one the target has since dropped is left behind. */
const sharedColumns = (db: Database, table: string) =>
  Effect.gen(function* () {
    const cols = (schema: string) =>
      db
        .all<{ name: string }>(sql.raw(`SELECT name FROM pragma_table_info('${table}', '${schema}')`))
        .pipe(Effect.map((rows) => rows.map((row) => row.name)))
    const target = yield* cols("main")
    const source = yield* cols(SCHEMA)
    const have = new Set(source)
    return target.filter((name) => have.has(name))
  })

/**
 * Import every legacy store that has not been imported already.
 *
 * Each FILE is one transaction: it lands whole or not at all, and a file that
 * throws — corrupt, locked, on a schema too far gone — is logged and stepped
 * over so the others still arrive. Row-level collisions are impossible in
 * practice (a session id carries 22 random characters; across the five stores
 * on the machine this was written for, the id overlap between every pair was
 * zero) but `INSERT OR IGNORE` handles them anyway, which is also what makes a
 * re-run after a half-finished attempt cost nothing.
 */
export function importLegacy(db: Database, input: { dataDir: string; files?: readonly string[] }) {
  return Effect.gen(function* () {
    const files = input.files ?? legacyFiles(input.dataDir)
    const results: FileResult[] = []
    if (files.length === 0) return { files: results, rows: 0 } satisfies Summary

    yield* db.run(
      sql`CREATE TABLE IF NOT EXISTS ${sql.identifier("data_migration")} (name TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`,
    )
    const done = new Set(
      (yield* db.all<{ name: string }>(sql`SELECT name FROM ${sql.identifier("data_migration")}`)).map(
        (row) => row.name,
      ),
    )

    for (const file of files) {
      const marker = markerFor(file)
      if (done.has(marker)) {
        results.push({ file, imported: {}, skipped: true })
        continue
      }
      const exit = yield* Effect.exit(importOne(db, file, marker))
      if (exit._tag === "Failure") {
        const error = String(exit.cause)
        yield* Effect.logWarning("legacy database skipped", { file, error })
        results.push({ file, imported: {}, skipped: false, error })
        // The ATTACH may or may not have happened; either way the next file
        // needs the name free, and a failed DETACH is not itself a problem.
        yield* db.run(sql.raw(`DETACH DATABASE ${SCHEMA}`)).pipe(Effect.ignore)
        continue
      }
      results.push(exit.value)
      yield* Effect.logInfo("legacy database imported", { file, imported: exit.value.imported })
    }

    const rows = results.reduce(
      (total, result) => total + Object.values(result.imported).reduce((sum, n) => sum + n, 0),
      0,
    )
    return { files: results, rows } satisfies Summary
  })
}

/**
 * Say so when this store is empty but orphaned ones are sitting beside it.
 *
 * The first start after the filename was made stable is the one moment the fix
 * LOOKS like the defect: `origami.db` may not exist yet, so the engine opens a
 * new empty one and the history appears to be gone — while every session of it
 * sits in the `origami-<channel>.db` files next door. The import is off by
 * default (it is a one-time, multi-gigabyte copy, and that is the owner's call
 * to schedule), so the one thing that must not happen is silence.
 */
export function orphanNotice(db: Database, dataDir: string) {
  return Effect.gen(function* () {
    const files = legacyFiles(dataDir)
    if (files.length === 0) return
    const row = yield* db.get<{ n: number }>(sql`SELECT count(*) AS n FROM (SELECT 1 FROM session LIMIT 1)`)
    if ((row?.n ?? 0) > 0) return
    yield* Effect.logWarning(
      "this database is empty, but older per-channel databases are next to it — " +
        "set ORIGAMI_DB_IMPORT_LEGACY=1 once to import their history into it (the originals are only read)",
      { found: files.map((file) => basename(file)) },
    )
  }).pipe(Effect.ignore)
}

function importOne(db: Database, file: string, marker: string) {
  return Effect.gen(function* () {
    // ATTACH cannot run inside a transaction, so it brackets one.
    yield* db.run(sql`ATTACH DATABASE ${file} AS ${sql.identifier(SCHEMA)}`)
    const present = new Set(
      (yield* db.all<{ name: string }>(
        sql.raw(`SELECT name FROM ${SCHEMA}.sqlite_master WHERE type = 'table'`),
      )).map((row) => row.name),
    )
    const imported: Record<string, number> = {}
    yield* db.transaction((tx) =>
      Effect.gen(function* () {
        // Checked at COMMIT instead of per row, so the tables can be written in
        // any order and a legacy store missing one of them still imports the
        // rest. An import that would genuinely orphan a row still fails here.
        yield* tx.run(sql`PRAGMA defer_foreign_keys = ON`)
        for (const table of LEGACY_TABLES) {
          // A store five tables older than this one is normal — two of the
          // owner's five had 20 tables where the newest had 25.
          if (!present.has(table)) continue
          const columns = yield* sharedColumns(db, table)
          if (columns.length === 0) continue
          const list = columns.map((name) => `"${name}"`).join(", ")
          yield* tx.run(
            sql.raw(`INSERT OR IGNORE INTO main."${table}" (${list}) SELECT ${list} FROM ${SCHEMA}."${table}"`),
          )
          const changed = yield* tx.get<{ n: number }>(sql`SELECT changes() AS n`)
          imported[table] = changed?.n ?? 0
        }
        yield* tx.run(
          sql`INSERT OR REPLACE INTO ${sql.identifier("data_migration")} (name, time_completed) VALUES (${marker}, ${Date.now()})`,
        )
      }),
    )
    yield* db.run(sql.raw(`DETACH DATABASE ${SCHEMA}`))
    return { file, imported, skipped: false } satisfies FileResult
  })
}
