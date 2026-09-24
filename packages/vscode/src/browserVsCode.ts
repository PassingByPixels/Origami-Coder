// browserVsCode.ts — the VS Code surfaces this bridge reaches through. NO surface is
// guaranteed on the build the user is running, so each is PROBED, never assumed:
//   1. the integrated browser's open COMMAND, whose id moved between releases.
//   2. the browser agent TOOLS ('read_page' and friends), registered by VS Code core
//      and exposed through `vscode.lm.tools`; real ids in browserTools.ts.
//   3. the EDITOR a shared page lives in, and the setting that decides whether a tool
//      runs without a modal — see browserPage.ts / browserForce.ts.
// Everything here is a lookup or a call. Nothing here decides anything.

import * as vscode from 'vscode';
import { isBrowserTool } from './browserTools';
// Showing a page is a call; showing it WITHOUT taking the cursor needs a probe
// of its own and a bundle reading to justify it, so both live next door.
import { openQuietly, revealQuietly } from './browserFocus';

export function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/** A url for the integrated browser. A bare path is a local file and becomes a real
 *  `file://` url; anything already carrying a scheme is passed through. The
 *  two-character minimum before the colon keeps `C:\src\x.html` a Windows path. */
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

/** Every browser tool this build publishes, by name. Matched on the REAL ids
 *  (browserTools.ts), not on the substring "browser": of the eleven tools VS Code
 *  registers only two carry that word, and neither drives a page. The tags are not
 *  consulted at all — these tools ship none. */
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

/** Run the open command this build registered, without taking the user's focus
 *  where the command allows it — browserFocus.ts has what each one accepts. */
export async function runOpenCommand(command: string, url: string): Promise<void> {
  await openQuietly(command, url);
}

/** A shared page's EDITOR resource — `URI.from({ scheme: "vscode-browser", path:
 *  "/<pageId>" })`. Built with `Uri.from`, not `parse`: the workbench reads the path
 *  back raw. Opening it REVEALS the existing tab rather than adding a second,
 *  because the editor is registered `exclusive` + `singlePerResource`. Only ever
 *  called with an id VS Code itself listed — an unknown id would open a blank page. */
export const BROWSER_SCHEME = 'vscode-browser';

/** The reveal LAYS THE PAGE OUT; it was never meant to move the cursor as well,
 *  and `vscode.open` cannot be told not to. browserFocus.ts owns that choice. */
export async function revealPage(pageId: string): Promise<void> {
  await revealQuietly(vscode.Uri.from({ scheme: BROWSER_SCHEME, path: `/${pageId}` }));
}

/** VS Code's global auto-approve. READ here, never written on install. The write lives in
 *  src/dashboard/browserAutoApproveControl.ts.
 *
 * t-obf3jw: bypass-browser is now the DEFAULT — an absent/unset setting reads as bypass. Only an
 * EXPLICIT `false` (the user's own OFF switch, set directly in VS Code's settings, or previously
 * via the now-removed composer row) still reads as "ask". This does not write anything to disk on
 * its own; it only changes what an unset value means to this reader. */
export const AUTO_APPROVE_SETTING = 'chat.tools.global.autoApprove';

export function globalAutoApprove(): boolean {
  return vscode.workspace.getConfiguration().get<boolean>(AUTO_APPROVE_SETTING) !== false;
}

export async function invoke(name: string, input: Record<string, unknown>): Promise<unknown> {
  const lm = (vscode as {
    lm?: { invokeTool?: (n: string, o: { input: unknown; toolInvocationToken: undefined }) => Thenable<unknown> };
  }).lm;
  if (!lm?.invokeTool) throw new Error('This VS Code build does not expose vscode.lm.invokeTool.');
  return await lm.invokeTool(name, { input, toolInvocationToken: undefined });
}
