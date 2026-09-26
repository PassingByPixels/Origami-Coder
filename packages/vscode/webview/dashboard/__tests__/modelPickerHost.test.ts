// modelPickerHost.test.ts — what the host posts to the model picker, through the REAL
// DashboardPanel (the claudeSubscriptionStatusLine.test.ts harness) with fake engine
// clients. Nothing is sent to any model; the Claude CLI discovery is mocked (the real one
// writes a hand-off file into ~/.origami).
//
// t-y5ecbj, owner UAT of 0.4.179 (subscription ready, spare off): the picker showed
// Claude (Sub)/claude-fable-5-1[1m], /Fable (ticked: the chat's saved pick
// `claude-subscription/fable`), /Haiku, /Opus, /opus[1m].

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

vi.mock('../../../src/dashboard/claudeCodeManager', async (orig) => ({
  ...(await orig() as Record<string, unknown>),
  claudeCli: async () => ({ binary: 'C:/fake/claude.exe', version: '2.1.282', source: 'path' }),
}));

import { DashboardPanel } from '../../../src/dashboard/DashboardPanel';
import { DeltaFanout } from '../../../src/dashboard/deltaFanout';
import { resetClaudeSubscriptionStatusCache } from '../../../src/claudeSubscription/engineStatus';
import { resetPickerReads } from '../../../src/dashboard/pickerReads';

type Post = Record<string, unknown>;
type Option = { value: string; name: string };
type ModelOption = { current: string; options: Option[] } | null;

interface FakeChat {
  id: string;
  gate?: { current: string };
  /** The engine's session model list; null until the engine has answered its session. */
  option: ModelOption;
  /** Every host call this chat's engine received. */
  asked: string[];
  answer: (m: string) => Promise<Record<string, unknown>>;
}

function chat(id: string, option: ModelOption, answer: FakeChat['answer'], gate?: string): FakeChat {
  return { id, option, answer, asked: [], ...(gate ? { gate: { current: gate } } : {}) };
}

function panelWith(chats: FakeChat[], activeId: string) {
  const posts: Post[] = [];
  const p = Object.create(DashboardPanel.prototype) as Record<string, unknown>;
  Object.defineProperty(p, 'cwd', { value: process.cwd() });
  const sessions = new Map<string, unknown>();
  chats.forEach((c, i) => {
    const client = {
      extMethod: (m: string) => { c.asked.push(m); return c.answer(m); },
      getModelOption: () => c.option,
    };
    sessions.set(c.id, {
      id: c.id, number: i + 1, agentName: 'Tsuru', messageLog: [], turnBusy: false,
      pendingPermissions: new Map(), modelWindow: 0, modelWindowFor: '', client, ...(c.gate ? { gate: c.gate } : {}),
    });
  });
  p['sessions'] = sessions;
  p['activeSessionId'] = activeId;
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
  const call = (name: string) => (p[name] as () => Promise<void>).call(p);
  return {
    posts,
    modelOptions: () => posts.filter((m) => m.type === 'modelOptions').pop()?.options as Array<Option & { covers?: string[] }> | undefined,
    providerStatus: () => posts.filter((m) => m.type === 'providerStatus').pop()?.providers as Array<{ id: string; live: boolean }> | undefined,
    requestModels: () => call('broadcastModelOptions'),
    requestProviderStatus: () => call('broadcastProviderStatus'),
    /** What the chat's start does once its engine has answered (DashboardPanel createSession). */
    engineUp: () => (p['broadcastModelStatus'] as () => void).call(p),
  };
}

const READY = async (m: string) =>
  m === 'claude_subscription_status' ? { state: 'ready', version: '2.1.282', path: 'C:/fake/claude.exe' } : {};
const sub = (id: string, name: string): Option => ({ value: `claude-subscription/${id}`, name: `Claude (Sub)/${name}` });

/** origami.json's claude-subscription block: the vision overrides read from the owner's
 *  config on 2026-09-23 (claude-subscription-config.test.ts) plus two picks persisted by
 *  writeModelConfig as `name: <id>`. */
const OWNER_BLOCK = {
  'claude-subscription': {
    name: 'LM Studio',
    models: {
      opus: { attachment: true }, sonnet: { attachment: true }, haiku: { attachment: true, name: 'haiku' }, fable: { attachment: true },
      'claude-fable-5-1[1m]': { name: 'claude-fable-5-1[1m]' }, 'opus[1m]': { name: 'opus[1m]' },
    },
  },
};

describe('t-y5ecbj: the Claude (Sub) rows the host posts', () => {
  beforeEach(() => { providers = { ...OWNER_BLOCK }; resetClaudeSubscriptionStatusCache(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('the UAT engine list: each model once, readable names, and the saved `fable` pick is on the Fable row', async () => {
    const uat = [
      sub('claude-fable-5-1[1m]', 'claude-fable-5-1[1m]'), sub('fable', 'Fable'), sub('haiku', 'Haiku'),
      sub('opus', 'Opus'), sub('opus[1m]', 'opus[1m]'), sub('sonnet', 'Sonnet'),
    ];
    const rig = panelWith([chat('session-1', { current: 'claude-subscription/fable', options: uat }, READY)], 'session-1');
    void rig.requestModels();
    await vi.advanceTimersByTimeAsync(50);
    const rows = (rig.modelOptions() ?? []).filter((r) => r.value.startsWith('claude-subscription/'));
    expect(rows.map((r) => r.name)).toEqual([
      'Claude (Sub)/Fable (1M context)', 'Claude (Sub)/Haiku', 'Claude (Sub)/Opus (1M context)', 'Claude (Sub)/Sonnet',
    ]);
    for (const r of rows) expect(r.name).not.toMatch(/\[1m\]|claude-fable/);
    expect(rows[0]!.covers).toEqual(['claude-subscription/fable']);
  });
});

// t-y5ecbc, owner UAT of 0.4.179: a new chat's picker said "Loading models…" for 4-5 s
// (warm spare on or off) while the composer said "Starting engine". The picker draws that
// row until its first `providerStatus` lands (NoConnections.svelte), and its rows come
// from `modelOptions`. Both posts waited on the NEW chat's engine, which answers nothing
// until it has booted: `modelOptions` on its Claude (Sub) Gate B read (since t-tija5f,
// already on origami-v0.4.175), and `providerStatus` on the same read since 0.4.179
// (569a17de52, t-xu5oty) and on the OAuth store read when a keyless block exists.
describe('t-y5ecbc: a new chat\'s picker gets a list at once, and its own when its engine is up', () => {
  const NEVER = () => new Promise<Record<string, unknown>>(() => {});
  const OLDER_LIST = { current: 'openai/gpt-5', options: [{ value: 'openai/gpt-5', name: 'OpenAI/GPT-5' }, { value: 'openai/engine-only', name: 'OpenAI/engine-only' }, sub('sonnet', 'Sonnet')] };
  beforeEach(() => {
    // An OAuth block (no key, no URL) makes the provider pass read the auth store first.
    providers = { ...OWNER_BLOCK, openai: { name: 'OpenAI', models: { 'gpt-5': {} } } };
    resetClaudeSubscriptionStatusCache();
    resetPickerReads();
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('while the new chat\'s engine starts: the model list goes at once, the one another chat already holds; no chat is asked', async () => {
    const older = chat('session-1', OLDER_LIST, READY);
    const fresh = chat('session-2', null, NEVER, 'starting');
    const rig = panelWith([older, fresh], 'session-2');
    void rig.requestModels();
    await vi.advanceTimersByTimeAsync(50);
    expect(rig.modelOptions()?.map((r) => r.value)).toEqual(expect.arrayContaining(['openai/engine-only', 'claude-subscription/sonnet']));
    // The hidden chat is read from memory only; the starting engine is not queued a call it cannot answer yet.
    expect(older.asked).toEqual([]);
    expect(fresh.asked).toEqual([]);
  });

  it('while the new chat\'s engine starts: the provider list goes at once; no chat is asked', async () => {
    const older = chat('session-1', OLDER_LIST, READY);
    const fresh = chat('session-2', null, NEVER, 'starting');
    const rig = panelWith([older, fresh], 'session-2');
    void rig.requestProviderStatus();
    await vi.advanceTimersByTimeAsync(50);
    expect(rig.providerStatus()?.map((r) => r.id)).toEqual(['openai']);
    expect(older.asked).toEqual([]);
    expect(fresh.asked).toEqual([]);
  });

  it('the first chat of a window (no other list yet): the configured list at once, not a wait', async () => {
    const fresh = chat('session-1', null, NEVER, 'starting');
    const rig = panelWith([fresh], 'session-1');
    void rig.requestModels();
    void rig.requestProviderStatus();
    await vi.advanceTimersByTimeAsync(50);
    expect(rig.modelOptions()?.map((r) => r.value)).toEqual(expect.arrayContaining(['openai/gpt-5']));
    expect(rig.providerStatus()).toBeDefined();
  });

  it('the only chat was closed, then a new one started: the last list seen in this window, at once', async () => {
    const first = panelWith([chat('session-1', OLDER_LIST, READY)], 'session-1');
    void first.requestModels();
    await vi.advanceTimersByTimeAsync(50);
    const rig = panelWith([chat('session-2', null, NEVER, 'starting')], 'session-2');
    void rig.requestModels();
    await vi.advanceTimersByTimeAsync(50);
    expect(rig.modelOptions()?.map((r) => r.value)).toEqual(expect.arrayContaining(['openai/engine-only', 'claude-subscription/sonnet']));
  });

  it('no active chat at all: the list is seeded from origami.json as before, not a remembered one', async () => {
    const first = panelWith([chat('session-1', OLDER_LIST, READY)], 'session-1');
    void first.requestModels();
    await vi.advanceTimersByTimeAsync(50);
    const rig = panelWith([], '');
    void rig.requestModels();
    await vi.advanceTimersByTimeAsync(50);
    expect(rig.modelOptions()?.map((r) => r.value)).toContain('openai/gpt-5');
    expect(rig.modelOptions()?.map((r) => r.value)).not.toContain('openai/engine-only');
  });

  it('when the chat\'s own engine is up the list is its own, and only now is that engine asked', async () => {
    const older = chat('session-1', OLDER_LIST, READY);
    const fresh = chat('session-2', null, NEVER, 'starting');
    const rig = panelWith([older, fresh], 'session-2');
    void rig.requestModels();
    await vi.advanceTimersByTimeAsync(50);
    fresh.option = { current: 'claude-subscription/haiku', options: [{ value: 'openai/o5', name: 'OpenAI/o5' }, sub('haiku', 'Haiku')] };
    fresh.answer = READY;
    rig.engineUp();
    await vi.advanceTimersByTimeAsync(50);
    expect(rig.modelOptions()?.map((r) => r.value)).toEqual(expect.arrayContaining(['openai/o5', 'claude-subscription/haiku']));
    expect(rig.modelOptions()?.map((r) => r.value)).not.toContain('openai/gpt-5');
    expect(fresh.asked).toContain('claude_subscription_status');
    expect(older.asked).toEqual([]);
  });
});
