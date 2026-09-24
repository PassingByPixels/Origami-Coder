// HOW WIDE IS THIS BOX, live — the one piece of DOM the Labyrinth's canvas
// needs and the only reason it held a `$effect` of its own.
//
// Extracted from LabyrinthMapCanvas.svelte when the analytics Flight view landed
// and that file went over its architecture cap: the canvas's job is to CHOOSE
// and place a view, and measuring is a separate concern with a separate failure
// mode (an environment with no ResizeObserver at all).
//
// jsdom has neither the observer nor a layout engine, so under test this reports
// nothing and every consumer must render correctly at width 0 — which is the
// same fallback a real panel uses before its first frame.

/**
 * Report `el`'s client width now and on every resize. Returns the teardown, or
 * undefined when there is nothing to observe — so a Svelte `$effect` can return
 * it directly and an absent observer is simply no subscription, never a crash.
 */
export function observeWidth(
  el: HTMLElement | undefined,
  onWidth: (px: number) => void,
): (() => void) | undefined {
  if (!el || typeof ResizeObserver === 'undefined') return undefined;
  const ro = new ResizeObserver(() => onWidth(el.clientWidth));
  ro.observe(el);
  onWidth(el.clientWidth);
  return () => ro.disconnect();
}
