// The four forces the "Showcase" recipe added to the memory graph, tested as
// pure maths with no canvas/DOM.
//
// Each case targets something the picture would get wrong if the force were
// mis-ported: a cluster that keeps its stragglers, a swirl that never lets the
// animation loop stop, a tag ring that never forms, and — the sharpest one —
// a centre pull anchored on the screen midpoint instead of the world point
// underneath it, which is what dragged the whole cloud into a corner the last
// time a centre pull was tried here.

import { describe, expect, it } from 'vitest';
import {
  ringSlots,
  applyTagRingForce,
  applyBubbleForce,
  viewCentreWorld,
  centrePullDelta,
  RING_RADIUS,
  RING_PULL,
  BUBBLE_CONTAIN,
  BUBBLE_HEADROOM,
  BUBBLE_MIN_MEMBERS,
  CENTRE_PULL,
  type ForceNode,
} from './wikiGraphForces';

const node = (id: string, x: number, y: number, extra: Partial<ForceNode> = {}): ForceNode =>
  ({ id, x, y, vx: 0, vy: 0, ...extra });

describe('ringSlots — which folder a tag rings, and where on it', () => {
  it('assigns a tag to the folder most of its pages live in', () => {
    const slots = ringSlots([{ id: 'tag:a', label: 'a', folders: ['docs', 'src', 'src'] }]);
    expect(slots.get('tag:a')?.folder).toBe('src');
  });

  it('breaks a tie toward the folder seen first, so the choice is not map-order luck', () => {
    const slots = ringSlots([{ id: 'tag:a', label: 'a', folders: ['docs', 'src'] }]);
    expect(slots.get('tag:a')?.folder).toBe('docs');
  });

  it('falls back to the root folder for a tag no page carries', () => {
    const slots = ringSlots([{ id: 'tag:orphan', label: 'orphan', folders: [] }]);
    expect(slots.get('tag:orphan')?.folder).toBe('(root)');
  });

  it('spaces one folder\'s tags evenly right around its ring', () => {
    const slots = ringSlots([
      { id: 'tag:a', label: 'a', folders: ['src'] },
      { id: 'tag:b', label: 'b', folders: ['src'] },
      { id: 'tag:c', label: 'c', folders: ['src'] },
      { id: 'tag:d', label: 'd', folders: ['src'] },
    ]);
    const angles = ['tag:a', 'tag:b', 'tag:c', 'tag:d'].map((id) => slots.get(id)!.angle);
    expect(angles).toEqual([0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]);
  });

  it('gives each folder its own full ring rather than one shared circle', () => {
    const slots = ringSlots([
      { id: 'tag:a', label: 'a', folders: ['src'] },
      { id: 'tag:b', label: 'b', folders: ['docs'] },
    ]);
    // Two tags, two folders — each is alone on its own ring, so both take slot 0.
    expect(slots.get('tag:a')).toEqual({ folder: 'src', angle: 0 });
    expect(slots.get('tag:b')).toEqual({ folder: 'docs', angle: 0 });
  });

  it('orders slots by label, so a rebuild does not reshuffle the ring', () => {
    const forward = ringSlots([
      { id: 'tag:z', label: 'z', folders: ['src'] },
      { id: 'tag:a', label: 'a', folders: ['src'] },
    ]);
    const reversed = ringSlots([
      { id: 'tag:a', label: 'a', folders: ['src'] },
      { id: 'tag:z', label: 'z', folders: ['src'] },
    ]);
    expect(forward.get('tag:a')!.angle).toBe(reversed.get('tag:a')!.angle);
    expect(forward.get('tag:z')!.angle).toBe(reversed.get('tag:z')!.angle);
  });
});

describe('applyTagRingForce — tags leave the cloud for a perimeter', () => {
  const slots = new Map([['tag:a', { folder: 'src', angle: 0 }]]);
  const anchor = { x: 0, y: 0 };
  const anchorOf = () => anchor;

  it('pushes a tag sitting inside the ring outward', () => {
    const t = node('tag:a', 10, 0); // well inside RING_RADIUS
    applyTagRingForce([t], slots, anchorOf);
    expect(t.vx).toBeGreaterThan(0);
  });

  it('pulls a tag flung past the ring back in', () => {
    const t = node('tag:a', RING_RADIUS * 3, 0);
    applyTagRingForce([t], slots, anchorOf);
    expect(t.vx).toBeLessThan(0);
  });

  it('applies the radial spring in proportion to how far off the ring it is', () => {
    // Slot 0 lies on +x, so a tag on the +x axis feels the radial spring and
    // the slot pull along the same line — the ratio isolates the proportion.
    const near = node('tag:a', RING_RADIUS + 10, 0);
    const far = node('tag:a', RING_RADIUS + 20, 0);
    applyTagRingForce([near], slots, anchorOf);
    applyTagRingForce([far], slots, anchorOf);
    expect(far.vx / near.vx).toBeCloseTo(2, 6);
  });

  it('leaves a tag the user is dragging (fixed) alone', () => {
    const t = node('tag:a', 10, 0, { fixed: true });
    applyTagRingForce([t], slots, anchorOf);
    expect({ vx: t.vx, vy: t.vy }).toEqual({ vx: 0, vy: 0 });
  });

  it('leaves a tag alone when its folder hub is missing rather than flinging it at the origin', () => {
    const t = node('tag:a', 10, 0);
    applyTagRingForce([t], slots, () => undefined);
    expect({ vx: t.vx, vy: t.vy }).toEqual({ vx: 0, vy: 0 });
  });

  it('drives a tag toward its OWN slot, not just any point on the ring', () => {
    // Slot at pi/2 is straight down (+y); a tag parked on +x must acquire +y.
    const t = node('tag:a', RING_RADIUS, 0);
    applyTagRingForce([t], new Map([['tag:a', { folder: 'src', angle: Math.PI / 2 }]]), anchorOf);
    expect(t.vy).toBeGreaterThan(0);
  });
});

describe('applyBubbleForce — containment rounds a cluster, swirl only while settling', () => {
  // Three members at 10, 10 and 100 from the hub: mean 40, so the boundary is
  // 40 * BUBBLE_HEADROOM = 50 and exactly one member is outside it.
  const hub = { x: 0, y: 0 };
  const cluster = () => [node('a', 10, 0), node('b', -10, 0), node('c', 100, 0)];
  const BOUND = ((10 + 10 + 100) / 3) * BUBBLE_HEADROOM;

  it('pulls an outlier in by (distance past the boundary) * the spring constant', () => {
    const kids = cluster();
    applyBubbleForce([{ hub, kids }], false);
    expect(kids[2].vx).toBeCloseTo(-(100 - BOUND) * BUBBLE_CONTAIN, 9);
  });

  it('leaves the interior alone — the cluster fills as a disc, not a ring', () => {
    const kids = cluster();
    applyBubbleForce([{ hub, kids }], false);
    expect(kids[0].vx).toBe(0);
    expect(kids[1].vx).toBe(0);
  });

  it('scales the pull with the overshoot, so a worse straggler is drawn harder', () => {
    const mild = [node('a', 10, 0), node('b', -10, 0), node('c', 100, 0)];
    const harsh = [node('a', 10, 0), node('b', -10, 0), node('c', 400, 0)];
    applyBubbleForce([{ hub, kids: mild }], false);
    applyBubbleForce([{ hub, kids: harsh }], false);
    expect(Math.abs(harsh[2].vx)).toBeGreaterThan(Math.abs(mild[2].vx));
  });

  it('adds a tangential drift while settling', () => {
    const kids = cluster();
    applyBubbleForce([{ hub, kids }], true);
    // Members sit on the x axis, so any y velocity is purely the swirl.
    expect(kids[0].vy).not.toBe(0);
  });

  it('adds NO tangential drift once settled — a swirl at rest would never let the loop stop', () => {
    const kids = cluster();
    applyBubbleForce([{ hub, kids }], false);
    expect(kids.map((n) => n.vy)).toEqual([0, 0, 0]);
  });

  it('shears the rim faster than the core', () => {
    const kids = [node('core', 5, 0), node('mid', 40, 0), node('rim', 100, 0)];
    applyBubbleForce([{ hub, kids }], true);
    expect(Math.abs(kids[2].vy)).toBeGreaterThan(Math.abs(kids[0].vy));
  });

  it('ignores a cluster too small to have a silhouette', () => {
    const kids = Array.from({ length: BUBBLE_MIN_MEMBERS - 1 }, (_, i) => node(`n${i}`, 500, 0));
    applyBubbleForce([{ hub, kids }], true);
    expect(kids.every((n) => n.vx === 0 && n.vy === 0)).toBe(true);
  });

  it('survives a member sitting exactly on its hub without producing NaN', () => {
    const kids = [node('a', 0, 0), node('b', 10, 0), node('c', 100, 0)];
    applyBubbleForce([{ hub, kids }], true);
    expect(kids.every((n) => Number.isFinite(n.vx) && Number.isFinite(n.vy))).toBe(true);
  });
});

describe('viewCentreWorld — the centre pull anchors on WORLD coordinates', () => {
  it('coincides with the screen midpoint at zoom 1 / no pan — which is why the bug hid', () => {
    expect(viewCentreWorld(800, 600, 0, 0, 1)).toEqual({ x: 400, y: 300 });
  });

  it('is NOT the screen midpoint once the view is panned and zoomed', () => {
    // resetView() installs exactly this kind of fitted zoom + non-zero pan.
    const centre = viewCentreWorld(800, 600, -1000, -500, 2);
    expect(centre).toEqual({ x: 700, y: 400 });
    // The screen-space idiom (canvasCenter) would have said (400, 300) here.
    expect(centre).not.toEqual({ x: 400, y: 300 });
  });

  it('inverts the transform render() paints with, for any view', () => {
    const [w, h, panX, panY, zoom] = [640, 480, 37, -211, 0.75];
    const { x, y } = viewCentreWorld(w, h, panX, panY, zoom);
    // Forward transform: screen = world * zoom + pan. Round-trips to the middle.
    expect(x * zoom + panX).toBeCloseTo(w / 2, 9);
    expect(y * zoom + panY).toBeCloseTo(h / 2, 9);
  });

  it('falls back to the seed centre while the canvas box is still collapsed', () => {
    expect(viewCentreWorld(0, 0, 0, 0, 1)).toEqual({ x: 400, y: 300 });
    expect(viewCentreWorld(39, 600, 0, 0, 1)).toEqual({ x: 400, y: 300 });
  });
});

describe('centrePullDelta — pulls toward what the user is looking at', () => {
  it('is zero for a node already at the view centre', () => {
    const centre = viewCentreWorld(800, 600, -1000, -500, 2);
    expect(centrePullDelta({ x: centre.x, y: centre.y }, centre, 1)).toEqual({ dvx: 0, dvy: 0 });
  });

  it('would NOT be zero for that node if the screen midpoint were used as the anchor', () => {
    // The regression this force is exposed to: anchoring on canvasCenter()'s
    // screen coordinates drags a settled cloud off toward a corner. Same node,
    // same view — only the anchor differs.
    const centre = viewCentreWorld(800, 600, -1000, -500, 2);
    const screenAnchor = { x: 800 / 2, y: 600 / 2 };
    const wrong = centrePullDelta({ x: centre.x, y: centre.y }, screenAnchor, 1);
    expect(Math.abs(wrong.dvx) + Math.abs(wrong.dvy)).toBeGreaterThan(1);
  });

  it('points from the node toward the centre, scaled by the spring constant', () => {
    const d = centrePullDelta({ x: 100, y: 50 }, { x: 0, y: 0 }, 1);
    expect(d.dvx).toBeCloseTo(-100 * CENTRE_PULL, 9);
    expect(d.dvy).toBeCloseTo(-50 * CENTRE_PULL, 9);
  });

  it('cools with the anneal alpha like every other settle force', () => {
    const hot = centrePullDelta({ x: 100, y: 0 }, { x: 0, y: 0 }, 0.4);
    const cool = centrePullDelta({ x: 100, y: 0 }, { x: 0, y: 0 }, 0.02);
    expect(hot.dvx / cool.dvx).toBeCloseTo(0.4 / 0.02, 6);
  });
});

describe('the recipe\'s numbers are the ones the owner signed off', () => {
  // A guard, not an echo: these are the values from the graph lab's `showcase`
  // preset plus the three later overrides. Anyone re-tuning by hand instead of
  // through the lab has to come here and say so.
  it('pins the ring, bubble and centre-pull constants', () => {
    expect({ RING_RADIUS, RING_PULL, BUBBLE_CONTAIN, CENTRE_PULL })
      .toEqual({ RING_RADIUS: 210, RING_PULL: 0.07, BUBBLE_CONTAIN: 0.3, CENTRE_PULL: 0.031 });
  });
});
