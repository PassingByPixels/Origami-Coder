// The race-Compare editor tab: opens a diff screen in its own tab (same webview mount as the
// board) so siblings' differences are visible, rather than the old in-column numbers table.
// One tab per race group (root+groupId), revealed/reused on re-click.

import * as vscode from 'vscode';
import type { WebviewHost } from '../DashboardPanel';

/** The race identity injected into the compare webview. `siblings` is a snapshot at click
 *  time; the screen fetches live diffs on demand and offers manual refresh. */
export interface RaceCompareParams {
  root: string;
  groupId: string;
  base: string;
  siblings: Array<{ id: string; name: string; state: string; agentName: string; model: string }>;
}

/** The narrow slice of DashboardPanel the tab needs: attach a secondary webview carrying the
 *  race payload. */
export interface CompareTabHost {
  attachView(host: WebviewHost, bundle: 'chat', soloSessionId: undefined, memory: boolean, board: boolean, raceCompare: RaceCompareParams): void;
}

// One tab per (root::groupId); revealed on re-click instead of a duplicate.
const tabs = new Map<string, vscode.WebviewPanel>();

/** Open (or reveal) a race group's Compare screen in its own editor tab. */
export function openRaceCompareTab(
  context: vscode.ExtensionContext,
  host: CompareTabHost,
  params: RaceCompareParams,
): void {
  const key = `${params.root}::${params.groupId}`;
  const existing = tabs.get(key);
  if (existing) { existing.reveal(); return; }
  const panel = vscode.window.createWebviewPanel(
    'origami.raceComparePanel',
    `Compare · ${params.base}`,
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
  host.attachView(wvHost, 'chat', undefined, false, false, params);
}
