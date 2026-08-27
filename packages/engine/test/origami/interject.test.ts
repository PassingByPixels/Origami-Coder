import { describe, expect } from "bun:test"
import { LayerNode } from "@origami/core/effect/layer-node"
import { Effect, Fiber } from "effect"
import { Interject } from "@/origami/interject"
import { SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(Interject.node))

const A = SessionID.make("ses_interject_a")
const B = SessionID.make("ses_interject_b")

/** Let a forked waiter actually reach its park before we signal it. Without
 *  this a green test would only prove the signal ran, not that it released
 *  anybody - which is the entire claim. */
const settle = Effect.gen(function* () {
  yield* Effect.yieldNow
  yield* Effect.yieldNow
  yield* Effect.yieldNow
})

/** Did this waiter actually come back? Bounded, because a shell that is never
 *  released does not fail a plain `Fiber.join` - it hangs the suite, and a
 *  regression nobody can read is barely better than no test at all. */
const released = (fiber: Fiber.Fiber<void>) =>
  Effect.timeoutOrElse(Fiber.join(fiber).pipe(Effect.as(true)), {
    duration: "2 seconds",
    orElse: () => Effect.succeed(false),
  })

describe("origami.interject", () => {
  it.instance("the envelope tells the model to CONTINUE, not to treat this as a new turn", () =>
    Effect.gen(function* () {
      // A model that reads an interjection as "the user is done, start over"
      // abandons work it was halfway through - the exact failure this feature
      // exists to remove. The wording is load-bearing, so it is asserted.
      expect(Interject.ENVELOPE).toContain("while you were working")
      expect(Interject.ENVELOPE).toContain("continue your current task")
    }),
  )

  it.instance("a waiting shell is released by a signal for its own session", () =>
    Effect.gen(function* () {
      const interject = yield* Interject.Service
      const waiter = yield* Effect.forkChild(interject.wait(A))
      yield* settle
      expect(yield* interject.signal(A)).toBe(1)
      expect(yield* released(waiter)).toBe(true)
    }),
  )

  it.instance("EVERY foreground shell in the session is released, not just the first", () =>
    Effect.gen(function* () {
      // A turn can have several foreground shells in flight at once. Releasing
      // one would leave the message stuck behind the slowest of the rest.
      const interject = yield* Interject.Service
      const first = yield* Effect.forkChild(interject.wait(A))
      const second = yield* Effect.forkChild(interject.wait(A))
      const third = yield* Effect.forkChild(interject.wait(A))
      yield* settle
      expect(yield* interject.signal(A)).toBe(3)
      expect(yield* released(first)).toBe(true)
      expect(yield* released(second)).toBe(true)
      expect(yield* released(third)).toBe(true)
    }),
  )

  it.instance("a signal is scoped to its session: another session's shell keeps waiting", () =>
    Effect.gen(function* () {
      const interject = yield* Interject.Service
      const other = yield* Effect.forkChild(interject.wait(B))
      yield* settle
      // Nothing in A to release, and B's waiter is untouched - proven by it
      // still being there to release a moment later.
      expect(yield* interject.signal(A)).toBe(0)
      expect(yield* interject.signal(B)).toBe(1)
      expect(yield* released(other)).toBe(true)
    }),
  )

  it.instance("a command that ends on its own leaves nothing behind to signal", () =>
    Effect.gen(function* () {
      // The registry must not leak a deferred per shell call: every foreground
      // command in every session registers one, and almost all exit normally.
      const interject = yield* Interject.Service
      const waiter = yield* Effect.forkChild(interject.wait(A))
      yield* settle
      yield* Fiber.interrupt(waiter)
      yield* settle
      expect(yield* interject.signal(A)).toBe(0)
    }),
  )

  it.instance("signalling a session with nothing running is a harmless no-op", () =>
    Effect.gen(function* () {
      // The common case: the user interjects while the model is thinking rather
      // than shelling out. Nothing to promote, and the message simply waits for
      // the boundary that was already coming.
      const interject = yield* Interject.Service
      expect(yield* interject.signal(A)).toBe(0)
      expect(yield* interject.signal(A)).toBe(0)
    }),
  )
})
