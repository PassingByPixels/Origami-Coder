// warmTipWatch.ts — closes a warm tooltip whose control went away.
//
// Owner, 0.4.156: the scroll-anchor pill's label ("Jump to the newest
// message...") stayed on screen after the pill hid. `mouseleave` is not fired
// when the hovered element is hidden or removed under the pointer, so the
// action's own leave handler never runs. While a tip is open the document is
// watched instead: the next pointer move that is not over the open node, any
// scroll, or the node losing its box closes the tip.

let node: HTMLElement | null = null;
let close: (() => void) | null = null;

/** Pure enough to test: an open node with no box (hidden or detached) is gone. */
export function nodeGone(el: HTMLElement): boolean {
  return !el.isConnected || el.getClientRects().length === 0;
}

// SUSPENSION (t-ru13hb item 5). A surface the user has PINNED open — the context
// breakdown card — is one the pointer is meant to travel over and the wheel to
// scroll, which is just what this watchdog reads as "the user has moved on". It
// is held off while such a surface holds, rather than each one fighting it.
let suspended = 0;

function onPointer(e: Event): void {
  if (suspended || !node || !close) return;
  const t = e.target as Node | null;
  if (nodeGone(node) || !(t && node.contains(t))) close();
}
function onScroll(): void {
  if (suspended) return;
  close?.();
}

/** Hold the watchdog off. Returns the release (idempotent); nested callers each
 *  hold their own and the last release re-arms it. */
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
  document.addEventListener('scroll', onScroll, true);
}

export function unwatchOpenTip(): void {
  document.removeEventListener('pointermove', onPointer, true);
  document.removeEventListener('scroll', onScroll, true);
  node = null;
  close = null;
}
