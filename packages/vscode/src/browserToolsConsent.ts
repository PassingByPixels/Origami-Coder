// browserToolsConsent.ts — the once-ever offer to REPAIR browser-tool auto-approval.
//
// This flow shipped believing `chat.tools.eligibleForAutoApproval` would remove
// the "Open Browser Page?" modal. It does not, and the UAT that followed proved
// it: the modal still appeared with `{"openBrowserPage": true}` set. The key was
// right — `uw.OpenBrowserPage` is the string "openBrowserPage" in the 1.132.0
// bundle — but the SETTING is not an approver. Read what it actually does:
//
//   isToolEligibleForAutoApproval(e) {
//     let t = getEligibleForAutoApprovalSpecialCase(e) ?? dle(e);
//     if (e.id === "copilot_fetchWebPage") return true;
//     if (Kbt.has(e.id)) return false;
//     let i = getValue("chat.tools.eligibleForAutoApproval");
//     if (i && typeof i == "object" && t) { if (hasOwnProperty(i, t)) return i[t]; … }
//     return true;                       // <- DEFAULT: already eligible
//   }
//
// It is a GATE with a default-open position, not a switch. Its own schema says
// so: `examples: [{ fetch: false, runTask: false }]` — the map exists to turn
// tools OFF. Writing `true` where nothing was written is a no-op, which is
// exactly the no-op the last wave shipped, behind a prompt that promised a
// popup would stop appearing.
//
// Passing the gate only makes a tool ELIGIBLE. Something must then APPROVE it,
// and on the path this extension uses — `vscode.lm.invokeTool` with
// `toolInvocationToken: undefined` — nothing can. See the header of
// browserRetry.ts's sibling investigation and the report for the full chain;
// the short version is that the no-chat-context branch of `invokeTool` passes a
// hardcoded `void 0` where the session-scoped approval would be read, the
// pre-approval hook is gated behind the `chatParticipantPrivate` proposed API,
// and the only remaining lever is `chat.tools.global.autoApprove`, which VS Code
// itself calls "YOLO mode … extremely dangerous" and guards with its own warning
// dialog. That setting is validated harmful and is NEVER written here.
//
// So the prompt is now asked in the ONE case where the write changes real
// behaviour: when the map explicitly says `false`. There the tool is barred from
// auto-approval everywhere, including the chat sessions where "Always allow"
// does work, and VS Code adds a "not eligible" disclaimer with
// `allowAutoConfirm: false` to every confirmation it raises. Setting it back to
// `true` repairs that. Anywhere else there is nothing to offer, so nothing is
// asked — a prompt that cannot deliver what it describes is worse than silence.
//
// Asked at most once, ever: origami.browserToolsConsent.v1 in globalState, the
// same write-once-marker idiom DashboardPanel.initialize() uses for
// ensureCollabAgents (origami.collab.agents.v4).
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

/**
 * Whether the map BARS the tool from auto-approval.
 *
 * Only an explicit `false` does. Absent is not "off" — `isToolEligibleForAutoApproval`
 * returns `true` when the key is missing, so an absent key and a `true` key are
 * the same state and neither is worth a prompt. Read as a strict `=== false` so
 * that a malformed value (a string, a nested object) is left alone rather than
 * silently rewritten on the user's behalf.
 */
export function isBarredFromAutoApproval(current: Record<string, unknown> | undefined, toolId: string): boolean {
  return current?.[toolId] === false;
}

/**
 * Runs once ever per install (globalState flag). Three exits, in order:
 *  1. Already asked (flag set) — nothing happens.
 *  2. Nothing to repair (the tool is not barred) — record the flag, no popup.
 *     This is the ordinary case on a stock machine.
 *  3. Barred. Ask. 'Yes' merges `true` back in + sets the flag; 'No' sets the
 *     flag and writes nothing; dismissed (Escape / click-away) sets NEITHER, so
 *     the next activation asks again rather than silently deciding "no" on the
 *     user's behalf.
 */
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

// --- YOLO-on-install disclosure (t-kgsupy) ---------------------------------
//
// The investigation above ends in one working lever: `chat.tools.global.autoApprove`,
// which VS Code itself labels "YOLO mode ... extremely dangerous" — the boolean
// kill-switch for its OWN confirmation dialogs, every tool, every workspace. It
// is also the only thing that actually removes the browser-open popup, so this
// flow offers it — but ONLY on an explicit "Turn on" click. This is a SEPARATE
// setting and a SEPARATE once-ever flag from the repair prompt above; it does
// not touch `chat.tools.eligibleForAutoApproval` and that flow does not touch
// this one.
//
// POLICY (owner-directed, superseded below): default ON at install. The
// owner's instruction — given directly in the 2026-08-11 UAT session, not an
// agent's paraphrase — was that installing Origami enables this setting by
// default, with plain disclosure. Two protections from the verifier's fix
// round were KEPT because they were compatible with that instruction and
// correct on their own:
//   1. A value someone EXPLICITLY configured (true or false, any scope) is
//      never silently overwritten. Explicit false gets a QUESTION, and a
//      dismissed question is not a decision — it asks again next activation.
//   2. Only the ABSENT case was defaulted on. There the write happened first
//      and the dialog was DISCLOSURE of an applied default, not a consent
//      prompt — so "Turn off" reverted it, while Keep/dismiss left the
//      announced state in place.
//
// SUPERSEDED (t-kgsupy round 3, owner direction, 2026-08-12): the round-2 UAT
// found the popup this flow was chasing was never the browser tool's own text
// — it is VS Code's OWN `_checkGlobalAutoApprove` warning (Enable/Disable,
// doc links), unreachable and unrewordable from here. The owner's round-3
// call was to stop springing this decision on the user at INSTALL TIME at
// all: `ensureYoloAutoApproveConsent` no longer runs on activation (the call
// site in DashboardPanel.ts's `initialize()` is gone), and the ABSENT branch
// that used to apply the default write is deleted below. The choice now lives
// in an explicit "Browser: Ask / Bypass" control in the composer
// (InputBar.svelte, wired through DashboardPanel.ts's
// `requestBrowserAutoApprove` / `setBrowserAutoApprove` cases and the
// browserAutoApproveControl.ts leaf) — reached on the user's own terms, not
// at the moment they are still deciding whether to trust the extension at
// all. What remains of this function is the EXPLICIT-FALSE repair question,
// kept rather than deleted because it is still correct on its own terms (a
// deliberate prior "off" is never silently overwritten) — though nothing
// calls this function in the current flow.

const YOLO_CONSENT_FLAG = 'origami.yoloAutoApproveConsent.v1';
/** SHARED with the reader in browserVsCode.ts, not spelled twice: browserForce
 *  gates a whole fallback on the value this flow writes, and a mirror of the
 *  key is a way for the writer and the reader to end up on different settings. */
const YOLO_SETTING_KEY = AUTO_APPROVE_SETTING;

/**
 * NOT called from activation any more (see the SUPERSEDED note above). If
 * called: already-true skips silently. An EXPLICITLY configured false (any
 * scope) gets a question — write only on "Turn on", remember "Keep off",
 * re-ask on dismiss. An ABSENT setting now does nothing at all — the
 * default-apply branch that used to write `true` here was deleted; that
 * decision belongs to the composer's Browser control now.
 */
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

  // Absent: no default is applied any more. See the SUPERSEDED note above —
  // this decision belongs to the composer's explicit Browser control now.
}
