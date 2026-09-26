export * as ElasticActivity from "./activity"

import { Effect } from "effect"
import { ElasticState } from "./state"

/**
 * WHERE "THIS ENGINE IS DOING SOMETHING" IS READ FROM (t-w2qlop).
 *
 * The state that says an engine is busy lives in many places, most of them
 * per-folder `InstanceState` maps that nothing can list from outside. So each
 * owner REGISTERS A PROBE over its own live map when the map is built, and
 * removes it when the map is disposed. A probe returns the ids of the live
 * items. Reading a probe reads the real state, not a copy kept in step with it:
 * there is no event to miss.
 *
 * `idle.ts` turns the probes into the idle report; `state.ts` asks `busy()` to
 * decide the effective class.
 */

/** Sources with a probe. `session-busy` is internal: `idle.ts` splits it into
 *  `turn-running` and `subagent-running`. */
export type Source =
  | "session-busy"
  | "subagent-running"
  | "background-job"
  | "permission-pending"
  | "question-pending"
  | "collab-run"
  | "nest-lease"

export type Probe = () => Iterable<string>

const probes = new Map<Source, Set<Probe>>()

/** Register a probe. Returns the unregister. */
export function probe(source: Source, read: Probe): () => void {
  const set = probes.get(source) ?? new Set<Probe>()
  probes.set(source, set)
  set.add(read)
  return () => {
    set.delete(read)
  }
}

/** {@link probe} for a scoped owner: removed when the scope closes, which is
 *  when the map it reads is disposed. */
export const probeScoped = (source: Source, read: Probe) =>
  Effect.acquireRelease(
    Effect.sync(() => probe(source, read)),
    (off) => Effect.sync(off),
  )

/** The id a probe that threw stands for. It keeps the report "not parkable":
 *  a state that cannot be read is not evidence of idleness. */
export const UNREADABLE = "(unreadable)"

/** The live ids of one source, across every registered probe. */
export function read(source: Source): Set<string> {
  const ids = new Set<string>()
  for (const read of probes.get(source) ?? []) {
    try {
      for (const id of read()) ids.add(id)
    } catch {
      ids.add(UNREADABLE)
    }
  }
  return ids
}

/** A turn runs in this process: a session with a busy or retry status, or a
 *  busy runner. A sub-agent is a session too, so it counts while it works.
 *  While this holds, a requested `idle` is held at `background`.
 *
 *  Job state is left out ON PURPOSE: a job settles after its session went idle,
 *  and nothing re-checks the class at that moment, so a job-based answer would
 *  hold the engine at `active` until some unrelated status change. */
export function busy(): boolean {
  return read("session-busy").size > 0
}

ElasticState.setBusyProbe(busy)

/** How many probes are registered for a source. For a test that asserts an
 *  owner's probe went away with its map. */
export function probeCount(source: Source): number {
  return probes.get(source)?.size ?? 0
}
