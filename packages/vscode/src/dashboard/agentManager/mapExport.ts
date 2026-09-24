// Save the map as a page: the extension host owns the save dialog since the map's content
// is host-side and pure (rendered from the snapshot the tab opened with), so only the
// request crosses the wire, and the exported page is byte-identical to the run-written
// map.html.

import * as path from 'node:path';
import * as vscode from 'vscode';
import { renderMapHtml } from './mapHtml';
import type { RepoMap } from './mapSchema';

/** Render the map to a standalone page. The suggested filename deliberately avoids starting
 *  with "origami" so Origami Folio's file:// intercept doesn't hijack it into its Studio. */
export async function saveMapHtml(map: RepoMap, name: string): Promise<void> {
  try {
    const html = renderMapHtml(map);
    const slug = name.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'repo';
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(`map-${slug}-${stamp}.html`),
      filters: { HTML: ['html'] },
      saveLabel: 'Export map',
    });
    if (!uri) return;
    await vscode.workspace.fs.writeFile(uri, Buffer.from(html, 'utf8'));
    vscode.window.showInformationMessage(`Architecture map exported to ${path.basename(uri.fsPath)}`);
  } catch (err) {
    vscode.window.showErrorMessage(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
