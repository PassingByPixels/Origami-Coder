// t-xnvp72: the boot recorder behind the `boot step` / `boot timings` log lines. The first
// instance boot of an adopted warm spare took 5-8 s in the owner's UAT; these lines are
// what names the slow step in the next UAT log.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ElasticBootTrace } from "../../src/elastic/boot-trace"

const sleep = (ms: number) => Effect.promise(() => new Promise((resolve) => setTimeout(resolve, ms)))

describe("ElasticBootTrace", () => {
  test("records each span of the boot with its callers' names and its duration", async () => {
    const recorder = ElasticBootTrace.recorder()
    const inner = Effect.fn("Git.run")(function* () {
      yield* sleep(30)
    })
    const outer = Effect.fn("Project.fromDirectory")(function* () {
      yield* inner()
      yield* sleep(10)
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const base = yield* Effect.tracer
        yield* outer().pipe(Effect.withTracer(recorder.tracer(base)))
      }),
    )
    const record = recorder.finish()
    const git = record.steps.find((step) => step.path === "Project.fromDirectory > Git.run")
    expect(git?.ms).toBeGreaterThanOrEqual(25)
    expect(ElasticBootTrace.spanMs(record.steps, "Project.fromDirectory")).toBeGreaterThanOrEqual(35)
    // Start order: the caller first.
    expect(record.steps[0].path).toBe("Project.fromDirectory")
  })

  // A per-folder state made during the boot keeps this tracer in its fiber context for the
  // folder's life: recording after the boot would grow without end.
  test("records nothing after finish, and still passes every span to the real tracer", async () => {
    const recorder = ElasticBootTrace.recorder()
    let ended = 0
    const counted = Effect.gen(function* () {
      const base = yield* Effect.tracer
      return recorder.tracer({
        span: (options) => {
          const span = base.span(options)
          const end = span.end.bind(span)
          span.end = (time, exit) => {
            ended++
            end(time, exit)
          }
          return span
        },
      })
    })
    const tracer = await Effect.runPromise(counted)
    await Effect.runPromise(Effect.void.pipe(Effect.withSpan("during"), Effect.withTracer(tracer)))
    const record = recorder.finish()
    await Effect.runPromise(Effect.void.pipe(Effect.withSpan("after"), Effect.withTracer(tracer)))
    expect(record.steps.map((step) => step.path)).toEqual(["during"])
    expect(recorder.finish().steps.map((step) => step.path)).toEqual(["during"])
    expect(ended).toBe(2)
  })

  test("the lag probe tells a blocked main thread from a slow wait", async () => {
    const blocked = ElasticBootTrace.lagProbe()
    await new Promise((resolve) => setTimeout(resolve, 40))
    const until = performance.now() + 150
    while (performance.now() < until) {
      // the main thread does not run timers now
    }
    expect(blocked.stop()).toBeGreaterThanOrEqual(100)

    const waiting = ElasticBootTrace.lagProbe()
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(waiting.stop()).toBeLessThan(100)
  })

  test("only steps of 5 ms or more are logged, at most 60, the slowest kept, in start order", () => {
    const steps = Array.from({ length: 100 }, (_, i) => ({ path: `s${i}`, startMs: i, ms: i }))
    const shown = ElasticBootTrace.shown(steps)
    expect(shown).toHaveLength(ElasticBootTrace.STEP_MAX_LINES)
    expect(shown[0].path).toBe("s40")
    expect(shown.at(-1)?.path).toBe("s99")
    expect(ElasticBootTrace.shown(steps.slice(0, 10)).map((step) => step.path)).toEqual(["s5", "s6", "s7", "s8", "s9"])
  })

  // t-yc1mzc: adoption-timings.test.ts:82 asserts a `Project.fromDirectory` step line is
  // always logged after adoption, but `shown()` used to drop ANY step under STEP_MIN_MS,
  // fromDirectory included - so a fast one (no adoption penalty that run) silently vanished
  // from the log, and the assertion flaked (~1 in 4). fromDirectory is the one step this
  // whole trace exists to name (t-xnvp72): it must be logged whether it was slow or not, as
  // the comparison point for the slow runs UAT reported.
  test("Project.fromDirectory is logged even when it is fast - the one step this trace exists to name", () => {
    const steps = [
      { path: "Project.fromDirectory", startMs: 0, ms: 1 },
      { path: "Project.fromDirectory > Git.run", startMs: 0, ms: 1 },
      { path: "InstanceBootstrap", startMs: 2, ms: 20 },
    ]
    const shown = ElasticBootTrace.shown(steps)
    expect(shown.some((step) => step.path === "Project.fromDirectory")).toBe(true)
    // Still in start order alongside the ordinarily-shown slow steps.
    expect(shown.map((step) => step.path)).toEqual(["Project.fromDirectory", "InstanceBootstrap"])
  })

  test("a fast Project.fromDirectory does not steal a STEP_MAX_LINES slot from the slow steps", () => {
    const slow = Array.from({ length: ElasticBootTrace.STEP_MAX_LINES }, (_, i) => ({
      path: `s${i}`,
      startMs: i + 1,
      ms: 100 - i,
    }))
    const steps = [{ path: "Project.fromDirectory", startMs: 0, ms: 1 }, ...slow]
    const shown = ElasticBootTrace.shown(steps)
    expect(shown.some((step) => step.path === "Project.fromDirectory")).toBe(true)
    expect(shown).toHaveLength(ElasticBootTrace.STEP_MAX_LINES + 1)
  })
})
