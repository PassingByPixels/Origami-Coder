// The `cache_stats` host leaf — this session's prompt-cache token accounting
// plus a lifetime sum, for the Insights cache-hit-ratio card.
import type { CacheStatsResult, SessionCacheTokens } from '../acpExtTypes';

/** Just the two public members of AcpClient this needs, so a test can fake it. */
export interface CacheStatsSource {
  extMethod(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** The ENGINE's session id. Null before the session is created. */
  readonly currentSessionId: string | null;
}

export interface CacheStatsPayload {
  current: SessionCacheTokens | null;
  lifetime: SessionCacheTokens | null;
  sessionCount: number;
  error?: string;
}

const NO_SESSION = 'Open a chat first — this needs a live engine connection.';
const EMPTY: CacheStatsPayload = { current: null, lifetime: null, sessionCount: 0 };
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * This session's cache totals plus the workspace's lifetime sum. No session
 * yet is an empty answer, not an error.
 */
export async function cacheStatsPayload(client: CacheStatsSource | null | undefined): Promise<CacheStatsPayload> {
  if (!client) return { ...EMPTY, error: NO_SESSION };
  const sessionId = client.currentSessionId;
  if (!sessionId) return EMPTY;
  try {
    const res = (await client.extMethod('cache_stats', { sessionId })) as unknown as CacheStatsResult;
    return {
      current: isTokens(res?.current) ? res.current : null,
      lifetime: isTokens(res?.lifetime) ? res.lifetime : null,
      sessionCount: typeof res?.sessionCount === 'number' ? res.sessionCount : 0,
    };
  } catch (e) {
    return { ...EMPTY, error: message(e) };
  }
}

/** A wire value is only real token accounting if it carries all four numbers. */
function isTokens(value: unknown): value is SessionCacheTokens {
  if (!value || typeof value !== 'object') return false;
  const t = value as Partial<SessionCacheTokens>;
  return (
    typeof t.input === 'number' &&
    typeof t.output === 'number' &&
    typeof t.cacheRead === 'number' &&
    typeof t.cacheWrite === 'number'
  );
}
