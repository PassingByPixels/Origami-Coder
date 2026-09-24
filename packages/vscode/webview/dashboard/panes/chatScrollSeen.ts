// chatScrollSeen.ts — what the reader last SAW, per scroller (t-v47ytt). Split out of
// chatScrollRearm.ts, whose rules read it, because our own scrolls must write it too: the follow
// (ChatPane), the pill's pin (chatPin.ts) and a prepend's held place (historyScroll.ts).
//
// THE BUG. Only scroll events wrote the record. Growth and our own scrolls fire no scroll event
// before the next frame is painted, so the record kept the height of the LAST SCROLL EVENT. Measured
// in Chromium with the real leaves, rows every 10ms: (1) our follow moved 0 -> 8, the next row landed
// before that move's event, and the event (top 8 of 549, no record yet) read as the reader leaving:
// the follow dropped with no input, 6 runs of 6, and the jump pill came up; (2) the reader then moved
// to the bottom they could see, a row landed before the event, and the rule measured it against a
// height several rows old: the pill stayed up, 3 runs of 3. With this record: 0 of 6, 0 of 3.

/** A scroller as the reader last saw it: growth moves `height`, not `top`.
 *  `echo`: the browser still owes a scroll event for OUR last move. */
export interface Seen { top: number; height: number; client: number; echo?: boolean; }
const seen = new WeakMap<Element, Seen>();

export const seenOf = (el: Element): Seen | undefined => seen.get(el);
export const forgetSeen = (el: Element): boolean => seen.delete(el);

/** A scroll event landed: the reader's own position, and no event is owed any more. */
export function recordScroll(el: Element): void {
  seen.set(el, { top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight });
}

/**
 * Record the frame the reader will see. `ours` is for our own scrolls: when one moved the scroller,
 * its event is owed, and rearmOnScroll must not read that event as the reader. Without `ours` a
 * record that an upward wheel deleted stays deleted: only the wheel's own scroll event restores it.
 */
export function noteSeen(el: Element, ours = false): void {
  const prev = seen.get(el);
  if (!ours && !prev) return;
  const top = el.scrollTop;
  const echo = ours ? prev?.echo === true || top !== (prev?.top ?? 0) : prev?.echo === true && top === prev.top;
  seen.set(el, { top, height: el.scrollHeight, client: el.clientHeight, echo });
}
