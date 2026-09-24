// The Connections Refresh button (t-ttmo5w): make a model a provider just added show
// in the picker NOW, without a window reload. Its own leaf because DashboardPanel.ts
// is a message switch, and the order below is the part worth testing.
//
// Every cache that can hold a stale model list is dropped, in this order:
//  1. the panel's gateway entitlement cache (OpenCode Zen/Go rows: gatewayEntitledCache.ts);
//  2. each engine's provider list, live-discovery memo and on-disk catalog cache
//     (`provider_refresh` with `hard`: engine acp/service.ts);
//  3. Claude (subscription)'s readiness: the engine re-runs Gate B on `hard`, and the
//     host's 5 s copy (claudeSubscription/engineStatus.ts) is dropped (t-ty02bb);
// then the picker is re-broadcast, which starts fresh gateway sweeps, and the button
// is answered only once those sweeps have landed, so its spinner means "still asking".

import { refreshEngineProviders, type RefreshTarget } from './providerRefresh';
import { resetClaudeSubscriptionStatusCache } from '../claudeSubscription/engineStatus';

export const MODEL_LIST_REFRESH_MESSAGE_TYPES: ReadonlySet<string> = new Set(['refreshModelLists']);

export interface ModelListRefreshHost {
  clearGateways(): void;
  /** Resolves when every gateway sweep has landed: true when every gateway answered. */
  gatewaysIdle(): Promise<boolean>;
  /** Every live engine: each chat's, else the window's host engine. */
  engineTargets(): RefreshTarget[];
  broadcastModels(): Promise<void>;
  broadcastProviderStatus(): Promise<void>;
  post(message: { type: 'modelListsRefreshed'; ok: boolean }): void;
}

/** The handler. A second press while one runs joins it instead of starting a second
 *  round of probes against the same keys. */
export function createModelListRefresh(host: ModelListRefreshHost): () => Promise<void> {
  let running: Promise<void> | null = null;
  const run = async (): Promise<void> => {
    let ok = false;
    try {
      host.clearGateways();
      const engines = await refreshEngineProviders(host.engineTargets(), { hard: true });
      resetClaudeSubscriptionStatusCache();
      await host.broadcastModels();
      const gateways = await host.gatewaysIdle();
      await host.broadcastProviderStatus();
      ok = engines && gateways;
    } catch {
      // ok stays false: the button shows "failed", never a spinner that does not stop
    }
    host.post({ type: 'modelListsRefreshed', ok });
  };
  return () => (running ??= run().finally(() => { running = null; }));
}
