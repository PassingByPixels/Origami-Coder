// browserToolsConsent.ts — the once-ever offer to REPAIR browser-tool
// auto-approval.
//
// `chat.tools.eligibleForAutoApproval` does NOT remove the "Open Browser Page?"
// modal; UAT proved it. It is a GATE with a DEFAULT-OPEN position, not a switch:
// eligibility is true when the map has no entry, and the map exists to turn tools
// OFF, so writing `true` where nothing was written is a no-op. Passing the gate only
// makes a tool ELIGIBLE, and on the path this extension uses (`vscode.lm.invokeTool`
// with `toolInvocationToken: undefined`) nothing can then APPROVE it. The only
// remaining lever is `chat.tools.global.autoApprove`, which VS Code itself calls
// "YOLO mode … extremely dangerous"; it is validated harmful and is NEVER written
// here. So the prompt is asked in the ONE case where the write changes real
// behaviour — an explicit `false`, which bars the tool everywhere — and asked at
// most once ever, via origami.browserToolsConsent.v1 in globalState.
import * as vscode from 'vscode';
import { AUTO_APPROVE_SETTING } from './browserVsCode';

const CONSENT_FLAG = 'origami.browserToolsConsent.v1';
const SETTING_KEY = 'chat.tools.eligibleForAutoApproval';
/** `uw.OpenBrowserPage` in the 1.132.0 workbench bundle — the tool's REFERENCE
 *  name, which is what `dle()` keys this map by. Not its id (`open_browser_page`). */
const TOOL_ID = 'openBrowserPage';

/** Pure read-merge-write: every key already in `current` survives untouched;
 *  only `toolId` is added or overwritten. `current` absent/malformed reads as
 *  an empty map rather than throwing — a first-ever write is not an error. */
export function mergeAutoApprovalSetting(
  current: Record<string, unknown> | undefined,
  toolId: string,
  enabled: boolean,
): Record<string, unknown> {
  const base = current && typeof current === 'object' ? current : {};
  return { ...base, [toolId]: enabled };
}

/** Whether the map BARS the tool from auto-approval. Only an explicit `false` does:
 *  `isToolEligibleForAutoApproval` returns true when the key is missing, so an
 *  absent key and a `true` key are the same state. Read as a strict `=== false`, so
 *  a malformed value is left alone rather than silently rewritten for the user. */
export function isBarredFromAutoApproval(current: Record<string, unknown> | undefined, toolId: string): boolean {
  return current?.[toolId] === false;
}

/** Runs once ever per install (globalState flag). Three exits, in order:
 *   1. Already asked (flag set) — nothing happens.
 *   2. Nothing to repair (the tool is not barred) — record the flag, no popup.
 *   3. Barred. Ask. 'Yes' merges `true` back in + sets the flag; 'No' sets the flag
 *      and writes nothing; dismissed sets NEITHER, so the next activation asks again
 *      rather than silently deciding "no" on the user's behalf. */
export async function ensureBrowserToolsConsent(context: vscode.ExtensionContext): Promise<void> {
  if (context.globalState.get<boolean>(CONSENT_FLAG) === true) return;

  const cfg = vscode.workspace.getConfiguration();
  const current = cfg.get<Record<string, unknown>>(SETTING_KEY);
  if (!isBarredFromAutoApproval(current, TOOL_ID)) {
    void context.globalState.update(CONSENT_FLAG, true);
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    'Origami: "chat.tools.eligibleForAutoApproval" currently bars the "Open browser page" tool from ever being ' +
      'auto-approved, so VS Code asks about it every time and offers no "Always allow". Allow it to be ' +
      'auto-approved again? (This does not remove the confirmation VS Code raises for agent-driven opens.)',
    'Yes',
    'No',
  );
  if (choice === 'Yes') {
    await cfg.update(SETTING_KEY, mergeAutoApprovalSetting(current, TOOL_ID, true), vscode.ConfigurationTarget.Global);
    void context.globalState.update(CONSENT_FLAG, true);
  } else if (choice === 'No') {
    void context.globalState.update(CONSENT_FLAG, true);
  }
}

// --- YOLO-on-install disclosure -------------------------------------------
//
// The one working lever is `chat.tools.global.autoApprove` — VS Code's own boolean
// kill-switch for its confirmation dialogs, every tool, every workspace, which it
// labels "extremely dangerous". A SEPARATE setting and a SEPARATE once-ever flag
// from the repair prompt above; neither flow touches the other's. It is no longer
// offered at INSTALL TIME: this is not called on activation, and the branch that
// defaulted an ABSENT setting to on is deleted below — that choice lives in the
// composer's explicit "Browser: Ask / Bypass" control. What remains is the
// EXPLICIT-FALSE repair question, so a deliberate prior "off" is never overwritten.

const YOLO_CONSENT_FLAG = 'origami.yoloAutoApproveConsent.v1';
/** SHARED with the reader in browserVsCode.ts, not spelled twice: browserForce
 *  gates a whole fallback on the value this flow writes, and a mirror of the
 *  key is a way for the writer and the reader to end up on different settings. */
const YOLO_SETTING_KEY = AUTO_APPROVE_SETTING;

/** NOT called from activation any more (see above). If called: already-true skips
 *  silently; an EXPLICITLY configured false (any scope) gets a question — write only
 *  on "Turn on", remember "Keep off", re-ask on dismiss; an ABSENT setting does
 *  nothing at all. */
export async function ensureYoloAutoApproveConsent(context: vscode.ExtensionContext): Promise<void> {
  if (context.globalState.get<boolean>(YOLO_CONSENT_FLAG) === true) return;

  const cfg = vscode.workspace.getConfiguration();
  if (cfg.get<boolean>(YOLO_SETTING_KEY) === true) {
    void context.globalState.update(YOLO_CONSENT_FLAG, true);
    return;
  }

  const inspected = cfg.inspect<boolean>(YOLO_SETTING_KEY);
  const explicitlyConfigured =
    inspected !== undefined &&
    (inspected.globalValue !== undefined ||
      inspected.workspaceValue !== undefined ||
      inspected.workspaceFolderValue !== undefined);

  if (explicitlyConfigured) {
    const choice = await vscode.window.showInformationMessage(
      'Origami works best with VS Code\'s "chat.tools.global.autoApprove" turned on, but it is currently off. ' +
        'Turning it on auto-approves ALL chat tools, in ALL workspaces, with no confirmation dialogs — ' +
        'VS Code calls this "YOLO mode". Turn it on?',
      'Turn on',
      'Keep off',
    );
    if (choice === 'Turn on') {
      await cfg.update(YOLO_SETTING_KEY, true, vscode.ConfigurationTarget.Global);
      void context.globalState.update(YOLO_CONSENT_FLAG, true);
    } else if (choice === 'Keep off') {
      void context.globalState.update(YOLO_CONSENT_FLAG, true);
    }
    // dismissed: a question with no answer — ask again next activation.
    return;
  }

  // Absent: no default is applied any more — that decision belongs to the composer's Browser
  // control.
}
