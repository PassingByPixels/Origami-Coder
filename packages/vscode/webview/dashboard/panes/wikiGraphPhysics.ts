// Pure force-directed physics for the memory-graph mind map, extracted
// from WikiSearchPane.svelte for unit-testable maths with no canvas/DOM.
// WikiSearchPane owns the node/edge arrays and the render loop; this module owns the numbers.

/** A node's physics-relevant fields — a subset of WikiSearchPane's GraphNode,
 *  generic so this module never needs to import that component's types. */
export interface PhysicsNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  fixed?: boolean;
}


/** Below this separation, repulsion is computed as if the pair were this
 *  far apart — two near-coincident nodes would else diverge as 1/d^2 and explode in one step. */
export const MIN_DIST = 8;

/** Ceiling on a single pair's repulsion force, before the alpha scale. Belt
 *  and suspenders alongside MIN_DIST. */
export const MAX_PAIR_FORCE = 60;

/** Repulsive force the separation (dx, dy) = b - a contributes to a (the
 *  caller negates it onto b); pure, so integrating pairs needs no node lookups. */
export function repulsionForce(dx: number, dy: number, repulsion: number, alpha: number): { fx: number; fy: number } {
  let dist = Math.sqrt(dx * dx + dy * dy);
  // Exact coincidence has no direction to push along — nudge on a fixed
  // axis so the pair separates over a few ticks instead of sitting locked forever.
  if (dist === 0) { dx = 1; dist = 1; }
  const magDist = Math.max(MIN_DIST, dist);
  const force = Math.min(MAX_PAIR_FORCE, repulsion / (magDist * magDist)) * alpha;
  return { fx: (dx / dist) * force, fy: (dy / dist) * force };
}


/** Per-tick speed ceiling, before the Euler update, so no tick can teleport a node. */
export const MAX_SPEED = 40;

export function clampVelocity(vx: number, vy: number, maxSpeed: number = MAX_SPEED): { vx: number; vy: number } {
  const speed = Math.sqrt(vx * vx + vy * vy);
  if (speed <= maxSpeed || speed === 0) return { vx, vy };
  const scale = maxSpeed / speed;
  return { vx: vx * scale, vy: vy * scale };
}

/** Generous world radius; a settled layout never touches it, only a runaway gets pulled back. */
export const WORLD_BOUND_RADIUS = 4000;

export function clampToBounds(x: number, y: number, cx: number, cy: number, radius: number = WORLD_BOUND_RADIUS): { x: number; y: number } {
  const dx = x - cx, dy = y - cy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist <= radius || dist === 0) return { x, y };
  const scale = radius / dist;
  return { x: cx + dx * scale, y: cy + dy * scale };
}


/** Starting energy — matches the old fixed non-drag alpha. */
export const ALPHA_HOT = 0.4;
/** Energy while a node is actively being dragged — new energy the settle
 *  curve doesn't have, so dragging always gets this regardless of progress. */
export const ALPHA_DRAG = 0.8;
/** Floor the curve cools to — never fully zero, so a graph that's still
 *  ticking (e.g. mid-coast) keeps nudging rather than freezing mid-step. */
export const ALPHA_MIN = 0.02;
/** Ticks the cooling curve takes to go from ALPHA_HOT to ALPHA_MIN. */
export const SETTLE_ITERS = 300;

/** Alpha for the current tick. Dragging always re-heats to ALPHA_DRAG
 *  regardless of progress; otherwise a quadratic decay near the floor. */
export function annealAlpha(progress: number, dragging: boolean): number {
  if (dragging) return ALPHA_DRAG;
  const p = Math.max(0, Math.min(1, progress));
  return ALPHA_MIN + (ALPHA_HOT - ALPHA_MIN) * (1 - p) ** 2;
}


export interface PriorPhysicsState { x: number; y: number; vx: number; vy: number; fixed?: boolean; }

/** Position-preserving merge for a rebuild: any id in `prior` keeps its
 *  x/y/vx/vy/fixed so a settled layout doesn't re-randomize; new ids
 *  stay as seeded. Mutates in place. */
export function mergeNodePositions<N extends PhysicsNode>(freshNodes: N[], prior: ReadonlyMap<string, PriorPhysicsState>): N[] {
  for (const n of freshNodes) {
    const p = prior.get(n.id);
    if (!p) continue;
    n.x = p.x; n.y = p.y; n.vx = p.vx; n.vy = p.vy; n.fixed = p.fixed;
  }
  return freshNodes;
}

/** True if any fresh id is absent from `prior` — worth re-heating, or should stay cool. */
export function hasNewNodes<N extends { id: string }>(freshNodes: N[], prior: ReadonlyMap<string, unknown>): boolean {
  return freshNodes.some((n) => !prior.has(n.id));
}


/** ~137.5deg, the golden angle. Placing point N at N*GOLDEN_ANGLE is the
 *  sunflower-seed spiral: successive points spread far apart in angle. */
export const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** Deterministic, evenly-spread seed position, replacing a random
 *  ring/box whose collision odds rise with node count (radius grows with sqrt(t), area-uniform). */
export function spiralSeed(index: number, total: number, cx: number, cy: number, minR: number, maxR: number): { x: number; y: number } {
  const angle = index * GOLDEN_ANGLE;
  const t = total > 1 ? index / (total - 1) : 0;
  const r = minR + (maxR - minR) * Math.sqrt(t);
  return { x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r };
}
