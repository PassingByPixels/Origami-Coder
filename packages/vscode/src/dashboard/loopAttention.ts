// loopAttention.ts — the wire shape for a PERSISTED loop whose engine session
// did not come back on a restore. Extracted from loopSchedules.ts when the live
// projection grew its next-run / last-run fields and that file was at its cap.
//
// The split is along the honesty line the two shapes already had: a live loop
// can be asked what its armed timer will do next, and a needs-attention one
// cannot — nothing is armed for it at all.

import { formatInterval } from './chatCommands';

/** A persisted loop whose engine session did NOT come back on this restore
 *  (agentManager/loopPersistence.ts's `needsAttention` bucket) — no live
 *  chat identity (number/agentName/title) to show, only what was persisted.
 *
 *  Deliberately carries NO next-run field: nothing is scheduled for one of
 *  these, so any time here would be an invention. */
export interface NeedsAttentionLoop {
  sessionId: string;
  intervalLabel: string;
  prompt: string;
  runs: number;
  createdAt: number;
  /** Persistent loops reach here only when RECALL FAILED (engine session gone). */
  persistent: boolean;
}

/** The slice of a PersistedLoop this leaf needs — kept structural (not
 *  imported from loopPersistence.ts) so this module has no dependency on the
 *  other module's type. */
interface PersistedLoopSource {
  sessionId: string;
  intervalMs: number;
  prompt: string;
  runs: number;
  createdAt: number;
  persistent?: boolean;
}

/** Project persisted-but-unarmed loops into wire data for the Loops pane's
 *  "needs attention" section. */
export function toNeedsAttentionLoops(loops: readonly PersistedLoopSource[]): NeedsAttentionLoop[] {
  return loops.map((l) => ({
    sessionId: l.sessionId,
    intervalLabel: formatInterval(l.intervalMs),
    prompt: l.prompt,
    runs: l.runs,
    createdAt: l.createdAt,
    persistent: l.persistent === true,
  }));
}
