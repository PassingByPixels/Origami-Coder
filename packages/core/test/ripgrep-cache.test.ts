import { describe, expect } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import { LayerNode } from "@origami/core/effect/layer-node"
import { FSUtil } from "@origami/core/fs-util"
import { RipgrepBinary } from "@origami/core/ripgrep/binary"
import { testEffect } from "./lib/effect"

/**
 * t-ru0by6 item 2. `core/src/ripgrep/binary.ts:92` resolved and cached the rg
 * binary path with a bare `Effect.cached`, the same interrupt-poisoning
 * hazard pinned in `core/test/effect/cached.test.ts` (t-qbpgu3). The site now
 * uses `cachedInvalidateForever`. This swaps in an FSUtil whose `isFile`
 * blocks on a gate for the `ORIGAMI_RG_PATH` rung only, so a first resolver
 * can be interrupted mid-check, then proves the second caller still resolves
 * instead of inheriting the interrupt.
 */

const FAKE_RG_PATH = "C:/tmp/origami-test/fake-rg-interrupt.exe"

let release: (() => void) | undefined
const gate = new Promise<void>((resolve) => {
  release = resolve
})

const slowFs = Layer.effect(
  FSUtil.Service,
  Effect.gen(function* () {
    const real = yield* FSUtil.Service
    return FSUtil.Service.of({
      ...real,
      isFile: (path: string) => (path === FAKE_RG_PATH ? Effect.promise(() => gate.then(() => true)) : real.isFile(path)),
    })
  }),
).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))

const it = testEffect(Layer.fresh(LayerNode.compile(RipgrepBinary.node, [[FSUtil.node, slowFs]])))

describe("RipgrepBinary.filepath cache", () => {
  it.live("an interrupted first resolver does not poison the second caller", () =>
    Effect.gen(function* () {
      const previous = process.env["ORIGAMI_RG_PATH"]
      process.env["ORIGAMI_RG_PATH"] = FAKE_RG_PATH
      try {
        const svc = yield* RipgrepBinary.Service
        const cancelled = yield* Effect.forkChild(svc.filepath)
        // The isFile check stays pending on `gate` until released below.
        yield* Effect.sleep("5 millis")
        yield* Fiber.interrupt(cancelled)

        release?.()
        const result = yield* svc.filepath
        expect(result).toBe(FAKE_RG_PATH)
      } finally {
        if (previous === undefined) delete process.env["ORIGAMI_RG_PATH"]
        else process.env["ORIGAMI_RG_PATH"] = previous
      }
    }),
  )
})
