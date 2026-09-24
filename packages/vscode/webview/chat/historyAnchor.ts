// historyAnchor.ts — pure anchoring maths for HistoryDropdown.svelte's
// overlay (t-hb1o0e). jsdom has no layout, so this stays a pure function
// (anchor rect + viewport height -> top/left/width/maxHeight) with its own
// unit tests; the component only calls it once, at open, and applies the
// result as inline style. A LEAF because HistoryDropdown.svelte sits AT its
// line cap and none of this is drawing.

/** The subset of DOMRect the maths needs — a real getBoundingClientRect()
 *  satisfies this structurally, and a test can pass a plain object. */
export interface AnchorRect {
  top: number;
  left: number;
  width: number;
  bottom: number;
}

export interface HistoryPlacement {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

const GAP_BELOW_ANCHOR = 4;
const BOTTOM_MARGIN = 8;

/** Anchors the overlay directly under `anchor`, at its exact width, and
 *  bounds its height to the space left to the viewport's bottom edge — it
 *  is never taller than that, however many rows the list has. */
export function computeHistoryPlacement(anchor: AnchorRect, viewportHeight: number): HistoryPlacement {
  const top = anchor.bottom + GAP_BELOW_ANCHOR;
  const maxHeight = Math.max(0, viewportHeight - top - BOTTOM_MARGIN);
  return { top, left: anchor.left, width: anchor.width, maxHeight };
}
