// loopRearm.ts — the PURE restore planning for persisted /loop schedules:
// given what was persisted and which engine sessions are live again, decide
// which loops re-arm on an open chat, which get pulled back up headlessly, and
// which are left alone for the user to deal with.
//
// EXTRACTED from loopPersistence.ts when persistent loops landed and that file
// hit its architecture cap — the same split cronService.ts/cronReconcile.ts
// took. loopPersistence.ts keeps the STORAGE (the memento, the record shape,
// the validity rule); this file keeps the DECISIONS, which is the half worth
// testing without a Memento in sight. loopPersistence re-exports everything
// here, so callers still have one import site.

import { isPersistent, type PersistedLoop } from './loopPersistence';

/** Split persisted loops by whether their engine session is live again
 *  (`liveEngineIds` — the engine ids of sessions currently open in this
 *  window). `rearm` entries have a session to prompt into; `needsAttention`
 *  entries do not, and the caller must leave them persisted untouched
 *  rather than drop or re-point them. */
export function splitPersistedLoops(
  loops: readonly PersistedLoop[],
  liveEngineIds: ReadonlySet<string>,
): { rearm: PersistedLoop[]; needsAttention: PersistedLoop[] } {
  const rearm: PersistedLoop[] = [];
  const needsAttention: PersistedLoop[] = [];
  for (const loop of loops) (liveEngineIds.has(loop.sessionId) ? rearm : needsAttention).push(loop);
  return { rearm, needsAttention };
}

/** Host callback DashboardPanel supplies to enact a rearm: install the
 *  schedule on the given LOCAL session id. Implementations must ONLY
 *  schedule the next tick (e.g. `setTimeout(fn, loop.intervalMs)`) — never
 *  run the prompt immediately, or a reload would fire a burst of missed
 *  runs just because the interval elapsed while the window was closed. */
export interface RearmHost {
  arm: (localId: string, loop: PersistedLoop) => void;
}

/** Re-arm persisted loops whose engine session is live again (`liveByEngineId`,
 *  engine id -> local session id) via `host.arm`, in persisted order. A loop
 *  with no live session is never re-pointed at a different chat, and nothing
 *  here writes to storage. */
export function armRestoredLoops(
  loops: readonly PersistedLoop[],
  liveByEngineId: ReadonlyMap<string, string>,
  host: RearmHost,
): { rearmed: PersistedLoop[]; recall: PersistedLoop[]; needsAttention: PersistedLoop[] } {
  const { rearm, needsAttention: unarmed } = splitPersistedLoops(loops, new Set(liveByEngineId.keys()));
  for (const loop of rearm) {
    const localId = liveByEngineId.get(loop.sessionId);
    if (localId) host.arm(localId, loop);
  }
  // A loop with no live chat splits by INTENT, not by circumstance. A persistent
  // one asked to be pulled back up, so it goes to `recall` for the caller to
  // reopen headlessly — returned rather than invoked, because that is async and
  // this module stays pure. A plain one keeps the old contract exactly:
  // untouched, still persisted, surfaced so the user can resume or cancel it.
  // An absent `persistent` flag means plain (see loopPersistence.isPersistent).
  const recall: PersistedLoop[] = [];
  const needsAttention: PersistedLoop[] = [];
  for (const loop of unarmed) (isPersistent(loop) ? recall : needsAttention).push(loop);
  return { rearmed: rearm, recall, needsAttention };
}
