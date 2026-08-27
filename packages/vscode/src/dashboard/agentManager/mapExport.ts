// "Save this map as a page" — the map screen's export, and the ONLY part of the
// map tab that talks to the user through VS Code chrome.
//
// The SAME split the Labyrinth export uses (DashboardPanel's `exportLabyrinth`
// case): the webview asks, the extension host owns the save dialog and the write.
// One thing is reversed, deliberately. The Labyrinth's webview owns its content,
// because only it can see the rendered SVG and the resolved theme; a repo map's
// content is host-side and pure (renderMapHtml over the map snapshot the tab was
// opened with), so nothing but the REQUEST crosses the wire. That also means the
// exported page is byte-identical to the .origami/map/map.html a run writes,
// rather than a second rendering of the same picture.

import * as path from 'node:path';
import * as vscode from 'vscode';
import { renderMapHtml } from './mapHtml';
import type { RepoMap } from './mapSchema';

/** Render the map to a standalone page and let the user put it somewhere.
 *
 *  The suggested name deliberately does NOT start with "origami": a file whose
 *  final segment starts with that word matches Origami Folio's file:// intercept,
 *  and Folio would hijack the page into its Studio as "not a deck" — the same
 *  trap the Labyrinth export documents. */
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
