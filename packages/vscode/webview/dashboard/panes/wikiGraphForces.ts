// The memory graph's "Showcase" force recipe: the tuned constants plus the
// four forces the graph did not have before, kept out of WikiSearchPane.svelte
// so the maths is testable with no canvas/DOM — the same split
// wikiGraphPhysics.ts made for the integrator's clamps.
//
// PROVENANCE. Every number here is a dial from the graph lab
// (origami-graph-lab-v2/index.html), frozen at the value the owner signed off:
// its `showcase` preset (lab L1176-1185) plus three later overrides —
// containment, swirl and centre pull. The lab's 45-dial UI does NOT ship; the
// lab stays the place to re-tune, and a new recipe lands here as new numbers.
//
// A dial the owner left at its default is absent on purpose: it was already the
// shipped value, so naming it here would only add a second place to disagree
// with the code it came from.

/** A node's force-relevant fields — a subset of WikiSearchPane's GraphNode,
 *  generic so this module never imports that component's types. Matches
 *  wikiGraphPhysics.PhysicsNode's shape for the same reason. */
export interface ForceNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  fixed?: boolean;
}

// --- Tuned constants: forces that already existed ---------------------------

/** All-pairs repulsion strength. Lab `repel`, 2000 -> 2600. */
export const REPEL = 2600;
/** Folder hub <-> folder hub repulsion multiplier — hubs must not pile up.
 *  Lab `hubRepelMult`, 10 -> 14. */
export const HUB_REPEL_MULT = 14;
/** Edge spring constant during settle. Lab `attract`, 0.08 -> 0.075. */
export const ATTRACT = 0.075;
/** Sibling (same-folder page) repulsion after settle. Lab `childRepel`,
 *  640 -> 900. */
export const CHILD_REPEL = 900;
/** Page<->page wikilink springs pull at this fraction of a metadata edge, so
 *  structure reads without collapsing folders. Lab `linkScale`, 0.45 -> 0.5. */
export const LINK_ATTRACT_SCALE = 0.5;
/** Tag springs are slackened to this fraction, or the ring below never wins
 *  against them and the tags stay inside the cloud. Lab `tagEdgeScale`,
 *  1 (no such multiplier existed) -> 0.22. */
export const TAG_EDGE_SCALE = 0.22;
/** Velocity retained per settle tick. Lab `dampSettle`, 0.75 -> 0.78. */
export const DAMP_SETTLE = 0.78;
/** Velocity retained per post-settle tick. Lab `dampFollow`, 0.82 -> 0.85. */
export const DAMP_FOLLOW = 0.85;

// --- Perimeter tag ring (new) -----------------------------------------------
//
// Tags used to sit wherever their page springs left them, which is inside the
// cloud. Here each tag gets a radial spring toward a ring around ITS OWN
// folder hub (the lab's ring mode 1, "around each cluster" — the mode the
// owner picked), plus a pull toward an evenly spaced slot on that ring. The
// slot is what turns a fat band into distinct satellites.
//
// The lab's ring mode 2 (one ring around the whole graph) is deliberately not
// ported: the shipped recipe never selects it, and an unreachable branch is a
// second layout nobody would ever see fail.

/** Ring radius around the folder hub, in world units. Lab `ringRadius`. */
export const RING_RADIUS = 210;
/** Radial spring constant toward the ring. Lab `ringPull`. */
export const RING_PULL = 0.07;
/** How hard a tag is pulled toward its own even-angle slot. Lab `ringSpread`. */
export const RING_SPREAD = 0.5;
/** Fixed gain the lab applies to the slot pull (lab L604) so `ringSpread`
 *  reads 0..1 rather than 0..0.02. Not a dial; part of the force. */
export const RING_SPREAD_GAIN = 0.02;

/** One tag's ring input: the folders of every page carrying it. Plain data so
 *  the caller keeps ownership of the node/edge arrays. */
export interface TagRingInput {
  id: string;
  label: string;
  folders: string[];
}

/** The folder a tag rings, and its angle on that folder's ring. */
export interface RingSlot {
  folder: string;
  angle: number;
}

/** Assign every tag to the folder most of its pages live in, then space that
 *  folder's tags evenly around it. Ties go to the folder seen first, and a tag
 *  with no carrying pages falls back to '(root)' — both matching the lab.
 *  Sorted by label so the slot a tag gets is stable across rebuilds rather
 *  than following map insertion order. */
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

/** Push each tag toward the ring around its folder's anchor, and toward its
 *  own slot on that ring. Mutates vx/vy in place (the plain-array house style).
 *  `anchorOf` returning undefined leaves that tag alone — a tag whose folder
 *  hub is missing has nothing to ring. */
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

// --- Bubble clustering (new) ------------------------------------------------
//
// The folder spring sets a rest LENGTH and sibling repel pushes members apart,
// so between them the SPACING was already right — but nothing constrained a
// cluster's OUTLINE, leaving a ragged blob with a few members flung well past
// the pack.
//
// Containment is deliberately ONE-SIDED: only members past their own cluster's
// boundary are pulled back. A two-sided spring toward a target radius would
// evacuate the middle and leave an annulus; leaving the interior alone lets
// sibling repel keep filling it, so a cluster reads as a disc.
//
// The boundary comes from the cluster's OWN mean member distance, not a
// constant, so a 60-page folder still gets a bigger bubble than a 4-page one.
// This force rounds a silhouette; it does not resize anything.

/** Containment spring constant, applied to the overshoot past the boundary.
 *  Lab `bubbleContain` (owner override, at the dial's maximum). */
export const BUBBLE_CONTAIN = 0.3;
/** Tangential drift, SETTLE ONLY — see applyBubbleForce. Lab `bubbleSwirl`
 *  (owner override). */
export const BUBBLE_SWIRL = 0.114;
/** Headroom over the typical member before the boundary bites, so a
 *  well-behaved cluster never feels it and only stragglers are drawn in. */
export const BUBBLE_HEADROOM = 1.25;
/** Under this many members there is no silhouette to round. */
export const BUBBLE_MIN_MEMBERS = 3;

/** One folder's cluster: its hub and the member pages free to move. */
export interface BubbleGroup {
  hub: { x: number; y: number };
  kids: readonly ForceNode[];
}

/** Round each cluster's silhouette. Mutates member vx/vy in place.
 *
 *  `settling` gates the swirl and nothing else. A tangential force still
 *  running at rest would hold the layout above followTick's rest threshold
 *  forever, so the rAF loop would never stop and the pane would burn a core
 *  doing nothing visible. */
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
        // Scaled by how far out the member sits — the rim shears around faster
        // than the core, which is what fills the corners in.
        const t = Math.min(1, dist / bound);
        n.vx += -uy * swirl * t;
        n.vy += ux * swirl * t;
      }
    }
  }
}

// --- Centre pull (new), anchored in WORLD space -----------------------------

/** Spring constant toward the view centre during settle. Lab `centrePull`
 *  (owner override). The pane had no centre pull at all: the last attempt used
 *  the canvas midpoint as if it were a world point and packed every hub onto
 *  it, so it was removed rather than fixed. viewCentreWorld is that fix. */
export const CENTRE_PULL = 0.031;

/** Below this the canvas box is not laid out yet — the same threshold
 *  WikiSearchPane's canvasCenter() uses to decide a box is real. */
export const LIVE_CANVAS_MIN = 40;

/** The WORLD point under the middle of the viewport.
 *
 *  The pane's canvasCenter() returns SCREEN coordinates — CSS pixels from the
 *  canvas's top-left — and feeds them into world-space maths. At zoom 1 / pan 0
 *  the two spaces coincide, which is why the confusion survived; but
 *  resetView() installs a fitted zoom and a non-zero pan, after which the
 *  screen midpoint and the world point beneath it are different places.
 *  Anchoring an attractive force on the former drags the whole cloud toward a
 *  corner. This inverts the transform render() applies, so the anchor is where
 *  the user is actually looking.
 *
 *  DPR is absent on purpose: clientWidth/Height are CSS pixels and render()
 *  pre-multiplies dpr onto BOTH the scale and the pan
 *  (`setTransform(dpr*zoom, 0, 0, dpr*zoom, dpr*panX, dpr*panY)`), so the
 *  device-pixel factor cancels out of the inversion.
 *
 *  A canvas that is not laid out yet falls back to (400, 300) — the same dead
 *  fallback canvasCenter() seeds around, so a pre-layout graph is pulled toward
 *  the point it was seeded around rather than toward the origin. */
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

/** The velocity a node gains this tick from the centre pull. Scaled by the
 *  anneal alpha like every other settle force, so it cools with the layout. */
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
