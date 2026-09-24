// ctxCardPin.ts — holding the context breakdown card open (t-ru13hb item 5).
//
// The card was hover-only: it opened on entering the gauge wrap, left on
// leaving it, and carried `pointer-events: none`, so the numbers could be read
// but never held still or pointed at. Pinned, it stays until the user says
// otherwise — Escape, or a pointer down anywhere that is not the card or the
// control that pinned it.
//
// A LEAF because InputBar.svelte is a capped file and this is two document
// listeners plus their teardown, none of which is about the composer.

import { suspendTipWatch } from '../../shared/warmTipWatch';

/**
 * Install the dismissal rules for as long as the card is pinned. Returns the
 * teardown, which is what an `$effect` hands back.
 *
 * `roots` are the elements a pointer may go down on WITHOUT unpinning: the
 * card itself, and the gauge wrap that holds the pin. Nulls are tolerated —
 * a `bind:this` is null until the element is in the DOM.
 *
 * `pointerdown`, not `click`: a drag that starts inside the card and ends
 * outside it is not the user leaving, and a click would say it was.
 */
export function watchPinned(roots: Array<HTMLElement | null>, unpin: () => void): () => void {
  const inside = (t: EventTarget | null) =>
    t instanceof Node && roots.some((r) => r?.contains(t));
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') unpin(); };
  const onDown = (e: PointerEvent) => { if (!inside(e.target)) unpin(); };
  window.addEventListener('keydown', onKey);
  document.addEventListener('pointerdown', onDown, true);
  // The warm-tooltip watchdog closes an open tip on ANY pointer move that is
  // not over its node, and on any scroll (warmTipWatch.ts). With the card
  // pinned the pointer is meant to travel over it and its rows scroll, so the
  // watchdog would be firing against a surface the user is deliberately using.
  // Suspended for as long as the pin holds, restored by the teardown.
  const resume = suspendTipWatch();
  return () => {
    window.removeEventListener('keydown', onKey);
    document.removeEventListener('pointerdown', onDown, true);
    resume();
  };
}
