// The pure restore planning for persisted /loop schedules: given what was persisted and
// which engine sessions are live again, decide which loops re-arm, which get pulled up
// headlessly, and which are left for the user. Extracted from loopPersistence.ts to keep the
// decisions testable without a Memento.

import { isPersistent, type PersistedLoop } from './loopPersistence';

/** Split persisted loops by whether their engine session is live again; entries with no live
 *  session must be left persisted untouched, never dropped or re-pointed. */
export function splitPersistedLoops(
  loops: readonly PersistedLoop[],
  liveEngineIds: ReadonlySet<string>,
): { rearm: PersistedLoop[]; needsAttention: PersistedLoop[] } {
  const rearm: PersistedLoop[] = [];
  const needsAttention: PersistedLoop[] = [];
  for (const loop of loops) (liveEngineIds.has(loop.sessionId) ? rearm : needsAttention).push(loop);
  return { rearm, needsAttention };
}

/** Host callback to enact a rearm: install the schedule only (never run the prompt
 *  immediately), or a reload would fire a burst of missed runs. */
export interface RearmHost {
  arm: (localId: string, loop: PersistedLoop) => void;
}

/** Re-arm persisted loops whose engine session is live again, in persisted order; a loop
 *  with no live session is never re-pointed at a different chat. */
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
  // A loop with no live chat splits by intent: a persistent one goes to `recall` for headless
  // reopening; a plain one stays surfaced for the user to resume or cancel, unchanged.
  const recall: PersistedLoop[] = [];
  const needsAttention: PersistedLoop[] = [];
  for (const loop of unarmed) (isPersistent(loop) ? recall : needsAttention).push(loop);
  return { rearmed: rearm, recall, needsAttention };
}
