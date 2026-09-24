import { describe, expect } from "bun:test"
import { BackgroundJob } from "@origami/core/background-job"
import { LayerNode } from "@origami/core/effect/layer-node"
import { Deferred, Effect, Exit, Scope } from "effect"
import { it } from "./lib/effect"

const jobsLayer = LayerNode.compile(BackgroundJob.node)

describe("BackgroundJob", () => {
  it.live("tracks process-local work through explicit observation", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const latch = yield* Deferred.make<void>()
      const job = yield* jobs.start({
        type: "test",
        metadata: { durable: false },
        run: Deferred.await(latch).pipe(Effect.as("done")),
      })

      expect(job).toMatchObject({ type: "test", status: "running", metadata: { durable: false } })
      expect(yield* jobs.wait({ id: job.id, timeout: 0 })).toMatchObject({
        timedOut: true,
        info: { status: "running" },
      })

      yield* Deferred.succeed(latch, undefined)
      expect(yield* jobs.wait({ id: job.id })).toMatchObject({
        timedOut: false,
        info: { status: "completed", output: "done" },
      })
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("publishes jobs before starting immediately settling work", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service

      yield* Effect.forEach(Array.from({ length: 100 }), (_, index) => {
        const id = `job_immediate_start_${index}`
        return Effect.gen(function* () {
          const job = yield* jobs.start({
            id,
            type: "test",
            run: jobs
              .get(id)
              .pipe(
                Effect.flatMap((info) =>
                  info?.status === "running"
                    ? Effect.succeed(`done-${index}`)
                    : Effect.fail("job started before publish"),
                ),
              ),
          })

          expect(yield* jobs.wait({ id: job.id })).toMatchObject({
            timedOut: false,
            info: { status: "completed", output: `done-${index}` },
          })
        })
      })
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("increments pending work before starting immediately settling extensions", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service

      yield* Effect.forEach(Array.from({ length: 100 }), (_, index) =>
        Effect.gen(function* () {
          const first = yield* Deferred.make<void>()
          const job = yield* jobs.start({
            type: "test",
            run: Deferred.await(first).pipe(Effect.as(`first-${index}`)),
          })

          expect(yield* jobs.extend({ id: job.id, run: Effect.succeed(`second-${index}`) })).toBe(true)
          expect((yield* jobs.get(job.id))?.status).toBe("running")

          yield* Deferred.succeed(first, undefined)
          expect(yield* jobs.wait({ id: job.id })).toMatchObject({
            timedOut: false,
            info: { status: "completed", output: `second-${index}` },
          })
        }),
      )
    }).pipe(Effect.provide(jobsLayer)),
  )

  // --- the max-duration watchdog ---

  it.live("cancels and FLAGS a job that outlives its ceiling", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const interrupted = yield* Deferred.make<void>()
      const job = yield* jobs.start({
        type: "test",
        maxDurationMs: 150,
        run: Effect.never.pipe(Effect.ensuring(Deferred.succeed(interrupted, undefined))),
      })
      expect(job.status).toBe("running")

      const settled = yield* jobs.wait({ id: job.id, timeout: 5_000 })
      expect(settled.timedOut).toBe(false)
      // `error`, not `cancelled`: nobody asked for this stop, and reporting it
      // as a cancellation would read as an intended one.
      expect(settled.info?.status).toBe("error")
      // t-dcl8fe. Hours and minutes, built from the two numbers below - not
      // "14400000 ms", which is the figure nobody can hold in their head.
      expect(settled.info?.error).toContain("ran past its 150 ms limit and was stopped after ")
      expect(settled.info?.metadata?.expired).toBe(true)
      // t-d935qk. The cause as NUMBERS, so a caller can say "stopped: 150 ms
      // limit reached after N" without parsing the sentence above.
      expect(settled.info?.metadata?.max_duration_ms).toBe(150)
      expect(settled.info?.metadata?.elapsed_ms as number).toBeGreaterThanOrEqual(150)
      // Flagging is not enough - the work itself has to actually stop.
      yield* Deferred.await(interrupted).pipe(Effect.timeout("3 seconds"))
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("leaves a job that finishes inside its ceiling completely alone", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const job = yield* jobs.start({
        type: "test",
        maxDurationMs: 5_000,
        run: Effect.sleep("50 millis").pipe(Effect.as("done")),
      })
      const settled = yield* jobs.wait({ id: job.id })
      expect(settled.info?.status).toBe("completed")
      expect(settled.info?.output).toBe("done")
      expect(settled.info?.error).toBeUndefined()
      expect(settled.info?.metadata?.expired).toBeUndefined()
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("a non-positive ceiling disables the watchdog", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const latch = yield* Deferred.make<void>()
      const job = yield* jobs.start({
        type: "test",
        maxDurationMs: 0,
        run: Deferred.await(latch).pipe(Effect.as("done")),
      })
      yield* Effect.sleep("250 millis")
      expect((yield* jobs.get(job.id))?.status).toBe("running")
      yield* Deferred.succeed(latch, undefined)
      expect((yield* jobs.wait({ id: job.id })).info?.status).toBe("completed")
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("an expired watchdog never touches a LATER job that reused its id", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const first = yield* jobs.start({ id: "job_reused", type: "test", maxDurationMs: 100, run: Effect.never })
      expect((yield* jobs.wait({ id: first.id, timeout: 5_000 })).info?.status).toBe("error")

      const latch = yield* Deferred.make<void>()
      const second = yield* jobs.start({
        id: "job_reused",
        type: "test",
        maxDurationMs: 5_000,
        run: Deferred.await(latch).pipe(Effect.as("second")),
      })
      yield* Effect.sleep("300 millis")
      // Well past the FIRST job's 100 ms ceiling: a watchdog that matched on id
      // alone would have killed this one by now.
      expect((yield* jobs.get(second.id))?.status).toBe("running")
      yield* Deferred.succeed(latch, undefined)
      expect((yield* jobs.wait({ id: second.id })).info?.output).toBe("second")
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("records the ceiling it armed the moment the job starts", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const latch = yield* Deferred.make<void>()
      // The only way a caller can SHOW which ceiling a job is running under -
      // asking the job, rather than waiting to be killed to find out.
      const job = yield* jobs.start({
        type: "test",
        maxDurationMs: 5_000,
        metadata: { durable: false },
        run: Deferred.await(latch).pipe(Effect.as("done")),
      })
      expect(job.metadata).toMatchObject({ durable: false, max_duration_ms: 5_000 })
      expect((yield* jobs.get(job.id))?.metadata?.max_duration_ms).toBe(5_000)
      yield* Deferred.succeed(latch, undefined)
      yield* jobs.wait({ id: job.id })
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("a job with no ceiling records none", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const latch = yield* Deferred.make<void>()
      const job = yield* jobs.start({
        type: "test",
        maxDurationMs: 0,
        run: Deferred.await(latch).pipe(Effect.as("done")),
      })
      expect(job.metadata?.max_duration_ms).toBeUndefined()
      yield* Deferred.succeed(latch, undefined)
      yield* jobs.wait({ id: job.id })
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("time spent blocked on something the job does not control never spends the ceiling", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const opened = Date.now()
      // Blocked from the first millisecond until `released` is stamped - the
      // shape of a sub-agent parked on a permission ask nobody has answered.
      let released: number | undefined
      const job = yield* jobs.start({
        type: "test",
        maxDurationMs: 200,
        blockedMs: Effect.sync(() => (released ?? Date.now()) - opened),
        run: Effect.never,
      })

      yield* Effect.sleep("700 millis")
      // Three and a half ceilings of wall clock, every millisecond of it
      // blocked. The old watchdog had one timeout and would have killed this
      // job at 200 ms, which is exactly the sub-agent the user was answering.
      expect((yield* jobs.get(job.id))?.status).toBe("running")

      released = Date.now()
      const settled = yield* jobs.wait({ id: job.id, timeout: 5_000 })
      // Unblocked, the ceiling is spent as normal and the job is stopped - the
      // credit defers the kill, it does not cancel it.
      expect(settled.timedOut).toBe(false)
      expect(settled.info?.status).toBe("error")
      expect(settled.info?.metadata?.expired).toBe(true)
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("a broken blocked probe falls back to the plain ceiling instead of living forever", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const job = yield* jobs.start({
        type: "test",
        maxDurationMs: 150,
        blockedMs: Effect.die(new Error("probe is broken")),
        run: Effect.never,
      })
      const settled = yield* jobs.wait({ id: job.id, timeout: 5_000 })
      expect(settled.timedOut).toBe(false)
      expect(settled.info?.metadata?.expired).toBe(true)
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("an extension that names a ceiling moves the deadline to it", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const first = yield* Deferred.make<void>()
      const second = yield* Deferred.make<void>()
      const job = yield* jobs.start({
        type: "test",
        maxDurationMs: 300,
        run: Deferred.await(first).pipe(Effect.as("first")),
      })

      yield* Effect.sleep("200 millis")
      expect(yield* jobs.extend({ id: job.id, maxDurationMs: 300, run: Deferred.await(second).pipe(Effect.as("second")) })).toBe(true)
      expect((yield* jobs.get(job.id))?.metadata?.max_duration_ms).toBe(300)

      yield* Effect.sleep("250 millis")
      // 450 ms in: past the ceiling the job STARTED with. A resume is the
      // caller deliberately handing the job new work, so its clock restarts.
      expect((yield* jobs.get(job.id))?.status).toBe("running")

      yield* Deferred.succeed(first, undefined)
      yield* Deferred.succeed(second, undefined)
      expect((yield* jobs.wait({ id: job.id })).info?.status).toBe("completed")
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("an extension that names no ceiling leaves the deadline where it was", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const job = yield* jobs.start({ type: "test", maxDurationMs: 250, run: Effect.never })
      yield* Effect.sleep("100 millis")
      expect(yield* jobs.extend({ id: job.id, run: Effect.never })).toBe(true)

      // An unasked-for chain of extensions is still the runaway shape the
      // ceiling exists to bound.
      const settled = yield* jobs.wait({ id: job.id, timeout: 5_000 })
      expect(settled.timedOut).toBe(false)
      expect(settled.info?.metadata?.expired).toBe(true)
      expect(settled.info?.metadata?.max_duration_ms).toBe(250)
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("an extension cannot arm a ceiling on a job that was started without one", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const latch = yield* Deferred.make<void>()
      const job = yield* jobs.start({ type: "test", maxDurationMs: 0, run: Effect.never })
      expect(yield* jobs.extend({ id: job.id, maxDurationMs: 100, run: Deferred.await(latch).pipe(Effect.as("x")) })).toBe(true)

      yield* Effect.sleep("400 millis")
      // No watchdog fiber was ever forked for this job, so a deadline written
      // here would be a number nothing reads - worse than none.
      expect((yield* jobs.get(job.id))?.status).toBe("running")
      expect((yield* jobs.get(job.id))?.metadata?.max_duration_ms).toBeUndefined()
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("interrupts live work without promising settlement after the owning process-local scope closes", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const interrupted = yield* Deferred.make<void>()
      const jobs = yield* BackgroundJob.make.pipe(Scope.provide(scope))
      const job = yield* jobs.start({
        type: "test",
        run: Effect.never.pipe(Effect.ensuring(Deferred.succeed(interrupted, undefined))),
      })

      yield* Scope.close(scope, Exit.void)

      yield* Deferred.await(interrupted).pipe(Effect.timeout("1 second"))
      // The abandoned in-memory registry is not a durable observation channel.
      expect((yield* jobs.get(job.id))?.status).toBe("running")
    }),
  )
  // --- t-dcl8fe: expiry cascades down the session tree ---

  it.live("a ceiling stop cancels the expired job's children AND grandchildren", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const childStopped = yield* Deferred.make<void>()
      const grandchildStopped = yield* Deferred.make<void>()

      // The shape a sub-agent fan-out makes: a job is keyed by the session it
      // runs, and names the session that launched it.
      const parent = yield* jobs.start({
        id: "ses_parent",
        type: "task",
        maxDurationMs: 200,
        metadata: { sessionId: "ses_parent", parentSessionId: "ses_root" },
        run: Effect.never,
      })
      yield* jobs.start({
        id: "ses_child",
        type: "task",
        metadata: { sessionId: "ses_child", parentSessionId: "ses_parent", background: true },
        run: Effect.never.pipe(Effect.ensuring(Deferred.succeed(childStopped, undefined))),
      })
      yield* jobs.start({
        id: "ses_grandchild",
        type: "task",
        metadata: { sessionId: "ses_grandchild", parentSessionId: "ses_child", background: true },
        run: Effect.never.pipe(Effect.ensuring(Deferred.succeed(grandchildStopped, undefined))),
      })

      const settled = yield* jobs.wait({ id: parent.id, timeout: 5_000 })
      expect(settled.info?.metadata?.expired).toBe(true)

      // Red before the fix: expiry stopped only the job that ran out of time,
      // and both descendants kept running against a parent that could no
      // longer read them. The WORK has to stop, not just the status.
      yield* Deferred.await(childStopped).pipe(Effect.timeout("5 seconds"))
      yield* Deferred.await(grandchildStopped).pipe(Effect.timeout("5 seconds"))
      expect((yield* jobs.get("ses_child"))?.status).toBe("cancelled")
      expect((yield* jobs.get("ses_grandchild"))?.status).toBe("cancelled")
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("a ceiling stop leaves another session's jobs alone", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const parent = yield* jobs.start({
        id: "ses_a",
        type: "task",
        maxDurationMs: 200,
        metadata: { sessionId: "ses_a", parentSessionId: "ses_root" },
        run: Effect.never,
      })
      yield* jobs.start({
        id: "ses_b",
        type: "task",
        metadata: { sessionId: "ses_b", parentSessionId: "ses_root" },
        run: Effect.never,
      })

      yield* jobs.wait({ id: parent.id, timeout: 5_000 })
      // A SIBLING is not a descendant. The walk keys off parentSessionId, so a
      // bug that cancelled by shared ancestry would take this one too.
      expect((yield* jobs.get("ses_b"))?.status).toBe("running")
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("formats the expiry sentence in hours and minutes", () => {
    // The numbers a four-hour sub-agent ceiling actually produces: the old
    // sentence read "maximum duration of 14400000 ms".
    expect(BackgroundJob.formatDuration(4 * 60 * 60 * 1_000)).toBe("4 h")
    expect(BackgroundJob.formatDuration(3 * 60 * 60 * 1_000 + 58 * 60 * 1_000)).toBe("3 h 58 m")
    expect(BackgroundJob.formatDuration(90 * 1_000)).toBe("2 m")
    expect(BackgroundJob.formatDuration(150)).toBe("150 ms")
    return Effect.void
  })
})
