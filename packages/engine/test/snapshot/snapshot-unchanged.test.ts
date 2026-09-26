import { afterEach, expect } from "bun:test"
import { CrossSpawnSpawner } from "@origami/core/cross-spawn-spawner"
import { LayerNode } from "@origami/core/effect/layer-node"
import { FSUtil } from "@origami/core/fs-util"
import { Global } from "@origami/core/global"
import { Hash } from "@origami/core/util/hash"
import { execFileSync } from "child_process"
import { existsSync, readdirSync } from "fs"
import path from "path"
import { Effect, Layer } from "effect"
import { Snapshot } from "../../src/snapshot"
import { SnapshotGit } from "../../src/snapshot/git-runner"
import { disposeAllInstances, provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// t-woacbl: every git process the snapshot starts is on the step's path to the
// first word, and under load each one costs 150-1,000 ms (process start plus
// run). A turn that changed no file must not start git processes whose answer
// is already known: a diff of a tree with itself, and a tree written from an
// index that nobody changed since the last write.

const it = testEffect(
  Layer.mergeAll(LayerNode.compile(LayerNode.group([Snapshot.node, FSUtil.node])), testInstanceStoreLayer),
)

afterEach(async () => {
  SnapshotGit.testing.reset()
  await disposeAllInstances()
})

const write = (file: string, content: string) => FSUtil.Service.use((fs) => fs.writeWithDirs(file, content))
const gitTmpdir = () => tmpdirScoped({ git: true }).pipe(Effect.provide(LayerNode.compile(CrossSpawnSpawner.node)))
const runs = () => {
  const counts = SnapshotGit.testing.counts()
  return counts.worker + counts.inline
}

// The snapshot gitdir of a worktree: <data>/snapshot/<project id>/<hash of the worktree>.
const gitdirOf = (worktree: string) => {
  const root = path.join(Global.Path.data, "snapshot")
  for (const project of readdirSync(root)) {
    const candidate = path.join(root, project, Hash.fast(worktree))
    if (existsSync(candidate)) return candidate
  }
  throw new Error(`no snapshot gitdir for ${worktree}`)
}

it.live("a diff of a tree with itself starts no git process", () =>
  Effect.gen(function* () {
    const dir = yield* gitTmpdir()
    yield* write(`${dir}/a.txt`, "alpha\n")
    yield* Effect.gen(function* () {
      const snapshot = yield* Snapshot.Service
      const tree = yield* snapshot.track()
      expect(tree).toMatch(/^[0-9a-f]{40}$/)
      SnapshotGit.testing.reset()
      expect(yield* snapshot.diffFull(tree!, tree!)).toEqual([])
      expect(runs()).toBe(0)
    }).pipe(provideInstance(dir))
  }),
)

it.live("a track of an unchanged worktree does not write the tree again", () =>
  Effect.gen(function* () {
    const dir = yield* gitTmpdir()
    yield* write(`${dir}/a.txt`, "alpha\n")
    yield* write(`${dir}/new.txt`, "untracked\n")
    yield* Effect.gen(function* () {
      const snapshot = yield* Snapshot.Service
      const first = yield* snapshot.track()
      SnapshotGit.testing.reset()
      const second = yield* snapshot.track()
      expect(second).toBe(first)
      // The two listings (tracked changes, untracked files) and no write-tree.
      expect(runs()).toBe(2)
    }).pipe(provideInstance(dir))
  }),
)

it.live("an edit after a track gives a new tree", () =>
  Effect.gen(function* () {
    const dir = yield* gitTmpdir()
    yield* write(`${dir}/a.txt`, "alpha\n")
    yield* Effect.gen(function* () {
      const snapshot = yield* Snapshot.Service
      const first = yield* snapshot.track()
      yield* snapshot.track()
      yield* write(`${dir}/a.txt`, "alpha changed\n")
      const second = yield* snapshot.track()
      expect(second).not.toBe(first)
      const diffs = yield* snapshot.diffFull(first!, second!)
      expect(diffs.map((item) => item.file)).toEqual(["a.txt"])
    }).pipe(provideInstance(dir))
  }),
)

// A second engine on the same folder shares the snapshot gitdir. When it stages
// an edit, this engine's listing sees nothing left to stage, but the index is no
// longer the one its last tree was written from: the old tree would be stale,
// and a revert to a stale tree deletes the edit.
it.live("an index another process changed is written again, not reused", () =>
  Effect.gen(function* () {
    const dir = yield* gitTmpdir()
    yield* write(`${dir}/a.txt`, "alpha\n")
    yield* Effect.gen(function* () {
      const snapshot = yield* Snapshot.Service
      const first = yield* snapshot.track()
      yield* write(`${dir}/a.txt`, "alpha from the other engine\n")
      const gitdir = gitdirOf(dir)
      execFileSync(
        "git",
        ["-c", "core.autocrlf=false", "--git-dir", gitdir, "--work-tree", dir, "add", "--all", "--", "a.txt"],
        { cwd: dir },
      )
      const second = yield* snapshot.track()
      expect(second).not.toBe(first)
      const shown = execFileSync("git", ["--git-dir", gitdir, "show", `${second}:a.txt`], { cwd: dir }).toString()
      expect(shown).toBe("alpha from the other engine\n")
    }).pipe(provideInstance(dir))
  }),
)

it.live("a restore to an older tree is followed by that tree, not the last one written", () =>
  Effect.gen(function* () {
    const dir = yield* gitTmpdir()
    yield* write(`${dir}/a.txt`, "one\n")
    yield* Effect.gen(function* () {
      const snapshot = yield* Snapshot.Service
      const first = yield* snapshot.track()
      yield* write(`${dir}/a.txt`, "two\n")
      const second = yield* snapshot.track()
      expect(second).not.toBe(first)
      yield* snapshot.restore(first!)
      expect(yield* snapshot.track()).toBe(first)
    }).pipe(provideInstance(dir))
  }),
)
