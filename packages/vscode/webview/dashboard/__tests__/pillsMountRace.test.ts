// The regression the owner reported on 0.4.116, both desktops: the context
// gauge and the plan-usage pill missing from chat panes that were plainly
// working - the model name showed, turns ran, no offline banner anywhere - and
// coming back only on a later trigger (a turn ending, a model change).
//
// IT IS A MOUNT-TIME ORDERING BUG, not an offline verdict. 0.4.113
// (lane/models-live, 394a704a18) put `refreshEngineProviders` - a
// `provider_refresh` ext call on EVERY live engine, seconds of work each,
// because it drops the engine's per-instance Config and Provider state and
// rebuilding it runs live model discovery - in FRONT of the `requestModels`
// broadcast. The sidebar ControlStrip posts `requestModels` on every window
// reload, so `modelOptions` (and the `modelStatus` that follows a discovery
// pass) landed seconds later than on 0.4.114, after the picker's one-shot
// mount reads had already fired into a void.
//
// These tests drive the REAL DashboardPanel over its own prototype (the
// remotePanelHarness pattern) with a fake ACP client, so what they assert is
// the production handler, not a re-description of it. No network: the gateway
// catalog fetch is the only outbound call on this path and it is mocked.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

let providers: Record<string, unknown> = {};

vi.mock('../../../src/dashboard/firstFold', async (orig) => ({
  ...(await orig() as Record<string, unknown>),
  readGlobalProviders: () => providers,
  detectLocalProvider: () => undefined,
  detectModel: () => '',
}));

vi.mock('../../../src/dashboard/keyOnlyPresets', async (orig) => ({
  ...(await orig() as Record<string, unknown>),
  fetchCatalogIds: async () => ['omen-alpha'],
}));

import { DashboardPanel } from '../../../src/dashboard/DashboardPanel';
import { createModelRefreshGate } from '../../../src/dashboard/modelRefreshGate';
import { DeltaFanout } from '../../../src/dashboard/deltaFanout';

/** The owner's two connections: a ChatGPT OAuth block (no baseURL, no apiKey -
 *  its liveness can only be answered by the engine's auth store) and the
 *  OpenCode Go keyless-catalog gateway (baseURL + apiKey - its probe is a
 *  catalog fetch that never touches that store). */
const OWNER_PROVIDERS = {
  openai: { name: 'ChatGPT', options: {} },
  'opencode-go': { name: 'OpenCode Go', options: { baseURL: 'https://opencode.example/v1', apiKey: 'k' } },
};

type Post = Record<string, unknown>;

function panelOn(
  current: string,
  extMethod: (m: string) => Promise<Record<string, unknown>>,
  opts: { refreshMs?: number } = {},
) {
  const posts: Post[] = [];
  const p = Object.create(DashboardPanel.prototype) as Record<string, unknown>;
  Object.defineProperty(p, 'cwd', { value: process.cwd() });
  const sessions = new Map<string, unknown>();
  const client = {
    // A `provider_refresh` costs REAL seconds against the owner's engine.
    extMethod: (m: string) => m === 'provider_refresh' && opts.refreshMs
      ? new Promise<Record<string, unknown>>((r) => setTimeout(() => r({ ok: true }), opts.refreshMs))
      : extMethod(m),
    getModelOption: () => ({ current, options: [] }),
  };
  sessions.set('session-1', {
    id: 'session-1', number: 1, agentName: 'Tsuru', messageLog: [], turnBusy: false,
    pendingPermissions: new Map(), modelWindow: 0, modelWindowFor: '', client,
  });
  p['sessions'] = sessions;
  p['activeSessionId'] = 'session-1';
  p['extraViews'] = [];
  p['viewSolo'] = new Map();
  p['viewWiring'] = new Map();
  // post() routes through this (t-tc2rlo #9); Object.create never runs the
  // class's own field initializer, same as every other Map above.
  p['deltaFanout'] = new DeltaFanout((id) => sessions.has(id));
  p['pendingQuestionPermissions'] = new Map();
  p['context'] = {
    extensionUri: { fsPath: process.cwd() },
    extension: { packageJSON: { version: 'harness' } },
    globalState: { get: <T>(_k: string, d: T) => d, update: () => Promise.resolve() },
    workspaceState: { get: <T>(_k: string, d: T) => d, update: () => Promise.resolve() },
  };
  // No local server: the owner's chats are both on remote providers, and this
  // keeps the LM Studio branch out of every verdict below.
  p['modelInfo'] = { ok: false, modelId: '', contextLength: 0, reason: 'no model loaded' };
  p['providerStatusCache'] = new Map();
  p['panel'] = { webview: { postMessage: (m: Post) => { posts.push(m); return Promise.resolve(true); } } };
  // The real broadcast merges a LIVE LM Studio poll; here it stands for "the
  // picker's model list went out", which is what the ordering test is about.
  p['broadcastModelOptions'] = () => { posts.push({ type: 'modelOptions', options: [] }); return Promise.resolve(); };
  p['broadcastConfigSelectors'] = () => undefined;
  p['resolveEngineUrl'] = () => '';
  p['engineRefreshTargets'] = () => [{ client }];
  p['modelRefreshGate'] = createModelRefreshGate();
  const of = (type: string) => posts.filter((m) => m.type === type);
  return {
    posts,
    statusCount: () => of('modelStatus').length,
    latestStatus: () => of('modelStatus').pop(),
    providerRows: () => (of('providerStatus').pop()?.providers ?? []) as Array<{ id: string; live: boolean }>,
    optionsCount: () => of('modelOptions').length,
    probeLatched: () => p['providerProbeInFlight'] as boolean,
    reload: () => (p['broadcastModelStatus'] as () => void).call(p),
    requestModels: () => (p['handleWebviewMessage'] as (m: unknown) => Promise<void>).call(p, { type: 'requestModels' }),
  };
}

const ANSWERS = async (m: string) =>
  m === 'provider_auth_list' ? { methods: {}, connected: { openai: { type: 'oauth' } } } : {};
const UNANSWERED = () => new Promise<Record<string, unknown>>(() => {});

describe('requestModels on a window reload', () => {
  beforeEach(() => { providers = { ...OWNER_PROVIDERS }; vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('broadcasts the model list BEFORE the multi-second engine refresh, not after it', async () => {
    // THE REGRESSION, in one assertion. `provider_refresh` takes seconds per
    // engine here, as it does on the owner's machine; the picker mounted on
    // reload has already made its one-shot reads by then. What the panel
    // already knows has to go out first - the discovery pass is an improvement
    // on that answer, not a precondition for it.
    const rig = panelOn('opencode-go/omen-alpha', ANSWERS, { refreshMs: 3000 });
    const done = rig.requestModels();
    await vi.advanceTimersByTimeAsync(0);
    expect(rig.optionsCount(), 'no model list went out before the refresh').toBeGreaterThan(0);
    const early = rig.optionsCount();
    await vi.advanceTimersByTimeAsync(5000);
    await done;
    // And again once discovery has actually found something.
    expect(rig.optionsCount()).toBeGreaterThan(early);
  });

  it('re-posts every session status after the refresh, so a late list is not a silent one', async () => {
    // The engine rebuilt its provider list, which is what `modelStatus`
    // ultimately reads its model name out of. Nothing re-posted it, so a pane
    // that mounted before the rebuild kept the pre-rebuild verdict until some
    // unrelated event pushed again.
    const rig = panelOn('opencode-go/omen-alpha', ANSWERS, { refreshMs: 3000 });
    const done = rig.requestModels();
    await vi.advanceTimersByTimeAsync(0);
    expect(rig.statusCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    await done;
    expect(rig.statusCount()).toBeGreaterThan(0);
  });
});

describe('the liveness probe landing', () => {
  beforeEach(() => { providers = { ...OWNER_PROVIDERS }; vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('repaints the pane that mounted while the cache was still empty', async () => {
    // The pane's first `modelStatus` is drawn from an EMPTY providerStatusCache
    // (ok:false, no model name), because the probe it kicks has not answered
    // yet. The gauge is only honest again if that verdict is replaced when the
    // probe lands - which is what broadcastProviderStatus's trailing repaint is
    // for, and what this pins.
    const rig = panelOn('opencode-go/omen-alpha', ANSWERS);
    rig.reload();
    expect(rig.latestStatus()?.ok, 'the first paint is honestly unknown').toBe(false);
    await vi.advanceTimersByTimeAsync(30000);
    expect(rig.latestStatus()?.ok).toBe(true);
    expect(rig.latestStatus()?.modelName).toBe('omen-alpha');
  });

  it('is not held open by an engine that never answers provider_auth_list', async () => {
    // HARDENING, from the first reading of this bug. `oauthConnectedIds` was
    // awaited OUTSIDE probeConcurrently - the one place every other provider
    // call is bounded - so an unanswered auth read held the WHOLE broadcast:
    // no providerStatus post, no repaint, and no further probe ever, because
    // the stale kick latches `providerProbeInFlight` on a promise that never
    // settles. The gateway's own probe does not consult that store at all and
    // still went down with it.
    const rig = panelOn('opencode-go/omen-alpha', UNANSWERED);
    rig.reload();
    expect(rig.probeLatched(), 'the reload must actually kick a probe').toBe(true);
    await vi.advanceTimersByTimeAsync(30000);
    expect(rig.providerRows().find((r) => r.id === 'opencode-go')?.live, 'the gateway probe never ran').toBe(true);
    expect(rig.latestStatus()?.ok).toBe(true);
    expect(rig.probeLatched(), 'the latch never cleared, so no later tick could repair anything').toBe(false);
  });

  it('still calls an unanswerable OAuth block "checking", never "not configured"', async () => {
    // The bound must not buy a settled broadcast by inventing a verdict: a
    // store that could not be asked stays neutral (no alarm banner), uncached,
    // and is asked again on the next tick.
    const rig = panelOn('openai/gpt-5.6-sol', UNANSWERED);
    rig.reload();
    await vi.advanceTimersByTimeAsync(30000);
    expect(rig.latestStatus()?.reason).toBe('Checking provider…');
    expect(rig.providerRows().find((r) => r.id === 'openai')?.live).toBe(false);
  });

  it('reports a signed-in ChatGPT block live, exactly as before the bound', async () => {
    const rig = panelOn('openai/gpt-5.6-sol', ANSWERS);
    rig.reload();
    await vi.advanceTimersByTimeAsync(30000);
    expect(rig.providerRows().find((r) => r.id === 'openai')?.live).toBe(true);
    expect(rig.latestStatus()?.ok).toBe(true);
    expect(rig.latestStatus()?.modelName).toBe('gpt-5.6-sol');
  });
});

describe('a model whose provider the global config does not list', () => {
  beforeEach(() => { providers = {}; vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('is not reported offline, and is not queued for a probe that can never run', async () => {
    // broadcastProviderStatus probes exactly the ids origami.json holds, so
    // this id can never get a cache row. Reading that permanent absence as "not
    // live" put an alarm on a chat the extension simply cannot see, and
    // re-queued it on every broadcast forever.
    const rig = panelOn('some-engine-catalog/sonnet-4', ANSWERS);
    rig.reload();
    await vi.advanceTimersByTimeAsync(30000);
    expect(rig.latestStatus()?.ok).toBe(true);
    expect(rig.latestStatus()?.reason).toBeNull();
    expect(rig.probeLatched(), 'an unprobeable provider must not kick a probe').toBeFalsy();
  });
});
