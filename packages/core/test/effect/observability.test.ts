import { afterEach, describe, expect, test } from "bun:test"
import { NodeFileSystem } from "@effect/platform-node"
import { Effect, Layer, Logger } from "effect"
import fs from "fs/promises"
import fsSync from "fs"
import os from "os"
import path from "path"
import { fileLogger, rotateIfOwned, rotatingFileLogger } from "../../src/observability/logging"
import { resource } from "../../src/observability/otlp"

const otelResourceAttributes = process.env.OTEL_RESOURCE_ATTRIBUTES
const origamiClient = process.env.ORIGAMI_CLIENT

afterEach(() => {
  if (otelResourceAttributes === undefined) delete process.env.OTEL_RESOURCE_ATTRIBUTES
  else process.env.OTEL_RESOURCE_ATTRIBUTES = otelResourceAttributes

  if (origamiClient === undefined) delete process.env.ORIGAMI_CLIENT
  else process.env.ORIGAMI_CLIENT = origamiClient
})

describe("resource", () => {
  test("parses and decodes OTEL resource attributes", () => {
    process.env.OTEL_RESOURCE_ATTRIBUTES =
      "service.namespace=anomalyco,team=platform%2Cobservability,label=hello%3Dworld,key%2Fname=value%20here"

    expect(resource().attributes).toMatchObject({
      "service.namespace": "anomalyco",
      team: "platform,observability",
      label: "hello=world",
      "key/name": "value here",
    })
  })

  test("drops OTEL resource attributes when any entry is invalid", () => {
    process.env.OTEL_RESOURCE_ATTRIBUTES = "service.namespace=anomalyco,broken"

    expect(resource().attributes["service.namespace"]).toBeUndefined()
    expect(resource().attributes["origami.client"]).toBeDefined()
  })

  test("keeps built-in attributes when env values conflict", () => {
    process.env.ORIGAMI_CLIENT = "cli"
    process.env.OTEL_RESOURCE_ATTRIBUTES =
      "origami.client=web,service.instance.id=override,service.namespace=anomalyco"

    expect(resource().attributes).toMatchObject({
      "origami.client": "cli",
      "service.namespace": "anomalyco",
    })
    expect(resource().attributes["service.instance.id"]).not.toBe("override")
    expect(resource().attributes["origami.run"]).toMatch(/^[0-9a-f]{8}$/)
  })
})

test("file logger appends concurrent runs with a run on every line", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "origami-log-test-"))
  await using _ = {
    async [Symbol.asyncDispose]() {
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
  const file = path.join(dir, "origami.log")
  const write = (runID: string) =>
    Effect.forEach(
      Array.from({ length: 50 }, (_, index) => index),
      (index) => Effect.logInfo(`entry-${index}`),
    ).pipe(
      Effect.provide(Logger.layer([fileLogger(file, runID)]).pipe(Layer.provide(NodeFileSystem.layer), Layer.orDie)),
      Effect.scoped,
    )

  await Effect.runPromise(Effect.all([write("run-a"), write("run-b")], { concurrency: "unbounded" }))

  const lines = (await Bun.file(file).text()).trim().split("\n")
  expect(lines).toHaveLength(100)
  expect(lines.filter((line) => line.includes("run=run-a"))).toHaveLength(50)
  expect(lines.filter((line) => line.includes("run=run-b"))).toHaveLength(50)
  expect(lines.every((line) => line.startsWith("timestamp=") && line.includes(" level=INFO "))).toBe(true)
  expect(lines.every((line) => !line.includes(" fiber="))).toBe(true)
  expect(lines.every((line) => !line.startsWith("{"))).toBe(true)
})

test("file logger flattens nested objects", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "origami-log-test-"))
  await using _ = {
    async [Symbol.asyncDispose]() {
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
  const file = path.join(dir, "origami.log")

  await Effect.logInfo("request complete", {
    request: { method: "GET", timing: { duration: 42 } },
    tags: ["api", "test"],
  }).pipe(
    Effect.annotateLogs({ session: { id: "session-1" } }),
    Effect.provide(Logger.layer([fileLogger(file, "run-a")]).pipe(Layer.provide(NodeFileSystem.layer), Layer.orDie)),
    Effect.scoped,
    Effect.runPromise,
  )

  const line = (await Bun.file(file).text()).trim()
  expect(line).toContain('message="request complete"')
  expect(line).toContain("request.method=GET")
  expect(line).toContain("request.timing.duration=42")
  expect(line).toContain('tags="[\\\"api\\\",\\\"test\\\"]"')
  expect(line).toContain("session.id=session-1")
  expect(line).not.toContain("request={")
})

test("rotatingFileLogger rotates by size and keeps a bounded number of generations (finding 23)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "origami-log-rotate-test-"))
  await using _ = {
    async [Symbol.asyncDispose]() {
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
  const file = path.join(dir, "origami.log")
  const layer = Logger.layer([rotatingFileLogger(file, { maxBytes: 120, maxFiles: 3, batchWindow: 20 })]).pipe(
    Layer.provide(NodeFileSystem.layer),
    Layer.orDie,
  )

  // One long-lived logger, like a real engine process: six entries, each big
  // enough alone to push the live file over the 120-byte cap, with a real
  // pause between them so each one's batch flushes (and rotates) on its own
  // before the next is logged.
  await Effect.runPromise(
    Effect.gen(function* () {
      for (let i = 0; i < 6; i++) {
        yield* Effect.logInfo(`entry ${i} ${"x".repeat(80)}`)
        yield* Effect.sleep(60)
      }
    }).pipe(Effect.provide(layer), Effect.scoped),
  )

  const sizeOf = (suffix: string) =>
    fs
      .stat(file + suffix)
      .then((info) => info.size)
      .catch(() => undefined)

  // maxFiles=3 keeps the live file plus two backups; nothing older survives.
  expect(await sizeOf("")).toBeGreaterThan(0)
  expect(await sizeOf(".1")).toBeGreaterThan(0)
  expect(await sizeOf(".2")).toBeGreaterThan(0)
  expect(await sizeOf(".3")).toBeUndefined()

  // Each generation holds one entry (about 158 bytes), not all six -- the cap
  // keeps bounding it on every write, not just the first one.
  expect(await sizeOf("")).toBeLessThan(300)
})

test("rotatingFileLogger renames the live file instead of deleting it, so a handle another engine still holds keeps reading its own content", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "origami-log-rotate-test-"))
  await using _ = {
    async [Symbol.asyncDispose]() {
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
  const file = path.join(dir, "origami.log")
  await fs.writeFile(file, "already-there-before-rotation\n")

  // Stand in for another engine process with the live file open.
  const otherEngineHandle = fsSync.openSync(file, "r")
  try {
    await Effect.logInfo("triggers a rotation").pipe(
      Effect.provide(
        Logger.layer([rotatingFileLogger(file, { maxBytes: 10, maxFiles: 2 })]).pipe(
          Layer.provide(NodeFileSystem.layer),
          Layer.orDie,
        ),
      ),
      Effect.scoped,
      Effect.runPromise,
    )

    // The pre-existing content moved to the ".1" backup, not to /dev/null.
    expect(await fs.readFile(`${file}.1`, "utf8")).toBe("already-there-before-rotation\n")

    // The OTHER engine's handle, opened before the rotation, still resolves to
    // real, readable bytes -- the rename kept the file alive for it instead of
    // unlinking it out from under a live reader.
    const buf = Buffer.alloc(64)
    const bytesRead = fsSync.readSync(otherEngineHandle, buf, 0, 64, 0)
    expect(buf.toString("utf8", 0, bytesRead)).toBe("already-there-before-rotation\n")
  } finally {
    fsSync.closeSync(otherEngineHandle)
  }
})

test("rotateIfOwned: two fds on the same oversize file rotate exactly once, and the real history survives", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "origami-log-rotate-race-"))
  await using _ = {
    async [Symbol.asyncDispose]() {
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
  const file = path.join(dir, "origami.log")
  const realHistory = "old-history-line\n".repeat(20)
  await fs.writeFile(file, realHistory)

  const maxBytes = 50
  const maxFiles = 3

  // Two "engines" on one log: both fds are opened before either one rotates,
  // so both hold the SAME original file (same device + inode).
  const fdA = fsSync.openSync(file, "a")
  const fdB = fsSync.openSync(file, "a")

  // A goes first and performs the real rotation. Without the identity check,
  // B's fd still reports the old file's (still over-cap) size on its own
  // check and would rotate AGAIN -- renaming A's fresh, near-empty file over
  // ".1" and pushing the real history down to ".2" (or losing it entirely
  // once more engines pile on).
  const nextA = rotateIfOwned(file, fdA, maxBytes, maxFiles)
  const nextB = rotateIfOwned(file, fdB, maxBytes, maxFiles)

  try {
    expect(await fs.readFile(`${file}.1`, "utf8")).toBe(realHistory)
    // Only one generation was produced -- B recognised A already rotated and
    // just followed along instead of rotating a second time.
    expect(await fs.stat(`${file}.2`).catch(() => undefined)).toBeUndefined()
  } finally {
    fsSync.closeSync(nextA)
    fsSync.closeSync(nextB)
  }
})

/** Counts the timers armed with exactly `ms` while `body` runs. Effect's `sleep`
 *  and a plain `setTimeout` both land on `globalThis.setTimeout`, so this sees
 *  every wake-up the logger schedules, whoever schedules it. */
async function countTimers<T>(
  ms: number,
  body: (seen: { count: number }) => Promise<T>,
): Promise<{ count: number; value: T }> {
  const real = globalThis.setTimeout
  const seen = { count: 0 }
  globalThis.setTimeout = ((fn: (...args: unknown[]) => void, delay?: number, ...rest: unknown[]) => {
    if (delay === ms) seen.count++
    return real(fn, delay, ...rest)
  }) as typeof setTimeout
  try {
    const value = await body(seen)
    return { count: seen.count, value }
  } finally {
    globalThis.setTimeout = real
  }
}

test("t-w2qlop: an idle file logger arms no flush timer, and one burst arms exactly one", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "origami-log-idle-"))
  await using _ = {
    async [Symbol.asyncDispose]() {
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
  const file = path.join(dir, "origami.log")
  // A window no other code in this process uses, so the count is the logger's.
  const window = 37
  const layer = Logger.layer([rotatingFileLogger(file, { batchWindow: window })]).pipe(
    Layer.provide(NodeFileSystem.layer),
    Layer.orDie,
  )

  const { count, value } = await countTimers(window, (seen) =>
    Effect.runPromise(
      Effect.gen(function* () {
        // Idle for about ten windows: the old `sleep(window) -> flush, forever`
        // loop woke the process on every one of them with nothing to write.
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, window * 10)))
        const idle = seen.count
        yield* Effect.logInfo("one")
        yield* Effect.logInfo("two")
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, window * 4)))
        return idle
      }).pipe(Effect.provide(layer), Effect.scoped),
    ),
  )
  expect(value).toBe(0)
  expect(count).toBe(1)
  const lines = (await fs.readFile(file, "utf8")).trim().split("\n")
  expect(lines).toHaveLength(2)
})

test("t-w2qlop: lines logged just before the scope closes are written, not dropped", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "origami-log-exit-"))
  await using _ = {
    async [Symbol.asyncDispose]() {
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
  const file = path.join(dir, "origami.log")
  // A window far longer than the test: only the close path can write these.
  await Effect.logInfo("last words").pipe(
    Effect.provide(
      Logger.layer([rotatingFileLogger(file, { batchWindow: 60_000 })]).pipe(
        Layer.provide(NodeFileSystem.layer),
        Layer.orDie,
      ),
    ),
    Effect.scoped,
    Effect.runPromise,
  )
  expect(await fs.readFile(file, "utf8")).toContain('message="last words"')
})

test("t-w2qlop: a pending batch is written by process exit, which runs no Effect finalizer", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "origami-log-exit-"))
  await using _ = {
    async [Symbol.asyncDispose]() {
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
  const file = path.join(dir, "origami.log")
  const module = path.resolve(import.meta.dir, "../../src/observability/logging.ts")
  // A child process that logs one line and calls process.exit() inside the
  // batch window, the way `index.ts` ends: the scope never closes there.
  const script = `
    import { Effect, Logger } from ${JSON.stringify(Bun.resolveSync("effect", import.meta.dir))}
    import { rotatingFileLogger } from ${JSON.stringify(module)}
    const layer = Logger.layer([rotatingFileLogger(${JSON.stringify(file)}, { batchWindow: 60_000 })])
    await Effect.runPromise(Effect.gen(function* () {
      yield* Effect.logInfo("before exit")
      process.exit(0)
    }).pipe(Effect.provide(layer), Effect.scoped))
  `
  const scriptFile = path.join(dir, "exit.ts")
  await fs.writeFile(scriptFile, script)
  const child = Bun.spawnSync([process.execPath, scriptFile], { cwd: path.resolve(import.meta.dir, "../..") })
  expect({ exit: child.exitCode, stderr: child.stderr.toString() }).toEqual({ exit: 0, stderr: "" })
  expect(await fs.readFile(file, "utf8").catch(() => "")).toContain('message="before exit"')
})

// t-wdybz9 (review finding 5): the flush runs from a raw timer. A reopen that
// fails (a read-only file, another engine rotating at that moment, antivirus)
// threw out of the timer: an uncaught exception, exit code 1. The fd variable
// also kept the number of the CLOSED file, so a later flush could stat, write
// to or close whatever the process opened next under that number.
test("t-wdybz9: a failed reopen neither crashes the process nor leaves the logger on a stale fd", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "origami-log-reopen-"))
  await using _ = {
    async [Symbol.asyncDispose]() {
      await fs.chmod(path.join(dir, "origami.log"), 0o644).catch(() => {})
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
  const file = path.join(dir, "origami.log")
  const victim = path.join(dir, "victim.txt")
  const module = path.resolve(import.meta.dir, "../../src/observability/logging.ts")
  const script = `
    import fs from "fs"
    import { Effect, Logger } from ${JSON.stringify(Bun.resolveSync("effect", import.meta.dir))}
    import { rotatingFileLogger } from ${JSON.stringify(module)}
    const layer = Logger.layer([rotatingFileLogger(${JSON.stringify(file)}, { batchWindow: 20, maxBytes: 1, maxFiles: 1 })])
    await Effect.runPromise(Effect.gen(function* () {
      yield* Effect.logInfo("first")
      yield* Effect.sleep("150 millis")
      fs.chmodSync(${JSON.stringify(file)}, 0o444)
      yield* Effect.logInfo("second")
      yield* Effect.sleep("150 millis")
      fs.chmodSync(${JSON.stringify(file)}, 0o644)
      const other = fs.openSync(${JSON.stringify(victim)}, "w")
      yield* Effect.logInfo("third")
      yield* Effect.sleep("150 millis")
      fs.closeSync(other)
    }).pipe(Effect.provide(layer), Effect.scoped))
    console.log("survived")
  `
  const scriptFile = path.join(dir, "reopen.ts")
  await fs.writeFile(scriptFile, script)
  const child = Bun.spawnSync([process.execPath, scriptFile], { cwd: path.resolve(import.meta.dir, "../..") })
  expect({ exit: child.exitCode, stdout: child.stdout.toString().trim() }).toEqual({ exit: 0, stdout: "survived" })
  const log = await fs.readFile(file, "utf8")
  expect(log).toContain("message=first")
  expect(log).toContain("message=third")
  expect(await fs.readFile(victim, "utf8")).toBe("")
})
