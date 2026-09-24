// modelListRefresh.test.ts — the Connections Refresh button, end to end on the host
// side (t-ttmo5w, src/dashboard/modelListRefresh.ts).
//
// Driven with the REAL pieces the panel wires together: the gateway cache
// (gatewayEntitledCache.ts), the picker merge (liveModelMerge.ts) and the engine
// refresh seam (providerRefresh.ts). Only the network and the engine are fakes: a
// fake OpenAI-compatible gateway, and an engine that records the ext method.
// The assertion is the thing the owner saw: the picker rows the host POSTS.

import { describe, expect, it, vi } from 'vitest';
import { GatewayEntitledCache } from '../../../src/dashboard/gatewayEntitledCache';
import { mergeLiveModels, type ModelOptionRow } from '../../../src/dashboard/liveModelMerge';
import { createModelListRefresh } from '../../../src/dashboard/modelListRefresh';
import { PROVIDER_REFRESH_METHOD, type RefreshTarget } from '../../../src/dashboard/providerRefresh';
import { fetchClaudeSubscriptionReadiness, resetClaudeSubscriptionStatusCache } from '../../../src/claudeSubscription/engineStatus';

const BASE = 'https://opencode.ai/zen/v1';
const PROVIDERS = { opencode: { options: { baseURL: BASE, apiKey: 'sk-test' }, models: {} } };

function harness(initial: string[], engineTargets: RefreshTarget[]) {
  const gw = { catalog: [...initial], sweeps: 0 };
  const fetchImpl = (async (url: unknown) => {
    if (String(url) === `${BASE}/models`) {
      gw.sweeps++;
      const menu = gw.catalog.map((id) => ({ id }));
      return { ok: true, status: 200, json: async () => ({ data: menu }) } as Response;
    }
    return { ok: true, status: 200 } as Response;
  }) as unknown as typeof fetch;
  const posted: Array<{ type: string; ok?: boolean; rows?: string[] }> = [];
  const broadcastModels = async () => {
    const rows = await mergeLiveModels([] as ModelOptionRow[], PROVIDERS, (b, k) => cache.served(b, k));
    posted.push({ type: 'modelOptions', rows: rows.map((r) => r.value) });
  };
  const cache = new GatewayEntitledCache({ fetch: fetchImpl, sessionId: 's', onLanded: () => void broadcastModels() });
  const refresh = createModelListRefresh({
    clearGateways: () => cache.clear(),
    gatewaysIdle: () => cache.idle(),
    engineTargets: () => engineTargets,
    broadcastModels,
    broadcastProviderStatus: async () => undefined,
    post: (m) => posted.push(m),
  });
  /** The picker as the user sees it: the last modelOptions broadcast. */
  const picker = () => [...posted].reverse().find((m) => m.type === 'modelOptions')?.rows;
  return { gw, cache, posted, refresh, broadcastModels, picker };
}

describe('the Connections Refresh button', () => {
  it('a model the gateway just added is in the picker when the button answers, with no reload', async () => {
    const engine = { extMethod: vi.fn().mockResolvedValue({ ok: true }) };
    const h = harness(['a'], [{ client: engine, cwd: '/work/repo' }]);
    await h.broadcastModels();
    await h.cache.idle();
    expect(h.picker()).toEqual(['opencode/a']);

    h.gw.catalog.push('new-model');
    await h.broadcastModels(); // an ordinary picker open inside the cache window: still stale
    expect(h.picker()).toEqual(['opencode/a']);

    await h.refresh();
    const done = h.posted.findIndex((m) => m.type === 'modelListsRefreshed');
    expect(h.posted[done]).toEqual({ type: 'modelListsRefreshed', ok: true });
    // The spinner stops only AFTER the picker already holds the new row.
    const before = h.posted.slice(0, done).reverse().find((m) => m.type === 'modelOptions');
    expect(before?.rows).toEqual(['opencode/a', 'opencode/new-model']);
    expect(engine.extMethod).toHaveBeenCalledWith(PROVIDER_REFRESH_METHOD, { cwd: '/work/repo', hard: true });
  });

  it('a second press while one runs joins it: one sweep, one answer', async () => {
    const h = harness(['a'], []);
    await Promise.all([h.refresh(), h.refresh()]);
    expect(h.gw.sweeps).toBe(1);
    expect(h.posted.filter((m) => m.type === 'modelListsRefreshed')).toHaveLength(1);
  });

  it('an engine that does not answer turns the button to failed, and the picker is still refreshed', async () => {
    const dead = { extMethod: vi.fn().mockRejectedValue(new Error('connection closed')) };
    const h = harness(['a', 'b'], [{ client: dead }]);
    await h.refresh();
    expect(h.posted.at(-1)).toEqual({ type: 'modelListsRefreshed', ok: false });
    expect(h.picker()).toEqual(['opencode/a', 'opencode/b']);
  });

  it('a broadcast that throws still answers the button (failed), so the spinner stops', async () => {
    const post = vi.fn();
    const refresh = createModelListRefresh({
      clearGateways: () => undefined,
      gatewaysIdle: async () => true,
      engineTargets: () => [],
      broadcastModels: async () => { throw new Error('boom'); },
      broadcastProviderStatus: async () => undefined,
      post,
    });
    await expect(refresh()).resolves.toBeUndefined();
    expect(post).toHaveBeenCalledWith({ type: 'modelListsRefreshed', ok: false });
  });

  // t-ty02bb: after `claude update`, the press must show the new Gate B answer. The
  // engine re-probes on `hard`; the host's own 5 s copy must not hide that answer.
  it('Claude (subscription): the readiness read after the press is the new engine answer, not the cached one', async () => {
    resetClaudeSubscriptionStatusCache();
    let state = 'version-too-old';
    const engine = {
      extMethod: vi.fn(async (method: string) =>
        method === 'claude_subscription_status' ? { state, found: '2.1.198', floor: '2.1.263' } : { ok: true }),
    };
    const refresh = createModelListRefresh({
      clearGateways: () => undefined,
      gatewaysIdle: async () => true,
      engineTargets: () => [{ client: engine }],
      broadcastModels: async () => undefined,
      broadcastProviderStatus: async () => undefined,
      post: () => undefined,
    });
    expect((await fetchClaudeSubscriptionReadiness(engine)).state).toBe('version-too-old');
    state = 'ready'; // the owner ran `claude update`; the engine's hard refresh re-ran Gate B
    expect((await fetchClaudeSubscriptionReadiness(engine)).state).toBe('version-too-old'); // cached
    await refresh();
    expect((await fetchClaudeSubscriptionReadiness(engine)).state).toBe('ready');
  });
});
