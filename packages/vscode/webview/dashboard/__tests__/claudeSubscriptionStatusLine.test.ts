// t-xu5oty. Owner UAT of 0.4.178: a chat on claude-subscription/haiku ran its
// turns, but the line under the composer said "Checking claude-subscription…"
// for good.
//
// ROOT CAUSE (host only; no engine is asked, so it is not the elastic build:
// the same three pieces are on origami-v0.4.175). The line is the chat's
// `modelStatus` reason. sessionModelStatus reads a remote provider's liveness
// from providerStatusCache and calls it `known` when origami.json has a block
// for it. A `claude-subscription` block exists as soon as a vision override is
// written for one of its models (a models-only block, no name). But
// broadcastProviderStatus strips that block before it probes (the connection
// draws its own tile, t-ty02bb), so no row is EVER cached for it: every
// broadcast reads "known, never probed" -> ok:false, reason "Checking
// provider…", label = the bare id, and kicks one more probe that skips it again.
//
// Driven through the REAL DashboardPanel (the pillsMountRace.test.ts harness)
// with a fake engine client. Nothing is sent to any model.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

let providers: Record<string, unknown> = {};

vi.mock('../../../src/dashboard/firstFold', async (orig) => ({
  ...(await orig() as Record<string, unknown>),
  readGlobalProviders: () => providers,
  detectLocalProvider: () => undefined,
  detectModel: () => '',
}));

vi.mock('../../../src/claudeSubscriptionFlag', async (orig) => ({
  ...(await orig() as Record<string, unknown>),
  claudeSubscriptionEnabled: () => true,
}));

import { DashboardPanel } from '../../../src/dashboard/DashboardPanel';
import { DeltaFanout } from '../../../src/dashboard/deltaFanout';
import { resetClaudeSubscriptionStatusCache } from '../../../src/claudeSubscription/engineStatus';

/** The block a vision override on a subscription model writes: models only, no name. */
const VISION_BLOCK = { 'claude-subscription': { models: { haiku: { attachment: true, modalities: { input: ['text', 'image'] } } } } };

type Post = Record<string, unknown>;

function panelOn(current: string, extMethod: (m: string) => Promise<Record<string, unknown>>) {
  const posts: Post[] = [];
  const asked: string[] = [];
  const p = Object.create(DashboardPanel.prototype) as Record<string, unknown>;
  Object.defineProperty(p, 'cwd', { value: process.cwd() });
  const sessions = new Map<string, unknown>();
  const client = {
    extMethod: (m: string) => { asked.push(m); return extMethod(m); },
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
  p['deltaFanout'] = new DeltaFanout((id) => sessions.has(id));
  p['pendingQuestionPermissions'] = new Map();
  p['context'] = {
    extensionUri: { fsPath: process.cwd() },
    extension: { packageJSON: { version: 'harness' } },
    globalState: { get: <T>(_k: string, d: T) => d, update: () => Promise.resolve() },
    workspaceState: { get: <T>(_k: string, d: T) => d, update: () => Promise.resolve() },
  };
  p['modelInfo'] = { ok: false, modelId: '', contextLength: 0, reason: 'no model loaded' };
  p['providerStatusCache'] = new Map();
  p['panel'] = { webview: { postMessage: (m: Post) => { posts.push(m); return Promise.resolve(true); } } };
  p['broadcastConfigSelectors'] = () => undefined;
  p['resolveEngineUrl'] = () => '';
  const statuses = () => posts.filter((m) => m.type === 'modelStatus');
  return {
    asked,
    latestStatus: () => statuses().pop(),
    providerRows: () => (posts.filter((m) => m.type === 'providerStatus').pop()?.providers ?? []) as Array<{ id: string }>,
    probeLatched: () => p['providerProbeInFlight'] as boolean,
    reload: () => (p['broadcastModelStatus'] as () => void).call(p),
  };
}

const READY = async (m: string) =>
  m === 'claude_subscription_status' ? { state: 'ready', version: '2.1.282', path: 'C:/x/claude.exe' } : {};
const NOT_SIGNED_IN = async (m: string) => (m === 'claude_subscription_status' ? { state: 'not-logged-in' } : {});
const NEVER = (m: string) =>
  m === 'claude_subscription_status' ? new Promise<Record<string, unknown>>(() => {}) : Promise.resolve({});

describe('the status line of a Claude (subscription) chat (t-xu5oty)', () => {
  beforeEach(() => { providers = { ...VISION_BLOCK }; resetClaudeSubscriptionStatusCache(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('ready: the line resolves (no "Checking…"), from the chat engine\'s own Gate B answer', async () => {
    const rig = panelOn('claude-subscription/haiku', READY);
    rig.reload();
    await vi.advanceTimersByTimeAsync(30000);
    const status = rig.latestStatus()!;
    expect(status.reason).not.toBe('Checking provider…');
    expect(status.ok).toBe(true);
    expect(status.modelName).toBe('haiku');
    expect(rig.asked).toContain('claude_subscription_status');
    // The connection keeps its own tile: no provider row is added for it.
    expect(rig.providerRows().some((r) => r.id === 'claude-subscription')).toBe(false);
  });

  it('not ready: a clear error text with the fix, named "Claude (Sub)", not the bare id', async () => {
    const rig = panelOn('claude-subscription/haiku', NOT_SIGNED_IN);
    rig.reload();
    await vi.advanceTimersByTimeAsync(30000);
    const status = rig.latestStatus()!;
    expect(status.ok).toBe(false);
    expect(status.reason).toMatch(/Not logged in/);
    expect(status.providerLabel).toBe('Claude (Sub)');
  });

  it('an engine that never answers: an error text within the probe bound, and the latch clears', async () => {
    const rig = panelOn('claude-subscription/haiku', NEVER);
    rig.reload();
    await vi.advanceTimersByTimeAsync(30000);
    const status = rig.latestStatus()!;
    expect(status.ok).toBe(false);
    expect(status.reason).not.toBe('Checking provider…');
    expect(String(status.reason)).toMatch(/did not answer/);
    expect(rig.probeLatched()).toBe(false);
  });
});
