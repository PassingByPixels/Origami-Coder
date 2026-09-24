// THE SIDEBAR DOCK as a whole-item carousel (t-qlgav5). At a narrow sidebar
// the seven dock items no longer fit the pill and the last ones clipped off
// the right edge. Fixed here the same way the connections strip fixed its
// own clipping (Mock-Redesign/CHANGES.md change 4): show only whole items,
// page the rest behind arrows in the conn-arrow style.
//
// UNLIKE the connections strip, dock items do NOT stretch to fill the track
// (t-qhzy4k fixed them at 26px, matching the connection squares beside them).
// So this reuses connectionCarouselFit's fitTiles for its COUNT arithmetic
// only — how many ideal-width tiles fit a track — and ignores the WIDTH it
// also returns, which is connectionCarouselFit's own concern (ticket
// requirement: one fit definition, not a second rule).
//
// Pure, because jsdom has no layout: these numbers are the only part of the
// dock's paging that can be proven in a unit test.
import { fitTiles } from '../sidebar/connectionCarouselFit';

/** Matches `.dock-item` in SidebarDock.svelte (t-qhzy4k: 26px, the sidebar's
 *  own scale). */
export const DOCK_ITEM_W = 26;
/** Matches `.dock-track`'s flex gap. */
export const DOCK_GAP = 4;
/** Matches `.dock`'s horizontal padding (5px 8px -> 8 + 8). */
export const DOCK_PAD = 16;
/** Matches `.conn-arrow`'s width — the dock arrows reuse that look. */
export const DOCK_ARROW_W = 20;

export interface DockFit {
  /** Whole items that fit the track — also the page size for an arrow. */
  count: number;
  /** Whether the track needed paging at all. */
  arrows: boolean;
}

/** How many of `total` fixed-width items fit a track of `trackW`, min 1
 *  (never 0 — an unmeasured/zero track still shows something), max `total`. */
function fitCount(trackW: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(1, Math.min(total, fitTiles(trackW, DOCK_ITEM_W, DOCK_GAP).count));
}

/**
 * Decide the page size for the WHOLE pill width (`pillW`, the dock's own
 * measured clientWidth — arrows live inside it, so nothing else needs
 * measuring). All seven items fit -> no arrows, full width available to
 * them. They do not -> arrows claim their own width first, then the
 * remaining track is fit again.
 */
export function dockFit(pillW: number, total: number): DockFit {
  // An unmeasured pill (0 width — the state before first layout, and jsdom's
  // permanent one) shows everything rather than guessing almost nothing
  // fits: a real measurement corrects it a frame later in a real webview,
  // and a test that never resizes should see the same dock it always has.
  if (!(pillW > 0)) return { count: total, arrows: false };
  const inner = Math.max(0, pillW - DOCK_PAD);
  const full = fitCount(inner, total);
  if (full >= total) return { count: total, arrows: false };
  const withArrows = Math.max(0, inner - 2 * (DOCK_ARROW_W + DOCK_GAP));
  return { count: fitCount(withArrows, total), arrows: true };
}

/** Next window start (an arrow's `dir` -1/+1), clamped so the window never
 *  runs past the last item — paging by whole items, never a partial page. */
export function dockPageStart(start: number, dir: number, total: number, count: number): number {
  if (count >= total) return 0;
  const maxStart = total - count;
  return Math.max(0, Math.min(start + dir * count, maxStart));
}
