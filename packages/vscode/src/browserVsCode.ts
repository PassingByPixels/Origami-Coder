// browserVsCode.ts — the VS Code surfaces this bridge reaches through.
//
// Extracted from browserBridge.ts (341/350, no room) when the page verbs were
// taught to read failure. It is the paragraph that file's own header already
// described as separate: NO surface is guaranteed on the build the user is
// running, so each is PROBED rather than assumed, and probing is not the same
// job as deciding what an action means.
//
//   1. the integrated browser's open COMMAND. Its id moved between releases
//      ('workbench.browser.open' / 'workbench.action.browser.open', with the
//      older 'simpleBrowser.show' being phased out).
//   2. the browser agent TOOLS ('read_page' and friends), registered by VS Code
//      core and exposed through `vscode.lm.tools`. Their real ids live in
//      browserTools.ts, read off a shipped build.
//   3. the EDITOR a shared page lives in, and the setting that decides whether
//      a tool runs without a modal — see browserPage.ts / browserForce.ts.
//
// Everything here is a lookup or a call. Nothing here decides anything.

import * as vscode from 'vscode';
import { isBrowserTool } from './browserTools';

export function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/**
 * A url for the integrated browser. A bare path is a local file, so it becomes
 * a real `file://` url; anything already carrying a scheme is passed through.
 * The two-character minimum before the colon is what keeps `C:\src\x.html` a
 * Windows path instead of a "c:" scheme.
 */
export function toBrowserUrl(raw: string): string {
  if (/^[a-z][a-z0-9+.-]+:/i.test(raw)) return raw;
  return vscode.Uri.file(raw).toString();
}

/** Probed in order; the first one this build registers is the one used. */
export const OPEN_COMMANDS = [
  'workbench.browser.open',
  'workbench.action.browser.open',
  'simpleBrowser.show',
] as const;

export async function findOpenCommand(): Promise<string | undefined> {
  let all: readonly string[] = [];
  try {
    all = await vscode.commands.getCommands(true);
  } catch {
    return undefined;
  }
  return OPEN_COMMANDS.find((id) => all.includes(id));
}

/**
 * Every browser tool this build publishes, by name.
 *
 * Matched on the REAL ids (browserTools.ts), not on the substring "browser":
 * of the eleven tools VS Code registers, only two carry that word, and neither
 * of them drives a page. The tags are not consulted at all — these tools ship
 * none, so a tag predicate could only ever have matched an extension's tool.
 */
export function discoverTools(): string[] {
  const tools = (vscode as { lm?: { tools?: readonly { name?: unknown }[] } }).lm?.tools;
  if (!Array.isArray(tools)) return [];
  return tools.map((t) => str(t?.name)).filter((name): name is string => name !== undefined && isBrowserTool(name));
}

/** What this build can do, as facts rather than prose. Read by the `probe`
 *  action AND by every failure that has to say why it could not act. */
export interface BrowserProbe {
  tools: string[];
  openCommand?: string;
}

export async function probe(): Promise<BrowserProbe> {
  const openCommand = await findOpenCommand();
  return { tools: discoverTools(), ...(openCommand ? { openCommand } : {}) };
}

/** Run the open command this build registered. Kept beside findOpenCommand so
 *  that every `vscode.` call this feature makes sits in one file. */
export async function runOpenCommand(command: string, url: string): Promise<void> {
  await vscode.commands.executeCommand(command, url);
}

/** A shared page's EDITOR resource — `oy.forId` in the 1.132.0 bundle:
 *  `URI.from({ scheme: "vscode-browser", path: "/<pageId>" })`. Built with
 *  `Uri.from`, not `parse`: the workbench reads the path back raw (`oy.parse`
 *  strips the leading "/" and decodes nothing). Opening it REVEALS the existing
 *  tab rather than adding a second, because the editor is registered for
 *  `vscode-browser:/**` as `exclusive` + `singlePerResource`. Only ever called
 *  with an id VS Code itself listed: `createEditorInput` runs
 *  `getOrCreateLazy(id)`, so an unknown id would open a blank page. */
export const BROWSER_SCHEME = 'vscode-browser';

export async function revealPage(pageId: string): Promise<void> {
  await vscode.commands.executeCommand('vscode.open', vscode.Uri.from({ scheme: BROWSER_SCHEME, path: `/${pageId}` }));
}

/** VS Code's global auto-approve. READ here, never written. The write moved
 *  twice: it used to be an install-time default in browserToolsConsent.ts
 *  (t-kgsupy round 2), then that was superseded (round 3, owner direction) by
 *  an explicit "Browser: Ask / Bypass" composer control — the write for THAT
 *  lives in src/dashboard/browserAutoApproveControl.ts, reached only on a
 *  deliberate click, never at activation. */
export const AUTO_APPROVE_SETTING = 'chat.tools.global.autoApprove';

export function globalAutoApprove(): boolean {
  return vscode.workspace.getConfiguration().get<boolean>(AUTO_APPROVE_SETTING) === true;
}

export async function invoke(name: string, input: Record<string, unknown>): Promise<unknown> {
  const lm = (vscode as {
    lm?: { invokeTool?: (n: string, o: { input: unknown; toolInvocationToken: undefined }) => Thenable<unknown> };
  }).lm;
  if (!lm?.invokeTool) throw new Error('This VS Code build does not expose vscode.lm.invokeTool.');
  return await lm.invokeTool(name, { input, toolInvocationToken: undefined });
}
