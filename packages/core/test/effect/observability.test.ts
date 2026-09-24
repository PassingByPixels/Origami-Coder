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
