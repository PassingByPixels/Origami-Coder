// WHERE A WARM TIP GOES — the geometry behind WarmTooltip.svelte.
//
// Pure, and its own file because warmTip.ts (the fuse/grace/warm wire) and
// WarmTooltip.svelte (the one box) are both at their caps, and because
// placement is the part with a second case now: a card on a COMPOSER control
// lines up with the composer, not with the 20px control it hangs off.
//
// Every `x` here is a CENTRE: the box is drawn with `translate(-50%)`.

export interface TipPlacement {
  x: number;
  y: number;
  above: boolean;
}

/** The inset every composer row lines up to (`.model-bar`'s own padding). */
export const COMPOSER_GUTTER = 12;

/**
 * The ordinary case. Below the control, flipped above when it would run off
 * the bottom (the chat composer sits at the foot of its pane, so its tooltips
 * must go up), and clamped to the viewport on both sides so a control near an
 * edge still gets a whole box rather than a squeezed one.
 */
export function tipPlacement(
  r: { left: number; top: number; bottom: number; width: number },
  tipW: number,
  tipH: number,
  vw: number,
  vh: number,
): TipPlacement {
  const below = r.bottom + 8;
  const above = r.top - 8 - tipH;
  const flip = below + tipH > vh - 4 && above > 4;
  const half = tipW / 2;
  const x = Math.max(4 + half, Math.min(r.left + r.width / 2, vw - 4 - half));
  return { x, y: flip ? above : below, above: flip };
}

export interface AnchoredPlacement extends TipPlacement {
  /** The box is capped to the anchor's inner measure, so a long label wraps
   *  inside the composer rather than hanging off it. 0 = no cap of our own. */
  maxWidth: number;
}

/**
 * Hung off a BOX rather than centred on a control: the card's right edge lands
 * on the box's gutter line — the grid every composer row shares — and it sits
 * above the box, because the composer is at the foot of the pane.
 */
export function anchoredPlacement(
  box: { left: number; right: number; top: number },
  tipW: number,
  tipH: number,
  gutter: number = COMPOSER_GUTTER,
): AnchoredPlacement {
  const inner = Math.max(0, box.right - box.left - 2 * gutter);
  const width = Math.min(tipW, inner);
  return { x: box.right - gutter - width / 2, y: box.top - 8 - tipH, above: true, maxWidth: inner };
}

export interface PlaceInput {
  host: { left: number; top: number; bottom: number; width: number };
  box: { w: number; h: number };
  /** The composer's box when this tip asked to be anchored to it, else null. */
  area: { left: number; right: number; top: number } | null;
  view: { w: number; h: number };
}

/** The one call the component makes: anchored when it has an anchor, centred
 *  otherwise. Keeps the branch out of the box's `$effect`. */
export function placeTip({ host, box, area, view }: PlaceInput): AnchoredPlacement {
  if (area) return anchoredPlacement(area, box.w, box.h);
  return { ...tipPlacement(host, box.w, box.h, view.w, view.h), maxWidth: 0 };
}
