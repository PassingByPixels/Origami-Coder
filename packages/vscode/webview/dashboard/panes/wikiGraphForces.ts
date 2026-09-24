// The memory graph's "Showcase" force recipe: tuned constants plus four forces,
// kept out of WikiSearchPane.svelte so the maths is testable with no canvas/DOM.
// Every number is a dial from the graph lab, frozen at its `showcase` preset; a
// dial left at its default is absent on purpose.

/** A node's force-relevant fields; matches wikiGraphPhysics.PhysicsNode's shape. */
export interface ForceNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  fixed?: boolean;
}


/** All-pairs repulsion strength. Lab `repel`, 2000 -> 2600. */
export const REPEL = 2600;
/** Folder hub repulsion multiplier, hubs must not pile up. Lab `hubRepelMult`, 10 -> 14. */
export const HUB_REPEL_MULT = 14;
/** Edge spring constant during settle. Lab `attract`, 0.08 -> 0.075. */
export const ATTRACT = 0.075;
/** Sibling (same-folder page) repulsion after settle. Lab `childRepel`, 640 -> 900. */
export const CHILD_REPEL = 900;
/** Page<->page wikilink springs pull at this fraction of a metadata edge. Lab `linkScale`. */
export const LINK_ATTRACT_SCALE = 0.5;
/** Tag springs are slackened so the ring below can win against them. Lab `tagEdgeScale`. */
export const TAG_EDGE_SCALE = 0.22;
/** Velocity retained per settle tick. Lab `dampSettle`, 0.75 -> 0.78. */
export const DAMP_SETTLE = 0.78;
/** Velocity retained per post-settle tick. Lab `dampFollow`, 0.82 -> 0.85. */
export const DAMP_FOLLOW = 0.85;

// --- Perimeter tag ring: each tag gets a radial spring toward a ring around its
// own folder hub, plus a pull toward an evenly spaced slot on it.

/** Ring radius around the folder hub, in world units. Lab `ringRadius`. */
export const RING_RADIUS = 210;
/** Radial spring constant toward the ring. Lab `ringPull`. */
export const RING_PULL = 0.07;
/** How hard a tag is pulled toward its own even-angle slot. Lab `ringSpread`. */
export const RING_SPREAD = 0.5;
/** Fixed gain so `ringSpread` reads 0..1 rather than 0..0.02; not a dial. */
export const RING_SPREAD_GAIN = 0.02;

/** One tag's ring input: the folders of every page carrying it. */
export interface TagRingInput {
  id: string;
  label: string;
  folders: string[];
}

/** The folder a tag rings, and its angle on that ring. */
export interface RingSlot {
  folder: string;
  angle: number;
}

/** Assign every tag to the folder most of its pages live in, then space that
 *  folder's tags evenly around it. Ties go to the folder seen first; a tag with no
 *  carrying pages falls back to '(root)'. Sorted by label so a slot is stable. */
export function ringSlots(tags: readonly TagRingInput[]): Map<string, RingSlot> {
  const byFolder = new Map<string, TagRingInput[]>();
  for (const t of tags) {
    const votes = new Map<string, number>();
    for (const f of t.folders) votes.set(f, (votes.get(f) || 0) + 1);
    let best = '(root)';
    let bestN = -1;
    votes.forEach((n, f) => { if (n > bestN) { bestN = n; best = f; } });
    let g = byFolder.get(best);
    if (!g) { g = []; byFolder.set(best, g); }
    g.push(t);
  }
  const out = new Map<string, RingSlot>();
  byFolder.forEach((group, folder) => {
    const sorted = [...group].sort((a, b) => a.label.localeCompare(b.label));
    sorted.forEach((t, i) => {
      out.set(t.id, { folder, angle: (i / Math.max(1, sorted.length)) * Math.PI * 2 });
    });
  });
  return out;
}

/** Push each tag toward the ring around its folder's anchor, and toward its own
 *  slot on that ring. Mutates vx/vy in place. `anchorOf` returning undefined leaves
 *  that tag alone: a tag whose folder hub is missing has nothing to ring. */
export function applyTagRingForce(
  tags: readonly ForceNode[],
  slots: ReadonlyMap<string, RingSlot>,
  anchorOf: (slot: RingSlot) => { x: number; y: number } | undefined,
): void {
  for (const t of tags) {
    if (t.fixed) continue;
    const slot = slots.get(t.id);
    if (!slot) continue;
    const a = anchorOf(slot);
    if (!a) continue;
    const dx = t.x - a.x, dy = t.y - a.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const f = (dist - RING_RADIUS) * RING_PULL;
    t.vx -= (dx / dist) * f;
    t.vy -= (dy / dist) * f;
    const tx = a.x + Math.cos(slot.angle) * RING_RADIUS;
    const ty = a.y + Math.sin(slot.angle) * RING_RADIUS;
    t.vx += (tx - t.x) * RING_SPREAD * RING_SPREAD_GAIN;
    t.vy += (ty - t.y) * RING_SPREAD * RING_SPREAD_GAIN;
  }
}

// --- Bubble clustering: containment is ONE-SIDED, so only members past their own
// cluster's boundary are pulled back. A two-sided spring toward a target radius
// would evacuate the middle into an annulus; leaving the interior alone lets
// sibling repel keep filling it, so a cluster reads as a disc. The boundary is the
// cluster's own mean member distance, so a 60-page folder gets a bigger bubble.

/** Containment spring constant, applied to the overshoot past the boundary. */
export const BUBBLE_CONTAIN = 0.3;
/** Tangential drift, settle only (see applyBubbleForce). Lab `bubbleSwirl`. */
export const BUBBLE_SWIRL = 0.114;
/** Headroom over the typical member before the boundary bites, so only stragglers
 *  are drawn in. */
export const BUBBLE_HEADROOM = 1.25;
/** Under this many members there is no silhouette to round. */
export const BUBBLE_MIN_MEMBERS = 3;

/** One folder's cluster: its hub and the member pages free to move. */
export interface BubbleGroup {
  hub: { x: number; y: number };
  kids: readonly ForceNode[];
}

/** Round each cluster's silhouette. Mutates member vx/vy in place. `settling` gates
 *  the swirl only: a tangential force still running at rest would hold the layout
 *  above followTick's rest threshold forever, burning a core doing nothing. */
export function applyBubbleForce(groups: readonly BubbleGroup[], settling: boolean): void {
  const swirl = settling ? BUBBLE_SWIRL : 0;
  for (const { hub, kids } of groups) {
    if (kids.length < BUBBLE_MIN_MEMBERS) continue;
    let sum = 0;
    const dists = kids.map((n) => {
      const dx = n.x - hub.x, dy = n.y - hub.y;
      const r = Math.sqrt(dx * dx + dy * dy) || 1;
      sum += r;
      return r;
    });
    const bound = (sum / kids.length) * BUBBLE_HEADROOM;
    for (let i = 0; i < kids.length; i++) {
      const n = kids[i], dist = dists[i];
      const ux = (n.x - hub.x) / dist, uy = (n.y - hub.y) / dist;
      if (dist > bound) {
        const f = (dist - bound) * BUBBLE_CONTAIN;
        n.vx -= ux * f;
        n.vy -= uy * f;
      }
      if (swirl > 0) {
        // Scaled by how far out the member sits, so the rim shears faster than the core.
        const t = Math.min(1, dist / bound);
        n.vx += -uy * swirl * t;
        n.vy += ux * swirl * t;
      }
    }
  }
}


/** Spring constant toward the view centre during settle. Anchored in WORLD space:
 *  using the canvas midpoint as a world point packs every hub onto it. */
export const CENTRE_PULL = 0.031;

/** Below this the canvas box isn't laid out yet (WikiSearchPane's canvasCenter() threshold). */
export const LIVE_CANVAS_MIN = 40;

/** The world point under the middle of the viewport. canvasCenter() returns screen
 *  coordinates; after resetView() installs a fitted zoom and pan the two spaces
 *  diverge, and anchoring an attractive force on the screen midpoint drags the
 *  cloud toward a corner. This inverts the transform render() applies; DPR is
 *  absent on purpose, since it cancels out of the inversion. */
export function viewCentreWorld(
  width: number,
  height: number,
  panX: number,
  panY: number,
  zoom: number,
): { x: number; y: number } {
  if (width < LIVE_CANVAS_MIN || height < LIVE_CANVAS_MIN) return { x: 400, y: 300 };
  return { x: (width / 2 - panX) / zoom, y: (height / 2 - panY) / zoom };
}

/** The velocity a node gains this tick from the centre pull, scaled by the anneal alpha. */
export function centrePullDelta(
  node: { x: number; y: number },
  centre: { x: number; y: number },
  alpha: number,
): { dvx: number; dvy: number } {
  return {
    dvx: (centre.x - node.x) * CENTRE_PULL * alpha,
    dvy: (centre.y - node.y) * CENTRE_PULL * alpha,
  };
}
