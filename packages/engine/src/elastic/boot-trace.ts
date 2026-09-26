export * as ElasticBootTrace from "./boot-trace"

import type { Tracer } from "effect"

/**
 * t-xnvp72: WHERE THE FIRST INSTANCE BOOT OF AN ADOPTED SPARE SPENDS ITS TIME.
 *
 * In the owner's UAT every adopted warm spare spent 5.2-8.5 s in its first
 * `Project.fromDirectory` (median 6.5 s, 21 of 21 adoptions); the same step
 * takes 0.2-0.4 s everywhere else, and a store copy does not reproduce it
 * (newchat_start_timing.md). This module turns the spans that the boot already
 * makes (every `Effect.fn`: git runs, file reads, SQL, config and plugin
 * loads) into engine log lines, so the next UAT log names the slow step.
 *
 * A {@link Recorder} wraps the tracer in use for ONE boot. It records each span
 * that ends while the boot runs (name, its parents' names, start, duration) and
 * passes every call through to the real tracer, so OTLP export is unchanged.
 * After `finish()` it records nothing more: a cached per-folder state made
 * during the boot keeps this tracer in its fiber context for the folder's life.
 *
 * A {@link LagProbe} measures how late a 20 ms timer fires: the longest time the
 * main thread did not run at all. It tells a blocked thread from a slow await.
 *
 * Nothing here reaches a request, a store or the disk: it only measures.
 */

/** A span of the boot: `path` is its parents' names and its own, outermost first. */
export interface Step {
  readonly path: string
  readonly startMs: number
  readonly ms: number
}

export interface BootRecord {
  readonly totalMs: number
  /** Every recorded span, in start order. */
  readonly steps: readonly Step[]
  /** The longest time the main thread did not run during the boot. */
  readonly mainThreadMaxBlockMs: number
}

export interface Recorder {
  /** The tracer to run the boot under: `base` with recording. */
  readonly tracer: (base: Tracer.Tracer) => Tracer.Tracer
  /** Stop recording. Safe to call twice. */
  readonly finish: () => BootRecord
}

/** Parent names kept in a step's path: enough to place a git run inside its caller. */
const PATH_DEPTH = 4

export function recorder(now: () => number = () => performance.now()): Recorder {
  const started = now()
  const lag = lagProbe(now)
  const names = new Map<string, { name: string; parent?: string }>()
  let steps: Step[] = []
  let done: BootRecord | undefined
  const pathOf = (name: string, parent: string | undefined) => {
    const parts = [name]
    for (let id = parent; id && parts.length < PATH_DEPTH; id = names.get(id)?.parent) {
      const known = names.get(id)
      if (!known) break
      parts.unshift(known.name)
    }
    return parts.join(" > ")
  }
  return {
    tracer: (base) => ({
      span(options) {
        const span = base.span(options)
        if (done) return span
        const at = now()
        const parent = options.parent._tag === "Some" ? options.parent.value.spanId : undefined
        names.set(span.spanId, { name: options.name, parent })
        const end = span.end.bind(span)
        span.end = (endTime, exit) => {
          if (!done) steps.push({ path: pathOf(options.name, parent), startMs: at - started, ms: now() - at })
          end(endTime, exit)
        }
        return span
      },
      ...(base.context ? { context: base.context } : {}),
    }),
    finish: () => {
      if (done) return done
      done = {
        totalMs: now() - started,
        steps: steps.toSorted((a, b) => a.startMs - b.startMs),
        mainThreadMaxBlockMs: lag.stop(),
      }
      steps = []
      names.clear()
      return done
    },
  }
}

export interface LagProbe {
  /** Stop the timer. Returns the longest delay past the timer's due time, in ms. */
  readonly stop: () => number
}

/** A 20 ms timer that notes how late it fires. Unref'd: it never keeps the process alive,
 *  and it stops by itself after `maxMs` if nobody stops it (a report never logged). */
export function lagProbe(now: () => number = () => performance.now(), everyMs = 20, maxMs = 120_000): LagProbe {
  const started = now()
  let last = started
  let max = 0
  let stopped = false
  const timer = setInterval(() => {
    const at = now()
    max = Math.max(max, at - last - everyMs)
    last = at
    if (at - started > maxMs) end()
  }, everyMs)
  timer.unref?.()
  const end = () => {
    if (stopped) return
    stopped = true
    clearInterval(timer)
    // The time since the last tick counts too: a block at the very end.
    max = Math.max(max, now() - last - everyMs)
  }
  return {
    stop: () => {
      end()
      return Math.max(0, Math.round(max))
    },
  }
}

/** Steps under this many ms are left out of the log (counted in the summary),
 *  except {@link ALWAYS_SHOWN}. */
export const STEP_MIN_MS = 5
/** At most this many OTHER step lines per boot (on top of any ALWAYS_SHOWN one). */
export const STEP_MAX_LINES = 60

/** Steps logged whatever their duration. `Project.fromDirectory` is the one step this
 *  whole trace exists to name (t-xnvp72): a fast run must still log it, as the
 *  comparison point for the slow ones UAT reported - dropping it under STEP_MIN_MS
 *  is what made adoption-timings.test.ts flake (t-yc1mzc). */
const ALWAYS_SHOWN = ["Project.fromDirectory"]

function isAlwaysShown(step: Step): boolean {
  return ALWAYS_SHOWN.some((name) => step.path === name || step.path.endsWith(` > ${name}`))
}

/** The steps to log: every {@link ALWAYS_SHOWN} step, plus at least STEP_MIN_MS of the
 *  rest up to STEP_MAX_LINES (the slowest), in start order. */
export function shown(steps: readonly Step[]): readonly Step[] {
  const always = steps.filter(isAlwaysShown)
  const slow = steps.filter((step) => step.ms >= STEP_MIN_MS && !isAlwaysShown(step))
  const capped =
    slow.length <= STEP_MAX_LINES
      ? slow
      : (() => {
          const cut = slow.toSorted((a, b) => b.ms - a.ms)[STEP_MAX_LINES - 1].ms
          return slow.filter((step) => step.ms >= cut).slice(0, STEP_MAX_LINES)
        })()
  return [...always, ...capped].toSorted((a, b) => a.startMs - b.startMs)
}

/** The longest step whose own name is `name` (0 when there is none). */
export function spanMs(steps: readonly Step[], name: string): number {
  const own = steps.filter((step) => step.path === name || step.path.endsWith(` > ${name}`))
  return Math.round(Math.max(0, ...own.map((step) => step.ms)))
}
