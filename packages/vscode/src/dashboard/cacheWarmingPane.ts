// cacheWarmingPane.ts — the two messages behind the Insights pane's prompt-cache
// warming switch: read the setting, write the setting.
//
// Its own module rather than two more cases in DashboardPanel.ts, on the
// precedent subagentLimitPane.ts set: a pane that reads SETTINGS and never the
// engine needs nothing from the panel but `post`.
//
// The value is read by the engine at SPAWN (cacheWarming.ts), so a write here
// changes nothing until the window reloads. The reply says so rather than
// leaving the pane to claim an effect it cannot deliver.

import { cacheWarmingEnabled, setCacheWarmingEnabled } from '../cacheWarming';

// The READ takes the house `request*` prefix (requestSubagentLimit), which
// Origami Remote's allowlist treats as a read a phone may make.
export const CACHE_WARMING_MESSAGE_TYPES = new Set(['requestCacheWarming', 'cacheWarmingSet']);

export interface CacheWarmingHost {
  post(message: Record<string, unknown>): void;
}

function state(error?: string): Record<string, unknown> {
  return {
    type: 'cacheWarmingData',
    enabled: cacheWarmingEnabled(),
    ...(error ? { error } : {}),
  };
}

export async function handleCacheWarmingMessage(
  host: CacheWarmingHost,
  m: { type?: string; [k: string]: unknown },
): Promise<void> {
  if (m.type === 'requestCacheWarming') {
    host.post(state());
    return;
  }
  if (m.type !== 'cacheWarmingSet') return;
  // A webview is not a trusted validator: anything that is not an exact boolean
  // is refused rather than coerced, so the stored value can never be a string
  // the engine's `!== false` reading would treat as ON.
  if (typeof m['enabled'] !== 'boolean') {
    host.post(state('Cache warming takes true or false.'));
    return;
  }
  host.post(state(await setCacheWarmingEnabled(m['enabled'])));
}
