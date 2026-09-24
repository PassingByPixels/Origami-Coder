// Tools pane — the two actions offered on a failed tool file: open it in an editor tab, or delete
// it. Own module rather than another toolsPane.ts case, per that file's rule of one self-contained
// unit per file.
// Safety property: every other write on this pane takes a tool ID and resolves the path itself.
// These two can't — a failed file produced no tool and so has no id, and the path IS the identity —
// so the path is re-checked against a fresh engine read and refused unless the engine still names
// it.

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
 * Drop one file from a re-read payload's problem list. The engine scans tool
 * files once per instance and caches the answer, so a just-deleted file is
 * still in the list an immediate re-read returns — this patches it out so the
 * card doesn't spring back, same pattern as `patchToolStatePayload`.
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
    // To the recycle bin, not straight off disk: this is the user's own source file and the pane
    // offers no undo.
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
