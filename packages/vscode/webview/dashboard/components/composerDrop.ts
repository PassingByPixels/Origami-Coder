// COMPOSER DROP STATE — "Drop to attach" (CHANGES.md round 2, change 28).
//
// `dragenter` and `dragleave` are COUNTED, never toggled. The composer has
// children (the textarea, the pills, the buttons), and crossing from the
// composer onto one of them fires a `dragleave` for the composer before the
// `dragenter` for the child: a single boolean flickers off mid-drag and the
// drop hint strobes. The depth only reaches zero when the pointer has really
// left the whole box.
//
// A `drop` resets to zero outright: the browser sends no closing `dragleave`
// for the element the drop landed on, so a decrement would leave the hint up.

export type DragEventKind = 'enter' | 'leave' | 'drop';

/** Pure: the next depth for one event. Never negative — a drag that began
 *  outside the webview can deliver a `dragleave` with no matching enter. */
export function nextDepth(depth: number, kind: DragEventKind): number {
  if (kind === 'enter') return depth + 1;
  if (kind === 'leave') return Math.max(0, depth - 1);
  return 0;
}

/** Pure: is the drop hint showing? */
export function isDropping(depth: number): boolean {
  return depth > 0;
}
