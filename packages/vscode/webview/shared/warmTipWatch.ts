// warmTipWatch.ts — closes a warm tooltip whose control went away.
//
// Owner, 0.4.156: `mouseleave` never fires for an element hidden/removed
// under the pointer. While a tip is open the document is watched instead: a
// pointer move off the open node, any scroll, the node losing its box, or
// (t-xtim9n, 0.4.179 reopened) the webview going hidden/unfocused (a tab
// switch fires none of the rest) closes the tip.

let node: HTMLElement | null = null;
let close: (() => void) | null = null;

/** Pure enough to test: an open node with no box (hidden or detached) is gone. */
export function nodeGone(el: HTMLElement): boolean {
  return !el.isConnected || el.getClientRects().length === 0;
}

// SUSPENSION (t-ru13hb item 5): a PINNED surface is meant to be hovered/scrolled, which this watchdog would else read as "moved on".
let suspended = 0;

function onPointer(e: Event): void {
  if (suspended || !node || !close) return;
  const t = e.target as Node | null;
  if (nodeGone(node) || !(t && node.contains(t))) close();
}
function closeNow(): void { if (!suspended) close?.(); }
function onVisibility(): void { if (document.hidden) closeNow(); }

/** Hold the watchdog off; the release is idempotent and last-release re-arms it. */
export function suspendTipWatch(): () => void {
  suspended += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    suspended = Math.max(0, suspended - 1);
  };
}

export function watchOpenTip(el: HTMLElement, onClose: () => void): void {
  unwatchOpenTip();
  node = el;
  close = onClose;
  document.addEventListener('pointermove', onPointer, true);
  document.addEventListener('scroll', closeNow, true);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('blur', closeNow);
}

export function unwatchOpenTip(): void {
  document.removeEventListener('pointermove', onPointer, true);
  document.removeEventListener('scroll', closeNow, true);
  document.removeEventListener('visibilitychange', onVisibility);
  window.removeEventListener('blur', closeNow);
  node = null;
  close = null;
}
