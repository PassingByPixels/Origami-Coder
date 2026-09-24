/**
 * t-tc1haz: a snapshot is complete or it is not taken, and a patch between two
 * trees costs no add pass.
 *
 * `git add` stages all of its paths or none. On master one vanished path, or
 * another engine's index.lock on the shared snapshot gitdir, left the index at
 * an older state, `track()` still wrote a tree from it, and a revert against
 * that tree deleted files that were on disk before the step. The spy
 * AppProcess reproduces both races at the exact moment: just before the
 * snapshot's `git add` runs.
 */
import { afterEach, expect } from "bun:test"
import { LayerNode } from "@origami/core/effect/layer-node"
import { AppProcess } from "@origami/core/process"
import { FSUtil } from "@origami/core/fs-util"
import fs from "fs/promises"
import { rmSync, writeFileSync } from "fs"
import path from "path"
import { Effect, Layer } from "effect"
import { Snapshot } from "../../src/snapshot"
import { disposeAllInstances, testInstanceStoreLayer, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { gitSpy, gitSpyLayer, isAddPass, subcommand } from "../lib/git-spy"

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(LayerNode.group([Snapshot.node, FSUtil.node]), [[AppProcess.node, gitSpyLayer]]),
    testInstanceStoreLayer,
  ),
)

afterEach(async () => {
  gitSpy.reset()
  await disposeAllInstances()
})

const read = (file: string) => Effect.promise(() => fs.readFile(file, "utf8"))
const exists = (file: string) => Effect.promise(() => fs.stat(file).then(() => true, () => false))
const write = (file: string, text: string) => Effect.promise(() => fs.writeFile(file, text))

const isStage = (args: readonly string[]) => subcommand(args) === "add" && args.includes("--pathspec-from-file=-")
const gitdirOf = (args: readonly string[]) => args[args.indexOf("--git-dir") + 1]!

/** Two files on disk before the first snapshot, untracked in the source repo. */
const setup = Effect.gen(function* () {
  const dir = (yield* TestInstance).directory
  yield* write(path.join(dir, "a.txt"), "A before")
  yield* write(path.join(dir, "b.txt"), "B before")
  return dir
})

/** Runs `act` once, just before the first snapshot `git add`. */
const beforeFirstStage = (act: (args: readonly string[]) => void) => {
  let done = false
  gitSpy.before = (args) => {
    if (done || !isStage(args)) return
    done = true
    act(args)
  }
}

it.instance(
  "a path that vanishes before git add does not leave the snapshot empty",
  Effect.gen(function* () {
    const dir = yield* setup
    const temp = path.join(dir, "save.tmp123")
    yield* write(temp, "atomic write in progress")
    // An atomic writer renames its temp file away after the listing saw it.
    beforeFirstStage(() => rmSync(temp))

    const snapshot = yield* Snapshot.Service
    const before = yield* snapshot.track()
    expect(before).toBeTruthy()
    gitSpy.before = undefined

    // Nothing changed since the snapshot, so nothing may differ from it.
    expect((yield* snapshot.patch(before!)).files).toEqual([])
  }),
  { git: true },
)

it.instance(
  "revert keeps a file that existed before the step after a vanished path",
  Effect.gen(function* () {
    const dir = yield* setup
    const temp = path.join(dir, "save.tmp456")
    yield* write(temp, "atomic write in progress")
    beforeFirstStage(() => rmSync(temp))

    const snapshot = yield* Snapshot.Service
    const before = yield* snapshot.track()
    expect(before).toBeTruthy()
    gitSpy.before = undefined

    // The step edits a file the user had before it.
    yield* write(path.join(dir, "a.txt"), "A edited by the agent")
    const patch = yield* snapshot.patch(before!)
    yield* snapshot.revert([patch])

    expect(yield* read(path.join(dir, "a.txt"))).toBe("A before")
    expect(yield* read(path.join(dir, "b.txt"))).toBe("B before")
  }),
  { git: true },
)

it.instance(
  "a snapshot waits for another git process's index.lock",
  Effect.gen(function* () {
    const dir = yield* setup
    beforeFirstStage((args) => {
      const lock = path.join(gitdirOf(args), "index.lock")
      writeFileSync(lock, "")
      // The other engine's add finishes a moment later.
      setTimeout(() => rmSync(lock, { force: true }), 300)
    })

    const snapshot = yield* Snapshot.Service
    const before = yield* snapshot.track()
    expect(before).toBeTruthy()
    gitSpy.before = undefined

    expect((yield* snapshot.patch(before!)).files).toEqual([])
    expect(yield* exists(path.join(dir, "a.txt"))).toBe(true)
  }),
  { git: true },
)

it.instance(
  "a snapshot is not taken while index.lock stays held",
  Effect.gen(function* () {
    yield* setup
    let lock: string | undefined
    beforeFirstStage((args) => {
      lock = path.join(gitdirOf(args), "index.lock")
      writeFileSync(lock, "")
    })

    const snapshot = yield* Snapshot.Service
    const before = yield* snapshot.track()
    if (lock) rmSync(lock, { force: true })
    gitSpy.before = undefined

    // No tree at all, rather than a tree of the old index.
    expect(lock).toBeTruthy()
    expect(before).toBeUndefined()
  }),
  { git: true },
  20_000,
)

it.instance(
  "a patch between two trees lists what differs between them and runs no add pass",
  Effect.gen(function* () {
    const dir = yield* setup
    const snapshot = yield* Snapshot.Service
    const before = yield* snapshot.track()
    yield* write(path.join(dir, "a.txt"), "A changed")
    yield* Effect.promise(() => fs.rm(path.join(dir, "b.txt")))
    yield* write(path.join(dir, "new.txt"), "new")
    const after = yield* snapshot.track()
    // A change after the second tree is not part of the step.
    yield* write(path.join(dir, "later.txt"), "later")

    gitSpy.reset()
    const patch = yield* snapshot.patch(before!, after!)
    const names = patch.files.map((file) => path.basename(file)).sort()

    expect(patch.hash).toBe(before!)
    expect(names).toEqual(["a.txt", "b.txt", "new.txt"])
    expect(gitSpy.calls.filter((call) => isAddPass(call.args) || isStage(call.args))).toEqual([])
  }),
  { git: true },
)

it.instance(
  "a patch from a tree to itself is empty and runs no git",
  Effect.gen(function* () {
    const dir = yield* setup
    const snapshot = yield* Snapshot.Service
    const tree = yield* snapshot.track()
    yield* write(path.join(dir, "a.txt"), "A changed after the tree")

    gitSpy.reset()
    expect((yield* snapshot.patch(tree!, tree!)).files).toEqual([])
    expect(gitSpy.calls).toEqual([])
  }),
  { git: true },
)
