// The repo architecture-map editor tab, mirroring compareTab.ts: "View map" opens a real
// screen in its own tab (same webview mount, __ORIGAMI_REPO_MAP__ payload). One tab per repo
// root, revealed/reused on re-click.

import * as vscode from 'vscode';
import type { WebviewHost } from '../DashboardPanel';
import { layoutMap, type IsoLayout } from './isoLayout';
import { saveMapHtml } from './mapExport';
import type { RepoMap } from './mapSchema';

/** What the panel hands in: the repo root+name and the validated, stamped map
 *  (a snapshot taken at open). Unchanged, so the panel needs no edit. */
export interface RepoMapParams {
  root: string;
  name: string;
  map: RepoMap;
}

/** What the webview receives: the map plus its isometric geometry, computed here and
 *  serialized with it — the webview can't import a runtime value from src/, and mirroring
 *  ~180 lines of geometry with only a byte-compare guard is the wrong trade. So the numbers
 *  travel with the map; the screen imports only this shape's TYPES, which the compiler checks. */
export interface RepoMapPayload extends RepoMapParams {
  layout: IsoLayout;
}

/** The narrow slice of DashboardPanel the tab needs: attach a secondary webview carrying the
 *  map payload. Mirrors CompareTabHost. */
export interface MapTabHost {
  attachView(host: WebviewHost, bundle: 'chat', soloSessionId: undefined, memory: boolean, board: boolean, raceCompare: undefined, repoMap: RepoMapPayload): void;
}

// One tab per repo root; revealed on re-click instead of a duplicate.
const tabs = new Map<string, vscode.WebviewPanel>();

/** Open (or reveal) a repo's architecture-map screen in its own editor tab. */
export function openRepoMapTab(
  context: vscode.ExtensionContext,
  host: MapTabHost,
  params: RepoMapParams,
): void {
  const key = params.root;
  const existing = tabs.get(key);
  if (existing) { existing.reveal(); return; }
  const panel = vscode.window.createWebviewPanel(
    'origami.repoMapPanel',
    `Map · ${params.name}`,
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
  // The screen's one message, "save this map as a page", is subscribed here rather than in
  // DashboardPanel's switch, which sits at its own line cap.
  panel.webview.onDidReceiveMessage((m: { type?: unknown }) => {
    if (m && m.type === 'exportRepoMap') void saveMapHtml(params.map, params.name);
  });
  // The layout is computed ONCE, here, at open — it is a pure function of the
  // map, so a tab reopened on the same map draws byte-identical geometry.
  host.attachView(wvHost, 'chat', undefined, false, false, undefined, { ...params, layout: layoutMap(params.map) });
}
