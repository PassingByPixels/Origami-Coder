/**
 * The engine call behind every subscription-usage read, and the shapes it
 * answers. Extracted from providerUsage.ts as a real seam: this owns the
 * wire, providerUsage.ts owns the wording. Never returns a token — only
 * percentages cross here.
 */

export interface ProviderUsageClient {
  extMethod(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/** One quota lane, as `acp/provider-usage.ts` shapes it. */
export interface UsageWindow {
  readonly label: string;
  readonly usedPercent: number;
  /** Epoch millis. */
  readonly resetsAt?: number;
  /** Epoch millis this window OPENED, when the provider states it. */
  readonly startsAt?: number;
  /** How long this window is, when the provider states it. */
  readonly lengthMs?: number;
}

/** Hand-mirrored from the engine's `UsageResult`, like providerAuthPane's shapes. */
export interface UsageResult {
  ok?: boolean;
  providerID?: string;
  plan?: string;
  windows?: UsageWindow[];
  unavailable?: string;
}

/** Ask one connection how much of its plan is spent. Never throws: an engine predating this method
 *  degrades to a refusal the caller can render. */
export async function fetchProviderUsage(
  client: ProviderUsageClient,
  providerId: string,
): Promise<UsageResult> {
  try {
    return (await client.extMethod('provider_auth_usage', { providerID: providerId })) as unknown as UsageResult;
  } catch {
    return { ok: false, providerID: providerId, unavailable: 'This engine build cannot report subscription usage.' };
  }
}
