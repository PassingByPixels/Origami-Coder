// The picker's cache of a keyless-catalog gateway's ENTITLED model ids (OpenCode Zen/Go),
// keyed by `baseURL + key`: entitlements belong to the KEY, so a Re-key sweeps fresh at
// once, and two blocks that share a baseURL never see each other's set. Moved out of
// DashboardPanel.ts (t-ttmo5w) so the revalidation rule can be tested without a panel.
//
// Two clocks, because the two checks cost very different amounts:
//  - the FULL sweep (gatewayEntitlements.ts) probes every catalog id (64 on Zen), so it
//    stands for SWEEP_TTL_MS;
//  - the catalog itself is one keyless GET /models, so it is re-read after REVALIDATE_MS
//    and used as a fingerprint: an unchanged menu costs nothing more, a changed one
//    probes ONLY the ids that are new and drops the ids the gateway no longer lists.
// Before t-ttmo5w only the first clock existed, so a model the gateway added stayed out
// of the picker for up to six hours; a window reload "fixed" it by making a new panel.
//
// Every network step runs in the BACKGROUND and `onLanded` re-broadcasts the picker when
// it changes the cache. A full sweep fills the cache only with a non-empty answer, so a
// failed sweep retries on the next open instead of caching "none".

import { fetchCatalogIds } from './keyOnlyPresets';
import { sweepEntitledModels } from './gatewayEntitlements';

/** How long a full sweep stands. */
export const SWEEP_TTL_MS = 21_600_000;
/** How long the catalog fingerprint stands: the stated bound for a new model to show. */
export const REVALIDATE_MS = 5 * 60_000;

export interface GatewayEntry {
  ids: string[];
  catalog: string[];
  /** When the last FULL sweep landed. */
  at: number;
  /** When the catalog was last read. */
  checkedAt: number;
}

export interface GatewayEntitledCacheDeps {
  fetch: typeof fetch;
  /** Sent as `x-opencode-session` on every probe (gatewayEntitlements.ts header). */
  sessionId: string;
  /** Called when a background step changed the cache; the panel re-broadcasts. */
  onLanded: () => void;
  now?: () => number;
}

export class GatewayEntitledCache {
  private readonly entries = new Map<string, GatewayEntry>();
  /** One background step per key. Resolves true when the gateway answered. */
  private readonly inFlight = new Map<string, Promise<boolean>>();
  private readonly now: () => number;
  /** Bumped by clear(): a step started before it must not write its older answer back. */
  private generation = 0;

  constructor(private readonly deps: GatewayEntitledCacheDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** The cached entry for one gateway block, or undefined before its first sweep lands. */
  get(baseURL: string, apiKey?: string): GatewayEntry | undefined {
    return this.entries.get(cacheKey(baseURL, apiKey));
  }

  /** The entitled ids to show NOW. Never waits on the network: a stale or missing entry
   *  starts a background step and answers with what is cached (empty on a first miss). */
  async served(baseURL: string, apiKey?: string): Promise<string[]> {
    const key = cacheKey(baseURL, apiKey);
    const hit = this.entries.get(key);
    const swept = hit !== undefined && this.now() - hit.at < SWEEP_TTL_MS;
    if (swept && this.now() - hit.checkedAt < REVALIDATE_MS) return hit.ids;
    if (!this.inFlight.has(key)) {
      const step = swept ? this.revalidate(key, hit, baseURL, apiKey) : this.sweep(key, baseURL, apiKey);
      const run: Promise<boolean> = step.finally(() => { if (this.inFlight.get(key) === run) this.inFlight.delete(key); });
      this.inFlight.set(key, run);
    }
    return hit?.ids ?? [];
  }

  /** Forget every entry (the Connections Refresh button). The next open sweeps fresh. */
  clear(): void {
    this.generation++;
    this.entries.clear();
    this.inFlight.clear();
  }

  /** Resolves when every background step has finished: true when every gateway answered. */
  async idle(): Promise<boolean> {
    const results = await Promise.all([...this.inFlight.values()]);
    return results.every(Boolean);
  }

  private async sweep(key: string, baseURL: string, apiKey?: string): Promise<boolean> {
    const generation = this.generation;
    const catalog = await fetchCatalogIds(baseURL, this.deps.fetch, apiKey);
    if (catalog.length === 0) return false;
    const ids = await this.probe(baseURL, apiKey, catalog);
    if (ids.length === 0 || generation !== this.generation) return true;
    const at = this.now();
    this.entries.set(key, { ids, catalog, at, checkedAt: at });
    this.deps.onLanded();
    return true;
  }

  private async revalidate(key: string, entry: GatewayEntry, baseURL: string, apiKey?: string): Promise<boolean> {
    const generation = this.generation;
    const catalog = await fetchCatalogIds(baseURL, this.deps.fetch, apiKey);
    // Unreachable: keep the list, but wait a full interval before asking again.
    if (catalog.length === 0) { entry.checkedAt = this.now(); return false; }
    const known = new Set(entry.catalog);
    if (catalog.length === known.size && catalog.every((id) => known.has(id))) { entry.checkedAt = this.now(); return true; }
    const added = catalog.filter((id) => !known.has(id));
    const entitled = new Set([...entry.ids, ...(added.length > 0 ? await this.probe(baseURL, apiKey, added) : [])]);
    if (generation !== this.generation) return true;
    this.entries.set(key, { ids: catalog.filter((id) => entitled.has(id)), catalog, at: entry.at, checkedAt: this.now() });
    this.deps.onLanded();
    return true;
  }

  private probe(baseURL: string, apiKey: string | undefined, ids: readonly string[]): Promise<string[]> {
    return sweepEntitledModels(baseURL, apiKey ?? '', ids, this.deps.fetch, this.deps.sessionId);
  }
}

function cacheKey(baseURL: string, apiKey?: string): string {
  return `${baseURL}\n${apiKey ?? ''}`;
}
