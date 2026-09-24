import { describe, expect } from "bun:test"
import path from "path"
import { LayerNode } from "@origami/core/effect/layer-node"
import { Effect, Fiber, Layer } from "effect"
import { FSUtil } from "@origami/core/fs-util"
import { CrossSpawnSpawner } from "@origami/core/cross-spawn-spawner"
import { Global } from "@origami/core/global"
import { Storage } from "@/storage/storage"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

/**
 * t-ru0by6 item 2. `engine/src/storage/storage.ts:222` cached the migration
 * state (the resolved storage dir, reached after running any pending
 * migrations) with a bare `Effect.cached`, the same interrupt-poisoning
 * hazard pinned in `core/test/effect/cached.test.ts` (t-qbpgu3). The site
 * now uses `cachedInvalidateForever`. This remaps the global data dir to a
 * scoped tmp dir (same technique as storage.test.ts's migration tests), then
 * stalls the migration marker's read on a gate so a first caller — any
 * Storage method, since they all resolve `state` first — can be interrupted
 * mid-load, then proves the second caller still resolves instead of
 * inheriting the interrupt.
 */

const dir = path.join(Global.Path.data, "storage")

function remap(root: string, file: string) {
  if (file === Global.Path.data) return root
  if (file.startsWith(Global.Path.data + path.sep)) return path.join(root, path.relative(Global.Path.data, file))
  return file
}

let release: (() => void) | undefined
const gate = new Promise<void>((resolve) => {
  release = resolve
})
let stalled = false

function remappedFs(root: string) {
  return Layer.effect(
    FSUtil.Service,
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      return FSUtil.Service.of({
        ...fs,
        isDir: (file) => fs.isDir(remap(root, file)),
        readJson: (file) => fs.readJson(remap(root, file)),
        writeWithDirs: (file, content, mode) => fs.writeWithDirs(remap(root, file), content, mode),
        readFileString: (file) => {
          const target = remap(root, file)
          if (path.basename(target) === "migration" && !stalled) {
            stalled = true
            return Effect.promise(() => gate).pipe(Effect.flatMap(() => fs.readFileString(target)))
          }
          return fs.readFileString(target)
        },
        remove: (file) => fs.remove(remap(root, file)),
        glob: (pattern, options) =>
          fs.glob(pattern, options?.cwd ? { ...options, cwd: remap(root, options.cwd) } : options),
      })
    }),
  ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
}

const remappedStorage = (root: string) =>
  Layer.fresh(LayerNode.compile(Storage.node, [[FSUtil.node, remappedFs(root)]]))

const it = testEffect(LayerNode.compile(LayerNode.group([Storage.node, FSUtil.node, CrossSpawnSpawner.node])))

describe("Storage state cache", () => {
  it.live("an interrupted first caller does not poison the second", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const tmp = yield* tmpdirScoped()
      const storage = path.join(tmp, "storage")

      yield* Effect.gen(function* () {
        const svc = yield* Storage.Service

        // The migration marker read is stalled on `gate`, so this write's
        // resolution of `state` is still in flight when we interrupt it.
        const cancelled = yield* Effect.forkChild(svc.write(["cache_probe"], { ok: true }))
        yield* Effect.sleep("5 millis")
        yield* Fiber.interrupt(cancelled)

        release?.()
        yield* svc.write(["cache_probe"], { ok: true })
        expect(yield* svc.read<{ ok: boolean }>(["cache_probe"])).toEqual({ ok: true })
      }).pipe(Effect.provide(remappedStorage(tmp)))

      expect(yield* fs.isFile(path.join(storage, "cache_probe.json"))).toBe(true)
    }),
  )
})
