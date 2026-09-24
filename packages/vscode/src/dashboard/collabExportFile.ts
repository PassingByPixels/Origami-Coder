// "Export collab" — the save dialog and the write, the only part of a
// collab tab that talks to VS Code chrome. The webview renders the markdown
// (it holds the polled snapshot and roster); the host writes it verbatim.
import * as path from 'node:path';
import * as vscode from 'vscode';

export async function saveCollabMarkdown(markdown: string, title: string): Promise<void> {
  try {
    // An empty export is refused rather than written: a zero-byte file named
    // after a collab reads as "the transcript was lost", not "there was none".
    if (!markdown.trim()) {
      vscode.window.showErrorMessage('Nothing to export — this collab has nothing in it yet.');
      return;
    }
    const slug = title.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'collab';
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(`origami-collab-${slug}-${stamp}.md`),
      filters: { Markdown: ['md'] },
      saveLabel: 'Export collab',
    });
    if (!uri) return;
    await vscode.workspace.fs.writeFile(uri, Buffer.from(markdown, 'utf8'));
    vscode.window.showInformationMessage(`Collab exported to ${path.basename(uri.fsPath)}`);
  } catch (err) {
    console.error('exportCollab failed', err);
    vscode.window.showErrorMessage(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
