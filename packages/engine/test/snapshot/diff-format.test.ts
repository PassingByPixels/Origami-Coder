// t-tc1mhl: the patch FORMAT diffFull stores in summary.diffs. A whole-file
// patch per changed file made the message table 95% summary.diffs on the
// owner's store (one edit to a 32 MB file = a 33 MB row). Patches are now
// hunks with 3 lines of context, and a side over the 2 MB snapshot limit gets
// stats but no patch.
import { afterEach, expect } from "bun:test"
import { LayerNode } from "@origami/core/effect/layer-node"
import { FSUtil } from "@origami/core/fs-util"
import { Effect, Layer } from "effect"
import { Snapshot } from "../../src/snapshot"
import { disposeAllInstances, testInstanceStoreLayer, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(LayerNode.compile(LayerNode.group([Snapshot.node, FSUtil.node])), testInstanceStoreLayer),
)

afterEach(async () => {
  await disposeAllInstances()
})

const write = (file: string, content: string) => FSUtil.Service.use((fs) => fs.writeWithDirs(file, content))
const lines = (count: number, edit?: number) =>
  Array.from({ length: count }, (_, i) => (i === edit ? `line ${i} EDITED` : `line ${i}`)).join("\n") + "\n"

it.instance(
  "a one-line edit to a long file stores one small hunk, not the whole file",
  () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      yield* write(`${dir}/long.txt`, lines(2000))
      const snapshot = yield* Snapshot.Service
      const before = yield* snapshot.track()
      yield* write(`${dir}/long.txt`, lines(2000, 1000))
      const after = yield* snapshot.track()

      const [diff] = yield* snapshot.diffFull(before!, after!)
      expect(diff?.file).toBe("long.txt")
      expect(diff?.additions).toBe(1)
      expect(diff?.deletions).toBe(1)
      expect(diff?.patch).toContain("-line 1000\n")
      expect(diff?.patch).toContain("+line 1000 EDITED\n")
      // 3 lines of context on each side, and nothing further away.
      expect(diff?.patch).toContain(" line 997\n")
      expect(diff?.patch).toContain(" line 1003\n")
      expect(diff?.patch).not.toContain(" line 996\n")
      expect(diff?.patch).not.toContain(" line 0\n")
      expect(diff?.patch).toContain("@@ -998,7 +998,7 @@")
      // The whole file is ~21 KB; the hunk is a few hundred bytes.
      expect(diff!.patch!.length).toBeLessThan(500)
    }),
  { git: true },
)

it.instance(
  "a side over the 2 MB snapshot limit keeps its stats and stores no patch",
  () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      yield* write(`${dir}/big.json`, "small\n")
      yield* write(`${dir}/small.txt`, "a\n")
      const snapshot = yield* Snapshot.Service
      const before = yield* snapshot.track()
      // 2.2 MB: over the limit on the after side.
      yield* write(`${dir}/big.json`, "y\n".repeat(1_100_000))
      yield* write(`${dir}/small.txt`, "b\n")
      const after = yield* snapshot.track()

      const diffs = yield* snapshot.diffFull(before!, after!)
      const big = diffs.find((d) => d.file === "big.json")
      const small = diffs.find((d) => d.file === "small.txt")
      expect(big).toBeDefined()
      expect(big!.additions).toBeGreaterThan(1_000_000)
      expect(big!.status).toBe("modified")
      expect(big!.patch).toBeUndefined()
      expect(small?.patch).toContain("+b\n")
    }),
  { git: true },
)
