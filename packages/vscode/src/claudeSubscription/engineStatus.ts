// engineStatus.ts — the one host call the picker uses to read the engine's
// own Gate B answer for "Claude (subscription, experimental)" (t-tjt9wd).
//
// The engine exposes this synchronously (provider/claude-subscription.ts
// `readiness()`, refreshed by `providerInfo()` on config load and every 10
// min while the flag is on — no CLI spawn on this path). This module adds a
// short cache of its own on the extension side, so a burst of picker renders
// (typing in the filter box, opening the tab) does not round-trip the ACP
// connection once per render.
import type { ClaudeSubscriptionReadiness } from './readiness';

/** What the `claude_subscription_status` ext method answers with — mirrors
 *  the engine's `ClaudeSubscription.WireStatus` (provider/claude-subscription.ts).
 *  Kept as a plain shape here, not imported, because the extension and the
 *  engine are separate processes and packages: this is the wire contract, not
 *  a shared type. */
interface EngineExtMethodClient {
  extMethod(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
}

const CACHE_MS = 5_000;
let cache: { at: number; value: ClaudeSubscriptionReadiness } | undefined;

/** Narrow an untrusted ext-method reply into the picker's shape. A reply that
 *  is missing, malformed, or names a state this extension does not know about
 *  reads as `unready` with the raw text if there is any — never as `ready`,
 *  because treating an unreadable answer as ready would let a broken wire look
 *  like a working connection. */
export function parseEngineClaudeSubscriptionStatus(raw: unknown): ClaudeSubscriptionReadiness {
  const row = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  // t-vd9s7z: the binary the engine uses. An older engine sends no path.
  const path = typeof row.path === 'string' && row.path ? { path: row.path } : {};
  switch (row.state) {
    case 'ready':
      return { state: 'ready', ...(typeof row.version === 'string' && row.version ? { version: row.version } : {}), ...path };
    case 'cli-missing':
      return { state: 'cli-missing' };
    case 'not-logged-in':
      return { state: 'not-logged-in' };
    case 'version-too-old':
      return {
        state: 'version-too-old',
        found: typeof row.found === 'string' ? row.found : '',
        floor: typeof row.floor === 'string' ? row.floor : '',
        ...path,
      };
    default:
      return {
        state: 'unready',
        reason: typeof row.reason === 'string' && row.reason ? row.reason : 'Claude (subscription) status is unknown.',
      };
  }
}

/** The host call, cached briefly. A client that has no `extMethod` (or whose
 *  call fails/times out — e.g. no engine session yet) answers `unready`
 *  rather than throwing: the caller (DashboardPanel) falls back to the local
 *  CLI-discovery heuristic (`readinessFromCli`) when there is no session at
 *  all, and this path is for when there IS one but the call itself failed. */
export async function fetchClaudeSubscriptionReadiness(
  client: EngineExtMethodClient,
  now: number = Date.now(),
): Promise<ClaudeSubscriptionReadiness> {
  if (cache && now - cache.at < CACHE_MS) return cache.value;
  let value: ClaudeSubscriptionReadiness;
  try {
    const raw = await client.extMethod('claude_subscription_status', {});
    value = parseEngineClaudeSubscriptionStatus(raw);
  } catch (error) {
    value = { state: 'unready', reason: error instanceof Error ? error.message : String(error) };
  }
  cache = { at: now, value };
  return value;
}

/** Test seam: the cache is module-wide. */
export const resetClaudeSubscriptionStatusCache = (): void => {
  cache = undefined;
};
