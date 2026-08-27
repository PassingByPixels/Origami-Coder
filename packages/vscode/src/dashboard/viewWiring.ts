import type * as vscode from 'vscode';

/** Attach one webview to the panel's broadcast + inbound wiring, tearing down
 *  any PREVIOUS wiring for the same webview first. A sidebar view re-resolves
 *  without disposing (no retainContextWhenHidden), and before this guard the
 *  same webview sat in `extraViews` twice with two message subscriptions —
 *  every post delivered twice, every inbound send handled twice: two prompts
 *  and two echoes for one click. Extracted from DashboardPanel.attachView
 *  (at its cap). Returns the teardown, which the caller's onDidDispose also
 *  runs; a teardown that is no longer the CURRENT wiring for its webview is a
 *  no-op (identity guard), so a late dispose cannot evict a re-attach. */
export function rewireView(
  wiring: Map<vscode.Webview, () => void>,
  extraViews: vscode.Webview[],
  viewSolo: Map<vscode.Webview, string>,
  webview: vscode.Webview,
  onMessage: (m: unknown) => void,
): () => void {
  wiring.get(webview)?.();
  const msgSub = webview.onDidReceiveMessage(onMessage);
  extraViews.push(webview);
  const teardown = () => {
    // A STALE teardown (the old view's onDidDispose firing after a re-attach)
    // must not evict the new wiring — same webview key, so guard on identity.
    if (wiring.get(webview) !== teardown) return;
    const i = extraViews.indexOf(webview);
    if (i >= 0) extraViews.splice(i, 1);
    viewSolo.delete(webview);
    msgSub.dispose();
    wiring.delete(webview);
  };
  wiring.set(webview, teardown);
  return teardown;
}
