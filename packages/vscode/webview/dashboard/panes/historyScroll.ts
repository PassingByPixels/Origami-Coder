// historyScroll.ts — the reader's place across a prepend (t-ucnp7t, plan 3.5 "Scroll anchor").
//
// Rows inserted ABOVE the viewport push everything down by exactly the height they add. Keeping
// `scrollHeight - scrollTop` (the distance from the top of the viewport to the end of the content)
// across the insert, and setting it back after the render, holds the row under the reader's eye
// still. The same arithmetic SubagentTranscriptView uses for its own older steps.
//
// The anchor is re-marked after the move (chatScroll.ts): without it the stick gate would read our
// own jump as the reader scrolling, and stop or start following on its own.

import { tick } from 'svelte';
import { markScrollAnchor } from './chatScroll';
import { noteSeen } from './chatScrollSeen';

/** Pure: where scrollTop must go after the content grew, to keep `keep`. */
export function heldScrollTop(scrollHeightAfter: number, keep: number): number {
  return Math.max(0, scrollHeightAfter - keep);
}

/** Record the place now; put it back once the prepend has rendered. `el` is injectable for a test;
 *  in the pane it is this chat's own scroller, looked up by id like every other caller. */
export function holdPlace(sessionId: string, el: HTMLElement | null = document.querySelector<HTMLElement>(`.cell-messages[data-session-id="${sessionId}"]`), after: () => Promise<void> = tick): void {
  if (!el) return;
  const keep = el.scrollHeight - el.scrollTop;
  void after().then(() => {
    el.scrollTop = heldScrollTop(el.scrollHeight, keep);
    markScrollAnchor(el);
    noteSeen(el, true); // the move's scroll event may land after more growth (t-v47ytt)
  });
}
