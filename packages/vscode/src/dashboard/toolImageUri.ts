// toolImageUri.ts — WHICH LOCAL FILES A CHAT WEBVIEW MAY DRAW, AND ITS URI.
//
// A webview loads a local file only from a path under one of its
// `localResourceRoots`, and the chat surfaces were created with exactly one:
// the extension's own `out/webview`. A read-image card needs the file the model
// read, so the chat surfaces also get the WORKSPACE folders and the OS temp
// directory (where render pipelines write — the evidence for this ticket was
// four PNGs under %TEMP%\origami). Nothing wider: an image outside those roots
// keeps the placeholder rather than widening what a webview may read.
//
// The roots are read back OFF the webview, so a surface that was not given them
// silently draws no picture instead of emitting a URI that CSP would block.

import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { desktopImageFallback } from './desktopImageFallback';
import type { ReadImageFacts } from './toolImageCard';

/** The roots a chat webview is created with: the bundle, the workspace, temp. */
export function chatResourceRoots(extensionUri: vscode.Uri): vscode.Uri[] {
  return [
    vscode.Uri.joinPath(extensionUri, 'out', 'webview'),
    ...(vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri),
    vscode.Uri.file(os.tmpdir()),
  ];
}

/** True when `file` is inside `root` — a path compare, never a string prefix:
 *  `C:\a\bb` must not count as inside `C:\a\b`. `path.relative` on win32 already
 *  case-folds (verified: `path.win32.relative('C:\\WS','c:\\ws\\a') === 'a'`),
 *  so no separate lower-cased fallback is needed on Windows. */
export function isUnderRoot(file: string, root: string): boolean {
  if (!file || !root) return false;
  const rel = path.relative(root, file);
  if (!rel) return true;
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** The `<img src>` for one read-image card on one webview, or undefined when
 *  that webview may not read the file. */
export function webviewImageSrc(webview: vscode.Webview, facts: ReadImageFacts): string | undefined {
  const roots = (webview.options.localResourceRoots ?? []).filter((root) => root.scheme === 'file');
  if (!roots.some((root) => isUnderRoot(facts.path, root.fsPath))) return undefined;
  return webview.asWebviewUri(vscode.Uri.file(facts.path)).toString();
}

/** `webviewImageSrc`, then the host's own capped copy of the bytes when the
 *  file is outside every root (t-fdw2j2) — DESKTOP surfaces only. Never the
 *  phone's webview shim: it has no roots, so this would data-URI every read;
 *  DashboardPanel.ts gates callers on `isRemoteWebview`. */
export function desktopImageSrc(webview: vscode.Webview, facts: ReadImageFacts): string | undefined {
  return webviewImageSrc(webview, facts) ?? desktopImageFallback(facts);
}
