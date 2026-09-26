// sessionSignals.ts — t-w2qv3o: DashboardPanel's chats (and the window's host engine) read as the
// tracker's engine views. No vscode here: the panel hands in plain readers, so a test drives it with
// objects. DashboardPanel.ts is at its line cap; this is the logic, the panel only wires it.
//
// Active = the chat the user WORKS IN (t-x3a89j, owner 2026-09-25; it replaces "on screen", scope A section 2):
// the chat the sidebar DISPLAYS (t-xp0dzr) while the sidebar is visible and it is the single-chat view or the sidebar has
// keyboard focus (grid mode: the owner keeps the grid open all day as a console), OR its editor tab is the
// ACTIVE editor. A tile that is only visible, or a visible tab that is not the active editor, counts as hidden.
// The phone counts too: a chat open on the phone is active (owner decision 2026-09-24).

import { QUIET, type EngineSignals } from './activityClass';
import type { ElasticClient, EngineView } from './activityTracker';
import { HOST_PARK_AFTER_MS } from './hostPark';
import { engineLabel } from './engineLabel';

/** The slice of DashboardPanel's `Session` this reads. */
export interface SignalSession {
  id: string;
  number?: number;
  kind?: 'chat' | 'agent';
  /** t-xoenz1 (engineLabel.ts): a persistent /loop on a session with no chat tab. */
  headlessLoop?: boolean;
  client: ElasticClient & { readonly pid?: number; readonly currentSessionId?: string | null };
  /** `whenUp` (EngineGate): on a parked gate it starts the restore, the same as a message (t-wy2jj3). */
  gate: { current: string; whenUp?(): Promise<boolean> };
  turnBusy?: boolean;
  pendingPermissions: { size: number };
  runningChildren: { size: number };
  loopSchedule?: { stopped: boolean };
}

export interface PanelSignals {
  sessions(): Iterable<SignalSession>;
  /** The host's selected chat (activeSessionId). t-xp0dzr: NOT "on screen"; onScreenClient only prefers it. */
  activeId(): string | null;
  grid(): boolean;
  /** The chat's own editor tab, if it has one (`DashboardPanel.sessionPanels`). t-x3a89j: `active` (the focused
   *  editor) is what counts; `visible` alone does not. */
  solo(id: string): { visible: boolean; active?: boolean } | undefined;
  /** A question waits for this chat (`pendingQuestionPermissions`). */
  question(id: string): boolean;
  /** t-w2txb2: stop this chat's engine on purpose (elastic/park.ts); null = parked, else why not. */
  park?(id: string): Promise<string | null>;
  /** t-wdyi2t: a finished Folds chat that parks as soon as no view shows it (ParkHost.parkSoon). */
  parkSoon?(id: string): boolean;
  /** t-wypna7: the window's reload reopen loop runs (each new chat is the active one for a moment): start nothing yet. */
  booting?(): boolean;
}

/** Window-wide facts, owned by elasticWindow.ts. */
export interface WindowSignals {
  sidebarVisible(): boolean;
  /** t-x3a89j: the sidebar chat webview has keyboard focus (its `chatFocus` post). */
  sidebarFocused(): boolean;
  /** t-xp0dzr: the chat the sidebar webview displays (its `sidebarChat` post); null = none (launcher, Settings). */
  sidebarChat(): string | null;
  phoneFocus(): string | null;
  /** The engine's last `origami/sessionStatus` for this client said a turn runs. */
  engineBusy(client: object): boolean;
}

/** t-x3a89j: this is the chat the user works in (the phone aside). The classifier's `onScreen` input is this.
 *  t-xp0dzr: a chat with its own editor tab counts through that tab only; the sidebar counts the chat its webview
 *  DISPLAYS, never the host's selected chat (`activeId`: set by a new chat or a recall, not by a popped-out one). */
export function inFocus(s: SignalSession, panel: PanelSignals, win: WindowSignals): boolean {
  const tab = panel.solo(s.id);
  if (tab) return tab.active === true;
  return win.sidebarVisible() && win.sidebarChat() === s.id && (!panel.grid() || win.sidebarFocused());
}

export function chatSignals(s: SignalSession, panel: PanelSignals, win: WindowSignals): EngineSignals {
  return {
    onScreen: inFocus(s, panel, win),
    phone: win.phoneFocus() === s.id,
    turnBusy: s.turnBusy === true,
    engineBusy: win.engineBusy(s.client),
    pendingAsk: s.pendingPermissions.size > 0 || panel.question(s.id),
    runningChildren: s.runningChildren.size > 0,
    loopArmed: !!s.loopSchedule && !s.loopSchedule.stopped,
    // t-xoenfh: a host call to a chat engine is not activity in that chat. Most are calls the user did not cause
    // there (the provider_refresh fan-out to every chat, a host read routed to the active or first chat, a settings
    // push), and each one restarted the quiet clock of every idle chat it reached. What the user does in a chat
    // reaches it as focus, the phone, a turn, an ask or a sub-agent above. The host engine keeps its stamp (below).
    lastActivityAt: 0,
  };
}

/** Every chat engine, plus the host engine when it runs. The host engine is never on screen, so it
 *  starts background and goes idle when nothing has asked it anything for the idle period. t-wdyi2t:
 *  `hostPark` stops it after HOST_PARK_AFTER_MS of that (elastic/hostPark.ts, lead decision). */
export function engineViews(
  panel: PanelSignals | null,
  win: WindowSignals,
  host: (ElasticClient & { lastExtAt?: number; readonly pid?: number }) | undefined,
  hostPark?: () => Promise<string | null>,
): EngineView[] {
  const out: EngineView[] = [];
  for (const s of panel?.sessions() ?? []) {
    // t-w2txb2: a parked chat has no engine to class or trim, and asking it anything would start it
    // again. Leaving it out also drops its tracker state, so its restored engine starts from START.
    if (s.gate.current === 'parked') continue;
    const label = engineLabel(s); // t-xoenz1: kind, pid and engine session on every line the tracker writes
    const park = panel?.park ? () => panel.park!(s.id) : undefined;
    out.push({ key: s.client, client: s.client, label, ready: s.gate.current === 'ready', pid: s.client.pid, signals: chatSignals(s, panel!, win), ...(park ? { park } : {}), ...(panel?.parkSoon?.(s.id) ? { parkSoon: true } : {}) });
  }
  if (host) out.push({ key: host, client: host, label: 'host engine', ready: true, pid: host.pid, signals: { ...QUIET, lastActivityAt: host.lastExtAt ?? 0 }, ...(hostPark ? { park: hostPark, parkAfterMs: HOST_PARK_AFTER_MS } : {}) });
  return out;
}

/** t-wy2jj3 (owner decision 2026-09-25): a parked chat that becomes the focused chat or the phone's chat starts
 *  its engine now, through its gate, the same restore a message starts (park.ts: session/resume, the recorded
 *  spawn env, the settings set again). The restore then overlaps the typing: a message sent meanwhile waits in
 *  the gate and goes once after it. t-x3a89j: FOCUS, not visibility: a grid tile or a tab that is only visible
 *  stays parked. A gate that is already starting (or failed: its card offers Retry) is not parked, so a pass
 *  never starts a second restore. */
export function wakeOnScreen(panel: PanelSignals, win: WindowSignals, log?: (line: string) => void): void {
  if (panel.booting?.()) return; // t-wypna7: not during the reload's reopen loop (each new tab is the active editor for a moment)
  for (const s of panel.sessions()) {
    if (s.gate.current !== 'parked' || !s.gate.whenUp || !(inFocus(s, panel, win) || win.phoneFocus() === s.id)) continue;
    log?.(`[elastic] ${s.kind === 'agent' ? 'agent' : 'chat'} ${s.number ?? s.id} is focused: starting its engine again`);
    void s.gate.whenUp();
  }
}

/** The engine a host read may use without waking a hidden chat: the active chat when it is focused
 *  (or on the phone), else any chat that is. Undefined = none is. t-x3a89j: a merely visible tile is not used,
 *  or host reads (which stamp its quiet clock) would keep it from ever going idle. */
export function onScreenClient<C extends ElasticClient>(
  panel: Omit<PanelSignals, 'sessions'> & { sessions(): Iterable<SignalSession & { client: C }> },
  win: WindowSignals,
): C | undefined {
  // A parked chat on screen is not woken for a host read (t-w2txb2): the host engine answers instead.
  const visible = (s: SignalSession) => s.gate.current !== 'parked' && (inFocus(s, panel, win) || win.phoneFocus() === s.id);
  const all = [...panel.sessions()];
  const active = all.find((s) => s.id === panel.activeId());
  if (active && visible(active)) return active.client;
  return all.find(visible)?.client;
}
