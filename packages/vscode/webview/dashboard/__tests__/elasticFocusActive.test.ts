// elasticFocusActive.test.ts — t-x3a89j (epic t-w1r73y, Elastic E12): the chat you are WORKING IN is active,
// not every chat the sidebar shows. The owner keeps the sidebar open in grid mode all day as a console. Before
// this ticket every grid tile of a visible sidebar counted as on screen (sessionSignals.ts onScreen), so no chat
// ever went idle, trimmed or parked, and restore-on-show (t-wy2jj3) would restore every parked tile at once.
//
// The rule under test (src/elastic/sessionSignals.ts inFocus):
//   active = the sidebar's active chat while the sidebar is visible AND (it is the single-chat view OR the
//            sidebar webview has keyboard focus: `chatFocus` from the webview), OR the chat's editor tab is the
//            ACTIVE editor (WebviewPanel.active), OR the phone is on it.
//   A visible grid tile, or a visible but not active editor tab, is treated like a hidden chat.
// The bugs each block catches: a grid tile counted active; a restore started by a tile being visible; a
// visible-but-unfocused editor tab counted active; the sidebar focus flag left set after the view closes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('vscode', () => ({
  workspace: { getConfiguration: () => ({ get: () => undefined }), onDidChangeConfiguration: () => ({ dispose: () => undefined }) },
  window: { createOutputChannel: () => ({ appendLine: () => undefined }) },
}));

import { ActivityTracker, type ElasticSettings } from '../../../src/elastic/activityTracker';
import { chatSignals, engineViews, wakeOnScreen, type PanelSignals, type SignalSession, type WindowSignals } from '../../../src/elastic/sessionSignals';
import * as elasticWindow from '../../../src/elastic/elasticWindow';
import { engineAnswered } from '../../../src/dashboard/pickerReads';

const MIN = 60_000;
const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** A chat engine that answers the elastic wire: idle report parkable, trims succeed. */
class FakeEngine {
  calls: string[] = [];
  async extMethod(method: string): Promise<Record<string, unknown>> {
    this.calls.push(method);
    if (method === '_elastic_idle_report') return { parkable: true, reasons: [] };
    if (method === '_elastic_trim') return { trimmed: true };
    return {};
  }
}

type Chat = SignalSession & { client: FakeEngine; gate: { current: string; whenUp: ReturnType<typeof vi.fn> } };

function chat(id: string, n: number, stage = 'ready'): Chat {
  const c: Chat = {
    id, number: n, kind: 'chat', client: new FakeEngine(),
    gate: { current: stage, whenUp: vi.fn(async () => { c.gate.current = 'ready'; return true; }) },
    pendingPermissions: { size: 0 }, runningChildren: { size: 0 },
  };
  return c;
}

/** The window as the owner uses it: the sidebar chat view visible, in grid mode. */
function console_(chats: Chat[], over: { grid?: boolean; active?: string | null; focused?: boolean; visible?: boolean; phone?: string | null; tabs?: Record<string, { visible: boolean; active: boolean }> } = {}) {
  const state = { grid: over.grid ?? true, active: over.active === undefined ? chats[0]!.id : over.active, focused: over.focused ?? true, visible: over.visible ?? true, phone: over.phone ?? null, tabs: over.tabs ?? {} };
  const panel: PanelSignals = {
    sessions: () => chats,
    activeId: () => state.active,
    grid: () => state.grid,
    solo: (id) => state.tabs[id],
    question: () => false,
  };
  const win: WindowSignals = {
    sidebarVisible: () => state.visible,
    sidebarFocused: () => state.focused,
    sidebarChat: () => state.active, // t-xp0dzr: the sidebar webview displays its active chat (grid: the active tile)
    phoneFocus: () => state.phone,
    engineBusy: () => false,
  };
  return { state, panel, win };
}

const activeIds = (chats: Chat[], panel: PanelSignals, win: WindowSignals) => chats.filter((c) => chatSignals(c, panel, win).onScreen).map((c) => c.id);

describe('which chat is active (pure)', () => {
  const chats = [chat('c1', 1), chat('c2', 2), chat('c3', 3), chat('c4', 4)];

  it('grid console, sidebar visible and focused: ONLY the focused tile is active, not every tile', () => {
    const { panel, win } = console_(chats, { active: 'c2' });
    expect(activeIds(chats, panel, win)).toEqual(['c2']);
  });

  it('grid console, focus elsewhere (the editor, another window): NO tile is active', () => {
    const { panel, win } = console_(chats, { active: 'c2', focused: false });
    expect(activeIds(chats, panel, win)).toEqual([]);
  });

  it('the single-chat sidebar view counts its chat as the one you work in while it is visible, focused or not', () => {
    const { panel, win, state } = console_(chats, { grid: false, active: 'c3', focused: false });
    expect(activeIds(chats, panel, win)).toEqual(['c3']);
    state.visible = false;
    expect(activeIds(chats, panel, win)).toEqual([]);
  });

  it('an editor tab counts only while it is the ACTIVE editor; a visible tab in another group does not', () => {
    const { panel, win, state } = console_(chats, { visible: false, tabs: { c4: { visible: true, active: false } } });
    expect(activeIds(chats, panel, win)).toEqual([]);
    state.tabs.c4 = { visible: true, active: true };
    expect(activeIds(chats, panel, win)).toEqual(['c4']);
  });

  it('the phone chat is active wherever the sidebar is', () => {
    const { panel, win } = console_(chats, { focused: false, phone: 'c3' });
    expect(chats.filter((c) => chatSignals(c, panel, win).phone).map((c) => c.id)).toEqual(['c3']);
  });
});

describe('the grid console under the real tracker (fake clock): tiles go background, idle, trimmed, parked', () => {
  let settings: ElasticSettings;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    settings = { enabled: true, idleAfterMs: 5 * MIN, trimAfterMs: 0, retrimMs: 10 * MIN, parkAfterMs: 60 * MIN, parkUntimedAfterMs: 120 * MIN };
  });
  afterEach(() => vi.useRealTimers());

  it('with the sidebar visible in grid mode and 4 chats, only the focused one stays active; the others idle, trim and park by the usual rules', async () => {
    const chats = [chat('c1', 1), chat('c2', 2), chat('c3', 3), chat('c4', 4)];
    const { panel, win } = console_(chats, { active: 'c1' });
    const parked: string[] = [];
    panel.park = async (id) => { parked.push(id); chats.find((c) => c.id === id)!.gate.current = 'parked'; return null; };
    const tracker = new ActivityTracker({ setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>), now: () => Date.now(), settings: () => settings, log: () => undefined });
    tracker.attach({ engines: () => engineViews(panel, win, undefined), wake: () => wakeOnScreen(panel, win) });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(chats.map((c) => tracker.classOf(c.client))).toEqual(['active', 'background', 'background', 'background']);
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(chats.map((c) => tracker.classOf(c.client))).toEqual(['active', 'idle', 'idle', 'idle']);
    expect(chats.map((c) => c.client.calls.includes('_elastic_trim'))).toEqual([false, true, true, true]);
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(parked.sort()).toEqual(['c2', 'c3', 'c4']);
    expect(chats[0]!.gate.current).toBe('ready');
    // Parked tiles are not restored by being visible: no pass wakes them.
    tracker.poke();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(chats.map((c) => c.gate.whenUp.mock.calls.length)).toEqual([0, 0, 0, 0]);
    tracker.dispose();
  });

  it('a visible tile that holds work (a question waits, a turn runs) is background, never idle or parked, until the work ends', async () => {
    const chats = [chat('c1', 1), chat('c2', 2), chat('c3', 3)];
    const { panel, win } = console_(chats, { active: 'c1' });
    const asks = new Set(['c2']);
    panel.question = (id) => asks.has(id);
    chats[2]!.turnBusy = true;
    const parked: string[] = [];
    panel.park = async (id) => { parked.push(id); chats.find((c) => c.id === id)!.gate.current = 'parked'; return null; };
    const tracker = new ActivityTracker({ setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>), now: () => Date.now(), settings: () => settings, log: () => undefined });
    tracker.attach({ engines: () => engineViews(panel, win, undefined), wake: () => wakeOnScreen(panel, win) });
    await vi.advanceTimersByTimeAsync(90 * MIN);
    expect(chats.map((c) => tracker.classOf(c.client))).toEqual(['active', 'background', 'background']);
    expect(parked).toEqual([]);
    asks.clear();
    chats[2]!.turnBusy = false;
    tracker.poke();
    await vi.advanceTimersByTimeAsync(6 * MIN);
    expect(chats.map((c) => tracker.classOf(c.client))).toEqual(['active', 'idle', 'idle']);
    tracker.dispose();
  });
});

describe('restore starts on FOCUS of a parked chat, never because it is visible', () => {
  it('a grid of 10 parked chats restores none until one is focused; then only that one, then the next tile clicked', () => {
    const chats = Array.from({ length: 10 }, (_, i) => chat(`c${i}`, i, 'parked'));
    const { panel, win, state } = console_(chats, { active: 'c3', focused: false });
    wakeOnScreen(panel, win);
    expect(chats.filter((c) => c.gate.whenUp.mock.calls.length > 0)).toEqual([]);
    state.focused = true; // the user clicks into the sidebar: the active tile c3
    wakeOnScreen(panel, win);
    expect(chats.filter((c) => c.gate.whenUp.mock.calls.length > 0).map((c) => c.id)).toEqual(['c3']);
    state.active = 'c7'; // a click on tile c7 (activeSessionChanged)
    wakeOnScreen(panel, win);
    expect(chats.filter((c) => c.gate.whenUp.mock.calls.length > 0).map((c) => c.id)).toEqual(['c3', 'c7']);
  });

  it('an editor tab that is visible but not the active editor does not restore; focusing it does', () => {
    const chats = [chat('c1', 1, 'parked')];
    const { panel, win, state } = console_(chats, { visible: false, tabs: { c1: { visible: true, active: false } } });
    wakeOnScreen(panel, win);
    expect(chats[0]!.gate.whenUp).not.toHaveBeenCalled();
    state.tabs.c1 = { visible: true, active: true };
    wakeOnScreen(panel, win);
    expect(chats[0]!.gate.whenUp).toHaveBeenCalledTimes(1);
  });

  it('the phone opening a parked chat restores it, sidebar focused or not', () => {
    const chats = [chat('c1', 1, 'parked'), chat('c2', 2, 'parked')];
    const { panel, win } = console_(chats, { active: 'c1', focused: false, phone: 'c2' });
    wakeOnScreen(panel, win);
    expect(chats.map((c) => c.gate.whenUp.mock.calls.length)).toEqual([0, 1]);
  });
});

describe('the sidebar focus input (elasticWindow.ts)', () => {
  let pokes = 0;
  beforeEach(() => {
    pokes = 0;
    vi.spyOn(elasticWindow.elastic, 'poke').mockImplementation(() => void pokes++);
  });
  afterEach(() => vi.restoreAllMocks());

  it('setSidebarFocus is read live, pokes the tracker only on a change, and is cleared when the chat view closes', () => {
    const gone: Array<() => void> = [];
    elasticWindow.watchChatView({ visible: true, onDidChangeVisibility: () => ({ dispose: () => undefined }), onDidDispose: (l) => { gone.push(l); return { dispose: () => undefined }; } });
    expect(elasticWindow.windowSignals.sidebarFocused()).toBe(false);
    const before = pokes;
    elasticWindow.setSidebarFocus(true);
    expect(elasticWindow.windowSignals.sidebarFocused()).toBe(true);
    expect(pokes).toBe(before + 1);
    elasticWindow.setSidebarFocus(true);
    expect(pokes).toBe(before + 1);
    for (const l of gone) l();
    expect(elasticWindow.windowSignals.sidebarFocused()).toBe(false);
  });
});

describe('DashboardPanel wiring (source guards: the panel cannot be built in a unit test)', () => {
  const src = readFileSync(path.join(pkg, 'src/dashboard/DashboardPanel.ts'), 'utf8');
  it('the sidebar webview`s `chatFocus` post sets the window focus input', () => {
    expect(src).toMatch(/if \(m\.type === 'chatFocus'\) \{ setSidebarFocus\(m\.focused === true\); return; \}/);
  });
  it('the model-picker readiness read skips a parked active chat (a picker mounting in a visible tile must not restore it)', () => {
    // t-xu5oty: the read moved into claudeSubscriptionReadiness() (bounded; the status line reads it too).
    expect(src).toMatch(/const readiness = !enabled \? undefined : await this\.claudeSubscriptionReadiness\(\);/);
    // t-y5ecbc: the test moved into engineAnswered() (pickerReads.ts), which also skips a chat whose engine is still starting.
    expect(src).toMatch(/!engineAnswered\(active\) \? lastClaudeSubscriptionReadiness\(\) \?\? readinessFromCli\(await claudeCli\(\)\) : fetchClaudeSubscriptionReadiness\(active!\.client\)/);
    const list = () => ({ current: 'claude-subscription/haiku', options: [] });
    expect(engineAnswered({ gate: { current: 'parked' }, client: { getModelOption: list } })).toBe(false);
    expect(engineAnswered({ gate: { current: 'ready' }, client: { getModelOption: list } })).toBe(true);
  });
});
