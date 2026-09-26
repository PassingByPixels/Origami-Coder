// t-w2qv3o — the inputs the activity classes read: the sidebar chat view's visibility, a chat's
// editor tab, grid mode, the phone, the engine's own busy report, and the phone focus the remote
// shaper reports (src/elastic/sessionSignals.ts, elasticWindow.ts, remote/remoteOutbound.ts). The bugs
// each block catches:
//
// - a chat counted "on screen" because it is the ACTIVE tab while the sidebar is hidden (the old
//   `isSessionMounted` proxy), so a hidden chat is never lowered;
// - a solo tab behind another tab counted as on screen (no onDidChangeViewState);
// - the sidebar hidden or shown without the tracker hearing it;
// - a phone that moves between chats, or goes away, without the tracker hearing it;
// - a host engine that is never tracked, so it never goes idle.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('vscode', () => ({
  workspace: { getConfiguration: () => ({ get: () => undefined }), onDidChangeConfiguration: () => ({ dispose: () => undefined }) },
  window: { createOutputChannel: () => ({ appendLine: () => undefined }) },
}));

import { chatSignals, engineViews, type PanelSignals, type SignalSession } from '../../../src/elastic/sessionSignals';
import { elastic, noteEngineStatus, raiseFromOutside, readElasticSettings, setPhoneFocus, setSidebarChat, setSidebarFocus, watchChatView, windowSignals } from '../../../src/elastic/elasticWindow';
import { spawn } from 'node:child_process';
import * as os from 'node:os';
import { RemoteOutbound } from '../../../src/remote/remoteOutbound';

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (rel: string) => readFileSync(path.join(pkg, rel), 'utf8');

let pokes = 0;

function session(id: string, extra: Partial<SignalSession> = {}): SignalSession {
  return { id, client: { extMethod: async () => ({}) }, gate: { current: 'ready' }, pendingPermissions: { size: 0 }, runningChildren: { size: 0 }, ...extra };
}

function panel(p: Partial<PanelSignals> & { list: SignalSession[] }): PanelSignals {
  return {
    sessions: () => p.list,
    activeId: p.activeId ?? (() => p.list[0]?.id ?? null),
    grid: p.grid ?? (() => false),
    solo: p.solo ?? (() => undefined),
    question: p.question ?? (() => false),
  };
}

/** A WebviewView-shaped fake that emits visibility changes. */
function fakeView() {
  const vis: Array<() => void> = [];
  const gone: Array<() => void> = [];
  return {
    visible: false,
    onDidChangeVisibility: (l: () => void) => { vis.push(l); return { dispose: () => undefined }; },
    onDidDispose: (l: () => void) => { gone.push(l); return { dispose: () => undefined }; },
    show(v: boolean) { this.visible = v; for (const l of vis) l(); },
    close() { for (const l of gone) l(); },
  };
}

beforeEach(() => {
  pokes = 0;
  vi.spyOn(elastic, 'poke').mockImplementation(() => void pokes++);
});

describe('the sidebar chat view (onDidChangeVisibility)', () => {
  it('its visibility is read live and every change pokes the tracker; a closed view is hidden', () => {
    const v = fakeView();
    watchChatView(v);
    setSidebarChat('session-1'); // t-xp0dzr: the sidebar webview displays session-1
    const s = session('session-1');
    const p = panel({ list: [s] });
    expect(chatSignals(s, p, windowSignals).onScreen).toBe(false);
    const before = pokes;
    v.show(true);
    expect(pokes).toBe(before + 1);
    expect(chatSignals(s, p, windowSignals).onScreen).toBe(true);
    v.show(false);
    expect(chatSignals(s, p, windowSignals).onScreen).toBe(false);
    v.show(true);
    v.close();
    expect(windowSignals.sidebarVisible()).toBe(false);
  });

  it('with the sidebar visible only the ACTIVE chat is on screen; in grid mode only while the sidebar has focus (t-x3a89j: a tile is not "on screen")', () => {
    const v = fakeView();
    watchChatView(v);
    setSidebarChat('session-1'); // t-xp0dzr: the sidebar webview displays session-1 (grid: its active tile)
    v.show(true);
    const a = session('session-1');
    const b = session('session-2');
    expect([a, b].map((s) => chatSignals(s, panel({ list: [a, b] }), windowSignals).onScreen)).toEqual([true, false]);
    expect([a, b].map((s) => chatSignals(s, panel({ list: [a, b], grid: () => true }), windowSignals).onScreen)).toEqual([false, false]);
    setSidebarFocus(true);
    expect([a, b].map((s) => chatSignals(s, panel({ list: [a, b], grid: () => true }), windowSignals).onScreen)).toEqual([true, false]);
    v.close();
  });
});

describe('a chat editor tab (panel.active, onDidChangeViewState)', () => {
  it('a tab that is hidden, or visible but not the active editor, does not count; the active editor tab does (t-x3a89j)', () => {
    const s = session('session-2');
    let tab = { visible: false, active: false };
    const p = panel({ list: [session('session-1'), s], solo: (id) => (id === 'session-2' ? tab : undefined) });
    expect(chatSignals(s, p, windowSignals).onScreen).toBe(false);
    tab = { visible: true, active: false };
    expect(chatSignals(s, p, windowSignals).onScreen).toBe(false);
    tab = { visible: true, active: true };
    expect(chatSignals(s, p, windowSignals).onScreen).toBe(true);
  });

  it('DashboardPanel pokes the tracker when a tab is shown, hidden or closed; the sidebar view is watched (source guards)', () => {
    const src = read('src/dashboard/DashboardPanel.ts');
    expect(src).toMatch(/panel\.onDidChangeViewState\(\(\) => pokeElastic\(\)\);/);
    expect(src).toMatch(/panel\.onDidDispose\(\(\) => \{\s*pokeElastic\(\);/);
    expect(read('src/sidebar/ChatViewProvider.ts')).toMatch(/watchChatView\(webviewView\);/);
  });
});

describe('work signals and the host copy of sessionStatus', () => {
  it('each work input is read off the session', () => {
    const s = session('session-1', { turnBusy: true, pendingPermissions: { size: 1 }, runningChildren: { size: 2 }, loopSchedule: { stopped: false } });
    expect(chatSignals(s, panel({ list: [s] }), windowSignals)).toMatchObject({ turnBusy: true, pendingAsk: true, runningChildren: true, loopArmed: true });
    const q = session('session-2', { loopSchedule: { stopped: true } });
    expect(chatSignals(q, panel({ list: [q], question: () => true }), windowSignals)).toMatchObject({ pendingAsk: true, loopArmed: false });
  });

  it("engineBusy follows the engine's last report for THAT client: busy and retry are busy, idle is not", () => {
    const s = session('session-1');
    const p = panel({ list: [s] });
    noteEngineStatus(s.client, 'busy');
    expect(chatSignals(s, p, windowSignals).engineBusy).toBe(true);
    noteEngineStatus(s.client, 'retry');
    expect(chatSignals(s, p, windowSignals).engineBusy).toBe(true);
    noteEngineStatus(s.client, 'idle');
    expect(chatSignals(s, p, windowSignals).engineBusy).toBe(false);
    expect(chatSignals(session('session-9'), p, windowSignals).engineBusy).toBe(false);
  });
});

describe('the phone', () => {
  it('setPhoneFocus marks that chat, pokes once per real move, and null clears it', () => {
    const a = session('session-1');
    const b = session('session-2');
    const p = panel({ list: [a, b] });
    const before = pokes;
    setPhoneFocus('session-2');
    setPhoneFocus('session-2');
    expect(pokes).toBe(before + 1);
    expect([a, b].map((s) => chatSignals(s, p, windowSignals).phone)).toEqual([false, true]);
    setPhoneFocus(null);
    expect(chatSignals(b, p, windowSignals).phone).toBe(false);
  });

  it('RemoteOutbound reports every move of its focus, and only real moves', () => {
    const moves: Array<string | null> = [];
    const out = new RemoteOutbound({ send: async () => undefined, clock: { setTimer: () => ({}), clearTimer: () => undefined }, onFocus: (f) => void moves.push(f) });
    void out.send({ type: 'restoreActiveSession', sessionId: 'session-1' }); // the host's active chat: the phone mounts it
    out.notePhone({ type: 'prompt', sessionId: 'session-2' }); // the phone acts in chat 2
    out.notePhone({ type: 'prompt', sessionId: 'session-2' }); // same chat: no move
    out.notePhone({ type: 'closeSession', sessionId: 'session-2' }); // back to the host's active chat
    out.forget(); // a hydration: nothing confirmed, still the host's active chat, so no move
    expect(moves).toEqual(['session-1', 'session-2', 'session-1']);
  });

  it('the controller reports the focus only while the relay says the phone is present, and the window feeds the tracker (source guards)', () => {
    const ctl = read('src/remote/remoteController.ts');
    expect(ctl).toMatch(/onFocus: \(\) => this\.tellFocus\(\)/);
    expect(ctl).toMatch(/this\.peer\.presence === 'present' \? this\.shaper\.focus : null/);
    expect(read('src/remote/activate.ts')).toMatch(/onPhoneFocus: setPhoneFocus,/);
  });
});

describe('engine views', () => {
  it('every chat plus the running host engine; a starting chat is not ready; the host engine is never on screen', () => {
    const host = { extMethod: async () => ({}), lastExtAt: 1234 };
    const a = session('session-1', { gate: { current: 'starting' }, kind: 'agent', number: 3 });
    const views = engineViews(panel({ list: [a] }), windowSignals, host);
    expect(views.map((v) => [v.label, v.ready])).toEqual([['agent 3 · kind Folds agent · engine session (none yet)', false], ['host engine', true]]); // t-xoenz1: the label names kind, pid and engine session
    expect(views[1]!.signals).toMatchObject({ onScreen: false, phone: false, lastActivityAt: 1234 });
    expect(engineViews(null, windowSignals, undefined)).toEqual([]);
  });
});

describe('settings (origamicoder.elastic.*)', () => {
  it('ON by default: idle after 5 min, trim at once when idle, re-trim every 10 min, when nothing is set', () => {
    expect(readElasticSettings()).toEqual({ enabled: true, idleAfterMs: 5 * 60_000, trimAfterMs: 0, retrimMs: 10 * 60_000, parkAfterMs: 20 * 60_000, parkUntimedAfterMs: 20 * 60_000 }); // t-ze0hwh: park after 20 min, timed and untimed provider alike
  });

  it('package.json declares all four with those defaults and a description each', () => {
    const props = JSON.parse(read('package.json')).contributes.configuration.properties as Record<string, { default: unknown; description?: string }>;
    expect(props['origamicoder.elastic.enabled']?.default).toBe(true);
    expect(props['origamicoder.elastic.idleAfterMinutes']?.default).toBe(5);
    expect(props['origamicoder.elastic.trimAfterMinutes']?.default).toBe(0);
    expect(props['origamicoder.elastic.retrimMinutes']?.default).toBe(10);
    expect(props['origamicoder.elastic.parkAfterMinutes']?.default).toBe(20); // t-ze0hwh
    expect(props['origamicoder.elastic.parkUntimedAfterMinutes']?.default).toBe(20);
    for (const k of ['enabled', 'idleAfterMinutes', 'trimAfterMinutes', 'retrimMinutes']) {
      expect(props[`origamicoder.elastic.${k}`]?.description?.length ?? 0).toBeGreaterThan(40);
    }
  });
});

describe('raiseFromOutside (Windows: a parent may set the priority class of its own child)', () => {
  it('maps active to NORMAL and background to BELOW_NORMAL, never sets idle, does nothing off Windows, and swallows a gone pid', () => {
    const calls: Array<[number, number]> = [];
    const set = (pid: number, p: number) => void calls.push([pid, p]);
    raiseFromOutside(7, 'active', 'win32', set);
    raiseFromOutside(7, 'background', 'win32', set);
    raiseFromOutside(7, 'idle', 'win32', set);
    raiseFromOutside(7, 'active', 'darwin', set);
    expect(calls).toEqual([[7, os.constants.priority.PRIORITY_NORMAL], [7, os.constants.priority.PRIORITY_BELOW_NORMAL]]);
    expect(() => raiseFromOutside(7, 'active', 'win32', () => { throw new Error('ESRCH'); })).not.toThrow();
  });

  it.runIf(process.platform === 'win32')('on this OS: a child lowered to IDLE is back at NORMAL after the call (read back with os.getPriority)', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore', windowsHide: true });
    try {
      await new Promise((r) => child.once('spawn', r));
      const pid = child.pid!;
      os.setPriority(pid, os.constants.priority.PRIORITY_LOW); // what the engine does to itself for the idle class
      expect(os.getPriority(pid)).toBe(os.constants.priority.PRIORITY_LOW);
      raiseFromOutside(pid, 'active');
      expect(os.getPriority(pid)).toBe(os.constants.priority.PRIORITY_NORMAL);
    } finally {
      child.kill();
    }
  });
});
