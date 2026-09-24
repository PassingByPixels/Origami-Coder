export * as BackgroundJob from "./background-job"

import { Cause, Clock, Context, Deferred, Effect, Exit, Layer, Scope, SynchronizedRef } from "effect"
import { Identifier } from "./id/id"
import { makeGlobalNode } from "./effect/app-node"

export type Status = "running" | "completed" | "error" | "cancelled"

/**
 * Why a job was cancelled, as the canceller knew it. Recorded on the job as
 * `metadata.cancel_reason`; absent for a cancel that named nothing.
 *
 * - `task_stop` - the model called `task_stop` on a task it launched.
 * - `parent_turn_stopped` - the parent's TURN was stopped (the user pressed
 *   stop, or the client sent `session/cancel`) and the cascade took the child
 *   with it. The parent decided nothing.
 * - `ancestor_expired` - an ancestor job hit its max-duration ceiling, and this
 *   job is in the subtree the watchdog cleared.
 * - `session_removed` - the owning session was deleted.
 * - `user_stop` - the USER pressed Stop on that one sub-agent row (t-q910fo).
 *   A sibling is untouched and the parent turn runs on; it is not the parent's
 *   decision, so it must not read as one.
 */
export type CancelReason = "task_stop" | "parent_turn_stopped" | "ancestor_expired" | "session_removed" | "user_stop"

/** Where {@link CancelReason} is recorded on a cancelled job. */
export const CANCEL_REASON_KEY = "cancel_reason"

export type Info = {
  id: string
  type: string
  title?: string
  status: Status
  started_at: number
  completed_at?: number
  output?: string
  error?: string
  /**
   * t-41dz9f. The PROCESS exit code, when the job ran one and it reported.
   *
   * This is what separates the three ways a job can end badly, which used to
   * be one indistinguishable `error`:
   *   - `exit` set and non-zero: the command ran and failed. `error` carries
   *     the sentence, `output` still carries its tail.
   *   - `metadata.expired`: the max-duration watchdog stopped it.
   *   - neither, with `error` set: a DEFECT inside the job's own effect.
   * Absent for a job that has no process behind it (a sub-agent task).
   */
  exit?: number
  metadata?: Record<string, unknown>
}

type Active = {
  info: Info
  done: Deferred.Deferred<Info>
  scope: Scope.Closeable
  token: object
  pending: number
  next: number
  output?: { sequence: number; text: string }
  tail: Deferred.Deferred<void>
  promoted: Deferred.Deferred<Info>
  onPromote?: Effect.Effect<void>
  /**
   * Absolute time the ceiling fires, or absent when this job has no ceiling.
   * t-d935qk made it a moving deadline rather than one fixed timeout so that
   * `extend` and credited blocked time can push it out; the watchdog re-reads
   * it every pass and is the only thing that acts on it.
   */
  deadline?: number
  /** Total ms this job has spent blocked on something outside its control, as
   *  its owner reports it. See {@link StartInput.blockedMs}. */
  blockedMs?: Effect.Effect<number>
}

type State = {
  jobs: SynchronizedRef.SynchronizedRef<Map<string, Active>>
  scope: Scope.Scope
}

type FinishResult = {
  info?: Info
  done?: Deferred.Deferred<Info>
  scope?: Scope.Closeable
}

type PromoteResult = {
  info?: Info
  promoted?: Deferred.Deferred<Info>
  onPromote?: Effect.Effect<void>
}

type StartResult = { info: Info } | { info: Info; scope: Scope.Closeable; token: object }

type ExtendResult =
  | { extended: false }
  | {
      extended: true
      previous: Deferred.Deferred<void>
      scope: Scope.Closeable
      tail: Deferred.Deferred<void>
      token: object
      sequence: number
    }

/**
 * Wall-clock ceiling on ONE job that names no ceiling of its own. Nothing else
 * bounded a background job: the registry started work, kept a handle to it, and
 * then waited forever - a job whose process wedged stayed `running` for the
 * life of the instance, counted as outstanding by every caller that asks, and
 * could only be ended by a user who happened to notice.
 *
 * Thirty minutes is sized for a build or a test run. It was NOT long enough for
 * a sub-agent (t-d935qk: a review agent was cut off mid-investigation, and the
 * resume after the cut burned the cache), so tool/task.ts passes four hours of
 * its own. Anything else that ends up on this default should ask the same
 * question rather than inherit an answer sized for someone else's work.
 */
export const DEFAULT_MAX_DURATION_MS = 30 * 60 * 1_000

/**
 * A span of milliseconds in whole hours and minutes, for a sentence a human
 * reads. Smaller units only below the next one up, where "0 m" would be worse
 * than useless - and a sub-second span stays honest rather than rounding up to
 * "1 s", because the only things that set one are tests and they must read
 * what they set.
 *
 * It lives here rather than in the one caller (engine tool/task.ts, which
 * renders the same numbers for the model) so the registry's own expiry
 * sentence and the parent's stop line cannot drift apart.
 */
export function formatDuration(ms: number) {
  if (!Number.isFinite(ms) || ms < 0) return "an unknown time"
  if (ms < 1_000) return `${Math.round(ms)} ms`
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return `${Math.round(ms / 1_000)} s`
  if (minutes < 60) return `${minutes} m`
  const rest = minutes % 60
  return rest === 0 ? `${Math.floor(minutes / 60)} h` : `${Math.floor(minutes / 60)} h ${rest} m`
}

/**
 * What a job's `run` effect may resolve to.
 *
 * A bare string is the original contract and still means "finished, no
 * process code to report" - that is what a sub-agent task returns. A job with
 * a real process behind it returns the tail AND its code, because succeeding
 * at running a command that failed is not the same as succeeding
 * (t-41dz9f: a background `npm test` that exited 1 was stored as `completed`).
 */
export type Outcome = { readonly text: string; readonly exit?: number }

/** Normalises both spellings of a job result to the richer one. */
export function outcome(value: string | Outcome): Outcome {
  return typeof value === "string" ? { text: value } : value
}

export type StartInput = {
  id?: string
  type: string
  title?: string
  metadata?: Record<string, unknown>
  onPromote?: Effect.Effect<void>
  /**
   * Override the max-duration watchdog for this job. A non-finite or
   * non-positive value disables it - only for work whose length is genuinely
   * unbounded AND which something else can stop.
   */
  maxDurationMs?: number
  /**
   * t-d935qk. Total ms this job has so far spent blocked on something it does
   * not control - for a sub-agent, an unanswered permission ask. The watchdog
   * reads it only when the deadline has already passed, and pushes the deadline
   * out by every millisecond it has not yet credited, so waiting on a human
   * never spends the ceiling. Omit it and the ceiling is plain wall clock.
   *
   * A probe that DIES is treated as reporting nothing new: a broken probe must
   * not be able to keep a runaway job alive forever.
   */
  blockedMs?: Effect.Effect<number>
  run: Effect.Effect<string | Outcome, unknown>
}

export type ExtendInput = {
  id: string
  /**
   * Move this job's ceiling to `maxDurationMs` from now. Only an ALREADY armed
   * job moves: an extension cannot arm a ceiling the job was started without.
   * Absent leaves the deadline exactly where it was, which is what the shell
   * path wants - an unasked-for chain of extensions is the runaway shape the
   * ceiling exists to bound. A sub-agent RESUME is the opposite case: the
   * parent deliberately gave the child new work, so tool/task.ts passes it.
   */
  maxDurationMs?: number
  run: Effect.Effect<string | Outcome, unknown>
}

export type WaitInput = {
  id: string
  timeout?: number
}

export type WaitResult = {
  info?: Info
  timedOut: boolean
}

export interface Interface {
  readonly list: () => Effect.Effect<Info[]>
  readonly get: (id: string) => Effect.Effect<Info | undefined>
  readonly start: (input: StartInput) => Effect.Effect<Info>
  readonly extend: (input: ExtendInput) => Effect.Effect<boolean>
  readonly wait: (input: WaitInput) => Effect.Effect<WaitResult>
  readonly waitForPromotion: (id: string) => Effect.Effect<Info>
  readonly promote: (id: string) => Effect.Effect<Info | undefined>
  /**
   * Stop one job. `reason` is recorded on the job as `metadata.cancel_reason`
   * (see {@link CancelReason}) so a caller rendering the stop for a human can
   * say WHO stopped it: every cancel used to arrive as the bare status
   * `cancelled`, and tool/task.ts read all of them as "stopped by the parent" -
   * including the cascade from a user pressing stop on the parent's turn, which
   * is the one case where the parent decided nothing.
   */
  readonly cancel: (id: string, reason?: CancelReason) => Effect.Effect<Info | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@origami/BackgroundJob") {}

function snapshot(job: Active): Info {
  return {
    ...job.info,
    ...(job.info.metadata ? { metadata: { ...job.info.metadata } } : {}),
  }
}

function errorText(error: unknown) {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Cancel every job UNDER one root, transitively.
 *
 * The tree is read off the jobs themselves: a job belongs to the root when it
 * IS the root, when its `metadata.sessionId` is a session already being
 * cancelled, or when its `metadata.parentSessionId` is. A sub-agent job is
 * keyed by the child's own session id, so a grandchild names the child that
 * spawned it and one pass of this walk reaches every generation.
 *
 * `includeRoot: false` cancels only what is UNDER the root - what the expiry
 * watchdog wants, since it has already settled the root itself.
 *
 * ONE walk, two callers (t-dcl8fe). The engine's session run-state has always
 * used it to stop a turn's background work; the max-duration watchdog used to
 * stop only the job that expired, so a sub-agent stopped at its ceiling left
 * its own children running with nobody left to report to.
 */
export const cancelTree = (
  registry: Pick<Interface, "list" | "cancel">,
  rootID: string,
  options?: { readonly spareDetached?: boolean; readonly includeRoot?: boolean; readonly reason?: CancelReason },
) =>
  Effect.gen(function* () {
    const spareDetached = options?.spareDetached ?? false
    const includeRoot = options?.includeRoot ?? true
    const jobs = yield* registry.list()
    const pending = new Set<string>([rootID])
    const cancelled = new Set<string>()
    const matches = (job: Info) => {
      if (job.status !== "running") return false
      if (cancelled.has(job.id)) return false
      // The expiry caller has already settled the root and only wants what is
      // UNDER it. Skipping it by id also protects a LATER job that reused the
      // dead one's id: it is a different job, and the walk must not reach it.
      if (!includeRoot && job.id === rootID) return false
      // A parent turn-stop (spareDetached) must leave detached background work
      // running - it outlives the turn and notifies on completion. The direct
      // cancel target is still killable via its own id, so removal / a direct
      // abort still work.
      //
      // origami_change (t-41dz9f): `&& job.metadata?.sessionId !== rootID`
      // used to end this test. It excluded exactly one kind of job from the
      // spare - a detached background SHELL, the only kind that stamps
      // `metadata.sessionId` (tool/shell.ts) - which was a metadata-key
      // convention, not a decision. `task_stop` remains the way to end one on
      // purpose, and the launch message names it.
      if (spareDetached && job.metadata?.["background"] === true && job.id !== rootID) return false
      if (pending.has(job.id)) return true
      if (typeof job.metadata?.["sessionId"] === "string" && pending.has(job.metadata["sessionId"])) return true
      return typeof job.metadata?.["parentSessionId"] === "string" && pending.has(job.metadata["parentSessionId"])
    }
    let batch = jobs.filter(matches)
    while (batch.length > 0) {
      yield* Effect.forEach(
        batch,
        (job) =>
          registry.cancel(job.id, options?.reason).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                cancelled.add(job.id)
                pending.add(job.id)
                if (typeof job.metadata?.["sessionId"] === "string") pending.add(job.metadata["sessionId"])
              }),
            ),
          ),
        { concurrency: "unbounded", discard: true },
      )
      batch = jobs.filter(matches)
    }
  })

/**
 * Makes one scoped, process-local registry. Entries are intentionally not
 * durable: process restart or owner-scope closure loses status and interrupts
 * live work. Persisted observation, restart recovery, and remote workers need a
 * separate durable ownership slice rather than pretending this registry has
 * those semantics.
 */
export const make = Effect.gen(function* () {
  const state: State = {
    jobs: yield* SynchronizedRef.make(new Map()),
    scope: yield* Scope.Scope,
  }

  const settle = Effect.fn("BackgroundJob.settle")(function* (
    id: string,
    token: object,
    sequence: number,
    exit: Exit.Exit<string | Outcome, unknown>,
  ) {
    const completed_at = yield* Clock.currentTimeMillis
    const result = yield* SynchronizedRef.modify(state.jobs, (jobs): readonly [FinishResult, Map<string, Active>] => {
      const job = jobs.get(id)
      if (!job) return [{}, jobs]
      if (job.token !== token) return [{}, jobs]
      if (job.info.status !== "running") return [{ info: snapshot(job) }, jobs]
      const pending = job.pending - 1
      const settled = Exit.isSuccess(exit) ? outcome(exit.value) : undefined
      const output =
        settled && (!job.output || sequence > job.output.sequence) ? { sequence, text: settled.text } : job.output
      if (Exit.isSuccess(exit) && pending > 0) {
        return [{}, new Map(jobs).set(id, { ...job, pending, output })]
      }
      // t-41dz9f. A command that RAN and returned non-zero is a failure, and
      // used to be filed as `completed` because the effect wrapping it had
      // succeeded at running it. The three bad endings stay apart: a non-zero
      // exit sets `exit` and keeps its output tail, the watchdog sets
      // `metadata.expired` (below), and a defect sets neither and carries only
      // the squashed cause.
      const failedCode = settled?.exit !== undefined && settled.exit !== 0 ? settled.exit : undefined
      const status: Exclude<Status, "running"> = Exit.isSuccess(exit)
        ? failedCode === undefined
          ? "completed"
          : "error"
        : Cause.hasInterruptsOnly(exit.cause)
          ? "cancelled"
          : "error"
      const next = {
        ...job,
        onPromote: undefined,
        pending: 0,
        output,
        info: {
          ...job.info,
          status,
          completed_at,
          ...(output ? { output: output.text } : {}),
          ...(settled?.exit === undefined ? {} : { exit: settled.exit }),
          ...(failedCode === undefined ? {} : { error: `Command exited with code ${failedCode}.` }),
          ...(Exit.isFailure(exit) ? { error: errorText(Cause.squash(exit.cause)) } : {}),
        },
      }
      return [{ info: snapshot(next), done: job.done, scope: job.scope }, new Map(jobs).set(id, next)]
    })
    if (result.info && result.done) yield* Deferred.succeed(result.done, result.info).pipe(Effect.ignore)
    if (result.scope) {
      yield* Scope.close(result.scope, Exit.void).pipe(Effect.forkIn(state.scope, { startImmediately: true }))
    }
    return result.info
  })

  const fork = Effect.fn("BackgroundJob.fork")(function* (
    scope: Scope.Scope,
    id: string,
    token: object,
    sequence: number,
    run: Effect.Effect<string | Outcome, unknown>,
  ) {
    return yield* run.pipe(
      Effect.matchCauseEffect({
        onSuccess: (output) => settle(id, token, sequence, Exit.succeed(output)),
        onFailure: (cause) => settle(id, token, sequence, Exit.failCause(cause)),
      }),
      Effect.asVoid,
      Effect.forkIn(scope, { startImmediately: true }),
    )
  })

  /**
   * Ends a job that outlived its ceiling. Deliberately `error`, not
   * `cancelled`: `cancelled` is what a user or a parent turn did on purpose,
   * and a runaway reported as one reads like an intended stop. The `expired`
   * metadata flag is the machine-readable half of the same statement.
   */
  const expire = Effect.fn("BackgroundJob.expire")(function* (id: string, token: object, ms: number) {
    const completed_at = yield* Clock.currentTimeMillis
    const result = yield* SynchronizedRef.modify(state.jobs, (jobs): readonly [FinishResult, Map<string, Active>] => {
      const job = jobs.get(id)
      if (!job) return [{}, jobs]
      // A finished job whose id was reused by a later `start` has a new token;
      // this watchdog belongs to the old one and must not touch the new job.
      if (job.token !== token) return [{}, jobs]
      if (job.info.status !== "running") return [{ info: snapshot(job) }, jobs]
      // The ceiling as it stands NOW, which an `extend` may have moved since
      // this watchdog was armed (t-d935qk). `ms` is the one it started with.
      const limit = typeof job.info.metadata?.["max_duration_ms"] === "number" ? job.info.metadata["max_duration_ms"] : ms
      const elapsed = completed_at - job.info.started_at
      const next = {
        ...job,
        onPromote: undefined,
        pending: 0,
        info: {
          ...job.info,
          status: "error" as const,
          completed_at,
          // t-dcl8fe. Built from the SAME two numbers the metadata carries, in
          // hours and minutes. It used to read "...maximum duration of
          // 14400000 ms", which is the figure nobody can hold in their head,
          // on the one card a user sees when a job they were waiting on dies.
          error: `background task ran past its ${formatDuration(limit)} limit and was stopped after ${formatDuration(elapsed)}`,
          // t-d935qk. The numbers, not just the flag: a caller rendering this
          // for a human needs how long the job actually ran (the ceiling that
          // fired is already on the job as `max_duration_ms`, from `start`),
          // and parsing them back out of the sentence above is exactly the
          // string-matching this is here to avoid. `elapsed_ms` is wall clock
          // and so INCLUDES any credited blocked time.
          metadata: {
            ...job.info.metadata,
            expired: true,
            elapsed_ms: elapsed,
          },
        },
      }
      return [{ info: snapshot(next), done: job.done, scope: job.scope }, new Map(jobs).set(id, next)]
    })
    if (result.info && result.done) yield* Deferred.succeed(result.done, result.info).pipe(Effect.ignore)
    if (result.scope) yield* Scope.close(result.scope, Exit.void)
    return result.info
  })

  /**
   * Arms the ceiling for one job. Races the job's own settlement, so a job that
   * finishes normally takes the watchdog fiber down with it.
   *
   * t-d935qk turned the single `timeout` into a loop around a DEADLINE stored
   * on the job, because two things move that deadline and neither could be
   * expressed as a fixed duration:
   *
   *   - Time the job spent blocked on something outside its control is not its
   *     time. A sub-agent parked on a permission ask nobody has answered was
   *     being counted as if it were working, so the one job that must not be
   *     stopped - the one waiting on the user - was the one most likely to be.
   *     The blocked total is read ONLY once the deadline has passed (so the
   *     common case still costs one sleep), and anything not yet credited is
   *     added to the deadline.
   *   - `extend` re-arms when, and only when, its caller passes a ceiling. A
   *     chain of extensions nobody asked for is still bounded; see ExtendInput.
   *
   * Reading the job fresh each pass is also what keeps a watchdog off a LATER
   * job that reused the id: the token check lives here as well as in `expire`.
   */
  const watchdog = (id: string, token: object, done: Deferred.Deferred<Info>, ms: number) =>
    Effect.gen(function* () {
      let credited = 0
      while (true) {
        const job = (yield* SynchronizedRef.get(state.jobs)).get(id)
        if (!job || job.token !== token || job.info.status !== "running" || job.deadline === undefined) return
        const remaining = job.deadline - (yield* Clock.currentTimeMillis)
        if (remaining > 0) {
          const settled = yield* Deferred.await(done).pipe(Effect.timeoutOption(remaining))
          if (settled._tag === "Some") return
          continue
        }
        const blocked = job.blockedMs
          ? yield* job.blockedMs.pipe(Effect.catchCause(() => Effect.succeed(credited)))
          : credited
        if (blocked > credited) {
          const owed = blocked - credited
          credited = blocked
          yield* SynchronizedRef.update(state.jobs, (jobs) => {
            const current = jobs.get(id)
            if (!current || current.token !== token || current.deadline === undefined) return jobs
            return new Map(jobs).set(id, { ...current, deadline: current.deadline + owed })
          })
          continue
        }
        const stopped = yield* expire(id, token, ms)
        // t-dcl8fe. The ceiling stops the WHOLE subtree, not just the job that
        // ran out of time: a sub-agent's children have no other way to hear
        // about it, and were left running against a parent that can no longer
        // read their results. `spareDetached` is deliberately off - a detached
        // grandchild of an expired job has nobody to report to either.
        if (stopped?.metadata?.["expired"] === true) {
          yield* cancelTree({ list, cancel }, id, { includeRoot: false, reason: "ancestor_expired" }).pipe(
            Effect.ignore,
          )
        }
        return
      }
    }).pipe(Effect.forkIn(state.scope, { startImmediately: true }), Effect.asVoid)

  const list: Interface["list"] = Effect.fn("BackgroundJob.list")(function* () {
    return Array.from((yield* SynchronizedRef.get(state.jobs)).values())
      .map(snapshot)
      .toSorted((a, b) => a.started_at - b.started_at)
  })

  const get: Interface["get"] = Effect.fn("BackgroundJob.get")(function* (id) {
    const job = (yield* SynchronizedRef.get(state.jobs)).get(id)
    if (!job) return
    return snapshot(job)
  })

  const start: Interface["start"] = Effect.fn("BackgroundJob.start")(function* (input) {
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const id = input.id ?? Identifier.ascending("job")
        const started_at = yield* Clock.currentTimeMillis
        const ceiling = input.maxDurationMs ?? DEFAULT_MAX_DURATION_MS
        // A non-finite or non-positive ceiling means "no watchdog", and the
        // job then carries no deadline at all - which is also what stops
        // `extend` from arming one behind the caller's back.
        const armed = Number.isFinite(ceiling) && ceiling > 0
        const done = yield* Deferred.make<Info>()
        const promoted = yield* Deferred.make<Info>()
        const tail = yield* Deferred.make<void>()
        const result = yield* SynchronizedRef.modifyEffect(
          state.jobs,
          Effect.fnUntraced(function* (jobs) {
            const existing = jobs.get(id)
            if (existing?.info.status === "running") {
              return [{ info: snapshot(existing) }, jobs] as readonly [StartResult, Map<string, Active>]
            }
            const scope = yield* Scope.fork(state.scope, "parallel")
            const token = {}
            const job = {
              info: {
                id,
                type: input.type,
                title: input.title,
                status: "running" as const,
                started_at,
                // t-d935qk. The ceiling is recorded the moment it is armed, not
                // only when it fires: it is the one number that says how long
                // this job is allowed to live, and a caller that has to wait for
                // the kill to learn it cannot show it, test it, or explain it.
                metadata: armed ? { ...input.metadata, max_duration_ms: ceiling } : input.metadata,
              },
              done,
              scope,
              token,
              pending: 1,
              next: 1,
              tail,
              promoted,
              onPromote: input.onPromote,
              ...(armed ? { deadline: started_at + ceiling, blockedMs: input.blockedMs } : {}),
            }
            return [{ info: snapshot(job), scope, token }, new Map(jobs).set(id, job)] as readonly [
              StartResult,
              Map<string, Active>,
            ]
          }),
        )
        if ("scope" in result) {
          yield* fork(
            result.scope,
            id,
            result.token,
            0,
            restore(input.run).pipe(Effect.ensuring(Deferred.succeed(tail, undefined))),
          )
          if (armed) yield* watchdog(id, result.token, done, ceiling)
        }
        return result.info
      }),
    )
  })

  const extend: Interface["extend"] = Effect.fn("BackgroundJob.extend")(function* (input) {
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const tail = yield* Deferred.make<void>()
        const now = yield* Clock.currentTimeMillis
        const result = yield* SynchronizedRef.modify(
          state.jobs,
          (jobs): readonly [ExtendResult, Map<string, Active>] => {
            const job = jobs.get(input.id)
            if (!job || job.info.status !== "running") return [{ extended: false }, jobs]
            // Only a job that already HAS a deadline gets a new one, and only
            // when this caller asked for it (t-d935qk, see ExtendInput).
            const deadline =
              job.deadline !== undefined &&
              input.maxDurationMs !== undefined &&
              Number.isFinite(input.maxDurationMs) &&
              input.maxDurationMs > 0
                ? now + input.maxDurationMs
                : job.deadline
            const moved = deadline !== job.deadline
            return [
              { extended: true, previous: job.tail, scope: job.scope, tail, token: job.token, sequence: job.next },
              new Map(jobs).set(input.id, {
                ...job,
                pending: job.pending + 1,
                next: job.next + 1,
                tail,
                ...(deadline === undefined ? {} : { deadline }),
                ...(moved
                  ? { info: { ...job.info, metadata: { ...job.info.metadata, max_duration_ms: input.maxDurationMs } } }
                  : {}),
              }),
            ]
          },
        )
        if (!result.extended) return false
        yield* fork(
          result.scope,
          input.id,
          result.token,
          result.sequence,
          Deferred.await(result.previous).pipe(
            Effect.andThen(restore(input.run)),
            Effect.ensuring(Deferred.succeed(result.tail, undefined)),
          ),
        )
        return true
      }),
    )
  })

  const wait: Interface["wait"] = Effect.fn("BackgroundJob.wait")(function* (input) {
    const job = (yield* SynchronizedRef.get(state.jobs)).get(input.id)
    if (!job) return { timedOut: false }
    if (job.info.status !== "running") return { info: snapshot(job), timedOut: false }
    if (input.timeout === undefined) return { info: yield* Deferred.await(job.done), timedOut: false }
    if (input.timeout <= 0) return { info: snapshot(job), timedOut: true }
    const info = yield* Deferred.await(job.done).pipe(Effect.timeoutOption(input.timeout))
    if (info._tag === "Some") return { info: info.value, timedOut: false }
    return { info: snapshot(job), timedOut: true }
  })

  const waitForPromotion: Interface["waitForPromotion"] = Effect.fn("BackgroundJob.waitForPromotion")(function* (id) {
    const job = (yield* SynchronizedRef.get(state.jobs)).get(id)
    if (!job || job.info.status !== "running") return yield* Effect.never
    if (job.info.metadata?.background === true) return snapshot(job)
    return yield* Deferred.await(job.promoted)
  })

  const promote: Interface["promote"] = Effect.fn("BackgroundJob.promote")(function* (id) {
    const result = yield* SynchronizedRef.modifyEffect(
      state.jobs,
      Effect.fnUntraced(function* (jobs) {
        const job = jobs.get(id)
        if (!job || job.info.status !== "running") return [{}, jobs] as readonly [PromoteResult, Map<string, Active>]
        if (job.info.metadata?.background === true)
          return [{ info: snapshot(job) }, jobs] as readonly [PromoteResult, Map<string, Active>]
        const next = {
          ...job,
          onPromote: undefined,
          info: {
            ...job.info,
            metadata: { ...job.info.metadata, background: true },
          },
        }
        return [
          { info: snapshot(next), onPromote: job.onPromote, promoted: job.promoted },
          new Map(jobs).set(id, next),
        ] as readonly [PromoteResult, Map<string, Active>]
      }),
    )
    if (result.info && result.promoted) yield* Deferred.succeed(result.promoted, result.info).pipe(Effect.ignore)
    if (result.onPromote) yield* result.onPromote.pipe(Effect.ignore)
    return result.info
  })

  const cancel: Interface["cancel"] = Effect.fn("BackgroundJob.cancel")(function* (id, reason) {
    const completed_at = yield* Clock.currentTimeMillis
    const result = yield* SynchronizedRef.modify(state.jobs, (jobs): readonly [FinishResult, Map<string, Active>] => {
      const job = jobs.get(id)
      if (!job) return [{}, jobs]
      if (job.info.status !== "running") return [{ info: snapshot(job) }, jobs]
      const next = {
        ...job,
        onPromote: undefined,
        pending: 0,
        info: {
          ...job.info,
          status: "cancelled" as const,
          completed_at,
          // Only when the canceller named one: an absent key is an honest "we
          // do not know", not a guess at the commonest case.
          ...(reason ? { metadata: { ...job.info.metadata, [CANCEL_REASON_KEY]: reason } } : {}),
        },
      }
      return [{ info: snapshot(next), done: job.done, scope: job.scope }, new Map(jobs).set(id, next)]
    })
    if (result.info && result.done) yield* Deferred.succeed(result.done, result.info).pipe(Effect.ignore)
    if (result.scope) yield* Scope.close(result.scope, Exit.void)
    return result.info
  })

  return Service.of({ list, get, start, extend, wait, waitForPromotion, promote, cancel })
})

const layer = Layer.effect(Service, make)

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
