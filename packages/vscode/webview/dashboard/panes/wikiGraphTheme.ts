// The memory graph's paint side: the FIXED palette the canvas draws with, the
// "Showcase" recipe's look constants, and the two tints derived from that
// palette — the hub halo and the vignette.
//
// Why the palette is FIXED. The graph used to resolve --og-* through
// getComputedStyle at draw time, so it wore whichever of the five themes was
// running. On the light ones (Ember's warm paper above all) the result was hard
// to look at. The owner's call on 2026-08-27 is that the graph keeps its
// Harbour look on EVERY theme; HARBOUR_GRAPH_THEME below is that pin. Only the
// CANVAS is pinned — the pane around it (toolbar, legend, detail popover) stays
// live-themed, which is why render() paints its own opaque ground instead of
// clearing to transparent and letting the pane show through.
//
// Why this is its own leaf. Canvas cannot use `var(--og-*)`; it needs concrete
// strings. The palette, and the arithmetic that turns a colour into a halo or a
// vignette stop, is pure — so it belongs where it can be tested without a 2d
// context, which jsdom does not have at all.
//
// This file is DELIBERATELY not in architecture.test.ts's THEMED_FILES list,
// for the same reason labyrinthExport.ts is not: its job is producing concrete
// colour values for a canvas that cannot read var(), so "no literal colour" is
// the wrong rule for it. The literals it holds are Harbour's own tokens — the
// test parses the real theme.css and asserts each one still agrees — plus the
// vignette's achromatic pole.
//
// PROVENANCE. The numbered constants are dials from the graph lab
// (origami-graph-lab-v2/index.html), frozen at the owner's signed-off
// `showcase` values (lab L1176-1185). The lab's dial UI does not ship.

// --- Colour axis ------------------------------------------------------------

/** Saturation of every generated cluster/tag hue. Lab `sat`, 68 -> 74. */
export const CLUSTER_SAT = 74;
/** Lightness of every generated cluster/tag hue, on a DARK theme.
 *  Lab `light`, 58 -> 61. */
export const CLUSTER_LIGHT = 61;
/** Opacity floor for the least-used tag; the most-used tag is always 1.
 *  Lab `tagFloor`, 0.4 -> 0.3. */
export const TAG_ALPHA_FLOOR = 0.3;

// --- Edges ------------------------------------------------------------------

/** page<->page wikilink edge opacity. Lab `linkAlpha`, 0.5 -> 0.62. */
export const LINK_ALPHA = 0.62;
/** tag/folder metadata edge opacity — pushed well back so the wikilinks read
 *  as the structure. Lab `metaAlpha`, 1 -> 0.28. */
export const META_ALPHA = 0.28;
/** Wikilink edge width in CSS px (divided by zoom at draw time).
 *  Lab `linkWidth`, 1.1 -> 1.2. */
export const LINK_WIDTH = 1.2;
/** Metadata edge width. Lab `metaWidth`, 0.7 -> 0.6. */
export const META_WIDTH = 0.6;
/** Perpendicular bow, as a fraction of the edge's own chord. 0 draws the old
 *  straight line. Lab `edgeCurve`, 0 -> 0.11. */
export const EDGE_CURVE = 0.11;

// --- Nodes ------------------------------------------------------------------

/** How much a node's degree grows its drawn radius. Lab `degScale`, 0 -> 0.9 —
 *  degree used to drive gravity only and never size. */
export const DEG_SCALE = 0.9;
/** Opacity of a node unrelated to the hovered one. Lab `nodeDim`, 0.15 -> 0:
 *  the owner's call is that hovering blacks the rest out entirely rather than
 *  leaving a grey ghost. */
export const NODE_DIM = 0;
/** Extra fade on a tag, on top of its frequency alpha — the reference look is
 *  grey satellites around a cluster, not lit ones. Lab `ringDim`, 1 -> 0.5. */
export const RING_DIM = 0.5;

// --- Atmosphere -------------------------------------------------------------

/** shadowBlur behind every node, in CSS px (divided by zoom at draw time so
 *  the bloom keeps its visual size). Lab `glow`, 0 -> 11. */
export const GLOW = 11;
/** Peak opacity of the radial halo behind a folder hub. Lab `hubHalo`,
 *  0 -> 0.7. */
export const HUB_HALO = 0.7;
/** Halo radius as a multiple of the hub's drawn radius. Lab `hubHaloR`,
 *  5 -> 6.5. */
export const HUB_HALO_R = 6.5;
/** Opacity the screen-space vignette reaches at the rim. Lab `vignette`,
 *  0 -> 0.55. */
export const VIGNETTE = 0.55;

// --- The pinned palette -----------------------------------------------------

/** The colours the graph canvas paints with. */
export interface GraphTheme {
  /** --og-text — page nodes in Theme mode, and a lit label. */
  text: string;
  /** --og-text-muted — a resting label, and a muted node. */
  muted: string;
  /** --og-border — metadata edges. */
  border: string;
  /** --og-chat — the selected node. */
  chat: string;
  /** --og-accent — wikilink edges and the selection ring. */
  accent: string;
  /** --og-error — tag nodes in Theme mode. */
  tag: string;
  /** --og-crane — folder hubs in Theme mode. */
  hub: string;
  /** --og-bg — the ground, painted opaque under every frame. */
  bg: string;
}

/** Harbour's palette, copied verbatim from theme.css's `[data-theme="harbour"]`
 *  block, and what the graph paints with on EVERY theme (owner pin,
 *  2026-08-27). Copies, not reads: the canvas needs concrete strings and the
 *  running theme is no longer the source. wikiGraphTheme.test.ts parses the
 *  same block out of the real theme.css and asserts every field still agrees,
 *  so a Harbour retint cannot silently leave the graph behind. */
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

// --- Tints ------------------------------------------------------------------

/** A cluster/tag hue as a fill colour. The hue itself is DATA (which folder,
 *  which tag); saturation and lightness are the recipe's. */
export function clusterColour(hue: number): string {
  return `hsl(${hue | 0}, ${CLUSTER_SAT}%, ${CLUSTER_LIGHT}%)`;
}

/** A stop for the halo behind a folder hub: the hub's OWN folder hue, bloomed.
 *
 *  CLUSTER_LIGHT sits well above the pinned ground, so the halo reads as a
 *  bloom AROUND the hub rather than washing into it. This used to take a
 *  `dark` flag and mirror the lightness about 50% on Ember's warm paper; the
 *  graph no longer wears the light themes, so the mirror went with them. */
export function hubHaloColour(hue: number, alpha: number): string {
  return `hsla(${hue | 0}, ${CLUSTER_SAT}%, ${CLUSTER_LIGHT}%, ${alpha})`;
}

/** A vignette stop.
 *
 *  The rim recedes toward black, one step past the pinned ground's own
 *  near-black. Painting HARBOUR_GRAPH_THEME.bg itself would be invisible —
 *  that colour is what the frame already started from. The pole is achromatic
 *  on purpose: a tinted vignette would fight the folder hues it darkens. */
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
