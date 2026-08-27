// browserAutoApproveControl.ts — the composer's "Browser: Ask / Bypass"
// control's host-side read/write (t-kgsupy round 3, owner direction).
//
// Reads and writes VS Code's OWN global chat-tool auto-approve
// (AUTO_APPROVE_SETTING, browserVsCode.ts) — NEVER scoped to a session, so
// every open composer (every grid cell, every attached view) converges on
// the same value. Extracted out of DashboardPanel.ts (which sat at its cap,
// 6317/6318) so only the message-handler wiring stayed behind — the same
// shape as visionProfile.ts and connectOllama.ts.
import * as vscode from 'vscode';
import { AUTO_APPROVE_SETTING, globalAutoApprove } from '../browserVsCode';

export interface BrowserAutoApproveHost {
  post: (msg: Record<string, unknown>) => void;
}

/** Read the setting LIVE and broadcast it. Called on composer mount AND
 *  again each time the popover opens (`requestBrowserAutoApprove`), so a
 *  value changed OUTSIDE Origami — the Settings UI, another window — is
 *  never stale by the time the user looks at the control. */
export function broadcastBrowserAutoApprove(host: BrowserAutoApproveHost): void {
  host.post({ type: 'browserAutoApproveUpdate', value: globalAutoApprove() });
}

/**
 * Bypass writes `true`; Ask writes `undefined`, which REMOVES the entry
 * rather than writing `false` — `false` would be a third state nobody asked
 * for. Absent reads the same as "off" for THIS setting (unlike the sibling
 * `chat.tools.eligibleForAutoApproval` map browserToolsConsent.ts decodes,
 * which defaults open — a different setting with a different default).
 * Writing `true` is the one action that makes VS Code raise its OWN
 * strongly-worded confirmation dialog; that dialog is not ours to word,
 * suppress, or skip.
 */
export async function setBrowserAutoApprove(host: BrowserAutoApproveHost, bypass: boolean): Promise<void> {
  const value = bypass ? true : undefined;
  try {
    await vscode.workspace.getConfiguration().update(AUTO_APPROVE_SETTING, value, vscode.ConfigurationTarget.Global);
  } catch (e) {
    // Same shape as the other global-setting writers (setFrequencyPenalty):
    // a toast, not a thrown rejection the message-handler loop would swallow.
    vscode.window.showErrorMessage(
      `Origami: could not update "chat.tools.global.autoApprove" — ${e instanceof Error ? e.message : e}`,
    );
  }
  // Broadcast either way. InputBar's popover sets its notch OPTIMISTICALLY on
  // click, before this write resolves, with no other correction path — so a
  // caught rejection must still send a fresh LIVE read (never the attempted
  // `value`; broadcastBrowserAutoApprove re-reads config) to snap the client
  // back to what VS Code actually has on disk. Skipping this on failure was
  // the bug: the gauge stayed on the optimistic guess forever, and in the
  // dangerous direction — write throws while un-bypassing — it could show
  // "Ask" (looks safe) while the real setting was still `true`.
  broadcastBrowserAutoApprove(host);
}
