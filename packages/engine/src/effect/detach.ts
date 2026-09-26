import { Context, Effect, References, Scope, Tracer } from "effect"

/**
 * Run `effect` without the caller's span and `Effect.fn` stack frame (t-w2u5vf).
 *
 * For work whose result outlives the caller: a folder's cached state, a logger
 * kept on a global. Anything made inside it that keeps the fiber context (an
 * `EffectBridge`, a forked fiber) would otherwise keep the caller's span, and
 * through `parent` every span above it. An ended span keeps its exit value, and
 * a stack frame keeps the arguments of its call, so one lookup made inside a
 * turn kept that turn's whole request (80 MB of messages for a big chat) after
 * the chat closed. Services, the instance and the loggers stay; only the trace
 * link to the caller goes, so spans made inside start a trace of their own.
 */
export const detach = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  effect.pipe(
    Effect.updateContext(
      (context: Context.Context<R>) =>
        Context.omit(Tracer.ParentSpan, References.CurrentStackFrame)(context) as Context.Context<R>,
    ),
  )

/**
 * `detach`, and also without the caller's `Scope` (t-x3admf).
 *
 * For a value kept in a process-wide slot that has no scope of its own (the AI
 * SDK warning logger on a global). The caller's scope closes when the caller's
 * run ends, and a closed scope keeps the exit it closed with. When the run
 * failed, that exit's cause keeps the `Effect.fn` frame of the failure (Effect
 * annotates every failure with it), and the frame keeps its call's arguments:
 * after a failed request the logger kept the whole step input (180 MB for a big
 * chat) until the next request replaced it.
 *
 * Not for an `InstanceState` lookup: the scope there is the cache entry's own,
 * provided by the cache, and the lookup needs it.
 */
export const detachRun = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  effect.pipe(
    Effect.updateContext(
      (context: Context.Context<R>) =>
        Context.omit(Tracer.ParentSpan, References.CurrentStackFrame, Scope.Scope)(context) as Context.Context<R>,
    ),
  )

export * as EffectDetach from "./detach"
