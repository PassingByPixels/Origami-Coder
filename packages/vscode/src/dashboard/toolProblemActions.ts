// Tools pane — the two actions offered on a FAILED TOOL FILE (the error card
// the pane draws above the grid): open it in an editor tab, or delete it.
//
// Its own module rather than another case in toolsPane.ts, on that file's own
// established rule: this is one self-contained unit (validate a path, act on
// it, patch the answer) and toolsPane.ts had 30 lines of slack against a 150
// cap, which the delete's safety check alone would have eaten.
//
// THE SAFETY PROPERTY THIS FILE EXISTS FOR: every other write on this pane
// takes a tool ID and resolves the path itself, because a path from a webview
// is not a fact. These two cannot — a failed file produced no tool and so has
// no id, and the path IS the identity. So the path is re-checked against a
// FRESH engine read and refused unless the ENGINE is still naming it. Nothing
// the webview invents can become an unlink; the worst a compromised or stale
// message can do is name a file the engine already reported as broken.

import * as vscode from 'vscode';
import type { ToolProblem } from '../acpExtTypes';
import { catalogPayload } from './toolsCatalog';
import type { ToolsPaneHost } from './toolsCatalog';

export const TOOL_PROBLEM_MESSAGE_TYPES = ['toolsOpenProblem', 'toolsDeleteProblem'] as const;

/** The failed-file list out of a `toolsData` payload. Always an array — every
 *  shape catalogPayload can answer with carries one (toolsCatalog.ts). */
export function payloadProblems(payload: Record<string, unknown>): ToolProblem[] {
  const problems = payload['problems'];
  return Array.isArray(problems) ? (problems as ToolProblem[]) : [];
}

/**
 * Drop one file from a re-read payload's problem list.
 *
 * The engine scans the tool files ONCE per instance and answers from that
 * cache (`InstanceState` in engine/src/tool/registry.ts — no file watcher), so
 * a file deleted a moment ago is still in the list the immediate re-read comes
 * back with, and the card would spring straight back onto the screen. Same
 * stale-cache patch `patchToolStatePayload` applies after a state write, and
 * `pluginsPane.ts` after an enable/disable.
 */
export function patchProblemRemoved(payload: Record<string, unknown>, file: string): Record<string, unknown> {
  return { ...payload, problems: payloadProblems(payload).filter((p) => p.file !== file) };
}

/** Open the file, or delete it — after proving the ENGINE named it. */
export async function handleToolProblemMessage(
  host: ToolsPaneHost,
  type: string,
  raw: unknown,
): Promise<void> {
  if (typeof raw !== 'string' || !raw) return;
  const payload = await catalogPayload(host);
  if (!payloadProblems(payload).some((p) => p.file === raw)) {
    // Refused, and said out loud. A silent no-op here would read exactly like
    // a delete that worked, on the one control that removes a file.
    vscode.window.showErrorMessage(`${raw} is not a tool file the engine reported — nothing was opened or deleted.`);
    host.post(payload);
    return;
  }
  const uri = vscode.Uri.file(raw);
  if (type === 'toolsOpenProblem') {
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: false });
    return;
  }
  try {
    // To the recycle bin, not straight off the disk: this is the user's own
    // source file and the pane offers no undo of its own.
    await vscode.workspace.fs.delete(uri, { useTrash: true });
  } catch (e) {
    vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
    host.post(payload);
    return;
  }
  vscode.window.showInformationMessage(
    `Deleted ${raw} — reload the window or start a new session to clear it from the engine's list.`,
  );
  host.post(patchProblemRemoved(payload, raw));
}
