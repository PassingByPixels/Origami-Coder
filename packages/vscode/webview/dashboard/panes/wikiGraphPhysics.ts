// Pure force-directed physics for the memory-graph mind map, extracted from
// WikiSearchPane.svelte so the maths — force clamping, alpha annealing, the
// rebuild merge, and seed placement — is unit-testable with no canvas/DOM.
// Mirrors the modelGrouping.ts pattern: WikiSearchPane owns the node/edge
// arrays and drives the render loop; this module owns the numbers.

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

// --- Repulsion: distance-floored, magnitude-capped -------------------------

/** Below this separation, repulsion is computed as if the pair were exactly
 *  this far apart. Without a floor, two near-coincident nodes (an increasingly
 *  likely spawn as the page count grows) produce a force that diverges as
 *  1/distance^2, and one Euler step throws them apart explosively. */
export const MIN_DIST = 8;

/** Ceiling on a single pair's repulsion force, before the alpha scale. Belt
 *  and suspenders alongside MIN_DIST: even with the distance floor, this caps
 *  what any one pair can contribute to a node's velocity in one tick. */
export const MAX_PAIR_FORCE = 60;

/** The repulsive force the separation (dx, dy) = b - a contributes to a — the
 *  caller negates it onto b. Pure: takes the separation vector directly
 *  rather than the two points, so integrating many pairs never needs node
 *  lookups here. */
export function repulsionForce(dx: number, dy: number, repulsion: number, alpha: number): { fx: number; fy: number } {
  let dist = Math.sqrt(dx * dx + dy * dy);
  // Exact coincidence (dist === 0) has no direction to push along — nudge on
  // a fixed axis so the pair separates over a few ticks instead of sitting
  // locked together forever.
  if (dist === 0) { dx = 1; dist = 1; }
  const magDist = Math.max(MIN_DIST, dist);
  const force = Math.min(MAX_PAIR_FORCE, repulsion / (magDist * magDist)) * alpha;
  return { fx: (dx / dist) * force, fy: (dy / dist) * force };
}

// --- Integration safety: velocity + world-bounds clamps --------------------

/** Per-tick speed ceiling, applied AFTER all forces are summed and BEFORE the
 *  Euler position update (`x += vx`) — so no single tick, however strong the
 *  accumulated force, can teleport a node. */
export const MAX_SPEED = 40;

export function clampVelocity(vx: number, vy: number, maxSpeed: number = MAX_SPEED): { vx: number; vy: number } {
  const speed = Math.sqrt(vx * vx + vy * vy);
  if (speed <= maxSpeed || speed === 0) return { vx, vy };
  const scale = maxSpeed / speed;
  return { vx: vx * scale, vy: vy * scale };
}

/** Generous world radius around the canvas centre. Large enough that a normal
 *  settled layout never touches it — only a genuine runaway (a live bug, or a
 *  huge graph mid-settle) gets pulled back, so hit-testing/pan never has to
 *  deal with a node at coordinates the canvas can't reach. */
export const WORLD_BOUND_RADIUS = 4000;

export function clampToBounds(x: number, y: number, cx: number, cy: number, radius: number = WORLD_BOUND_RADIUS): { x: number; y: number } {
  const dx = x - cx, dy = y - cy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist <= radius || dist === 0) return { x, y };
  const scale = radius / dist;
  return { x: cx + dx * scale, y: cy + dy * scale };
}

// --- Alpha annealing ---------------------------------------------------

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

/** Alpha for the current tick. `progress` is settleIter / SETTLE_ITERS (the
 *  caller clamps it here too); dragging always re-heats to ALPHA_DRAG,
 *  ignoring progress — the user moving a node is new energy the settle curve
 *  did not have. Quadratic decay so the curve spends most of its life near
 *  the floor rather than lingering hot. */
export function annealAlpha(progress: number, dragging: boolean): number {
  if (dragging) return ALPHA_DRAG;
  const p = Math.max(0, Math.min(1, progress));
  return ALPHA_MIN + (ALPHA_HOT - ALPHA_MIN) * (1 - p) ** 2;
}

// --- Rebuild merge: existing nodes keep their physics state -----------------

export interface PriorPhysicsState { x: number; y: number; vx: number; vy: number; fixed?: boolean; }

/** Position-preserving merge for a rebuild: a freshly-computed node keeps its
 *  own (label/degree/etc) fields, but any id that existed in `prior` has its
 *  x/y/vx/vy/fixed OVERWRITTEN back to what it was — so a settled layout does
 *  not get re-randomized every time buildGraph() re-runs (e.g. on every wiki
 *  file save). Genuinely new ids are left exactly as the caller seeded them.
 *  Mutates `freshNodes` in place (matching the plain-array, non-$state house
 *  style) and also returns it. */
export function mergeNodePositions<N extends PhysicsNode>(freshNodes: N[], prior: ReadonlyMap<string, PriorPhysicsState>): N[] {
  for (const n of freshNodes) {
    const p = prior.get(n.id);
    if (!p) continue;
    n.x = p.x; n.y = p.y; n.vx = p.vx; n.vy = p.vy; n.fixed = p.fixed;
  }
  return freshNodes;
}

/** True if `freshNodes` contains at least one id absent from `prior` — the
 *  signal the caller uses to decide whether a rebuild is worth re-heating
 *  (new content to integrate) or should stay cool (an unrelated refresh that
 *  changed nothing this graph cares about). */
export function hasNewNodes<N extends { id: string }>(freshNodes: N[], prior: ReadonlyMap<string, unknown>): boolean {
  return freshNodes.some((n) => !prior.has(n.id));
}

// --- Seed placement: golden-angle spiral, not a random ring/box -------------

/** ~137.5deg, the golden angle. Placing point N at angle N*GOLDEN_ANGLE is the
 *  classic sunflower-seed spiral: successive points are always spread far
 *  apart in angle, so no two ever land near the same ray from the centre. */
export const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** Deterministic, evenly-spread seed position for the `index`-th of `total`
 *  new nodes, replacing a random ring/box (whose collision odds rise with the
 *  node count — exactly the near-coincident spawns that feed the repulsion
 *  blowup this module also guards against). Radius grows with sqrt(t) so
 *  points are AREA-uniform across the band, not bunched near the inner edge. */
export function spiralSeed(index: number, total: number, cx: number, cy: number, minR: number, maxR: number): { x: number; y: number } {
  const angle = index * GOLDEN_ANGLE;
  const t = total > 1 ? index / (total - 1) : 0;
  const r = minR + (maxR - minR) * Math.sqrt(t);
  return { x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r };
}
