import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@origami/core/effect/layer-node"
import { Effect, Exit, Fiber } from "effect"
import { Image } from "@/image/image"
import { Config } from "@/config/config"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"

/**
 * t-tc1tnk (scout B#15). The engine's image service loaded photon through a
 * bare `Effect.cached`. The load runs on the first caller's fiber, so a turn
 * cancelled while the first picture of the process was loading left the
 * INTERRUPT as the cached loader: every later picture failed until restart.
 * `catchIf(ResizerUnavailableError)` in prompt.ts does not catch an interrupt.
 *
 * The loader's first step assigns `globalThis.__ORIGAMI_PHOTON_WASM_PATH`.
 * These tests put a setter on that global so the FIRST load is interrupted (or
 * dies) at an exact point, with no timing race.
 */

const KEY = "__ORIGAMI_PHOTON_WASM_PATH"
const it = testEffect(LayerNode.compile(Image.node, [[Config.node, TestConfig.layer()]]))

const webp = () => ({
  id: PartID.ascending(),
  messageID: MessageID.ascending(),
  sessionID: SessionID.make("ses_test"),
  type: "file" as const,
  mime: "image/webp",
  url: "data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA",
})

/** Run `onFirst` on the first assignment of the wasm path, then behave as a plain property. */
const trapFirstLoad = (onFirst: () => void) => {
  let value = (globalThis as Record<string, unknown>)[KEY]
  let armed = true
  Object.defineProperty(globalThis, KEY, {
    configurable: true,
    get: () => value,
    set: (next) => {
      value = next
      if (!armed) return
      armed = false
      onFirst()
    },
  })
}

afterEach(() => {
  const value = (globalThis as Record<string, unknown>)[KEY]
  Object.defineProperty(globalThis, KEY, { configurable: true, writable: true, value })
})

describe("Image photon loader", () => {
  it.live("a first load that is interrupted is not what every later picture gets", () =>
    Effect.gen(function* () {
      trapFirstLoad(() => Fiber.getCurrent()?.interruptUnsafe())
      const image = yield* Image.Service

      const first = yield* Effect.forkChild(image.normalize(webp()))
      const firstExit = yield* Fiber.await(first)
      expect(Exit.hasInterrupts(firstExit)).toBe(true)

      const second = yield* Effect.exit(image.normalize(webp()).pipe(Effect.timeout("10 seconds")))
      expect(Exit.isSuccess(second)).toBe(true)
    }),
  )

  it.live("a first load that dies is not what every later picture gets", () =>
    Effect.gen(function* () {
      trapFirstLoad(() => {
        throw new Error("boom")
      })
      const image = yield* Image.Service

      expect(Exit.hasDies(yield* Effect.exit(image.normalize(webp())))).toBe(true)
      const second = yield* Effect.exit(image.normalize(webp()).pipe(Effect.timeout("10 seconds")))
      expect(Exit.isSuccess(second)).toBe(true)
    }),
  )
})
