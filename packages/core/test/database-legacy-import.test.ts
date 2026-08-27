// Defect A — the per-channel database split, and the import that ends it.
//
// `Database.path()` used to key the filename on the installation channel,
// which falls back to the current git BRANCH. The machine this was written for
// had FIVE stores side by side — origami-local.db (4.2 GB), origami-flock-map.db
// (3.9 GB), origami-flock.db, origami-v2-rebase.db, origami-stage-5.db — holding
// 1343 sessions and 38,010 messages between them, each one orphaned the moment
// the engine line changed. Read READONLY on 2026-08-25, the session-id overlap
// between every one of the ten pairs was ZERO, and two of the five had 20 tables
// where the newest three had 25.
//
// Every fixture here is synthesized in a temp dir. Nothing in this file opens,
// reads or writes the real stores.
import { describe, expect, test } from "bun:test"
import { Effect, Logger } from "effect"
import { Database as BunDatabase } from "bun:sqlite"
import path from "path"
import { Database } from "../src/database/database"
import { Flag } from "../src/flag/flag"
import { DatabaseLegacyImport } from "../src/database/legacy-import"
import { tmpdir } from "./fixture/tmpdir"

/** Open the target store the way the engine does — schema migrated, ready. */
const withTarget = <A>(file: string, use: (db: Database.Interface["db"]) => Effect.Effect<A, unknown>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      return yield* use(db)
    }).pipe(Effect.provide(Database.layerFromPath(file)), Effect.scoped, Effect.orDie) as Effect.Effect<A>,
  )

/**
 * A legacy store: the real column sets are unknown to this test, so it copies
 * them off a freshly migrated target and then writes rows directly. That keeps
 * the fixture honest against schema changes without restating the schema.
 */
async function makeLegacy(
  file: string,
  rows: { project: string; sessions: string[] },
  opts?: { dropTables?: string[]; dropColumns?: Record<string, string[]> },
) {
  await withTarget(file, () => Effect.void) // create + migrate, then close
  const db = new BunDatabase(file)
  for (const table of opts?.dropTables ?? []) db.run(`DROP TABLE IF EXISTS "${table}"`)
  for (const [table, cols] of Object.entries(opts?.dropColumns ?? {})) {
    for (const col of cols) db.run(`ALTER TABLE "${table}" DROP COLUMN "${col}"`)
  }
  db.run(
    `INSERT OR IGNORE INTO project (id, worktree, sandboxes, time_created, time_updated) VALUES (?, ?, ?, ?, ?)`,
    [rows.project, "C:/ws", "[]", 1, 1],
  )
  for (const id of rows.sessions) {
    db.run(
      `INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, rows.project, `slug-${id}`, "C:/ws", `Chat ${id}`, "0.0.0-test", 1, 1],
    )
  }
  db.close()
}

const sessionIds = (file: string): string[] => {
  const db = new BunDatabase(file, { readonly: true })
  const ids = (db.query("SELECT id FROM session ORDER BY id").all() as { id: string }[]).map((r) => r.id)
  db.close()
  return ids
}

const runImport = (target: string, dataDir: string) =>
  withTarget(target, (db) => DatabaseLegacyImport.importLegacy(db, { dataDir }))

describe("legacy database import", () => {
  test("a fresh machine with no legacy stores imports nothing and does not fail", async () => {
    await using tmp = await tmpdir()
    const target = path.join(tmp.path, "origami.db")
    const summary = await runImport(target, tmp.path)
    expect(summary.files).toEqual([])
    expect(summary.rows).toBe(0)
    expect(sessionIds(target)).toEqual([])
  })

  test("imports every legacy store into the stable one", async () => {
    await using tmp = await tmpdir()
    await makeLegacy(path.join(tmp.path, "origami-flock.db"), { project: "p1", sessions: ["ses_a", "ses_b"] })
    await makeLegacy(path.join(tmp.path, "origami-local.db"), { project: "p2", sessions: ["ses_c"] })
    const target = path.join(tmp.path, "origami.db")

    const summary = await runImport(target, tmp.path)

    expect(sessionIds(target)).toEqual(["ses_a", "ses_b", "ses_c"])
    expect(summary.files.map((f) => path.basename(f.file))).toEqual(["origami-flock.db", "origami-local.db"])
    expect(summary.files.every((f) => !f.error)).toBe(true)
  })

  test("never touches the legacy files it read", async () => {
    await using tmp = await tmpdir()
    const legacy = path.join(tmp.path, "origami-flock.db")
    await makeLegacy(legacy, { project: "p1", sessions: ["ses_a"] })
    await runImport(path.join(tmp.path, "origami.db"), tmp.path)
    // Still there, still holding its own rows.
    expect(sessionIds(legacy)).toEqual(["ses_a"])
  })

  test("partial overlap: rows already in the target are skipped, new ones land", async () => {
    await using tmp = await tmpdir()
    const target = path.join(tmp.path, "origami.db")
    await makeLegacy(path.join(tmp.path, "origami-flock.db"), { project: "p1", sessions: ["ses_a", "ses_b"] })
    // The target already holds one of them, under the same id.
    await makeLegacy(target, { project: "p1", sessions: ["ses_a"] })

    await runImport(target, tmp.path)

    expect(sessionIds(target)).toEqual(["ses_a", "ses_b"])
  })

  test("a corrupt legacy store is skipped, and the others still import", async () => {
    await using tmp = await tmpdir()
    await makeLegacy(path.join(tmp.path, "origami-aaa.db"), { project: "p1", sessions: ["ses_good"] })
    await Bun.write(path.join(tmp.path, "origami-bbb.db"), "this is not a database")
    await makeLegacy(path.join(tmp.path, "origami-ccc.db"), { project: "p2", sessions: ["ses_also_good"] })
    const target = path.join(tmp.path, "origami.db")

    const summary = await runImport(target, tmp.path)

    // The one that could not be read is reported, not thrown.
    const bad = summary.files.find((f) => path.basename(f.file) === "origami-bbb.db")
    expect(bad?.error).toBeTruthy()
    // Everything either side of it still arrived.
    expect(sessionIds(target)).toEqual(["ses_also_good", "ses_good"])
  })

  test("a legacy store missing whole tables still imports the ones it has", async () => {
    await using tmp = await tmpdir()
    // The owner's two oldest stores had 20 tables where the newest had 25.
    await makeLegacy(
      path.join(tmp.path, "origami-old.db"),
      { project: "p1", sessions: ["ses_old"] },
      { dropTables: ["session_context_epoch", "session_share"] },
    )
    const target = path.join(tmp.path, "origami.db")

    const summary = await runImport(target, tmp.path)

    expect(sessionIds(target)).toEqual(["ses_old"])
    expect(summary.files[0]?.error).toBeUndefined()
    expect(summary.files[0]?.imported).not.toHaveProperty("session_share")
  })

  test("a legacy store missing a COLUMN imports the columns it shares", async () => {
    await using tmp = await tmpdir()
    await makeLegacy(
      path.join(tmp.path, "origami-old.db"),
      { project: "p1", sessions: ["ses_old"] },
      { dropColumns: { session: ["summary_diffs"] } },
    )
    const target = path.join(tmp.path, "origami.db")

    await runImport(target, tmp.path)

    expect(sessionIds(target)).toEqual(["ses_old"])
  })

  test("re-running is a no-op: the second pass writes nothing", async () => {
    await using tmp = await tmpdir()
    await makeLegacy(path.join(tmp.path, "origami-flock.db"), { project: "p1", sessions: ["ses_a", "ses_b"] })
    const target = path.join(tmp.path, "origami.db")

    const first = await runImport(target, tmp.path)
    const second = await runImport(target, tmp.path)

    expect(first.rows).toBeGreaterThan(0)
    expect(second.rows).toBe(0)
    expect(second.files.every((f) => f.skipped)).toBe(true)
    expect(sessionIds(target)).toEqual(["ses_a", "ses_b"])
  })

  test("legacyFiles finds the channel stores and never the stable one or its sidecars", async () => {
    await using tmp = await tmpdir()
    for (const name of ["origami.db", "origami-flock.db", "origami-local.db", "origami-flock.db-wal", "notes.txt"]) {
      await Bun.write(path.join(tmp.path, name), "x")
    }
    expect(DatabaseLegacyImport.legacyFiles(tmp.path).map((f) => path.basename(f))).toEqual([
      "origami-flock.db",
      "origami-local.db",
    ])
  })

  test("legacyFiles on a directory that does not exist answers empty, not an error", () => {
    expect(DatabaseLegacyImport.legacyFiles(path.join("C:/", "no", "such", "dir"))).toEqual([])
  })
})

describe("orphan notice", () => {
  /** Capture what the effect logged, so the warning is asserted rather than assumed. */
  const logsOf = async (target: string, dataDir: string): Promise<string[]> => {
    const lines: string[] = []
    await withTarget(target, (db) =>
      DatabaseLegacyImport.orphanNotice(db, dataDir).pipe(
        Effect.provide(
          Logger.layer([
            Logger.make(({ message }) => {
              lines.push(Array.isArray(message) ? message.join(" ") : String(message))
            }),
          ]),
        ),
      ),
    )
    return lines
  }

  test("warns when the stable store is empty and legacy stores sit beside it", async () => {
    await using tmp = await tmpdir()
    await makeLegacy(path.join(tmp.path, "origami-flock.db"), { project: "p1", sessions: ["ses_a"] })
    const lines = await logsOf(path.join(tmp.path, "origami.db"), tmp.path)
    expect(lines.join("\n")).toContain("ORIGAMI_DB_IMPORT_LEGACY")
  })

  test("says nothing when there are no legacy stores", async () => {
    await using tmp = await tmpdir()
    expect(await logsOf(path.join(tmp.path, "origami.db"), tmp.path)).toEqual([])
  })

  test("says nothing once the stable store has history of its own", async () => {
    await using tmp = await tmpdir()
    await makeLegacy(path.join(tmp.path, "origami-flock.db"), { project: "p1", sessions: ["ses_a"] })
    const target = path.join(tmp.path, "origami.db")
    await makeLegacy(target, { project: "p2", sessions: ["ses_mine"] })
    expect(await logsOf(target, tmp.path)).toEqual([])
  })
})

describe("database path is stable across engine lines", () => {
  test("does not key the filename on the installation channel", () => {
    // The test preload pins ORIGAMI_DB to :memory:; lift it to see what a real
    // start-up would resolve. Under the defect this answered
    // `origami-<branch>.db` for every build that was not a tagged release.
    const pinned = Flag.ORIGAMI_DB
    Flag.ORIGAMI_DB = undefined
    try {
      expect(path.basename(Database.path())).toBe("origami.db")
    } finally {
      Flag.ORIGAMI_DB = pinned
    }
  })
})
