// chatPin.ts — going back to the bottom, against a bottom that is still moving.
//
// One `scrollTop = scrollHeight` is not enough. A message landing between the
// click and the scroll it caused leaves the scroller SHORT, and the product's
// stick gate (chatScroll.ts) then reads that gap as "the reader is reading" and
// stops following again — measured in the mock: a click with two messages in
// flight landed 220px short and never followed after. So the assignment is
// repeated across a few frames until the bottom is actually reached.
//
// The `pinning` flag is the other half: while we are re-assigning, our own
// scroll handler must not read the attempt as the USER moving. Callers ask
// `isPinning(el)` before treating a scroll event as evidence.

import { markScrollAnchor } from './chatScroll';
import { noteSeen } from './chatScrollSeen';

/** How many frames the re-pin keeps trying. Five covers the arrival races seen
 *  in the mock without leaving a runaway loop fighting a deliberate scroll. */
export const PIN_FRAMES = 5;

const pinning = new WeakSet<Element>();

/** True while pinToBottom is still re-assigning this scroller. */
export const isPinning = (el: Element): boolean => pinning.has(el);

/**
 * Land at the bottom and STAY there across up to `PIN_FRAMES` frames.
 * `raf` is injectable so the rule can be driven frame by frame in a test —
 * jsdom has no rendering loop, and a test that waited on a real one would be
 * asserting the timer, not the re-pin.
 */
export function pinToBottom(
  el: Element,
  raf: (cb: () => void) => void = (cb) => requestAnimationFrame(cb),
  frames: number = PIN_FRAMES,
): void {
  pinning.add(el);
  let left = frames;
  const step = () => {
    el.scrollTop = el.scrollHeight;
    markScrollAnchor(el); // read back: the browser clamps, fractionally
    noteSeen(el, true); // this step's scroll event may land after more growth (t-v47ytt)
    left -= 1;
    if (left > 0) raf(step);
    else pinning.delete(el);
  };
  step();
}

/** The pane's one caller: re-pin the scroller belonging to this session. The
 *  cells are keyed by data-session-id (a bind:this would race in multi-up), so
 *  the lookup is the same one ChatPane's scrollToBottom already makes. */
export function pinSessionCell(sessionId: string): void {
  const cell = document.querySelector<HTMLDivElement>(`.cell-messages[data-session-id="${sessionId}"]`);
  if (cell) pinToBottom(cell);
}
