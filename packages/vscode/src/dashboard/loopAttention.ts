// The wire shape for a PERSISTED loop whose engine session did not come back on a restore — split
// from loopSchedules.ts when that file grew its live-projection fields past its cap.

import { formatInterval } from './chatCommands';

/** A persisted loop whose engine session did NOT come back (agentManager/loopPersistence.ts's
 *  `needsAttention` bucket) — no live chat identity, and deliberately no next-run field since
 *  nothing is scheduled for one of these. */
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
