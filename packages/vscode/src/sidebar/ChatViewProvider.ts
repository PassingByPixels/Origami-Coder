// Chat view provider — the CHAT half of the split (secondary side bar).
//
// Renders the CHAT bundle in a VS Code WebviewView, driven by the DashboardPanel
// session machinery over the SHARED-HOST path: whichever of the chat/config views
// resolves first creates the host, and the second attaches to it.

import * as vscode from 'vscode';
import { DashboardPanel, type WebviewHost } from '../dashboard/DashboardPanel';
import { chatResourceRoots } from '../dashboard/toolImageUri';
import { watchChatView } from '../elastic/elasticWindow';

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
      // The bundle, plus the roots a read-image card draws its picture from
      // (toolImageUri.ts) — a webview may load a local file from nowhere else.
      localResourceRoots: chatResourceRoots(this.context.extensionUri),
    };

    // t-w2qv3o: this view on screen is what makes its chat "active" (elastic/sessionSignals.ts).
    watchChatView(webviewView);

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
      // Shared-host resolve: render the CHAT bundle. If the config view already
      // created the host this attaches to it, else it becomes the primary host.
      await DashboardPanel.resolveSharedView(host, this.context, 'chat');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      vscode.window.showErrorMessage(`Origami: chat view failed to start: ${msg}`);
    }
  }
}
