import { failureBackoff, isTransientExit } from "@origami/core/effect/cached"
import { Cause, Duration, Effect, Exit, ScopedCache, Scope } from "effect"
import type { InstanceContext } from "@/project/instance-context"
import { InstanceRef, WorkspaceRef } from "./instance-ref"
import { registerDisposer } from "./instance-registry"
import { detach } from "./detach"
import { WorkspaceContext } from "@/control-plane/workspace-context"

const TypeId = "~origami/InstanceState"

export interface InstanceState<A, E = never, R = never> {
  readonly [TypeId]: typeof TypeId
  readonly cache: ScopedCache.ScopedCache<string, A, E, R>
}

export const context = Effect.gen(function* () {
  const ctx = yield* InstanceRef
  if (!ctx) return yield* Effect.die(new Error("InstanceRef not provided"))
  return ctx
})

export const workspaceID = Effect.gen(function* () {
  return (yield* WorkspaceRef) ?? WorkspaceContext.workspaceID
})

export const directory = Effect.map(context, (ctx) => ctx.directory)

export const make = <A, E = never, R = never>(
  init: (ctx: InstanceContext) => Effect.Effect<A, E, R | Scope.Scope>,
): Effect.Effect<InstanceState<A, E, Exclude<R, Scope.Scope>>, never, R | Scope.Scope> =>
  Effect.gen(function* () {
    /** Consecutive typed failures per directory, for `failureBackoff`. */
    const failures = new Map<string, number>()
    const typedFailureTtl = (exit: Exit.Exit<A, E>, key: string) => {
      if (Exit.isSuccess(exit)) {
        failures.delete(key)
        return Duration.infinity
      }
      const count = (failures.get(key) ?? 0) + 1
      failures.set(key, count)
      return failureBackoff(count)
    }

    const cache = yield* ScopedCache.makeWith<string, A, E, R>({
      capacity: Number.POSITIVE_INFINITY,
      // Detached from the caller (t-w2u5vf): the value lives as long as the
      // folder, and a bridge or fiber made in `init` would otherwise keep the
      // span and arguments of whichever turn happened to read it first.
      lookup: () =>
        detach(
          Effect.gen(function* () {
            return yield* init(yield* context)
          }),
        ),
      // An interrupted or defective lookup describes that run, not the
      // folder's state: it expires at once, so the next `get` looks up again
      // (t-tc1tnk). A typed failure (a provider or MCP start that failed) is
      // kept for a backoff that grows per consecutive failure, then looked up
      // again (t-tijhw6). A success is kept until the instance is disposed.
      // ScopedCache calls this once per finished lookup, reads expiry from
      // Effect's Clock, and shares one lookup between concurrent callers.
      timeToLive: (exit, key) => (isTransientExit(exit) ? Duration.zero : typedFailureTtl(exit, key)),
    })

    const off = registerDisposer((directory) =>
      Effect.runPromise(
        ScopedCache.invalidate(cache, directory).pipe(Effect.ensuring(Effect.sync(() => failures.delete(directory)))),
      ),
    )
    yield* Effect.addFinalizer(() => Effect.sync(off))

    return {
      [TypeId]: TypeId,
      cache,
    }
  })

export const get = <A, E, R>(self: InstanceState<A, E, R>) =>
  Effect.gen(function* () {
    const key = yield* directory
    return yield* ScopedCache.get(self.cache, key).pipe(
      // A caller that joined a lookup whose owner was interrupted gets the
      // owner's interrupt. Look up once more. This fiber's own interrupt skips
      // failure handlers. Once, not in a loop: a lookup that interrupts itself
      // must not spin. The yield is required: ScopedCache completes the
      // entry's Deferred BEFORE it stamps the expiry, in one synchronous
      // callback, so a waiter resumed from that Deferred still sees the entry.
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.andThen(Effect.yieldNow, ScopedCache.get(self.cache, key))
          : Effect.failCause(cause),
      ),
    )
  })

export const use = <A, E, R, B>(self: InstanceState<A, E, R>, select: (value: A) => B) => Effect.map(get(self), select)

export const useEffect = <A, E, R, B, E2, R2>(
  self: InstanceState<A, E, R>,
  select: (value: A) => Effect.Effect<B, E2, R2>,
) => Effect.flatMap(get(self), select)

export const has = <A, E, R>(self: InstanceState<A, E, R>) =>
  Effect.gen(function* () {
    return yield* ScopedCache.has(self.cache, yield* directory)
  })

export const invalidate = <A, E, R>(self: InstanceState<A, E, R>) =>
  Effect.gen(function* () {
    return yield* ScopedCache.invalidate(self.cache, yield* directory)
  })

export * as InstanceState from "./instance-state"
