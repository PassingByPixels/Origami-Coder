// sidebarFocus.ts — t-x3a89j: the sidebar chat webview tells the host when it has keyboard focus. In grid
// mode the sidebar shows every chat as a tile; only its active tile, and only while the sidebar has focus, is
// the chat the user works in (src/elastic/sessionSignals.ts inFocus). VS Code gives a WebviewView no focus
// event, so the page reports its own window focus. Kept out of ChatPane.svelte (at its cap).

type FocusWindow = {
  addEventListener(type: 'focus' | 'blur', listener: () => void): void;
  removeEventListener(type: 'focus' | 'blur', listener: () => void): void;
};

/** Post the focus state now and on each change; the returned cleanup stops and posts `false`. */
export function watchSidebarFocus(win: FocusWindow, doc: { hasFocus(): boolean }, post: (focused: boolean) => void): () => void {
  let last: boolean | null = null;
  const tell = (focused: boolean) => {
    if (focused === last) return;
    last = focused;
    post(focused);
  };
  const onFocus = () => tell(true);
  const onBlur = () => tell(false);
  win.addEventListener('focus', onFocus);
  win.addEventListener('blur', onBlur);
  tell(doc.hasFocus());
  return () => {
    win.removeEventListener('focus', onFocus);
    win.removeEventListener('blur', onBlur);
    tell(false);
  };
}

/** t-xp0dzr: a sidebar ChatPane tells the host which chat it displays (its active chat; in grid, the focused tile)
 *  now, and null when that ends (the next id, or unmount). The host counts a chat as on screen through the sidebar
 *  only by this report (src/elastic/sessionSignals.ts inFocus), never by its own selected chat. */
export function reportSidebarChat(sessionId: string | null, post: (sessionId: string | null) => void): () => void {
  post(sessionId);
  return () => post(null);
}
