// claudeSubscriptionConsent.ts — the one-time disclosure the
// origami.experimentalClaudeSubscription setting requires before it is
// allowed to STAY on (t-tijdof).
//
// Modelled on browserToolsConsent.ts's YOLO-consent flow, mirrored: that flow
// asks about turning a setting ON; this one asks about a setting the user
// (or synced settings) already turned on, and REVERTS it if the answer is
// not an explicit "Enable". A dismissed dialog (Escape, click-away) counts as
// "not confirmed" too — an unconfirmed billing-and-account-risk feature must
// not sit on silently, unlike the browser-tool repair prompt, which is safe
// to leave unresolved because its baseline is off already.
//
// Two entry points reach the same question: a live flip in Settings
// (watchClaudeSubscriptionSetting, wired at activation) and the setting
// already being on at activation with no recorded consent
// (ensureClaudeSubscriptionConsent) — synced settings or an older build can
// produce that state.
import * as vscode from 'vscode';
import { CLAUDE_SUBSCRIPTION_SETTING, CLAUDE_SUBSCRIPTION_SETTING_ID } from './claudeSubscriptionFlag';

const CONSENT_FLAG = 'origami.claudeSubscriptionDisclosure.v1';
/** The exact page the study (claude_subscription_hermes_2026-09-23, section 5)
 *  cites for Anthropic's terms on third-party subscription-login use. */
const LEGAL_URL = 'https://www.anthropic.com/legal';

/** ASD-STE100: short sentences, one fact each, no idiom. */
export const DISCLOSURE_TEXT =
  'This uses your Claude subscription through the Claude Code program on this computer. ' +
  "Anthropic bills it at the Agent SDK rate against your plan's allowance. " +
  "Anthropic's terms limit third-party use of subscription logins. The program may act on your account. " +
  `Read the terms: ${LEGAL_URL}`;

function readSetting(): boolean {
  try {
    return vscode.workspace.getConfiguration('origami').get<boolean>(CLAUDE_SUBSCRIPTION_SETTING) === true;
  } catch {
    return false;
  }
}

async function revertSetting(): Promise<void> {
  await vscode.workspace
    .getConfiguration('origami')
    .update(CLAUDE_SUBSCRIPTION_SETTING, false, vscode.ConfigurationTarget.Global);
}

/**
 * Ask once ever (globalState). Returns true only for an explicit "Enable" —
 * every other answer, including a dismiss, is a decline. On decline the
 * caller must revert the setting; this function does not write it, so it
 * stays a pure yes/no ask that both call sites can reuse identically.
 */
export async function confirmClaudeSubscriptionDisclosure(context: vscode.ExtensionContext): Promise<boolean> {
  if (context.globalState.get<boolean>(CONSENT_FLAG) === true) return true;
  const choice = await vscode.window.showWarningMessage(DISCLOSURE_TEXT, { modal: true }, 'Enable');
  if (choice === 'Enable') {
    await context.globalState.update(CONSENT_FLAG, true);
    return true;
  }
  return false;
}

/** Activation-time repair: the setting is ALREADY on but consent was never
 *  recorded (synced settings, or an older build with no disclosure at all).
 *  Same question, asked once; a decline reverts the setting to off. */
export async function ensureClaudeSubscriptionConsent(context: vscode.ExtensionContext): Promise<void> {
  if (!readSetting()) return;
  const ok = await confirmClaudeSubscriptionDisclosure(context);
  if (!ok) await revertSetting();
}

/** Wire the live flip: OFF -> ON needs the confirm, or the setting goes back
 *  to false. ON -> OFF, and any change that does not touch this setting, does
 *  nothing. Call once at activation and push the returned disposable. */
export function watchClaudeSubscriptionSetting(context: vscode.ExtensionContext): vscode.Disposable {
  let last = readSetting();
  return vscode.workspace.onDidChangeConfiguration(async (e) => {
    if (!e.affectsConfiguration(CLAUDE_SUBSCRIPTION_SETTING_ID)) return;
    const now = readSetting();
    const turnedOn = now && !last;
    last = now;
    if (!turnedOn) return;
    const ok = await confirmClaudeSubscriptionDisclosure(context);
    if (!ok) {
      last = false;
      await revertSetting();
    }
  });
}
