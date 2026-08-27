// Collabs M1 - collabTab.ts: a collab's stream SCREEN in its own editor tab,
// mirroring mapTab.ts (which mirrors compareTab.ts) exactly. Clicking a collab
// in the sidebar opens the same createWebviewPanel + dashboard-bundle mount the
// board, the race Compare tab and the repo map already use, with a new
// __ORIGAMI_COLLAB__ payload. ONE tab per collab id, revealed/reused on
// re-click. Kept OUT of DashboardPanel behind a thin dispatch.

import * as vscode from 'vscode';
import type { WebviewHost } from '../DashboardPanel';
import { waitingTitleFor } from '../tabIcon';

/** The collab identity injected into the webview (window.__ORIGAMI_COLLAB__).
 *  Deliberately just the identity, never a state snapshot: the pane polls
 *  `collab_state` for everything else, so a tab left open for an hour cannot be
 *  showing an hour-old roster it was seeded with. */
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

/**
 * Badge (or un-badge) a collab's tab — report F12 / 1.13.
 *
 * `waitingTitleFor` is the CHAT tab's printer, reused rather than copied, so one
 * idiom means "this needs you" on every editor tab and the prefix can never
 * stack or drift. WHETHER a room needs the user is collabAttention.ts's rule;
 * this function only knows which panel to write it on, because the map above is
 * the only place that knows.
 *
 * A collab with no open tab is a NO-OP: a background room's ring is the sidebar's
 * job, and there is no title to badge.
 */
export function setCollabTabWaiting(collabId: string, waiting: boolean): void {
  const panel = tabs.get(collabId);
  if (!panel) return;
  panel.title = waitingTitleFor(panel.title, waiting ? 1 : 0);
}
