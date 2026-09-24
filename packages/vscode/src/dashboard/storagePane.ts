// storagePane.ts — the Insights Storage card's host half: measure the session
// store, and prune old tool payloads out of it.
//
// Its own module rather than more cases in DashboardPanel.ts, on the
// cacheWarmingPane.ts precedent — but unlike that one this pane reads the
// ENGINE (the store is the engine's SQLite file), so it is shaped like
// mcpPane.ts: every job goes through the active session's extMethod, and with
// no chat open there is no answer.
//
// The pane never decides what is safe to remove. The engine owns the window
// floor, the protected tail and the rewrite itself (engine
// `src/storage/retention.ts`); this file carries a request and a reply.

import { NEST_STORAGE_MESSAGE_TYPES, handleNestStorageMessage } from './nestStoragePane';

// The Nests view's Storage card (t-s9jr6u) rides this route: it needs the same
// engine client, and DashboardPanel.ts is at its cap.
export const STORAGE_PANE_MESSAGE_TYPES = new Set(['requestStorageStats', 'storagePrune', ...NEST_STORAGE_MESSAGE_TYPES]);

export interface StoragePaneClient {
  extMethod(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface StoragePaneHost {
  client?: StoragePaneClient;
  post(message: Record<string, unknown>): void;
}

const NO_SESSION = 'Open a chat first — the store is measured through a live engine connection.';

/** The floor the ENGINE clamps to, repeated here only so the card can refuse a
 *  window before it costs a round trip. The engine still clamps; this is not the
 *  guard, it is the message. */
export const MIN_WINDOW_DAYS = 7;
export const DEFAULT_WINDOW_DAYS = 60;

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function handleStorageMessage(
  host: StoragePaneHost,
  m: { type?: string; [k: string]: unknown },
): Promise<void> {
  if (NEST_STORAGE_MESSAGE_TYPES.has(m.type ?? '')) return handleNestStorageMessage(host, m);
  if (m.type === 'requestStorageStats') {
    if (!host.client) {
      host.post({ type: 'storageStatsData', error: NO_SESSION });
      return;
    }
    try {
      host.post({ type: 'storageStatsData', stats: await host.client.extMethod('storage_stats', {}) });
    } catch (error) {
      host.post({ type: 'storageStatsData', error: reason(error) });
    }
    return;
  }
  if (m.type !== 'storagePrune') return;
  // A webview is not a trusted validator. `dryRun` defaults to TRUE here as it
  // does on the wire, so a malformed message can only ever measure.
  const dryRun = m['dryRun'] !== false;
  const days = m['olderThanDays'];
  if (typeof days !== 'number' || !Number.isFinite(days) || days < MIN_WINDOW_DAYS) {
    host.post({ type: 'storagePruneData', dryRun, error: `The window must be at least ${MIN_WINDOW_DAYS} days.` });
    return;
  }
  if (!host.client) {
    host.post({ type: 'storagePruneData', dryRun, error: NO_SESSION });
    return;
  }
  try {
    const result = await host.client.extMethod('storage_prune', { olderThanDays: Math.floor(days), dryRun });
    host.post({ type: 'storagePruneData', dryRun, result });
    // A real prune changes the split, so the card is re-measured rather than
    // left showing the numbers the user pruned against.
    if (!dryRun) await handleStorageMessage(host, { type: 'requestStorageStats' });
  } catch (error) {
    host.post({ type: 'storagePruneData', dryRun, error: reason(error) });
  }
}
