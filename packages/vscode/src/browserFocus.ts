// browserFocus.ts — SHOW the browser page without taking the user's cursor.
//
// browserPage.ts reveals a page listed "not visible" before every driven verb, and
// that reveal is load-bearing: a background editor tab is not laid out, so
// Playwright's actionability check can never pass on it. But on 1.136.1
// `vscode.open`'s handler forwards ONE argument, so it cannot carry `preserveFocus`
// at all and every reveal took the cursor off whatever the user was typing in.
// `_workbench.open`, the command it delegates to, does take options as the tuple
// `[column, options]`; an undefined column lands in the ACTIVE group, and the
// browser editor is `exclusive` + `singlePerResource`, so the existing tab is
// revealed rather than duplicated. PROBED, not assumed — the probe passes `false`,
// because `getCommands(true)` hides `_`-prefixed ids — with `vscode.open` as the
// fallback, where the page is still revealed and the focus still moves.

import * as vscode from 'vscode';

/** The internal command that honours editor options. */
export const REVEAL_COMMAND = '_workbench.open';
/** The public one, which on 1.136.1 forwards the uri alone. */
export const REVEAL_FALLBACK = 'vscode.open';

/** `_workbench.open`'s third argument: `[column, options]`. An undefined column
 *  is the ACTIVE group, which is where a page already open is anyway. */
export const QUIET_REVEAL_ARGS: readonly [undefined, { preserveFocus: true }] = [
  undefined,
  { preserveFocus: true },
];

/** Which of the two this build registers. Not cached: the reveal it serves
 *  already costs a tool round trip, so one in-process command list is not the
 *  expensive part, and a cache would have to be resettable to be testable. */
export async function revealCommand(): Promise<string> {
  try {
    const all = await vscode.commands.getCommands(false);
    return all.includes(REVEAL_COMMAND) ? REVEAL_COMMAND : REVEAL_FALLBACK;
  } catch {
    return REVEAL_FALLBACK;
  }
}

/** Origami's own switch for where the agent's browser tab lands. */
export const OPEN_BESIDE_SETTING = 'origami.browser.openBeside';
/** VS Code's own, read off the shipped 1.138.0 bundle: `workbench.browser.
 *  newTabPlacement`, enum `activeGroup | sideGroup | window`, default
 *  `activeGroup` — the value that puts the agent's page OVER whatever the user is
 *  reading. `sideGroup` is what "opens beside" means to the workbench. */
export const PLACEMENT_SETTING = 'workbench.browser.newTabPlacement';
export const BESIDE_PLACEMENT = 'sideGroup';

/** Whether the Origami default may be written to the workbench setting. Only when
 *  the user has never set that setting THEMSELVES, at any scope — a value they
 *  chose is a decision, and a default is not allowed to overwrite a decision. Pure,
 *  so the rule is testable without a workbench. */
export function shouldApplyBeside(
  beside: boolean,
  inspected: { globalValue?: unknown; workspaceValue?: unknown; workspaceFolderValue?: unknown } | undefined,
  current: unknown,
): boolean {
  if (!beside || current === BESIDE_PLACEMENT) return false;
  return (
    inspected?.globalValue === undefined &&
    inspected?.workspaceValue === undefined &&
    inspected?.workspaceFolderValue === undefined
  );
}

/** Put the agent's browser tab beside the chat rather than over it, once, before a
 *  page is opened. Best effort: a settings write that fails is not a reason to fail
 *  the open, and the page still appears — just in the active group. */
export async function applyOpenBeside(): Promise<void> {
  try {
    const config = vscode.workspace.getConfiguration();
    const beside = config.get<boolean>(OPEN_BESIDE_SETTING) !== false;
    const inspected = config.inspect(PLACEMENT_SETTING);
    if (!shouldApplyBeside(beside, inspected, config.get(PLACEMENT_SETTING))) return;
    await config.update(PLACEMENT_SETTING, BESIDE_PLACEMENT, vscode.ConfigurationTarget.Global);
  } catch {
    // No placement setting on this build, or a read-only settings file.
  }
}

/** Bring a resource's editor to the front, leaving the cursor where it was. */
export async function revealQuietly(uri: vscode.Uri): Promise<void> {
  const command = await revealCommand();
  if (command === REVEAL_COMMAND) {
    await vscode.commands.executeCommand(command, uri, QUIET_REVEAL_ARGS);
    return;
  }
  await vscode.commands.executeCommand(command, uri);
}

/** Run the integrated browser's open COMMAND, as quietly as that command allows.
 *  On 1.136.1 the only registered id is `simpleBrowser.show`, which takes one
 *  parameter and drops a second argument, so the option is passed only for a build
 *  that reads one. Hence the RESTORE below: conditional on the focus having actually
 *  moved, and able to restore only to a TEXT editor — when none was active (the
 *  dashboard webview had focus, the ordinary case during a turn) the focus stays
 *  where the command put it. The command is reached only when VS Code publishes no
 *  `open_browser_page`, which already opens with `preserveFocus: true`. */
export async function openQuietly(command: string, url: string): Promise<void> {
  const before = vscode.window.activeTextEditor;
  await vscode.commands.executeCommand(command, url, { preserveFocus: true });
  if (!before || vscode.window.activeTextEditor === before) return;
  try {
    await vscode.window.showTextDocument(before.document, before.viewColumn);
  } catch {
    // The editor closed while the page opened. Nothing to put the cursor back in.
  }
}
