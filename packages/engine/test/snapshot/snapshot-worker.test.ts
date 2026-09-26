import { afterEach, expect } from "bun:test"
import { CrossSpawnSpawner } from "@origami/core/cross-spawn-spawner"
import { LayerNode } from "@origami/core/effect/layer-node"
import { FSUtil } from "@origami/core/fs-util"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { Snapshot } from "../../src/snapshot"
import { SnapshotGit } from "../../src/snapshot/git-runner"
import { disposeAllInstances, provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// t-w2r1kf: the snapshot's git commands run on a Bun Worker. Tree hashes and
// patch file lists must be the same as the inline run, and every failure of the
// Worker must end in the inline run, not in a missing snapshot.

const it = testEffect(
  Layer.mergeAll(LayerNode.compile(LayerNode.group([Snapshot.node, FSUtil.node])), testInstanceStoreLayer),
)

afterEach(async () => {
  SnapshotGit.testing.setMode("auto")
  SnapshotGit.testing.setWorkerUrl(undefined)
  SnapshotGit.testing.reset()
  await disposeAllInstances()
})

const write = (file: string, content: string | Uint8Array) =>
  FSUtil.Service.use((fs) => fs.writeWithDirs(file, content))

const gitTmpdir = () => tmpdirScoped({ git: true }).pipe(Effect.provide(LayerNode.compile(CrossSpawnSpawner.node)))

// The same edits in every run: text, CRLF, a sub folder, a non-ASCII name, a
// binary file, an ignored file, a delete and an add.
const scenario = Effect.gen(function* () {
  const dir = yield* gitTmpdir()
  yield* write(`${dir}/a.txt`, "alpha\n")
  yield* write(`${dir}/b.txt`, "bravo\r\ncharlie\r\n")
  yield* write(`${dir}/sub/c.txt`, "charlie\n")
  yield* write(`${dir}/naïve file.txt`, "unicode name\n")
  yield* write(`${dir}/bin.dat`, new Uint8Array([0, 1, 2, 255, 0, 10]))
  yield* write(`${dir}/.gitignore`, "ignored.log\n")
  return yield* Effect.gen(function* () {
    const snapshot = yield* Snapshot.Service
    const before = yield* snapshot.track()
    yield* write(`${dir}/a.txt`, "alpha changed\n")
    yield* Effect.promise(() => fs.rm(`${dir}/b.txt`))
    yield* write(`${dir}/sub/new.txt`, "new\n")
    yield* write(`${dir}/ignored.log`, "noise\n")
    const patch = yield* snapshot.patch(before!)
    const after = yield* snapshot.track()
    const diffs = yield* snapshot.diffFull(before!, after!)
    return {
      before,
      after,
      files: patch.files.map((file) => path.relative(dir, file).replaceAll("\\", "/")).sort(),
      diffs: diffs.map((item) => ({ ...item })).sort((a, b) => (a.file ?? "").localeCompare(b.file ?? "")),
    }
  }).pipe(provideInstance(dir))
})

it.live("Worker and inline give the same hashes, patch files and diffs", () =>
  Effect.gen(function* () {
    SnapshotGit.testing.setMode("auto")
    const onWorker = yield* scenario
    const counts = SnapshotGit.testing.counts()
    expect(counts.worker).toBeGreaterThan(5)
    expect(counts.inline).toBe(0)

    SnapshotGit.testing.reset()
    SnapshotGit.testing.setMode("inline")
    const inline = yield* scenario
    expect(SnapshotGit.testing.counts()).toEqual({ worker: 0, inline: counts.worker })

    expect(onWorker.before).toMatch(/^[0-9a-f]{40}$/)
    expect(onWorker.after).toMatch(/^[0-9a-f]{40}$/)
    expect(onWorker.before).toBe(inline.before)
    expect(onWorker.after).toBe(inline.after)
    expect(onWorker.files).toEqual(["a.txt", "b.txt", "sub/new.txt"])
    expect(onWorker.files).toEqual(inline.files)
    expect(onWorker.diffs.length).toBeGreaterThan(0)
    expect(onWorker.diffs).toEqual(inline.diffs)
  }),
)

it.live("falls back to inline when the Worker script cannot load", () =>
  Effect.gen(function* () {
    SnapshotGit.testing.setMode("inline")
    const expected = yield* scenario
    SnapshotGit.testing.reset()

    SnapshotGit.testing.setMode("auto")
    SnapshotGit.testing.setWorkerUrl(path.join(import.meta.dir, "does-not-exist-worker.ts"))
    const result = yield* scenario
    expect(result).toEqual(expected)
    expect(SnapshotGit.testing.counts().worker).toBe(0)
    expect(SnapshotGit.testing.counts().inline).toBeGreaterThan(5)
  }),
)

it.live("falls back to inline when the Worker dies in the middle of a call", () =>
  Effect.gen(function* () {
    SnapshotGit.testing.setMode("inline")
    const expected = yield* scenario
    SnapshotGit.testing.reset()

    // Says "ready", then throws on its first request.
    const dir = yield* tmpdirScoped().pipe(Effect.provide(LayerNode.compile(CrossSpawnSpawner.node)))
    const script = path.join(dir, "dying-worker.ts")
    yield* Effect.promise(() =>
      fs.writeFile(
        script,
        `self.onmessage = () => { throw new Error("worker died") }\nself.postMessage({ type: "ready" })\n`,
      ),
    )
    SnapshotGit.testing.setMode("auto")
    SnapshotGit.testing.setWorkerUrl(script)
    const result = yield* scenario
    expect(result).toEqual(expected)
    expect(SnapshotGit.testing.counts().worker).toBe(0)
    expect(SnapshotGit.testing.isRunning()).toBe(false)
  }),
)

// t-w1r73y (R4 hang): git has exited, but its output pipe stays open because
// another process holds git's end of it. On Windows that is any process the
// main thread starts while the Worker starts git (an MCP server at a chat's
// first prompt): it inherits the Worker's pipe handles and keeps them for its
// whole life. Here the holder is a background `sleep` that git's alias leaves.
// The run must answer with git's output and exit code, not wait for the holder.
it.live(
  "answers when git has exited but another process keeps its output open",
  () =>
    Effect.gen(function* () {
      const holdSeconds = 15
      const started = Date.now()
      const output = yield* SnapshotGit.run(
        { args: ["-c", `alias.r4hold=!echo held-output; sleep ${holdSeconds} &`, "r4hold"] },
        Effect.die(new Error("the inline run must not be needed")),
      )
      const took = Date.now() - started
      expect(new TextDecoder().decode(output.stdout).trim()).toBe("held-output")
      expect(output.code).toBe(0)
      expect(took).toBeLessThan(5_000)
      expect(SnapshotGit.testing.counts()).toEqual({ worker: 1, inline: 0 })
    }),
  30_000,
)

// t-w1r73y: a Worker that takes a run and never answers must not hold the
// snapshot (and the turn) forever: the call ends in the inline run.
it.live(
  "falls back to inline when the Worker takes a run and never answers",
  () =>
    Effect.gen(function* () {
      SnapshotGit.testing.setMode("inline")
      const expected = yield* scenario
      SnapshotGit.testing.reset()

      const dir = yield* tmpdirScoped().pipe(Effect.provide(LayerNode.compile(CrossSpawnSpawner.node)))
      const script = path.join(dir, "silent-worker.ts")
      yield* Effect.promise(() =>
        fs.writeFile(script, `self.onmessage = () => {}\nself.postMessage({ type: "ready" })\n`),
      )
      SnapshotGit.testing.setMode("auto")
      SnapshotGit.testing.setWorkerUrl(script)
      SnapshotGit.testing.setAnswerTimeout(500)
      const result = yield* scenario
      expect(result).toEqual(expected)
      expect(SnapshotGit.testing.counts().worker).toBe(0)
      expect(SnapshotGit.testing.isRunning()).toBe(false)
    }),
  30_000,
)
