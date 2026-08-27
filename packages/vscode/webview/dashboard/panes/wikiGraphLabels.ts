// Label density for the memory-graph mind map — which TEXT the graph shows at
// each step of the Labels control. Extracted from WikiSearchPane.svelte so the
// states are one declared contract instead of a condition chain in the render
// loop plus a separate `{#if}` in the template, which is how the pane grew a
// state ('none') that still showed text.
//
// The four states, and the text each leaves on screen:
//
//   hubs   folder-hub labels. Hover/selected and live-filter hits also draw.
//   all    every node's label. Hover/selected and filter hits also draw.
//   none   no STANDING node labels — but hover, selection and filter hits all
//          still draw, and the legend strip under the canvas stays put.
//   clean  no canvas text at all, under any condition, and no legend strip.
//          Nodes and edges only.
//
// `clean` is deliberately about READOUTS, not controls: the search input, the
// button row and the zoom cluster all stay, because they are the only way back
// out of a state whose point is that nothing on it is readable.

export type LabelMode = 'hubs' | 'all' | 'none' | 'clean';

/** Click order of the Labels button. The first three are the order the control
 *  already shipped with; `clean` is appended so a user's existing muscle
 *  memory for hubs -> all -> none still lands where they expect. */
export const LABEL_MODES = ['hubs', 'all', 'none', 'clean'] as const;

/** Guard for the persisted webview preference. State written by an older build
 *  outlives a release, so an unrecognised value must fall back to the default
 *  rather than become a fifth mode that renders nothing. */
export function isLabelMode(value: unknown): value is LabelMode {
  return LABEL_MODES.includes(value as LabelMode);
}

export function nextLabelMode(mode: LabelMode): LabelMode {
  return LABEL_MODES[(LABEL_MODES.indexOf(mode) + 1) % LABEL_MODES.length];
}

/** The word the button shows after `Labels: `. */
export function labelModeText(mode: LabelMode): string {
  return mode.charAt(0).toUpperCase() + mode.slice(1);
}

/** The per-node facts the label decision needs, named rather than passed as a
 *  run of booleans — the call site reads four of these in a row. */
export interface LabelContext {
  /** A folder hub (`type === 'namespace'`), the only node kind `hubs` labels. */
  isHub: boolean;
  isHovered: boolean;
  isSelected: boolean;
  /** Matches the live filter. Only meaningful while `queryActive`. */
  isQueryHit: boolean;
  /** A live filter is running, so the graph is already showing hits only. */
  queryActive: boolean;
}

export function drawsNodeLabel(mode: LabelMode, node: LabelContext): boolean {
  if (mode === 'clean') return false;
  if (node.isHovered || node.isSelected) return true;
  // Under a filter the graph draws hits only, so a non-hit's label would land
  // on empty space where its node used to be — hits only, whatever the mode.
  if (node.queryActive) return node.isQueryHit;
  return mode === 'all' || (mode === 'hubs' && node.isHub);
}

/** The pane's non-interactive TEXT readouts, which no label mode before
 *  `clean` ever controlled — which is why `none` still left them showing:
 *    - `.graph-legend`, the strip under the canvas (colour axis + link key)
 *    - `.page-count`, the `N pages` / `hits/total` figure in the control strip
 *  Controls are not readouts and are never hidden: `.search-input`, the
 *  `.action-btn` row and the `.zoom-btn` cluster all survive `clean`, since
 *  they are the only way back out of it. */
export function showsReadouts(mode: LabelMode): boolean {
  return mode !== 'clean';
}
