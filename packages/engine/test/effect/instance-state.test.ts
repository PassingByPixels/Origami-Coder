import { expect } from "bun:test"
import { CrossSpawnSpawner } from "@origami/core/cross-spawn-spawner"
import { LayerNode } from "@origami/core/effect/layer-node"
import { $ } from "bun"
import { Context, Deferred, Duration, Effect, Exit, Fiber, Layer, References, Tracer } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { InstanceState } from "@/effect/instance-state"
import {
  disposeAllInstancesEffect,
  provideInstanceEffect,
  reloadInstance,
  testInstanceStoreLayer,
  tmpdirScoped,
} from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(LayerNode.compile(CrossSpawnSpawner.node), testInstanceStoreLayer))

const access = <A, E>(state: InstanceState.InstanceState<A, E>, dir: string) =>
  InstanceState.get(state).pipe(provideInstanceEffect(dir))

const tmpdirGitScoped = Effect.gen(function* () {
  const dir = yield* tmpdirScoped({ git: true })
  yield* Effect.promise(() => $`git commit --allow-empty --amend -m ${`root commit ${dir}`}`.cwd(dir).quiet())
  return dir
})

it.live("InstanceState caches values per directory", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    let n = 0
    const state = yield* InstanceState.make(() => Effect.sync(() => ({ n: ++n })))

    const a = yield* access(state, dir)
    const b = yield* access(state, dir)

    expect(a).toBe(b)
    expect(n).toBe(1)
  }),
)

it.live("InstanceState isolates directories", () =>
  Effect.gen(function* () {
    const one = yield* tmpdirScoped()
    const two = yield* tmpdirScoped()
    let n = 0
    const state = yield* InstanceState.make((dir) => Effect.sync(() => ({ dir, n: ++n })))

    const a = yield* access(state, one)
    const b = yield* access(state, two)
    const c = yield* access(state, one)

    expect(a).toBe(c)
    expect(a).not.toBe(b)
    expect(n).toBe(2)
  }),
)

it.live("InstanceState invalidates on reload", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const seen: string[] = []
    let n = 0
    const state = yield* InstanceState.make(() =>
      Effect.acquireRelease(
        Effect.sync(() => ({ n: ++n })),
        (value) =>
          Effect.sync(() => {
            seen.push(String(value.n))
          }),
      ),
    )

    const a = yield* access(state, dir)
    yield* reloadInstance({ directory: dir })
    const b = yield* access(state, dir)

    expect(a).not.toBe(b)
    expect(seen).toEqual(["1"])
  }),
)

it.live("InstanceState invalidates on disposeAll", () =>
  Effect.gen(function* () {
    const one = yield* tmpdirScoped()
    const two = yield* tmpdirScoped()
    const seen: string[] = []
    const state = yield* InstanceState.make((ctx) =>
      Effect.acquireRelease(
        Effect.sync(() => ({ dir: ctx.directory })),
        (value) =>
          Effect.sync(() => {
            seen.push(value.dir)
          }),
      ),
    )

    yield* access(state, one)
    yield* access(state, two)
    yield* disposeAllInstancesEffect

    expect(seen.sort()).toEqual([one, two].sort())
  }),
)

it.live("InstanceState.get reads the current directory lazily", () =>
  Effect.gen(function* () {
    const one = yield* tmpdirScoped()
    const two = yield* tmpdirScoped()

    interface Api {
      readonly get: () => Effect.Effect<string>
    }

    class Test extends Context.Service<Test, Api>()("@test/InstanceStateLazy") {
      static readonly layer = Layer.effect(
        Test,
        Effect.gen(function* () {
          const state = yield* InstanceState.make((ctx) => Effect.sync(() => ctx.directory))
          const get = InstanceState.get(state)

          return Test.of({
            get: Effect.fn("Test.get")(function* () {
              return yield* get
            }),
          })
        }),
      )
    }

    yield* Effect.gen(function* () {
      const a = yield* Test.use((svc) => svc.get()).pipe(provideInstanceEffect(one))
      const b = yield* Test.use((svc) => svc.get()).pipe(provideInstanceEffect(two))

      expect(a).toBe(one)
      expect(b).toBe(two)
    }).pipe(Effect.provide(Test.layer))
  }),
)

it.live("InstanceState preserves directory across async boundaries", () =>
  Effect.gen(function* () {
    const one = yield* tmpdirGitScoped
    const two = yield* tmpdirGitScoped
    const three = yield* tmpdirGitScoped

    interface Api {
      readonly get: () => Effect.Effect<{ directory: string; worktree: string; project: string }>
    }

    class Test extends Context.Service<Test, Api>()("@test/InstanceStateAsync") {
      static readonly layer = Layer.effect(
        Test,
        Effect.gen(function* () {
          const state = yield* InstanceState.make((ctx) =>
            Effect.sync(() => ({
              directory: ctx.directory,
              worktree: ctx.worktree,
              project: ctx.project.id,
            })),
          )

          return Test.of({
            get: Effect.fn("Test.get")(function* () {
              yield* Effect.sleep(Duration.millis(1))
              yield* Effect.sleep(Duration.millis(1))
              for (let i = 0; i < 100; i++) {
                yield* Effect.yieldNow
              }
              for (let i = 0; i < 100; i++) {
                yield* Effect.promise(() => Promise.resolve())
              }
              yield* Effect.sleep(Duration.millis(2))
              yield* Effect.sleep(Duration.millis(1))
              return yield* InstanceState.get(state)
            }),
          })
        }),
      )
    }

    yield* Effect.gen(function* () {
      const [a, b, c] = yield* Effect.all(
        [one, two, three].map((dir) => Test.use((svc) => svc.get()).pipe(provideInstanceEffect(dir))),
        { concurrency: "unbounded" },
      )

      expect(a).toEqual({ directory: one, worktree: one, project: a.project })
      expect(b).toEqual({ directory: two, worktree: two, project: b.project })
      expect(c).toEqual({ directory: three, worktree: three, project: c.project })
      expect(a.project).not.toBe(b.project)
      expect(a.project).not.toBe(c.project)
      expect(b.project).not.toBe(c.project)
    }).pipe(Effect.provide(Test.layer))
  }),
)

it.live("InstanceState survives high-contention concurrent access", () =>
  Effect.gen(function* () {
    const dirs = yield* Effect.all(
      Array.from({ length: 20 }, () => tmpdirScoped()),
      { concurrency: "unbounded" },
    )

    interface Api {
      readonly get: () => Effect.Effect<string>
    }

    class Test extends Context.Service<Test, Api>()("@test/HighContention") {
      static readonly layer = Layer.effect(
        Test,
        Effect.gen(function* () {
          const state = yield* InstanceState.make((ctx) => Effect.sync(() => ctx.directory))

          return Test.of({
            get: Effect.fn("Test.get")(function* () {
              for (let i = 0; i < 10; i++) {
                yield* Effect.sleep(Duration.millis(Math.random() * 3))
                yield* Effect.yieldNow
                yield* Effect.promise(() => Promise.resolve())
              }
              return yield* InstanceState.get(state)
            }),
          })
        }),
      )
    }

    yield* Effect.gen(function* () {
      const results = yield* Effect.all(
        dirs.map((dir) => Test.use((svc) => svc.get()).pipe(provideInstanceEffect(dir))),
        { concurrency: "unbounded" },
      )

      expect(results).toEqual(dirs)
    }).pipe(Effect.provide(Test.layer))
  }),
)

it.live("InstanceState correct after interleaved init and dispose", () =>
  Effect.gen(function* () {
    const one = yield* tmpdirScoped()
    const two = yield* tmpdirScoped()

    interface Api {
      readonly get: () => Effect.Effect<string>
    }

    class Test extends Context.Service<Test, Api>()("@test/InterleavedDispose") {
      static readonly layer = Layer.effect(
        Test,
        Effect.gen(function* () {
          const state = yield* InstanceState.make((ctx) =>
            Effect.gen(function* () {
              yield* Effect.sleep(Duration.millis(5))
              return ctx.directory
            }),
          )

          return Test.of({
            get: Effect.fn("Test.get")(function* () {
              return yield* InstanceState.get(state)
            }),
          })
        }),
      )
    }

    yield* Effect.gen(function* () {
      const a = yield* Test.use((svc) => svc.get()).pipe(provideInstanceEffect(one))
      expect(a).toBe(one)

      const [, b] = yield* Effect.all(
        [reloadInstance({ directory: one }), Test.use((svc) => svc.get()).pipe(provideInstanceEffect(two))],
        { concurrency: "unbounded" },
      )
      expect(b).toBe(two)

      const c = yield* Test.use((svc) => svc.get()).pipe(provideInstanceEffect(one))
      expect(c).toBe(one)
    }).pipe(Effect.provide(Test.layer))
  }),
)

it.live("InstanceState mutation in one directory does not leak to another", () =>
  Effect.gen(function* () {
    const one = yield* tmpdirScoped()
    const two = yield* tmpdirScoped()
    const state = yield* InstanceState.make(() => Effect.sync(() => ({ count: 0 })))

    const s1 = yield* access(state, one)
    s1.count = 42

    const s2 = yield* access(state, two)
    expect(s2.count).toBe(0)

    const s1again = yield* access(state, one)
    expect(s1again.count).toBe(42)
    expect(s1again).toBe(s1)
  }),
)

it.live("InstanceState dedupes concurrent lookups", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    let n = 0
    const state = yield* InstanceState.make(() =>
      Effect.gen(function* () {
        n += 1
        yield* Effect.sleep(Duration.millis(10))
        return { n }
      }),
    )

    const [a, b] = yield* Effect.all([access(state, dir), access(state, dir)], { concurrency: "unbounded" })
    expect(a).toBe(b)
    expect(n).toBe(1)
  }),
)

// t-tc1tnk (scout B#5). The ScopedCache kept whatever exit the first lookup
// produced, with no TTL. Stop pressed while the first turn in a folder was
// still starting MCP servers or loading providers left that service holding an
// INTERRUPT for the folder until the instance was disposed.
it.live("InstanceState retries a first lookup that was interrupted", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    let n = 0
    const entered = yield* Deferred.make<void>()
    const state = yield* InstanceState.make(() =>
      Effect.gen(function* () {
        n += 1
        yield* Deferred.succeed(entered, undefined)
        if (n === 1) return yield* Effect.never
        return { n }
      }),
    )

    const first = yield* access(state, dir).pipe(Effect.forkChild)
    yield* Deferred.await(entered)
    yield* Fiber.interrupt(first)

    const second = yield* access(state, dir).pipe(Effect.timeout("2 seconds"), Effect.exit)
    expect(Exit.isSuccess(second) ? second.value : second).toEqual({ n: 2 })
    // A good value is still kept.
    expect(yield* access(state, dir)).toEqual({ n: 2 })
    expect(n).toBe(2)
  }),
)

it.live("InstanceState retries a first lookup that died", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    let n = 0
    const state = yield* InstanceState.make(() =>
      Effect.suspend(() => (++n === 1 ? Effect.die(new Error("boom")) : Effect.succeed({ n }))),
    )

    expect(Exit.hasDies(yield* access(state, dir).pipe(Effect.exit))).toBe(true)
    expect(yield* access(state, dir)).toEqual({ n: 2 })
    expect(n).toBe(2)
  }),
)

it.live("InstanceState: a caller waiting on an interrupted first lookup gets a fresh one", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    let n = 0
    const entered = yield* Deferred.make<void>()
    const state = yield* InstanceState.make(() =>
      Effect.gen(function* () {
        n += 1
        yield* Deferred.succeed(entered, undefined)
        if (n === 1) return yield* Effect.never
        return { n }
      }),
    )

    const owner = yield* access(state, dir).pipe(Effect.forkChild)
    yield* Deferred.await(entered)
    const waiter = yield* access(state, dir).pipe(Effect.timeout("2 seconds"), Effect.exit, Effect.forkChild)
    yield* Effect.sleep("10 millis")
    yield* Fiber.interrupt(owner)

    const got = yield* Fiber.join(waiter)
    expect(Exit.isSuccess(got) ? got.value : got).toEqual({ n: 2 })
  }),
)

// t-tijhw6. A typed failure (a provider or MCP start that failed) was kept
// until the instance was disposed. It is now kept for a backoff window per
// directory (2 s, doubling per consecutive failure, at most 60 s), then the
// next get looks up again. TestClock drives the window.
it.effect("InstanceState keeps a typed failure for a doubling backoff, then looks up again", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    let n = 0
    const state = yield* InstanceState.make(() => Effect.suspend(() => Effect.fail(`start failed ${++n}`)))

    expect(yield* Effect.flip(access(state, dir))).toBe("start failed 1")
    yield* TestClock.adjust("1999 millis")
    expect(yield* Effect.flip(access(state, dir))).toBe("start failed 1")
    yield* TestClock.adjust("1 millis")
    expect(yield* Effect.flip(access(state, dir))).toBe("start failed 2")

    // Second consecutive failure: 4 s.
    yield* TestClock.adjust("3999 millis")
    expect(yield* Effect.flip(access(state, dir))).toBe("start failed 2")
    yield* TestClock.adjust("1 millis")
    expect(yield* Effect.flip(access(state, dir))).toBe("start failed 3")
    expect(n).toBe(3)
  }),
)

it.effect("InstanceState: a success after failures is kept and resets the backoff", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    let n = 0
    let fail = true
    const state = yield* InstanceState.make(() =>
      Effect.suspend(() => (++n, fail ? Effect.fail("start failed") : Effect.succeed({ n }))),
    )

    yield* Effect.flip(access(state, dir))
    yield* TestClock.adjust("2 seconds")
    yield* Effect.flip(access(state, dir))
    yield* TestClock.adjust("4 seconds")
    fail = false
    const value = yield* access(state, dir)
    expect(value).toEqual({ n: 3 })
    yield* TestClock.adjust("1 hour")
    expect(yield* access(state, dir)).toBe(value)

    // After a reload, the next failure starts again at 2 s, not 8 s.
    fail = true
    yield* reloadInstance({ directory: dir })
    yield* Effect.flip(access(state, dir))
    yield* TestClock.adjust("2 seconds")
    yield* Effect.flip(access(state, dir))
    expect(n).toBe(5)
  }),
)

it.effect("InstanceState: callers inside the backoff share the failure; one lookup after it", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    let n = 0
    // The yield keeps each lookup in flight while the other callers arrive.
    const state = yield* InstanceState.make(() =>
      Effect.suspend(() => (++n, Effect.andThen(Effect.yieldNow, Effect.fail("start failed")))),
    )

    yield* Effect.flip(access(state, dir))
    yield* Effect.all(Array.from({ length: 10 }, () => Effect.flip(access(state, dir))), { concurrency: "unbounded" })
    expect(n).toBe(1)

    yield* TestClock.adjust("2 seconds")
    yield* Effect.all(Array.from({ length: 10 }, () => Effect.flip(access(state, dir))), { concurrency: "unbounded" })
    expect(n).toBe(2)
  }),
)

it.effect("InstanceState: the failure backoff is per directory", () =>
  Effect.gen(function* () {
    const one = yield* tmpdirScoped()
    const two = yield* tmpdirScoped()
    const seen: string[] = []
    const state = yield* InstanceState.make((ctx) =>
      Effect.suspend(() => (seen.push(ctx.directory), Effect.fail("start failed"))),
    )

    // Three failures in `one` (backoff now 8 s there), one in `two` (2 s).
    yield* Effect.flip(access(state, one))
    yield* TestClock.adjust("2 seconds")
    yield* Effect.flip(access(state, one))
    yield* TestClock.adjust("4 seconds")
    yield* Effect.flip(access(state, one))
    yield* Effect.flip(access(state, two))
    yield* TestClock.adjust("2 seconds")
    yield* Effect.flip(access(state, one))
    yield* Effect.flip(access(state, two))
    expect(seen).toEqual([one, one, one, two, two])
  }),
)

it.live("InstanceState survives deferred resume from the same instance context", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped({ git: true })

    interface Api {
      readonly get: (gate: Deferred.Deferred<void>) => Effect.Effect<string>
    }

    class Test extends Context.Service<Test, Api>()("@test/DeferredResume") {
      static readonly layer = Layer.effect(
        Test,
        Effect.gen(function* () {
          const state = yield* InstanceState.make((ctx) => Effect.sync(() => ctx.directory))

          return Test.of({
            get: Effect.fn("Test.get")(function* (gate: Deferred.Deferred<void>) {
              yield* Deferred.await(gate)
              return yield* InstanceState.get(state)
            }),
          })
        }),
      )
    }

    yield* Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const fiber = yield* Test.use((svc) => svc.get(gate)).pipe(provideInstanceEffect(dir), Effect.forkScoped)

      yield* Deferred.succeed(gate, undefined).pipe(provideInstanceEffect(dir))
      const exit = yield* Fiber.await(fiber)

      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) expect(exit.value).toBe(dir)
    }).pipe(Effect.provide(Test.layer))
  }),
)

it.live("InstanceState survives deferred resume outside ALS when InstanceRef is set", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped({ git: true })

    interface Api {
      readonly get: (gate: Deferred.Deferred<void>) => Effect.Effect<string>
    }

    class Test extends Context.Service<Test, Api>()("@test/DeferredResumeOutside") {
      static readonly layer = Layer.effect(
        Test,
        Effect.gen(function* () {
          const state = yield* InstanceState.make((ctx) => Effect.sync(() => ctx.directory))

          return Test.of({
            get: Effect.fn("Test.get")(function* (gate: Deferred.Deferred<void>) {
              yield* Deferred.await(gate)
              return yield* InstanceState.get(state)
            }),
          })
        }),
      )
    }

    yield* Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const fiber = yield* Test.use((svc) => svc.get(gate)).pipe(provideInstanceEffect(dir), Effect.forkScoped)

      yield* Deferred.succeed(gate, undefined)
      const exit = yield* Fiber.await(fiber)

      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) expect(exit.value).toBe(dir)
    }).pipe(Effect.provide(Test.layer))
  }),
)

// t-w2u5vf: the heap snapshot of a closed chat's engine showed MCP.state keeping
// 80 MB of a turn's messages. The folder's state is made by whichever turn reads
// it first; a bridge made in `init` keeps the fiber context, and in it the
// turn's span (whose ended parents keep their exit values) and the Effect.fn
// stack frames (which keep the call's arguments). The state lives as long as
// the folder, so it must not keep the reader's span or frames.
it.live("InstanceState does not keep the span or call frames of the turn that read it first", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const state = yield* InstanceState.make(() => Effect.map(Effect.context<never>(), (kept) => ({ kept })))
    const step = Effect.fn("turn.step")(function* (_request: { readonly messages: readonly string[] }) {
      return yield* access(state, dir)
    })

    const value = yield* step({ messages: ["a big request"] }).pipe(Effect.withSpan("turn"))

    const spans: string[] = []
    let span = Context.getOption(value.kept, Tracer.ParentSpan)
    while (span._tag === "Some" && span.value._tag === "Span") {
      spans.push(span.value.name)
      span = span.value.parent
    }
    const frames: string[] = []
    for (let frame = Context.get(value.kept, References.CurrentStackFrame); frame; frame = frame.parent)
      frames.push(frame.name)
    expect(spans).not.toContain("turn")
    expect(spans).not.toContain("turn.step")
    expect(frames).not.toContain("turn.step")
  }),
)
