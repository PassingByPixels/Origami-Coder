/**
 * How much of a subscription connection's quota is spent, for the Lab fold.
 *
 * ITS OWN FILE, not part of providerAuthPane.ts, for the reason the ratchet
 * exists: that file sat at 284 against a cap of 285. It is also a different
 * subject — providerAuthPane owns a FLOW (three calls, a browser hand-off, a
 * config write), this owns a READ. Nothing here can change anything.
 *
 * LAZY, NEVER TIMED. The webview asks once when a provider's fold opens. There
 * is deliberately no poller: openai/codex#10869 is the bug report filed against
 * OpenAI's own CLI for polling this same endpoint every 60 seconds.
 *
 * THE TOKEN NEVER COMES HERE. The engine reads the credential, makes the call,
 * and answers with percentages (acp/provider-usage.ts). This file sees only what
 * a webview may see.
 */

import { configuredUsageCapableIds } from './usageCapable';

export const PROVIDER_USAGE_MESSAGE_TYPES = new Set(['providerUsageRequest', 'providerUsageCapableRequest']);

export interface ProviderUsageClient {
  extMethod(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface ProviderUsageHost {
  readonly client?: ProviderUsageClient;
  readonly post: (msg: Record<string, unknown>) => void;
}

/** One quota lane, as `acp/provider-usage.ts` shapes it. */
export interface UsageWindow {
  readonly label: string;
  readonly usedPercent: number;
  /** Epoch millis. */
  readonly resetsAt?: number;
}

/** Hand-mirrored from the engine's `UsageResult`, like providerAuthPane's shapes. */
interface UsageResult {
  ok?: boolean;
  providerID?: string;
  plan?: string;
  windows?: UsageWindow[];
  unavailable?: string;
}

/**
 * A window as one short sentence: "5-hour: 12% used, resets in 2h 30m".
 *
 * Rendered here rather than in Svelte so the wording is testable without a DOM,
 * and so "resets in" is computed against a clock the test controls.
 */
export function usageLine(window: UsageWindow, now: number): string {
  const used = `${Math.round(window.usedPercent)}% used`;
  if (window.resetsAt === undefined) return `${window.label}: ${used}`;
  const seconds = Math.round((window.resetsAt - now) / 1000);
  // A reset already in the past is not "resets in -3m" — the window has rolled
  // over and the number beside it is simply stale.
  if (seconds <= 0) return `${window.label}: ${used}, resetting now`;
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const span = days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
  return `${window.label}: ${used}, resets in ${span}`;
}

/**
 * Ask the engine, and post the answer back to the webview.
 *
 * Every failure path ends in a `providerUsageData` carrying `unavailable`, never
 * in a thrown error or in silence: the fold has to decide between "hide the
 * line" and "keep waiting", and silence cannot tell it which.
 */
export async function handleProviderUsageMessage(
  host: ProviderUsageHost,
  m: Record<string, unknown>,
): Promise<void> {
  // "Which providers could answer at all" — asked once on mount, before any
  // model is picked, so the model bar knows whether to ask for a usage read.
  // Config-only: it answers correctly with no engine running, which is exactly
  // the state a freshly opened window is in.
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
  let result: UsageResult;
  try {
    result = (await host.client.extMethod('provider_auth_usage', { providerID: providerId })) as unknown as UsageResult;
  } catch (e) {
    // An engine that predates this ext method answers method_not_found. That is
    // a version skew, not a broken account — say so without a stack.
    send({ unavailable: 'This engine build cannot report subscription usage.' });
    return;
  }
  if (!result?.ok) {
    send({ unavailable: result?.unavailable || 'Usage is not available for this connection.' });
    return;
  }
  const windows = Array.isArray(result.windows) ? result.windows : [];
  if (windows.length === 0) {
    send({ unavailable: 'The provider reported no quota window for this account.' });
    return;
  }
  // Formatted HERE, not in the webview. `tsconfig.webview.json` pins rootDir to
  // webview/, so a Svelte component cannot import this module — sending raw
  // numbers would mean a second copy of the wording living across that split,
  // which is exactly the drift keyOnlyPresets.mirror.test.ts exists to police.
  // The text is a SNAPSHOT: "resets in" is computed once, at fold-open. It goes
  // stale if the fold is left open, and reopening it asks again.
  const now = Date.now();
  send({ lines: windows.map((w) => usageLine(w, now)), ...(result.plan ? { plan: result.plan } : {}) });
}
