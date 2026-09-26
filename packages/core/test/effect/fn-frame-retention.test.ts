import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { cachedInvalidateForever } from "@origami/core/effect/cached"

/**
 * t-x3admf. Effect annotates every failure with the fiber's current `Effect.fn`
 * stack frame. The frame's `stack` thunk was made inside the call, so it kept the
 * call's `arguments`, and through `parent` the arguments of every `Effect.fn`
 * call above it. Anything that keeps a failure, a Cause or an Exit past the
 * call therefore kept those arguments: after a failed request the engine kept
 * a whole step input (180 MB for a big chat).
 *
 * A failure may keep the frame's name and call site, never the arguments.
 *
 * Reachability is checked through the garbage collector. Bun's collector also
 * scans the machine stack conservatively, so a stale stack slot can keep one
 * object by chance; each test therefore uses several inputs and allows one.
 * The defect keeps every one of them.
 */

const INPUTS = 8

/** A step input, as a turn passes it down: only a WeakRef to it is kept here. */
function inputs() {
  const refs: WeakRef<object>[] = []
  const make = () => {
    const messages = [{ role: "user", content: "x".repeat(10_000) }]
    refs.push(new WeakRef(messages))
    return { messages }
  }
  return { refs, make }
}

/** How many of `refs` are still reachable after full collections run from a timer (a fresh stack). */
async function reachable(refs: WeakRef<object>[]) {
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise<void>((resolve) => setTimeout(() => (Bun.gc(true), resolve()), 10))
    if (refs.every((ref) => ref.deref() === undefined)) break
  }
  return refs.filter((ref) => ref.deref() !== undefined).length
}

class Refused extends Error {}

describe("a kept failure does not keep the arguments of the Effect.fn calls it failed in", () => {
  test("an Exit kept after the call", async () => {
    const { refs, make } = inputs()
    const step = Effect.fn("Test.step")(function* (_input: { messages: unknown[] }) {
      return yield* Effect.fail(new Refused("refused"))
    })
    const kept: Exit.Exit<never, Refused>[] = []
    for (let i = 0; i < INPUTS; i++) kept.push(await Effect.runPromiseExit(Effect.suspend(() => step(make()))))

    expect(kept.every(Exit.isFailure)).toBe(true)
    expect(await reachable(refs)).toBeLessThanOrEqual(1)
  })

  // The hypothesis for the t-w2u5vf fix4 outlier: a process-wide cache keeps a
  // typed failure until the next call after its backoff. Its load runs on the
  // first caller's fiber, so a load that failed inside a turn kept that turn's
  // input for as long as nobody called the cache again (a closed chat: forever).
  test("a typed failure a cachedInvalidateForever load kept from inside a turn", async () => {
    const { refs, make } = inputs()
    const caches: Effect.Effect<never, Refused>[] = []
    for (let i = 0; i < INPUTS; i++) {
      const [get] = await Effect.runPromise(cachedInvalidateForever(Effect.fail(new Refused("load failed"))))
      caches.push(get)
      const turn = Effect.fn("Test.turn")(function* (_input: { messages: unknown[] }) {
        return yield* get
      })
      expect(Exit.isFailure(await Effect.runPromiseExit(Effect.suspend(() => turn(make()))))).toBe(true)
    }

    expect(caches).toHaveLength(INPUTS)
    expect(await reachable(refs)).toBeLessThanOrEqual(1)
  })
})
