import { describe, expect, mock } from "bun:test"
import { Effect, Fiber } from "effect"
import { cachedInvalidateForever } from "@origami/core/effect/cached"
import { ResizerUnavailableError } from "@origami/core/image"
import { it } from "../lib/effect"

/**
 * t-ru0by6 item 2. `core/src/image.ts:51` used to load the photon adapter
 * module with a bare `Effect.cached`, the same interrupt-poisoning hazard
 * pinned in `core/test/effect/cached.test.ts` (t-qbpgu3). The site now wraps
 * the identical import/flatMap shape in `cachedInvalidateForever`. This
 * drives that shape through a controllable dynamic import of `./image/photon`
 * so a first caller can be interrupted mid-load, then proves the second
 * caller still gets a real answer instead of the interrupt.
 */

let release: (() => void) | undefined
const gate = new Promise<void>((resolve) => {
  release = resolve
})

const MARKER = () => Effect.succeed("normalize-fn" as never)

void mock.module("../../src/image/photon", () => gate.then(() => ({ make: Effect.succeed(MARKER) })))

describe("Image.Service adapter cache", () => {
  it.live("an interrupted first loader does not poison the second caller", () =>
    Effect.gen(function* () {
      const [loadAdapter] = yield* cachedInvalidateForever(
        (
          Effect.tryPromise({
            try: () => import("../../src/image/photon"),
            catch: () => new ResizerUnavailableError(),
          }) as unknown as Effect.Effect<{ make: Effect.Effect<typeof MARKER> }, ResizerUnavailableError>
        ).pipe(Effect.flatMap((adapter) => adapter.make)),
      )

      const cancelled = yield* Effect.forkChild(loadAdapter)
      yield* Effect.sleep("5 millis")
      yield* Fiber.interrupt(cancelled)

      release?.()
      const result = yield* loadAdapter
      expect(result).toBe(MARKER)
    }),
  )
})
