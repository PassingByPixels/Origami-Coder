export * as ElasticState from "./state"

/**
 * THE ENGINE'S ELASTIC CLASS (t-w2qlop, epic t-w1r73y option D).
 *
 * The extension tells each engine how much it matters right now:
 *  - `active`: its chat is on screen. Also the default, so an engine nobody
 *    classifies (the CLI, an older extension) behaves exactly as before.
 *  - `background`: hidden, or a host / headless engine.
 *  - `idle`: hidden and quiet for a while.
 *
 * REQUESTED vs EFFECTIVE. The requested class is what the extension last sent.
 * While a turn or a sub-agent runs in this process, `idle` is held at
 * `background`: a hidden chat with a busy turn runs at BELOW_NORMAL, never at
 * IDLE + EcoQoS (measured, measure_cheap_checks.md: BELOW_NORMAL protects the
 * foreground under contention for about +6 % turn time; EcoQoS + IDLE cost busy
 * turns +15 %, and IDLE can starve behind a build). `active` and `background`
 * are kept as asked. Everything that acts on the class - the OS priority and the
 * timer cadences - reads the EFFECTIVE class and follows its changes.
 *
 * A leaf module on purpose: the timer owners (flock, peer broker, snapshot gc)
 * import it, and it imports nothing of theirs.
 */

export type ElasticClass = "active" | "background" | "idle"

export const CLASSES: readonly ElasticClass[] = ["active", "background", "idle"]

/** The shortest period any periodic engine timer may have while the engine
 *  rests (background or idle). An idle engine wakes at most this often. */
export const REST_MIN_MS = 20_000

export type Listener = (effective: ElasticClass) => void

let requested: ElasticClass = "active"
let busy: () => boolean = () => false
let published: ElasticClass = "active"
let wasWorking = false
let lastWorkEnd: number | undefined
const listeners = new Set<Listener>()

export function isClass(value: unknown): value is ElasticClass {
  return typeof value === "string" && (CLASSES as readonly string[]).includes(value)
}

/** What the extension last asked for. */
export function requestedClass(): ElasticClass {
  return requested
}

/** Whether a turn runs now. A busy probe that throws counts as busy - the safe
 *  direction. */
function working(): boolean {
  try {
    return busy()
  } catch {
    return true
  }
}

/** What the engine acts on: the requested class, except that `idle` is held at
 *  `background` while a turn runs. */
export function effectiveClass(): ElasticClass {
  return requested === "idle" && working() ? "background" : requested
}

/** True in `background` and `idle`: the engine's periodic timers slow down. */
export function resting(): boolean {
  return effectiveClass() !== "active"
}

/** The period a periodic timer uses now: `activeMs` while active, at least
 *  {@link REST_MIN_MS} (or `restMs` when longer) while resting. */
export function period(activeMs: number, restMs: number = REST_MIN_MS): number {
  return resting() ? Math.max(activeMs, restMs, REST_MIN_MS) : activeMs
}

/** Record a new requested class. Returns the effective class after it. */
export function request(next: ElasticClass): ElasticClass {
  requested = next
  return recheck()
}

/** Re-read the busy probe and tell the listeners when the effective class moved.
 *  Called by whoever changes what "busy" means (a session status write). */
export function recheck(): ElasticClass {
  const now = working()
  if (wasWorking && !now) lastWorkEnd = Date.now()
  wasWorking = now
  const next = effectiveClass()
  if (next === published) return next
  published = next
  for (const listener of [...listeners]) {
    try {
      listener(next)
    } catch {
      // A timer owner that fails to re-arm must not stop the next one.
    }
  }
  return next
}

/** Epoch ms the last turn in this process ended, as seen by `recheck` (every
 *  session status write calls it). Undefined until one has. */
export function lastWorkEndAt(): number | undefined {
  return lastWorkEnd
}

/** Follow effective-class changes. Returns the unsubscribe. */
export function onChange(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Where "a turn or a sub-agent runs" comes from (`activity.ts` installs it). */
export function setBusyProbe(probe: () => boolean): void {
  busy = probe
}

/** Test seam: back to an unclassified engine. Keeps the busy probe and listeners
 *  (they belong to the modules that installed them). */
export function resetForTest(): void {
  request("active")
  wasWorking = working()
  lastWorkEnd = undefined
}
