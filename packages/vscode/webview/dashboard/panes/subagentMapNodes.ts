// subagentMapNodes.ts — where each sub-agent sits on the agent map, and what
// its node says.
//
// LEFT-TO-RIGHT TREE: the chat's hub at the left edge, one node per sub-agent
// in a vertical column to the right, grouped Running / Error / Done. Replaces
// a star (one ring around a centre hub) that overlapped once a chat ran 20+
// agents, with no way to tell which spoke led where (t-di35mj). A column has
// no such ceiling: it grows down, and the panel scrolls to it.
//
// LIVE SESSION ONLY, off the roster the drawer is built from. Pure and DOM-free:
// one node, zero, forty and a group boundary are all testable without SVG.

import { elapsedText } from './subagentFormat';
import { tokensTitle, tokensTotalText } from './subagentTokens';
import { isSettled } from './subagentEntry';
import { subagentLabel } from './subagentLabel';
import type { SubagentRow, SubagentState } from './subagentRows';

/** CSS class the card's line 1 always carries — a `-webkit-line-clamp: 2`
 *  rule in SubagentMap.svelte, never a JS truncation, so `label` below is
 *  always the FULL caption regardless of length. */
export const CARD_LABEL_CLAMP = 'sm-clamp-2';

// viewBox `0 0 100 {height}`: WIDTH is fixed at 100, HEIGHT grows with the
// roster. Everything below is a viewBox unit, not a pixel.
export const TREE_HUB_X = 8;
// 60->64, TREE_NODE_HALF_WIDTH 18->24 (t-f9jxl1): the card widened so a
// typical 3-5 word description fits its identity line without wrapping, and
// gained a third line (model) the narrower card had no room for. The column
// moved right by the same amount the box grew, so the spoke gap and the
// 0..100 edge bound (checked below) both still hold.
export const TREE_NODE_X = 64;
/** Half the node card's drawn width — a caller checks `x + this` stays under 100. */
export const TREE_NODE_HALF_WIDTH = 24;
/** The node card's drawn height, and what row spacing is measured against so
 *  two cards can never overlap. */
export const TREE_NODE_HEIGHT = 9;
const ROW_STEP = 13; // centre-to-centre step within one group; clears TREE_NODE_HEIGHT
const GROUP_GAP = 6; // extra distance at a group boundary, on top of ROW_STEP
const TOP_MARGIN = 10;
const BOTTOM_MARGIN = 10;
/** Never shrinks below the old star's square, so one or two agents still fill
 *  the panel instead of leaving a sliver of blank space. */
export const TREE_MIN_HEIGHT = 100;

export interface MapNode {
  key: string; // the roster key — click target identity and {#each} key
  label: string; // `<type> · T<n> · <description>` — subagentLabel.ts, the card's line 1
  title: string;
  model: string; // '' when the card carried no model
  state: SubagentRow['state'];
  age: string; // '4s' / '2m 05s' / '' for an unknown age — subagentFormat.ts
  tokens: string; // '54.3k tokens', or '' against an engine that rides no tokens
  thinking: string; // t-gvz8t0 `thinking · ~5.4k tokens · 2m 05s` while it reasons, else ''
  tokensDetail: string; // the full token breakdown for the node's `title=`, or ''
  openable: boolean; // false: no child session, so no transcript to open
  /** Which band this node is in — the first row of each new value is where
   *  the component draws that band's heading. */
  group: 'running' | 'error' | 'done';
  x: number;
  y: number;
}

export interface MapTree {
  nodes: MapNode[];
  /** Always `TREE_HUB_X`, vertically centred on the node column. */
  hubX: number;
  hubY: number;
  /** The viewBox height this roster needs — `TREE_MIN_HEIGHT` or taller. */
  height: number;
}

/** Running/queued (still out) before error/failed (stopped badly) before done
 *  (stopped clean) — the dot colour already groups error with failed
 *  (SubagentMap.svelte's `.sm-error, .sm-failed`), and queued joins running
 *  the same way the drawer's own Running band does (subagentRows.ts). */
function mapGroup(state: SubagentState): MapNode['group'] {
  if (!isSettled(state)) return 'running';
  return state === 'error' || state === 'failed' ? 'error' : 'done';
}
const GROUP_RANK: Record<MapNode['group'], number> = { running: 0, error: 1, done: 2 };

/**
 * One node per row, stacked top to bottom within its group, groups in
 * Running / Error / Done order, oldest-first inside each. Returns the column
 * plus the hub position and viewBox height the component cannot get right by
 * eye once the roster passes a screenful.
 */
export function mapTree(rows: ReadonlyArray<SubagentRow>): MapTree {
  const ordered = [...rows].sort((a, b) => GROUP_RANK[mapGroup(a.state)] - GROUP_RANK[mapGroup(b.state)]);

  const nodes: MapNode[] = [];
  let y = TOP_MARGIN;
  let lastGroup: MapNode['group'] | null = null;
  for (const row of ordered) {
    const group = mapGroup(row.state);
    if (lastGroup !== null) y += group === lastGroup ? ROW_STEP : ROW_STEP + GROUP_GAP;
    lastGroup = group;
    nodes.push({
      key: row.key, label: subagentLabel(row), title: row.title, model: row.model ?? '', state: row.state,
      age: elapsedText(row.elapsedMs), tokens: tokensTotalText(row.tokens), tokensDetail: tokensTitle(row.tokens),
      thinking: row.thinking,
      openable: !!row.taskSessionId, group, x: TREE_NODE_X, y: round(y),
    });
  }

  const height = nodes.length === 0
    ? TREE_MIN_HEIGHT
    : Math.max(TREE_MIN_HEIGHT, round(y + TREE_NODE_HEIGHT / 2 + BOTTOM_MARGIN));
  const hubY = nodes.length === 0 ? round(height / 2) : round((nodes[0].y + nodes[nodes.length - 1].y) / 2);
  return { nodes, hubX: TREE_HUB_X, hubY, height };
}

/** Two decimals: smooth at any pane width, few enough to write by hand in a test. */
function round(v: number): number {
  return Math.round(v * 100) / 100;
}
