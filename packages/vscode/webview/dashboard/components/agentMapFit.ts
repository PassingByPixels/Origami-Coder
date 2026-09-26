// agentMapFit.ts — t-ze0hwh: HOW BIG THE AGENT MAP PANEL IS.
//
// Before t-z1xlfy the map was a centred panel of min(620px, 94%) x min(520px, 92%): it fit the chat
// panel's width and stopped there. t-z1xlfy made it fill the whole chat panel. The owner wants the
// centred panel back, only slightly larger: the same fit, capped at 1.2x the old size. The scrim
// centres the panel; the map inside keeps its own pan and zoom.
//
// The pure half is apart from the DOM half so the rule is testable without a layout engine
// (the same split as toolcards/readImageFit.ts).

export const PANEL_MAX_W = 744; // 1.2 x 620
export const PANEL_MAX_H = 624; // 1.2 x 520
const FIT_W = 0.94;
const FIT_H = 0.92;

/** The panel's size in a view of `viewW` x `viewH` px. A view not measured yet (0, NaN) gets the cap. */
export function mapPanelSize(viewW: number, viewH: number): { w: number; h: number } {
  const fit = (v: number, share: number, cap: number) => (Number.isFinite(v) && v > 0 ? Math.min(cap, Math.floor(v * share)) : cap);
  return { w: fit(viewW, FIT_W, PANEL_MAX_W), h: fit(viewH, FIT_H, PANEL_MAX_H) };
}

/** Svelte action: sizes the panel from its parent (the scrim over the chat cell) and again when the
 *  parent resizes (a sidebar drag, a window resize). */
export function fitMapPanel(node: HTMLElement): { destroy?: () => void } {
  const parent = node.parentElement;
  const apply = () => {
    const { w, h } = mapPanelSize(parent?.clientWidth ?? 0, parent?.clientHeight ?? 0);
    node.style.width = `${w}px`;
    node.style.height = `${h}px`;
  };
  apply();
  const RO = node.ownerDocument.defaultView?.ResizeObserver;
  const observer = RO && parent ? new RO(apply) : undefined;
  observer?.observe(parent!);
  return { destroy: () => observer?.disconnect() };
}
