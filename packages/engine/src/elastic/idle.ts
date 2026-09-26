export * as ElasticIdle from "./idle"

import { FlockService } from "@/flock/service"
import { SessionCacheWarm } from "@/session/cache-warm"
import { parentsWithResults } from "@/session/task-result"
import { ElasticActivity } from "./activity"
import { ElasticOs } from "./os"
import { ElasticState, type ElasticClass } from "./state"

/**
 * THE THREE ELASTIC ANSWERS (t-w2qlop): apply a class, trim, and "is it safe to
 * stop this engine now". The wire contract is `acp/elastic.ts`; this is the
 * engine side, and `report()` is THE single answer to "safe to stop" - the D3
 * stop lane builds on it, so every reason that makes a stop lose work is here.
 */

/** Why an engine is not parkable. The order is the order they are reported in. */
export const REASONS = [
  "turn-running",
  "subagent-running",
  "background-job",
  "permission-pending",
  "question-pending",
  "task-result-pending",
  "flock-lease",
  "nest-lease",
  "collab-run",
  "warm-pending",
] as const

export type Reason = (typeof REASONS)[number]

export interface IdleReport {
  /** True when no reason holds: stopping the process loses no live work. */
  readonly parkable: boolean
  readonly reasons: Reason[]
  /** Epoch ms of the last real provider request this engine sent. */
  readonly lastRequestAt?: number
  /** Epoch ms the earliest armed cache warm fires. */
  readonly warmDueAt?: number
  /** origami_change (t-w2txb2): epoch ms after which no provider cache this
   *  process wrote or warmed can still be alive (SessionCacheWarm.cacheLife). The
   *  extension parks an engine only after it: a stop before could throw a paid
   *  cache away if a restored request were not byte-identical. */
  readonly cacheColdAt?: number
  /** Some session here used a provider that publishes no cache window: no time
   *  makes its stop cache-neutral, so the extension parks it only after its own
   *  long fixed delay (the byte identity of a restore is the guard there). */
  readonly cacheUntimed?: true
}

/** What keeps the process from being stopped, read from the live state. */
export function report(): IdleReport {
  const subagents = ElasticActivity.read("subagent-running")
  // A sub-agent's session id IS its job id (tool/task.ts), so a busy session that
  // is a running sub-agent is reported once, as the sub-agent.
  const turns = [...ElasticActivity.read("session-busy")].filter((id) => !subagents.has(id))
  const held: Record<Reason, boolean> = {
    "turn-running": turns.length > 0,
    "subagent-running": subagents.size > 0,
    "background-job": ElasticActivity.read("background-job").size > 0,
    "permission-pending": ElasticActivity.read("permission-pending").size > 0,
    "question-pending": ElasticActivity.read("question-pending").size > 0,
    "task-result-pending": guard(() => parentsWithResults().length > 0),
    "flock-lease": guard(() => FlockService.kind() === "relay"),
    "nest-lease": ElasticActivity.read("nest-lease").size > 0,
    "collab-run": ElasticActivity.read("collab-run").size > 0,
    "warm-pending": guard(() => SessionCacheWarm.pendingSessions().length > 0),
  }
  const reasons = REASONS.filter((reason) => held[reason])
  const lastRequestAt = SessionCacheWarm.lastRequestAt()
  const warmDueAt = SessionCacheWarm.nextDueAt()
  const life = SessionCacheWarm.cacheLife()
  return {
    parkable: reasons.length === 0,
    reasons,
    ...(lastRequestAt === undefined ? {} : { lastRequestAt }),
    ...(warmDueAt === undefined ? {} : { warmDueAt }),
    ...(life.coldAt === undefined ? {} : { cacheColdAt: life.coldAt }),
    ...(life.untimed ? { cacheUntimed: true as const } : {}),
  }
}

/** A trim this close to a cache warm is undone by the warm: it pulls the whole
 *  window back in to rebuild the request. */
export const WARM_GUARD_MS = 30_000

/** A trim this soon after a turn is undone: the turn's deferred GC touches the
 *  heap again (measured: 2 of 6 trims 30 s after a turn grew back about 290 MB in
 *  20 s; one at 2.5 min grew back 59 MB). The extension's own delay should be
 *  longer (5 min is the measured safe start); this is the floor. */
export const TURN_GUARD_MS = 120_000

export type TrimRefusal = "turn-running" | "subagent-running" | "turn-ended-recently" | "warm-due"

export interface TrimResult {
  readonly trimmed: boolean
  readonly reason?: TrimRefusal | string
  readonly workingSetBefore?: number
  readonly workingSetAfter?: number
  readonly childrenTrimmed?: number
}

/** Push this process's working set out, and its children's, unless work would
 *  pull it straight back. */
export function trim(now: number = Date.now()): TrimResult {
  const refused = trimRefusal(now)
  if (refused) return { trimmed: false, reason: refused }
  try {
    return ElasticOs.get().trim()
  } catch (error) {
    return { trimmed: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

function trimRefusal(now: number): TrimRefusal | undefined {
  const subagents = ElasticActivity.read("subagent-running")
  const turns = [...ElasticActivity.read("session-busy")].filter((id) => !subagents.has(id))
  if (turns.length > 0) return "turn-running"
  if (subagents.size > 0) return "subagent-running"
  const ended = ElasticState.lastWorkEndAt()
  if (ended !== undefined && now - ended < TURN_GUARD_MS) return "turn-ended-recently"
  const due = SessionCacheWarm.nextDueAt()
  if (due !== undefined && due - now <= WARM_GUARD_MS) return "warm-due"
  return undefined
}

export interface ClassResult extends ElasticOs.ApplyResult {
  /** The class the caller asked for, echoed. */
  readonly class: ElasticClass
  /** Present when `idle` was asked while a turn runs: the OS stays at
   *  `background` until the turn ends, then moves to `idle` by itself. */
  readonly deferred?: true
}

let applies = 0
let installed = false
let last: ElasticOs.ApplyResult | undefined

/** origami_change (t-wdybz9): how long after a class change the child processes
 *  follow. The walk is a full process snapshot (11-25 ms measured on Windows),
 *  too slow for the session status write the class listener runs in; a turn's
 *  start and end within this window cost one walk, at the last class. */
export const CHILD_WALK_DELAY_MS = 250
let childWalk: { timer: ReturnType<typeof setTimeout>; cls: ElasticClass } | undefined

function apply(effective: ElasticClass, options?: { children?: boolean }): ElasticOs.ApplyResult {
  applies++
  try {
    last = ElasticOs.get().apply(effective, options)
  } catch (error) {
    // `os.ts` never throws; this is the belt for a future OS that does. The
    // listener that calls this runs inside a session status write.
    last = { priority: "unsupported", ecoqos: false, error: error instanceof Error ? error.message : String(error) }
  }
  return last
}

function walkChildren(cls: ElasticClass): number | undefined {
  try {
    return ElasticOs.get().applyChildren?.(cls)
  } catch {
    return undefined
  }
}

/** The child walk for `cls`, later and once: a newer class replaces a pending one. */
function scheduleChildren(cls: ElasticClass): void {
  if (childWalk) {
    childWalk.cls = cls
    return
  }
  const timer = setTimeout(() => {
    const pending = childWalk
    childWalk = undefined
    if (pending) walkChildren(pending.cls)
  }, CHILD_WALK_DELAY_MS)
  timer.unref?.()
  childWalk = { timer, cls }
}

function cancelChildren(): void {
  if (childWalk) clearTimeout(childWalk.timer)
  childWalk = undefined
}

/** Follow the effective class with the OS priority: a turn that starts in an
 *  idle engine raises it, and the end of the turn lowers it again. Idempotent.
 *  The engine's own class moves at once; its children follow shortly after. */
export function install(): void {
  if (installed) return
  installed = true
  ElasticState.onChange((effective) => {
    apply(effective, { children: false })
    scheduleChildren(effective)
  })
}

/** Take a requested class from the extension and apply the effective one. The
 *  extension's call is not a status write, so the children are set here, in
 *  place, and counted in the answer. */
export function setClass(requested: ElasticClass): ClassResult {
  install()
  const before = applies
  const effective = ElasticState.request(requested)
  // `request` applies through the listener only when the effective class
  // MOVED; a repeat or a first call still has to reach the OS once.
  const own = applies === before ? apply(effective, { children: false }) : last!
  cancelChildren()
  const childrenSet = walkChildren(effective)
  const result: ElasticOs.ApplyResult = { ...own, ...(childrenSet === undefined ? {} : { childrenSet }) }
  last = result
  return { class: requested, ...result, ...(effective !== requested ? { deferred: true as const } : {}) }
}

function guard(read: () => boolean): boolean {
  try {
    return read()
  } catch {
    // A state that cannot be read is not evidence of idleness.
    return true
  }
}

/** Test seam. */
export function resetForTest(): void {
  cancelChildren()
  last = undefined
  applies = 0
}
