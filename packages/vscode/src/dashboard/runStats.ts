// The run_stats host leaf — per-run counts for a page of the Labyrinth's run index. Sibling of
// boardData.ts.
// Costs one engine read per session id in the batch, so it is asked once when the index opens,
// never per row. No vscode import; a failure becomes an `error` field, never a rejected promise.
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

/** Only the ids that could name a run — a blank or duplicate id would cost a read for nothing. */
export function statIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  for (const id of raw) if (typeof id === 'string' && id) seen.add(id);
  return [...seen];
}

/** Counts for these runs. An empty id list answers without a round trip. `stats` is read
 *  defensively — a malformed row is dropped rather than trusted. */
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
