import { describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { cachedInvalidateForever } from "@origami/core/effect/cached"
import { it } from "../lib/effect"

/**
 * The defect this exists to pin, from the field: a session turn triggered the
 * first `ModelsDev.populate`, the turn was cancelled while the catalog file was
 * still being read, and `Effect.cachedInvalidateWithTTL` stored that INTERRUPT
 * as the process-wide answer. At `Duration.infinity` nothing evicted it, so
 * every later caller — different instance, different test file, different
 * session — died with "All fibers interrupted without error", no failure and no
 * assertion to point at.
 *
 * So the second assertion is the defect, pinned. The third one is there because
 * the obvious over-correction (never memoise, or invalidate on every exit)
 * would pass the second and quietly turn a process-wide memo into a reload on
 * every call.
 */
describe("cachedInvalidateForever", () => {
  it.effect("a caller cancelled mid-load is not the answer every later caller gets", () =>
    Effect.gen(function* () {
      let loads = 0
      let block = true
      const entered = yield* Deferred.make<void>()

      const load = Effect.suspend(() =>
        Effect.gen(function* () {
          loads++
          yield* Deferred.succeed(entered, undefined)
          if (block) return yield* Effect.never
          return loads
        }),
      )

      const [get] = yield* cachedInvalidateForever(load)

      // A caller reaches the load first and is then cancelled — the hazard.
      const cancelled = yield* Effect.forkChild(get)
      yield* Deferred.await(entered)
      yield* Fiber.interrupt(cancelled)

      block = false
      expect(yield* get).toBe(2)
      expect(loads).toBe(2)

      // A good answer is still kept: this is a memo, not a reload.
      expect(yield* get).toBe(2)
      expect(loads).toBe(2)
    }),
  )

  // t-tc1tnk. A second caller that JOINED the in-flight load while the first
  // caller was cancelled got the first caller's interrupt as its own answer:
  // "All fibers interrupted" for a caller nobody cancelled.
  it.effect("a caller waiting on a load whose owner is cancelled gets a fresh load, not the interrupt", () =>
    Effect.gen(function* () {
      let loads = 0
      const entered = yield* Deferred.make<void>()
      const load = Effect.suspend(() =>
        Effect.gen(function* () {
          loads++
          yield* Deferred.succeed(entered, undefined)
          if (loads === 1) return yield* Effect.never
          return loads
        }),
      )

      const [get] = yield* cachedInvalidateForever(load)

      const owner = yield* Effect.forkChild(get)
      yield* Deferred.await(entered)
      const waiter = yield* Effect.forkChild(get)
      yield* Effect.yieldNow
      yield* Fiber.interrupt(owner)

      expect(yield* Fiber.join(waiter)).toBe(2)
      expect(loads).toBe(2)
    }),
  )

  // t-tc1tnk. A defect is a bug in one run, not an answer: keeping it made
  // every later caller in the process die the same way.
  it.effect("a load that dies is not the answer every later caller gets", () =>
    Effect.gen(function* () {
      let loads = 0
      const load = Effect.suspend(() => {
        loads++
        return loads === 1 ? Effect.die(new Error("boom")) : Effect.succeed(loads)
      })

      const [get] = yield* cachedInvalidateForever(load)

      expect(Exit.hasDies(yield* Effect.exit(get))).toBe(true)
      expect(yield* get).toBe(2)
      expect(yield* get).toBe(2)
      expect(loads).toBe(2)
    }),
  )

  // t-tijhw6. A typed failure used to be kept until restart: a provider or MCP
  // start that failed once stayed failed. It is now kept for a backoff window
  // only (2 s, doubling per consecutive failure, at most 60 s), so a caller
  // inside the window gets it without a new load, and the first caller after
  // the window loads again.
  it.effect("a typed failure is kept for a backoff window that doubles, then the next call loads again", () =>
    Effect.gen(function* () {
      let loads = 0
      const load = Effect.suspend(() => {
        loads++
        return Effect.fail(`nope ${loads}` as const)
      })

      const [get] = yield* cachedInvalidateForever(load)

      expect(yield* Effect.flip(get)).toBe("nope 1")
      yield* TestClock.adjust("1999 millis")
      expect(yield* Effect.flip(get)).toBe("nope 1")
      expect(loads).toBe(1)

      yield* TestClock.adjust("1 millis")
      expect(yield* Effect.flip(get)).toBe("nope 2")
      expect(loads).toBe(2)

      // Second consecutive failure: 4 s.
      yield* TestClock.adjust("3999 millis")
      expect(yield* Effect.flip(get)).toBe("nope 2")
      yield* TestClock.adjust("1 millis")
      expect(yield* Effect.flip(get)).toBe("nope 3")
      expect(loads).toBe(3)
    }),
  )

  it.effect("the backoff stops growing at 60 s", () =>
    Effect.gen(function* () {
      let loads = 0
      const load = Effect.suspend(() => {
        loads++
        return Effect.fail("nope" as const)
      })
      const [get] = yield* cachedInvalidateForever(load)

      // 2 + 4 + 8 + 16 + 32 s, then 60 s (not 64 s) from the sixth failure on.
      yield* Effect.flip(get)
      for (const seconds of [2, 4, 8, 16, 32]) {
        yield* TestClock.adjust(`${seconds} seconds`)
        yield* Effect.flip(get)
      }
      expect(loads).toBe(6)
      yield* TestClock.adjust("60 seconds")
      yield* Effect.flip(get)
      expect(loads).toBe(7)
      yield* TestClock.adjust("59999 millis")
      yield* Effect.flip(get)
      expect(loads).toBe(7)
      yield* TestClock.adjust("1 millis")
      yield* Effect.flip(get)
      expect(loads).toBe(8)
    }),
  )

  it.effect("a success after failures is kept, and resets the backoff", () =>
    Effect.gen(function* () {
      let loads = 0
      let fail = true
      const load = Effect.suspend(() => {
        loads++
        return fail ? Effect.fail("nope" as const) : Effect.succeed(loads)
      })
      const [get, invalidate] = yield* cachedInvalidateForever(load)

      yield* Effect.flip(get)
      yield* TestClock.adjust("2 seconds")
      yield* Effect.flip(get)
      yield* TestClock.adjust("4 seconds")
      fail = false
      expect(yield* get).toBe(3)
      // Kept with no expiry.
      yield* TestClock.adjust("1 hour")
      expect(yield* get).toBe(3)
      expect(loads).toBe(3)

      // The next failure starts again at 2 s, not 8 s.
      fail = true
      yield* invalidate
      yield* Effect.flip(get)
      yield* TestClock.adjust("2 seconds")
      yield* Effect.flip(get)
      expect(loads).toBe(5)
    }),
  )

  it.effect("callers inside the backoff window share the cached failure, and one load retries after it", () =>
    Effect.gen(function* () {
      let loads = 0
      // The yield keeps each load in flight while the other callers arrive.
      const load = Effect.suspend(() => {
        loads++
        return Effect.andThen(Effect.yieldNow, Effect.fail("nope" as const))
      })
      const [get] = yield* cachedInvalidateForever(load)

      yield* Effect.flip(get)
      const inside = yield* Effect.all(Array.from({ length: 10 }, () => Effect.flip(get)), {
        concurrency: "unbounded",
      })
      expect(inside).toEqual(Array.from({ length: 10 }, () => "nope"))
      expect(loads).toBe(1)

      yield* TestClock.adjust("2 seconds")
      yield* Effect.all(Array.from({ length: 10 }, () => Effect.flip(get)), { concurrency: "unbounded" })
      expect(loads).toBe(2)
    }),
  )

  it.effect("invalidate starts a new load, which is then kept", () =>
    Effect.gen(function* () {
      let loads = 0
      const load = Effect.sync(() => ++loads)
      const [get, invalidate] = yield* cachedInvalidateForever(load)

      expect(yield* get).toBe(1)
      yield* invalidate
      expect(yield* get).toBe(2)
      expect(yield* get).toBe(2)
    }),
  )
})
