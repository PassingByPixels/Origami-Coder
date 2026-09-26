// t-xoenfh (owner UAT of 0.4.178) — a host call the user did not cause must not pull an idle chat back to
// background. The REAL AcpClient.extMethod (acpClient.ts, which stamps `lastExtAt`), the real
// sessionSignals.engineViews wiring and the real ActivityTracker run here; only the engine connection is a fake.
// The bugs each block catches:
//
// - opening a new chat (or a Folds agent's tab) fans `provider_refresh` out to EVERY chat engine
//   (providerRefresh.ts, over DashboardPanel.engineRefreshTargets), and every idle chat goes
//   `idle -> background`, waits a full idle period again, and is trimmed and parked late;
// - one host read routed to a hidden chat (DashboardPanel.engineClient: the active or the first chat) does
//   the same to that chat;
// - changing an Engines setting while such a call lands restarts the chat's quiet clock, so its park moves;
// - the fix going too far: a message, a question, an engine turn or the phone must still move a chat out of idle.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  workspace: { getConfiguration: () => ({ get: () => undefined }), onDidChangeConfiguration: () => ({ dispose: () => undefined }) },
  window: { createOutputChannel: () => ({ appendLine: () => undefined }) },
}));

import { AcpClient, type AcpEventHandlers } from '../../../src/acpClient';
import { ActivityTracker, EVALUATE_DEBOUNCE_MS, type ElasticSettings } from '../../../src/elastic/activityTracker';
import { engineViews, type PanelSignals, type SignalSession } from '../../../src/elastic/sessionSignals';
import { refreshEngineProviders } from '../../../src/dashboard/providerRefresh';

const MIN = 60_000;

/** A real AcpClient on a fake connection: every ext call goes through AcpClient.extMethod, stamp and all. */
function chatClient(calls: string[]): AcpClient {
  const client = new AcpClient({} as AcpEventHandlers);
  const connection = {
    extMethod: async (method: string) => {
      calls.push(method);
      if (method === '_elastic_idle_report') return { parkable: true, reasons: [] };
      if (method === '_elastic_trim') return { trimmed: true, workingSetBefore: 0, workingSetAfter: 0 };
      return {};
    },
  };
  (client as unknown as { connection: unknown }).connection = connection;
  return client;
}

type Chat = SignalSession & { client: AcpClient; calls: string[] };

function world() {
  const chats: Chat[] = [1, 2, 3].map((n) => {
    const calls: string[] = [];
    return { id: `session-${n}`, number: n, client: chatClient(calls), calls, gate: { current: 'ready' }, pendingPermissions: { size: 0 }, runningChildren: { size: 0 } };
  });
  let phone: string | null = null;
  const busy = new Set<object>();
  const parked: string[] = [];
  const question = new Set<string>();
  const panel: PanelSignals = {
    sessions: () => chats,
    activeId: () => 'session-1',
    grid: () => false,
    solo: () => undefined,
    question: (id) => question.has(id),
    park: async (id) => { parked.push(id); return 'kept for the test'; },
  };
  // Every chat hidden: the sidebar is not visible, displays no chat, and no chat has an editor tab. Not annotated, so the
  // fixture fits WindowSignals with and without lane A's `sidebarChat` (t-xp0dzr).
  const win = { sidebarVisible: () => false, sidebarFocused: () => false, sidebarChat: (): string | null => null, phoneFocus: () => phone, engineBusy: (c: object) => busy.has(c) };
  const log: string[] = [];
  const tracker = new ActivityTracker({
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
    settings: () => settings,
    log: (l) => void log.push(l),
  });
  tracker.attach({ engines: () => engineViews(panel, win, undefined) });
  const classes = () => chats.map((c) => tracker.classOf(c.client));
  return { chats, tracker, log, classes, parked, question, busy, setPhone: (id: string | null) => { phone = id; } };
}

let settings: ElasticSettings;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  settings = { enabled: true, idleAfterMs: 5 * MIN, trimAfterMs: 0, retrimMs: 10 * MIN, parkAfterMs: 60 * MIN, parkUntimedAfterMs: 120 * MIN };
});
afterEach(() => vi.useRealTimers());

/** Three hidden chats, quiet since the first pass, all idle once the idle delay has run. */
async function idleWorld() {
  const w = world();
  await vi.advanceTimersByTimeAsync(EVALUATE_DEBOUNCE_MS);
  await vi.advanceTimersByTimeAsync(5 * MIN);
  expect(w.classes()).toEqual(['idle', 'idle', 'idle']);
  w.log.length = 0;
  return w;
}

describe('t-xoenfh: host calls the user did not cause leave idle chats idle', () => {
  it('the provider_refresh fan-out to every chat engine (a picker, pane or new tab asking requestModels) moves no chat out of idle', async () => {
    const w = await idleWorld();
    await refreshEngineProviders(w.chats.map((c) => ({ client: c.client, cwd: 'C:/work' })));
    expect(w.chats.every((c) => c.calls.includes('_provider_refresh'))).toBe(true); // the call did reach every engine
    w.tracker.poke();
    await vi.advanceTimersByTimeAsync(EVALUATE_DEBOUNCE_MS);
    expect(w.classes()).toEqual(['idle', 'idle', 'idle']);
    expect(w.log.filter((l) => l.includes('idle -> background'))).toEqual([]);
  });

  it('a host read routed to one hidden chat (engineClient: provider_auth_list, claude_subscription_status, artifact_list ...) leaves it idle', async () => {
    const w = await idleWorld();
    for (const m of ['provider_auth_list', 'claude_subscription_status', 'artifact_list']) await w.chats[0]!.client.extMethod(m, {});
    w.tracker.poke();
    await vi.advanceTimersByTimeAsync(EVALUATE_DEBOUNCE_MS);
    expect(w.classes()).toEqual(['idle', 'idle', 'idle']);
  });

  it('an Engines setting changed while such a call lands: the chat stays idle and its quiet clock is not restarted (the park comes on time)', async () => {
    const w = await idleWorld(); // quiet since ~t0; now t0 + 5 min
    await vi.advanceTimersByTimeAsync(MIN); // t0 + 6 min
    await w.chats[0]!.client.extMethod('provider_auth_list', {});
    settings = { ...settings, parkAfterMs: 8 * MIN }; // the owner lowers parkAfterMinutes; the window pokes on the change
    w.tracker.poke();
    await vi.advanceTimersByTimeAsync(EVALUATE_DEBOUNCE_MS);
    expect(w.classes()).toEqual(['idle', 'idle', 'idle']);
    await vi.advanceTimersByTimeAsync(2 * MIN); // t0 + 8 min: 8 min of quiet since t0, not since the call
    expect(w.parked).toContain('session-1');
  });
});

describe('t-xoenfh: real activity in an idle chat still moves it out of idle', () => {
  it('a message (host turn), a question, an engine-reported turn (a tool runs) and the phone each wake their chat', async () => {
    const w = await idleWorld();
    const [a, b, c] = w.chats as [Chat, Chat, Chat];
    a.turnBusy = true; // the user sent a message
    w.question.add(b.id); // the engine asks the user a question
    w.busy.add(c.client); // origami/sessionStatus busy: a turn with tool calls runs in the engine
    w.tracker.poke();
    await vi.advanceTimersByTimeAsync(EVALUATE_DEBOUNCE_MS);
    expect(w.classes()).toEqual(['background', 'background', 'background']);
    a.turnBusy = false; w.question.delete(b.id); w.busy.delete(c.client);
    w.setPhone(a.id); // the paired phone opens chat 1
    w.tracker.poke();
    await vi.advanceTimersByTimeAsync(EVALUATE_DEBOUNCE_MS);
    expect(w.tracker.classOf(a.client)).toBe('active');
  });
});
