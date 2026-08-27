// Pure width-state math for the Labyrinth pane's two resizable columns — the
// run index on the left, the inspector on the right (t-q41pe0, "so the
// right-most or left panel can be slimmed on small monitors") — plus the map
// SVG's own sizing, the same question a third time. Mirrors chatSections.ts's
// clampCollabsHeight (t-kgserq): jsdom has no layout engine, so what is verified
// here with plain numbers is the MATH; the gestures themselves need a human
// eyeball. A separate leaf, deliberately not sharing code with the sidebar's
// divider — the two features share no data.
import { fitScale } from './repoMapPillars';

/** The pane's own CSS defaults (LabyrinthRunIndex.svelte's `.lab-index`,
 *  LabyrinthPane.svelte's `.lab-inspect`) — used only when nothing has been
 *  dragged yet (persisted width is null), so the first drag or keyboard nudge
 *  starts from the width actually on screen rather than an assumed one. */
export const DEFAULT_INDEX_WIDTH = 300;
export const DEFAULT_INSPECT_WIDTH = 340;

/** Floors below which a column reads as unusable — title/meta clipped past
 *  legibility for the run index, label+value rows crowded past reading for
 *  the inspector. */
export const MIN_INDEX_WIDTH = 180;
export const MIN_INSPECT_WIDTH = 220;

/**
 * Clamp a candidate column width to [minPx, 60% of the container] — the
 * floor keeps the column usable, the ceiling keeps one column from
 * swallowing the whole pane. `containerWidthPx <= 0` (no real rect yet — a
 * mount-time default, or jsdom, which has no layout engine) skips the
 * ceiling rather than clamping everything down to the floor.
 */
export function clampColumnWidth(candidatePx: number, containerWidthPx: number, minPx: number): number {
  const ceiling = containerWidthPx > 0 ? Math.max(minPx, containerWidthPx * 0.6) : Infinity;
  return Math.min(ceiling, Math.max(minPx, Math.round(candidatePx)));
}

/** Sizing for the map SVG. Fit off, or a map that already fits, keeps the natural
 *  1-unit-per-pixel box .lab-canvas scrolls; otherwise BOTH axes take the SAME
 *  fitScale k — with preserveAspectRatio "meet" a dropped min-width alone letterboxes
 *  it, and a transform would leave the box full size, so the fit would be cosmetic. */
export function mapFitStyle(boxW: number, boxH: number, fitWidthPx: number): string {
  const k = fitWidthPx > 0 ? fitScale(boxW, fitWidthPx) : 1;
  return k < 1 ? `min-width: 0; height: ${Math.round(boxH * k)}px;` : `min-width: ${boxW}px; height: ${boxH}px;`;
}
