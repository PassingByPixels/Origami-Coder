// elasticWindow.ts — t-w2qv3o: the ONE activity tracker per VS Code window, and the window-wide facts
// it reads: is the sidebar chat view visible, which chat the phone is on, and which engines said a
// turn runs. The rules live in activityClass.ts / activityTracker.ts; this file is wiring.

import * as vscode from 'vscode';
import * as os from 'node:os';
import { ActivityTracker, type ElasticClient, type ElasticSettings } from './activityTracker';
import { engineViews, wakeOnScreen, type PanelSignals, type WindowSignals } from './sessionSignals';
import { parkHostEngine, type HostParkClient } from './hostPark';

export const ELASTIC_SECTION = 'origamicoder.elastic';
export const ELASTIC_CHANNEL = 'Origami Elastic';
const MINUTE = 60_000;

/** Minutes from a setting, bounded: a value under `min` (or not a number) falls back to the default. */
function minutes(c: { get<T>(key: string): T | undefined }, key: string, fallback: number, min = 1): number {
  const v = c.get<number>(key);
  return (typeof v === 'number' && Number.isFinite(v) && v >= min ? v : fallback) * MINUTE;
}

/** Read fresh on every pass, so a change takes effect without a reload. ON by default; a host with
 *  no settings store reads the defaults (same rule as engineEnv.ts codeModeEnabled). */
export function readElasticSettings(): ElasticSettings {
  let c: { get<T>(key: string): T | undefined };
  try {
    c = vscode.workspace.getConfiguration(ELASTIC_SECTION);
  } catch {
    c = { get: () => undefined };
  }
  return {
    enabled: c.get<boolean>('enabled') !== false,
    idleAfterMs: minutes(c, 'idleAfterMinutes', 5),
    trimAfterMs: minutes(c, 'trimAfterMinutes', 0, 0), // 0: the trim goes out when the engine turns idle
    retrimMs: minutes(c, 'retrimMinutes', 10),
    // t-w2txb2: 0 turns parking off. The untimed delay never goes below the timed one. t-ze0hwh: both default 20.
    parkAfterMs: minutes(c, 'parkAfterMinutes', 20, 0),
    parkUntimedAfterMs: Math.max(minutes(c, 'parkUntimedAfterMinutes', 20, 0), minutes(c, 'parkAfterMinutes', 20, 0)),
  };
}

/** Windows only: a parent may set its own child's priority class (libuv SetPriorityClass). macOS cannot
 *  undo the engine's own PRIO_DARWIN_BG from outside, so there the engine's message is the only path. */
export function raiseFromOutside(pid: number, cls: 'active' | 'background' | 'idle', platform = process.platform, set = os.setPriority): void {
  if (platform !== 'win32' || cls === 'idle') return;
  try {
    set(pid, cls === 'active' ? os.constants.priority.PRIORITY_NORMAL : os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {
    // gone, or not ours: the class message still goes out
  }
}

let channel: vscode.OutputChannel | undefined;
/** The "Origami Elastic" channel; park.ts / parkHost.ts log here too (t-w2txb2). */
export function elasticLog(line: string): void {
  try {
    (channel ??= vscode.window.createOutputChannel(ELASTIC_CHANNEL)).appendLine(`${new Date().toISOString()} ${line}`);
  } catch {
    console.warn(`[origami] ${line}`); // a host with no output channels (a test harness)
  }
}

export const elastic = new ActivityTracker({
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
  settings: readElasticSettings,
  log: elasticLog,
  raise: raiseFromOutside,
});

let chatView: { readonly visible: boolean } | null = null;
let sidebarFocus = false;
let sidebarChat: string | null = null;
let phone: string | null = null;
const engineBusy = new WeakMap<object, boolean>();

export const windowSignals: WindowSignals = {
  sidebarVisible: () => chatView?.visible === true,
  sidebarFocused: () => sidebarFocus,
  sidebarChat: () => sidebarChat,
  phoneFocus: () => phone,
  engineBusy: (client) => engineBusy.get(client) === true,
};

/** Something the classes read may have changed. Cheap: one pass per 250 ms at most. */
export function pokeElastic(): void {
  elastic.poke();
}

const settled = new Set<() => void>();
/** t-w2u2ki: called when an engine's turn ends (busy -> idle). The warm spare's replacement waits for it. */
export function onTurnSettled(listener: () => void): { dispose(): void } {
  settled.add(listener);
  return { dispose: () => { settled.delete(listener); } };
}

/** The host copy of `origami/sessionStatus` (sessionStatusRoute.ts): anything but `idle` is a turn. */
export function noteEngineStatus(client: object, status: string): void {
  const wasBusy = engineBusy.get(client) === true;
  engineBusy.set(client, status !== 'idle');
  elastic.poke();
  if (wasBusy && status === 'idle') for (const listener of settled) listener();
}

/** The chat the paired phone is on; null when no phone is there (remoteController.ts). */
export function setPhoneFocus(sessionId: string | null): void {
  if (phone === sessionId) return;
  phone = sessionId;
  elastic.poke();
}

/** t-x3a89j: the sidebar chat webview gained or lost keyboard focus (its `chatFocus` post, sidebarFocus.ts). In grid
 *  mode this decides whether the sidebar's active chat is the one the user works in. */
export function setSidebarFocus(focused: boolean): void {
  if (sidebarFocus === focused) return;
  sidebarFocus = focused;
  elastic.poke();
}

/** t-xp0dzr: the chat the sidebar webview DISPLAYS (its `sidebarChat` post), null when it displays none (the
 *  launcher: Chats list, Settings, History). Not the host's selected chat (activeSessionId). */
export function setSidebarChat(sessionId: string | null): void {
  if (sidebarChat === sessionId) return;
  sidebarChat = sessionId;
  elastic.poke();
}

/** The sidebar chat view (ChatViewProvider.ts). Its visibility is one input of "the chat you work in". */
export function watchChatView(view: {
  readonly visible: boolean;
  onDidChangeVisibility(listener: () => void): { dispose(): unknown };
  onDidDispose(listener: () => void): { dispose(): unknown };
}): void {
  chatView = view;
  sidebarChat = null; // t-xp0dzr: a new page has not said what it displays yet
  const vis = view.onDidChangeVisibility(() => elastic.poke());
  const gone = view.onDidDispose(() => {
    if (chatView === view) { chatView = null; sidebarFocus = false; sidebarChat = null; }
    vis.dispose();
    gone.dispose();
    elastic.poke();
  });
  elastic.poke();
}

type HostEngineClient = ElasticClient & HostParkClient & { readonly pid?: number };
type HostSide = { ownClient(): HostEngineClient | undefined; stopOwn(client: HostEngineClient): void };
let host: HostSide | null = null;
/** t-wdyi2t: the idle host engine is stopped, and the next host read starts it again (hostPark.ts). */
const hostPark = () => (host ? parkHostEngine(host, { log: elasticLog }) : Promise.resolve('no host engine'));

/** The panel whose chats the tracker reads (the newest, as in ActivityTracker.attach). */
let attached: PanelSignals | null = null;
/** A panel's chats (DashboardPanel constructor), plus the window's host engine when it runs. t-wy2jj3: a parked
 *  chat on screen starts again in the pass that sees it (one pass per 250 ms at most after a poke). */
export function attachPanelElastic(panel: PanelSignals): { dispose(): void } {
  attached = panel;
  const sub = elastic.attach({ engines: () => engineViews(panel, windowSignals, host?.ownClient(), hostPark), wake: () => wakeOnScreen(panel, windowSignals, elasticLog) });
  return { dispose: () => { if (attached === panel) attached = null; sub.dispose(); } };
}

/** t-xmulzj: a chat turn runs now: the host awaits a prompt, or the engine said it runs one. The warm spare
 *  does not start next to it (warmSpare.ts refresh). */
export function chatTurnRunning(): boolean {
  for (const s of attached?.sessions() ?? []) if (s.turnBusy === true || windowSignals.engineBusy(s.client)) return true;
  return false;
}

/** Activation: the host engine is tracked with or without a panel, a settings change is read at once,
 *  and the tracker goes with the window. */
export function activateElastic(context: { subscriptions: Array<{ dispose(): unknown }> }, hostEngine: HostSide): void {
  host = hostEngine;
  elastic.setBase({ engines: () => engineViews(null, windowSignals, hostEngine.ownClient(), hostPark) });
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration(ELASTIC_SECTION)) elastic.poke(); }),
    { dispose: () => elastic.dispose() },
  );
}
