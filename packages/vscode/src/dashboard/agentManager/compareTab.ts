// Agent Manager - compareTab.ts (S6d): the race-Compare EDITOR TAB. Passing's
// UAT verdict on the S6c in-column numbers table was that it doesn't let him SEE
// how siblings differ, so Compare now opens a real diff SCREEN in its own editor
// tab (the same createWebviewPanel + dashboard-bundle mount the board itself uses,
// with a new __ORIGAMI_RACE_COMPARE__ payload). ONE tab per race group, keyed by
// root+groupId and revealed/reused on re-click. Kept OUT of DashboardPanel (which
// is at its line cap) behind a thin dispatch: the panel only guarantees the shared
// host exists, then hands off here.

import * as vscode from 'vscode';
import type { WebviewHost } from '../DashboardPanel';

/** The race identity injected into the compare webview (window.__ORIGAMI_RACE_COMPARE__).
 *  siblings is a SNAPSHOT taken when Compare was clicked - the screen fetches live
 *  per-file diffs on demand (amRaceFileDiffs) and offers a manual refresh; it does
 *  not live-poll the roster (v1). */
export interface RaceCompareParams {
  root: string;
  groupId: string;
  base: string;
  siblings: Array<{ id: string; name: string; state: string; agentName: string; model: string }>;
}

/** The narrow slice of DashboardPanel the tab needs: attach a secondary webview
 *  carrying the race payload (renderHtmlFor injects the global; the shared host
 *  routes the tab's am* messages + fans broadcasts to it). */
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
