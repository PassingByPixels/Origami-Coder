/**
 * How much of a subscription's quota is spent, for the Lab fold. Own file
 * because providerAuthPane.ts is at its cap and owns a flow, not a read.
 * Lazy, never polled; the token never reaches here, only the engine's percentages.
 */

import { configuredUsageCapableIds } from './usageCapable';
import { fetchProviderUsage, type ProviderUsageClient, type UsageWindow } from './providerUsageFetch';

// Re-exported so the fold's callers and its tests keep one import path.
export { fetchProviderUsage } from './providerUsageFetch';
export type { ProviderUsageClient, UsageResult, UsageWindow } from './providerUsageFetch';

export const PROVIDER_USAGE_MESSAGE_TYPES = new Set(['providerUsageRequest', 'providerUsageCapableRequest']);

export interface ProviderUsageHost {
  readonly client?: ProviderUsageClient;
  readonly post: (msg: Record<string, unknown>) => void;
}

/** A window as one short sentence ("5-hour: 12% used, resets in 2h 30m"). Rendered here, not in
 *  Svelte, so the wording is testable without a DOM. */
export function usageLine(window: UsageWindow, now: number): string {
  const used = `${Math.round(window.usedPercent)}% used`;
  if (window.resetsAt === undefined) return `${window.label}: ${used}`;
  const seconds = Math.round((window.resetsAt - now) / 1000);
  // A reset already in the past reads as "resetting now", not a negative time.
  if (seconds <= 0) return `${window.label}: ${used}, resetting now`;
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const span = days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
  return `${window.label}: ${used}, resets in ${span}`;
}

/** Ask the engine and post the answer back. Every failure path answers with `unavailable` rather
 *  than throwing or staying silent. */
export async function handleProviderUsageMessage(
  host: ProviderUsageHost,
  m: Record<string, unknown>,
): Promise<void> {
  // Which providers could answer at all — asked once on mount, before any model is picked.
  // Config-only, so it works with no engine running.
  if (m.type === 'providerUsageCapableRequest') {
    host.post({ type: 'providerUsageCapable', ids: configuredUsageCapableIds() });
    return;
  }
  if (m.type !== 'providerUsageRequest') return;
  const providerId = typeof m.providerId === 'string' ? m.providerId : '';
  if (!providerId) return;
  const send = (extra: Record<string, unknown>) =>
    host.post({ type: 'providerUsageData', providerId, ...extra });
  if (!host.client) {
    send({ unavailable: 'Open a chat so the engine is running, then reopen this.' });
    return;
  }
  // An engine predating this method answers method_not_found — version skew, not a broken account.
  const result = await fetchProviderUsage(host.client, providerId);
  if (!result?.ok) {
    send({ unavailable: result?.unavailable || 'Usage is not available for this connection.' });
    return;
  }
  const windows = Array.isArray(result.windows) ? result.windows : [];
  if (windows.length === 0) {
    send({ unavailable: 'The provider reported no quota window for this account.' });
    return;
  }
  // Formatted here, not in the webview: tsconfig.webview.json blocks importing this module there,
  // and the text is a snapshot computed once at fold-open.
  const now = Date.now();
  send({
    lines: windows.map((w) => usageLine(w, now)),
    // SAME order as `lines`, index-for-index — the webview picks the tightest
    // window for the pill's own number (t-d942yi) and reuses the matching
    // pre-formatted `lines` entry for its text, rather than reformatting a
    // second time on that side (tsconfig.webview.json blocks importing
    // usageLine there too).
    windows: windows.map((w) => ({ label: w.label, pct: Math.round(w.usedPercent), resetsAt: w.resetsAt ?? 0 })),
    ...(result.plan ? { plan: result.plan } : {}),
  });
}
