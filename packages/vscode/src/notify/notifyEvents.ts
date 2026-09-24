// Maps the five "owner is waiting" moments to an OS toast. Each kind reads its
// own `origamicoder.notifications.*` setting, is skipped while the VS Code
// window is focused, and is throttled to one toast per kind per THROTTLE_MS.
// `shouldNotify` is the pure rule; call-sites use only the `notify*` functions.

import * as vscode from 'vscode';
import { sendOsToast, TOAST_APP_ID } from './osToast';

export type NotifyKind = 'question' | 'permission' | 'turnDone' | 'flock' | 'remote';

export const THROTTLE_MS = 10_000;

const lastFired = new Map<NotifyKind, number>();
let lastFlockSnapshot = '';

/** Test-only: clear throttle history and the Flock dedupe snapshot between cases. */
export function resetNotifyState(): void {
  lastFired.clear();
  lastFlockSnapshot = '';
}

export interface NotifySettings {
  enabled: boolean;
  question: boolean;
  permission: boolean;
  turnDone: boolean;
  flock: boolean;
  remote: boolean;
  onlyWhenUnfocused: boolean;
}

export function readNotifySettings(): NotifySettings {
  const c = vscode.workspace.getConfiguration('origamicoder.notifications');
  return {
    enabled: c.get<boolean>('enabled', true),
    question: c.get<boolean>('question', true),
    permission: c.get<boolean>('permission', true),
    turnDone: c.get<boolean>('turnDone', true),
    flock: c.get<boolean>('flock', true),
    remote: c.get<boolean>('remote', true),
    onlyWhenUnfocused: c.get<boolean>('onlyWhenUnfocused', true),
  };
}

/** Pure gate: overall + per-kind enabled, not focused, outside the throttle. */
export function shouldNotify(opts: {
  enabled: boolean;
  kindEnabled: boolean;
  onlyWhenUnfocused: boolean;
  focused: boolean;
  now: number;
  last?: number;
}): boolean {
  if (!opts.enabled || !opts.kindEnabled) return false;
  if (opts.onlyWhenUnfocused && opts.focused) return false;
  if (opts.last !== undefined && opts.now - opts.last < THROTTLE_MS) return false;
  return true;
}

function fire(kind: NotifyKind, title: string, body: string): void {
  const settings = readNotifySettings();
  const now = Date.now();
  const ok = shouldNotify({
    enabled: settings.enabled,
    kindEnabled: settings[kind],
    onlyWhenUnfocused: settings.onlyWhenUnfocused,
    focused: vscode.window.state.focused,
    now,
    last: lastFired.get(kind),
  });
  if (!ok) return;
  lastFired.set(kind, now);
  void sendOsToast(title, body);
}

/** A buffered background-agent question — no chat view is mounted to show it. */
export function notifyQuestionWaiting(agentName: string, preview: string): void {
  fire('question', `${agentName} needs you`, preview);
}

/** Forwarded to a mounted chat view; the window itself may not have focus. */
export function notifyPermissionWaiting(agentName: string, title: string): void {
  fire('permission', `${agentName} is waiting`, title);
}

const NO_TOAST_STOP_REASONS = new Set(['idle', 'blocked']);

/** A turn ended. `idle`/`blocked` are not a finish worth a toast. */
export function notifyTurnDone(agentName: string | undefined, stopReason: string | undefined): void {
  if (stopReason !== undefined && NO_TOAST_STOP_REASONS.has(stopReason)) return;
  fire('turnDone', `${agentName ?? 'Agent'} finished`, stopReason ?? 'Turn complete');
}

/** DashboardPanel.post() choke point for the two waiting-on-you message types. */
export function notifyOnPost(msg: Record<string, unknown>, agentName: string | undefined): void {
  if (msg.type === 'turnDone') { notifyTurnDone(agentName, msg.stopReason as string | undefined); return; }
  if (msg.type === 'requestPermission') {
    const title = typeof msg.title === 'string' ? msg.title : 'Waiting for you';
    if (msg.questions) notifyQuestionWaiting(agentName ?? 'Agent', title);
    else notifyPermissionWaiting(agentName ?? 'Agent', title);
  }
}

/** The mailbox is re-posted on every write and refresh, mostly unchanged —
 *  snapshot the threads so only a real change reaches the throttle gate. */
export function notifyFlockMailbox(threads: unknown[]): void {
  const snapshot = JSON.stringify(threads);
  if (snapshot === lastFlockSnapshot) return;
  lastFlockSnapshot = snapshot;
  if (threads.length === 0) return;
  fire('flock', 'Flock', 'New message in your mailbox');
}

export function notifyRemotePaired(): void {
  fire('remote', TOAST_APP_ID, 'Phone paired');
}
