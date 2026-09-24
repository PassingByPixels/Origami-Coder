// "Export" on a side quest — the save dialog and the write, the only part of the
// Side quests pull-out that talks to VS Code chrome (t-f89g49).
//
// Its own module for the reason collabExportFile.ts is: sideQuestsPane.ts holds
// the folder logic and imports no `vscode`, so the one call that needs the editor
// lives where it can be seen rather than inside a handler nobody would look in.
import * as path from 'node:path';
import * as vscode from 'vscode';

/** Write one quest's bytes wherever the owner points the dialog. `bytes` is the
 *  file's own text, handed through verbatim — this function does not re-render,
 *  re-wrap or re-encode it. */
export async function saveSideQuestFile(fileName: string, bytes: string): Promise<void> {
  try {
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(fileName),
      filters: { Markdown: ['md'] },
      saveLabel: 'Export side quest',
    });
    if (!uri) return;
    await vscode.workspace.fs.writeFile(uri, Buffer.from(bytes, 'utf8'));
    vscode.window.showInformationMessage(`Side quest exported to ${path.basename(uri.fsPath)}`);
  } catch (err) {
    console.error('sideQuestExport failed', err);
    vscode.window.showErrorMessage(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
