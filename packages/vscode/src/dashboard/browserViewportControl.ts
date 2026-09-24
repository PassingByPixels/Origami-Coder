// browserViewportControl.ts — the Settings section's "Browser" card, host side.
// Reads and writes the two viewport settings and the open-beside switch. Same
// shape as browserAutoApproveControl.ts: a live read on request, a write that
// broadcasts the live value back whether or not it succeeded.
import * as vscode from 'vscode';
import { HEIGHT_SETTING, WIDTH_SETTING, clampViewport, readViewport } from '../browserViewport';
import { OPEN_BESIDE_SETTING } from '../browserFocus';
import { REVEAL_SETTING, readRevealPolicy, toRevealPolicy } from '../browserReveal';

export interface BrowserViewportHost {
  post: (msg: Record<string, unknown>) => void;
}

/** Read LIVE and broadcast — called on mount and after every write, so a value
 *  changed in VS Code's own settings editor is never stale here. */
export function broadcastBrowserViewport(host: BrowserViewportHost): void {
  const view = readViewport();
  host.post({
    type: 'browserViewportUpdate',
    width: view.width,
    height: view.height,
    beside: vscode.workspace.getConfiguration().get<boolean>(OPEN_BESIDE_SETTING) !== false,
    reveal: readRevealPolicy(),
  });
}

async function write(key: string, value: unknown): Promise<void> {
  try {
    await vscode.workspace.getConfiguration().update(key, value, vscode.ConfigurationTarget.Global);
  } catch (e) {
    // A toast, not a rejection the message-handler loop would swallow — the same
    // choice setBrowserAutoApprove makes, for the same reason.
    vscode.window.showErrorMessage(
      `Origami: could not update "${key}" — ${e instanceof Error ? e.message : e}`,
    );
  }
}

/** The width/height pair, written together and clamped to what the workbench's own
 *  emulation inputs accept, so a half-typed number cannot persist as a viewport no
 *  page could ever have. */
export async function setBrowserViewport(
  host: BrowserViewportHost,
  width: unknown,
  height: unknown,
): Promise<void> {
  const view = clampViewport(width, height);
  await write(WIDTH_SETTING, view.width);
  await write(HEIGHT_SETTING, view.height);
  broadcastBrowserViewport(host);
}

/** The reveal policy. Whatever arrives is put through toRevealPolicy first, so a
 *  webview that drifts can only ever write one of the three contributed values. */
export async function setBrowserReveal(host: BrowserViewportHost, value: unknown): Promise<void> {
  await write(REVEAL_SETTING, toRevealPolicy(value));
  broadcastBrowserViewport(host);
}

export async function setBrowserOpenBeside(host: BrowserViewportHost, beside: boolean): Promise<void> {
  await write(OPEN_BESIDE_SETTING, beside);
  broadcastBrowserViewport(host);
}
