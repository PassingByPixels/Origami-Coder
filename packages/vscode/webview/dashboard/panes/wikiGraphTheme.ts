// The memory graph's paint side: fixed palette, look constants, and two
// tints derived from it (hub halo, vignette).
//
// The palette is fixed to the Harbour look on every theme
// (HARBOUR_GRAPH_THEME). Only the canvas is pinned; the pane stays
// live-themed, so render() paints its own opaque ground instead of
// clearing to transparent.
//
// Its own leaf because canvas cannot use `var(--og-*)`; it needs concrete
// strings, and the arithmetic is pure so it is testable without a 2d
// context, which jsdom does not have. wikiGraphTheme.test.ts checks the
// literals against theme.css instead.


/** Saturation of every generated cluster/tag hue. Lab `sat`, 68 -> 74. */
export const CLUSTER_SAT = 74;
/** Lightness of every generated cluster/tag hue, on a dark theme. Lab `light`, 58 -> 61. */
export const CLUSTER_LIGHT = 61;
/** Opacity floor for the least-used tag; the most-used is always 1. Lab `tagFloor`, 0.4 -> 0.3. */
export const TAG_ALPHA_FLOOR = 0.3;


/** page<->page wikilink edge opacity. Lab `linkAlpha`, 0.5 -> 0.62. */
export const LINK_ALPHA = 0.62;
/** tag/folder metadata edge opacity, pushed back so wikilinks read as the structure. */
export const META_ALPHA = 0.28;
export const LINK_WIDTH = 1.2;
export const META_WIDTH = 0.6;
/** Perpendicular bow, as a fraction of the edge's own chord; 0 draws a straight line. */
export const EDGE_CURVE = 0.11;


/** How much a node's degree grows its drawn radius (previously size-independent). Lab `degScale`, 0 -> 0.9. */
export const DEG_SCALE = 0.9;
/** Opacity of a node unrelated to the hovered one: dims to black instead of grey. */
export const NODE_DIM = 0;
/** Extra fade on a tag, on top of its frequency alpha: grey satellites around a cluster, not lit ones. */
export const RING_DIM = 0.5;


/** shadowBlur behind every node, in CSS px (divided by zoom so the bloom keeps its visual size). */
export const GLOW = 11;
/** Peak opacity of the radial halo behind a folder hub. Lab `hubHalo`, 0 -> 0.7. */
export const HUB_HALO = 0.7;
export const HUB_HALO_R = 6.5;
/** Opacity the screen-space vignette reaches at the rim. Lab `vignette`, 0 -> 0.55. */
export const VIGNETTE = 0.55;


/** The colours the graph canvas paints with. */
export interface GraphTheme {
  text: string;
  muted: string;
  border: string;
  chat: string;
  accent: string;
  /** --og-error — tag nodes in Theme mode. */
  tag: string;
  /** --og-crane — folder hubs in Theme mode. */
  hub: string;
  bg: string;
}

/** Harbour's palette, copied verbatim from theme.css's `[data-theme="harbour"]`
 *  block. Copies, not reads: the canvas needs concrete strings.
 *  wikiGraphTheme.test.ts checks every field still matches theme.css. */
export const HARBOUR_GRAPH_THEME: GraphTheme = {
  text: '#e6eef4',
  muted: '#6d8598',
  border: '#263a48',
  chat: '#5aa9d4',
  accent: '#3f7e9a',
  tag: '#e0897a',
  hub: '#5aa9d4',
  bg: '#0b1418',
};


/** A cluster/tag hue as a fill colour. The hue itself is DATA (which folder,
 *  which tag); saturation and lightness are the recipe's. */
export function clusterColour(hue: number): string {
  return `hsl(${hue | 0}, ${CLUSTER_SAT}%, ${CLUSTER_LIGHT}%)`;
}

/** A stop for the halo behind a folder hub: the hub's own folder hue, bloomed.
 *  CLUSTER_LIGHT sits well above the pinned ground, so the halo reads as a
 *  bloom around the hub rather than washing into it. */
export function hubHaloColour(hue: number, alpha: number): string {
  return `hsla(${hue | 0}, ${CLUSTER_SAT}%, ${CLUSTER_LIGHT}%, ${alpha})`;
}

/** A vignette stop: the rim recedes toward black, one step past the pinned
 *  ground's own near-black (painting HARBOUR_GRAPH_THEME.bg would be
 *  invisible). Achromatic on purpose: a tinted vignette would fight the hues it darkens. */
export function vignetteColour(alpha: number): string {
  return `rgba(0, 0, 0, ${alpha})`;
}

/** A node's drawn radius: its base size grown by how connected it is.
 *  Hit-testing must use this too, or the clickable disc stops matching the
 *  painted one. */
export function drawRadius(radius: number, degree: number, maxDegree: number): number {
  return radius * (1 + DEG_SCALE * (degree / Math.max(1, maxDegree)));
}

/** Opacity of a tag node by how often the tag is used — the least-used tag
 *  sits at TAG_ALPHA_FLOOR, the most-used at 1. */
export function tagAlpha(count: number, maxCount: number): number {
  if (maxCount <= 0) return 1;
  return TAG_ALPHA_FLOOR + (1 - TAG_ALPHA_FLOOR) * (count / maxCount);
}
