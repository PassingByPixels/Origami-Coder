import { Cause, Clock, Deferred, Duration, Effect, Exit } from "effect"

/**
 * An exit that describes one RUN of an effect, not the value it computes: an
 * interrupt (the caller was cancelled or timed out) or a defect (a bug hit in
 * that run). A cache must never keep one. A typed failure is an answer, but
 * only for a short time: see `failureBackoff`.
 *
 * Shared by every cache in the engine that keeps an exit - this helper, and
 * the `InstanceState` ScopedCache, which expires such an entry at once.
 */
export const isTransientExit = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit) && (Cause.hasInterrupts(exit.cause) || Cause.hasDies(exit.cause))

/**
 * How long a cache keeps a typed failure after `failures` consecutive typed
 * failures: 2 s, doubled for each further failure, at most 60 s (t-tijhw6).
 * Before this, a provider or MCP start that failed once stayed failed until
 * the engine restarted. Callers inside the window get the kept failure, so a
 * failing start is not run again by every caller.
 */
export const failureBackoff = (failures: number) =>
  Duration.millis(Math.min(2_000 * 2 ** Math.max(0, failures - 1), 60_000))

/**
 * A process-wide memo of one effect, returned as `[get, invalidate]`.
 *
 * THE TRAP it replaces. `Effect.cached` / `Effect.cachedInvalidateWithTTL`
 * store whatever EXIT the first caller produced, and an INTERRUPT is an exit
 * like any other. The first caller is whichever fiber got there first - a
 * session turn, a forked subagent, a model switch under a timeout - and if it
 * is cancelled while the load is in flight, the interrupt becomes the cached
 * answer. Every later caller then dies with "All fibers interrupted without
 * error" until the process restarts (0.4.153 provider_refresh; t-tc1tnk
 * directory refresh). The primitive also hands that interrupt to every caller
 * that was WAITING on the same load, although nobody cancelled them.
 *
 * THE RULES.
 * - A success is kept until `invalidate`, and resets the failure count.
 * - A typed failure is kept for `failureBackoff(n)` after the n-th
 *   consecutive typed failure (Effect's Clock, so TestClock drives it). The
 *   first call after that loads again.
 * - An interrupt or a defect is never kept (`isTransientExit`): the next
 *   caller loads again. It does not count as a failure.
 * - A caller that joined a load whose owner was interrupted starts a new load
 *   instead of taking the owner's interrupt. A caller that is itself
 *   interrupted stops, as usual.
 * - `invalidate` drops the entry and the failure count.
 *
 * The load runs on the first caller's fiber, so a caller's timeout still stops
 * the work.
 */
export const cachedInvalidateForever = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.sync(() => {
    let current: { readonly deferred: Deferred.Deferred<A, E>; expiresAt?: number } | undefined
    let failures = 0

    const get: Effect.Effect<A, E, R> = Effect.uninterruptibleMask((restore) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) => {
        const shared = current
        if (shared && !(shared.expiresAt !== undefined && now >= shared.expiresAt))
          return restore(
            Deferred.await(shared.deferred).pipe(
              // Runs only when the OWNER was interrupted: this fiber's own
              // interrupt skips failure handlers.
              Effect.catchCause((cause) => (Cause.hasInterruptsOnly(cause) ? get : Effect.failCause(cause))),
            ),
          )
        const entry: { readonly deferred: Deferred.Deferred<A, E>; expiresAt?: number } = {
          deferred: Deferred.makeUnsafe<A, E>(),
        }
        current = entry
        return restore(self).pipe(
          Effect.onExit((exit) =>
            Effect.flatMap(Clock.currentTimeMillis, (end) =>
              Effect.sync(() => {
                if (current === entry) {
                  if (isTransientExit(exit)) current = undefined
                  else if (Exit.isSuccess(exit)) failures = 0
                  else entry.expiresAt = end + Duration.toMillis(failureBackoff(++failures))
                }
                Deferred.doneUnsafe(entry.deferred, exit)
              }),
            ),
          ),
        )
      }),
    )

    const invalidate = Effect.sync(() => {
      current = undefined
      failures = 0
    })

    return [get, invalidate] as const
  })
