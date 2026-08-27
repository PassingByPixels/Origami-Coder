// Agent Manager - mapTab.ts (S15): the repo architecture-map EDITOR TAB, mirroring
// compareTab.ts exactly. A "View map" board action opens a real map SCREEN in its
// own editor tab (the same createWebviewPanel + dashboard-bundle mount the board and
// the race Compare tab use, with a new __ORIGAMI_REPO_MAP__ payload). ONE tab per
// repo root, revealed/reused on re-click. Kept OUT of DashboardPanel (at its line
// cap) behind a thin dispatch: the panel reads+validates map.json, then hands off here.

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

/** What the WEBVIEW receives (window.__ORIGAMI_REPO_MAP__) — the same thing plus
 *  the map's isometric geometry, computed here and serialized with it.
 *
 *  This is the seam that replaces a mirror. The webview cannot import a runtime
 *  value out of src/ (tsconfig.webview.json pins rootDir to `webview/`), and the
 *  house answer to that is to declare the value twice with a drift guard reading
 *  both files. That trade is right for a five-entry constant table and wrong for
 *  ~180 lines of geometry, whose only possible guard is a byte-compare. So the
 *  numbers travel with the map instead, and RepoMapScreen.svelte imports only the
 *  TYPES of this shape — which the compiler checks. Two renderers, one layout,
 *  no drift possible. */
export interface RepoMapPayload extends RepoMapParams {
  layout: IsoLayout;
}

/** The narrow slice of DashboardPanel the tab needs: attach a secondary webview
 *  carrying the map payload (renderHtmlFor injects the global; the shared host
 *  fans broadcasts to it). Mirrors CompareTabHost. */
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
  // The screen's ONE message: "save this map as a page". Subscribed HERE and not
  // in DashboardPanel's switch, where the sibling exports live: that file sits at
  // 6335 lines against a cap of 6336, so a case there would force a raise on the
  // largest file in the repo — the exact move the ratchet exists to prevent.
  panel.webview.onDidReceiveMessage((m: { type?: unknown }) => {
    if (m && m.type === 'exportRepoMap') void saveMapHtml(params.map, params.name);
  });
  // The layout is computed ONCE, here, at open — it is a pure function of the
  // map, so a tab reopened on the same map draws byte-identical geometry.
  host.attachView(wvHost, 'chat', undefined, false, false, undefined, { ...params, layout: layoutMap(params.map) });
}
