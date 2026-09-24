// browserAutoApproveControl.ts — the composer's "Browser: Ask / Bypass"
// control's host-side read/write. Reads and writes VS Code's own global
// chat-tool auto-approve setting, never scoped to a session.
import * as vscode from 'vscode';
import { AUTO_APPROVE_SETTING, globalAutoApprove } from '../browserVsCode';

export interface BrowserAutoApproveHost {
  post: (msg: Record<string, unknown>) => void;
}

/** Read the setting LIVE and broadcast it — called on mount and whenever the
 *  popover opens, so an externally changed value is never stale. */
export function broadcastBrowserAutoApprove(host: BrowserAutoApproveHost): void {
  host.post({ type: 'browserAutoApproveUpdate', value: globalAutoApprove() });
}

/**
 * Bypass writes `true`; Ask writes an EXPLICIT `false` (t-obf3jw: bypass is
 * now the default, so an absent entry reads as bypass — removing the entry
 * here would silently undo the very "Ask" the write was asked for). Writing
 * `true` triggers VS Code's own confirmation dialog, which is not ours to
 * word, suppress, or skip.
 */
export async function setBrowserAutoApprove(host: BrowserAutoApproveHost, bypass: boolean): Promise<void> {
  const value = bypass ? true : false;
  try {
    await vscode.workspace.getConfiguration().update(AUTO_APPROVE_SETTING, value, vscode.ConfigurationTarget.Global);
  } catch (e) {
    // Same shape as the other global-setting writers (setFrequencyPenalty):
    // a toast, not a thrown rejection the message-handler loop would swallow.
    vscode.window.showErrorMessage(
      `Origami: could not update "chat.tools.global.autoApprove" — ${e instanceof Error ? e.message : e}`,
    );
  }
    // Broadcast either way: the popover sets its notch optimistically on
    // click, so a caught rejection must still send a fresh live read to snap
    // the client back to what VS Code actually has on disk.
  broadcastBrowserAutoApprove(host);
}
