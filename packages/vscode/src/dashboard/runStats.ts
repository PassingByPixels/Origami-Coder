// The `run_stats` host leaf — per-run counts for a PAGE of the Labyrinth's run
// index, so a listed run can show its own cache health rather than only its
// title and date. Sibling of boardData.ts, and separate from it for the reason
// the ratchet exists: that file sits on its architecture cap.
//
// COST, stated plainly because it is the reason this is not on the history
// wire. Every session id in the batch costs the engine one `session.messages`
// read — the same read `run_steps` does — so this is asked ONCE when the
// Labyrinth opens its index, never per row and never from `requestHistory`,
// which the chat history dropdown and the chat pane also wait on.
//
// No `vscode` import, so the no-session guard and the failure-into-an-`error`
// shape are testable without an extension host. Same conventions as
// boardData.ts: a failure becomes an `error` FIELD, never a rejected promise,
// because the caller is a panel that still has to draw something.
import type { RunStat, RunStatsResult } from '../acpExtTypes';

interface RunStatsSource {
  getRunStats(sessionIds: string[], cwd?: string): Promise<RunStatsResult>;
}

export interface RunStatsPayload {
  stats: RunStat[];
  /** True when the engine capped the batch; the extras are absent from `stats`. */
  truncated: boolean;
  error?: string;
}

const NO_SESSION = 'Open a chat first — this needs a live engine connection.';
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Only the ids that could name a run. A blank one would cost a read and
 *  answer nothing, and a duplicate would cost the same read twice. */
export function statIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  for (const id of raw) if (typeof id === 'string' && id) seen.add(id);
  return [...seen];
}

/**
 * Counts for these runs. An empty id list is answered WITHOUT a round trip:
 * there is nothing to count, and that is not an error.
 *
 * `stats` is read defensively — a row that crossed the wire malformed is
 * dropped rather than trusted, so a consumer never has to guard a `sessionId`
 * that is not a string.
 */
export async function runStatsPayload(
  client: RunStatsSource | null | undefined,
  sessionIds: string[],
  cwd = '',
): Promise<RunStatsPayload> {
  const ids = statIds(sessionIds);
  if (ids.length === 0) return { stats: [], truncated: false };
  if (!client) return { stats: [], truncated: false, error: NO_SESSION };
  try {
    const res = await client.getRunStats(ids, cwd || undefined);
    const stats = Array.isArray(res?.stats)
      ? res.stats.filter((s): s is RunStat => !!s && typeof s === 'object' && typeof s.sessionId === 'string' && !!s.sessionId)
      : [];
    return { stats, truncated: res?.truncated === true };
  } catch (e) {
    return { stats: [], truncated: false, error: message(e) };
  }
}
