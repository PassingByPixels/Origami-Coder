import { describe, expect, test } from "bun:test"
import { Database as Sqlite } from "bun:sqlite"
import { spawn } from "child_process"
import path from "path"
import { migrations } from "@origami/core/database/migration.gen"
import { tmpdir } from "./fixture/tmpdir"

// t-tc2193. Several engines on ONE store start in the same second (VS Code
// restores every chat after an extension update, and each gets an engine). The
// in-process lock in `migration.ts` cannot see the other processes, so these
// tests use real processes, not two layers in one.

const root = path.join(import.meta.dir, "..")
const worker = path.join(import.meta.dir, "fixture", "database-migrate-worker.ts")
const WORKERS = 6

function run(msg: { file: string; startAt: number; extra?: boolean }, home: string) {
  return new Promise<{ code: number; out: string }>((resolve) => {
    const proc = spawn(process.execPath, [worker, JSON.stringify(msg)], {
      cwd: root,
      // Every path the engine derives stays inside the test directory; nothing
      // is created or read under the owner's real data folders.
      env: {
        ...process.env,
        ORIGAMI_DB: msg.file,
        ORIGAMI_TEST_HOME: home,
        XDG_DATA_HOME: path.join(home, "data"),
        XDG_CACHE_HOME: path.join(home, "cache"),
        XDG_CONFIG_HOME: path.join(home, "config"),
        XDG_STATE_HOME: path.join(home, "state"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    const out: Buffer[] = []
    proc.stdout?.on("data", (data) => out.push(Buffer.from(data)))
    proc.stderr?.on("data", (data) => out.push(Buffer.from(data)))
    proc.on("close", (code) => resolve({ code: code ?? 1, out: Buffer.concat(out).toString() }))
  })
}

/** Start `WORKERS` engines that all reach the store at the same instant. The
 *  lead time covers process start-up (the imports take about a second). */
async function startTogether(file: string, home: string, extra?: boolean) {
  const startAt = Date.now() + 3000
  return Promise.all(Array.from({ length: WORKERS }, () => run({ file, startAt, extra }, home)))
}

function inspect(file: string) {
  const db = new Sqlite(file, { readonly: true })
  try {
    return {
      ids: db.query<{ id: string }, []>("SELECT id FROM migration").all().map((row) => row.id),
      integrity: db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check,
      journal: db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode,
    }
  } finally {
    db.close()
  }
}

describe("migrations across engine processes (t-tc2193)", () => {
  test("several engines creating one fresh store at once all start, schema applied once", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "fresh.db")
    const results = await startTogether(file, tmp.path)
    for (const result of results) expect(result.code, result.out).toBe(0)
    const { ids, integrity, journal } = inspect(file)
    expect(ids.length).toBe(migrations.length)
    expect(new Set(ids).size).toBe(migrations.length)
    expect(integrity).toBe("ok")
    expect(journal).toBe("wal")
  }, 60_000)

  test("several engines applying one new ADD COLUMN migration at once all start, column added once", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "existing.db")
    // An installed store, before the release that brings the new migration.
    const seed = await run({ file, startAt: 0 }, tmp.path)
    expect(seed.code, seed.out).toBe(0)
    const results = await startTogether(file, tmp.path, true)
    for (const result of results) expect(result.code, result.out).toBe(0)
    const { ids } = inspect(file)
    expect(ids.filter((id) => id === "test_add_probe_column").length).toBe(1)
    expect(ids.length).toBe(migrations.length + 1)
  }, 60_000)
})
