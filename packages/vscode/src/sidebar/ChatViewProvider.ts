// Chat view provider — the CHAT half of the split (the secondary side
// bar, top-right; the crane is the brand hero here).
//
// Renders the CHAT bundle (ChatView.svelte → compact crane header + honest
// status badge + the real ChatPane / InputBar / new-chat tabs) inside a VS
// Code WebviewView, and drives it with the DashboardPanel session
// machinery via the SHARED-HOST path (resolveSharedView): whichever of the
// chat/config views resolves first creates the DashboardPanel + bootstraps
// the ACP session; the second attaches to the same host so both surfaces
// share one session loop and agree on model/connection/theme status.

import * as vscode from 'vscode';
import { DashboardPanel, type WebviewHost } from '../dashboard/DashboardPanel';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  /** Matches the view id contributed in package.json (`contributes.views`). */
  public static readonly viewId = 'origami.chatView';

  constructor(private readonly context: vscode.ExtensionContext) {}

  async resolveWebviewView(
    webviewView: vscode.WebviewView,
    _ctx: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'out', 'webview'),
      ],
    };

    const host: WebviewHost = {
      webview: webviewView.webview,
      onDidDispose: (listener, thisArgs, disposables) =>
        webviewView.onDidDispose(listener, thisArgs, disposables),
      reveal: () => {
        /* VS Code owns side-bar focus; nothing to do. */
      },
      dispose: () => {
        /* The view's lifecycle is VS Code's, not ours. */
      },
    };

    try {
      // Shared-host resolve: render the CHAT bundle. If the config view
      // already created the host, this attaches to it; otherwise it
      // becomes the primary host and bootstraps the session.
      await DashboardPanel.resolveSharedView(host, this.context, 'chat');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      vscode.window.showErrorMessage(`Origami: chat view failed to start: ${msg}`);
    }
  }
}
