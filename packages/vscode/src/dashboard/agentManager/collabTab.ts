// Collab stream screen in its own editor tab, mirroring mapTab.ts/compareTab.ts: same
// createWebviewPanel + dashboard-bundle mount, with a __ORIGAMI_COLLAB__ payload. One tab per
// collab id, revealed/reused on re-click.

import * as vscode from 'vscode';
import type { WebviewHost } from '../DashboardPanel';
import { waitingTitleFor } from '../tabIcon';

/** The collab identity injected into the webview. Deliberately just the identity — the pane
 *  polls collab_state for everything else, so a tab left open can't show a stale roster. */
export interface CollabTabParams {
  id: string;
  title: string;
}

/** The narrow slice of DashboardPanel the tab needs. Mirrors MapTabHost. */
export interface CollabTabHost {
  attachView(
    host: WebviewHost,
    bundle: 'chat',
    soloSessionId: undefined,
    memory: boolean,
    board: boolean,
    raceCompare: undefined,
    repoMap: undefined,
    collab: CollabTabParams,
  ): void;
}

// One tab per collab id; revealed on re-click instead of a duplicate.
const tabs = new Map<string, vscode.WebviewPanel>();

/** Open (or reveal) a collab's stream screen in its own editor tab. */
export function openCollabTab(
  context: vscode.ExtensionContext,
  host: CollabTabHost,
  params: CollabTabParams,
): void {
  const key = params.id;
  const existing = tabs.get(key);
  if (existing) { existing.reveal(); return; }
  const panel = vscode.window.createWebviewPanel(
    'origami.collabPanel',
    `Collab · ${params.title}`,
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'out', 'webview')],
    },
  );
  panel.iconPath = {
    light: vscode.Uri.joinPath(context.extensionUri, 'media', 'origami-icon-light.svg'),
    dark: vscode.Uri.joinPath(context.extensionUri, 'media', 'origami-icon-dark.svg'),
  };
  tabs.set(key, panel);
  panel.onDidDispose(() => { if (tabs.get(key) === panel) tabs.delete(key); });
  const wvHost: WebviewHost = {
    webview: panel.webview,
    onDidDispose: (listener, thisArgs, disposables) => panel.onDidDispose(listener, thisArgs, disposables),
    reveal: () => panel.reveal(),
    dispose: () => panel.dispose(),
  };
  host.attachView(wvHost, 'chat', undefined, false, false, undefined, undefined, params);
}

/** Badge (or un-badge) a collab's tab. Reuses the chat tab's waitingTitleFor printer so one
 *  idiom means "needs you" across every editor tab type. A collab with no open tab is a
 *  no-op — a background room's ring is the sidebar's job. */
export function setCollabTabWaiting(collabId: string, waiting: boolean): void {
  const panel = tabs.get(collabId);
  if (!panel) return;
  panel.title = waitingTitleFor(panel.title, waiting ? 1 : 0);
}
