// agentMapLayout.ts — where every card, chip and wire of the agent map sits
// (t-z1xlfy). Pure and DOM-free: jsdom has no layout, so the geometry lives here
// and is tested here; SubagentMap.svelte only places what this returns.
//
// The mockup's algorithm (Mock-Redesign tool-elements, "Sub-agents pull-out and
// agent map"), in pixels of the unscaled world:
//   - a column per tier: the hub at the left, tier n at LEFT0 + (n - 1) * COLW;
//   - order: top-level agents Running, Failed, Done; each agent is followed by
//     its own sub-agents (the same order, recursively), then its background tasks;
//     the chat's own background tasks come last, in tier 1;
//   - rows: each item takes the next free row, EXCEPT a first child, which
//     starts on its parent's row;
//   - wires: rounded elbows. The trunk runs down just right of the parent
//     (18 px), so every child of one parent joins at the same point on it.
// Cards and chips have FIXED heights (the CSS pins them), which is what lets
// the rows be computed without measuring anything.

import { hubLine, isFailedState } from './subagentCard';
import type { SubagentRow } from './subagentRows';
import { isSettled } from './subagentEntry';
import { HUB, type AgentTreeView, type TreeAgent, type TreeTask } from './agentTree';

export const COL0 = 16;
export const HUB_W = 196;
export const HUB_H = 62;
export const LEAD = 40;
export const COL_W = 272;
export const CARD_W = 234;
export const CARD_H = 50;
export const CHIP_H = 40;
export const GAP = 8;
export const TOP = 16;
/** Wire anchor below a box's top: the card's first line, the chip's centre line. */
const HUB_ANCHOR = 22;
const CARD_ANCHOR = 16;
const CHIP_ANCHOR = 13;
/** The trunk's offset right of the parent, and the elbow radius. */
const TRUNK = 18;
const R = 6;

export const ZOOM_MIN = 0.15;
export const ZOOM_MAX = 1.5;
export const ZOOM_STEP = 1.25;

export type MapGroup = 'running' | 'failed' | 'done';

export interface MapItem {
  key: string;
  /** The key of the node the wire comes from: another item or HUB. */
  owner: string;
  depth: number;
  x: number;
  y: number;
  w: number;
  h: number;
  agent?: TreeAgent;
  task?: TreeTask;
  /** The wire's class: a card's group, or `bg` for a chip. */
  wire: MapGroup | 'bg';
  path: string;
}

export interface MapLayout {
  items: MapItem[];
  hub: { x: number; y: number; w: number; h: number };
  width: number;
  height: number;
  tiers: number;
}

export function mapGroup(state: TreeAgent['row']['state']): MapGroup {
  if (!isSettled(state)) return 'running';
  return isFailedState(state) ? 'failed' : 'done';
}
const RANK: Record<MapGroup, number> = { running: 0, failed: 1, done: 2 };
const byGroup = (a: TreeAgent, b: TreeAgent) => RANK[mapGroup(a.row.state)] - RANK[mapGroup(b.row.state)];

/** A rounded elbow from (x1, y1) to (x2, y2): along, down the trunk, along. */
export function elbowPath(x1: number, y1: number, x2: number, y2: number): string {
  if (Math.abs(y2 - y1) < 1) return `M${x1},${y1} H${x2}`;
  const mx = x1 + TRUNK, s = y2 > y1 ? 1 : -1;
  return `M${x1},${y1} H${mx - R} Q${mx},${y1} ${mx},${y1 + s * R} V${y2 - s * R} Q${mx},${y2} ${mx + R},${y2} H${x2}`;
}

export function layoutMap(tree: AgentTreeView): MapLayout {
  const kids = new Map<string, TreeAgent[]>();
  for (const a of tree.agents) kids.set(a.parent, [...(kids.get(a.parent) ?? []), a]);
  const tasks = new Map<string, TreeTask[]>();
  for (const t of tree.tasks) tasks.set(t.owner, [...(tasks.get(t.owner) ?? []), t]);

  const order: Array<{ owner: string; depth: number; agent?: TreeAgent; task?: TreeTask }> = [];
  const walk = (owner: string, depth: number) => {
    for (const a of [...(kids.get(owner) ?? [])].sort(byGroup)) {
      order.push({ owner, depth, agent: a });
      walk(a.row.key, depth + 1);
      for (const t of tasks.get(a.row.key) ?? []) order.push({ owner: a.row.key, depth: depth + 1, task: t });
    }
  };
  walk(HUB, 1);
  for (const t of tasks.get(HUB) ?? []) order.push({ owner: HUB, depth: 1, task: t });

  const hub = { x: COL0, y: TOP, w: HUB_W, h: HUB_H };
  const at = new Map<string, { x: number; y: number; w: number; chip: boolean }>([[HUB, { x: hub.x, y: hub.y, w: hub.w, chip: false }]]);
  const items: MapItem[] = [];
  let next = TOP;
  order.forEach((o, i) => {
    const prev = order[i - 1];
    const firstChild = !!prev?.agent && o.depth === prev.depth + 1 && o.owner === prev.agent.row.key;
    const key = o.agent ? o.agent.row.key : o.task!.key;
    const h = o.agent ? CARD_H : CHIP_H;
    const x = COL0 + HUB_W + LEAD + (o.depth - 1) * COL_W;
    const y = firstChild ? items[i - 1].y : next;
    next = Math.max(next, y + h + GAP);
    at.set(key, { x, y, w: CARD_W, chip: !o.agent });
    const p = at.get(o.owner) ?? at.get(HUB)!;
    const py = p.y + (o.owner === HUB ? HUB_ANCHOR : CARD_ANCHOR);
    items.push({
      key, owner: o.owner, depth: o.depth, x, y, w: CARD_W, h,
      ...(o.agent ? { agent: o.agent } : { task: o.task }),
      wire: o.agent ? mapGroup(o.agent.row.state) : 'bg',
      path: elbowPath(p.x + p.w, py, x, y + (o.agent ? CARD_ANCHOR : CHIP_ANCHOR)),
    });
  });

  const tiers = items.reduce((m, it) => Math.max(m, it.depth), 0);
  const width = COL0 + HUB_W + LEAD + Math.max(0, tiers - 1) * COL_W + (tiers ? CARD_W : 0) + 24;
  const height = Math.max(next, TOP + HUB_H + GAP) + 12;
  return { items, hub, width, height, tiers };
}

export const clampZoom = (z: number) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));

/** The zoom that shows the whole world in the view; never above 100 %. */
export function fitZoom(viewW: number, viewH: number, width: number, height: number): number {
  if (viewW <= 0 || viewH <= 0 || width <= 0 || height <= 0) return 1;
  return clampZoom(Math.min(1, (viewW - 16) / width, (viewH - 16) / height));
}

/** The scroll offsets that keep the world point under `around` in place when the zoom changes. */
export function scrollAround(scroll: { left: number; top: number }, around: { x: number; y: number }, from: number, to: number) {
  const f = to / from;
  return { left: (scroll.left + around.x) * f - around.x, top: (scroll.top + around.y) * f - around.y };
}

/** Every item on the chain from `key` up to the hub: what stays bright on hover. */
export function chainOf(items: ReadonlyArray<MapItem>, key: string): Set<string> {
  const byKey = new Map(items.map((it) => [it.key, it]));
  const out = new Set<string>();
  for (let k: string | undefined = key; k && k !== HUB && !out.has(k); k = byKey.get(k)?.owner) out.add(k);
  return out;
}

/** The hub's second line: `This chat · 12 sub-agents in 3 tiers · 2 background · 1.4M tokens`. */
export function mapHubLine(rows: ReadonlyArray<SubagentRow>, tiers: number, backgroundRunning: number): string {
  const parts = hubLine(rows).split(' · ');
  if (tiers > 1) parts[1] += ` in ${tiers} tiers`;
  if (backgroundRunning > 0) parts.splice(2, 0, `${backgroundRunning} background`);
  return parts.join(' · ');
}
