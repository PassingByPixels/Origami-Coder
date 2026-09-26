// elasticSidebarShows.test.ts — t-xp0dzr (owner UAT of 0.4.178): which chat counts as on screen through the
// sidebar. Before this ticket, inFocus read the HOST's selected chat (DashboardPanel.activeSessionId). That id is
// set by createSession (a new chat, a history recall) and never by a chat that is popped out to its own tab, and
// Settings does not clear it. In the owner's layout (sidebar always open, chats in editor tabs) one chat was
// always stuck `active`: chat 14 for 17 minutes, then chat 16.
//
// The rule under test (src/elastic/sessionSignals.ts inFocus):
//   - the sidebar counts a chat only while the sidebar is visible AND its webview DISPLAYS that chat (the
//     `sidebarChat` post, elasticWindow.setSidebarChat). The sidebar launcher (Chats list, Settings, History)
//     displays no chat, so it makes no chat active.
//   - a chat with its own editor tab counts through that tab only (the focused editor).
//   - grid: only the displayed tile, and only while the sidebar has focus (unchanged, t-x3a89j).
// The bugs each block catches: the host's selection kept a hidden chat active; a popped-out chat kept active by the
// sidebar; the UAT repro (recall, pop out, focus another editor: no `active -> background` line); a displayed-chat
// value left over after the sidebar view closes or loads again; the webview side not reporting what it shows.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('vscode', () => ({
  workspace: { getConfiguration: () => ({ get: () => undefined }), onDidChangeConfiguration: () => ({ dispose: () => undefined }) },
  window: { createOutputChannel: () => ({ appendLine: () => undefined }) },
}));

import { ActivityTracker, type ElasticSettings } from '../../../src/elastic/activityTracker';
import { chatSignals, engineViews, wakeOnScreen, type PanelSignals, type SignalSession } from '../../../src/elastic/sessionSignals';
import * as elasticWindow from '../../../src/elastic/elasticWindow';
import { DESK_REFUSALS } from '../../../src/remote/deskRefusals';
import { reportSidebarChat } from '../panes/sidebarFocus';

const MIN = 60_000;
const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (rel: string) => readFileSync(path.join(pkg, rel), 'utf8');

class FakeEngine {
  calls: string[] = [];
  async extMethod(method: string): Promise<Record<string, unknown>> {
    this.calls.push(method);
    if (method === '_elastic_idle_report') return { parkable: false, reasons: ['test'] };
    return {};
  }
}

type Chat = SignalSession & { client: FakeEngine };
const chat = (id: string, n: number): Chat => ({ id, number: n, kind: 'chat', client: new FakeEngine(), gate: { current: 'ready', whenUp: async () => true }, pendingPermissions: { size: 0 }, runningChildren: { size: 0 } });

type Tab = { visible: boolean; active: boolean };
/** DashboardPanel as the tracker reads it: `selected` is the HOST's activeSessionId, `tabs` its sessionPanels. */
function panelOf(chats: Chat[], state: { selected: string | null; grid?: boolean; tabs: Record<string, Tab> }): PanelSignals {
  return { sessions: () => chats, activeId: () => state.selected, grid: () => state.grid === true, solo: (id) => state.tabs[id], question: () => false };
}

/** A WebviewView-shaped fake for elasticWindow.watchChatView. */
function sidebarView(visible: boolean) {
  const gone: Array<() => void> = [];
  const v = { visible, onDidChangeVisibility: () => ({ dispose: () => undefined }), onDidDispose: (l: () => void) => { gone.push(l); return { dispose: () => undefined }; }, close: () => { for (const l of gone) l(); } };
  elasticWindow.watchChatView(v);
  return v;
}

const onScreen = (chats: Chat[], panel: PanelSignals) => chats.filter((c) => chatSignals(c, panel, elasticWindow.windowSignals).onScreen).map((c) => c.id);

let views: Array<{ close(): void }> = [];
beforeEach(() => { vi.spyOn(elasticWindow.elastic, 'poke').mockImplementation(() => undefined); views = []; });
afterEach(() => { for (const v of views) v.close(); vi.restoreAllMocks(); });

describe('the sidebar counts only the chat its webview displays', () => {
  it('the sidebar launcher (Chats list, Settings, History) displays no chat: the host-selected chat is NOT on screen while the sidebar is visible', () => {
    views.push(sidebarView(true));
    const chats = [chat('c14', 14), chat('c2', 2)];
    const panel = panelOf(chats, { selected: 'c14', tabs: {} });
    expect(onScreen(chats, panel)).toEqual([]);
  });

  it('a sidebar that displays a chat keeps it active while visible (single view); a hidden sidebar does not', () => {
    const v = sidebarView(true);
    views.push(v);
    const chats = [chat('c1', 1), chat('c3', 3)];
    const panel = panelOf(chats, { selected: 'c1', tabs: {} });
    elasticWindow.setSidebarChat('c3');
    expect(onScreen(chats, panel)).toEqual(['c3']);
    elasticWindow.setSidebarChat(null); // the sidebar goes to Settings
    expect(onScreen(chats, panel)).toEqual([]);
    v.visible = false;
    elasticWindow.setSidebarChat('c3');
    expect(onScreen(chats, panel)).toEqual([]);
  });

  it('grid (unchanged rule): only the displayed tile, and only while the sidebar has focus', () => {
    views.push(sidebarView(true));
    const chats = [chat('c1', 1), chat('c2', 2), chat('c3', 3)];
    const panel = panelOf(chats, { selected: 'c1', grid: true, tabs: {} });
    elasticWindow.setSidebarChat('c2');
    elasticWindow.setSidebarFocus(false);
    expect(onScreen(chats, panel)).toEqual([]);
    elasticWindow.setSidebarFocus(true);
    expect(onScreen(chats, panel)).toEqual(['c2']);
    elasticWindow.setSidebarFocus(false);
  });
});

describe('a popped-out chat counts through its own editor tab only', () => {
  it('its sidebar selection or display never makes it active; its tab being the focused editor does', () => {
    views.push(sidebarView(true));
    const chats = [chat('c14', 14)];
    const state = { selected: 'c14' as string | null, tabs: { c14: { visible: true, active: false } } as Record<string, Tab> };
    const panel = panelOf(chats, state);
    elasticWindow.setSidebarChat('c14');
    expect(onScreen(chats, panel)).toEqual([]);
    state.tabs.c14 = { visible: true, active: true };
    expect(onScreen(chats, panel)).toEqual(['c14']);
  });

  it('a parked popped-out chat is not restored by its sidebar selection, only by focusing its tab', () => {
    views.push(sidebarView(true));
    const c = chat('c14', 14);
    c.gate = { current: 'parked', whenUp: vi.fn(async () => true) };
    const state = { selected: 'c14' as string | null, tabs: { c14: { visible: true, active: false } } as Record<string, Tab> };
    const panel = panelOf([c], state);
    wakeOnScreen(panel, elasticWindow.windowSignals);
    expect(c.gate.whenUp).not.toHaveBeenCalled();
    state.tabs.c14 = { visible: true, active: true };
    wakeOnScreen(panel, elasticWindow.windowSignals);
    expect(c.gate.whenUp).toHaveBeenCalledTimes(1);
  });
});

describe('UAT repro under the real tracker (fake clock)', () => {
  let settings: ElasticSettings;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    settings = { enabled: true, idleAfterMs: 5 * MIN, trimAfterMs: 0, retrimMs: 10 * MIN, parkAfterMs: 0, parkUntimedAfterMs: 0 };
  });
  afterEach(() => vi.useRealTimers());

  it('recall chat 14, pop it out, focus another editor: `chat 14: active -> background` within one pass; the next new chat (16) does the same', async () => {
    views.push(sidebarView(true)); // the owner's sidebar: always open, showing the launcher
    const chats = [chat('c14', 14)];
    const state = { selected: 'c14' as string | null, tabs: {} as Record<string, Tab> }; // createSession for the recall selected it
    const panel = panelOf(chats, state);
    const lines: string[] = [];
    const tracker = new ActivityTracker({ setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>), now: () => Date.now(), settings: () => settings, log: (l) => lines.push(l) });
    tracker.attach({ engines: () => engineViews(panel, elasticWindow.windowSignals, undefined), wake: () => wakeOnScreen(panel, elasticWindow.windowSignals) });
    state.tabs.c14 = { visible: true, active: true }; // popped out: its tab is the focused editor
    tracker.poke();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(tracker.classOf(chats[0]!.client)).toBe('active');
    state.tabs.c14 = { visible: true, active: false }; // the owner focuses another editor tab (onDidChangeViewState pokes)
    tracker.poke();
    await vi.advanceTimersByTimeAsync(300);
    expect(tracker.classOf(chats[0]!.client)).toBe('background');
    expect(lines).toContain('[elastic] chat 14 · kind chat · engine session (none yet): active -> background'); // t-xoenz1 label
    // Chat 16: a new chat on the spare, used only through its own tab `Tsuru #16`.
    chats.push(chat('c16', 16));
    state.selected = 'c16';
    state.tabs.c16 = { visible: true, active: true };
    tracker.poke();
    await vi.advanceTimersByTimeAsync(300);
    expect(tracker.classOf(chats[1]!.client)).toBe('active');
    state.tabs.c16 = { visible: true, active: false };
    tracker.poke();
    await vi.advanceTimersByTimeAsync(300);
    expect(chats.map((c) => tracker.classOf(c.client))).toEqual(['background', 'background']);
    tracker.dispose();
  });
});

describe('the displayed-chat input (elasticWindow.ts)', () => {
  it('pokes the tracker only on a change, and is cleared when the view closes and when a view is resolved again', () => {
    vi.restoreAllMocks();
    let pokes = 0;
    vi.spyOn(elasticWindow.elastic, 'poke').mockImplementation(() => void pokes++);
    const v = sidebarView(true);
    const before = pokes;
    elasticWindow.setSidebarChat('c1');
    expect(elasticWindow.windowSignals.sidebarChat()).toBe('c1');
    expect(pokes).toBe(before + 1);
    elasticWindow.setSidebarChat('c1');
    expect(pokes).toBe(before + 1);
    v.close();
    expect(elasticWindow.windowSignals.sidebarChat()).toBeNull();
    elasticWindow.setSidebarChat('c1');
    views.push(sidebarView(true)); // a new webview has not reported what it shows yet
    expect(elasticWindow.windowSignals.sidebarChat()).toBeNull();
  });

  it('the phone may not set the desk sidebar display (named refusal)', () => {
    expect(DESK_REFUSALS).toContain('sidebarChat');
  });
});

describe('the webview side (panes/sidebarFocus.ts reportSidebarChat)', () => {
  it('reports the displayed chat at once, and null when it stops displaying it (the next chat, or unmount)', () => {
    const posts: Array<string | null> = [];
    const stop = reportSidebarChat('c3', (id) => posts.push(id));
    expect(posts).toEqual(['c3']);
    stop();
    expect(posts).toEqual(['c3', null]);
  });
});

describe('wiring (source guards: the panel and the sidebar ChatPane cannot be built here)', () => {
  it('DashboardPanel sets the displayed chat from the sidebar webview`s `sidebarChat` post', () => {
    expect(read('src/dashboard/DashboardPanel.ts')).toMatch(/if \(m\.type === 'sidebarChat'\) \{ setSidebarChat\(typeof m\.sessionId === 'string' \? m\.sessionId : null\); return; \}/);
  });
  it('only a sidebar ChatPane (not a solo tab) reports what it displays', () => {
    expect(read('webview/dashboard/panes/ChatPane.svelte')).toMatch(/\$effect\(\(\) => \(soloSessionId \? undefined : reportSidebarChat\(activeSessionId, /);
  });
});
