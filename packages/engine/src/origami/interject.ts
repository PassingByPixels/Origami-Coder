import { LayerNode } from "@origami/core/effect/layer-node"
import { Context, Deferred, Effect, Layer } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { SessionID } from "@/session/schema"

/**
 * A message the user pushed INTO a running turn.
 *
 * Two halves live here because they are the same idea seen from both ends:
 *
 *  1. The ENVELOPE the model reads. An interjection is not the turn ending and
 *     not a fresh task - a model that reads it as either abandons work it was
 *     halfway through. The wording says so explicitly, and it rides as a
 *     `synthetic` text part so the user never sees the instructions written on
 *     their behalf.
 *  2. The SIGNAL a blocking foreground shell watches. A command that runs for
 *     minutes never reaches a tool boundary, so the boundary has to be brought
 *     forward: the signal completes the shell's wait, the shell takes its
 *     existing promotion path (process untouched, output still streaming), and
 *     the turn reaches the boundary where the message is waiting.
 *
 * The signal is per SESSION, not per shell, and completes EVERY waiter: a turn
 * can have several foreground shells in flight at once, and leaving any of them
 * blocking would leave the interjection undelivered for exactly as long as the
 * slowest one.
 */
export const ENVELOPE =
  "[The user sent this message while you were working. Address it, then continue your current task unless it changes your instructions.]"

interface State {
  waiting: Map<SessionID, Set<Deferred.Deferred<void>>>
}

export interface Interface {
  /**
   * Complete every foreground shell currently blocking in this session, so the
   * turn reaches a tool boundary. A session with nothing blocking is a no-op -
   * the interjection simply waits for the boundary that was already coming.
   */
  readonly signal: (sessionID: SessionID) => Effect.Effect<number>
  /**
   * Completes when `signal` is called for this session. Deregisters itself on
   * any exit, so a command that finishes normally leaves nothing behind.
   */
  readonly wait: (sessionID: SessionID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@origami/Interject") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = yield* InstanceState.make<State>(
      Effect.fn("Interject.state")(function* () {
        const state: State = { waiting: new Map<SessionID, Set<Deferred.Deferred<void>>>() }
        // An instance going away must not leave a shell blocked on a signal
        // that can no longer arrive.
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const waiters of state.waiting.values()) {
              for (const deferred of waiters) yield* Deferred.succeed(deferred, undefined)
            }
            state.waiting.clear()
          }),
        )
        return state
      }),
    )

    const signal = Effect.fn("Interject.signal")(function* (sessionID: SessionID) {
      const waiting = (yield* InstanceState.get(state)).waiting
      const waiters = waiting.get(sessionID)
      if (!waiters || waiters.size === 0) return 0
      const count = waiters.size
      for (const deferred of waiters) yield* Deferred.succeed(deferred, undefined)
      waiting.delete(sessionID)
      yield* Effect.logInfo("interject signalled", { "session.id": sessionID, waiters: count })
      return count
    })

    const wait = Effect.fn("Interject.wait")(function* (sessionID: SessionID) {
      const waiting = (yield* InstanceState.get(state)).waiting
      const deferred = yield* Deferred.make<void>()
      const waiters = waiting.get(sessionID) ?? new Set<Deferred.Deferred<void>>()
      waiters.add(deferred)
      waiting.set(sessionID, waiters)
      return yield* Effect.ensuring(
        Deferred.await(deferred),
        Effect.sync(() => {
          const current = waiting.get(sessionID)
          if (!current) return
          current.delete(deferred)
          if (current.size === 0) waiting.delete(sessionID)
        }),
      )
    })

    return { signal, wait } satisfies Interface
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [] })

export * as Interject from "./interject"
