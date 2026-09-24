import type * as vscode from 'vscode';

/** Attach one webview to the panel's broadcast + inbound wiring, tearing down any previous wiring
 *  for the same webview first — a sidebar view re-resolves without disposing, and before this guard
 *  the same webview sat in `extraViews` twice, delivering every post and handling every inbound
 *  send twice. */
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
    // A stale teardown (old view's onDidDispose firing after a re-attach) must not evict the new
    // wiring — guard on identity.
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
