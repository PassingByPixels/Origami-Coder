import { describe, expect } from "bun:test"
import { Effect, Fiber } from "effect"
import { cachedInvalidateForever } from "@origami/core/effect/cached"
import { ResizerUnavailableError } from "@origami/core/image"
import { it } from "../lib/effect"

/**
 * t-ru0by6 item 2. `core/src/image/photon.ts:14` used to load the
 * `@silvia-odwyer/photon-node` adapter with a bare `Effect.cached`, which
 * memoises an INTERRUPT exit forever (the t-qbpgu3 root cause pinned in
 * `core/test/effect/cached.test.ts`). The site now wraps the identical
 * import/catch shape in `cachedInvalidateForever`. This drives that exact
 * shape through a controllable dynamic import so a first caller can be
 * interrupted mid-load, then proves the second caller still gets a real
 * answer instead of the interrupt.
 *
 * t-x3ahdb: the pending import is a promise on `gate`, not `mock.module` with a
 * gated factory. When an earlier file in the same `bun test` process has
 * loaded the module, bun runs that factory at once and waits on its promise,
 * which only this test resolves: the whole run hung. A module mock also stays
 * for later files and would hand them this stub instead of the real photon.
 */

let release: (() => void) | undefined
const gate = new Promise<void>((resolve) => {
  release = resolve
})

const importPhoton = () => gate.then(() => ({ marker: "photon-node" }))

describe("Image.Photon adapter cache", () => {
  it.live("an interrupted first loader does not poison the second caller", () =>
    Effect.gen(function* () {
      const [loadPhoton] = yield* cachedInvalidateForever(
        Effect.tryPromise({
          try: importPhoton,
          catch: () => new ResizerUnavailableError(),
        }),
      )

      const cancelled = yield* Effect.forkChild(loadPhoton)
      // The import stays pending on `gate` until released below, so
      // this sleep only proves the fiber has started, not that it finished.
      yield* Effect.sleep("5 millis")
      yield* Fiber.interrupt(cancelled)

      release?.()
      const result = yield* loadPhoton
      expect(result).toMatchObject({ marker: "photon-node" })
    }),
  )
})
